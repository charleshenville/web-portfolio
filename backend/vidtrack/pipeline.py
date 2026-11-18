#!/usr/bin/env python3
"""
End-to-end: a scan video plus its GLB in, a tracked take for the web tool out.

Stages, each skippable so a failed or unsatisfying run can be resumed rather
than restarted:

    frames  ffmpeg splits the video into JPEGs
    cloud   glb_to_ply samples a coloured point cloud off the mesh
    solve   the camera is located against the scan, frame by frame
    refine  optical flow pulls each pose into line across the whole object
    export  track.json plus an undistorted H.264 copy of the footage
    verify  the solve is drawn back over the footage
    publish GLB, PLY and manifest entry land in public/mv/
    roto    object mattes from roto/<take>.json (made in the compositor's
            Roto mode), re-running SAM 2 where its masks are missing

Usage:
    python pipeline.py --video ~/Downloads/thing.MOV --glb ~/Downloads/thing.glb
    python pipeline.py --name thing --only refine,export
    python pipeline.py --name thing --only roto [--repropagate]
"""

import argparse
import filecmp
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
WORK = HERE / "work"
ASSETS = HERE / "assets"
PUBLIC = HERE.parent.parent / "public" / "mv"
PY = HERE.parent / "venv" / "bin" / "python"
GLB_TO_PLY = HERE.parent / "glb_to_ply" / "glb_to_ply.py"

STAGES = ["frames", "cloud", "solve", "refine", "export", "verify", "publish", "roto"]


def run(cmd: list, label: str) -> None:
    """Run a subprocess, echoing the command, and stop the pipeline if it fails."""
    print(f"\n=== {label} ===")
    print("  $ " + " ".join(str(c) for c in cmd))
    # Line-buffer child stdout so long stages (solve) show up in nohup logs.
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    subprocess.run([str(c) for c in cmd], check=True, env=env)


def probe_fps(video: Path) -> float:
    """Read the average frame rate out of a video's first video stream.

    Prefer avg_frame_rate (accounts for VFR) and fall back to r_frame_rate.
    ffprobe's csv muxer appends a trailing comma when a stream carries side
    data — common on 59.94 fps phone HEVC — which used to crash float().
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate,r_frame_rate",
         "-of", "default=nokey=1:noprint_wrappers=1", str(video)],
        check=True, capture_output=True, text=True).stdout
    for line in out.splitlines():
        token = line.strip().rstrip(",")
        if not token or token in ("0/0", "N/A"):
            continue
        num, _, den = token.partition("/")
        try:
            fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            continue
        if fps > 0:
            return fps
    return 30.0


def stage_frames(name: str, video: Path) -> None:
    """Split the video into numbered JPEGs for COLMAP to consume."""
    frames = WORK / name / "frames"
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)
    run(["ffmpeg", "-v", "error", "-i", video, "-q:v", "2",
         "-start_number", "0", frames / "%04d.jpg", "-y"], f"frames: {name}")
    print(f"  {len(list(frames.glob('*.jpg')))} frames")


# Points per square metre of scan surface when --points is not given, and
# the bounds on the count. A fixed count left big scans sparse: 300k points on
# the 211 m^2 Myhal atrium is one every 2.7 cm. The compositor samples more
# from the mesh itself when asked for a density above 1, so this only sets
# what is committed.
POINTS_PER_M2 = 2500
POINTS_MIN, POINTS_MAX = 300_000, 1_000_000


def stage_cloud(name: str, glb: Path, points: int | None,
                per_m2: float = POINTS_PER_M2) -> None:
    """Sample a point cloud off the GLB, and a low-poly copy for wireframes."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    local_glb = ASSETS / f"{name}.glb"
    if glb.resolve() != local_glb.resolve():
        shutil.copy(glb, local_glb)
    count = (["-n", points] if points else
             ["--per-m2", per_m2, "--min-points", POINTS_MIN, "--max-points", POINTS_MAX])
    run([PY, GLB_TO_PLY, local_glb, ASSETS / f"{name}.ply", *count, "--seed", 1],
        f"cloud: {name}")
    run([PY, HERE / "decimate.py", local_glb, ASSETS, name],
        f"wireframe: {name}")


def stage_solve(name: str, glb: Path, views: int, focal: float | None,
                keyframe: int | None, interior: bool = False) -> None:
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
    if interior:
        cmd += ["--interior"]
    run(cmd, f"solve: {name}")


