import React, { useEffect, useRef } from 'react';
import { clamp, fractalNoise, FRACTAL_KIND, BAYER8 } from '../../lib/noise';
import { subscribe, prefersReducedMotion } from '../../lib/ticker';
import styles from './ui.module.css';

// A small, cheap cousin of the ProceduralAscii tool: fractal Perlin noise
// drawn as monospace glyphs on a canvas that fills its (positioned) parent.
// mode="fill" covers the whole area, mode="frame" only draws a border
// `thickness` cells deep (separators).
//
// render="pixels" draws square cells instead, dithered onto `palette`
// (low to high, null = transparent). With mode="spill" the noise is weighted towards zero
// in the middle so it eats in from the edges over whatever sits underneath
// (the media frames).
//
// interactive adds the pointer to the field: `glow` brightens what is under
// the cursor, and `ripple` sends a ring out from a click, like a stone into
// water. Both are read off the parent element, because the canvas itself is
// pointer-events: none.
//
// Performance: one fillText per row per colour (or one scaled drawImage of a
// cols x rows buffer for pixels), a shared rAF ticker capped
// at `fps`, and nothing runs while the canvas is off screen, the tab is
// hidden, `animate` is false or the viewer prefers reduced motion. A ripple
// keeps the ticker alive for its own lifetime even when `animate` is false,
// without advancing the noise.
//
// The grid is also capped at `maxCells` cells. `cell` is in CSS pixels, so
// zooming out (cmd/ctrl -) hands the canvas a bigger CSS box and would
// otherwise quadruple the glyph count for every halving of the zoom. Past the
// cap the cell grows instead, which keeps the work per frame bounded and the
// glyphs at a steady physical size, on huge displays as well as at low zoom.

const FONT_STACK = '"SF Mono", ui-monospace, Menlo, Monaco, monospace';
const ROW_RATIO = 1.8; // row height / column width
const MAX_DT = 0.1;
// Ceilings on cols x rows, per frame. Ascii pays a fillText per row per colour
// and is the expensive one; pixels go through a single ImageData blit.
const MAX_CELLS_ASCII = 20000;
const MAX_CELLS_PIXELS = 250000;
// Ripples: how many can be in flight, how far either side of the ring's centre
// the wave packet reaches (in `rippleWidth`s), and how many decay constants it
// is followed for before it is written off as gone.
const MAX_RIPPLES = 4;
const RIPPLE_REACH = 3;
const RIPPLE_LIFE = 3.5;

const DEFAULTS = {
    mode: 'fill',          // 'fill' | 'frame' | 'spill'
    render: 'ascii',       // 'ascii' | 'pixels'
    spread: 0.3,           // spill: edge band, as a fraction of the short side
    centre: 0.15,          // spill: noise weight left in the middle
    bias: 0.45,            // spill: pulled off values in the middle
    palette: [null, 'var(--paper)', 'var(--accent)', 'var(--ink)'], // pixels
    dither: 'bayer',       // pixels: 'bayer' | 'noise' | 'none'
    cell: 8,               // css px per character column
    maxCells: 0,           // cap on cols x rows; 0 = the per-render default
    thickness: 2,          // frame depth in cells
    ramp: ' .·:-=+*#%@',
    scale: 9,              // noise feature size, in cells
    octaves: 3,
    fractal: 'fbm',        // 'fbm' | 'turbulence' | 'ridged'
    evolve: 0.3,           // lattice cells per second along the time loop
    loop: 30,              // seconds per time loop
    driftX: 0.35,          // noise units per second
    driftY: 0,
    contrast: 1,
    density: 0,            // added to every value; negative thins the field
    accentAt: 0,           // values above this are drawn in the accent colour
    fadeX: false,
    fadeY: false,
    glow: 0,               // pointer brightening (interactive)
    glowRadius: 140,
    ripple: 0,             // height of the ring a click sends out (0 = off)
    rippleSpeed: 420,      // px/s the ring travels outwards
    rippleWidth: 48,       // px from the crest to the trough behind it
    rippleDecay: 1.1,      // seconds for the ring to fade to about a third
    seed: 1,
    fps: 15,
    speed: 1,              // time multiplier for all motion (morph + drift)
};

