#!/usr/bin/env python3
"""
Locate the camera against the scan itself, without needing it to move.

Structure from motion is the usual way to track a shot, but it recovers
geometry from parallax, so it needs the camera to travel. These clips barely
do - features shift about 4% of the frame width across an entire take - and
COLMAP cannot even pick an initial pair. The structure never needs recovering
though, because the scan already is the structure. So the camera is solved
against the model instead:

  1. Find the shot. The mesh is rendered from viewpoints spread over a sphere
     and each render is matched against one keyframe of the video. A render
     looks like a photograph - contiguous, correctly perspectived - which is
     exactly what the texture atlas does not, its charts being small, rotated
     and resampled. The best viewpoint, refined by re-rendering from the pose
     it implies, converges on where the camera really was.
  2. Carry it through the take. The keyframe's matches are 2D points with known
     3D positions, and tracking those 2D points frame to frame with optical
     flow keeps the correspondence. Over this little motion LK is near-exact,
     and no frame has to be matched against the model again.
  3. Solve each frame by PnP on the tracked correspondences. One view suffices,
     so zero camera translation is fine, and the pose arrives already in the
     mesh's coordinate frame - there is no similarity left to solve, which is
     where a two-stage SfM pipeline usually goes wrong.

Writes sfm.json and an identity alignment.json, so export_track.py consumes the
result exactly as it would a COLMAP solve.

Usage:
    python localize.py <work_dir> --glb <scan.glb>
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import trimesh
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).parent))
from render import (ScanRenderer, fibonacci_sphere, look_at,  # noqa: E402
                    perspective)

# Lowe ratio. Looser than the usual 0.75 because a scan repeats texture
# (panel edges, bolts, gravel) and RANSAC is what really rejects bad pairs.
RATIO = 0.82

# OpenCV camera axes (+Z forward, Y down) -> OpenGL view axes (-Z forward, Y up).
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])


def load_scan(glb_path: Path):
    """
    Load the mesh with its scene transform baked in, plus its base texture.

    Returns:
        (vertices (V,3), faces (F,3), uv (V,2), texture RGB array (H,W,3))
    """
    scene = trimesh.load(str(glb_path), force="scene")
    geoms = []
    for node in scene.graph.nodes_geometry:
        transform, gname = scene.graph[node]
        g = scene.geometry.get(gname)
        if not isinstance(g, trimesh.Trimesh):
            continue
        g = g.copy()
        g.apply_transform(transform)
        geoms.append(g)
    if len(geoms) != 1:
        raise SystemExit(f"expected one textured mesh, found {len(geoms)}")
    mesh = geoms[0]

    tex = mesh.visual.material.baseColorTexture
    if tex is None:
        raise SystemExit("scan has no base colour texture to match against")
    if tex.mode != "RGB":
        tex = tex.convert("RGB")

    return (np.asarray(mesh.vertices, dtype=np.float64),
            np.asarray(mesh.faces, dtype=np.int64),
            np.asarray(mesh.visual.uv, dtype=np.float64),
            np.asarray(tex))


def root_sift(desc: np.ndarray) -> np.ndarray:
    """
    RootSIFT: L1-normalise then square-root.

    Comparing the result under L2 is a Hellinger distance on the raw
    histograms, which matches noticeably better than plain SIFT for free.
    """
    if desc is None or not len(desc):
        return np.empty((0, 128), dtype=np.float32)
    desc = desc / np.maximum(desc.sum(axis=1, keepdims=True), 1e-7)
    return np.sqrt(desc).astype(np.float32)


def detect(img: np.ndarray, sift, mask=None):
    """Detect RootSIFT features, returning (points (N,2), descriptors)."""
    kps, desc = sift.detectAndCompute(img, mask)
    if desc is None or not len(kps):
        return np.empty((0, 2)), np.empty((0, 128), dtype=np.float32)
    return np.array([k.pt for k in kps], dtype=np.float64), root_sift(desc)


def ratio_match(query: np.ndarray, matcher):
    """
    Ratio-test knn match against a trained matcher.

    Returns:
        (query indices, train indices)
    """
    if not len(query):
        return np.empty(0, int), np.empty(0, int)
    knn = matcher.knnMatch(query, k=2)
    q, t = [], []
    for pair in knn:
        if len(pair) == 2 and pair[0].distance < RATIO * pair[1].distance:
            q.append(pair[0].queryIdx)
            t.append(pair[0].trainIdx)
    return np.asarray(q, int), np.asarray(t, int)


def intrinsics(focal: float, width: int, height: int) -> np.ndarray:
    """Pinhole camera matrix with the principal point at the centre."""
    return np.array([[focal, 0, width / 2.0],
                     [0, focal, height / 2.0],
                     [0, 0, 1]], dtype=np.float64)


def solve_pose(obj: np.ndarray, img: np.ndarray, K: np.ndarray,
               reproj: float = 4.0):
    """
    PnP with RANSAC, refined on the inlier set.

    Returns:
        (rvec, tvec, inlier_indices) or (None, None, empty)
    """
    empty = np.empty(0, int)
    if len(obj) < 6:
        return None, None, empty
    ok, rvec, tvec, inliers = cv2.solvePnPRansac(
        obj.reshape(-1, 1, 3), img.reshape(-1, 1, 2), K, None,
        iterationsCount=2000, reprojectionError=reproj, confidence=0.999,
        flags=cv2.SOLVEPNP_EPNP)
    if not ok or inliers is None or len(inliers) < 6:
        return None, None, empty
    idx = inliers.ravel()
    rvec, tvec = cv2.solvePnPRefineLM(
        obj[idx].reshape(-1, 1, 3), img[idx].reshape(-1, 1, 2), K, None,
        rvec, tvec)
    return rvec, tvec, idx


def gl_view_from_pose(rvec: np.ndarray, tvec: np.ndarray) -> np.ndarray:
    """Turn an OpenCV camera pose into an OpenGL world-to-view matrix."""
    R, _ = cv2.Rodrigues(rvec)
    m = np.eye(4)
    m[:3, :3] = R
    m[:3, 3] = tvec.ravel()
    return CV_TO_GL @ m


def match_render_to_frame(rgb, world, mask, sift, frame_matcher, frame_pts,
                          K, reproj, up):
    """
    Match one render against the keyframe and solve a pose from it.

    The render's world-position buffer is what makes this cheap: a matched
    pixel's mesh coordinate is simply an array lookup.

    Args:
        up: factor carrying keyframe points back to full frame resolution,
            since matching runs at the render's scale but PnP uses the real K

    Returns:
        (rvec, tvec, object points, image points, n_inliers)
    """
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    r_pts, r_desc = detect(gray, sift, mask.astype(np.uint8) * 255)
    if len(r_pts) < 8:
        return None, None, None, None, 0

    ri, fi = ratio_match(r_desc, frame_matcher)
    if len(ri) < 8:
        return None, None, None, None, 0

    px = np.clip(r_pts[ri, 0].astype(int), 0, world.shape[1] - 1)
    py = np.clip(r_pts[ri, 1].astype(int), 0, world.shape[0] - 1)
    good = mask[py, px]
    obj = world[py[good], px[good]].astype(np.float64)
    img = frame_pts[fi[good]] * up
    if len(obj) < 8:
        return None, None, None, None, 0

    rvec, tvec, inl = solve_pose(obj, img, K, reproj)
    if rvec is None:
        return None, None, None, None, 0
    return rvec, tvec, obj[inl], img[inl], len(inl)


def find_pose(renderer, centre, radius, frame_gray, sift, focal_frame,
              n_views, distances, render_wh, reproj, verbose=True):
    """
    Search viewpoints for the one that explains the keyframe, then refine it.

    Args:
        renderer: a ScanRenderer
        centre, radius: bounding sphere of the scan
        frame_gray: the keyframe, greyscale
        sift: detector shared with the renders
        focal_frame: focal length in frame pixels to test with
        n_views: directions to spread over the sphere
        distances: multiples of radius to place the camera at
        render_wh: (width, height) of each render
        reproj: RANSAC reprojection threshold in frame pixels

    Returns:
        (rvec, tvec, object points, image points, n_inliers)
    """
    rw, rh = render_wh
    fh, fw = frame_gray.shape[:2]
    K = intrinsics(focal_frame, fw, fh)

    # Match at the render's scale. SIFT tolerates a scale gap but does not
    # relish one, and a 1920px frame against a 720px render is a 2.7x jump
    # that costs most of the matches; the scan's texture carries no more
    # detail than the render anyway. Points scale back up for PnP.
    small = cv2.resize(frame_gray, (rw, rh), interpolation=cv2.INTER_AREA)
    up = fw / float(rw)

    f_pts, f_desc = detect(small, sift, None)
    if verbose:
        print(f"[find] keyframe has {len(f_pts)} features at {rw}x{rh}")
    matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5),
                                    dict(checks=48))
    matcher.add([f_desc])
    matcher.train()

    # The render's own focal only has to frame the object; it never has to
    # match the camera, because only the world buffer is read from it.
    proj = perspective(0.9 * max(rw, rh), rw, rh)
    dirs = fibonacci_sphere(n_views)

    best = (0, None, None, None, None)
    for dist in distances:
        for d in dirs:
            eye = centre + d * radius * dist
            rgb, world, mask = renderer.render(
                look_at(eye, centre, [0, 1, 0]), proj)
            if mask.mean() < 0.02:
                continue
            rvec, tvec, obj, img, n = match_render_to_frame(
                rgb, world, mask, sift, matcher, f_pts, K, reproj, up)
            if n > best[0]:
                best = (n, rvec, tvec, obj, img)
    if verbose:
        print(f"[find] best viewpoint gives {best[0]} PnP inliers")
    if best[1] is None:
        return None, None, None, None, 0

    # Re-render from the pose we just found and match again. The render now
    # shares the camera's viewpoint, so far more features survive and the pose
    # tightens. A couple of rounds is enough to settle.
    n, rvec, tvec, obj, img = best
    for it in range(3):
        view = gl_view_from_pose(rvec, tvec)
        proj_c = perspective(focal_frame * rh / fh, rw, rh)
        rgb, world, mask = renderer.render(view, proj_c)
        r2, t2, o2, i2, n2 = match_render_to_frame(
            rgb, world, mask, sift, matcher, f_pts, K, reproj, up)
        if n2 <= n:
            break
        rvec, tvec, obj, img, n = r2, t2, o2, i2, n2
        if verbose:
            print(f"[find]   refine {it + 1}: {n} inliers")
    return rvec, tvec, obj, img, n


def sweep_focal(renderer, centre, radius, frame_gray, sift, width, height,
                n_views, distances, render_wh, reproj):
    """
    Choose a focal length by which one best explains the keyframe.

    The clips carry no usable EXIF, and with this little camera motion the
    focal cannot be recovered from the trajectory either. Testing it against
    the known model is the dependable option: the right focal wins on inliers.
    """
    print("[focal] sweeping against the model...")
    best = (0, None)
    # Spans roughly 55-110 degrees horizontally, which covers a phone's wide
    # and main cameras; a 24mm-equivalent main camera lands near 0.67.
    for mult in (0.55, 0.67, 0.8, 0.95, 1.15, 1.4, 1.7):
        f = mult * max(width, height)
        _, _, _, _, n = find_pose(renderer, centre, radius, frame_gray, sift,
                                  f, n_views, distances, render_wh, reproj,
                                  verbose=False)
        print(f"[focal]   f={f:7.1f}px -> {n:4d} inliers")
        if n > best[0]:
            best = (n, f)
    if best[1] is None:
        raise SystemExit("[focal] no viewpoint matched at any focal length")
    print(f"[focal] chose f={best[1]:.1f}px ({best[0]} inliers)")
    return best[1]


def densify(renderer, rvec, tvec, frame_gray, focal, render_wh, K, reproj,
            max_points=1200):
    """
    Grow the correspondence set once the pose is known.

    Matching only yields as many points as SIFT agrees on - often under a
    hundred - and optical flow sheds them steadily, which is what starves a
    long take. But at the converged pose the render is aligned with the frame,
    so *any* trackable corner can be given a 3D position by reading the world
    buffer underneath it. That turns tens of correspondences into hundreds,
    spread over the whole object rather than clustered on high-contrast marks.

    The mask is eroded first: near a silhouette a pixel's depth flips between
    the object and whatever is behind it, and a point that lands on the wrong
    side would carry a badly wrong 3D position.

    Returns:
        (object points, image points, n_inliers) or (None, None, 0)
    """
    rw, rh = render_wh
    fh, fw = frame_gray.shape[:2]
    proj = perspective(focal * rh / fh, rw, rh)
    _, world, mask = renderer.render(gl_view_from_pose(rvec, tvec), proj)

    solid = cv2.erode((mask * 255).astype(np.uint8), np.ones((7, 7), np.uint8))
    full = cv2.resize(solid, (fw, fh), interpolation=cv2.INTER_NEAREST)

    corners = cv2.goodFeaturesToTrack(
        frame_gray, maxCorners=max_points, qualityLevel=0.01,
        minDistance=max(6, fw // 220), mask=full)
    if corners is None or len(corners) < 12:
        return None, None, 0

    pts = corners.reshape(-1, 2).astype(np.float64)
    rx = np.clip((pts[:, 0] * rw / fw).astype(int), 0, rw - 1)
    ry = np.clip((pts[:, 1] * rh / fh).astype(int), 0, rh - 1)
    good = mask[ry, rx]
    obj = world[ry[good], rx[good]].astype(np.float64)
    img = pts[good]
    if len(obj) < 12:
        return None, None, 0

    # Re-solve on the densified set and keep only what agrees with the pose we
    # already trust, so a stray depth read cannot pull the track.
    r2, t2, inl = solve_pose(obj, img, K, reproj)
    if r2 is None:
        return None, None, 0
    return obj[inl], img[inl], len(inl)


def track_and_solve(paths, key_idx, obj, img, K, reproj, win=31, levels=4,
                    reach=None):
    """
    Carry the keyframe's correspondences through the take with optical flow.

    Each tracked 2D point keeps its 3D partner, so every frame can be solved by
    PnP without matching against the model again. Tracking runs outwards from
    the keyframe in both directions, which halves the accumulated drift
    compared with starting at frame 0.

    Args:
        paths: frame paths, ordered
        key_idx: index of the keyframe within paths
        obj: (N,3) mesh points
        img: (N,2) their positions in the keyframe
        K: camera matrix
        reproj: RANSAC reprojection threshold

    Returns:
        dict of frame index -> (rvec, tvec, n_inliers)
    """
    lk = dict(winSize=(win, win), maxLevel=levels,
              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                        30, 0.01))
    out = {}

    rvec, tvec, inl = solve_pose(obj, img, K, reproj)
    if rvec is None:
        raise SystemExit("[track] keyframe correspondences do not solve")
    out[key_idx] = (rvec, tvec, len(inl))

    for direction in (-1, 1):
        cur = cv2.imread(str(paths[key_idx]), cv2.IMREAD_GRAYSCALE)
        pts = img.astype(np.float32).reshape(-1, 1, 2)
        live = obj.copy()
        i = key_idx + direction
        limit = len(paths) if reach is None else reach

        while 0 <= i < len(paths) and abs(i - key_idx) <= limit:
            nxt = cv2.imread(str(paths[i]), cv2.IMREAD_GRAYSCALE)
            fwd, st, _ = cv2.calcOpticalFlowPyrLK(cur, nxt, pts, None, **lk)
            # Track back again and keep only points that land where they
            # started; this is what catches points sliding onto an occluder.
            back, st2, _ = cv2.calcOpticalFlowPyrLK(nxt, cur, fwd, None, **lk)
            err = np.linalg.norm((back - pts).reshape(-1, 2), axis=1)
            ok = (st.ravel() == 1) & (st2.ravel() == 1) & (err < 1.0)
            if ok.sum() < 8:
                break

            pts = fwd[ok].reshape(-1, 1, 2)
            live = live[ok]
            r, t, inl = solve_pose(live, pts.reshape(-1, 2), K, reproj)
            if r is not None:
                out[i] = (r, t, len(inl))
            cur = nxt
            i += direction

    return out


def smooth_poses(frames: list, window: int) -> list:
    """
    Low-pass the trajectory.

    Solving each frame independently is what keeps the result drift-free, but
    it also lets neighbouring frames jitter against each other. The real camera
    is a hand holding a phone, so there is nothing genuine at that frequency.
    """
    if len(frames) < 3 or window < 3:
        return frames
    half = window // 2

    tv = np.array([f["tvec"] for f in frames], dtype=np.float64)
    rot = Rotation.from_quat(np.array([f["qvec_xyzw"] for f in frames]))

    for i, f in enumerate(frames):
        lo, hi = max(0, i - half), min(len(frames), i + half + 1)
        f["tvec"] = tv[lo:hi].mean(axis=0).tolist()
        # Rotations are averaged in their own chart, not componentwise.
        f["qvec_xyzw"] = rot[lo:hi].mean().as_quat().tolist()
    return frames


def localise(work_dir: Path, glb: Path, n_views: int, render_w: int,
             reproj: float, smooth: int, focal: float | None,
             keyframe: int | None, anchors: int) -> dict:
    """Solve a pose for every frame and write it out in COLMAP's layout."""
    paths = sorted((work_dir / "frames").glob("*.jpg"))
    if not paths:
        raise SystemExit(f"no frames in {work_dir / 'frames'}")

    probe = cv2.imread(str(paths[0]))
    height, width = probe.shape[:2]
    key_idx = len(paths) // 2 if keyframe is None else keyframe
    if anchors <= 0:
        anchors = max(1, round(len(paths) / 70))
    print(f"[loc] {len(paths)} frames at {width}x{height}, "
          f"keyframe {paths[key_idx].name}")

    verts, faces, uv, tex = load_scan(glb)
    centre = (verts.min(axis=0) + verts.max(axis=0)) / 2.0
    radius = float(np.linalg.norm(verts.max(axis=0) - verts.min(axis=0)) / 2.0)
    print(f"[loc] scan {len(verts)} verts, radius {radius:.3f}")

    render_h = int(round(render_w * height / width))
    renderer = ScanRenderer(verts, faces, uv, tex, render_w, render_h)
    sift = cv2.SIFT_create(nfeatures=12000)
    key_gray = cv2.imread(str(paths[key_idx]), cv2.IMREAD_GRAYSCALE)
    distances = (1.6, 2.2)
    render_wh = (render_w, render_h)

    # Optical flow sheds points as it goes, so one anchor cannot carry a long
    # take. Several independent anchors spread across the clip each cover their
    # own stretch, and because every one is located against the model from
    # scratch, they cannot drift relative to each other.
    if anchors <= 1:
        key_idxs = [key_idx]
    else:
        key_idxs = [int(v) for v in
                    np.linspace(0, len(paths) - 1, anchors + 2)[1:-1]]
        if keyframe is not None and key_idx not in key_idxs:
            key_idxs.append(key_idx)
        key_idxs = sorted(set(key_idxs))
    spacing = len(paths) if len(key_idxs) < 2 else max(
        key_idxs[i + 1] - key_idxs[i] for i in range(len(key_idxs) - 1))
    reach = int(spacing * 0.9) + 12  # overlap, so segments can be compared
    print(f"[loc] anchors at {key_idxs}, each reaching +/-{reach} frames")

    seeds = []
    try:
        if focal is None:
            focal = sweep_focal(renderer, centre, radius, key_gray, sift,
                                width, height, max(60, n_views // 3),
                                distances, render_wh, reproj)
        K = intrinsics(focal, width, height)

        for ki in key_idxs:
            gray = cv2.imread(str(paths[ki]), cv2.IMREAD_GRAYSCALE)
            rvec, tvec, obj, img, n = find_pose(
                renderer, centre, radius, gray, sift, focal, n_views,
                distances, render_wh, reproj, verbose=False)
            if rvec is None:
                print(f"[loc] anchor {ki}: could not locate, skipping")
                continue
            d_obj, d_img, d_n = densify(renderer, rvec, tvec, gray, focal,
                                        render_wh, K, reproj)
            if d_n > n:
                print(f"[loc] anchor {ki}: {n} matched -> {d_n} densified")
                obj, img, n = d_obj, d_img, d_n
            else:
                print(f"[loc] anchor {ki}: {n} correspondences")
            seeds.append((ki, obj, img, n))
    finally:
        renderer.release()

    if not seeds:
        raise SystemExit("[loc] could not locate the camera on any keyframe")

    # Each anchor votes for the frames it reaches; the one with the most
    # inliers on a given frame wins it.
    solved = {}
    for ki, obj, img, _ in seeds:
        seg = track_and_solve(paths, ki, obj, img, K, reproj, reach=reach)
        for i, (r, t, n_inl) in seg.items():
            if i not in solved or n_inl > solved[i][2]:
                solved[i] = (r, t, n_inl)

    n = max(s[3] for s in seeds)
    print(f"[loc] solved {len(solved)}/{len(paths)} frames "
          f"from {len(seeds)} anchor(s)")
    if not solved:
        raise SystemExit("[loc] nothing solved")

    frames = []
    for i in sorted(solved):
        r, t, n_inl = solved[i]
        R, _ = cv2.Rodrigues(r)
        frames.append({
            "name": paths[i].name,
            "index": int(paths[i].stem),
            "qvec_xyzw": Rotation.from_matrix(R).as_quat().tolist(),
            "tvec": t.ravel().tolist(),
            "num_points": int(n_inl),
        })

    inl = [f["num_points"] for f in frames]
    print(f"[loc] inliers median {int(np.median(inl))}, "
          f"min {min(inl)}, max {max(inl)}")

    if smooth > 1:
        frames = smooth_poses(frames, smooth)
        print(f"[loc] smoothed over a {smooth}-frame window")

    data = {
        "source": work_dir.name,
        "solver": "pnp-model-localisation",
        "intrinsics": {
            "model": "PINHOLE",
            "width": width, "height": height,
            "fx": focal, "fy": focal,
            "cx": width / 2.0, "cy": height / 2.0,
            "params": {"fx": focal, "fy": focal,
                       "cx": width / 2.0, "cy": height / 2.0},
        },
        "frames": frames,
        "num_points": int(len(obj)),
    }
    (work_dir / "sfm.json").write_text(json.dumps(data, indent=2))

    # Poses already sit in the mesh's frame, so the downstream similarity is
    # the identity and there is no registration step left to go wrong.
    (work_dir / "alignment.json").write_text(json.dumps({
        "source": work_dir.name,
        "scale": 1.0,
        "rotation": np.eye(3).tolist(),
        "translation": [0.0, 0.0, 0.0],
        "quality": {
            "solver": "pnp-model-localisation",
            "solved_frames": len(frames),
            "total_frames": len(paths),
            "median_inliers": int(np.median(inl)),
            "keyframe_correspondences": int(n),
            "inlier_fraction_2pct": float(len(frames) / len(paths)),
        },
    }, indent=2))
    print(f"[loc] wrote {work_dir / 'sfm.json'} and alignment.json")
    return data


def main():
    ap = argparse.ArgumentParser(
        description="Locate the camera against a textured scan, frame by frame")
    ap.add_argument("work_dir", type=Path)
    ap.add_argument("--glb", type=Path, required=True)
    ap.add_argument("--views", type=int, default=260,
                    help="viewpoints spread over the sphere in the search")
    ap.add_argument("--render-width", type=int, default=720)
    ap.add_argument("--reproj", type=float, default=4.0,
                    help="RANSAC reprojection threshold in pixels")
    ap.add_argument("--smooth", type=int, default=7,
                    help="trajectory smoothing window in frames; 1 disables")
    ap.add_argument("--focal", type=float, default=None,
                    help="skip the focal sweep and use this value, in pixels")
    ap.add_argument("--keyframe", type=int, default=None,
                    help="frame to locate first; defaults to the middle")
    ap.add_argument("--anchors", type=int, default=0,
                    help="independently located keyframes; 0 picks one per "
                         "~70 frames, 1 forces a single anchor")
    args = ap.parse_args()

    localise(args.work_dir, args.glb, args.views, args.render_width,
             args.reproj, args.smooth, args.focal, args.keyframe,
             args.anchors)


if __name__ == "__main__":
    main()
