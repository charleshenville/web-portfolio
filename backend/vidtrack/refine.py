#!/usr/bin/env python3
"""
Pull a solved track into line with the footage by dense optical flow.

localize.py steers by SIFT matches, and SIFT only fires where the scan has
distinctive texture - a sign, a logo, lettering. On an object that is mostly
plain material that leaves the solve anchored by one small region and free to
swing everywhere else. Galbraith showed it plainly: the two signs at the foot
of a concrete column sat within a few pixels while the street number higher up
was 40px adrift, and every feature-based check called it aligned, because the
only features any of them could find were the ones already lined up.
Densification does not rescue this either; it reads its 3D points from a
render at the solve's own pose, so it inherits whatever that pose gets wrong.

Flow does not need features. DIS optical flow from the scan rendered at the
solved pose to the real frame gives an offset at every textured pixel - plain
concrete included - and each flow vector is a correspondence: its start, read
through the render's world buffer, is a 3D point on the scan, and its end is
where that point really is in the frame. Refining the pose on those by
least squares, re-rendering and repeating, pulls the whole object into line
rather than its most distinctive corner. On Galbraith the median offset in the
top quarter of the frame fell from 19px to 9px and the street number stopped
doubling.

Two guards keep it honest:

- Flow is checked forwards and backwards and only taken on textured pixels.
  Blank wall gives flow, but not information.
- A frame's refined pose is kept only if it leaves the flow residual lower
  than the solve did. Fast pans blur the footage and the flow with it; there
  the solve's pose stands.

The focal can be refitted on the same correspondences across a spread of
frames. A sweep against the model scores a focal by inlier count, which a
wrong focal earns plenty of near wherever the features are; dense
correspondences span the object, which is exactly what a wrong focal gets
wrong. The fit is kept only if it agrees with its points to within a few
pixels and stays near the solve's value.

What it cannot fix is the scan disagreeing with the footage. A scan warps,
slightly, wherever the capture was thin - the top of a tall column, say - and
no single camera then lines up every part of it. The refined residual in that
region is the scan's error, not the track's.

Reads sfm.json and rewrites it in place. The unrefined solve is kept as
sfm_solve.json, and a rerun refines from that rather than compounding.

Usage:
    python refine.py <work_dir> --glb <scan.glb>
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).parent))
from localize import gl_view_from_pose, load_scan, smooth_poses  # noqa: E402
from render import ScanRenderer, perspective  # noqa: E402

# Flow runs at half resolution: plenty for a few-pixel correction, and it
# keeps a take of a thousand frames to minutes.
FLOW_SCALE = 0.5
# Sample spacing for correspondences, in flow-resolution pixels.
GRID_STEP = 6
# Forward and backward flow must agree to within this, in flow pixels.
MAX_FB_ERROR = 1.0
# Minimum local texture (smoothed |Laplacian|) for a pixel to count.
MIN_TEXTURE = 2.0
# A frame with fewer usable correspondences keeps its solved pose.
MIN_POINTS = 150
# Residuals beyond max(this, 3x the median) are bad flow, not misalignment.
OUTLIER_FLOOR = 6.0
# A refitted focal must explain its correspondences to within this rms...
MAX_FOCAL_RMS = 3.0
# ...and land within this factor of the solve's focal.
MAX_FOCAL_CHANGE = 1.25
SOLVER_TAG = "+flow-refine"


class FlowMatcher:
    """Dense 2D-3D correspondences between the scan and one frame."""

    def __init__(self, renderer: ScanRenderer, width: int, height: int):
        self.renderer = renderer
        self.width, self.height = width, height
        self.dis = cv2.DISOpticalFlow_create(
            cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
        self.dis.setFinestScale(1)
        self.dis.setPatchSize(16)
        self.dis.setPatchStride(4)
        self.dis.setGradientDescentIterations(25)
        # Equalise both sides: a render and a photograph of the same surface
        # rarely share exposure, and DIS matches intensities.
        self.clahe = cv2.createCLAHE(3.0, (8, 8))

    def prepare(self, frame_gray: np.ndarray) -> np.ndarray:
        """Shrink and equalise a frame once, for every iteration on it."""
        small = cv2.resize(frame_gray, None, fx=FLOW_SCALE, fy=FLOW_SCALE)
        return self.clahe.apply(small)

    def correspondences(self, rvec, tvec, focal, frame_small):
        """
        Render at a pose and flow the render onto the frame.

        Returns:
            (3D points (N,3), image points (N,2)) in full-resolution pixels,
            or (None, None) if too little of the scan is in view
        """
        s = FLOW_SCALE
        proj = perspective(focal, self.width, self.height)
        rgb, world, mask = self.renderer.render(
            gl_view_from_pose(rvec, tvec), proj)
        render = self.clahe.apply(cv2.resize(
            cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), None, fx=s, fy=s))
        # Stay clear of the silhouette: its edge is the render's, not the
        # object's, and flow there is a guess.
        m = cv2.erode(cv2.resize(mask.astype(np.uint8), None, fx=s, fy=s,
                                 interpolation=cv2.INTER_NEAREST),
                      np.ones((15, 15), np.uint8)) > 0
        if m.sum() < 2000:
            return None, None
        # Outside the scan, show the frame itself, so flow there is zero and
        # does not drag at the edge of the object.
        render = np.where(m, render, frame_small)
        fw = self.dis.calc(render, frame_small, None)
        bw = self.dis.calc(frame_small, render, None)

        gy, gx = np.mgrid[GRID_STEP // 2:m.shape[0]:GRID_STEP,
                          GRID_STEP // 2:m.shape[1]:GRID_STEP]
        gx, gy = gx.ravel(), gy.ravel()
        inside = m[gy, gx]
        gx, gy = gx[inside], gy[inside]
        f = fw[gy, gx]
        tx = np.clip(np.round(gx + f[:, 0]).astype(int), 0, m.shape[1] - 1)
        ty = np.clip(np.round(gy + f[:, 1]).astype(int), 0, m.shape[0] - 1)
        consistent = np.linalg.norm(f + bw[ty, tx], axis=1) < MAX_FB_ERROR
        texture = np.abs(cv2.GaussianBlur(
            cv2.Laplacian(render, cv2.CV_32F, ksize=3), (9, 9), 0))
        ok = consistent & (texture[gy, gx] > MIN_TEXTURE)
        gx, gy, f = gx[ok], gy[ok], f[ok]

        X = world[(gy / s).astype(int), (gx / s).astype(int)]
        img = np.stack([(gx + f[:, 0]) / s, (gy + f[:, 1]) / s], axis=1)
        return X.astype(np.float64), img.astype(np.float64)


def intrinsics(focal: float, width: int, height: int) -> np.ndarray:
    return np.array([[focal, 0, width / 2.0],
                     [0, focal, height / 2.0],
                     [0, 0, 1.0]])


def residuals(X, img, rvec, tvec, K) -> np.ndarray:
    proj, _ = cv2.projectPoints(X, rvec, tvec, K, None)
    return np.linalg.norm(proj.reshape(-1, 2) - img, axis=1)


def refine_pose(matcher, frame_small, rvec, tvec, focal, iters):
    """
    Refine one frame's pose against flow, re-rendering each round.

    Returns:
        (rvec, tvec, residual before, residual after, points used); the pose
        comes back unchanged if refining did not improve on it
    """
    K = intrinsics(focal, matcher.width, matcher.height)
    X, img = matcher.correspondences(rvec, tvec, focal, frame_small)
    if X is None or len(X) < MIN_POINTS:
        return rvec, tvec, None, None, 0
    before = float(np.median(residuals(X, img, rvec, tvec, K)))
    r, t = rvec.copy(), tvec.copy()
    used = 0
    for _ in range(iters):
        e = residuals(X, img, r, t, K)
        # Generous on purpose: an area uniformly 20px off is the error being
        # corrected, not an outlier.
        keep = e < max(OUTLIER_FLOOR, 3.0 * float(np.median(e)))
        if keep.sum() < MIN_POINTS:
            break
        r, t = cv2.solvePnPRefineLM(X[keep], img[keep], K, None, r, t)
        used = int(keep.sum())
        X, img = matcher.correspondences(r, t, focal, frame_small)
        if X is None or len(X) < MIN_POINTS:
            return rvec, tvec, before, None, 0
    after = float(np.median(residuals(X, img, r, t, K)))
    if after >= before:
        return rvec, tvec, before, before, 0
    return r, t, before, after, used


def fit_focal(matcher, frames_small, poses, focal):
    """
    Refit the focal on dense correspondences pooled over several frames.

    Returns:
        the fitted focal, or the given one if the fit does not hold up
    """
    W, H = matcher.width, matcher.height
    objs, imgs = [], []
    for small, (r, t) in zip(frames_small, poses):
        X, img = matcher.correspondences(r, t, focal, small)
        if X is not None and len(X) >= MIN_POINTS:
            objs.append(X.astype(np.float32))
            imgs.append(img.astype(np.float32))
    if len(objs) < 3:
        print("[refine] too few frames to fit the focal, keeping it")
        return focal
    flags = (cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_PRINCIPAL_POINT
             | cv2.CALIB_FIX_ASPECT_RATIO | cv2.CALIB_ZERO_TANGENT_DIST
             | cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3)
    K = intrinsics(focal, W, H)
    # Fit, drop each frame's worst residuals, refit: what survives is the
    # set of points one lens can explain, which bad flow is not part of.
    for _ in range(3):
        rms, K2, _, rvs, tvs = cv2.calibrateCamera(
            objs, imgs, (W, H), K.copy(), np.zeros(5), flags=flags)
        kept_o, kept_i = [], []
        for o, im, r, t in zip(objs, imgs, rvs, tvs):
            e = residuals(o, im, r, t, K2)
            k = e < max(3.0, float(np.percentile(e, 80)))
            kept_o.append(o[k])
            kept_i.append(im[k])
        objs, imgs = kept_o, kept_i
    f2 = float(K2[0, 0])
    print(f"[refine] focal fit {f2:.1f}px (rms {rms:.2f}px over "
          f"{len(objs)} frames)")
    if rms > MAX_FOCAL_RMS or not (focal / MAX_FOCAL_CHANGE <= f2
                                   <= focal * MAX_FOCAL_CHANGE):
        print(f"[refine] focal fit rejected, keeping {focal:.1f}px")
        return focal
    return f2


def band_medians(per_frame, height) -> list:
    """Median residual in each quarter of the frame, top to bottom."""
    bands = [[] for _ in range(4)]
    for img, e in per_frame:
        b = np.clip((img[:, 1] / (height / 4)).astype(int), 0, 3)
        for k in range(4):
            bands[k].extend(e[b == k].tolist())
    return [round(float(np.median(x)), 1) if x else None for x in bands]


def refine(work_dir: Path, glb: Path, iters: int, smooth: int,
           fit: bool, focal_frames: int) -> None:
    sfm_path = work_dir / "sfm.json"
    solve_path = work_dir / "sfm_solve.json"
    data = json.loads(sfm_path.read_text())
    if SOLVER_TAG in data.get("solver", ""):
        if not solve_path.exists():
            raise SystemExit(f"{sfm_path} is already refined and there is no "
                             f"{solve_path.name} to refine from")
        data = json.loads(solve_path.read_text())
    else:
        solve_path.write_text(json.dumps(data, indent=2))

    intr = data["intrinsics"]
    W, H = intr["width"], intr["height"]
    focal = float(intr["fy"])
    frames = data["frames"]
    print(f"[refine] {len(frames)} solved frames at f={focal:.1f}px")

    verts, faces, uv, tex = load_scan(glb)
    renderer = ScanRenderer(verts, faces, uv, tex, W, H)
    matcher = FlowMatcher(renderer, W, H)

    def pose(f):
        R = Rotation.from_quat(f["qvec_xyzw"]).as_matrix()
        rvec, _ = cv2.Rodrigues(R)
        return rvec, np.asarray(f["tvec"], dtype=np.float64).reshape(3, 1)

    def load(f):
        gray = cv2.imread(str(work_dir / "frames" / f"{f['index']:04d}.jpg"),
                          cv2.IMREAD_GRAYSCALE)
        return matcher.prepare(gray)

    try:
        if fit:
            # Refine a spread of frames at the solve's focal first, so the
            # fit starts from poses that already respect the whole object.
            picks = [frames[int(i)] for i in
                     np.linspace(0, len(frames) - 1, focal_frames + 2)[1:-1]]
            smalls = [load(f) for f in picks]
            starts = []
            for f, small in zip(picks, smalls):
                r, t = pose(f)
                r, t, _, _, _ = refine_pose(matcher, small, r, t, focal, iters)
                starts.append((r, t))
            focal = fit_focal(matcher, smalls, starts, focal)

        K = intrinsics(focal, W, H)
        out, before_px, after_px = [], [], []
        improved = kept = 0
        for n, f in enumerate(frames):
            small = load(f)
            r0, t0 = pose(f)
            r, t, before, after, used = refine_pose(
                matcher, small, r0, t0, focal, iters)
            if after is not None and after < (before or 0):
                improved += 1
            else:
                kept += 1
            # For the before/after report, measure both poses on the same
            # correspondences: those of the final pose.
            X, img = matcher.correspondences(r, t, focal, small)
            if X is not None and len(X) >= MIN_POINTS:
                before_px.append((img, residuals(X, img, r0, t0, K)))
                after_px.append((img, residuals(X, img, r, t, K)))
            Rm, _ = cv2.Rodrigues(r)
            out.append({**f, "qvec_xyzw": Rotation.from_matrix(Rm).as_quat().tolist(),
                        "tvec": t.ravel().tolist(),
                        "num_points": max(int(f["num_points"]), used)})
            if n % 50 == 0:
                print(f"[refine]   frame {f['index']}: "
                      f"{before if before is None else round(before, 2)} -> "
                      f"{after if after is None else round(after, 2)}px",
                      flush=True)
    finally:
        renderer.release()

    print(f"[refine] {improved} frames refined, {kept} kept their solved pose")
    print(f"[refine] median flow residual by quarter of frame, top to bottom: "
          f"{band_medians(before_px, H)} -> {band_medians(after_px, H)}px")

    if smooth > 1:
        out = smooth_poses(out, smooth)
        print(f"[refine] smoothed over a {smooth}-frame window")

    data["frames"] = out
    data["solver"] = data.get("solver", "") + SOLVER_TAG
    for k in ("fx", "fy"):
        data["intrinsics"][k] = focal
        data["intrinsics"]["params"][k] = focal
    sfm_path.write_text(json.dumps(data, indent=2))
    print(f"[refine] wrote {sfm_path} (unrefined solve kept as "
          f"{solve_path.name})")


def main():
    ap = argparse.ArgumentParser(
        description="Refine a solved track against the scan by optical flow")
    ap.add_argument("work_dir", type=Path)
    ap.add_argument("--glb", type=Path, required=True)
    ap.add_argument("--iters", type=int, default=3,
                    help="render-flow-refine rounds per frame")
    ap.add_argument("--smooth", type=int, default=7,
                    help="trajectory smoothing window after refining")
    ap.add_argument("--no-focal-fit", action="store_true",
                    help="keep the solve's focal rather than refitting it")
    ap.add_argument("--focal-frames", type=int, default=8,
                    help="frames pooled for the focal fit")
    args = ap.parse_args()
    refine(args.work_dir, args.glb, args.iters, args.smooth,
           not args.no_focal_fit, args.focal_frames)


if __name__ == "__main__":
    main()
