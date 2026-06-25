#!/usr/bin/env python3
"""
GLB to PLY Point Cloud Converter with Texture Sampling

Converts GLB files (with embedded textures) to PLY point cloud files by sampling
the texture color at each vertex's UV coordinates.

Usage:
    python glb_to_ply.py                     # Convert all GLBs in ./glbs/ to ./plys/
    python glb_to_ply.py <input.glb>         # Convert single file to ./plys/
    python glb_to_ply.py <input.glb> <out.ply>  # Convert to specific output path
    python glb_to_ply.py <input.glb> -n 100000  # Uniformly sample 100k surface points

By default, processes all .glb files in ./glbs/ and outputs point cloud PLY files
to ./plys/ folder, using one point per mesh vertex.

Use --sample-points/-n to instead randomly and uniformly sample a target number of
points across the textured mesh faces (area-weighted), with colors interpolated
from the texture via barycentric UV coordinates.

Requirements:
    pip install trimesh pillow numpy pygltflib
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

try:
    import trimesh
except ImportError:
    print("Error: trimesh is required. Install with: pip install trimesh")
    sys.exit(1)


def load_glb(glb_path: str) -> trimesh.Trimesh:
    """
    Load a GLB file and return the mesh.
    
    Args:
        glb_path: Path to the GLB file
        
    Returns:
        trimesh.Trimesh object
    """
    scene = trimesh.load(glb_path, force='scene')
    
    # If it's a scene with multiple meshes, combine them
    if isinstance(scene, trimesh.Scene):
        meshes = []
        for name, geometry in scene.geometry.items():
            if isinstance(geometry, trimesh.Trimesh):
                meshes.append(geometry)
        
        if len(meshes) == 0:
            raise ValueError(f"No valid meshes found in {glb_path}")
        elif len(meshes) == 1:
            return meshes[0]
        else:
            # Concatenate all meshes
            return trimesh.util.concatenate(meshes)
    elif isinstance(scene, trimesh.Trimesh):
        return scene
    else:
        raise ValueError(f"Unexpected type loaded from GLB: {type(scene)}")


def load_glb_geometries(glb_path: str) -> list[trimesh.Trimesh]:
    """
    Load a GLB file and return its individual mesh geometries with scene
    transforms baked in, without concatenating them.

    Keeping geometries separate preserves each mesh's own texture, UVs and
    material, which is essential for correctly coloring sampled points in
    multi-mesh scenes.

    Args:
        glb_path: Path to the GLB file

    Returns:
        List of trimesh.Trimesh geometries
    """
    scene = trimesh.load(glb_path, force='scene')

    if isinstance(scene, trimesh.Trimesh):
        return [scene]

    if not isinstance(scene, trimesh.Scene):
        raise ValueError(f"Unexpected type loaded from GLB: {type(scene)}")

    geometries: list[trimesh.Trimesh] = []
    # Walk the scene graph so per-node transforms are applied to each instance.
    for node_name in scene.graph.nodes_geometry:
        transform, geometry_name = scene.graph[node_name]
        geometry = scene.geometry.get(geometry_name)
        if not isinstance(geometry, trimesh.Trimesh):
            continue
        geometry = geometry.copy()
        geometry.apply_transform(transform)
        geometries.append(geometry)

    if not geometries:
        raise ValueError(f"No valid meshes found in {glb_path}")

    return geometries


def extract_texture_from_glb(glb_path: str) -> Image.Image | None:
    """
    Extract the texture image from a GLB file.
    
    Args:
        glb_path: Path to the GLB file
        
    Returns:
        PIL Image of the texture, or None if no texture found
    """
    scene = trimesh.load(glb_path, force='scene')
    
    # Try to find texture in materials
    if isinstance(scene, trimesh.Scene):
        for name, geometry in scene.geometry.items():
            if isinstance(geometry, trimesh.Trimesh):
                if hasattr(geometry, 'visual') and hasattr(geometry.visual, 'material'):
                    material = geometry.visual.material
                    
                    # Check for PBR material with base color texture
                    if hasattr(material, 'baseColorTexture') and material.baseColorTexture is not None:
                        return material.baseColorTexture
                    
                    # Check for simple texture material
                    if hasattr(material, 'image') and material.image is not None:
                        return material.image
                    
                # Check for TextureVisuals
                if hasattr(geometry, 'visual') and hasattr(geometry.visual, 'image'):
                    if geometry.visual.image is not None:
                        return geometry.visual.image
    
    elif isinstance(scene, trimesh.Trimesh):
        if hasattr(scene, 'visual') and hasattr(scene.visual, 'material'):
            material = scene.visual.material
            if hasattr(material, 'baseColorTexture') and material.baseColorTexture is not None:
                return material.baseColorTexture
            if hasattr(material, 'image') and material.image is not None:
                return material.image
        
        if hasattr(scene, 'visual') and hasattr(scene.visual, 'image'):
            if scene.visual.image is not None:
                return scene.visual.image
    
    return None


def get_uv_coordinates(glb_path: str) -> np.ndarray | None:
    """
    Extract UV coordinates from the GLB file.
    
    Args:
        glb_path: Path to the GLB file
        
    Returns:
        numpy array of UV coordinates (N, 2) or None if not found
    """
    scene = trimesh.load(glb_path, force='scene')
    
    if isinstance(scene, trimesh.Scene):
        for name, geometry in scene.geometry.items():
            if isinstance(geometry, trimesh.Trimesh):
                if hasattr(geometry, 'visual') and hasattr(geometry.visual, 'uv'):
                    uv = geometry.visual.uv
                    if uv is not None and len(uv) > 0:
                        return uv
    elif isinstance(scene, trimesh.Trimesh):
        if hasattr(scene, 'visual') and hasattr(scene.visual, 'uv'):
            uv = scene.visual.uv
            if uv is not None and len(uv) > 0:
                return uv
    
    return None


def sample_texture_at_uvs(texture: Image.Image, uvs: np.ndarray) -> np.ndarray:
    """
    Sample the texture image at the given UV coordinates.
    
    Args:
        texture: PIL Image of the texture
        uvs: numpy array of UV coordinates (N, 2) in range [0, 1]
        
    Returns:
        numpy array of RGB colors (N, 3) in range [0, 255]
    """
    # Convert to RGB if necessary
    if texture.mode != 'RGB':
        texture = texture.convert('RGB')
    
    width, height = texture.size
    texture_array = np.array(texture)
    
    # Clamp UVs to [0, 1] range and handle wrapping
    uvs = uvs.copy()
    uvs = np.mod(uvs, 1.0)  # Wrap UVs
    
    # Convert UV to pixel coordinates
    # Note: UV origin is typically bottom-left, image origin is top-left
    # U maps to X (width), V maps to Y (height) but inverted
    pixel_x = (uvs[:, 0] * (width - 1)).astype(np.int32)
    pixel_y = ((1.0 - uvs[:, 1]) * (height - 1)).astype(np.int32)
    
    # Clamp to valid range
    pixel_x = np.clip(pixel_x, 0, width - 1)
    pixel_y = np.clip(pixel_y, 0, height - 1)
    
    # Sample colors
    colors = texture_array[pixel_y, pixel_x]
    
    return colors


def compute_vertex_colors_from_faces(mesh: trimesh.Trimesh, uvs: np.ndarray, 
                                      texture: Image.Image) -> np.ndarray:
    """
    Compute vertex colors by sampling texture at UV coordinates.
    
    Handles the case where UVs are per-face-vertex (3 * num_faces)
    and need to be averaged for shared vertices.
    
    Args:
        mesh: The trimesh object
        uvs: UV coordinates array
        texture: The texture image
        
    Returns:
        numpy array of vertex colors (num_vertices, 3)
    """
    num_vertices = len(mesh.vertices)
    num_faces = len(mesh.faces)
    
    # Sample colors at all UV coordinates
    face_vertex_colors = sample_texture_at_uvs(texture, uvs)
    
    # If UVs match vertices directly
    if len(uvs) == num_vertices:
        return face_vertex_colors
    
    # If UVs are per-face-vertex, average colors for shared vertices
    if len(uvs) == num_faces * 3:
        vertex_colors_sum = np.zeros((num_vertices, 3), dtype=np.float64)
        vertex_counts = np.zeros(num_vertices, dtype=np.int32)
        
        face_vertex_colors_reshaped = face_vertex_colors.reshape(num_faces, 3, 3)
        
        for face_idx, face in enumerate(mesh.faces):
            for local_idx, vertex_idx in enumerate(face):
                vertex_colors_sum[vertex_idx] += face_vertex_colors_reshaped[face_idx, local_idx]
                vertex_counts[vertex_idx] += 1
        
        # Avoid division by zero
        vertex_counts = np.maximum(vertex_counts, 1)
        vertex_colors = (vertex_colors_sum / vertex_counts[:, np.newaxis]).astype(np.uint8)
        
        return vertex_colors
    
    # Fallback: try to map UVs to vertices directly
    # This handles some edge cases where UV count doesn't match expected
    print(f"Warning: UV count ({len(uvs)}) doesn't match vertices ({num_vertices}) "
          f"or face-vertices ({num_faces * 3}). Attempting direct mapping.")
    
    if len(uvs) >= num_vertices:
        return sample_texture_at_uvs(texture, uvs[:num_vertices])
    else:
        # Pad with the last color
        colors = sample_texture_at_uvs(texture, uvs)
        padded = np.zeros((num_vertices, 3), dtype=np.uint8)
        padded[:len(colors)] = colors
        padded[len(colors):] = colors[-1] if len(colors) > 0 else [128, 128, 128]
        return padded


def resolve_face_uvs(mesh: trimesh.Trimesh, uvs: np.ndarray | None) -> np.ndarray | None:
    """
    Resolve UV coordinates into a per-face-corner array of shape (num_faces, 3, 2).

    Handles both per-vertex UVs (len == num_vertices) and per-face-vertex UVs
    (len == num_faces * 3).

    Args:
        mesh: The trimesh object
        uvs: UV coordinates array, or None

    Returns:
        numpy array of shape (num_faces, 3, 2), or None if UVs can't be resolved
    """
    if uvs is None:
        return None

    num_vertices = len(mesh.vertices)
    num_faces = len(mesh.faces)

    if len(uvs) == num_vertices:
        return uvs[mesh.faces]

    if len(uvs) == num_faces * 3:
        return uvs.reshape(num_faces, 3, 2)

    print(f"Warning: UV count ({len(uvs)}) doesn't match vertices ({num_vertices}) "
          f"or face-vertices ({num_faces * 3}). Skipping UV interpolation for sampling.")
    return None


def get_geometry_texture(geometry: trimesh.Trimesh) -> Image.Image | None:
    """Extract the base color texture image from a single geometry, if any."""
    visual = getattr(geometry, 'visual', None)
    if visual is None:
        return None

    material = getattr(visual, 'material', None)
    if material is not None:
        base = getattr(material, 'baseColorTexture', None)
        if base is not None:
            return base
        image = getattr(material, 'image', None)
        if image is not None:
            return image

    image = getattr(visual, 'image', None)
    if image is not None:
        return image

    return None


def get_geometry_uv(geometry: trimesh.Trimesh) -> np.ndarray | None:
    """Extract per-vertex UV coordinates from a single geometry, if any."""
    visual = getattr(geometry, 'visual', None)
    if visual is None:
        return None
    uv = getattr(visual, 'uv', None)
    if uv is not None and len(uv) > 0:
        return np.asarray(uv)
    return None


def get_geometry_base_color(geometry: trimesh.Trimesh) -> np.ndarray | None:
    """Extract a flat RGB base color from a geometry's material, if any."""
    visual = getattr(geometry, 'visual', None)
    if visual is None:
        return None
    material = getattr(visual, 'material', None)
    if material is None:
        return None

    factor = getattr(material, 'baseColorFactor', None)
    if factor is None:
        factor = getattr(material, 'main_color', None)
    if factor is None:
        return None

    factor = np.asarray(factor).flatten()
    if factor.size < 3:
        return None
    rgb = factor[:3]
    # baseColorFactor is in [0, 1]; main_color is already in [0, 255].
    if rgb.max() <= 1.0:
        rgb = rgb * 255.0
    return np.clip(rgb, 0, 255).astype(np.uint8)


