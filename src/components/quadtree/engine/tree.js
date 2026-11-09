// The quad tree itself: plain arrays, no WebGL, no React.
//
// The renderer reads the graded seed back at a small fixed size (the
// analysis image: RGB plus the noise map in alpha). From it this builds
// summed-area tables, so the mean and variance of any rectangle cost four
// lookups however big it is, and subdividing a frame into tens of thousands
// of quads stays a few milliseconds.
//
// Quads are laid out in output pixels (the export size), never in screen
// pixels, so a tree is the same in the preview and in an export of any
// scale. Each leaf is written to a flat Float32Array the renderer uploads as
// instance data, and the SVG export reads as is:
//
//   x, y, size, r, g, b, luma, hash, kind      (kind: 0, reserved)

import { hexToRgb } from '../../../lib/procedural';

export const STRIDE = 9;
export const MAX_QUADS = 250000;

const LUMA = [0.2126, 0.7152, 0.0722];

// What the split test measures: 0 colour (the three channels' spread,
// averaged), 1 brightness, 2 the noise map, 3-5 one of red, green, blue.
const METRIC_CODE = {
    color: 0, luma: 1, noise: 2, r: 3, g: 4, b: 5,
};

// ---- Summed-area tables -------------------------------------------------------

export class Analysis {
    constructor() {
        this.w = 0;
        this.h = 0;
    }

    /**
     * Rebuild from RGBA bytes as gl.readPixels returns them (bottom row
     * first) for `metric`. One pass; the tables are (w+1) x (h+1).
     */
    update(px, w, h, metric) {
        const W = w + 1;
        const size = W * (h + 1);
        if (w !== this.w || h !== this.h) {
            this.w = w;
            this.h = h;
            this.sr = new Float64Array(size);
            this.sg = new Float64Array(size);
            this.sb = new Float64Array(size);
            this.sm = new Float64Array(size);
            this.q0 = new Float64Array(size);
            this.q1 = new Float64Array(size);
            this.q2 = new Float64Array(size);
        }
        const code = METRIC_CODE[metric] ?? 0;
        this.code = code;
        const {
            sr, sg, sb, sm, q0, q1, q2,
        } = this;
        const inv = 1 / 255;
        const lr = LUMA[0] * inv;
        const lg = LUMA[1] * inv;
        const lb = LUMA[2] * inv;
        const ch = code - 3;
        for (let y = 0; y < h; y++) {
            // Analysis row y (top first) is readback row h-1-y.
            let p = (h - 1 - y) * w * 4;
            let i = (y + 1) * W + 1;
            let j = y * W + 1;
            let ar = 0;
            let ag = 0;
            let ab = 0;
            let am = 0;
            let a0 = 0;
            let a1 = 0;
            let a2 = 0;
            for (let x = 0; x < w; x++, p += 4, i++, j++) {
                const R = px[p];
                const G = px[p + 1];
                const B = px[p + 2];
                const r = R * inv;
                const g = G * inv;
                const b = B * inv;
                ar += r;
                ag += g;
                ab += b;
                sr[i] = sr[j] + ar;
                sg[i] = sg[j] + ag;
                sb[i] = sb[j] + ab;
                if (code === 0) {
                    a0 += r * r;
                    a1 += g * g;
                    a2 += b * b;
                    q0[i] = q0[j] + a0;
                    q1[i] = q1[j] + a1;
                    q2[i] = q2[j] + a2;
                } else {
                    let v;
                    if (code === 1) v = R * lr + G * lg + B * lb;
                    else if (code === 2) v = px[p + 3] * inv;
                    else v = px[p + ch] * inv;
                    am += v;
                    a0 += v * v;
                    sm[i] = sm[j] + am;
                    q0[i] = q0[j] + a0;
                }
            }
        }
    }

