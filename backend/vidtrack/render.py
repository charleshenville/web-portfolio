#!/usr/bin/env python3
"""
Offscreen renderer for a textured scan.

Matching a photograph against a scan's texture atlas barely works: the atlas is
chopped into small charts, each resampled and rotated, so a feature there looks
little like the same feature seen head-on. A render of the mesh does not have
that problem - it is a contiguous, correctly-perspectived view, which is to say
it looks like a photograph.

Alongside the colour image, every pixel's world-space position is written to a
second attachment. That turns 3D lookup into an array read: match a point in a
render, index the position buffer, and the mesh coordinate falls out with no
unprojection and no depth-buffer decoding.

Uses an offscreen OpenGL context, which on macOS runs on Metal with no window
and no display server.
"""

import numpy as np

import moderngl

VERTEX_SHADER = """
#version 330
uniform mat4 mvp;
in vec3 in_position;
in vec2 in_uv;
out vec2 v_uv;
out vec3 v_world;
void main() {
    v_uv = in_uv;
    v_world = in_position;
    gl_Position = mvp * vec4(in_position, 1.0);
}
"""

FRAGMENT_SHADER = """
#version 330
uniform sampler2D tex;
in vec2 v_uv;
in vec3 v_world;
layout(location = 0) out vec4 f_color;
layout(location = 1) out vec4 f_world;
void main() {
    f_color = vec4(texture(tex, v_uv).rgb, 1.0);
    // Alpha flags coverage, so a reader can tell surface from background.
    f_world = vec4(v_world, 1.0);
}
"""


def look_at(eye: np.ndarray, target: np.ndarray, up: np.ndarray) -> np.ndarray:
    """
    World-to-view matrix for a camera at `eye` looking at `target`.

    Follows the OpenGL convention: the camera looks down its own -Z with +Y up.
    """
    eye = np.asarray(eye, dtype=np.float64)
    target = np.asarray(target, dtype=np.float64)
    f = target - eye
    f /= np.linalg.norm(f)
    up = np.asarray(up, dtype=np.float64)
    s = np.cross(f, up)
    n = np.linalg.norm(s)
    if n < 1e-8:  # looking straight along `up`; pick any perpendicular
        up = np.array([1.0, 0.0, 0.0])
        s = np.cross(f, up)
        n = np.linalg.norm(s)
    s /= n
    u = np.cross(s, f)

    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = s, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


def perspective(fy_px: float, width: int, height: int,
                near: float = 0.01, far: float = 500.0) -> np.ndarray:
    """Projection matrix from a focal length in pixels."""
    m = np.zeros((4, 4))
    m[0, 0] = 2.0 * fy_px / width
    m[1, 1] = 2.0 * fy_px / height
    m[2, 2] = -(far + near) / (far - near)
    m[2, 3] = -2.0 * far * near / (far - near)
    m[3, 2] = -1.0
    return m


def fibonacci_sphere(n: int, min_elevation: float = -0.25) -> np.ndarray:
    """
    Evenly spread unit directions over a sphere.

    Directions far below the horizon are dropped: these are objects standing on
    the ground, so nothing was ever filmed from underneath them.
    """
    i = np.arange(n, dtype=np.float64) + 0.5
    y = 1.0 - 2.0 * i / n
    keep = y >= min_elevation
    y = y[keep]
    r = np.sqrt(np.maximum(0.0, 1.0 - y * y))
    phi = np.pi * (1.0 + 5.0 ** 0.5) * i[keep]
    return np.stack([np.cos(phi) * r, y, np.sin(phi) * r], axis=1)


class ScanRenderer:
    """
    Renders a textured mesh offscreen, returning colour and world position.

    Args:
        vertices: (V,3) mesh vertices
        faces: (F,3) triangle indices
        uv: (V,2) texture coordinates
        texture: (H,W,3) uint8 RGB texture
        width, height: render size in pixels
    """

    def __init__(self, vertices, faces, uv, texture, width=800, height=600):
        self.width = width
        self.height = height
        self.ctx = moderngl.create_standalone_context()
        self.ctx.enable(moderngl.DEPTH_TEST)
        self.prog = self.ctx.program(vertex_shader=VERTEX_SHADER,
                                     fragment_shader=FRAGMENT_SHADER)

        verts = np.asarray(vertices, dtype="f4")
        # trimesh hands back UVs with v=0 at the bottom of the image, which is
        # already what GL samples; the flip happens once, on upload below.
        uvs = np.asarray(uv, dtype="f4")

        self.vbo = self.ctx.buffer(
            np.hstack([verts, uvs]).astype("f4").tobytes())
        self.ibo = self.ctx.buffer(np.asarray(faces, dtype="i4").tobytes())
        self.vao = self.ctx.vertex_array(
            self.prog,
            [(self.vbo, "3f 2f", "in_position", "in_uv")],
            self.ibo,
        )

        tex = np.ascontiguousarray(texture[::-1])  # flip to GL's row order
        self.tex = self.ctx.texture((tex.shape[1], tex.shape[0]), 3,
                                    tex.tobytes())
        self.tex.build_mipmaps()
        self.tex.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
        self.tex.anisotropy = 8.0

        self.color_rb = self.ctx.renderbuffer((width, height), components=4)
        self.world_rb = self.ctx.renderbuffer((width, height), components=4,
                                              dtype="f4")
        self.depth_rb = self.ctx.depth_renderbuffer((width, height))
        self.fbo = self.ctx.framebuffer(
            color_attachments=[self.color_rb, self.world_rb],
            depth_attachment=self.depth_rb,
        )

    def render(self, view: np.ndarray, proj: np.ndarray):
        """
        Draw the mesh for one camera.

        Args:
            view: 4x4 world-to-view matrix
            proj: 4x4 projection matrix

        Returns:
            (rgb uint8 (H,W,3), world float32 (H,W,3), mask bool (H,W))
            with rows ordered top-down, matching OpenCV
        """
        self.fbo.use()
        self.ctx.clear(0.0, 0.0, 0.0, 0.0)
        mvp = (proj @ view).astype("f4")
        self.prog["mvp"].write(np.ascontiguousarray(mvp.T, dtype="f4"))
        self.tex.use(0)
        self.prog["tex"].value = 0
        self.vao.render(moderngl.TRIANGLES)

        rgb = np.frombuffer(self.fbo.read(attachment=0, components=3),
                            dtype=np.uint8).reshape(self.height, self.width, 3)
        world = np.frombuffer(
            self.fbo.read(attachment=1, components=4, dtype="f4"),
            dtype="f4").reshape(self.height, self.width, 4)
        rgb = rgb[::-1].copy()
        world = world[::-1].copy()
        return rgb, world[:, :, :3], world[:, :, 3] > 0.5

    def release(self):
        """Drop the GL objects and the context."""
        for obj in (self.vao, self.vbo, self.ibo, self.tex, self.fbo,
                    self.color_rb, self.world_rb, self.depth_rb):
            try:
                obj.release()
            except Exception:
                pass
        self.ctx.release()
