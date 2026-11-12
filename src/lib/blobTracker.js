// The Blob Tracker's engine: detection, tracking, pairing and drawing.
// Shared by the Blob Tracker tool and the Compositor's Blob Tracker effect,
// so a change here shows in both.
//
//   detectBlobs        threshold a small frame and find its connected blobs
//   updateTracks       match them to last frame's tracks (stable ids, damped)
//   updateConnections  pair tracks up for the connection lines
//   drawOverlay        draw boxes, labels and connections onto a 2D canvas
//
// Frames are RGBA bytes, rows top to bottom, at ANALYSIS_WIDTH across.

import { GLYPH_FONTS } from '../components/quadtree/fonts';

// Width (px) of the downscaled frame the detector runs on. Small enough to
// flood-fill every animation frame, large enough to resolve separate blobs.
export const ANALYSIS_WIDTH = 220;

export const BLOB_DEFAULTS = {
    // Detection
    threshold: 70, // luma cutoff (0-255)
    invert: false, // track dark blobs on light footage instead
    minArea: 10, // min blob size, in analysis-grid pixels
    maxSize: 100, // max blob size, as a % of the frame (100 = no limit)
    maxBoxes: 12,
    smoothing: 0.65, // 0 = raw boxes, ->1 = heavily damped
    // Boxes
    showBoxes: true,
    boxStyle: 'corners', // 'corners' | 'box' | 'cross'
    boxColor: '#f2f0e6',
    lineWidth: 2,
    boxOpacity: 0.9,
    borderRadius: 4,
    glow: 0,
    blur: 0,
    // Labels
    showLabels: true,
    labelText: 'coords', // see LABEL_TEXTS; 'custom' uses labelTemplate
    labelTemplate: '#{id}  {area}',
    labelFont: 'mono', // a GLYPH_FONTS id; 'custom' uses labelFontCustom
    labelFontCustom: '',
    labelWeight: 400,
    labelSize: 11, // text px at 1280 wide
    labelPadX: 5,
    labelPadY: 3.5,
    labelGap: 4, // between the label and its box
    labelPlace: 'above', // 'above' | 'below' | 'inside' | 'centre'
    labelRadius: -1, // corner radius of the label; -1 follows the box's
    labelColor: '#2b4bdf',
    labelOpacity: 1, // of the label's fill
    labelTextColor: '#ffffff',
    labelOutline: true,
    labelOutlineColor: '#ffffff',
    labelOutlineOpacity: 0.85,
    labelOutlineWidth: 1,
    // Connections
    connectionColor: '#e8c56a',
    showConnections: false,
    connectionCurve: 0.3, // 0 = straight lines, 1 = strongly bowed
    connectionShuffle: 0, // seconds of video time between re-pairings (0 = never)
};

/** What a label can say: [id, name, template]. */
export const LABEL_TEXTS = [
    ['coords', 'Position', '{x}, {y}'],
    ['size', 'Size', '{w}×{h}'],
    ['area', 'Area', '{area} px²'],
    ['fill', 'Lit area', '{lit} px²'],
    ['variance', 'Variance', 'σ² {var}'],
    ['confidence', 'Confidence', '{conf}%'],
    ['id', 'Id', '#{id}'],
    ['custom', 'Custom…', null],
];
const LABEL_TEMPLATE = Object.fromEntries(LABEL_TEXTS.map(([id, , t]) => [id, t]));

export const LABEL_TOKENS = '{x} {y} {w} {h} {area} {lit} {fill} {mean} {var} {sd} {conf} {id}';

export const LABEL_PLACES = [['above', 'Above'], ['below', 'Below'], ['inside', 'Inside'], ['centre', 'Centre']];

const FONT_STACK = Object.fromEntries(GLYPH_FONTS.map(([id, , stack]) => [id, stack]));

