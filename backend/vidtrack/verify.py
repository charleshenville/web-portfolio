#!/usr/bin/env python3
"""
Render the solved track back over the footage, so the fit can be judged by eye.

Inlier counts say the solver found a self-consistent answer; they do not say it
found the right one. The honest check is to draw the scan through each solved
camera and see whether it lands on the object, so this writes a side-by-side
contact sheet and, optionally, a full overlay video.

Usage:
    python verify.py <work_dir> --glb <scan.glb> [--video] [--frames 0,60,120]
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from localize import gl_view_from_pose  # noqa: E402
from render import ScanRenderer, perspective  # noqa: E402
from localize import load_scan  # noqa: E402


def overlay(frame: np.ndarray, rgb: np.ndarray, mask: np.ndarray,
            mode: str = "blend") -> np.ndarray:
    """
    Composite a render onto a frame.

    Args:
        mode: "blend" tints the scan over the footage, "edge" draws only its
            silhouette and creases, which shows misalignment far more plainly
    """
    out = frame.copy()
    if mode == "edge":
        edges = cv2.Canny(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), 40, 110)
        edges = cv2.dilate(edges, np.ones((2, 2), np.uint8))
        sil = cv2.Canny((mask * 255).astype(np.uint8), 40, 110)
        sil = cv2.dilate(sil, np.ones((3, 3), np.uint8))
        out[edges > 0] = (0, 255, 255)
        out[sil > 0] = (0, 0, 255)
        return out
    m = mask[:, :, None].astype(np.float32) * 0.65
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR).astype(np.float32)
    return (out.astype(np.float32) * (1 - m) + bgr * m).astype(np.uint8)


def render_track(work_dir: Path, glb: Path, indices, mode: str):
    """
    Draw the scan through the solved camera for the requested frames.

    Returns:
        list of (index, composited BGR image)
    """
    sfm = json.loads((work_dir / "sfm.json").read_text())
    intr = sfm["intrinsics"]
    width, height = intr["width"], intr["height"]
    poses = {f["index"]: f for f in sfm["frames"]}

    verts, faces, uv, tex = load_scan(glb)
    renderer = ScanRenderer(verts, faces, uv, tex, width, height)
    proj = perspective(intr["fy"], width, height)

    out = []
    try:
        for i in indices:
            if i not in poses:
                print(f"[verify] frame {i} has no pose, skipping")
                continue
            p = poses[i]
            from scipy.spatial.transform import Rotation
            R = Rotation.from_quat(p["qvec_xyzw"]).as_matrix()
            rvec, _ = cv2.Rodrigues(R)
            tvec = np.asarray(p["tvec"], dtype=np.float64)

            rgb, _, mask = renderer.render(gl_view_from_pose(rvec, tvec), proj)
            frame = cv2.imread(str(work_dir / "frames" / f"{i:04d}.jpg"))
            out.append((i, overlay(frame, rgb, mask, mode)))
    finally:
        renderer.release()
    return out


def main():
    ap = argparse.ArgumentParser(
        description="Draw a solved track back over its footage")
    ap.add_argument("work_dir", type=Path)
    ap.add_argument("--glb", type=Path, required=True)
    ap.add_argument("--frames", type=str, default=None,
                    help="comma-separated frame indices for the contact sheet")
    ap.add_argument("--mode", choices=["blend", "edge"], default="blend")
    ap.add_argument("--video", action="store_true",
                    help="also write an overlay mp4 of the whole take")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    sfm = json.loads((args.work_dir / "sfm.json").read_text())
    n = max(f["index"] for f in sfm["frames"]) + 1

    if args.frames:
        idx = [int(x) for x in args.frames.split(",")]
    else:
        idx = [int(v) for v in np.linspace(0, n - 1, 4)]

    shots = render_track(args.work_dir, args.glb, idx, args.mode)
    if shots:
        tiles = [cv2.resize(img, (640, 480)) for _, img in shots]
        rows = [np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles), 2)]
        width = max(r.shape[1] for r in rows)
        rows = [r if r.shape[1] == width else
                np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0)))
                for r in rows]
        sheet = np.vstack(rows)
        out = args.out or (args.work_dir / f"verify_{args.mode}.jpg")
        cv2.imwrite(str(out), sheet)
        print(f"[verify] wrote {out} (frames {idx})")

    if args.video:
        vid_dir = args.work_dir / "verify_frames"
        vid_dir.mkdir(exist_ok=True)
        for i, img in render_track(args.work_dir, args.glb, range(n), args.mode):
            cv2.imwrite(str(vid_dir / f"{i:04d}.jpg"), img,
                        [cv2.IMWRITE_JPEG_QUALITY, 92])
        mp4 = args.work_dir / f"verify_{args.mode}.mp4"
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-framerate", "30",
            "-i", str(vid_dir / "%04d.jpg"), "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            str(mp4)], check=True)
        print(f"[verify] wrote {mp4}")


if __name__ == "__main__":
    main()