def get_geometry_vertex_colors(geometry: trimesh.Trimesh) -> np.ndarray | None:
    """Extract per-vertex RGB colors from a geometry, if present and meaningful."""
    visual = getattr(geometry, 'visual', None)
    if visual is None:
        return None
    if getattr(visual, 'kind', None) != 'vertex':
        return None
    vertex_colors = getattr(visual, 'vertex_colors', None)
    if vertex_colors is None or len(vertex_colors) != len(geometry.vertices):
        return None
    return np.asarray(vertex_colors)[:, :3]


def compute_sample_colors(mesh: trimesh.Trimesh, face_indices: np.ndarray,
                          bary: np.ndarray, texture: Image.Image | None,
                          uvs: np.ndarray | None) -> np.ndarray:
    """
    Compute per-sample RGB colors for sampled surface points.

    Tries, in order: texture + UV interpolation, per-vertex colors, a flat
    material base color, then a neutral gray fallback.
    """
    num_points = len(face_indices)

    # 1. Texture sampling via interpolated UVs.
    face_uvs = resolve_face_uvs(mesh, uvs)
    if texture is not None and face_uvs is not None:
        sampled_face_uvs = face_uvs[face_indices]  # (num_points, 3, 2)
        sampled_uvs = np.einsum('nc,ncd->nd', bary, sampled_face_uvs)
        return sample_texture_at_uvs(texture, sampled_uvs)

    # 2. Per-vertex colors, interpolated barycentrically.
    vertex_colors = get_geometry_vertex_colors(mesh)
    if vertex_colors is not None:
        tri_colors = vertex_colors[mesh.faces[face_indices]].astype(np.float64)
        colors = np.einsum('nc,ncd->nd', bary, tri_colors)
        return np.clip(colors, 0, 255).astype(np.uint8)

    # 3. Flat material base color.
    base_color = get_geometry_base_color(mesh)
    if base_color is not None:
        return np.tile(base_color, (num_points, 1))

    # 4. Neutral gray fallback.
    return np.full((num_points, 3), 128, dtype=np.uint8)