/** The CSS font for a label at `px` pixels. */
export function labelFont(s, px) {
    const family = s.labelFont === 'custom' && s.labelFontCustom
        ? `"${String(s.labelFontCustom).replace(/"/g, '')}", ${FONT_STACK.mono}`
        : FONT_STACK[s.labelFont] || FONT_STACK.mono;
    return `${s.labelWeight || 400} ${px}px ${family}`;
}

// ---- Detection ------------------------------------------------------------------------

// Working buffers, kept between frames (the frame size rarely changes).
let bufN = 0;
let lumBuf = null;
let maskBuf = null;
let visitedBuf = null;
let stackBuf = null;

function buffers(n) {
    if (n !== bufN) {
        bufN = n;
        lumBuf = new Uint8Array(n);
        maskBuf = new Uint8Array(n);
        visitedBuf = new Uint8Array(n);
        stackBuf = new Int32Array(n);
    } else {
        visitedBuf.fill(0);
    }
}

// Threshold the frame on luminance, then group lit pixels into connected
// components (8-connectivity, iterative flood fill). Returns the largest
// components as {x, y, w, h, area, cx, cy, mean, var} in analysis-grid
// coordinates; mean and var are the blob's luma (0-255) and its variance.
export function detectBlobs(data, w, h, s) {
    const n = w * h;
    buffers(n);
    const lum = lumBuf;
    const mask = maskBuf;
    const visited = visitedBuf;
    const stack = stackBuf;
    const th = s.threshold;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
        const l = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
        lum[i] = l;
        mask[i] = (s.invert ? l < th : l > th) ? 1 : 0;
    }

    const blobs = [];
    const maxArea = (s.maxSize ?? 100) >= 100 ? Infinity : (Math.max(0, s.maxSize) / 100) * n;
    for (let i = 0; i < n; i++) {
        if (!mask[i] || visited[i]) continue;
        let top = 0;
        stack[top++] = i;
        visited[i] = 1;
        let minX = w; let minY = h; let maxX = 0; let maxY = 0;
        let area = 0; let sumX = 0; let sumY = 0; let sumL = 0; let sumL2 = 0;

        while (top > 0) {
            const idx = stack[--top];
            const x = idx % w;
            const y = (idx / w) | 0;
            const l = lum[idx];
            area++;
            sumX += x;
            sumY += y;
            sumL += l;
            sumL2 += l * l;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= w) continue;
                    const nIdx = ny * w + nx;
                    if (mask[nIdx] && !visited[nIdx]) {
                        visited[nIdx] = 1;
                        stack[top++] = nIdx;
                    }
                }
            }
        }

        if (area >= s.minArea && area <= maxArea) {
            const mean = sumL / area;
            blobs.push({
                x: minX,
                y: minY,
                w: maxX - minX + 1,
                h: maxY - minY + 1,
                area,
                cx: sumX / area,
                cy: sumY / area,
                mean,
                var: Math.max(0, sumL2 / area - mean * mean),
            });
        }
    }

    blobs.sort((a, b) => b.area - a.area);
    return blobs.slice(0, s.maxBoxes);
}

// ---- Tracking -------------------------------------------------------------------------

const SMOOTHED = ['x', 'y', 'w', 'h', 'cx', 'cy', 'area', 'mean', 'var'];

/**
 * How sure the tracker is of a track, 0-1: how solidly the blob fills its
 * box and how far it sits past the threshold, scaled down while the track
 * is new (it takes a few frames to trust).
 */
function confidence(t, s) {
    const fill = Math.min(1, t.area / Math.max(1, t.w * t.h));
    const room = s.invert ? s.threshold : 255 - s.threshold;
    const contrast = room > 0 ? Math.min(1, Math.abs(t.mean - s.threshold) / room) : 1;
    const settled = Math.min(1, t.age / 8);
    return settled * (0.5 * fill + 0.5 * contrast);
}