// [r, g, b, a] (0-255) for any CSS colour, including var(--token) read from el.
function toRgba(ctx, el, color) {
    const token = /^var\((--[\w-]+)\)$/.exec(color.trim());
    const value = token ? getComputedStyle(el).getPropertyValue(token[1]).trim() : color;
    ctx.fillStyle = '#000';
    ctx.fillStyle = value || '#000';
    const out = ctx.fillStyle;
    if (out[0] === '#') {
        const n = parseInt(out.slice(1, 7), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    }
    const m = out.match(/[\d.]+/g) || [0, 0, 0];
    const a = m[3] === undefined ? 1 : Number(m[3]);
    return [Number(m[0]), Number(m[1]), Number(m[2]), Math.round(a * 255)];
}

// Stable per-pixel threshold in (0, 1) for white-noise dithering.
const hashThreshold = (x, y) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    return ((h >>> 0) % 1024 + 0.5) / 1024;
};

function AsciiField({ animate = true, interactive = false, className = '', style, ...props }) {
    const canvasRef = useRef(null);
    const cfg = useRef(DEFAULTS);
    cfg.current = { ...DEFAULTS, ...props };
    const animateRef = useRef(animate);
    animateRef.current = animate;
    const api = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const reduced = prefersReducedMotion();
        const st = {
            W: 0, H: 0, dpr: 1, cols: 0, rows: 0, cw: 0, ch: 0, x0: 0, y0: 0,
            fontSize: 12, ink: '#ecebe6', accent: '#0000ff',
            t: (cfg.current.seed % 97) * 1.37, last: null,
            visible: false, px: -1e6, py: -1e6, unsub: null, pending: 0,
            levelsKey: '', lo: -0.5, span: 1, ripples: [],
        };

        const measure = () => {
            const s = cfg.current;
            const rect = canvas.getBoundingClientRect();
            st.W = Math.max(1, rect.width);
            st.H = Math.max(1, rect.height);
            st.dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(st.W * st.dpr);
            canvas.height = Math.round(st.H * st.dpr);
            // grow the cell uniformly rather than draw more than `maxCells` of them
            const budget = s.maxCells > 0 ? s.maxCells
                : (s.render === 'pixels' ? MAX_CELLS_PIXELS : MAX_CELLS_ASCII);
            const rowRatio = s.render === 'pixels' ? 1 : ROW_RATIO;
            const want = (st.W / s.cell) * (st.H / (s.cell * rowRatio));
            const grow = want > budget ? Math.sqrt(want / budget) : 1;
            st.cw = s.cell * grow;
            if (s.render === 'pixels') {
                st.ch = st.cw;
                st.cols = Math.max(1, Math.ceil(st.W / st.cw));
                st.rows = Math.max(1, Math.ceil(st.H / st.ch));
                st.x0 = 0;
                st.y0 = 0;
                if (!st.buf) st.buf = document.createElement('canvas');
                st.buf.width = st.cols;
                st.buf.height = st.rows;
                st.bctx = st.buf.getContext('2d');
                st.img = st.bctx.createImageData(st.cols, st.rows);
            } else {
                st.ch = st.cw * ROW_RATIO;
                st.cols = Math.max(1, Math.floor(st.W / st.cw));
                st.rows = Math.max(1, Math.floor(st.H / st.ch));
                st.x0 = (st.W - st.cols * st.cw) / 2;
                st.y0 = (st.H - st.rows * st.ch) / 2;
            }
            ctx.font = `100px ${FONT_STACK}`;
            const advance = ctx.measureText('M').width / 100 || 0.6;
            st.fontSize = st.cw / advance;
            const cs = getComputedStyle(canvas);
            st.ink = cs.color || st.ink;
            st.accent = cs.getPropertyValue('--accent').trim() || st.accent;
            st.paletteKey = '';
        };

        // Fractal kinds span different ranges (fbm is centred, ridged is not),
        // so fix the 2nd..98th percentile from a sparse sample around the loop.
        const ensureLevels = (s, p, kind) => {
            const key = [s.fractal, s.octaves, s.scale, s.seed, s.evolve, s.loop].join('|');
            if (key === st.levelsKey) return;
            st.levelsKey = key;
            const samples = new Float32Array(6 * 20 * 20);
            let n = 0;
            for (let k = 0; k < 6; k++) {
                for (let y = 0; y < 20; y++) {
                    for (let x = 0; x < 20; x++) {
                        samples[n++] = fractalNoise(x * 1.7 + s.seed * 13.7, y * 1.3, k / 6, p, s.seed, kind);
                    }
                }
            }
            samples.sort();
            st.lo = samples[Math.floor(0.02 * (n - 1))];
            st.span = Math.max(1e-6, samples[Math.floor(0.98 * (n - 1))] - st.lo);
        };

        // ---- click ripples ----
        // A ring travelling out from the click, added to the field the same
        // way `glow` is. The profile is a cosine under a Gaussian window: one
        // crest with a trough either side, so it reads as a wave front rather
        // than a spreading disc. Amplitude decays with age rather than with
        // distance, which here is the same thing at a constant speed.
        //
        // Ripples run on the wall clock, not `st.t`: they should travel at the
        // same rate whatever `speed` the noise is set to, and should still play
        // out when the noise is paused.

        // Drop the ones that have faded out or run off the canvas.
        const pruneRipples = (now) => {
            if (!st.ripples.length) return;
            const s = cfg.current;
            const reach = RIPPLE_REACH * s.rippleWidth;
            const gone = Math.hypot(st.W, st.H) + reach;
            st.ripples = st.ripples.filter((rp) => {
                const age = now - rp.t;
                return age < RIPPLE_LIFE * s.rippleDecay && age * s.rippleSpeed < gone;
            });
        };

        // Per-frame form of the live ripples, with the bounds that let the
        // inner loop reject a cell on its squared distance, before the sqrt.
        const prepRipples = (now) => {
            if (!st.ripples.length) return null;
            const s = cfg.current;
            const reach = RIPPLE_REACH * s.rippleWidth;
            const invWidth = 1 / s.rippleWidth;
            return st.ripples.map((rp) => {
                const age = now - rp.t;
                const radius = age * s.rippleSpeed;
                const near = Math.max(0, radius - reach);
                const far = radius + reach;
                return {
                    x: rp.x,
                    y: rp.y,
                    radius,
                    invWidth,
                    amp: s.ripple * Math.exp(-age / s.rippleDecay),
                    near2: near * near,
                    far2: far * far,
                };
            });
        };

        // Height of every live ring at a point on the canvas, in field units.
        const rippleAt = (rips, x, y) => {
            let v = 0;
            for (let i = 0; i < rips.length; i++) {
                const rp = rips[i];
                const dx = x - rp.x;
                const dy = y - rp.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < rp.near2 || d2 > rp.far2) continue;
                const u = (Math.sqrt(d2) - rp.radius) * rp.invWidth;
                v += rp.amp * Math.exp(-u * u) * Math.cos(Math.PI * u);
            }
            return v;
        };

        const drawPixels = (s, p, kind, phase, rips) => {
            const { cols, rows, lo, span } = st;
            const data = st.img.data;
            const key = s.palette.join('|');
            if (key !== st.paletteKey) {
                st.paletteKey = key;
                st.palette = s.palette.map((c) => (c ? toRgba(ctx, canvas, c) : null));
            }
            const pal = st.palette;
            const top = Math.max(1, pal.length - 1);
            const dither = s.dither;
            const inv = 1 / s.scale;
            const ox = s.driftX * st.t + s.seed * 13.7;
            const oy = s.driftY * st.t;
            const spill = s.mode === 'spill';
            const short = Math.min(cols, rows);
            const band = Math.max(1e-3, s.spread * short);
            for (let r = 0; r < rows; r++) {
                const ny = r * inv + oy;
                const dy = Math.min(r + 0.5, rows - r - 0.5);
                const b = (r & 7) * 8;
                const cy = (r + 0.5) * st.ch;
                for (let c = 0; c < cols; c++) {
                    const n = (fractalNoise(c * inv + ox, ny, phase, p, s.seed, kind) - lo) / span;
                    let v = (n - 0.5) * s.contrast + 0.5 + s.density;
                    if (rips) v += rippleAt(rips, (c + 0.5) * st.cw, cy);
                    if (spill) {
                        // 0 at the edge .. 1 once `spread` inside it (smoothstep)
                        let e = Math.min(c + 0.5, cols - c - 0.5, dy) / band;
                        e = e >= 1 ? 1 : e * e * (3 - 2 * e);
                        v = v * (1 - e * (1 - s.centre)) - s.bias * e;
                    }
                    const threshold = dither === 'bayer' ? BAYER8[b + (c & 7)]
                        : dither === 'noise' ? hashThreshold(c, r) : 0.5;
                    let q = Math.floor(v * top + threshold);
                    q = q < 0 ? 0 : (q > top ? top : q);
                    const i = (r * cols + c) * 4;
                    const col = pal[q];
                    if (col) {
                        data[i] = col[0];
                        data[i + 1] = col[1];
                        data[i + 2] = col[2];
                        data[i + 3] = col[3];
                    } else {
                        data[i + 3] = 0;
                    }
                }
            }
            st.bctx.putImageData(st.img, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(st.buf, 0, 0, cols * st.cw, rows * st.ch);
        };

        const draw = () => {
            const s = cfg.current;
            const { cols, rows, cw, ch, x0, y0 } = st;
            ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
            ctx.clearRect(0, 0, st.W, st.H);
            ctx.font = `${st.fontSize}px ${FONT_STACK}`;
            ctx.textBaseline = 'middle';

            const chars = Array.from(s.ramp);
            const levels = chars.length;
            const top = levels - 1;
            const p = {
                octaves: s.octaves,
                persistence: 0.5,
                lacunarity: 2,
                loopCells: Math.max(1, Math.round(s.evolve * s.loop)),
            };
            const phase = (((st.t / s.loop) % 1) + 1) % 1;
            const kind = FRACTAL_KIND[s.fractal] || 0;
            ensureLevels(s, p, kind);
            const now = performance.now() / 1000;
            pruneRipples(now);
            const rips = prepRipples(now);
            if (s.render === 'pixels') {
                drawPixels(s, p, kind, phase, rips);
                return;
            }
            const { lo, span } = st;
            const inv = 1 / s.scale;
            const aspect = ch / cw;
            const ox = s.driftX * st.t + s.seed * 13.7;
            const oy = s.driftY * st.t;
            const frame = s.mode === 'frame';
            const th = Math.max(1, s.thickness);
            const glow = interactive ? s.glow : 0;
            const r2 = 2 * s.glowRadius * s.glowRadius;
            const accentAt = s.accentAt > 0 ? s.accentAt : Infinity;
            const blankRun = frame ? ' '.repeat(Math.max(0, cols - 2 * th)) : '';

            for (let r = 0; r < rows; r++) {
                const edgeRow = r < th || r >= rows - th;
                const ny = r * aspect * inv + oy;
                const ey = s.fadeY ? Math.sin((Math.PI * (r + 0.5)) / rows) : 1;
                const cy = y0 + (r + 0.5) * ch;
                let ink = '';
                let acc = '';
                let hasInk = false;
                let hasAcc = false;
                for (let c = 0; c < cols; c++) {
                    let depth = 0;
                    if (frame) {
                        if (!edgeRow && c === th) {
                            ink += blankRun;
                            acc += blankRun;
                            c = cols - th - 1;
                            continue;
                        }
                        depth = Math.min(r, rows - 1 - r, c, cols - 1 - c) / th;
                    }
                    const n = (fractalNoise(c * inv + ox, ny, phase, p, s.seed, kind) - lo) / span;
                    let v = (n - 0.5) * s.contrast + 0.5 + s.density;
                    if (s.fadeX) v *= Math.sin((Math.PI * (c + 0.5)) / cols) ** 0.7;
                    v *= ey;
                    if (frame) v *= 1 - depth * 0.45;
                    if (glow || rips) {
                        const cx = x0 + (c + 0.5) * cw;
                        if (glow) {
                            const dx = cx - st.px;
                            const dy = cy - st.py;
                            v += glow * Math.exp(-(dx * dx + dy * dy) / r2);
                        }
                        if (rips) v += rippleAt(rips, cx, cy);
                    }
                    const q = clamp((v * levels) | 0, 0, top);
                    const g = chars[q];
                    if (q > 0 && v >= accentAt) {
                        acc += g;
                        ink += ' ';
                        hasAcc = true;
                    } else {
                        ink += g;
                        acc += ' ';
                        if (q > 0) hasInk = true;
                    }
                }
                if (hasInk) {
                    ctx.fillStyle = st.ink;
                    ctx.fillText(ink, x0, cy);
                }
                if (hasAcc) {
                    ctx.fillStyle = st.accent;
                    ctx.fillText(acc, x0, cy);
                }
            }
        };

        const tick = (now) => {
            if (st.last !== null && animateRef.current) {
                st.t += Math.min(MAX_DT, now - st.last) * cfg.current.speed;
            }
            st.last = now;
            draw();
            // draw() prunes, so this is the frame the last ripple died on
            if (!animateRef.current && !st.ripples.length) sync();
        };

        const requestDraw = () => {
            if (st.pending) return;
            st.pending = requestAnimationFrame(() => {
                st.pending = 0;
                draw();
            });
        };

        const sync = () => {
            const run = (animateRef.current || st.ripples.length > 0) && st.visible && !reduced;
            if (run && !st.unsub) {
                st.last = null;
                st.unsub = subscribe(tick, cfg.current.fps);
            } else if (!run && st.unsub) {
                st.unsub();
                st.unsub = null;
            }
        };

        measure();
        draw();

        const ro = new ResizeObserver(() => {
            measure();
            draw();
        });
        ro.observe(canvas);

        const io = new IntersectionObserver(([entry]) => {
            st.visible = entry.isIntersecting;
            sync();
        }, { rootMargin: '80px' });
        io.observe(canvas);

        let fontsCancelled = false;
        if (document.fonts && document.fonts.load) {
            document.fonts.load(`12px ${FONT_STACK}`).then(() => {
                if (fontsCancelled) return;
                measure();
                draw();
            }).catch(() => {});
        }

        const onPointer = (e) => {
            const rect = canvas.getBoundingClientRect();
            st.px = e.clientX - rect.left;
            st.py = e.clientY - rect.top;
            if (!st.unsub) requestDraw();
        };

        // A ripple is motion and nothing else, so a viewer who asked for less
        // of it gets none: one frozen ring would be worse than no ring at all.
        const onDown = (e) => {
            if (reduced || !cfg.current.ripple) return;
            const rect = canvas.getBoundingClientRect();
            st.ripples.push({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                t: performance.now() / 1000,
            });
            if (st.ripples.length > MAX_RIPPLES) st.ripples.shift();
            sync();
            requestDraw(); // don't wait up to a frame interval for the first ring
        };

        // the canvas is pointer-events: none, so the parent is what gets clicked
        const host = interactive ? canvas.parentElement : null;
        if (interactive) window.addEventListener('pointermove', onPointer, { passive: true });
        if (host) host.addEventListener('pointerdown', onDown);

        api.current = { sync, requestDraw };

        return () => {
            fontsCancelled = true;
            ro.disconnect();
            io.disconnect();
            if (st.unsub) st.unsub();
            if (st.pending) cancelAnimationFrame(st.pending);
            window.removeEventListener('pointermove', onPointer);
            if (host) host.removeEventListener('pointerdown', onDown);
            api.current = null;
        };
        // setup runs once; live props are read through cfg / animateRef
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (api.current) api.current.sync();
    }, [animate]);

    return (
        <canvas
            ref={canvasRef}
            className={`${styles.field} ${className}`}
            style={style}
            aria-hidden="true"
        />
    );
}

export default AsciiField;
