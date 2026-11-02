#!/usr/bin/env python3
"""
Produce a low-poly copy of a scan for the wireframe layer.

A photogrammetry mesh runs to a few hundred thousand triangles. Drawn as
wireframe at that density every pixel is covered by an edge, so the layer reads
as a solid fill rather than as structure. Collapsing it to a few thousand faces
is what turns it back into something you can see through - and the silhouette
barely moves, since quadric decimation preserves it.

Usage:
    python decimate.py <scan.glb> <out.glb> [--faces 6000]
"""

import argparse
from pathlib import Path

import trimesh


def decimate(src: Path, dst: Path, faces: int = 6000) -> int:
    """
    Write a decimated, untextured copy of a mesh.

    Args:
        src: source GLB
        dst: destination GLB
        faces: target triangle count; disconnected shells can hold the result
            above this, which is fine

    Returns:
        The face count actually achieved
    """
    mesh = trimesh.load(str(src), force="mesh")
    print(f"[dec] {src.name}: {len(mesh.faces)} faces")

    simple = mesh.simplify_quadric_decimation(face_count=faces)
    # The wireframe is drawn in a flat colour, so the texture is dead weight.
    simple.visual = trimesh.visual.ColorVisuals(mesh=simple)

    dst.parent.mkdir(parents=True, exist_ok=True)
    simple.export(str(dst))
    print(f"[dec] -> {dst.name}: {len(simple.faces)} faces, "
          f"{dst.stat().st_size / 1e3:.0f} kB")
    return len(simple.faces)


def main():
    ap = argparse.ArgumentParser(description="Decimate a scan for wireframe use")
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--faces", type=int, default=6000)
    args = ap.parse_args()
    decimate(args.src, args.dst, args.faces)


if __name__ == "__main__":
    main()