// Greedy nearest-centroid matching between last frame's tracks and this
// frame's detections. Matched tracks keep their id (stable labels) and get
// lerped toward the new box; unmatched tracks survive a few frames so
// momentary detection dropouts don't flicker.
export function updateTracks(tracks, blobs, nextIdRef, s, maxDist) {
    const used = new Set();
    const alive = [];
    const k = 1 - Math.min(0.95, Math.max(0, s.smoothing));

    for (const t of tracks) {
        let best = -1;
        let bestD = maxDist;
        for (let j = 0; j < blobs.length; j++) {
            if (used.has(j)) continue;
            const d = Math.hypot(blobs[j].cx - t.cx, blobs[j].cy - t.cy);
            if (d < bestD) { bestD = d; best = j; }
        }
        if (best >= 0) {
            used.add(best);
            const b = blobs[best];
            for (const key of SMOOTHED) t[key] += (b[key] - t[key]) * k;
            t.missed = 0;
            t.age++;
            alive.push(t);
        } else {
            t.missed++;
            if (t.missed < 8) alive.push(t);
        }
    }

    for (let j = 0; j < blobs.length; j++) {
        if (used.has(j)) continue;
        alive.push({
            id: nextIdRef.current++, ...blobs[j], missed: 0, age: 1,
        });
    }

    for (const t of alive) t.conf = confidence(t, s);
    return alive;
}

/** Whether a track is drawn (it can survive a few frames unseen without showing). */
export const trackShown = (t) => t.missed < 3;

// Random pairing of visible tracks: each box connects to at most one random
// partner. Pairs persist while both tracks are alive so lines don't flicker;
// newly unpaired boxes get shuffled together each frame. `state` is
// { pairs: [{a, b, bend}], lastShuffle } and `now` is the video time (s):
// when connectionShuffle > 0, all pairs are re-drawn from scratch every
// `connectionShuffle` seconds of playback. `bend` (+1/-1) picks which side a
// curved connection bows toward and stays fixed for the pair's lifetime.
export function updateConnections(state, tracks, s, now) {
    if (s.connectionShuffle > 0) {
        if (now < state.lastShuffle) state.lastShuffle = now; // looped / rewound
        if (now - state.lastShuffle >= s.connectionShuffle) {
            state.pairs = [];
            state.lastShuffle = now;
        }
    }

    const ids = tracks.filter(trackShown).map((t) => t.id);
    const idSet = new Set(ids);
    const kept = state.pairs.filter((p) => idSet.has(p.a) && idSet.has(p.b));

    const paired = new Set();
    for (const p of kept) { paired.add(p.a); paired.add(p.b); }
    const free = ids.filter((id) => !paired.has(id));

    for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = free[i];
        free[i] = free[j];
        free[j] = tmp;
    }
    for (let i = 0; i + 1 < free.length; i += 2) {
        kept.push({ a: free[i], b: free[i + 1], bend: Math.random() < 0.5 ? 1 : -1 });
    }

    state.pairs = kept;
}

/** A fresh tracker: { tracks, nextId, conn }. */
export const newTrackerState = () => ({ tracks: [], nextId: { current: 1 }, conn: { pairs: [], lastShuffle: 0 } });

/** One frame through the tracker: detect, track and pair, in `state` (from newTrackerState). */
export function trackFrame(state, data, aw, ah, s, now) {
    const blobs = detectBlobs(data, aw, ah, s);
    state.tracks = updateTracks(state.tracks, blobs, state.nextId, s, aw * 0.18);
    updateConnections(state.conn, state.tracks, s, now);
}

// ---- Labels ---------------------------------------------------------------------------

function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
}

/**
 * A track's label. `kx`, `ky` scale analysis pixels to the pixels labels
 * count in (the picture's, or the output's).
 */
