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

# An anchor located on this few inliers is not worth tracking from. It will
# happily densify to a thousand points, because densification trusts the pose
# it is given, and then win frames off good anchors on sheer point count.
MIN_ANCHOR_INLIERS = 12

# A focal fit whose matches are off by more than this, in pixels, is fitting
# noise rather than the lens.
MAX_FOCAL_FIT_RMS = 4.0


def load_scan(glb_path: Path):
    """
    Load the mesh with its scene transform baked in, plus its base texture.

    A scan whose texture overflows one page arrives as several meshes, each
    with its own texture. The renderer binds a single texture, so the pages
    are stacked into one atlas and each mesh's UVs squeezed into its band.

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
    if not geoms:
        raise SystemExit("scan has no meshes")

    pages = []
    for g in geoms:
        tex = getattr(g.visual.material, "baseColorTexture", None)
        if tex is None or g.visual.uv is None:
            raise SystemExit("scan has no base colour texture to match against")
        pages.append(tex.convert("RGB") if tex.mode != "RGB" else tex)

    # Bring every page to a common width so they stack without padding.
    width = max(p.size[0] for p in pages)
    pages = [p if p.size[0] == width else
             p.resize((width, round(p.size[1] * width / p.size[0])))
             for p in pages]
    total = sum(p.size[1] for p in pages)

    # UV v runs up from the bottom of the image, and page 0 sits at the top,
    # so each band starts from however much of the stack lies beneath it.
    verts, faces, uvs = [], [], []
    offset, below = 0, total
    for g, p in zip(geoms, pages):
        h = p.size[1]
        below -= h
        uv = np.asarray(g.visual.uv, dtype=np.float64).copy()
        uv[:, 1] = (below + uv[:, 1] * h) / total
        verts.append(np.asarray(g.vertices, dtype=np.float64))
        faces.append(np.asarray(g.faces, dtype=np.int64) + offset)
        uvs.append(uv)
        offset += len(g.vertices)

    atlas = np.vstack([np.asarray(p) for p in pages])
    return np.vstack(verts), np.vstack(faces), np.vstack(uvs), atlas


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
    obj_in = np.ascontiguousarray(obj, dtype=np.float64).reshape(-1, 1, 3)
    img_in = np.ascontiguousarray(img, dtype=np.float64).reshape(-1, 1, 2)

    # EPNP is the fast answer and the usual one. SQPnP is tried after it
    # because EPNP reports plain failure on the near-degenerate spreads a
    # densified set throws up - a face of the scan seen almost flat-on, say -
    # and losing a whole anchor to that is not worth the microseconds saved.
    for flags in (cv2.SOLVEPNP_EPNP, cv2.SOLVEPNP_SQPNP):
        try:
            ok, rvec, tvec, inliers = cv2.solvePnPRansac(
                obj_in, img_in, K, None, iterationsCount=2000,
                reprojectionError=reproj, confidence=0.999, flags=flags)
        except cv2.error:
            continue
        if not ok or inliers is None or len(inliers) < 6:
            continue
        idx = inliers.ravel()
        rvec, tvec = cv2.solvePnPRefineLM(
            obj[idx].reshape(-1, 1, 3), img[idx].reshape(-1, 1, 2), K, None,
            rvec, tvec)
        return rvec, tvec, idx
    return None, None, empty


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


def view_up(direction: np.ndarray) -> np.ndarray:
    """An up vector for look_at that is never parallel to the view direction."""
    return np.array([0.0, 0.0, 1.0]) if abs(direction[1]) > 0.95 else \
        np.array([0.0, 1.0, 0.0])


def exterior_candidates(centre, radius, n_views, distances=(1.6, 2.2)):
    """Viewpoints on spheres around the scan, all looking at its centre."""
    return [(centre + d * radius * dist, centre)
            for dist in distances for d in fibonacci_sphere(n_views)]


def interior_candidates(verts, faces, uv, tex, n_positions, n_dirs,
                        probe=96):
    """
    Viewpoints inside the scan, looking outwards in every direction.

    For a space filmed from within - a room, a stairwell - the camera stands
    inside the geometry, and a sphere of viewpoints outside it only ever sees
    the backs of the walls. Free space is found by probing a grid with tiny
    cube-map renders: a point is inside if most of what surrounds it is scan,
    and usable if it keeps some clearance from the nearest surface. A spread
    of those points, each looking in every direction, makes the search.

    Returns:
        list of (eye, target)
    """
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    extent = float((hi - lo).max())
    step = extent / 16.0
    axes = [np.arange(lo[k] + step / 2, hi[k], step) for k in range(3)]
    grid = np.stack(np.meshgrid(*axes, indexing="ij"), -1).reshape(-1, 3)

    cube = [np.array(d, float) for d in
            ([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1],
             [0, 0, -1])]
    proj = perspective(probe / 2.0, probe, probe)  # 90 degrees: a cube face
    clearance = 0.03 * extent
    free = []
    r = ScanRenderer(verts, faces, uv, tex, probe, probe)
    try:
        for p in grid:
            cover, near = [], np.inf
            for d in cube:
                _, world, mask = r.render(look_at(p, p + d, view_up(d)), proj)
                cover.append(mask.mean())
                if mask.any():
                    near = min(near, float(np.linalg.norm(
                        world[mask] - p, axis=1).min()))
            # Scans have holes - windows, unscanned corners - so allow some
            # sky, but a point outside the scan sees nothing in half its faces.
            if np.mean(cover) > 0.7 and min(cover) > 0.3 and near > clearance:
                free.append(p)
    finally:
        r.release()
    if not free:
        raise SystemExit("[loc] found no free space inside the scan; "
                         "is this really an interior take?")
    free = np.array(free)

    # Farthest-point sampling spreads the positions through the whole space
    # rather than clumping them where the grid happens to be densest.
    pick = [int(np.argmin(np.linalg.norm(free - free.mean(0), axis=1)))]
    dist = np.linalg.norm(free - free[pick[0]], axis=1)
    while len(pick) < min(n_positions, len(free)):
        pick.append(int(np.argmax(dist)))
        dist = np.minimum(dist, np.linalg.norm(free - free[pick[-1]], axis=1))
    print(f"[loc] interior: {len(free)} free grid points of {len(grid)}, "
          f"searching {len(pick)} positions x {n_dirs} directions")

    dirs = fibonacci_sphere(n_dirs, min_elevation=-1.0)
    return [(free[i], free[i] + d) for i in pick for d in dirs]


def plausible(rvec, tvec, box) -> bool:
    """
    Whether a solved camera stands somewhere it could have been filmed from.

    PnP on a dozen near-coplanar matches - a bare wall, say - will happily
    return a camera 1e14 units away that still reprojects them within the
    threshold, and twelve inliers is enough to pass as an anchor. A camera
    has to stand within reach of the scan, or inside it for an interior take.
    """
    if rvec is None or box is None:
        return rvec is not None
    R, _ = cv2.Rodrigues(rvec)
    c = (-R.T @ np.asarray(tvec).reshape(3)).ravel()
    return bool(np.all(c >= box[0]) and np.all(c <= box[1]))


def refine_pose(renderer, rvec, tvec, n, obj, img, sift, matcher, f_pts, K,
                focal_frame, frame_hw, render_wh, reproj, up, verbose=False,
                box=None):
    """
    Re-render from a pose and rematch until the inlier count stops climbing.

    The render then shares the camera's viewpoint, so far more features
    survive than from the nearest search viewpoint, and the pose tightens.

    Returns:
        (rvec, tvec, object points, image points, n_inliers)
    """
    rw, rh = render_wh
    fh, _ = frame_hw
    for it in range(3):
        view = gl_view_from_pose(rvec, tvec)
        proj_c = perspective(focal_frame * rh / fh, rw, rh)
        rgb, world, mask = renderer.render(view, proj_c)
        r2, t2, o2, i2, n2 = match_render_to_frame(
            rgb, world, mask, sift, matcher, f_pts, K, reproj, up)
        if n2 <= n or not plausible(r2, t2, box):
            break
        rvec, tvec, obj, img, n = r2, t2, o2, i2, n2
        if verbose:
            print(f"[find]   refine {it + 1}: {n} inliers")
    return rvec, tvec, obj, img, n


def find_pose(renderer, candidates, frame_gray, sift, focal_frame, render_wh,
              reproj, verbose=True, interior=False, seed=None, box=None):
    """
    Search viewpoints for the one that explains the keyframe, then refine it.

    Args:
        renderer: a ScanRenderer
        candidates: (eye, target) viewpoints to try
        frame_gray: the keyframe, greyscale
        sift: detector shared with the renders
        focal_frame: focal length in frame pixels to test with
        render_wh: (width, height) of each render
        reproj: RANSAC reprojection threshold in frame pixels
        interior: render the search at the camera's own field of view; from
            inside, the view has to resemble the frame, not just contain it
        seed: (rvec, tvec) already near the answer, e.g. carried over by
            tracking from a neighbouring anchor; skips the search entirely
        box: (lo, hi) the camera centre must lie within; see plausible()

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

    if seed is not None:
        return refine_pose(renderer, seed[0], seed[1], 0, None, None, sift,
                           matcher, f_pts, K, focal_frame, (fh, fw),
                           render_wh, reproj, up, verbose, box)

    # From outside, the render's own focal only has to frame the object; it
    # never has to match the camera, because only the world buffer is read
    # from it. From inside there is no framing the space, so render what the
    # camera would see.
    proj = perspective(focal_frame * rh / fh if interior
                       else 0.9 * max(rw, rh), rw, rh)

    best = (0, None, None, None, None)
    for eye, target in candidates:
        rgb, world, mask = renderer.render(
            look_at(eye, target, view_up(target - eye)), proj)
        if mask.mean() < 0.02:
            continue
        rvec, tvec, obj, img, n = match_render_to_frame(
            rgb, world, mask, sift, matcher, f_pts, K, reproj, up)
        if n > best[0] and plausible(rvec, tvec, box):
            best = (n, rvec, tvec, obj, img)
    if verbose:
        print(f"[find] best viewpoint gives {best[0]} PnP inliers")
    if best[1] is None:
        return None, None, None, None, 0

    n, rvec, tvec, obj, img = best
    return refine_pose(renderer, rvec, tvec, n, obj, img, sift, matcher,
                       f_pts, K, focal_frame, (fh, fw), render_wh, reproj,
                       up, verbose, box)


