#!/usr/bin/env python3
"""
GLB to PLY Point Cloud Converter with Texture Sampling

Converts GLB files (with embedded textures) to PLY point cloud files by sampling
the texture color at each vertex's UV coordinates.

Usage:
    python glb_to_ply.py                     # Convert all GLBs in ./glbs/ to ./plys/
    python glb_to_ply.py <input.glb>         # Convert single file to ./plys/
    python glb_to_ply.py <input.glb> <out.ply>  # Convert to specific output path
    
By default, processes all .glb files in ./glbs/ and outputs point cloud PLY files
to ./plys/ folder.

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
               binary: bool = True, output_dir: Path | None = None) -> str:
    """
    Convert a GLB file to PLY point cloud with vertex colors from texture.
    
    Args:
        input_path: Path to the input GLB file
        output_path: Path to save the output PLY file (optional)
        binary: Whether to write binary PLY (default True)
        output_dir: Directory to save output files (optional, defaults to ./plys/)
        
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
    
    # Load mesh
    mesh = load_glb(str(input_path))
    print(f"  Vertices: {len(mesh.vertices)}")
    print(f"  Faces: {len(mesh.faces)}")
    
    # Extract texture
    texture = extract_texture_from_glb(str(input_path))
    if texture is None:
        print("Warning: No texture found. Using default gray color for all vertices.")
        colors = np.full((len(mesh.vertices), 3), 128, dtype=np.uint8)
    else:
        print(f"  Texture size: {texture.size[0]}x{texture.size[1]}")
        
        # Get UV coordinates
        uvs = get_uv_coordinates(str(input_path))
        if uvs is None:
            print("Warning: No UV coordinates found. Using default gray color for all vertices.")
            colors = np.full((len(mesh.vertices), 3), 128, dtype=np.uint8)
        else:
            print(f"  UV coordinates: {len(uvs)}")
            
            # Compute vertex colors from texture
            colors = compute_vertex_colors_from_faces(mesh, uvs, texture)
    
    # Write PLY point cloud file (no faces)
    print(f"Writing PLY point cloud: {output_path}")
    write_ply_point_cloud(mesh.vertices, colors, str(output_path), binary=binary)
    
    print(f"Conversion complete!")
    return str(output_path)


def convert_all_glbs(glbs_dir: Path, plys_dir: Path, binary: bool = True) -> list[str]:
    """
    Convert all GLB files in a directory to PLY point clouds.
    
    Args:
        glbs_dir: Directory containing GLB files
        plys_dir: Directory to save PLY files
        binary: Whether to write binary PLY (default True)
        
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
            output_path = glb_to_ply(str(glb_file), output_dir=plys_dir, binary=binary)
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
    
    args = parser.parse_args()
    script_dir = Path(__file__).parent
    
    # If no input specified, convert all GLBs in ./glbs/ to ./plys/
    if args.input is None:
        glbs_dir = script_dir / "glbs"
        plys_dir = script_dir / "plys"
        
        output_files = convert_all_glbs(glbs_dir, plys_dir, binary=not args.ascii)
        if not output_files:
            sys.exit(1)
    else:
        # Single file conversion
        if not Path(args.input).exists():
            print(f"Error: Input file not found: {args.input}")
            sys.exit(1)
        
        try:
            glb_to_ply(args.input, args.output, binary=not args.ascii)
        except Exception as e:
            print(f"Error during conversion: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
