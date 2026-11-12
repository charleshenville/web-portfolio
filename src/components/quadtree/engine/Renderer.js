// The Quad Trees renderer: one WebGL2 context per canvas (the preview has
// one, an export makes its own), no React.
//
// A frame goes:
//   seed      the picture to subdivide, at the target size: a generated
//             gradient or shapes (shaders here), or an uploaded picture
//             (image, video, procedural field, compositor render) fitted in
//   grade     colour grade, optional blur, then mipmapped
//   analysis  the graded seed at a small fixed size, noise map in alpha,
//             read back for the tree (engine/tree)
//   scene     background, the seed as an underlay, the quads (instanced:
//             squares / circles / glyphs, with outlines)
//   post      glow, aberration, vignette, grain, into the canvas
//
// Sizes: the tree is laid out in output pixels; `k` (target px per output
// px) scales gaps and outlines, so an export at 2x looks like the preview.

import {
    FULL_VS, BLIT_FS, GRADIENT_FS, SHAPES_FS, GRADE_FS, BLUR_FS, ANALYSIS_FS,
    QUAD_VS, QUAD_FS, UNDERLAY_FS, BRIGHT_FS, DOWN_FS, UP_FS, COMPOSITE_FS,
} from './shaders';
import { hexToRgb } from '../../../lib/procedural';
import { STRIDE } from './tree';
import { makeSdfTools, SDF_RADIUS, SDF_CUTOFF } from './sdf';
import { glyphFont } from '../fonts';

const MAX_SEED = 2560;
const GRADIENT_TYPES = {
    linear: 0, radial: 1, conic: 2, corners: 3, waves: 4,
};
const OUTLINE_MODES = { solid: 0, cell: 1, shade: 2 };
const SHAPES = {
    square: 0, circle: 1, mixed: 2, ascii: 3,
};
const FITS = { cover: 0, contain: 1, stretch: 2 };

const rgb = (hex) => hexToRgb(hex).map((v) => v / 255);

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        if (gl.isContextLost()) throw new Error('The browser dropped the WebGL context (too many open at once). Reload the page.');
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`Shader: ${log}`);
    }
    return sh;
}

function program(gl, vs, fs) {
    const p = gl.createProgram();
    const v = compile(gl, gl.VERTEX_SHADER, vs);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link: ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const name = info.name.replace(/\[0\]$/, '');
        uniforms[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms };
}

// Programs are per context: renderers sharing one (the compositor's) share them.
const PROGRAMS = new WeakMap();

function programsFor(gl) {
    let progs = PROGRAMS.get(gl);
    if (progs) return progs;
    const P = (fs) => program(gl, FULL_VS, fs);
    progs = {
        blit: P(BLIT_FS),
        gradient: P(GRADIENT_FS),
        shapes: P(SHAPES_FS),
        grade: P(GRADE_FS),
        blur: P(BLUR_FS),
        analysis: P(ANALYSIS_FS),
        underlay: P(UNDERLAY_FS),
        bright: P(BRIGHT_FS),
        down: P(DOWN_FS),
        up: P(UP_FS),
        composite: P(COMPOSITE_FS),
        quad: program(gl, QUAD_VS, QUAD_FS),
    };
    PROGRAMS.set(gl, progs);
    return progs;
}