def sweep_focal(renderer, candidates, frame_gray, sift, width, height,
                render_wh, reproj, interior=False, box=None):
    """
    Choose a focal length by which one best explains the keyframe.

    The clips carry no usable EXIF, and with this little camera motion the
    focal cannot be recovered from the trajectory either. Testing it against
    the known model is the dependable option: the right focal wins on inliers.
    """
    print("[focal] sweeping against the model...")
    scores = {}

    def score(f):
        _, _, _, _, n = find_pose(renderer, candidates, frame_gray, sift, f,
                                  render_wh, reproj, verbose=False,
                                  interior=interior, box=box)
        scores[f] = n
        print(f"[focal]   f={f:7.1f}px -> {n:4d} inliers")
        return n

    # Spans roughly 30-120 degrees horizontally. The bottom end is the 0.5x
    # ultrawide (13mm-equivalent, near 0.4); a 24mm-equivalent main camera
    # lands near 0.67. The range used to stop at 0.55, and an ultrawide take
    # simply picked that edge - PnP then hid the wrong focal by moving the
    # camera, which lines up the centre of frame and nothing else.
    grid = [m * max(width, height)
            for m in (0.3, 0.36, 0.43, 0.5, 0.58, 0.67, 0.8, 0.95, 1.15,
                      1.4, 1.7)]
    for f in grid:
        score(f)
    if not any(scores.values()):
        raise SystemExit("[focal] no viewpoint matched at any focal length")

    # The grid steps ~18% at a time, which is coarse enough to leave a visible
    # misfit at the frame edges. Bisect the bracket around the winner.
    best = max(scores, key=scores.get)
    i = grid.index(best)
    lo = grid[max(0, i - 1)]
    hi = grid[min(len(grid) - 1, i + 1)]
    for f in (np.sqrt(lo * best), np.sqrt(best * hi)):
        if f != best:
            score(float(f))
    best = max(scores, key=scores.get)
    print(f"[focal] chose f={best:.1f}px ({scores[best]} inliers)")
    return best


