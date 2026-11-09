// One frame, start to finish, shared by the preview and every export so they
// agree: seed -> grade -> analysis -> tree -> scene -> post. Plus the
// exports themselves (MP4, PNG, SVG).

import Renderer from './Renderer';
import { Analysis, buildTree, STRIDE } from './tree';
import { gradientFrame, shapesFrame } from './seeds';
import { Mp4Writer, pcmSlice } from '../../../lib/mp4Writer';
import { nextTask } from '../../../lib/mp4Frames';

const wrap = (v, n) => ((v % n) + n) % n;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

const RATIOS = {
    '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9,
};

/** The output frame in pixels: what exports are sized from. */
export function outputSize(s, seed) {
    let aspect = RATIOS[s.aspect];
    if (!aspect) aspect = seed?.width && seed?.height ? seed.width / seed.height : 16 / 9;
    const long = Math.max(64, Math.round(s.outLong) || 1920);
    return aspect >= 1
        ? { outW: long, outH: even(long / aspect) }
        : { outW: even(long * aspect), outH: long };
}

/** Which seed draws: a loaded one, or the generated fallback. */
export const activeSeed = (s, seed) => {
    if (s.seed === 'gradient' || s.seed === 'shapes') return s.seed;
    if (s.seed === 'procedural') return 'procedural';
    return seed && seed.kind === s.seed ? s.seed : 'gradient';
};

/** Settings as the renderer reads them (the shapes' own blur folded in). */
export function effective(s, kind) {
    if (kind !== 'shapes' || !s.shapeBlur) return s;
    return { ...s, blur: (s.blur || 0) + s.shapeBlur };
}

export async function seedFrame(kind, seed, s, t, ctx, cache, exact = false) {
    if (kind === 'gradient') return gradientFrame(s);
    if (kind === 'shapes') return shapesFrame(s, ctx.phase, ctx.outW / ctx.outH, cache);
    if (!seed) return null;
    return exact ? seed.exact(t, ctx, s) : seed.frame(t, ctx, s);
}

/** The preview's seed picture for `t` (may lag a playing video by a frame). */
export function previewFrame(kind, seed, s, t, ctx, cache) {
    if (kind === 'gradient') return gradientFrame(s);
    if (kind === 'shapes') return shapesFrame(s, ctx.phase, ctx.outW / ctx.outH, cache);
    return seed ? seed.frame(t, ctx, s) : null;
}

/** Draw one frame into `r`'s canvas. Returns the tree. */
export function renderFrame(r, an, scratch, frame, s, outW, outH, phase, frameIndex, dest = null) {
    r.drawSeed(frame, s, outW, outH, phase);
    r.grade(s, outH);
    const { px, w, h } = r.analyse(s, outW, outH, phase);
    an.update(px, w, h, s.metric);
    const tree = buildTree(an, s, outW, outH, phase, scratch);
    r.drawScene(tree, s, outW, outH);
    r.composite(s, frameIndex, dest);
    return tree;
}

function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const safeName = (n) => (n || 'quadtree').replace(/[^a-zA-Z0-9 _.-]+/g, '-');

/**
 * Render [t0, t1) to an MP4, frame-exact and independent of how fast it
 * runs. opts: { scale, fps, t0, t1, quality, sound }.
 */