def sample_mesh_surface(mesh: trimesh.Trimesh, num_points: int,
                        rng: np.random.Generator,
                        texture: Image.Image | None = None,
                        uvs: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """
    Uniformly sample random points on a single mesh's surface (area-weighted)
    and compute their colors.

    Args:
        mesh: The trimesh object
        num_points: Number of points to sample
        rng: A numpy random Generator
        texture: The texture image for this mesh, or None
        uvs: UV coordinates for this mesh, or None

    Returns:
        Tuple of (points (num_points, 3), colors (num_points, 3))
    """
    if num_points <= 0:
        return (np.empty((0, 3), dtype=np.float32),
                np.empty((0, 3), dtype=np.uint8))

    # Area-weighted face selection so the sampling is uniform over surface area.
    areas = mesh.area_faces.astype(np.float64)
    total_area = areas.sum()
    if total_area <= 0:
        # Degenerate mesh; fall back to uniform face probabilities.
        face_probs = np.full(len(areas), 1.0 / len(areas))
    else:
        face_probs = areas / total_area

    face_indices = rng.choice(len(mesh.faces), size=num_points, p=face_probs)

    # Random uniform barycentric coordinates within each triangle.
    r1 = rng.random(num_points)
    r2 = rng.random(num_points)
    sqrt_r1 = np.sqrt(r1)
    bary = np.stack([
        1.0 - sqrt_r1,
        sqrt_r1 * (1.0 - r2),
        sqrt_r1 * r2,
    ], axis=1)  # (num_points, 3)

    # Interpolate point positions.
    triangles = mesh.vertices[mesh.faces[face_indices]]  # (num_points, 3, 3)
    points = np.einsum('nc,ncd->nd', bary, triangles).astype(np.float32)

    colors = compute_sample_colors(mesh, face_indices, bary, texture, uvs)

    return points, colors


def sample_scene_surface(geometries: list[trimesh.Trimesh], num_points: int,
                         seed: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """
    Uniformly sample points across all geometries in a scene, distributing the
    point budget proportionally to each geometry's surface area. Each geometry
    is colored using its own texture/UVs/material.

    Args:
        geometries: List of trimesh.Trimesh geometries (transforms applied)
        num_points: Total number of points to sample across all geometries
        seed: Optional random seed for reproducibility

    Returns:
        Tuple of (points (num_points, 3), colors (num_points, 3))
    """
    rng = np.random.default_rng(seed)

    areas = np.array([float(g.area) for g in geometries], dtype=np.float64)
    total_area = areas.sum()
    if total_area <= 0:
        weights = np.full(len(geometries), 1.0 / len(geometries))
    else:
        weights = areas / total_area

    # Largest-remainder allocation so the counts sum exactly to num_points.
    exact = weights * num_points
    counts = np.floor(exact).astype(np.int64)
    remainder = num_points - int(counts.sum())
    if remainder > 0:
        order = np.argsort(-(exact - counts))
        counts[order[:remainder]] += 1

    all_points = []
    all_colors = []
    for geometry, count in zip(geometries, counts):
        if count <= 0:
            continue
        texture = get_geometry_texture(geometry)
        uvs = get_geometry_uv(geometry)
        points, colors = sample_mesh_surface(geometry, int(count), rng,
                                             texture=texture, uvs=uvs)
        all_points.append(points)
        all_colors.append(colors)

    if not all_points:
        return (np.empty((0, 3), dtype=np.float32),
                np.empty((0, 3), dtype=np.uint8))

    return np.concatenate(all_points, axis=0), np.concatenate(all_colors, axis=0)


def write_ply_point_cloud(vertices: np.ndarray, colors: np.ndarray, 
                          output_path: str, binary: bool = True) -> None:
    """
    Write a PLY point cloud file with vertex colors (no faces).
    
    Args:
        vertices: numpy array of vertices (N, 3)
        colors: numpy array of RGB colors (N, 3)
        output_path: Path to save the PLY file
        binary: Whether to write in binary format (default True for smaller files)
    """
    num_vertices = len(vertices)
    
    with open(output_path, 'wb' if binary else 'w') as f:
        # Write header (point cloud - no faces)
        header = f"""ply
format {'binary_little_endian' if binary else 'ascii'} 1.0
element vertex {num_vertices}
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
"""
        if binary:
            f.write(header.encode('ascii'))
        else:
            f.write(header)
        
        # Write vertices with colors
        if binary:
            for i in range(num_vertices):
                # Write position as floats
                f.write(np.array(vertices[i], dtype=np.float32).tobytes())
                # Write color as bytes
                f.write(np.array(colors[i], dtype=np.uint8).tobytes())
        else:
            for i in range(num_vertices):
                f.write(f"{vertices[i, 0]} {vertices[i, 1]} {vertices[i, 2]} "
                       f"{colors[i, 0]} {colors[i, 1]} {colors[i, 2]}\n")


def glb_to_ply(input_path: str, output_path: str | None = None, 
               binary: bool = True, output_dir: Path | None = None,
               sample_points: int | None = None, seed: int | None = None) -> str:
    """
    Convert a GLB file to PLY point cloud with vertex colors from texture.
    
    Args:
        input_path: Path to the input GLB file
        output_path: Path to save the output PLY file (optional)
        binary: Whether to write binary PLY (default True)
        output_dir: Directory to save output files (optional, defaults to ./plys/)
        sample_points: If set, randomly/uniformly sample this many points on the
            mesh surface instead of using only the mesh vertices
        seed: Optional random seed used when sample_points is set
        
    Returns:
        Path to the output PLY file
    """
    input_path = Path(input_path)
    script_dir = Path(__file__).parent
    
    if output_path is None:
        # Default to ./plys/ folder
        if output_dir is None:
            output_dir = script_dir / "plys"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / input_path.with_suffix('.ply').name
    else:
        output_path = Path(output_path)
    
    print(f"Loading GLB file: {input_path}")

    if sample_points is not None:
        # Randomly and uniformly sample points across the mesh faces. Keep each
        # geometry separate so its own texture/UVs/material are used for color.
        geometries = load_glb_geometries(str(input_path))
        total_vertices = sum(len(g.vertices) for g in geometries)
        total_faces = sum(len(g.faces) for g in geometries)
        print(f"  Geometries: {len(geometries)}")
        print(f"  Vertices: {total_vertices}")
        print(f"  Faces: {total_faces}")

        textured = sum(1 for g in geometries
                       if get_geometry_texture(g) is not None
                       and get_geometry_uv(g) is not None)
        print(f"  Textured geometries: {textured}/{len(geometries)}")
        if textured == 0:
            print("Warning: No textured geometries found. Falling back to vertex/"
                  "material colors where available, otherwise gray.")

        print(f"Sampling {sample_points} points uniformly over the mesh surface...")
        points, colors = sample_scene_surface(geometries, sample_points, seed=seed)
    else:
        # Load mesh (concatenated)
        mesh = load_glb(str(input_path))
        print(f"  Vertices: {len(mesh.vertices)}")
        print(f"  Faces: {len(mesh.faces)}")

        # Extract texture
        texture = extract_texture_from_glb(str(input_path))
        if texture is not None:
            print(f"  Texture size: {texture.size[0]}x{texture.size[1]}")

        # Get UV coordinates
        uvs = get_uv_coordinates(str(input_path))
        if uvs is not None:
            print(f"  UV coordinates: {len(uvs)}")

        points = mesh.vertices
        if texture is None:
            print("Warning: No texture found. Using default gray color for all vertices.")
            colors = np.full((len(mesh.vertices), 3), 128, dtype=np.uint8)
        elif uvs is None:
            print("Warning: No UV coordinates found. Using default gray color for all vertices.")
            colors = np.full((len(mesh.vertices), 3), 128, dtype=np.uint8)
        else:
            # Compute vertex colors from texture
            colors = compute_vertex_colors_from_faces(mesh, uvs, texture)
    
    # Write PLY point cloud file (no faces)
    print(f"Writing PLY point cloud ({len(points)} points): {output_path}")
    write_ply_point_cloud(points, colors, str(output_path), binary=binary)
    
    print(f"Conversion complete!")
    return str(output_path)


def convert_all_glbs(glbs_dir: Path, plys_dir: Path, binary: bool = True,
                     sample_points: int | None = None, seed: int | None = None) -> list[str]:
    """
    Convert all GLB files in a directory to PLY point clouds.
    
    Args:
        glbs_dir: Directory containing GLB files
        plys_dir: Directory to save PLY files
        binary: Whether to write binary PLY (default True)
        sample_points: If set, randomly/uniformly sample this many points per mesh
        seed: Optional random seed used when sample_points is set
        
    Returns:
        List of output PLY file paths
    """
    if not glbs_dir.exists():
        print(f"Error: GLBs directory not found: {glbs_dir}")
        return []
    
    glb_files = list(glbs_dir.glob("*.glb"))
    
    if not glb_files:
        print(f"No GLB files found in {glbs_dir}")
        return []
    
    print(f"Found {len(glb_files)} GLB file(s) in {glbs_dir}")
    plys_dir.mkdir(parents=True, exist_ok=True)
    
    output_files = []
    for glb_file in glb_files:
        print(f"\n{'='*60}")
        try:
            output_path = glb_to_ply(str(glb_file), output_dir=plys_dir, binary=binary,
                                     sample_points=sample_points, seed=seed)
            output_files.append(output_path)
        except Exception as e:
            print(f"Error converting {glb_file}: {e}")
    
    print(f"\n{'='*60}")
    print(f"Converted {len(output_files)}/{len(glb_files)} files successfully")
    return output_files


def main():
    parser = argparse.ArgumentParser(
        description="Convert GLB files to PLY point clouds with vertex colors from texture sampling"
    )
    parser.add_argument(
        "input",
        type=str,
        nargs="?",
        default=None,
        help="Path to input GLB file (optional, defaults to processing all files in ./glbs/)"
    )
    parser.add_argument(
        "output",
        type=str,
        nargs="?",
        default=None,
        help="Path to output PLY file (optional, defaults to ./plys/<input_name>.ply)"
    )
    parser.add_argument(
        "--ascii",
        action="store_true",
        help="Write ASCII PLY instead of binary (larger file size)"
    )
    parser.add_argument(
        "-n", "--sample-points",
        type=int,
        default=None,
        metavar="N",
        help="Randomly and uniformly sample N points across the textured mesh "
             "faces instead of using only the mesh vertices (e.g. -n 100000)"
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for reproducible surface sampling (used with --sample-points)"
    )
    
    args = parser.parse_args()
    script_dir = Path(__file__).parent

    if args.sample_points is not None and args.sample_points <= 0:
        print("Error: --sample-points must be a positive integer")
        sys.exit(1)
    
    # If no input specified, convert all GLBs in ./glbs/ to ./plys/
    if args.input is None:
        glbs_dir = script_dir / "glbs"
        plys_dir = script_dir / "plys"
        
        output_files = convert_all_glbs(glbs_dir, plys_dir, binary=not args.ascii,
                                        sample_points=args.sample_points, seed=args.seed)
        if not output_files:
            sys.exit(1)
    else:
        # Single file conversion
        if not Path(args.input).exists():
            print(f"Error: Input file not found: {args.input}")
            sys.exit(1)
        
        try:
            glb_to_ply(args.input, args.output, binary=not args.ascii,
                       sample_points=args.sample_points, seed=args.seed)
        except Exception as e:
            print(f"Error during conversion: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