def refine_focal(focal, width, height, matched, rounds=4):
    """
    Fit the focal directly from feature matches, rather than trusting a grid.

    Inlier counts from the sweep are a blunt score - a focal 10% out still
    collects plenty of matches near the centre of frame. Least squares over
    matches spread across the frame pins it properly, since the error at the
    frame edges is exactly what the wrong focal gets wrong.

    Only SIFT matches qualify. A matched feature's 3D point is wherever that
    texture sits on the scan, whatever focal found it. Densified points do
    not: their 3D comes from the render at the current focal and pose, so
    they agree with any focal they are given and the fit never moves.

    Args:
        matched: (object points, image points) pairs, one per located frame;
            pooling several frames steadies the fit

    Returns:
        focal
    """
    flags = (cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_PRINCIPAL_POINT
             | cv2.CALIB_FIX_ASPECT_RATIO | cv2.CALIB_ZERO_TANGENT_DIST
             | cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3)
    obj = [o.astype(np.float32) for o, _ in matched]
    img = [i.astype(np.float32) for _, i in matched]
    n = sum(len(o) for o in obj)
    if n < 30:
        return focal
    K = intrinsics(focal, width, height)
    rms, K2, _, _, _ = cv2.calibrateCamera(obj, img, (width, height), K,
                                           np.zeros(5), flags=flags)
    f2 = float(K2[0, 0])
    print(f"[focal]   fit f={f2:.1f}px (rms {rms:.2f}px on {n} matches "
          f"over {len(obj)} frame(s))")
    # Matches that no single focal explains - a mislocated frame among them,
    # say - can send the fit off to absurd values. Keep the sweep's answer
    # unless the fit actually agrees with its matches and stays in range.
    if rms > MAX_FOCAL_FIT_RMS or not 0.5 * focal <= f2 <= 2.0 * focal:
        print(f"[focal]   fit rejected, keeping f={focal:.1f}px")
        return focal
    return f2


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
                    reach=None, box=None):
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
        # One unusable anchor is not a dead run. The others each cover their
        # own stretch of the take, so this segment is simply dropped - which
        # beats throwing away a solve that got twenty-four anchors right.
        print(f"[track] anchor {key_idx}: correspondences do not solve, "
              "skipping this segment")
        return {}
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
            if plausible(r, t, box):
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

    The window narrows symmetrically towards either end of the take. Cut off
    on one side only, it would average a frame with its neighbours on the
    other, and a camera that is moving would lag behind itself there - by up
    to half a window of travel on the first and last frames (some 20px on a
    walking take).
    """
    if len(frames) < 3 or window < 3:
        return frames
    half = window // 2
    n = len(frames)

    tv = np.array([f["tvec"] for f in frames], dtype=np.float64)
    rot = Rotation.from_quat(np.array([f["qvec_xyzw"] for f in frames]))

    for i, f in enumerate(frames):
        k = min(half, i, n - 1 - i)
        lo, hi = i - k, i + k + 1
        f["tvec"] = tv[lo:hi].mean(axis=0).tolist()
        # Rotations are averaged in their own chart, not componentwise.
        f["qvec_xyzw"] = rot[lo:hi].mean().as_quat().tolist()
    return frames


def localise(work_dir: Path, glb: Path, n_views: int, render_w: int,
             reproj: float, smooth: int, focal: float | None,
             keyframe: int | None, anchors: int,
             min_anchor: int = MIN_ANCHOR_INLIERS,
             interior: bool = False) -> dict:
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
    render_wh = (render_w, render_h)

    # Where a camera may stand: inside the scan for an interior take, and
    # for an object, anywhere within a few radii of it.
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    margin = 0.05 * float((hi - lo).max()) if interior else 4.0 * radius
    box = (lo - margin, hi + margin)

    # The full search, and a thinner one for the focal sweep and fit, which
    # run it many times over.
    if interior:
        n_dirs = 26
        search = interior_candidates(verts, faces, uv, tex,
                                     max(8, n_views // n_dirs), n_dirs)
        quick = interior_candidates(verts, faces, uv, tex,
                                    max(4, n_views // (3 * n_dirs)), n_dirs)
    else:
        search = exterior_candidates(centre, radius, n_views)
        quick = exterior_candidates(centre, radius, max(60, n_views // 3))

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
    solved = {}
    try:
        if focal is None:
            focal = sweep_focal(renderer, quick, key_gray, sift, width,
                                height, render_wh, reproj, interior, box)
            # Match a few frames across the take at the current focal, fit,
            # and rematch at the fitted value: the PnP inliers a focal keeps
            # lean slightly towards it, so one pass would undershoot.
            fit_grays = [cv2.imread(str(paths[int(i)]), cv2.IMREAD_GRAYSCALE)
                         for i in np.linspace(0, len(paths) - 1, 5)[1:-1]]
            for _ in range(3):
                matched = []
                for gray in fit_grays:
                    rv, _, o, im, _ = find_pose(
                        renderer, quick, gray, sift, focal, render_wh,
                        reproj, verbose=False, interior=interior, box=box)
                    if rv is not None:
                        matched.append((o, im))
                f2 = refine_focal(focal, width, height, matched)
                step = abs(f2 - focal) / focal
                focal = f2
                if step < 0.005:
                    break
            print(f"[focal] using f={focal:.1f}px")
        K = intrinsics(focal, width, height)

        # Anchors run in order, each tracked as soon as it is located, so the
        # next one usually finds a pose already carried to its frame. Refining
        # from that skips the search - which from inside a space is hundreds
        # of renders - and it is still a fresh solve against the model, so
        # nothing drifts. The full search is the fallback.
        for ki in key_idxs:
            gray = cv2.imread(str(paths[ki]), cv2.IMREAD_GRAYSCALE)
            rvec, n = None, 0
            if ki in solved:
                rvec, tvec, obj, img, n = find_pose(
                    renderer, None, gray, sift, focal, render_wh, reproj,
                    verbose=False, seed=solved[ki][:2], box=box)
                if rvec is not None and n >= min_anchor:
                    print(f"[loc] anchor {ki}: refined from tracking")
            if rvec is None or n < min_anchor:
                rvec, tvec, obj, img, n = find_pose(
                    renderer, search, gray, sift, focal, render_wh, reproj,
                    verbose=False, interior=interior, box=box)
            if rvec is None:
                print(f"[loc] anchor {ki}: could not locate, skipping")
                continue
            if n < min_anchor:
                print(f"[loc] anchor {ki}: only {n} inliers "
                      f"(< {min_anchor}), skipping")
                continue
            d_obj, d_img, d_n = densify(renderer, rvec, tvec, gray, focal,
                                        render_wh, K, reproj)
            if d_n > n:
                print(f"[loc] anchor {ki}: {n} matched -> {d_n} densified")
                obj, img, n = d_obj, d_img, d_n
            else:
                print(f"[loc] anchor {ki}: {n} correspondences")
            seeds.append((ki, obj, img, n))

            # Each anchor votes for the frames it reaches; the one with the
            # most inliers on a given frame wins it.
            seg = track_and_solve(paths, ki, obj, img, K, reproj, reach=reach,
                                  box=box)
            for i, (r, t, n_inl) in seg.items():
                if i not in solved or n_inl > solved[i][2]:
                    solved[i] = (r, t, n_inl)
    finally:
        renderer.release()

    if not seeds:
        raise SystemExit("[loc] could not locate the camera on any keyframe")
    print(f"[loc] {len(seeds)} usable anchor(s) of {len(key_idxs)}")

    # The loop's own obj and n belong to whichever anchor ran last, which may
    # have been skipped; report the best one instead.
    _, obj, _, n = max(seeds, key=lambda s: s[3])
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
    ap.add_argument("--min-anchor", type=int, default=MIN_ANCHOR_INLIERS,
                    help="inliers an anchor needs before it is trusted")
    ap.add_argument("--interior", action="store_true",
                    help="the camera stands inside the scan (a room, a "
                         "stairwell); search from within, not around it")
    args = ap.parse_args()

    localise(args.work_dir, args.glb, args.views, args.render_width,
             args.reproj, args.smooth, args.focal, args.keyframe,
             args.anchors, args.min_anchor, args.interior)


if __name__ == "__main__":
    main()
