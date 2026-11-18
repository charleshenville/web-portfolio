#!/usr/bin/env python3
"""
Produce low-poly copies of a scan for the wireframe layer.

A photogrammetry mesh runs to a few hundred thousand triangles. Drawn as
wireframe at that density every pixel is covered by an edge, so the layer reads
as a solid fill rather than as structure. Collapsing it to a few thousand faces
turns it back into something you can see through, and quadric decimation keeps
the silhouette while doing it.

Three things make the result less of a mess:

  * Every mesh in the GLB is used. A scan whose texture overflows one page
    arrives as several meshes, one per page, which together make the whole.
  * The mesh is welded by position first. A textured scan splits its vertices
    wherever the texture atlas has a seam, so unwelded it falls apart into
    hundreds of loose charts: the decimator tears each one away from its
    neighbours, and a shell-size filter mistakes them for junk. On Myhal that
    once threw away 1184 "specks" - 145k faces, 45% of the scan - which were
    really pieces of the walls. Welded, nearly every scan is a handful of
    shells and nothing small is left to filter.
  * Several levels are written rather than one, since how dense a wireframe
    should be is a look, not a constant.

Small disconnected shells are kept unless --min-shell asks otherwise.

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


def load_welded(src: Path) -> trimesh.Trimesh:
    """
    Every mesh in a GLB, with its scene transform, as one mesh welded by
    position (texture coordinates and normals ignored).

    Args:
        src: the scan GLB

    Returns:
        An untextured mesh whose shells are the surface's real pieces
    """
    scene = trimesh.load(str(src), force="scene")
    verts, faces, offset = [], [], 0
    for node in scene.graph.nodes_geometry:
        transform, gname = scene.graph[node]
        g = scene.geometry.get(gname)
        if not isinstance(g, trimesh.Trimesh) or not len(g.faces):
            continue
        verts.append(trimesh.transform_points(np.asarray(g.vertices), transform))
        faces.append(np.asarray(g.faces, dtype=np.int64) + offset)
        offset += len(g.vertices)
    if not faces:
        raise SystemExit(f"{src}: no meshes")
    mesh = trimesh.Trimesh(np.vstack(verts), np.vstack(faces), process=False)
    raw = len(mesh.vertices)
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    print(f"[dec] {src.name}: {len(faces)} mesh(es), {len(mesh.faces)} faces, "
          f"{raw} -> {len(mesh.vertices)} vertices welded")
    return mesh


def drop_specks(mesh: trimesh.Trimesh, min_fraction: float = 0.0
                ) -> trimesh.Trimesh:
    """
    Remove disconnected shells smaller than a share of the faces.

    Components are found from face adjacency directly rather than through
    mesh.split(), which tries to repair each shell it extracts and pulls in a
    graph dependency to do it. Nothing here needs watertight parts. The mesh
    must be welded (load_welded) or every texture chart counts as a shell.

    Args:
        mesh: the welded scan
        min_fraction: smallest share of total faces a shell may hold and
            stay; 0 keeps everything

    Returns:
        The mesh with specks removed (or the original if that would empty it)
    """
    groups = trimesh.graph.connected_components(
        mesh.face_adjacency, nodes=np.arange(len(mesh.faces)))
    total = len(mesh.faces)
    sizes = sorted((len(g) for g in groups), reverse=True)
    print(f"[dec]   {len(groups)} shell(s), largest {sizes[:6]}")
    if len(groups) <= 1 or min_fraction <= 0:
        return mesh

    keep = [g for g in groups if len(g) >= total * min_fraction]
    if not keep or len(keep) == len(groups):
        return mesh

    faces = np.concatenate(keep)
    trimmed = mesh.submesh([faces], append=True, repair=False)
    print(f"[dec]   kept {len(keep)} ({len(groups) - len(keep)} specks, "
          f"{total - len(trimmed.faces)} faces dropped)")
    return trimmed


def decimate(src: Path, out_dir: Path, name: str, levels: dict,
             min_shell: float = 0.0) -> dict:
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
    mesh = drop_specks(load_welded(src), min_shell)

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
    ap.add_argument("--min-shell", type=float, default=0.0,
                    help="smallest share of faces a disconnected shell may hold "
                         "(default 0: keep every shell)")
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