    /**
     * Mean colour and standard deviation of the metric over analysis pixels
     * [x0, x1) x [y0, y1). Writes into `out` = [r, g, b, std].
     */
    stats(x0, y0, x1, y1, out) {
        const W = this.w + 1;
        const a = y0 * W + x0;
        const b = y0 * W + x1;
        const c = y1 * W + x0;
        const d = y1 * W + x1;
        const inv = 1 / ((x1 - x0) * (y1 - y0));
        const { sr, sg, sb } = this;
        const mr = (sr[d] - sr[b] - sr[c] + sr[a]) * inv;
        const mg = (sg[d] - sg[b] - sg[c] + sg[a]) * inv;
        const mb = (sb[d] - sb[b] - sb[c] + sb[a]) * inv;
        out[0] = mr;
        out[1] = mg;
        out[2] = mb;
        const { q0 } = this;
        if (this.code === 0) {
            const { q1, q2 } = this;
            const vr = (q0[d] - q0[b] - q0[c] + q0[a]) * inv - mr * mr;
            const vg = (q1[d] - q1[b] - q1[c] + q1[a]) * inv - mg * mg;
            const vb = (q2[d] - q2[b] - q2[c] + q2[a]) * inv - mb * mb;
            out[3] = Math.sqrt(Math.max(0, (vr + vg + vb) / 3));
        } else {
            const { sm } = this;
            const m = (sm[d] - sm[b] - sm[c] + sm[a]) * inv;
            out[3] = Math.sqrt(Math.max(0, (q0[d] - q0[b] - q0[c] + q0[a]) * inv - m * m));
        }
        return out;
    }
}

// ---- Colour ------------------------------------------------------------------

/** A lookup of `n` colours along `stops` (hex), as floats 0-1. */
export function rampTable(stops, n = 256) {
    const rgb = (stops && stops.length ? stops : ['#000000', '#ffffff']).map((h) => hexToRgb(h).map((v) => v / 255));
    if (rgb.length === 1) rgb.push(rgb[0]);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        const pos = t * (rgb.length - 1);
        const k = Math.min(rgb.length - 2, Math.floor(pos));
        const f = pos - k;
        for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f;
    }
    return out;
}

const hash2 = (x, y, s) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
};

// ---- Building -------------------------------------------------------------------

/** Root cells: square, `cols` across the output, centred vertically. */
export function rootGrid(outW, outH, cols) {
    const n = Math.max(1, Math.round(cols));
    const size = outW / n;
    const rows = Math.max(1, Math.ceil(outH / size - 1e-6));
    const y0 = (outH - rows * size) / 2;
    const cells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < n; c++) cells.push([c * size, y0 + r * size, size, c, r]);
    }
    return cells;
}

/**
 * Build the leaves for one frame. `s` is the settings, `phase` 0-1 through
 * the loop. Returns { data, count, capped }; `data` is reused between calls
 * through `scratch`.
 */
