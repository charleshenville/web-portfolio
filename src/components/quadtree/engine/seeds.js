// Seeds: what the quad tree subdivides. Each hands the renderer a frame
// description for a time, either something the renderer draws itself
//
//   { type: 'gradient', kind, stops, angle, spin, cycles, scale }
//   { type: 'shapes', shapes: Float32Array, colors: Float32Array, ... }
//
// or a picture to upload: { type: 'image', source, width, height }.
//
// `frame(t, ctx)` is the preview's (it may lag, a <video> plays on its own
// clock); `exact(t, ctx)` resolves to the picture for exactly that time, for
// exports. ctx = { phase, loop, outW, outH, playing, dt }. Everything is a
// function of time, so the preview can be scrubbed and loops are seamless:
// generated seeds turn a whole number of times per loop, the fluid is baked
// into a crossfaded loop, video and compositor seeds set the loop length.

import { Mp4FrameReader } from '../../../lib/mp4Frames';
import { clamp, makeRng } from '../../../lib/noise';
import {
    DEFAULTS as PROC_DEFAULTS, PerlinSource, FluidSource, gridDims,
    pixelPalette, pixelLevels, paintPixels, pixelLevelCount,
} from '../../../lib/procedural';

// ---- Generated -------------------------------------------------------------------

export function gradientFrame(s) {
    return {
        type: 'gradient',
        kind: s.gradType,
        stops: s.gradStops,
        angle: s.gradAngle,
        spin: Math.round(s.gradSpin),
        cycles: Math.round(s.gradCycles),
        scale: s.gradScale,
    };
}

function hsv(h, sat, v) {
    const f = (n) => {
        const k = (n + h * 6) % 6;
        return v - v * sat * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}

const hex3 = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const KINDS = ['circle', 'square', 'triangle', 'ring'];
const tri = (u) => 1 - Math.abs(1 - 2 * (u - Math.floor(u)));

/**
 * Shapes bouncing off the frame's edges. Each crosses the frame a whole
 * number of times per loop, so the loop closes.
 */
export function shapesFrame(s, phase, aspect, cache = {}) {
    const n = clamp(Math.round(s.shapeCount), 1, 64);
    const key = [n, s.shapeSeed, s.shapeSize, s.shapeSizeVar, s.shapeKind, s.shapeSpeed, s.shapeSpin, s.shapePalette, s.shapeSat, s.shapeStops.join()].join('|');
    if (cache.key !== key) {
        const rng = makeRng((s.shapeSeed | 0) * 7919 + 3);
        const r = () => rng.next();
        cache.key = key;
        cache.list = Array.from({ length: n }, (_, i) => {
            const rad = Math.max(0.005, s.shapeSize * 0.5 * (1 - s.shapeSizeVar * r()));
            const speed = Math.max(0, s.shapeSpeed);
            const kx = speed > 0 ? Math.max(1, Math.round(speed * (0.6 + 0.8 * r()))) : 0;
            const ky = speed > 0 ? Math.max(1, Math.round(speed * (0.6 + 0.8 * r()))) : 0;
            const kind = s.shapeKind === 'mixed' ? Math.floor(r() * 4) : Math.max(0, KINDS.indexOf(s.shapeKind));
            let col;
            if (s.shapePalette === 'stops' && s.shapeStops.length) col = hex3(s.shapeStops[Math.floor(r() * s.shapeStops.length) % s.shapeStops.length]);
            else col = hsv((i / n + r() * 0.25) % 1, s.shapeSat, 1);
            return {
                rad,
                kx: kx * (r() < 0.5 ? -1 : 1),
                ky: ky * (r() < 0.5 ? -1 : 1),
                u0: r(),
                v0: r(),
                rot0: r() * Math.PI * 2,
                spin: Math.round(s.shapeSpin) * (r() < 0.5 ? -1 : 1),
                kind,
                col,
            };
        });
        cache.shapes = new Float32Array(256);
        cache.colors = new Float32Array(256);
    }
    const { shapes, colors } = cache;
    // Speed scales the whole motion; whole numbers keep the loop seamless.
    phase *= s.shapeRate ?? 1;
    cache.list.forEach((sh, i) => {
        const x = sh.rad + Math.max(0, aspect - 2 * sh.rad) * tri(sh.u0 + sh.kx * phase);
        const y = sh.rad + Math.max(0, 1 - 2 * sh.rad) * tri(sh.v0 + sh.ky * phase);
        shapes.set([x, y, sh.rad, sh.rot0 + sh.spin * Math.PI * 2 * phase], i * 4);
        colors.set([...sh.col, sh.kind], i * 4);
    });
    return {
        type: 'shapes',
        count: n,
        shapes,
        colors,
        background: s.shapeBg,
        soft: s.shapeSoft,
        blend: s.shapeBlend,
    };
}

// ---- Pictures --------------------------------------------------------------------

export class ImageSeed {
    static async fromFile(file) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        return new ImageSeed(img, url, file.name);
    }

    constructor(img, url, name) {
        this.kind = 'image';
        this.name = name;
        this.url = url;
        this.width = img.naturalWidth;
        this.height = img.naturalHeight;
        this.img = img;
        this.duration = null;
    }

    frame() {
        return { type: 'image', source: this.img, width: this.width, height: this.height };
    }

    exact() { return this.frame(); }

    dispose() { URL.revokeObjectURL(this.url); }
}

