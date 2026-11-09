// GLSL for the Quad Trees renderer (WebGL2). Every full-frame pass draws one
// triangle from gl_VertexID; v_uv runs 0-1 with v = 1 at the top of the
// frame, the way render targets and readbacks are laid out here. Uploaded
// pictures arrive top row first and are flipped in `blit`.

export const FULL_VS = `#version 300 es
out vec2 v_uv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 o;
`;

const RAMP = `
uniform vec3 u_stops[8];
uniform int u_nStops;
// A gradient through the stops that wraps from the last back to the first.
vec3 cyc(float t) {
    int n = max(u_nStops, 1);
    float p = fract(t) * float(n);
    int i = int(floor(p)) % n;
    int j = (i + 1) % n;
    float f = p - floor(p);
    return mix(u_stops[i], u_stops[j], f * f * (3.0 - 2.0 * f));
}
`;

// A picture fitted into the frame: 0 cover, 1 contain, 2 stretch.
const SRGB = `
vec3 toSrgb(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

export const BLIT_FS = `${HEAD}
${SRGB}
uniform sampler2D u_tex;
uniform float u_srcAspect;
uniform float u_dstAspect;
uniform int u_fit;
uniform vec3 u_bg;
uniform float u_zoom;
uniform vec4 u_uvRect;   // the part of the texture to use
uniform int u_flipV;     // uploaded pictures are top row first
uniform int u_toSrgb;    // a linear source (the compositor's frame)
void main() {
    vec2 uv = v_uv - 0.5;
    float k = u_dstAspect / u_srcAspect;
    if (u_fit == 0) { if (k > 1.0) uv.y /= k; else uv.x *= k; }
    else if (u_fit == 1) { if (k > 1.0) uv.x *= k; else uv.y /= k; }
    uv = uv / max(u_zoom, 1e-3) + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { o = vec4(u_bg, 1.0); return; }
    vec2 tc = u_uvRect.xy + vec2(uv.x, u_flipV == 1 ? 1.0 - uv.y : uv.y) * u_uvRect.zw;
    vec3 c = texture(u_tex, tc).rgb;
    if (u_toSrgb == 1) c = toSrgb(c);
    o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Generated gradients, all periodic in u_phase so a loop is seamless.
export const GRADIENT_FS = `${HEAD}
${RAMP}
uniform int u_type;
uniform float u_phase;
uniform float u_aspect;
uniform float u_angle;
uniform float u_spin;
uniform float u_cycles;
uniform float u_scale;
const float TAU = 6.28318530718;
void main() {
    vec2 p = (v_uv - 0.5) * vec2(u_aspect, 1.0);
    float a = u_angle + TAU * u_spin * u_phase;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    vec2 q = R * p;
    float ph = u_cycles * u_phase;
    vec3 c;
    if (u_type == 0) {
        c = cyc(q.x / u_aspect * 0.5 * u_scale + 0.25 - ph);
    } else if (u_type == 1) {
        c = cyc(length(p) * u_scale - ph);
    } else if (u_type == 2) {
        c = cyc((atan(q.y, q.x) / TAU) * max(1.0, floor(u_scale + 0.5)) - ph);
    } else if (u_type == 3) {
        vec2 f = smoothstep(0.0, 1.0, v_uv);
        vec3 c00 = cyc(0.0 + ph);
        vec3 c10 = cyc(0.25 + ph);
        vec3 c11 = cyc(0.5 + ph);
        vec3 c01 = cyc(0.75 + ph);
        c = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
    } else {
        // Waves: a few interfering sines, each turning a whole number of
        // times per loop.
        float w = u_scale * 3.0;
        float t = TAU * u_phase;
        float v = sin(q.x * w + t * u_cycles)
            + sin((q.y * 0.8 + q.x * 0.6) * w * 1.3 - t * u_cycles)
            + sin(length(q * vec2(1.0, 1.4) + vec2(0.3, -0.2)) * w * 1.7 + t);
        c = cyc(v * 0.18 + 0.5 + u_phase * u_spin);
    }
    o = vec4(c, 1.0);
}`;

// Bouncing shapes. Positions come in frame units (x 0..aspect, y 0..1).
export const SHAPES_FS = `${HEAD}
uniform vec4 u_shape[64];  // x, y, radius, rotation
uniform vec4 u_color[64];  // r, g, b, kind
uniform int u_count;
uniform vec3 u_bg;
uniform float u_aspect;
uniform float u_soft;
uniform int u_blend;
uniform float u_px;
float sdBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdTri(vec2 p, float r) {
    const float k = 1.7320508;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
}
void main() {
    vec2 p = vec2(v_uv.x * u_aspect, 1.0 - v_uv.y);
    vec3 col = u_bg;
    float px = u_px;
    for (int i = 0; i < 64; i++) {
        if (i >= u_count) break;
        vec4 s = u_shape[i];
        vec4 c = u_color[i];
        vec2 d = p - s.xy;
        if (abs(d.x) > s.z * 1.5 + u_soft || abs(d.y) > s.z * 1.5 + u_soft) continue;
        float ca = cos(s.w);
        float sa = sin(s.w);
        d = mat2(ca, -sa, sa, ca) * d;
        float dist;
        int kind = int(c.w + 0.5);
        if (kind == 0) dist = length(d) - s.z;
        else if (kind == 1) dist = sdBox(d, vec2(s.z * 0.82), s.z * 0.12);
        else if (kind == 2) dist = sdTri(d, s.z * 0.95);
        else dist = abs(length(d) - s.z * 0.72) - s.z * 0.26;
        float a = 1.0 - smoothstep(-px - u_soft, px + u_soft, dist);
        if (u_blend == 1) col += c.rgb * a;
        else if (u_blend == 2) col = 1.0 - (1.0 - col) * (1.0 - c.rgb * a);
        else col = mix(col, c.rgb, a);
    }
    o = vec4(min(col, 1.0), 1.0);
}`;

// Colour grade on the seed.
export const GRADE_FS = `${HEAD}
uniform sampler2D u_tex;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
uniform float u_tint;
uniform float u_hue;
uniform float u_gamma;
uniform float u_lift;
uniform float u_gain;
uniform float u_invert;
uniform float u_posterize;
void main() {
    vec3 c = texture(u_tex, v_uv).rgb;
    c *= exp2(u_exposure);
    c *= vec3(1.0 + 0.25 * u_temperature - 0.05 * u_tint, 1.0 + 0.2 * u_tint, 1.0 - 0.25 * u_temperature - 0.05 * u_tint);
    c = c * (u_gain - u_lift) + u_lift;
    c = (c - 0.5) * u_contrast + 0.5;
    if (u_hue != 0.0) {
        const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
        const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
        vec3 yiq = toYIQ * c;
        float h = u_hue;
        yiq.yz = mat2(cos(h), sin(h), -sin(h), cos(h)) * yiq.yz;
        c = toRGB * yiq;
    }
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, u_saturation);
    c = pow(max(c, 0.0), vec3(1.0 / max(u_gamma, 0.01)));
    c = clamp(c, 0.0, 1.0);
    if (u_posterize >= 2.0) c = floor(c * (u_posterize - 1.0) + 0.5) / (u_posterize - 1.0);
    c = mix(c, 1.0 - c, u_invert);
    o = vec4(c, 1.0);
}`;

// Separable Gaussian.
export const BLUR_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec2 u_dir;     // texel step times radius / taps
void main() {
    vec3 acc = texture(u_tex, v_uv).rgb;
    float wsum = 1.0;
    for (int i = 1; i <= 12; i++) {
        float x = float(i) / 12.0;
        float w = exp(-4.5 * x * x);
        acc += (texture(u_tex, v_uv + u_dir * float(i)).rgb + texture(u_tex, v_uv - u_dir * float(i)).rgb) * w;
        wsum += 2.0 * w;
    }
    o = vec4(acc / wsum, 1.0);
}`;

// The analysis image: the graded seed (mipmapped down) and the noise map.
export const ANALYSIS_FS = `${HEAD}
uniform sampler2D u_tex;
uniform int u_noise;
uniform float u_aspect;
uniform float u_phase;
uniform float u_scale;
uniform int u_octaves;
uniform int u_evolve;
uniform float u_contrast;
uniform float u_warp;
uniform uint u_seed;

uvec3 pcg3(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
vec3 grad(ivec3 p, int per, uint seed) {
    p.z = ((p.z % per) + per) % per;
    uvec3 h = pcg3(uvec3(p + 32768) + uvec3(seed, seed * 7u, seed * 13u));
    vec3 g = vec3(h & 0xffffu) / 32767.5 - 1.0;
    return normalize(g + 1e-4);
}
// Gradient noise, periodic in z with period per.
float gnoise(vec3 p, int per, uint seed) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(grad(i, per, seed), f);
    float n100 = dot(grad(i + ivec3(1, 0, 0), per, seed), f - vec3(1, 0, 0));
    float n010 = dot(grad(i + ivec3(0, 1, 0), per, seed), f - vec3(0, 1, 0));
    float n110 = dot(grad(i + ivec3(1, 1, 0), per, seed), f - vec3(1, 1, 0));
    float n001 = dot(grad(i + ivec3(0, 0, 1), per, seed), f - vec3(0, 0, 1));
    float n101 = dot(grad(i + ivec3(1, 0, 1), per, seed), f - vec3(1, 0, 1));
    float n011 = dot(grad(i + ivec3(0, 1, 1), per, seed), f - vec3(0, 1, 1));
    float n111 = dot(grad(i + ivec3(1, 1, 1), per, seed), f - vec3(1, 1, 1));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec2 p, uint seed) {
    float a = 0.5;
    float s = 0.0;
    float norm = 0.0;
    float f = 1.0;
    int per = max(u_evolve, 1);
    for (int k = 0; k < 8; k++) {
        if (k >= u_octaves) break;
        int pk = per << k;
        s += a * gnoise(vec3(p * f + float(k) * 17.3, u_phase * float(pk)), pk, seed + uint(k) * 101u);
        norm += a;
        a *= 0.5;
        f *= 2.0;
    }
    return s / norm;
}
void main() {
    vec3 c = texture(u_tex, v_uv).rgb;
    float n = 1.0;
    if (u_noise == 1) {
        vec2 p = vec2(v_uv.x * u_aspect, 1.0 - v_uv.y) * u_scale;
        if (u_warp > 0.0) p += u_warp * vec2(fbm(p + vec2(5.2, 1.3), u_seed + 9u), fbm(p + vec2(1.7, 9.2), u_seed + 19u));
        n = clamp(0.5 + fbm(p, u_seed) * 1.6 * u_contrast, 0.0, 1.0);
    }
    o = vec4(c, n);
}`;

// The quads, one instance each.
export const QUAD_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 a_rect;   // x, y, size (output px)
layout(location = 1) in vec4 a_col;    // r, g, b, luma
layout(location = 2) in vec2 a_misc;   // hash, kind
uniform vec2 u_res;      // target px
uniform float u_k;       // target px per output px
uniform float u_gap;     // output px
uniform float u_size;
uniform float u_halftone;
uniform int u_htInvert;
uniform int u_shape;     // 0 square, 1 circle, 2 mixed, 3 ascii
uniform float u_mix;
uniform float u_outline; // output px
uniform int u_crisp;
uniform int u_pass;      // 0 shapes / fills, 1 the shared edge layer
uniform float u_lineW;   // edge width, whole target px
out vec2 v_p;
out float v_half;
out float v_cellHalf;
out vec4 v_col;
out vec2 v_pos;
flat out int v_circle;
flat out float v_kind;
flat out vec4 v_rect;    // snapped x0, y0, x1, y1 (target px)
flat out vec4 v_frame;   // 1 where a side lies on the frame's left, top, right, bottom
void main() {
    int id = gl_VertexID;
    vec2 c = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
    v_col = a_col;
    v_kind = a_misc.y;
    bool circle0 = u_shape == 1 || (u_shape == 2 && a_misc.x < u_mix);
    if (u_crisp == 1 && !circle0 && u_shape != 3) {
        // Plain tiled squares: corners snapped to whole pixels, so
        // neighbours share exact edges and fills tile with no seams.
        vec2 a = floor(a_rect.xy * u_k + 0.5);
        vec2 b = max(floor((a_rect.xy + a_rect.z) * u_k + 0.5), a + 1.0);
        float pad = u_pass == 1 ? u_lineW + 1.0 : 0.0;
        vec2 pos = mix(a - pad, b + pad, c);
        v_rect = vec4(a, b);
        v_frame = vec4(a.x <= 0.5 ? 1.0 : 0.0, a.y <= 0.5 ? 1.0 : 0.0, b.x >= u_res.x - 0.5 ? 1.0 : 0.0, b.y >= u_res.y - 0.5 ? 1.0 : 0.0);
        v_pos = pos;
        v_p = pos - (a + b) * 0.5;
        v_half = (b.x - a.x) * 0.5;
        v_cellHalf = v_half;
        v_circle = 0;
        gl_Position = vec4(pos.x / u_res.x * 2.0 - 1.0, 1.0 - pos.y / u_res.y * 2.0, 0.0, 1.0);
        return;
    }
    v_rect = vec4(0.0);
    v_frame = vec4(0.0);
    float cellHalf = a_rect.z * u_k * 0.5;
    vec2 centre = (a_rect.xy + a_rect.z * 0.5) * u_k;
    float l = u_htInvert == 1 ? 1.0 - a_col.a : a_col.a;
    float ht = mix(1.0, sqrt(clamp(l, 0.0, 1.0)), u_halftone);
    float hs = max(0.0, cellHalf - u_gap * u_k * 0.5) * u_size * ht;
    bool circle = u_shape == 1 || (u_shape == 2 && a_misc.x < u_mix);
    float ext = u_shape == 3 ? cellHalf : hs + (u_crisp == 1 && !circle ? 0.0 : 1.0);
    vec2 off = (c * 2.0 - 1.0) * ext;
    vec2 pos = centre + off;
    v_p = off;
    v_pos = pos;
    v_half = hs;
    v_cellHalf = cellHalf;
    v_circle = circle ? 1 : 0;
    gl_Position = vec4(pos.x / u_res.x * 2.0 - 1.0, 1.0 - pos.y / u_res.y * 2.0, 0.0, 1.0);
}`;

export const QUAD_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_p;
in float v_half;
in float v_cellHalf;
in vec4 v_col;
in vec2 v_pos;
flat in int v_circle;
flat in float v_kind;
flat in vec4 v_rect;
flat in vec4 v_frame;
out vec4 o;
uniform int u_pass;
uniform float u_lineW;
uniform vec2 u_res;
uniform float u_k;
uniform float u_radius;
uniform float u_outline;
uniform vec3 u_outlineColor;
uniform int u_outlineMode;  // 0 solid, 1 cell colour, 2 shade
uniform int u_fill;
uniform float u_opacity;
uniform int u_shape;
uniform int u_crisp;
uniform sampler2D u_atlas;
uniform float u_glyphs;
uniform float u_grid;
uniform float u_glyphBg;
uniform float u_size;
uniform int u_rampInvert;
float sdBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
    vec3 col = v_col.rgb;
    if (u_shape == 3) {
        float l = clamp(v_col.a, 0.0, 1.0);
        if (u_rampInvert == 1) l = 1.0 - l;
        float g = floor(l * (u_glyphs - 1.0) + 0.5);
        vec2 cell = vec2(mod(g, u_grid), floor(g / u_grid));
        vec2 q = v_p / max(v_cellHalf * u_size, 1e-3) * 0.5 + 0.5;
        float m = 0.0;
        if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) m = texture(u_atlas, (cell + q) / u_grid).a;
        float bgA = u_glyphBg;
        vec3 rgb = col * m + col * 0.35 * bgA * (1.0 - m);
        float a = max(m, bgA);
        o = vec4(rgb, a) * u_opacity;
        return;
    }
    vec3 lineCol0 = u_outlineMode == 0 ? u_outlineColor : (u_outlineMode == 1 ? col : col * 0.45);
    if (u_crisp == 1 && v_circle == 0) {
        // Snapped squares. Pass 0: the fill, exactly the cell's pixels.
        if (u_pass == 0) {
            if (u_fill == 0) discard;
            o = vec4(col, 1.0) * u_opacity;
            return;
        }
        // Pass 1, after every fill: each cell paints only its left and top
        // edges (and any side on the frame), so every shared edge is drawn
        // once, the same whole-pixel width everywhere.
        float w = u_lineW;
        float f = floor(w * 0.5);
        vec2 p = v_pos;
        vec4 r = v_rect;
        float lx = v_frame.x > 0.5 ? 0.0 : r.x - f;
        float ty = v_frame.y > 0.5 ? 0.0 : r.y - f;
        float rx = v_frame.z > 0.5 ? u_res.x - w : r.z - f;
        float by = v_frame.w > 0.5 ? u_res.y - w : r.w - f;
        // Spans along an edge reach over the corners so lines meet.
        bool spanY = p.y >= ty && p.y < by + w;
        bool spanX = p.x >= lx && p.x < rx + w;
        bool on = (p.x >= lx && p.x < lx + w && spanY)
            || (p.y >= ty && p.y < ty + w && spanX)
            || (v_frame.z > 0.5 && p.x >= rx && p.x < rx + w && spanY)
            || (v_frame.w > 0.5 && p.y >= by && p.y < by + w && spanX);
        if (!on) discard;
        o = vec4(lineCol0, 1.0) * u_opacity;
        return;
    }
    if (u_pass == 1) discard;
    float d = v_circle == 1 ? length(v_p) - v_half : sdBox(v_p, vec2(v_half), u_radius * v_half);
    bool crisp = u_crisp == 1 && v_circle == 0;
    float cover = crisp ? (d <= 0.0 ? 1.0 : 0.0) : clamp(0.5 - d, 0.0, 1.0);
    float ow = u_outline * u_k;
    float inner = cover;
    if (ow > 0.0) inner = crisp ? (d <= -ow ? 1.0 : 0.0) : clamp(0.5 - (d + ow), 0.0, 1.0);
    vec3 lineCol = u_outlineMode == 0 ? u_outlineColor : (u_outlineMode == 1 ? col : col * 0.45);
    float fillPart = u_fill == 1 ? inner : 0.0;
    float linePart = ow > 0.0 ? max(cover - inner, 0.0) : 0.0;
    float a = fillPart + linePart;
    if (a <= 0.0) discard;
    vec3 rgb = col * fillPart + lineCol * linePart;
    o = vec4(rgb, a) * u_opacity;
}`;

// Underlay: the graded seed behind the quads.
export const UNDERLAY_FS = `${HEAD}
uniform sampler2D u_tex;
uniform float u_opacity;
void main() { o = vec4(texture(u_tex, v_uv).rgb * u_opacity, u_opacity); }`;

// Glow: bright pass, then a dual-filter blur pyramid.
export const BRIGHT_FS = `${HEAD}
uniform sampler2D u_tex;
uniform float u_threshold;
uniform vec2 u_texel;
void main() {
    vec3 c = (texture(u_tex, v_uv + u_texel * vec2(-0.5, -0.5)).rgb
        + texture(u_tex, v_uv + u_texel * vec2(0.5, -0.5)).rgb
        + texture(u_tex, v_uv + u_texel * vec2(-0.5, 0.5)).rgb
        + texture(u_tex, v_uv + u_texel * vec2(0.5, 0.5)).rgb) * 0.25;
    float l = max(c.r, max(c.g, c.b));
    float knee = 0.2;
    float soft = clamp(l - u_threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float k = max(soft, l - u_threshold) / max(l, 1e-4);
    o = vec4(c * k, 1.0);
}`;

export const DOWN_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec2 u_texel;
void main() {
    vec3 s = texture(u_tex, v_uv).rgb * 4.0;
    s += texture(u_tex, v_uv - u_texel).rgb;
    s += texture(u_tex, v_uv + u_texel).rgb;
    s += texture(u_tex, v_uv + vec2(u_texel.x, -u_texel.y)).rgb;
    s += texture(u_tex, v_uv - vec2(u_texel.x, -u_texel.y)).rgb;
    o = vec4(s / 8.0, 1.0);
}`;

export const UP_FS = `${HEAD}
uniform sampler2D u_tex;    // the smaller level, already summed
uniform sampler2D u_add;    // this level's own blur
uniform vec2 u_texel;
uniform float u_spread;
void main() {
    vec2 t = u_texel * u_spread;
    vec3 s = texture(u_tex, v_uv + vec2(-t.x * 2.0, 0.0)).rgb;
    s += texture(u_tex, v_uv + vec2(-t.x, t.y)).rgb * 2.0;
    s += texture(u_tex, v_uv + vec2(0.0, t.y * 2.0)).rgb;
    s += texture(u_tex, v_uv + vec2(t.x, t.y)).rgb * 2.0;
    s += texture(u_tex, v_uv + vec2(t.x * 2.0, 0.0)).rgb;
    s += texture(u_tex, v_uv + vec2(t.x, -t.y)).rgb * 2.0;
    s += texture(u_tex, v_uv + vec2(0.0, -t.y * 2.0)).rgb;
    s += texture(u_tex, v_uv + vec2(-t.x, -t.y)).rgb * 2.0;
    o = vec4(s / 12.0 + texture(u_add, v_uv).rgb, 1.0);
}`;

export const COMPOSITE_FS = `${HEAD}
${SRGB}
uniform sampler2D u_scene;
uniform sampler2D u_orig;    // the seed as it came in, for mixing back
uniform float u_mix;
uniform int u_toLinear;      // writing back into the compositor's linear frame
uniform sampler2D u_bloom;
uniform float u_glow;
uniform vec3 u_glowTint;
uniform float u_vignette;
uniform float u_grain;
uniform float u_aberration;
uniform float u_aspect;
uniform float u_frame;
uniform int u_hasBloom;
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
void main() {
    vec2 uv = v_uv;
    vec3 c;
    if (u_aberration > 0.0) {
        vec2 dir = (uv - 0.5) * u_aberration * 0.02;
        c = vec3(texture(u_scene, uv + dir).r, texture(u_scene, uv).g, texture(u_scene, uv - dir).b);
    } else {
        c = texture(u_scene, uv).rgb;
    }
    if (u_hasBloom == 1) c += texture(u_bloom, uv).rgb * u_glow * u_glowTint;
    if (u_vignette > 0.0) {
        vec2 q = (uv - 0.5) * vec2(u_aspect, 1.0) / max(u_aspect, 1.0);
        c *= mix(1.0, smoothstep(0.85, 0.15, length(q) * 1.2), u_vignette);
    }
    if (u_grain > 0.0) c += (hash(gl_FragCoord.xy + u_frame * 17.17) - 0.5) * u_grain * 0.35;
    c = clamp(c, 0.0, 1.0);
    if (u_mix < 1.0) c = mix(texture(u_orig, uv).rgb, c, max(u_mix, 0.0));
    if (u_toLinear == 1) c = toLinear(c);
    o = vec4(c, 1.0);
}`;