export function labelFor(t, s, kx, ky) {
    const template = s.labelText === 'custom' ? (s.labelTemplate || '') : (LABEL_TEMPLATE[s.labelText] || LABEL_TEMPLATE.coords);
    const vals = {
        x: () => Math.round(t.cx * kx),
        y: () => Math.round(t.cy * ky),
        w: () => Math.round(t.w * kx),
        h: () => Math.round(t.h * ky),
        area: () => compact(t.w * t.h * kx * ky),
        lit: () => compact(t.area * kx * ky),
        fill: () => Math.round(Math.min(1, t.area / Math.max(1, t.w * t.h)) * 100),
        mean: () => Math.round(t.mean ?? 0),
        var: () => compact(t.var ?? 0),
        sd: () => (Math.sqrt(t.var ?? 0)).toFixed(1),
        conf: () => Math.round((t.conf ?? 0) * 100),
        id: () => t.id,
    };
    return template.replace(/\{(\w+)\}/g, (m, key) => (vals[key] ? String(vals[key]()) : m));
}

// ---- Drawing --------------------------------------------------------------------------

export function roundedRectPath(ctx, x, y, w, h, r, fresh = true) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (fresh) ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

/** The box a track is drawn as, in canvas pixels: { x, y, w, h, cx, cy }. */
export function trackBox(t, sx, sy, u) {
    const pad = 3 * u;
    return {
        x: t.x * sx - pad,
        y: t.y * sy - pad,
        w: t.w * sx + pad * 2,
        h: t.h * sy + pad * 2,
        cx: t.cx * sx,
        cy: t.cy * sy,
    };
}

const hexAlpha = (hex, a) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};