export class VideoSeed {
    static async fromFile(file) {
        const url = URL.createObjectURL(file);
        const el = document.createElement('video');
        el.muted = true;
        el.loop = true;
        el.playsInline = true;
        el.preload = 'auto';
        el.crossOrigin = 'anonymous';
        el.src = url;
        await new Promise((res, rej) => {
            el.onloadeddata = res;
            el.onerror = () => rej(new Error(`Could not read ${file.name}`));
        });
        return new VideoSeed(el, url, file);
    }

    constructor(el, url, file) {
        this.kind = 'video';
        this.el = el;
        this.url = url;
        this.file = file;
        this.name = file.name;
        this.width = el.videoWidth;
        this.height = el.videoHeight;
        this.duration = el.duration || 1;
        this.onSeeked = null;
        el.addEventListener('seeked', () => this.onSeeked?.());
    }

    /** Follow the transport: play natively while it plays, seek while it doesn't. */
    sync(t, playing, rate) {
        const { el } = this;
        if (playing && rate > 0) {
            if (el.playbackRate !== rate) el.playbackRate = rate;
            if (el.paused) el.play().catch(() => {});
        } else {
            if (!el.paused) el.pause();
            if (Math.abs(el.currentTime - t) > 1 / 120 && !el.seeking) el.currentTime = t;
        }
    }

    /** While it plays the video is the clock. */
    get clock() { return this.el.paused ? null : this.el.currentTime; }

    frame() {
        if (this.el.readyState < 2) return null;
        return { type: 'image', source: this.el, width: this.width, height: this.height };
    }

    async openExact() {
        this.reader = await Mp4FrameReader.open(this.file);
        if (this.reader) {
            this.canvas = document.createElement('canvas');
            this.canvas.width = this.reader.width;
            this.canvas.height = this.reader.height;
            this.ctx = this.canvas.getContext('2d');
        }
    }

    async exact(t) {
        const r = this.reader;
        if (r) {
            const vf = await r.frameAt(Math.min(t, this.duration));
            if (vf) {
                r.draw(this.ctx, vf, this.canvas.width, this.canvas.height);
                return { type: 'image', source: this.canvas, width: this.canvas.width, height: this.canvas.height };
            }
        }
        // No decoder for this file: seek the element.
        const { el } = this;
        el.pause();
        await new Promise((res) => {
            if (Math.abs(el.currentTime - t) < 1 / 240 && el.readyState >= 2) { res(); return; }
            const tm = setTimeout(res, 2000);
            el.addEventListener('seeked', () => { clearTimeout(tm); res(); }, { once: true });
            el.currentTime = t;
        });
        return this.frame();
    }

    closeExact() {
        this.reader?.close();
        this.reader = null;
    }

    /** The file's sound, decoded, or null. */
    async audio() {
        try {
            const buf = await this.file.arrayBuffer();
            const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            const ctx = new AC(2, 44100, 44100);
            return await ctx.decodeAudioData(buf);
        } catch (e) {
            return null;
        }
    }

    dispose() {
        this.closeExact();
        this.el.pause();
        this.el.removeAttribute('src');
        this.el.load();
        URL.revokeObjectURL(this.url);
    }
}

// ---- Procedural (the Procedural Art tool's engine) -----------------------------

export const PROC_KEYS = Object.keys(PROC_DEFAULTS);

export const procSettings = (s, loop) => ({
    ...PROC_DEFAULTS,
    ...s.proc,
    style: 'pixels',
    loopDuration: loop,
});

const FLUID_FPS = 30;

export class ProceduralSeed {
    constructor() {
        this.kind = 'procedural';
        this.perlin = new PerlinSource();
        this.cache = {};
        this.buf = new Float32Array(0);
        this.drawnKey = '';
        this.bake = null;
        this.duration = null;
    }

    dims(ps, outW, outH, res) {
        const cols = clamp(Math.round(res), 16, 640);
        return gridDims(outW, outH, { ...ps, style: 'pixels', pixelSize: outW / cols });
    }

