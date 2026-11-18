// Pictures for Image objects: a PNG, JPEG or WebP is one frame; a GIF is
// every frame it has, each composited as the GIF says (what stays, what is
// cleared, what is put back) and held for its delay. The file is kept with
// the uploads (lib/scanAssets/screenVideo), so it is there after a reload.
//
// Animated GIFs are decoded here rather than by the browser, so every
// browser plays them, and the frame shown is worked out from the timeline's
// time: an export lands on the same frame as the preview did.

import { sourceUrl } from '../../../lib/scanAssets/screenVideo';

/** Files an Image can show (by name). */
export const PICTURE_EXT = /\.(png|gif|jpe?g|webp|avif|bmp)$/i;
export const PICTURE_ACCEPT = 'image/png,image/gif,image/jpeg,image/webp,image/avif,image/bmp';

const cache = new Map(); // source id -> picture

// ---- GIF ---------------------------------------------------------------------------

/** The pixels' colour indices from a GIF's LZW image data. */
function lzw(minSize, data, count) {
    const out = new Uint8Array(count);
    const clear = 1 << minSize;
    const eoi = clear + 1;
    const prefix = new Int16Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) suffix[i] = i;
    let size = minSize + 1;
    let mask = (1 << size) - 1;
    let next = eoi + 1;
    let old = -1;
    let first = 0;
    let datum = 0;
    let bits = 0;
    let pos = 0;
    let op = 0;
    while (op < count) {
        while (bits < size && pos < data.length) { datum |= data[pos++] << bits; bits += 8; }
        if (bits < size) break;
        let code = datum & mask;
        datum >>>= size;
        bits -= size;
        if (code === clear) {
            size = minSize + 1;
            mask = (1 << size) - 1;
            next = eoi + 1;
            old = -1;
            continue;
        }
        if (code === eoi) break;
        if (old === -1) {
            if (code >= clear) break; // not a GIF anyone wrote
            out[op++] = suffix[code];
            old = code;
            first = code;
            continue;
        }
        const read = code;
        let sp = 0;
        // A code not made yet is the last string and its own first letter.
        if (code >= next) { stack[sp++] = first; code = old; }
        while (code >= clear) {
            stack[sp++] = suffix[code];
            code = prefix[code];
            if (sp > 4096) return out;
        }
        first = suffix[code];
        stack[sp++] = first;
        if (next < 4096) {
            prefix[next] = old;
            suffix[next] = first;
            next++;
            if ((next & mask) === 0 && next < 4096) { size++; mask = (1 << size) - 1; }
        }
        old = read;
        while (sp > 0 && op < count) out[op++] = stack[--sp];
    }
    return out;
}

/**
 * A GIF's frames, whole: `{ width, height, frames: [{ rgba, delay }] }`,
 * each frame the full picture as it stands then (RGBA), delay in seconds.
 */
