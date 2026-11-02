#!/usr/bin/env python3
"""
Register a COLMAP reconstruction into the coordinate frame of a GLB scan.

Monocular SfM recovers geometry only up to a similarity: the sparse cloud and
camera trajectory sit in an arbitrary frame at an arbitrary scale. The GLB from
the scanning app is the frame we actually want to render in, so we solve the
7-DOF similarity (scale, rotation, translation) that carries SfM space onto
mesh space, then apply its inverse reasoning to the cameras at export time.

The search is a multi-start trimmed similarity-ICP:

  1. Locate the object in SfM space as the least-squares intersection of the
     camera optical axes - the user orbited the object, so their view rays
     converge on it. This separates the object from background clutter far
     better than any statistical outlier filter, because the GLB contains the
     object alone while the SfM cloud also sees the room.
  2. Seed scale and translation from the two clouds' robust radii and centres.
  3. Refine from many random rotations, keeping correspondences trimmed so
     surviving background points cannot drag the fit.
  4. Rank the survivors by geometry *and* colour agreement. Colour is what
     breaks the rotational tie on a symmetric object - a box fits its own
     90-degree rotation perfectly well on geometry alone.

Usage:
    python align.py <work_dir> --mesh <scan.ply> [--out alignment.json]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).parent))
from sfm import write_ply  # noqa: E402


# ---------------------------------------------------------------- PLY loading

def read_ply(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """
    Read a binary-little-endian or ascii coloured point-cloud PLY.

    Only the subset of PLY this pipeline produces is supported: a single vertex
    element with float x/y/z and uchar red/green/blue.

    Returns:
        (xyz float64 (N,3), rgb uint8 (N,3))
    """
    with open(path, "rb") as f:
        header_bytes = b""
        while b"end_header" not in header_bytes:
            chunk = f.readline()
            if not chunk:
                raise ValueError(f"{path}: no end_header found")
            header_bytes += chunk
        header = header_bytes.decode("ascii", "replace")
        lines = [ln.strip() for ln in header.splitlines()]

        fmt = next(ln.split()[1] for ln in lines if ln.startswith("format"))
        count = next(int(ln.split()[2]) for ln in lines
                     if ln.startswith("element vertex"))
        props = [ln.split()[1:] for ln in lines if ln.startswith("property")]

        if fmt == "binary_little_endian":
            np_types = {
                "float": "<f4", "float32": "<f4", "double": "<f8",
                "uchar": "u1", "uint8": "u1", "char": "i1",
                "short": "<i2", "ushort": "<u2",
                "int": "<i4", "uint": "<u4",
            }
            dtype = np.dtype([(name, np_types[t]) for t, name in props])
            data = np.frombuffer(f.read(dtype.itemsize * count), dtype=dtype,
                                 count=count)
        elif fmt == "ascii":
            names = [name for _, name in props]
            raw = np.loadtxt(f, max_rows=count)
            data = {n: raw[:, i] for i, n in enumerate(names)}
        else:
            raise ValueError(f"{path}: unsupported PLY format {fmt}")

    xyz = np.stack([np.asarray(data["x"], dtype=np.float64),
                    np.asarray(data["y"], dtype=np.float64),
                    np.asarray(data["z"], dtype=np.float64)], axis=1)
    if "red" in (p[1] for p in props):
        rgb = np.stack([np.asarray(data["red"]), np.asarray(data["green"]),
                        np.asarray(data["blue"])], axis=1).astype(np.uint8)
    else:
        rgb = np.full((len(xyz), 3), 128, dtype=np.uint8)
    return xyz, rgb


# ------------------------------------------------------- geometry primitives

def quat_xyzw_to_matrix(q: np.ndarray) -> np.ndarray:
    """Rotation matrix from an (x, y, z, w) quaternion."""
    return Rotation.from_quat(np.asarray(q, dtype=np.float64)).as_matrix()


def camera_centres_and_axes(frames: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """
    Convert COLMAP cam_from_world poses into world-space centres and optical axes.

    COLMAP stores world->camera as (R, t) in OpenCV convention, so the camera
    centre is -R^T t and the viewing direction is the third row of R.

    Returns:
        (centres (N,3), axes (N,3) unit vectors)
    """
    centres, axes = [], []
    for fr in frames:
        R = quat_xyzw_to_matrix(fr["qvec_xyzw"])
        t = np.asarray(fr["tvec"], dtype=np.float64)
        centres.append(-R.T @ t)
        axes.append(R[2, :])  # +Z of the camera, in world coordinates
    return np.asarray(centres), np.asarray(axes)


def ray_convergence_point(origins: np.ndarray, dirs: np.ndarray) -> np.ndarray:
    """
    Least-squares point closest to a bundle of rays.

    Minimises the sum of squared perpendicular distances to every optical axis,
    which for an orbiting camera lands on the subject.
    """
    dirs = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    A = np.zeros((3, 3))
    b = np.zeros(3)
    eye = np.eye(3)
    for o, d in zip(origins, dirs):
        proj = eye - np.outer(d, d)  # projects onto the plane normal to d
        A += proj
        b += proj @ o
    return np.linalg.solve(A, b)


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """
    Least-squares similarity transform mapping src onto dst (Umeyama 1991).

    Returns:
        (scale, rotation (3,3), translation (3,)) such that
        dst ~= scale * rotation @ src + translation
    """
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    X = src - src_mean
    Y = dst - dst_mean

    cov = (Y.T @ X) / len(src)
    U, S, Vt = np.linalg.svd(cov)
    d = np.sign(np.linalg.det(U @ Vt))
    D = np.diag([1.0, 1.0, d])
    R = U @ D @ Vt

    var_src = (X ** 2).sum() / len(src)
    scale = float(np.trace(np.diag(S) @ D) / var_src) if var_src > 0 else 1.0
    t = dst_mean - scale * (R @ src_mean)
    return scale, R, t


def apply_sim(xyz: np.ndarray, scale: float, R: np.ndarray,
              t: np.ndarray) -> np.ndarray:
    """Apply a similarity transform to a point array."""
    return scale * (xyz @ R.T) + t


# ------------------------------------------------------------- trimmed ICP

def trimmed_icp(src: np.ndarray, tree: cKDTree, trim: float,
                scale: float, R: np.ndarray, t: np.ndarray,
                iters: int = 40, tol: float = 1e-6
                ) -> tuple[float, np.ndarray, np.ndarray, float, float]:
    """
    Similarity ICP that fits to only the best-matching fraction of points.

    Trimming is what makes this usable here: the source cloud contains room
    geometry that has no counterpart in the target mesh, and a plain
    least-squares fit would be dragged outwards by it. Keeping the closest
    `trim` fraction each iteration lets the object dominate.

    Args:
        src: Source points (N,3)
        tree: KD-tree over the target points
        trim: Fraction of correspondences to keep, in (0, 1]
        scale, R, t: Initial similarity
        iters: Maximum iterations
        tol: Stop when the trimmed RMS improves by less than this fraction

    Returns:
        (scale, R, t, trimmed_rms, inlier_rms) for the converged fit
    """
    keep = max(8, int(len(src) * trim))
    prev = np.inf
    rms = np.inf

    for _ in range(iters):
        moved = apply_sim(src, scale, R, t)
        dist, idx = tree.query(moved, k=1, workers=-1)

        order = np.argsort(dist)[:keep]
        rms = float(np.sqrt((dist[order] ** 2).mean()))

        # Re-fit on the surviving pairs. Note the fit is from the *original*
        # source points so the transform stays absolute rather than incremental.
        s2, R2, t2 = umeyama(src[order], tree.data[idx[order]])
        scale, R, t = s2, R2, t2

        if prev - rms <= tol * max(prev, 1e-12):
            break
        prev = rms

    moved = apply_sim(src, scale, R, t)
    dist, _ = tree.query(moved, k=1, workers=-1)
    order = np.argsort(dist)[:keep]
    return scale, R, t, rms, float(np.sqrt((dist[order] ** 2).mean()))


def colour_agreement(src: np.ndarray, src_rgb: np.ndarray, tree: cKDTree,
                     tgt_rgb: np.ndarray, scale: float, R: np.ndarray,
                     t: np.ndarray, trim: float) -> float:
    """
    Mean colour distance over the geometrically best-matching correspondences.

    Used to rank candidate fits that are geometrically indistinguishable, which
    is the normal case for a box or any other symmetric subject.

    Returns:
        Mean per-channel RGB distance in [0, 441]; lower is better
    """
    moved = apply_sim(src, scale, R, t)
    dist, idx = tree.query(moved, k=1, workers=-1)
    keep = max(8, int(len(src) * trim))
    order = np.argsort(dist)[:keep]
    diff = (src_rgb[order].astype(np.float64)
            - tgt_rgb[idx[order]].astype(np.float64))
    return float(np.linalg.norm(diff, axis=1).mean())


# ----------------------------------------------------------------- pipeline

def subsample(xyz: np.ndarray, n: int, rng: np.random.Generator,
              *extra: np.ndarray) -> tuple[np.ndarray, ...]:
    """Randomly subsample a cloud (and any parallel arrays) down to n points."""
    if len(xyz) <= n:
        return (xyz, *extra)
    sel = rng.choice(len(xyz), size=n, replace=False)
    return (xyz[sel], *[e[sel] for e in extra])


def align(work_dir: Path, mesh_ply: Path, n_rotations: int = 600,
          trim: float = 0.55, core_percentile: float = 75.0,
          seed: int = 0) -> dict:
    """
    Solve the similarity transform from SfM space to mesh space.

    Args:
        work_dir: Directory holding sfm.json and sfm_points.ply
        mesh_ply: Point cloud sampled from the GLB (see glb_to_ply.py)
        n_rotations: Random rotation seeds for the coarse search
        trim: Correspondence fraction kept by ICP
        core_percentile: Percentile of the radius distribution treated as
            "on the object" when seeding and when filtering clutter
        seed: RNG seed

    Returns:
        The alignment dict, also written to <work_dir>/alignment.json
    """
    rng = np.random.default_rng(seed)
    sfm = json.loads((work_dir / "sfm.json").read_text())
    frames = sfm["frames"]

    src_all, src_rgb_all = read_ply(work_dir / "sfm_points.ply")
    tgt_all, tgt_rgb_all = read_ply(mesh_ply)
    print(f"[align] sfm cloud {len(src_all)} pts, mesh cloud {len(tgt_all)} pts")

    # --- 1. Find the object in SfM space from where the cameras were looking.
    centres, axes = camera_centres_and_axes(frames)
    focus = ray_convergence_point(centres, axes)
    cam_radius = float(np.median(np.linalg.norm(centres - focus, axis=1)))
    print(f"[align] camera axes converge at {np.round(focus, 4).tolist()}, "
          f"median orbit radius {cam_radius:.4f}")

    # Keep the dense core around that focus; the rest is room.
    radii = np.linalg.norm(src_all - focus, axis=1)
    cut = float(np.percentile(radii, core_percentile))
    core = radii <= cut
    src_core = src_all[core]
    src_core_rgb = src_rgb_all[core]
    print(f"[align] object core: {core.sum()}/{len(src_all)} pts "
          f"within {cut:.4f} of focus")

    # --- 2. Seed the similarity from robust radii about each cloud's centre.
    tgt_centre = tgt_all.mean(axis=0)
    src_centre = src_core.mean(axis=0)
    src_scale = float(np.sqrt(((src_core - src_centre) ** 2).sum(axis=1).mean()))
    tgt_scale = float(np.sqrt(((tgt_all - tgt_centre) ** 2).sum(axis=1).mean()))
    scale0 = tgt_scale / src_scale
    print(f"[align] seed scale {scale0:.4f} "
          f"(sfm rms radius {src_scale:.4f} -> mesh {tgt_scale:.4f})")

    # --- 3. Multi-start ICP over rotation.
    tgt_small, tgt_rgb_small = subsample(tgt_all, 60000, rng, tgt_rgb_all)
    tree_small = cKDTree(tgt_small)
    src_coarse, src_coarse_rgb = subsample(src_core, 4000, rng, src_core_rgb)

    rotations = [np.eye(3)]
    # The 24 rotations of the cube cover the common case of a scan that is
    # already axis-aligned but permuted or flipped.
    for perm in [(0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)]:
        for signs in [(1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)]:
            M = np.zeros((3, 3))
            for i, (p, s) in enumerate(zip(perm, signs)):
                M[i, p] = s
            if np.isclose(np.linalg.det(M), 1.0):
                rotations.append(M)
    rotations.extend(Rotation.random(n_rotations, random_state=seed).as_matrix())
    print(f"[align] coarse search over {len(rotations)} rotations...")

    cands = []
    for R0 in rotations:
        t0 = tgt_centre - scale0 * (R0 @ src_centre)
        s, R, t, rms, _ = trimmed_icp(src_coarse, tree_small, trim,
                                      scale0, R0, t0, iters=18, tol=1e-4)
        cands.append((rms, s, R, t))

    cands.sort(key=lambda c: c[0])
    print(f"[align] coarse best trimmed rms {cands[0][0]:.5f}, "
          f"median {np.median([c[0] for c in cands]):.5f}")

    # --- 4. Refine the leaders properly, then rank on geometry plus colour.
    tree_full = cKDTree(tgt_all)
    src_fine, src_fine_rgb = subsample(src_core, 20000, rng, src_core_rgb)
    diag = float(np.linalg.norm(tgt_all.max(axis=0) - tgt_all.min(axis=0)))

    refined = []
    for rms0, s0, R0, t0 in cands[:12]:
        s, R, t, rms, inl = trimmed_icp(src_fine, tree_full, trim, s0, R0, t0,
                                        iters=60, tol=1e-7)
        col = colour_agreement(src_fine, src_fine_rgb, tree_full, tgt_rgb_all,
                               s, R, t, trim)
        # Geometry normalised by the mesh diagonal, colour by its 0-441 range,
        # so the two terms are comparable before weighting.
        score = (rms / diag) + 0.35 * (col / 441.0)
        refined.append({"score": score, "rms": rms, "inlier_rms": inl,
                        "colour": col, "scale": s, "R": R, "t": t})
        print(f"[align]   cand rms={rms / diag:.5f}*diag colour={col:6.1f} "
              f"scale={s:.4f} -> score {score:.5f}")

    refined.sort(key=lambda c: c["score"])
    best = refined[0]

    moved = apply_sim(src_fine, best["scale"], best["R"], best["t"])
    dist, _ = tree_full.query(moved, k=1, workers=-1)
    inlier_frac = float((dist < 0.02 * diag).mean())
    print(f"[align] BEST score={best['score']:.5f} "
          f"rms={best['rms'] / diag:.5f}*diag colour={best['colour']:.1f} "
          f"inliers(<2% diag)={inlier_frac * 100:.1f}%")

    # Diagnostic: the SfM cloud carried into mesh space. Load it next to the
    # mesh in any viewer to eyeball the fit.
    write_ply(work_dir / "sfm_aligned.ply",
              apply_sim(src_all, best["scale"], best["R"], best["t"]),
              src_rgb_all)

    out = {
        "source": work_dir.name,
        "mesh_ply": str(mesh_ply),
        "scale": float(best["scale"]),
        "rotation": [[float(v) for v in row] for row in best["R"]],
        "translation": [float(v) for v in best["t"]],
        "quality": {
            "trimmed_rms": float(best["rms"]),
            "trimmed_rms_rel_diag": float(best["rms"] / diag),
            "colour_mean_dist": float(best["colour"]),
            "inlier_fraction_2pct": inlier_frac,
            "mesh_diagonal": diag,
            "score": float(best["score"]),
        },
        "focus_sfm": [float(v) for v in focus],
        "camera_orbit_radius_sfm": cam_radius,
    }
    (work_dir / "alignment.json").write_text(json.dumps(out, indent=2))
    print(f"[align] wrote {work_dir / 'alignment.json'}")
    return out


def main():
    ap = argparse.ArgumentParser(
        description="Register a COLMAP model into a GLB scan's coordinate frame")
    ap.add_argument("work_dir", type=Path)
    ap.add_argument("--mesh", type=Path, required=True,
                    help="point cloud PLY sampled from the GLB")
    ap.add_argument("--rotations", type=int, default=600)
    ap.add_argument("--trim", type=float, default=0.55)
    ap.add_argument("--core-percentile", type=float, default=75.0)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    align(args.work_dir, args.mesh, n_rotations=args.rotations, trim=args.trim,
          core_percentile=args.core_percentile, seed=args.seed)


if __name__ == "__main__":
    main()