def stage_refine(name: str, glb: Path, fit_focal: bool) -> None:
    """
    Pull the solve into line across the whole object by optical flow.

    The solve steers by SIFT, which only finds the scan's most distinctive
    patches; see refine.py.
    """
    cmd = [PY, HERE / "refine.py", WORK / name, "--glb", glb]
    if not fit_focal:
        cmd += ["--no-focal-fit"]
    run(cmd, f"refine: {name}")


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


def place_public(src: Path, dst: Path) -> bool:
    """
    Put a file under public/ without reloading an open compositor.

    The dev server reloads every page when a file there *changes*, which
    throws the session away, but takes no notice of files added or deleted.
    So a file that is already there is deleted, and the new one moved in a
    moment later (whole, from work/), which reads as a delete and an add.
    An unchanged file is left alone. Returns whether anything was written.
    """
    if dst.exists() and filecmp.cmp(src, dst, shallow=False):
        return False
    staged = WORK / "_publish" / dst.relative_to(PUBLIC)
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, staged)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
        time.sleep(0.3)  # past the watcher's window for folding the pair into a change
    os.replace(staged, dst)
    return True


def stage_publish(name: str, label: str) -> None:
    """Copy the mesh and cloud next to the track and register the take."""
    out = PUBLIC / name
    out.mkdir(parents=True, exist_ok=True)
    names = [f"{name}.glb", f"{name}.ply"]
    names += [p.name for p in sorted(ASSETS.glob(f"{name}_wire_*.glb"))]
    for fname in names:
        src = ASSETS / fname
        if src.exists():
            wrote = place_public(src, out / fname)
            print(f"  {out / fname}{'' if wrote else ' (unchanged)'}")

    manifest_path = PUBLIC / "manifest.json"
    manifest = []
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    entry = {"id": name, "label": label}
    if entry in manifest:
        print(f"  '{name}' already registered in {manifest_path}")
        return
    # Kept in place if the take is already listed, appended if it is new.
    if any(m.get("id") == name for m in manifest):
        manifest = [entry if m.get("id") == name else m for m in manifest]
    else:
        manifest.append(entry)
    staged = WORK / "_publish" / "manifest.json.new"
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(json.dumps(manifest, indent=4) + "\n")
    place_public(staged, manifest_path)
    staged.unlink(missing_ok=True)
    print(f"  registered '{name}' in {manifest_path}")


def stage_roto(name: str, repropagate: bool, model: str) -> None:
    """Write the take's object mattes from its roto session, if it has one."""
    if not (HERE / "roto" / f"{name}.json").exists():
        print(f"\n=== roto: {name} ===\n  no roto/{name}.json; skipped")
        return
    cmd = [PY, HERE / "roto.py", name, "--model", model]
    if repropagate:
        cmd += ["--repropagate"]
    run(cmd, f"roto: {name}")


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
    ap.add_argument("--interior", action="store_true",
                    help="filmed from inside the scan, e.g. a room")
    ap.add_argument("--points", type=int, default=None,
                    help="points sampled for the cloud layer; by default "
                         f"{POINTS_PER_M2} per m^2 of surface, {POINTS_MIN}-{POINTS_MAX}")
    ap.add_argument("--points-per-m2", type=float, default=POINTS_PER_M2,
                    help="points per m^2 of surface when --points is not given")
    ap.add_argument("--repropagate", action="store_true",
                    help="roto: re-run SAM 2 from the saved clicks, not the stored masks")
    ap.add_argument("--roto-model", default="base_plus",
                    choices=["tiny", "small", "base_plus", "large"],
                    help="roto: which SAM 2 checkpoint")
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
        stage_cloud(name, glb, args.points, args.points_per_m2)
    if "solve" in todo:
        stage_solve(name, ASSETS / f"{name}.glb", args.views, args.focal,
                    args.keyframe, args.interior)
    if "refine" in todo:
        # A focal given on the command line is known, not estimated.
        stage_refine(name, ASSETS / f"{name}.glb", args.focal is None)
    if "export" in todo:
        stage_export(name, fps, args.video)
    if "verify" in todo:
        stage_verify(name, ASSETS / f"{name}.glb")
    if "publish" in todo:
        stage_publish(name, label)
    if "roto" in todo:
        stage_roto(name, args.repropagate, args.roto_model)

    print(f"\ndone: /vfx/scan-compositor -> {label}")


if __name__ == "__main__":
    main()