export default class Renderer {
    /**
     * `target` is a canvas (the tool: its own context) or a WebGL2 context
     * to borrow (the compositor's, through engine/threeFx). A borrowed
     * context is left as found only in the sense that the caller resets its
     * own state tracking afterwards (three's resetState).
     */
    constructor(target, { preserve = false } = {}) {
        let gl;
        if (typeof WebGL2RenderingContext !== 'undefined' && target instanceof WebGL2RenderingContext) {
            gl = target;
            this.canvas = null;
            this.shared = true;
        } else {
            this.canvas = target;
            gl = target.getContext('webgl2', {
                antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: preserve,
            });
            if (!gl) throw new Error('Quad Trees needs WebGL2.');
            this.shared = false;
            target.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
        }
        this.gl = gl;
        this.lost = false;
        this.progs = programsFor(gl);
        this.vao = gl.createVertexArray();
        this.quadVao = gl.createVertexArray();
        this.instances = gl.createBuffer();
        gl.bindVertexArray(this.quadVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
        const bytes = STRIDE * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, bytes, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, bytes, 12);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, bytes, 28);
        gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);

        this.srcTex = this.texture();
        this.targets = {};
        this.atlas = null;
        this.atlasKey = '';
        this.readBuf = null;
        this.w = 1;
        this.h = 1;
    }

    texture(mips = false) {
        const { gl } = this;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    /** A render target by name, (re)made at w x h. */
    target(name, w, h, mips = false) {
        const { gl } = this;
        w = Math.max(1, Math.round(w));
        h = Math.max(1, Math.round(h));
        let t = this.targets[name];
        if (t && t.w === w && t.h === h) return t;
        if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
        const tex = this.texture(mips);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        if (mips) gl.generateMipmap(gl.TEXTURE_2D);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        // Leave nothing bound: a target's texture left on a unit some
        // sampler reads would be a feedback loop when drawing into it.
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        t = {
            tex, fb, w, h, mips,
        };
        this.targets[name] = t;
        return t;
    }

    /** Drawing buffer size of the canvas (or of the output, when borrowed). */
    setSize(w, h) {
        w = Math.max(2, Math.round(w));
        h = Math.max(2, Math.round(h));
        if (this.canvas) {
            if (this.canvas.width !== w) this.canvas.width = w;
            if (this.canvas.height !== h) this.canvas.height = h;
        }
        this.w = w;
        this.h = h;
    }

    /** On a borrowed context: the fixed-function state these passes assume. */
    prepareState() {
        const { gl } = this;
        [gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.BLEND, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE].forEach((c) => gl.disable(c));
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    pass(prog, target, uniforms = {}, textures = []) {
        const { gl } = this;
        const pr = this.progs[prog];
        gl.useProgram(pr.p);
        if (target) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
            gl.viewport(0, 0, target.w, target.h);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.w, this.h);
        }
        textures.forEach(([name, tex], i) => {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            if (pr.u[name]) gl.uniform1i(pr.u[name], i);
        });
        this.setUniforms(pr, uniforms);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    setUniforms(pr, uniforms) {
        const { gl } = this;
        Object.entries(uniforms).forEach(([k, v]) => {
            const loc = pr.u[k];
            if (loc == null) return;
            if (v && v.int !== undefined) gl.uniform1i(loc, v.int);
            else if (v && v.uint !== undefined) gl.uniform1ui(loc, v.uint);
            else if (v && v.v4) gl.uniform4fv(loc, v.v4);
            else if (v && v.v3) gl.uniform3fv(loc, v.v3);
            else if (typeof v === 'number') gl.uniform1f(loc, v);
            else if (v.length === 2) gl.uniform2fv(loc, v);
            else if (v.length === 3) gl.uniform3fv(loc, v);
            else if (v.length === 4) gl.uniform4fv(loc, v);
        });
    }

    // ---- Seed --------------------------------------------------------------------

    /** Seed size for a frame of outW x outH drawn at w x h. */
    seedSize(outW, outH) {
        const scale = Math.min(1, MAX_SEED / Math.max(this.w, this.h));
        const aspect = outW / outH;
        let w = this.w * scale;
        let h = w / aspect;
        if (Math.abs(h - this.h * scale) > 2) h = this.h * scale;
        return [Math.max(8, Math.round(w)), Math.max(8, Math.round(h))];
    }

    /**
     * Draw the seed into 'seed'. `frame`: { type: 'gradient' | 'shapes' |
     * 'image', ... } (seeds.js), `s` the settings.
     */
    drawSeed(frame, s, outW, outH, phase) {
        const { gl } = this;
        const [w, h] = this.seedSize(outW, outH);
        const T = this.target('seed', w, h);
        const aspect = outW / outH;
        if (!frame || frame.type === 'blank') {
            gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
            gl.viewport(0, 0, w, h);
            const [r, g, b] = rgb(s.background);
            gl.clearColor(r, g, b, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return T;
        }
        if (frame.type === 'gradient') {
            const stops = new Float32Array(24);
            const list = frame.stops.slice(0, 8);
            list.forEach((hex, i) => stops.set(rgb(hex), i * 3));
            this.pass('gradient', T, {
                u_stops: { v3: stops },
                u_nStops: { int: list.length },
                u_type: { int: GRADIENT_TYPES[frame.kind] ?? 4 },
                u_phase: phase,
                u_aspect: aspect,
                u_angle: (frame.angle * Math.PI) / 180,
                u_spin: frame.spin,
                u_cycles: frame.cycles,
                u_scale: frame.scale,
            });
            return T;
        }
        if (frame.type === 'shapes') {
            const n = Math.min(64, frame.count ?? frame.shapes.length / 4);
            this.pass('shapes', T, {
                u_shape: { v4: frame.shapes.subarray(0, 256) },
                u_color: { v4: frame.colors.subarray(0, 256) },
                u_count: { int: n },
                u_bg: rgb(frame.background),
                u_aspect: aspect,
                u_soft: frame.soft,
                u_blend: { int: frame.blend === 'add' ? 1 : frame.blend === 'screen' ? 2 : 0 },
                u_px: 1.5 / h,
            });
            return T;
        }
        if (frame.type === 'texture') {
            // A texture already in this context (the compositor's frame):
            // the part `uv` covers, stretched to the frame, linear in.
            this.pass('blit', T, {
                u_srcAspect: aspect,
                u_dstAspect: aspect,
                u_fit: { int: 2 },
                u_bg: rgb(s.background),
                u_zoom: 1,
                u_uvRect: frame.uv || [0, 0, 1, 1],
                u_flipV: { int: 0 },
                u_toSrgb: { int: frame.linear ? 1 : 0 },
            }, [['u_tex', frame.tex]]);
            return T;
        }
        // A picture.
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
        } catch (e) {
            return this.drawSeed({ type: 'blank' }, s, outW, outH, phase);
        }
        this.pass('blit', T, {
            u_srcAspect: frame.width / Math.max(1, frame.height),
            u_dstAspect: aspect,
            u_fit: { int: FITS[s.fit] ?? 0 },
            u_bg: rgb(s.background),
            u_zoom: s.seedZoom || 1,
            u_uvRect: [0, 0, 1, 1],
            u_flipV: { int: 1 },
            u_toSrgb: { int: 0 },
        }, [['u_tex', this.srcTex]]);
        return T;
    }

    /** Grade (and blur) the seed into 'graded', mipmapped. */
    grade(s, outH) {
        const { gl } = this;
        const seed = this.targets.seed;
        const G = this.target('graded', seed.w, seed.h, true);
        this.pass('grade', G, {
            u_exposure: s.exposure,
            u_contrast: s.contrast,
            u_saturation: s.saturation,
            u_temperature: s.temperature,
            u_tint: s.tint,
            u_hue: (s.hue * Math.PI) / 180,
            u_gamma: s.gamma,
            u_lift: s.lift,
            u_gain: s.gain,
            u_invert: s.invert ? 1 : 0,
            u_posterize: s.posterize || 0,
        }, [['u_tex', seed.tex]]);
        let out = G;
        // Blur: a fraction of the frame height, done on a smaller copy when wide.
        const radius = (s.blur || 0) * seed.h;
        if (radius >= 0.5) {
            const ds = Math.max(1, Math.min(8, Math.floor(radius / 8)));
            // The smaller copy reads the graded picture minified: its mips first.
            if (ds > 1) {
                gl.bindTexture(gl.TEXTURE_2D, G.tex);
                gl.generateMipmap(gl.TEXTURE_2D);
            }
            const bw = seed.w / ds;
            const bh = seed.h / ds;
            const A = this.target('blurA', bw, bh);
            const B = this.target('blurB', bw, bh, true);
            const r = radius / ds;
            this.pass('blur', A, { u_dir: [r / 12 / A.w, 0] }, [['u_tex', G.tex]]);
            this.pass('blur', B, { u_dir: [0, r / 12 / B.h] }, [['u_tex', A.tex]]);
            out = B;
        }
        gl.bindTexture(gl.TEXTURE_2D, out.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        this.gradedOut = out;
        return out;
    }

    /** The analysis image as RGBA bytes (bottom row first): { px, w, h }. */
    analyse(s, outW, outH, phase) {
        const { gl } = this;
        const res = Math.max(32, Math.round(s.analysisRes));
        const aspect = outW / outH;
        const w = aspect >= 1 ? res : Math.max(8, Math.round(res * aspect));
        const h = aspect >= 1 ? Math.max(8, Math.round(res / aspect)) : res;
        const A = this.target('analysis', w, h);
        this.pass('analysis', A, {
            u_noise: { int: s.metric === 'noise' ? 1 : 0 },
            u_aspect: aspect,
            u_phase: phase,
            u_scale: s.noiseScale,
            u_octaves: { int: Math.max(1, Math.round(s.noiseOctaves)) },
            u_evolve: { int: Math.max(1, Math.round(s.noiseEvolve)) },
            u_contrast: s.noiseContrast,
            u_warp: s.noiseWarp,
            u_seed: { uint: (s.noiseSeed >>> 0) % 100000 },
        }, [['u_tex', this.gradedOut.tex]]);
        if (!this.readBuf || this.readBuf.length !== w * h * 4) this.readBuf = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf);
        return { px: this.readBuf, w, h };
    }

    // ---- Quads ---------------------------------------------------------------------

    /**
     * The ramp's glyphs in the chosen font. A web font still loading draws
     * in a fallback; the atlas is rebuilt once it lands (`onAtlasReady`
     * lets the owner redraw).
     */
    glyphAtlas(ramp, s) {
        const chars = Array.from(ramp || ' ');
        const probe = glyphFont(s, 100);
        const key = `${chars.join('')}|${probe}`;
        if (this.atlas && key === this.atlasKey) return this.atlas;
        if (document.fonts?.load && !document.fonts.check(probe, chars.join(''))) {
            this.fontsLoading = this.fontsLoading || new Set();
            if (!this.fontsLoading.has(probe)) {
                this.fontsLoading.add(probe);
                document.fonts.load(probe, chars.join('')).then(() => {
                    this.atlasKey = '';
                    this.onAtlasReady?.();
                }).catch(() => {});
            }
        }
        const { gl } = this;
        const grid = Math.max(1, Math.ceil(Math.sqrt(chars.length)));
        // Each cell holds the glyph twice: its coverage in alpha (mipmapped,
        // for glyphs drawn smaller than the cell) and its distance field in
        // red (for anything larger, so edges stay exact however big).
        // Short ramps (the usual) get finer fields; long ones stay compact.
        const cell = chars.length <= 16 ? 256 : chars.length <= 36 ? 192 : 160;
        const c = document.createElement('canvas');
        c.width = grid * cell;
        c.height = grid * cell;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // One size for the whole ramp: 0.95 of the cell, smaller if any of
        // its glyphs in this font would spill out of the cell, and the
        // ramp's ink centred, so glyphs line up like characters on a line.
        let fontPx = Math.round(cell * 0.95);
        ctx.font = glyphFont(s, fontPx);
        let up = cell * 0.46;
        let down = cell * 0.38;
        const ink = chars.filter((ch) => ch.trim()).map((ch) => ctx.measureText(ch));
        if (ink.length && Number.isFinite(ink[0].actualBoundingBoxAscent)) {
            const wide = Math.max(...ink.map((m) => (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0)));
            up = Math.max(...ink.map((m) => m.actualBoundingBoxAscent || 0));
            down = Math.max(...ink.map((m) => m.actualBoundingBoxDescent || 0));
            const fit = Math.min(1, (cell * 0.92) / Math.max(1, wide), (cell * 0.92) / Math.max(1, up + down));
            if (fit < 1) {
                fontPx = Math.max(1, Math.floor(fontPx * fit));
                ctx.font = glyphFont(s, fontPx);
                up *= fit;
                down *= fit;
            }
        }
        const dy = (up - down) / 2;
        chars.forEach((ch, i) => {
            const x = (i % grid) * cell + cell / 2;
            const y = Math.floor(i / grid) * cell + cell / 2 + dy;
            ctx.fillText(ch, x, y);
        });
        const W = c.width;
        const img = ctx.getImageData(0, 0, W, c.height).data;
        const px = new Uint8Array(img.length);
        const sdf = makeSdfTools(cell);
        const cov = new Uint8Array(cell * cell);
        const dist = new Uint8Array(cell * cell);
        for (let gy = 0; gy < grid; gy++) {
            for (let gx = 0; gx < grid; gx++) {
                for (let y = 0; y < cell; y++) {
                    for (let x = 0; x < cell; x++) cov[y * cell + x] = img[((gy * cell + y) * W + gx * cell + x) * 4 + 3];
                }
                sdf(cov, dist);
                for (let y = 0; y < cell; y++) {
                    for (let x = 0; x < cell; x++) {
                        const o = ((gy * cell + y) * W + gx * cell + x) * 4;
                        const d = dist[y * cell + x];
                        px[o] = d;
                        px[o + 1] = d;
                        px[o + 2] = d;
                        px[o + 3] = cov[y * cell + x];
                    }
                }
            }
        }
        if (!this.atlas) this.atlas = { tex: this.texture(true) };
        gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex);
        // Rows go up top first, and the shader reads v down the canvas.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.generateMipmap(gl.TEXTURE_2D);
        this.atlas.grid = grid;
        this.atlas.cell = cell;
        this.atlas.count = chars.length;
        this.atlasKey = key;
        return this.atlas;
    }

    /** Background, underlay and quads into 'scene' at the canvas size. */
    drawScene(tree, s, outW, outH) {
        const { gl } = this;
        const S = this.target('scene', this.w, this.h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb);
        gl.viewport(0, 0, S.w, S.h);
        const [br, bg, bb] = rgb(s.background);
        gl.clearColor(br, bg, bb, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (s.underlay > 0 && this.gradedOut) {
            this.pass('underlay', S, { u_opacity: s.underlay }, [['u_tex', this.gradedOut.tex]]);
        }
        if (tree && tree.count && s.quadOpacity > 0) {
            const pr = this.progs.quad;
            gl.useProgram(pr.p);
            const k = S.w / outW;
            const crisp = s.shape === 'square' && s.radius <= 0 && s.gap <= 0 && Math.abs(s.size - 1) < 1e-3 && s.halftone <= 0;
            let atlas = null;
            if (s.shape === 'ascii') atlas = this.glyphAtlas(s.ramp, s);
            this.setUniforms(pr, {
                u_res: [S.w, S.h],
                u_k: k,
                u_gap: s.gap,
                u_size: s.size,
                u_halftone: s.halftone,
                u_htInvert: { int: s.halftoneInvert ? 1 : 0 },
                u_shape: { int: SHAPES[s.shape] ?? 0 },
                u_mix: s.mixRatio,
                u_outline: s.outline,
                u_crisp: { int: crisp ? 1 : 0 },
                u_radius: s.radius,
                u_outlineColor: rgb(s.outlineColor),
                u_outlineMode: { int: OUTLINE_MODES[s.outlineMode] ?? 0 },
                u_fill: { int: s.fill ? 1 : 0 },
                u_opacity: s.quadOpacity,
                u_glyphs: atlas ? atlas.count : 1,
                u_grid: atlas ? atlas.grid : 1,
                u_glyphBg: s.glyphBg,
                u_cellPx: atlas ? atlas.cell : 1,
                u_rampBy: { int: s.rampBy === 'depth' ? 2 : s.rampBy === 'size' ? 1 : 0 },
                u_maxDepth: Math.max(0, Math.round(s.maxDepth)),
                u_sdf: [SDF_RADIUS, SDF_CUTOFF],
                u_rampInvert: { int: s.rampInvert ? 1 : 0 },
            });
            // Always set the atlas unit: whatever was left there (the scene
            // target's own texture, after a resize) would be a feedback loop.
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, atlas ? atlas.tex : null);
            if (pr.u.u_atlas) gl.uniform1i(pr.u.u_atlas, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
            gl.bufferData(gl.ARRAY_BUFFER, tree.data.subarray(0, tree.count * STRIDE), gl.DYNAMIC_DRAW);
            gl.bindVertexArray(this.quadVao);
            // Tiled squares with an outline: fills first, then the edges as
            // their own layer, each shared edge painted once.
            const edges = crisp && s.outline > 0;
            if (!edges || s.fill) {
                this.setUniforms(pr, { u_pass: { int: 0 } });
                gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, tree.count);
            }
            if (edges) {
                this.setUniforms(pr, { u_pass: { int: 1 }, u_lineW: Math.max(1, Math.round(s.outline * k)) });
                gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, tree.count);
            }
            gl.bindVertexArray(null);
        }
        gl.disable(gl.BLEND);
        return S;
    }

    /** Glow pyramid from 'scene'; returns the summed texture or null. */
    bloom(s) {
        if (!(s.glow > 0)) return null;
        const S = this.targets.scene;
        const levels = Math.max(2, Math.min(8, Math.round(2 + s.glowRadius * 6)));
        let w = S.w / 2;
        let h = S.h / 2;
        const downs = [];
        const B0 = this.target('bloomD0', w, h);
        this.pass('bright', B0, { u_threshold: s.glowThreshold, u_texel: [1 / S.w, 1 / S.h] }, [['u_tex', S.tex]]);
        downs.push(B0);
        for (let i = 1; i < levels; i++) {
            w = Math.max(1, w / 2);
            h = Math.max(1, h / 2);
            const D = this.target(`bloomD${i}`, w, h);
            const prev = downs[i - 1];
            this.pass('down', D, { u_texel: [1 / prev.w, 1 / prev.h] }, [['u_tex', prev.tex]]);
            downs.push(D);
        }
        let up = downs[levels - 1];
        for (let i = levels - 2; i >= 0; i--) {
            const U = this.target(`bloomU${i}`, downs[i].w, downs[i].h);
            this.pass('up', U, { u_texel: [1 / up.w, 1 / up.h], u_spread: 1 }, [['u_tex', up.tex], ['u_add', downs[i].tex]]);
            up = U;
        }
        this.bloomLevels = levels;
        return up;
    }

    /**
     * Post, into the canvas, or into `dest` ({ fb, w, h, linear }) when
     * borrowed. `s.mix` below 1 blends back toward the seed as it came in.
     */
    composite(s, frameIndex, dest = null) {
        const S = this.targets.scene;
        const B = this.bloom(s);
        const seed = this.targets.seed;
        this.pass('composite', dest, {
            u_mix: s.mix ?? 1,
            u_toLinear: { int: dest?.linear ? 1 : 0 },
            // The pyramid sums every level; keep strength independent of radius.
            // Off, the levels stack up into a blown-out glow.
            u_glow: B ? (s.glowNormalize === false ? s.glow : (s.glow * 2) / this.bloomLevels) : 0,
            u_glowTint: rgb(s.glowTint),
            u_vignette: s.vignette,
            u_grain: s.grain,
            u_aberration: s.aberration,
            u_aspect: S.w / S.h,
            u_frame: frameIndex % 9973,
            u_hasBloom: { int: B ? 1 : 0 },
        }, [['u_scene', S.tex], ['u_bloom', (B || S).tex], ['u_orig', (seed || S).tex]]);
    }

    dispose() {
        const { gl } = this;
        Object.values(this.targets).forEach((t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); });
        gl.deleteTexture(this.srcTex);
        if (this.atlas) gl.deleteTexture(this.atlas.tex);
        gl.deleteBuffer(this.instances);
        gl.deleteVertexArray(this.vao);
        gl.deleteVertexArray(this.quadVao);
        this.targets = {};
        // A borrowed context, and the programs in it, belong to its owner.
        if (this.shared) return;
        Object.values(this.progs).forEach((p) => gl.deleteProgram(p.p));
        PROGRAMS.delete(gl);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
}
