#!/usr/bin/env python3
"""
End-to-end: a scan video plus its GLB in, a tracked take for the web tool out.

Stages, each skippable so a failed or unsatisfying run can be resumed rather
than restarted:

    frames  ffmpeg splits the video into JPEGs
    cloud   glb_to_ply samples a coloured point cloud off the mesh
    sfm     COLMAP solves intrinsics and a camera pose per frame
    align   the solve is registered into the GLB's coordinate frame
    export  track.json plus an undistorted H.264 copy of the footage
    publish GLB, PLY and manifest entry land in public/mv/

Usage:
    python pipeline.py --video ~/Downloads/thing.MOV --glb ~/Downloads/thing.glb
    python pipeline.py --name thing --only align,export
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
WORK = HERE / "work"
ASSETS = HERE / "assets"
PUBLIC = HERE.parent.parent / "public" / "mv"
PY = HERE.parent / "venv" / "bin" / "python"
GLB_TO_PLY = HERE.parent / "glb_to_ply" / "glb_to_ply.py"

STAGES = ["frames", "cloud", "solve", "export", "verify", "publish"]


def run(cmd: list, label: str) -> None:
    """Run a subprocess, echoing the command, and stop the pipeline if it fails."""
    print(f"\n=== {label} ===")
    print("  $ " + " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True)


def probe_fps(video: Path) -> float:
    """Read the average frame rate out of a video's first video stream."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(video)],
        check=True, capture_output=True, text=True).stdout.strip()
    num, _, den = out.partition("/")
    return float(num) / float(den or 1)


def stage_frames(name: str, video: Path) -> None:
    """Split the video into numbered JPEGs for COLMAP to consume."""
    frames = WORK / name / "frames"
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)
    run(["ffmpeg", "-v", "error", "-i", video, "-q:v", "2",
         "-start_number", "0", frames / "%04d.jpg", "-y"], f"frames: {name}")
    print(f"  {len(list(frames.glob('*.jpg')))} frames")


def stage_cloud(name: str, glb: Path, points: int) -> None:
    """Sample a point cloud off the GLB, and a low-poly copy for wireframes."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    local_glb = ASSETS / f"{name}.glb"
    if glb.resolve() != local_glb.resolve():
        shutil.copy(glb, local_glb)
    run([PY, GLB_TO_PLY, local_glb, ASSETS / f"{name}.ply",
         "-n", points, "--seed", 1], f"cloud: {name}")
    run([PY, HERE / "decimate.py", local_glb, ASSETS, name],
        f"wireframe: {name}")


def stage_solve(name: str, glb: Path, views: int, focal: float | None,
                keyframe: int | None) -> None:
    """
    Solve intrinsics and a pose per frame against the scan itself.

    Model localisation rather than SfM, because these clips barely move and
    there is no parallax to reconstruct from. See localize.py.
    """
    cmd = [PY, HERE / "localize.py", WORK / name, "--glb", glb,
           "--views", views]
    if focal is not None:
        cmd += ["--focal", focal]
    if keyframe is not None:
        cmd += ["--keyframe", keyframe]
    run(cmd, f"solve: {name}")


def stage_verify(name: str, glb: Path) -> None:
    """Draw the solved track back over the footage so the fit can be judged."""
    for mode in ("blend", "edge"):
        run([PY, HERE / "verify.py", WORK / name, "--glb", glb, "--mode", mode],
            f"verify ({mode}): {name}")


def stage_export(name: str, fps: float, source: Path | None) -> None:
    """Write track.json and the undistorted H.264 footage into public/mv/."""
    cmd = [PY, HERE / "export_track.py", WORK / name,
           "--out-dir", PUBLIC / name, "--fps", fps]
    if source:
        cmd += ["--source-mov", source]
    run(cmd, f"export: {name}")


def stage_publish(name: str, label: str) -> None:
    """Copy the mesh and cloud next to the track and register the take."""
    out = PUBLIC / name
    out.mkdir(parents=True, exist_ok=True)
    names = [f"{name}.glb", f"{name}.ply"]
    names += [p.name for p in sorted(ASSETS.glob(f"{name}_wire_*.glb"))]
    for fname in names:
        src = ASSETS / fname
        if src.exists():
            shutil.copy(src, out / fname)
            print(f"  {out / fname}")

    manifest_path = PUBLIC / "manifest.json"
    manifest = []
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    entry = {"id": name, "label": label}
    manifest = [m for m in manifest if m.get("id") != name] + [entry]
    manifest_path.write_text(json.dumps(manifest, indent=4) + "\n")
    print(f"  registered '{name}' in {manifest_path}")


def main():
    ap = argparse.ArgumentParser(
        description="Solve a scan video's camera track and publish it to the web tool")
    ap.add_argument("--video", type=Path, help="source .MOV/.mp4")
    ap.add_argument("--glb", type=Path, help="the scan mesh")
    ap.add_argument("--name", type=str, default=None,
                    help="take id; defaults to the video's stem")
    ap.add_argument("--label", type=str, default=None,
                    help="display name in the tool's take list")
    ap.add_argument("--views", type=int, default=260,
                    help="viewpoints searched when locating the camera")
    ap.add_argument("--focal", type=float, default=None,
                    help="skip the focal sweep and use this value, in pixels")
    ap.add_argument("--keyframe", type=int, default=None,
                    help="frame to locate first; defaults to the middle")
    ap.add_argument("--points", type=int, default=300_000,
                    help="points sampled for the cloud layer")
    ap.add_argument("--only", type=str, default=None,
                    help=f"comma-separated subset of: {','.join(STAGES)}")
    args = ap.parse_args()

    name = args.name or (args.video.stem if args.video else None)
    if not name:
        raise SystemExit("need --name or --video")
    label = args.label or name.replace("_", " ").replace("-", " ").title()

    todo = STAGES if not args.only else [s.strip() for s in args.only.split(",")]
    bad = [s for s in todo if s not in STAGES]
    if bad:
        raise SystemExit(f"unknown stage(s): {bad}; choose from {STAGES}")

    (WORK / name).mkdir(parents=True, exist_ok=True)
    fps = probe_fps(args.video) if args.video else 30.0
    print(f"take '{name}' ({label}), fps={fps:g}, stages={todo}")

    if "frames" in todo:
        if not args.video:
            raise SystemExit("--video is required for the frames stage")
        stage_frames(name, args.video)
    glb = args.glb or (ASSETS / f"{name}.glb")
    if {"cloud", "solve", "verify"} & set(todo) and not glb.exists():
        raise SystemExit(f"no GLB at {glb}; pass --glb")
    if "cloud" in todo:
        stage_cloud(name, glb, args.points)
    if "solve" in todo:
        stage_solve(name, ASSETS / f"{name}.glb", args.views, args.focal,
                    args.keyframe)
    if "export" in todo:
        stage_export(name, fps, args.video)
    if "verify" in todo:
        stage_verify(name, ASSETS / f"{name}.glb")
    if "publish" in todo:
        stage_publish(name, label)

    print(f"\ndone: /vfx/scan-compositor -> {label}")


if __name__ == "__main__":
    main()