export async function exportMp4({
    s, seed, loop, opts, onProgress, cancelled, name, save = true,
}) {
    const kind = activeSeed(s, seed);
    const S = effective(s, kind);
    const { outW, outH } = outputSize(s, seed);
    const w = even(outW * opts.scale);
    const h = even(outH * opts.scale);
    const fps = Math.max(1, opts.fps);
    const t0 = Math.max(0, opts.t0);
    const t1 = Math.max(t0 + 1 / fps, opts.t1);
    const total = Math.max(1, Math.round((t1 - t0) * fps));
    const bitrate = Math.min(120_000_000, Math.round(w * h * fps * opts.quality));

    let pcm = null;
    if (opts.sound && seed?.audio && kind === 'video') {
        onProgress(0, 'Reading sound…');
        const buf = await seed.audio();
        if (buf) pcm = pcmSlice(buf, t0 % Math.max(1e-3, buf.duration), (t0 % Math.max(1e-3, buf.duration)) + (t1 - t0), { loop: true });
    }
    const writer = await Mp4Writer.open({
        width: w, height: h, fps, bitrate, pcm, name: safeName(name), frames: total,
    });

    const canvas = document.createElement('canvas');
    const r = new Renderer(canvas, { preserve: true });
    const ss = w * h <= 3_600_000 ? 2 : 1;
    r.setSize(w * ss, h * ss);
    const down = document.createElement('canvas');
    down.width = w;
    down.height = h;
    const dctx = down.getContext('2d', { alpha: false });
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    const an = new Analysis();
    const scratch = {};
    const cache = {};
    let done = false;
    let started = 0;
    let lastReport = 0;
    try {
        onProgress(0, 'Opening the seed…');
        if (seed?.openExact && kind === 'video') await seed.openExact(t0, t1, Math.max(w, h));
        for (let i = 0; i < total; i++) {
            if (cancelled()) break;
            const t = t0 + i / fps;
            const lt = wrap(t, loop);
            const ctx = {
                phase: lt / loop, loop, outW, outH, playing: true, dt: 1 / fps,
            };
            // eslint-disable-next-line no-await-in-loop
            const frame = await seedFrame(kind, seed, S, lt, ctx, cache, true);
            renderFrame(r, an, scratch, frame, S, outW, outH, ctx.phase, i);
            dctx.drawImage(canvas, 0, 0, w, h);
            // eslint-disable-next-line no-await-in-loop
            await writer.add(down);
            const now = performance.now();
            if (i === 0) started = now;
            if (now - lastReport > 250) {
                lastReport = now;
                const rate = i / Math.max(0.001, (now - started) / 1000);
                onProgress((i + 1) / total, `Rendering ${i + 1}/${total}${i ? ` · ${rate.toFixed(0)} fps · ${Math.ceil((total - i - 1) / Math.max(rate, 0.01))}s left` : ''}`);
                // eslint-disable-next-line no-await-in-loop
                await nextTask();
            }
        }
        done = !cancelled();
        if (done) {
            onProgress(1, 'Finishing…');
            const out = await writer.finish();
            if (out.blob && save) download(out.blob, `${safeName(name)}.mp4`);
            return out;
        }
        await writer.abort();
        return null;
    } catch (e) {
        await writer.abort();
        throw e;
    } finally {
        if (seed?.closeExact && kind === 'video') seed.closeExact();
        r.dispose();
    }
}

/** The frame at `t` as a PNG at `scale` times the output size. */
export async function exportPng({
    s, seed, loop, t, scale, name,
}) {
    const kind = activeSeed(s, seed);
    const S = effective(s, kind);
    const { outW, outH } = outputSize(s, seed);
    const w = Math.round(outW * scale);
    const h = Math.round(outH * scale);
    const canvas = document.createElement('canvas');
    const r = new Renderer(canvas, { preserve: true });
    try {
        r.setSize(w, h);
        const lt = wrap(t, loop);
        const ctx = {
            phase: lt / loop, loop, outW, outH, playing: false, dt: 0,
        };
        if (seed?.openExact && kind === 'video') await seed.openExact(lt, lt + 1, Math.max(w, h));
        const frame = await seedFrame(kind, seed, S, lt, ctx, {}, true);
        renderFrame(r, new Analysis(), {}, frame, S, outW, outH, ctx.phase, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (blob) download(blob, `${safeName(name)}_${w}x${h}.png`);
    } finally {
        if (seed?.closeExact && kind === 'video') seed.closeExact();
        r.dispose();
    }
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')}`;
const f2 = (n) => String(Math.round(n * 100) / 100);
const esc = (t) => t.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[m]));

/**
 * The tree on screen as vector shapes, in output pixels. Post effects and
 * the underlay are left out.
 */
