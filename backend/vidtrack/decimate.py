#!/usr/bin/env python3
"""
Produce low-poly copies of a scan for the wireframe layer.

A photogrammetry mesh runs to a few hundred thousand triangles. Drawn as
wireframe at that density every pixel is covered by an edge, so the layer reads
as a solid fill rather than as structure. Collapsing it to a few thousand faces
turns it back into something you can see through, and quadric decimation keeps
the silhouette while doing it.

Two things make the result less of a mess:

  * Specks are dropped first. A scan carries dozens of small disconnected
    shells - leaves, gravel, scraps of fence - that read as noise in wireframe
    and, worse, hold the decimator up: every shell needs a minimum number of
    faces, so a mesh full of them cannot be reduced much however low the target.
  * Several levels are written rather than one, since how dense a wireframe
    should be is a look, not a constant.

Usage:
    python decimate.py <scan.glb> <out_dir> <name> [--levels coarse=1200,...]
"""

import argparse
from pathlib import Path

import numpy as np
import trimesh

# Face budgets offered to the viewer. Names, not numbers, because the face
# count a mesh actually reaches depends on how it is connected.
DEFAULT_LEVELS = {"coarse": 1200, "medium": 5000, "fine": 18000}


def drop_specks(mesh: trimesh.Trimesh, min_fraction: float = 0.004
                ) -> trimesh.Trimesh:
    """
    Remove disconnected shells too small to be part of the subject.

    Components are found from face adjacency directly rather than through
    mesh.split(), which tries to repair each shell it extracts and pulls in a
    graph dependency to do it. Nothing here needs watertight parts.

    Args:
        mesh: the loaded scan
        min_fraction: smallest share of total faces a shell may hold and stay

    Returns:
        The mesh with specks removed (or the original if that would empty it)
    """
    groups = trimesh.graph.connected_components(
        mesh.face_adjacency, nodes=np.arange(len(mesh.faces)))
    if len(groups) <= 1:
        return mesh

    total = len(mesh.faces)
    keep = [g for g in groups if len(g) >= total * min_fraction]
    if not keep:
        return mesh

    faces = np.concatenate(keep)
    trimmed = mesh.submesh([faces], append=True, repair=False)
    print(f"[dec]   {len(groups)} shells -> kept {len(keep)} "
          f"({len(groups) - len(keep)} specks, "
          f"{total - len(trimmed.faces)} faces dropped)")
    return trimmed


def decimate(src: Path, out_dir: Path, name: str, levels: dict,
             min_shell: float = 0.004) -> dict:
    """
    Write one untextured copy of a mesh per level.

    Args:
        src: source GLB
        out_dir: directory to write into
        name: take id, used for the output filenames
        levels: {level name: target face count}
        min_shell: smallest share of faces a shell may hold and stay

    Returns:
        {level name: faces actually achieved}
    """
    mesh = trimesh.load(str(src), force="mesh")
    print(f"[dec] {src.name}: {len(mesh.faces)} faces")
    mesh = drop_specks(mesh, min_shell)

    out_dir.mkdir(parents=True, exist_ok=True)
    achieved = {}
    for level, target in sorted(levels.items(), key=lambda kv: kv[1]):
        if target >= len(mesh.faces):
            simple = mesh.copy()
        else:
            simple = mesh.simplify_quadric_decimation(face_count=target)
        # The wireframe draws in a flat colour, so the texture is dead weight.
        simple.visual = trimesh.visual.ColorVisuals(mesh=simple)

        dst = out_dir / f"{name}_wire_{level}.glb"
        simple.export(str(dst))
        achieved[level] = len(simple.faces)
        print(f"[dec]   {level}: target {target} -> {len(simple.faces)} faces, "
              f"{dst.stat().st_size / 1e3:.0f} kB")
    return achieved


def main():
    ap = argparse.ArgumentParser(description="Decimate a scan for wireframe use")
    ap.add_argument("src", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("name", type=str)
    ap.add_argument("--levels", type=str, default=None,
                    help="comma-separated name=faces, e.g. coarse=1200,fine=20000")
    ap.add_argument("--min-shell", type=float, default=0.004,
                    help="smallest share of faces a disconnected shell may hold")
    args = ap.parse_args()

    levels = DEFAULT_LEVELS
    if args.levels:
        levels = {}
        for part in args.levels.split(","):
            k, _, v = part.partition("=")
            levels[k.strip()] = int(v)

    decimate(args.src, args.out_dir, args.name, levels, args.min_shell)


if __name__ == "__main__":
    main()