export function decodeGif(buf) {
    const b = new Uint8Array(buf);
    let p = 0;
    const u8 = () => b[p++];
    const u16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
    const sig = String.fromCharCode(...b.subarray(0, 6));
    if (!/^GIF8[79]a$/.test(sig)) throw new Error('not a GIF');
    p = 6;
    const W = u16();
    const H = u16();
    const packed = u8();
    p += 2; // background colour, aspect
    const table = (n) => { const t = b.subarray(p, p + n * 3); p += n * 3; return t; };
    const gct = packed & 0x80 ? table(1 << ((packed & 7) + 1)) : null;
    const subBlocks = () => {
        const parts = [];
        let len = 0;
        for (let n = u8(); n > 0 && p <= b.length; n = u8()) { parts.push(b.subarray(p, p + n)); len += n; p += n; }
        const all = new Uint8Array(len);
        let o = 0;
        parts.forEach((x) => { all.set(x, o); o += x.length; });
        return all;
    };
    const screen = new Uint8ClampedArray(W * H * 4);
    const frames = [];
    let gce = { disposal: 0, delay: 0, trans: -1 };
    while (p < b.length) {
        const block = u8();
        if (block === 0x3b) break;
        if (block === 0x21) {
            const label = u8();
            if (label === 0xf9) {
                p++; // block size (4)
                const f = u8();
                const delay = u16();
                const ti = u8();
                p++; // terminator
                gce = { disposal: (f >> 2) & 7, delay, trans: f & 1 ? ti : -1 };
            } else {
                subBlocks();
            }
        } else if (block === 0x2c) {
            const x0 = u16();
            const y0 = u16();
            const w = u16();
            const h = u16();
            const ip = u8();
            const lct = ip & 0x80 ? table(1 << ((ip & 7) + 1)) : null;
            const colours = lct || gct;
            const minSize = u8();
            const idx = lzw(minSize, subBlocks(), w * h);
            // Interlaced rows come in four passes.
            const rows = new Int32Array(h);
            if (ip & 0x40) {
                let r = 0;
                [[0, 8], [4, 8], [2, 4], [1, 2]].forEach(([s, step]) => { for (let y = s; y < h; y += step) rows[r++] = y; });
            } else {
                for (let y = 0; y < h; y++) rows[y] = y;
            }
            const before = gce.disposal === 3 ? screen.slice() : null;
            if (colours) {
                for (let r = 0; r < h; r++) {
                    const sy = y0 + rows[r];
                    if (sy >= H) continue;
                    for (let x = 0; x < w; x++) {
                        const sx = x0 + x;
                        if (sx >= W) continue;
                        const c = idx[r * w + x];
                        if (c === gce.trans || c * 3 + 2 >= colours.length) continue;
                        const o = (sy * W + sx) * 4;
                        screen[o] = colours[c * 3];
                        screen[o + 1] = colours[c * 3 + 1];
                        screen[o + 2] = colours[c * 3 + 2];
                        screen[o + 3] = 255;
                    }
                }
            }
            // As browsers play them: no delay (or 10 ms) is a tenth of a second.
            frames.push({ rgba: screen.slice(), delay: (gce.delay < 2 ? 10 : gce.delay) / 100 });
            if (gce.disposal === 2) {
                for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
                    screen.fill(0, (y * W + x0) * 4, (y * W + Math.min(W, x0 + w)) * 4);
                }
            } else if (before) {
                screen.set(before);
            }
            gce = { disposal: 0, delay: 0, trans: -1 };
        } else {
            break; // past what we can read: keep the frames so far
        }
    }
    return { width: W, height: H, frames };
}

// ---- Pictures --------------------------------------------------------------------------

async function toBitmap(rgba, w, h) {
    const data = new ImageData(rgba, w, h);
    if (typeof createImageBitmap === 'function') return createImageBitmap(data);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(data, 0, 0);
    return c;
}

/**
 * The picture for source `id` (an upload's id), loading the first time it
 * is asked for: `{ ready, failed, width, height, frames, starts, total,
 * animated, promise }`; frames are drawable, starts each frame's time.
 */
export function loadPicture(id) {
    if (!id) return null;
    let pic = cache.get(id);
    if (pic) return pic;
    pic = { id, ready: false, failed: false, width: 0, height: 0, frames: [], starts: [], total: 0, animated: false };
    cache.set(id, pic);
    pic.promise = (async () => {
        try {
            const url = await sourceUrl(id);
            if (!url) throw new Error('missing');
            const blob = await (await fetch(url)).blob();
            const buf = await blob.arrayBuffer();
            const head = new Uint8Array(buf, 0, Math.min(6, buf.byteLength));
            const isGif = String.fromCharCode(...head).startsWith('GIF8');
            if (isGif) {
                const g = decodeGif(buf);
                if (!g.frames.length) throw new Error('no frames');
                pic.width = g.width;
                pic.height = g.height;
                let t = 0;
                pic.frames = await Promise.all(g.frames.map((f) => toBitmap(f.rgba, g.width, g.height)));
                pic.starts = g.frames.map((f) => { const s = t; t += f.delay; return s; });
                pic.total = t;
            } else {
                const bmp = await createImageBitmap(blob);
                pic.width = bmp.width;
                pic.height = bmp.height;
                pic.frames = [bmp];
                pic.starts = [0];
                pic.total = 0;
            }
            pic.animated = pic.frames.length > 1;
            pic.ready = true;
        } catch (e) {
            pic.failed = true;
        }
        return pic;
    })();
    return pic;
}

/** Which of `pic`'s frames shows `t` seconds in (looping, or held on the last). */
export function frameAt(pic, t, loop = true) {
    if (!pic?.ready || pic.frames.length < 2 || !(pic.total > 0)) return 0;
    let u = Number.isFinite(t) ? t : 0;
    if (loop) u = ((u % pic.total) + pic.total) % pic.total;
    else if (u >= pic.total) return pic.frames.length - 1;
    else if (u < 0) return 0;
    // The last frame starting at or before u.
    let lo = 0;
    let hi = pic.starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pic.starts[mid] <= u) lo = mid; else hi = mid - 1;
    }
    return lo;
}