// Renders tracks + connections onto a canvas of vw x vh pixels. Does NOT
// clear first, so it can composite over an already-drawn video frame (export).
// Analysis-grid coords scale up to the canvas; `u` scales strokes, radii and
// labels with the canvas, which keeps the overlay crisp (and the same shape)
// at any resolution. `opts.labelW` / `labelH` are the size label numbers
// count in (the canvas, unless given).
//
// Each kind of mark (boxes, label fills, outlines) is one path drawn once,
// so a glow (shadowBlur, which is costly) is worked out a few times a
// frame rather than for every box.
export function drawOverlay(ctx, vw, vh, aw, ah, tracks, pairs, s, opts = {}) {
    const sx = vw / aw;
    const sy = vh / ah;
    const u = Math.max(0.75, vw / 1280);
    const lw = Math.max(1, s.lineWidth * u);
    const radius = Math.max(0, s.borderRadius) * u;
    const glow = Math.max(0, s.glow) * u;
    ctx.filter = s.blur > 0 ? `blur(${s.blur * u}px)` : 'none';
    ctx.lineJoin = 'miter';

    const setGlow = (color) => {
        if (glow > 0) {
            ctx.shadowBlur = glow;
            ctx.shadowColor = color;
        } else {
            ctx.shadowBlur = 0;
        }
    };
    const shown = tracks.filter(trackShown);
    ctx.globalAlpha = s.boxOpacity;

    if (s.showConnections && pairs.length > 0) {
        const byId = new Map();
        for (const t of shown) byId.set(t.id, t);
        const curve = Math.max(0, s.connectionCurve || 0);
        ctx.strokeStyle = s.connectionColor;
        ctx.lineWidth = Math.max(1, lw * 0.8);
        setGlow(s.connectionColor);
        ctx.beginPath();
        for (const pair of pairs) {
            const a = byId.get(pair.a);
            const b = byId.get(pair.b);
            if (!a || !b) continue;
            const x1 = a.cx * sx; const y1 = a.cy * sy;
            const x2 = b.cx * sx; const y2 = b.cy * sy;
            ctx.moveTo(x1, y1);
            if (curve > 0) {
                // Control point offset perpendicular to the segment midpoint;
                // bend keeps each pair bowing to a consistent side.
                const px = (x1 + x2) / 2 - (y2 - y1) * curve * 0.5 * pair.bend;
                const py = (y1 + y2) / 2 + (x2 - x1) * curve * 0.5 * pair.bend;
                ctx.quadraticCurveTo(px, py, x2, y2);
            } else {
                ctx.lineTo(x2, y2);
            }
        }
        ctx.stroke();
    }

    // Boxes, all in one path.
    const boxes = shown.map((t) => trackBox(t, sx, sy, u));
    if (boxes.length && s.showBoxes !== false) {
        ctx.strokeStyle = s.boxColor;
        ctx.lineWidth = lw;
        setGlow(s.boxColor);
        ctx.beginPath();
        for (const b of boxes) {
            const { x, y, w, h } = b;
            if (s.boxStyle === 'box') {
                roundedRectPath(ctx, x, y, w, h, radius, false);
            } else if (s.boxStyle === 'corners') {
                const cl = Math.max(5 * u, Math.min(w, h) * 0.26);
                ctx.moveTo(x, y + cl); ctx.lineTo(x, y); ctx.lineTo(x + cl, y);
                ctx.moveTo(x + w - cl, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cl);
                ctx.moveTo(x + w, y + h - cl); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - cl, y + h);
                ctx.moveTo(x + cl, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - cl);
            } else {
                const r = 6 * u;
                ctx.moveTo(b.cx - r, b.cy); ctx.lineTo(b.cx + r, b.cy);
                ctx.moveTo(b.cx, b.cy - r); ctx.lineTo(b.cx, b.cy + r);
            }
        }
        ctx.stroke();
    }

    if (s.showLabels && shown.length) {
        const fontPx = Math.max(4, Math.round((s.labelSize ?? 11) * u));
        const padX = Math.max(0, s.labelPadX ?? 5) * u;
        const padY = Math.max(0, s.labelPadY ?? 3.5) * u;
        const gap = (s.labelGap ?? 4) * u;
        ctx.font = labelFont(s, fontPx);
        ctx.textBaseline = 'middle';
        const kx = (opts.labelW || vw) / aw;
        const ky = (opts.labelH || vh) / ah;
        const pills = shown.map((t, i) => {
            const b = boxes[i];
            const text = labelFor(t, s, kx, ky);
            const pw = ctx.measureText(text).width + padX * 2;
            const ph = fontPx + padY * 2;
            let px;
            let py;
            const place = s.labelPlace || 'above';
            if (place === 'centre') {
                px = b.cx - pw / 2;
                py = b.cy - ph / 2;
            } else if (place === 'inside') {
                px = b.x + gap;
                py = b.y + gap;
            } else if (place === 'below') {
                px = b.x;
                py = b.y + b.h + gap;
                if (py + ph > vh - 2) py = b.y - ph - gap;
            } else {
                px = b.x;
                py = b.y - ph - gap;
                if (py < 2) py = b.y + gap;
            }
            px = Math.min(Math.max(2, px), vw - pw - 2);
            return { text, px, py, pw, ph };
        });
        const pr = (s.labelRadius ?? -1) < 0 ? radius : s.labelRadius * u;

        const fillA = s.labelOpacity ?? 1;
        if (fillA > 0) {
            ctx.fillStyle = hexAlpha(s.labelColor, fillA);
            setGlow(s.labelColor);
            ctx.beginPath();
            for (const p of pills) roundedRectPath(ctx, p.px, p.py, p.pw, p.ph, Math.min(pr, p.ph / 2), false);
            ctx.fill();
        }
        ctx.shadowBlur = 0;
        if (s.labelOutline !== false && (s.labelOutlineWidth ?? 1) > 0) {
            ctx.strokeStyle = hexAlpha(s.labelOutlineColor || '#ffffff', s.labelOutlineOpacity ?? 0.85);
            ctx.lineWidth = Math.max(0.5, (s.labelOutlineWidth ?? 1) * u);
            ctx.beginPath();
            for (const p of pills) roundedRectPath(ctx, p.px, p.py, p.pw, p.ph, Math.min(pr, p.ph / 2), false);
            ctx.stroke();
        }
        ctx.fillStyle = s.labelTextColor;
        for (const p of pills) ctx.fillText(p.text, p.px + padX, p.py + p.ph / 2 + u * 0.5);
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.filter = 'none';
}