export function buildTree(an, s, outW, outH, phase, scratch = {}) {
    if (!scratch.data) scratch.data = new Float32Array(MAX_QUADS * STRIDE);
    const data = scratch.data;
    const kx = an.w / outW;
    const ky = an.h / outH;
    const st = [0, 0, 0, 0];
    let count = 0;
    let capped = false;

    const maxDepth = Math.max(0, Math.round(s.maxDepth));
    const minDepth = Math.max(0, Math.min(maxDepth, Math.round(s.minDepth)));
    const minSize = Math.max(0.5, s.minSize);
    const thr = Math.max(0, s.threshold);
    const falloff = s.falloff > 0 ? s.falloff : 1;

    // Colour of a cell, by the colour source.
    const levels = Math.round(s.levels) || 0;
    const ramp = s.colorSource === 'seed' ? null : (scratch.rampKey === s.stops.join() ? scratch.ramp : null) || (() => {
        scratch.rampKey = s.stops.join();
        scratch.ramp = rampTable(s.stops, 256);
        return scratch.ramp;
    })();
    const quant = (v) => {
        if (levels < 2) return v;
        const q = Math.round(v * (levels - 1)) / (levels - 1);
        return q;
    };

    const emit = (x, y, size, depth, kind) => {
        if (count >= MAX_QUADS) { capped = true; return; }
        // Clip to the frame for the statistics; skip what is wholly outside.
        const cx0 = Math.max(0, x);
        const cy0 = Math.max(0, y);
        const cx1 = Math.min(outW, x + size);
        const cy1 = Math.min(outH, y + size);
        if (cx1 <= cx0 || cy1 <= cy0) return;
        const ax0 = Math.min(an.w - 1, Math.floor(cx0 * kx));
        const ay0 = Math.min(an.h - 1, Math.floor(cy0 * ky));
        const ax1 = Math.max(ax0 + 1, Math.min(an.w, Math.ceil(cx1 * kx)));
        const ay1 = Math.max(ay0 + 1, Math.min(an.h, Math.ceil(cy1 * ky)));
        an.stats(ax0, ay0, ax1, ay1, st);
        let r = st[0];
        let g = st[1];
        let b = st[2];
        const luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
        if (s.colorSource === 'gradient' || s.colorSource === 'depth') {
            let t = s.colorSource === 'depth' ? depth / Math.max(1, maxDepth) : luma;
            t = Math.max(0, Math.min(1, quant(t)));
            const i = Math.round(t * 255) * 3;
            r = ramp[i];
            g = ramp[i + 1];
            b = ramp[i + 2];
        } else if (levels >= 2) {
            r = quant(r);
            g = quant(g);
            b = quant(b);
        }
        const o = count * STRIDE;
        data[o] = x;
        data[o + 1] = y;
        data[o + 2] = size;
        data[o + 3] = r;
        data[o + 4] = g;
        data[o + 5] = b;
        data[o + 6] = luma;
        data[o + 7] = hash2(Math.round(x * 8), Math.round(y * 8), Math.round(size * 8) + 31 * (s.styleSeed | 0));
        data[o + 8] = kind;
        count++;
    };

    // The metric's spread over a cell (frame-clipped).
    const spread = (x, y, size) => {
        const cx0 = Math.max(0, x);
        const cy0 = Math.max(0, y);
        const cx1 = Math.min(outW, x + size);
        const cy1 = Math.min(outH, y + size);
        if (cx1 <= cx0 || cy1 <= cy0) return -1;
        const ax0 = Math.min(an.w - 1, Math.floor(cx0 * kx));
        const ay0 = Math.min(an.h - 1, Math.floor(cy0 * ky));
        const ax1 = Math.max(ax0 + 1, Math.min(an.w, Math.ceil(cx1 * kx)));
        const ay1 = Math.max(ay0 + 1, Math.min(an.h, Math.ceil(cy1 * ky)));
        return an.stats(ax0, ay0, ax1, ay1, st)[3];
    };

    const roots = rootGrid(outW, outH, s.rootCols);

    // Variance: split while the cell is uneven enough.
    const stack = [];
    roots.forEach(([x, y, size]) => stack.push(x, y, size, 0));
    while (stack.length) {
        const d = stack.pop();
        const size = stack.pop();
        const y = stack.pop();
        const x = stack.pop();
        const half = size / 2;
        let split = false;
        // Every node still waiting ends as at least one leaf; a split
        // adds three. Past the budget, stop splitting rather than drop
        // leaves, so the frame stays covered (coarser where it ran out).
        const budget = count + stack.length / 4 + 3 < MAX_QUADS;
        if (!budget) { capped = true; } else if (d < minDepth && half >= 0.5) split = true;
        else if (d < maxDepth && half >= minSize) {
            const sd = spread(x, y, size);
            if (sd < 0) continue;
            split = sd > thr * falloff ** d;
        }
        if (split) {
            // Pushed in reverse so leaves come out top-left first.
            stack.push(x + half, y + half, half, d + 1);
            stack.push(x, y + half, half, d + 1);
            stack.push(x + half, y, half, d + 1);
            stack.push(x, y, half, d + 1);
        } else {
            emit(x, y, size, d, 0);
            if (count >= MAX_QUADS) break;
        }
    }
    return { data, count, capped };
}