    paint(field, ps, dims) {
        const L = pixelLevelCount(ps);
        const key = [L, ps.colorMode, ps.background, ps.foreground, ps.stops.join(), ps.reverseGradient].join('|');
        if (key !== this.paletteKey) {
            this.paletteKey = key;
            this.palette = pixelPalette(ps, L);
        }
        const canvas = paintPixels(this.cache, pixelLevels(field, ps, dims.cols, dims.rows, L), this.palette.rgba, dims.cols, dims.rows);
        return { type: 'image', source: canvas, width: dims.cols, height: dims.rows, smooth: true };
    }

    /** Fluid: bake one loop, a slice at a time. Returns the fraction done. */
    stepBake(ps, dims, loop) {
        const key = [ps.seed, ps.grid, ps.simSpeed, ps.viscosity, ps.drag, ps.force, ps.forceK, ps.forceTau, ps.cfl, ps.warmup,
            ps.render, ps.particles, ps.fade, ps.respawn, ps.supersample, ps.exposure, ps.flowScale, ps.flowScaleX, ps.flowScaleY,
            dims.cols, dims.rows, loop].join('|');
        if (!this.bake || this.bake.key !== key) {
            const fluid = new FluidSource({ historyBytes: 0 });
            fluid.sync(ps, dims);
            const n = Math.max(2, Math.round(loop * FLUID_FPS));
            const blend = Math.min(Math.round(FLUID_FPS * 1), Math.floor(n / 2));
            this.bake = {
                key, fluid, n, blend, i: 0, frames: new Array(n), head: [], cells: dims.cols * dims.rows, dims,
            };
        }
        const B = this.bake;
        if (B.i >= B.n + B.blend) return 1;
        const start = performance.now();
        const { fluid } = B;
        while (performance.now() - start < 12) {
            if (fluid.warmupLeft > 0) {
                const chunk = Math.min(fluid.warmupLeft, ps.simSpeed / 24);
                fluid.stepSim(chunk, ps, false);
                fluid.warmupLeft -= chunk;
                continue;
            }
            if (B.i >= B.n + B.blend) break;
            fluid.simulateFrame(1 / FLUID_FPS, ps);
            const f = Float32Array.from(fluid.getField(ps));
            if (B.i < B.blend) {
                B.head.push(f);
            } else {
                const k = B.i - B.n;
                if (k >= 0) {
                    const a = (k + 1) / (B.blend + 1);
                    const h = B.head[k];
                    for (let j = 0; j < f.length; j++) f[j] = (1 - a) * f[j] + a * h[j];
                }
                B.frames[B.i - B.blend] = f;
            }
            B.i++;
        }
        return Math.min(1, B.i / (B.n + B.blend));
    }

    get baking() {
        return this.bake && this.bake.i < this.bake.n + this.bake.blend ? this.bake.i / (this.bake.n + this.bake.blend) : 0;
    }

    fieldAt(t, ctx, s) {
        const ps = procSettings(s, ctx.loop);
        const dims = this.dims(ps, ctx.outW, ctx.outH, s.procRes);
        if (ps.mode === 'fluid') {
            this.stepBake(ps, dims, ctx.loop);
            const B = this.bake;
            const done = Math.max(0, B.i - B.blend);
            if (!done) return { field: null, ps, dims };
            const idx = Math.floor((((t % ctx.loop) + ctx.loop) % ctx.loop) * FLUID_FPS) % B.n;
            return { field: B.frames[Math.min(idx, done - 1)], ps, dims };
        }
        this.perlin.sync(ps, dims);
        if (this.buf.length !== dims.cols * dims.rows) this.buf = new Float32Array(dims.cols * dims.rows);
        const key = `${PerlinSource.noiseKey(ps)}|${t}|${dims.cols}|${dims.rows}`;
        if (key !== this.fieldKey) {
            this.fieldKey = key;
            this.perlin.fieldAt(this.buf, ((t % ctx.loop) + ctx.loop) % ctx.loop, ps);
        }
        return { field: this.buf, ps, dims };
    }

    frame(t, ctx, s) {
        const { field, ps, dims } = this.fieldAt(t, ctx, s);
        if (!field) return null;
        return this.paint(field, ps, dims);
    }

    /** Exports wait for the fluid bake to finish. */
    async exact(t, ctx, s) {
        const ps = procSettings(s, ctx.loop);
        if (ps.mode === 'fluid') {
            const dims = this.dims(ps, ctx.outW, ctx.outH, s.procRes);
            // eslint-disable-next-line no-await-in-loop
            while (this.stepBake(ps, dims, ctx.loop) < 1) await new Promise((r) => setTimeout(r, 0));
        }
        return this.frame(t, ctx, s);
    }

    dispose() { this.bake = null; }
}
