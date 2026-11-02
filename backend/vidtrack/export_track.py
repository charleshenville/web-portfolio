#!/usr/bin/env python3
"""
Turn an aligned COLMAP reconstruction into the track the web viewer consumes.

Three conversions happen here:

  * Convention. COLMAP stores world->camera with the camera looking down +Z
    and Y pointing down (OpenCV). Renderers like three.js look down -Z with Y
    up, so each basis is post-multiplied by diag(1, -1, -1).
  * Frame. The similarity from align.py carries camera centres and bases out
    of SfM space and into the GLB's own coordinates, so the mesh can simply sit
    at the origin of the scene untransformed.
  * Lens. COLMAP solves a radial distortion term that a pinhole projection
    cannot reproduce. Rather than approximate the lens in the renderer, the
    frames are undistorted once here and re-encoded, after which projecting
    with the plain intrinsic matrix is exact.

Frames COLMAP could not register are filled by interpolation so playback never
stalls, and are flagged so the viewer can show where the solve is guessing.

Usage:
    python export_track.py <work_dir> --out-dir <public/mv/name> [--no-video]
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

sys.path.insert(0, str(Path(__file__).parent))
from align import quat_xyzw_to_matrix  # noqa: E402

# COLMAP (OpenCV) camera axes -> renderer (OpenGL) camera axes.
CV_TO_GL = np.diag([1.0, -1.0, -1.0])


def build_track(work_dir: Path, fps: float) -> dict:
    """
    Compose per-frame camera poses in mesh space.

    Args:
        work_dir: Directory holding sfm.json and alignment.json
        fps: Frame rate of the source video, used to stamp each frame's time

    Returns:
        A dict with intrinsics, per-frame poses and solve coverage
    """
    sfm = json.loads((work_dir / "sfm.json").read_text())
    ali = json.loads((work_dir / "alignment.json").read_text())

    scale = float(ali["scale"])
    Rs = np.asarray(ali["rotation"], dtype=np.float64)
    ts = np.asarray(ali["translation"], dtype=np.float64)

    posed: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for fr in sfm["frames"]:
        R = quat_xyzw_to_matrix(fr["qvec_xyzw"])      # world -> cam (CV)
        t = np.asarray(fr["tvec"], dtype=np.float64)
        centre = -R.T @ t                              # camera centre, SfM space
        basis = R.T @ CV_TO_GL                         # cam -> world, GL axes

        # Carry both into mesh space. Uniform scale leaves orientation alone.
        posed[fr["index"]] = (scale * (Rs @ centre) + ts, Rs @ basis)

    if not posed:
        raise SystemExit("[export] no posed frames in sfm.json")

    # Describe the whole clip, not just the part that solved. Ending the track
    # at the last solved frame would quietly hide any unsolved tail from the
    # viewer, which then has no way to know it is showing a frozen camera over
    # moving footage.
    extracted = len(list((work_dir / "frames").glob("*.jpg")))
    n_frames = max(extracted, max(posed) + 1)
    solved = sorted(posed)
    gaps = n_frames - len(solved)
    print(f"[export] {len(solved)}/{n_frames} frames solved by "
          f"{sfm.get('solver', 'colmap')}"
          + (f" ({gaps} unsolved)" if gaps else ""))

    # Interpolate the gaps: linear on position, slerp on rotation, clamped at
    # the ends so a clip that fails to register its first or last frames still
    # plays rather than jumping.
    keys = np.asarray(solved, dtype=np.float64)
    positions = np.stack([posed[i][0] for i in solved])
    rots = Rotation.from_matrix(np.stack([posed[i][1] for i in solved]))
    slerp = Slerp(keys, rots)

    frames = []
    for i in range(n_frames):
        if i in posed:
            pos, basis = posed[i]
            quat = Rotation.from_matrix(basis).as_quat()
            solved_flag = True
        else:
            clamped = float(np.clip(i, keys[0], keys[-1]))
            pos = np.stack([np.interp(clamped, keys, positions[:, c])
                            for c in range(3)])
            quat = slerp([clamped])[0].as_quat()
            solved_flag = False
        frames.append({
            "i": i,
            "t": round(i / fps, 6),
            "p": [round(float(v), 6) for v in pos],
            "q": [round(float(v), 6) for v in quat],  # xyzw
            "solved": solved_flag,
        })

    intr = sfm["intrinsics"]
    w, h = intr["width"], intr["height"]
    fy = intr["fy"]
    track = {
        "source": sfm["source"],
        "fps": fps,
        "frame_count": n_frames,
        "solved_count": len(solved),
        "intrinsics": {
            "width": w,
            "height": h,
            "fx": intr["fx"],
            "fy": fy,
            "cx": intr["cx"],
            "cy": intr["cy"],
            # Convenience for a plain PerspectiveCamera; exact once the frames
            # are undistorted and the principal point sits at the centre.
            "fov_y_deg": float(np.degrees(2.0 * np.arctan(h / (2.0 * fy)))),
            "aspect": w / h,
            "undistorted": True,
        },
        "alignment": {
            "scale": scale,
            "quality": ali["quality"],
        },
        "frames": frames,
    }
    return track


def undistort_video(work_dir: Path, out_mp4: Path, fps: float,
                    source_mov: Path | None) -> None:
    """
    Undistort every frame with COLMAP's solved lens model and re-encode to H.264.

    The renderer projects with a pinhole matrix, so removing the radial term
    from the footage is what makes the overlay line up at the edges of frame as
    well as the centre. The intrinsic matrix is deliberately left unchanged so
    the track's fx/fy/cx/cy stay valid for the undistorted result.

    Args:
        work_dir: Directory holding frames/ and sfm.json
        out_mp4: Destination .mp4
        fps: Frame rate to encode at
        source_mov: Original video to lift the audio track from, if any
    """
    import cv2

    sfm = json.loads((work_dir / "sfm.json").read_text())
    intr = sfm["intrinsics"]
    params = intr["params"]
    K = np.array([[intr["fx"], 0, intr["cx"]],
                  [0, intr["fy"], intr["cy"]],
                  [0, 0, 1]], dtype=np.float64)

    model = intr["model"]
    if model == "SIMPLE_RADIAL":
        dist = np.array([params["k"], 0.0, 0.0, 0.0], dtype=np.float64)
    elif model == "RADIAL":
        dist = np.array([params["k1"], params["k2"], 0.0, 0.0], dtype=np.float64)
    elif model in ("OPENCV", "FULL_OPENCV"):
        dist = np.array([params["k1"], params["k2"], params["p1"], params["p2"]],
                        dtype=np.float64)
    elif model in ("PINHOLE", "SIMPLE_PINHOLE"):
        dist = np.zeros(4)
    else:
        raise SystemExit(f"[export] unhandled camera model {model}")
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    # A pinhole solve has nothing to undo, so going back through the extracted
    # JPEGs would only throw away quality. Transcode the original instead.
    if not np.any(np.abs(dist) > 1e-9):
        if source_mov and source_mov.exists():
            print(f"[export] {model}: no distortion to remove, "
                  "transcoding the source directly")
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-i", str(source_mov),
                "-c:v", "libx264", "-preset", "slow", "-crf", "18",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(out_mp4)], check=True)
            print(f"[export] wrote {out_mp4} "
                  f"({out_mp4.stat().st_size / 1e6:.1f} MB)")
            return
        print(f"[export] {model}: no distortion to remove")

    print(f"[export] undistorting with {model} dist={dist[:2].tolist()}")

    frames = sorted((work_dir / "frames").glob("*.jpg"))
    undist_dir = work_dir / "undistorted"
    if undist_dir.exists():
        shutil.rmtree(undist_dir)
    undist_dir.mkdir()

    map1 = map2 = None
    for p in frames:
        img = cv2.imread(str(p))
        if map1 is None:
            h, w = img.shape[:2]
            map1, map2 = cv2.initUndistortRectifyMap(
                K, dist, None, K, (w, h), cv2.CV_16SC2)
        cv2.imwrite(str(undist_dir / p.name),
                    cv2.remap(img, map1, map2, cv2.INTER_LINEAR),
                    [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(f"[export] undistorted {len(frames)} frames")

    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-framerate", str(fps), "-i", str(undist_dir / "%04d.jpg")]
    if source_mov and source_mov.exists():
        cmd += ["-i", str(source_mov), "-map", "0:v:0", "-map", "1:a:0?",
                "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_mp4)]
    subprocess.run(cmd, check=True)
    print(f"[export] wrote {out_mp4} ({out_mp4.stat().st_size / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser(
        description="Export a web-ready camera track and undistorted video")
    ap.add_argument("work_dir", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--source-mov", type=Path, default=None,
                    help="original video, for its audio track")
    ap.add_argument("--no-video", action="store_true",
                    help="write the track only, skip undistort/encode")
    args = ap.parse_args()

    name = args.work_dir.name
    args.out_dir.mkdir(parents=True, exist_ok=True)

    track = build_track(args.work_dir, args.fps)
    out_json = args.out_dir / "track.json"
    out_json.write_text(json.dumps(track, separators=(",", ":")))
    print(f"[export] wrote {out_json} ({out_json.stat().st_size / 1e3:.0f} kB)")

    if not args.no_video:
        undistort_video(args.work_dir, args.out_dir / f"{name}.mp4", args.fps,
                        args.source_mov)
    print("[export] done")


if __name__ == "__main__":
    main()