export function exportSvg({
    tree, s, seed, name,
}) {
    const { outW, outH } = outputSize(s, seed);
    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">`,
        `<rect width="${outW}" height="${outH}" fill="${s.background}"/>`,
    ];
    const chars = Array.from(s.ramp || ' ');
    const d = tree.data;
    // Tiled squares with an outline: plain fills, then each cell's left and
    // top edge (and frame sides) as one stroked layer, as the renderer does.
    const edges = s.shape === 'square' && s.radius <= 0 && s.gap <= 0 && Math.abs(s.size - 1) < 1e-3 && s.halftone <= 0 && s.outline > 0;
    const segs = {};
    const op = s.quadOpacity < 1 ? ` opacity="${f2(s.quadOpacity)}"` : '';
    out.push(`<g${op}${s.shape === 'ascii' ? ' font-family="\'SF Mono\', ui-monospace, Menlo, monospace" text-anchor="middle" dominant-baseline="central"' : ''}>`);
    for (let i = 0; i < tree.count; i++) {
        const o = i * STRIDE;
        const x = d[o];
        const y = d[o + 1];
        const size = d[o + 2];
        const col = toHex(d[o + 3], d[o + 4], d[o + 5]);
        const luma = d[o + 6];
        const cx = x + size / 2;
        const cy = y + size / 2;
        if (s.shape === 'ascii') {
            const l = Math.max(0, Math.min(1, s.rampInvert ? 1 - luma : luma));
            const ch = chars[Math.round(l * (chars.length - 1))] || ' ';
            if (s.glyphBg > 0) out.push(`<rect x="${f2(x)}" y="${f2(y)}" width="${f2(size)}" height="${f2(size)}" fill="${col}" fill-opacity="${f2(s.glyphBg * 0.35)}"/>`);
            if (ch.trim()) out.push(`<text x="${f2(cx)}" y="${f2(cy)}" font-size="${f2(size * s.size * 0.95)}" fill="${col}">${esc(ch)}</text>`);
            continue;
        }
        const l = s.halftoneInvert ? 1 - luma : luma;
        const ht = 1 + (Math.sqrt(Math.max(0, Math.min(1, l))) - 1) * s.halftone;
        const half = Math.max(0, size / 2 - s.gap / 2) * s.size * ht;
        if (half <= 0) continue;
        const circle = s.shape === 'circle' || (s.shape === 'mixed' && d[o + 7] < s.mixRatio);
        if (edges) {
            if (s.fill) out.push(`<rect x="${f2(x)}" y="${f2(y)}" width="${f2(size)}" height="${f2(size)}" fill="${col}"/>`);
            const lc = s.outlineMode === 'solid' ? s.outlineColor : s.outlineMode === 'cell' ? col : toHex(d[o + 3] * 0.45, d[o + 4] * 0.45, d[o + 5] * 0.45);
            const x1 = x + size;
            const y1 = y + size;
            let p = `M${f2(x)} ${f2(y1)}V${f2(y)}H${f2(x1)}`;
            if (x1 >= outW - 0.01) p += `V${f2(y1)}`;
            if (y1 >= outH - 0.01) p += `M${f2(x)} ${f2(y1)}H${f2(x1)}`;
            (segs[lc] = segs[lc] || []).push(p);
            continue;
        }
        const lineCol = s.outlineMode === 'solid' ? s.outlineColor : s.outlineMode === 'cell' ? col : toHex(d[o + 3] * 0.45, d[o + 4] * 0.45, d[o + 5] * 0.45);
        const ow = s.outline;
        const fill = s.fill ? col : 'none';
        const stroke = ow > 0 ? ` stroke="${lineCol}" stroke-width="${f2(ow)}"` : '';
        // Strokes sit inside the shape, as the renderer draws them.
        const hh = ow > 0 ? Math.max(0, half - ow / 2) : half;
        if (circle) {
            out.push(`<circle cx="${f2(cx)}" cy="${f2(cy)}" r="${f2(hh)}" fill="${fill}"${stroke}/>`);
        } else {
            const rx = s.radius > 0 ? ` rx="${f2(s.radius * hh)}"` : '';
            out.push(`<rect x="${f2(cx - hh)}" y="${f2(cy - hh)}" width="${f2(hh * 2)}" height="${f2(hh * 2)}"${rx} fill="${fill}"${stroke}/>`);
        }
    }
    Object.entries(segs).forEach(([c, list]) => {
        out.push(`<path d="${list.join('')}" fill="none" stroke="${c}" stroke-width="${f2(s.outline)}" stroke-linecap="square"/>`);
    });
    out.push('</g>', '</svg>');
    download(new Blob([out.join('\n')], { type: 'image/svg+xml' }), `${safeName(name)}_${tree.count}quads.svg`);
}
