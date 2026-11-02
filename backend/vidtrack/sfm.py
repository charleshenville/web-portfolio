#!/usr/bin/env python3
"""
Structure-from-motion over the frames of a scan video.

Runs COLMAP (via pycolmap) on a directory of extracted frames to recover the
camera intrinsics, a camera pose per frame, and a sparse coloured point cloud.
The poses land in COLMAP's own arbitrary world frame at an arbitrary scale;
align.py is what brings them into the GLB's coordinate system.

Usage:
    python sfm.py <work_dir> [--matcher exhaustive|sequential]

<work_dir> must already contain a frames/ directory (see extract_frames.sh).
Writes <work_dir>/sparse/ (COLMAP model), <work_dir>/sfm.json and
<work_dir>/sfm_points.ply.
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pycolmap


def run_sfm(work_dir: Path, matcher: str = "exhaustive",
            overlap: int = 20, reuse: bool = True) -> pycolmap.Reconstruction:
    """
    Extract features, match them across frames and run incremental mapping.

    Args:
        work_dir: Directory holding frames/, where outputs are written
        matcher: "exhaustive" (every pair; robust, implicit loop closure) or
            "sequential" (neighbours only; faster on long clips)
        overlap: Neighbour window for the sequential matcher
        reuse: Skip extraction/matching if the database already has them

    Returns:
        The largest pycolmap.Reconstruction
    """
    frames_dir = work_dir / "frames"
    db_path = work_dir / "database.db"
    sparse_dir = work_dir / "sparse"

    if not frames_dir.is_dir():
        raise SystemExit(f"No frames directory at {frames_dir}")

    n_frames = len(list(frames_dir.glob("*.jpg")))
    print(f"[sfm] {work_dir.name}: {n_frames} frames, matcher={matcher}")

    if db_path.exists() and not reuse:
        db_path.unlink()

    # One physical camera shot the whole clip, so solve a single shared
    # intrinsic set rather than one per frame.
    if not db_path.exists():
        t0 = time.time()
        print("[sfm] extracting features...")
        pycolmap.extract_features(
            database_path=db_path,
            image_path=frames_dir,
            camera_mode=pycolmap.CameraMode.SINGLE,
        )
        print(f"[sfm] features done in {time.time() - t0:.1f}s")

        t0 = time.time()
        print(f"[sfm] matching ({matcher})...")
        if matcher == "sequential":
            pairing = pycolmap.SequentialPairingOptions()
            pairing.overlap = overlap
            pairing.quadratic_overlap = True
            pycolmap.match_sequential(database_path=db_path, pairing_options=pairing)
        else:
            pycolmap.match_exhaustive(database_path=db_path)
        print(f"[sfm] matching done in {time.time() - t0:.1f}s")
    else:
        print(f"[sfm] reusing existing database {db_path}")

    if sparse_dir.exists():
        shutil.rmtree(sparse_dir)
    sparse_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    print("[sfm] incremental mapping...")
    recs = pycolmap.incremental_mapping(
        database_path=db_path,
        image_path=frames_dir,
        output_path=sparse_dir,
    )
    print(f"[sfm] mapping done in {time.time() - t0:.1f}s")

    if not recs:
        raise SystemExit("[sfm] reconstruction failed: no model produced")

    # Several disconnected submodels can come back; the useful one is whichever
    # registered the most frames.
    best_id = max(recs, key=lambda k: recs[k].num_reg_images())
    rec = recs[best_id]
    print(f"[sfm] {len(recs)} model(s); using #{best_id}: "
          f"{rec.num_reg_images()}/{n_frames} frames registered, "
          f"{rec.num_points3D()} points")
    return rec


def export_sfm(rec: pycolmap.Reconstruction, work_dir: Path,
               min_track_len: int = 3, max_error: float = 2.0) -> dict:
    """
    Dump the reconstruction to JSON plus a coloured PLY of the sparse cloud.

    Poses are stored exactly as COLMAP holds them: cam_from_world, OpenCV
    convention (camera looks down +Z, Y down). The conversion to a renderer's
    convention happens at export time in export_track.py.

    Args:
        rec: The reconstruction
        work_dir: Directory to write sfm.json and sfm_points.ply into
        min_track_len: Drop points seen by fewer than this many frames
        max_error: Drop points whose reprojection error exceeds this (px)

    Returns:
        The dict written to sfm.json
    """
    cams = list(rec.cameras.values())
    if len(cams) != 1:
        print(f"[sfm] warning: {len(cams)} cameras in model, using the first")
    cam = cams[0]

    # Normalise whatever model COLMAP chose down to a pinhole + the radial
    # terms we care about, so the web viewer can rebuild the projection.
    params = dict(zip(cam.params_info.split(", "), [float(p) for p in cam.params]))
    intr = {
        "model": cam.model.name,
        "width": int(cam.width),
        "height": int(cam.height),
        "fx": float(params.get("f", params.get("fx", 0.0))),
        "fy": float(params.get("f", params.get("fy", 0.0))),
        "cx": float(params["cx"]),
        "cy": float(params["cy"]),
        "params": params,
    }
    print(f"[sfm] intrinsics {intr['model']}: "
          f"fx={intr['fx']:.1f} fy={intr['fy']:.1f} "
          f"cx={intr['cx']:.1f} cy={intr['cy']:.1f}")

    frames = []
    for img in rec.images.values():
        if not img.has_pose:
            continue
        # 4.x exposes this as a method computed off the rig/frame pose, while
        # older builds expose a plain Rigid3d property.
        rigid = img.cam_from_world
        if callable(rigid):
            rigid = rigid()
        q = rigid.rotation.quat  # (x, y, z, w)
        frames.append({
            "name": img.name,
            "index": int(Path(img.name).stem),
            "qvec_xyzw": [float(v) for v in q],
            "tvec": [float(v) for v in rigid.translation],
            "num_points": int(len(img.get_observation_points2D())),
        })
    frames.sort(key=lambda f: f["index"])
    print(f"[sfm] exported {len(frames)} posed frames")

    xyz, rgb = [], []
    for p in rec.points3D.values():
        if p.track.length() < min_track_len or p.error > max_error:
            continue
        xyz.append(p.xyz)
        rgb.append(p.color)
    xyz = np.asarray(xyz, dtype=np.float64)
    rgb = np.asarray(rgb, dtype=np.uint8)
    print(f"[sfm] sparse cloud: {len(xyz)} points after filtering "
          f"(track>={min_track_len}, err<={max_error}px)")

    write_ply(work_dir / "sfm_points.ply", xyz, rgb)

    data = {
        "source": work_dir.name,
        "intrinsics": intr,
        "frames": frames,
        "num_points": int(len(xyz)),
    }
    (work_dir / "sfm.json").write_text(json.dumps(data, indent=2))
    return data


def write_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    """Write a binary little-endian coloured point-cloud PLY."""
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {len(xyz)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "end_header\n"
    )
    rec = np.zeros(len(xyz), dtype=[
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
        ("r", "u1"), ("g", "u1"), ("b", "u1"),
    ])
    rec["x"], rec["y"], rec["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    rec["r"], rec["g"], rec["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(rec.tobytes())
    print(f"[sfm] wrote {path}")


def main():
    ap = argparse.ArgumentParser(description="Run COLMAP SfM over video frames")
    ap.add_argument("work_dir", type=Path)
    ap.add_argument("--matcher", choices=["exhaustive", "sequential"],
                    default="exhaustive")
    ap.add_argument("--overlap", type=int, default=20,
                    help="neighbour window for the sequential matcher")
    ap.add_argument("--fresh", action="store_true",
                    help="rebuild the feature database from scratch")
    args = ap.parse_args()

    rec = run_sfm(args.work_dir, matcher=args.matcher, overlap=args.overlap,
                  reuse=not args.fresh)
    export_sfm(rec, args.work_dir)
    print("[sfm] done")


if __name__ == "__main__":
    main()
