import React, { useEffect, useRef } from 'react';
import {
    DEFAULTS, PerlinSource, FluidSource, gridDims, toneField, ditherBuffer,
    quantize, pixelLevelCount, pixelPalette, paintPixels,
} from '../../lib/procedural';
import { subscribe, prefersReducedMotion } from '../../lib/ticker';
import styles from './ui.module.css';

// The ProceduralAscii tool's perlin / fluid engine drawn as pixels on a
// canvas that fills its (positioned) parent. `settings` takes the same keys
// as the tool (anything left out falls back to the tool's defaults), plus
// `rate` for the tool's playback "Speed x". Only the pixel style is drawn
// here; pixelSize is in device pixels, as in the tool.
//
// A wide, short strip would give the fluid a domain too flat to form eddies,
// so in `fluid` mode the engine runs on a virtual view at least `viewAspect`
// (height / width) tall, like the tool's full-screen stage, and the canvas
// shows a horizontal slice through its middle. Perlin noise is homogeneous,
// so it is evaluated on the strip itself: same look, a fraction of the cells.
//
// Performance: the engine only advances while the canvas is within
// `rootMargin` of the viewport and the tab is visible, on the shared ticker
// capped at `fps`. The fluid source keeps no rewind history. Viewers who
// prefer reduced motion get a single settled frame.

const MAX_DT = 1 / 20;
const MAX_DPR = 2;

function ProceduralField({
    settings, fps = 30, viewAspect = 9 / 16, rootMargin = '120px', className = '', style,
}) {
    const canvasRef = useRef(null);
    const cfg = useRef(null);
    const cfgKey = useRef('');
    const aspectRef = useRef(viewAspect);
    aspectRef.current = viewAspect;
    const merged = { ...DEFAULTS, rate: 1, ...settings, style: 'pixels' };
    const key = JSON.stringify(merged);
    if (key !== cfgKey.current) {
        cfgKey.current = key;
        cfg.current = merged;
    }

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const reduced = prefersReducedMotion();
        const eng = { perlin: new PerlinSource(), fluid: new FluidSource({ historyBytes: 0 }) };
        const st = {
            W: 0, H: 0, visible: false, unsub: null, last: null, primed: false,
            drawnKey: '', bufKey: '', toned: null, levels: null, errBuf: null,
            paletteKey: '', palette: null, cache: {},
        };

        const measure = () => {
            const rect = canvas.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
            st.W = Math.round(rect.width * dpr);
            st.H = Math.round(rect.height * dpr);
            if (st.W && st.H && (canvas.width !== st.W || canvas.height !== st.H)) {
                canvas.width = st.W;
                canvas.height = st.H;
                st.drawnKey = '';
            }
        };

        const sourceFor = (s) => (s.mode === 'fluid' ? eng.fluid : eng.perlin);
        // the fluid needs a squarer domain than the strip; noise does not
        const virtualHeight = (s) => (s.mode === 'fluid'
            ? Math.max(st.H, Math.round(st.W * aspectRef.current))
            : st.H);

        // Advance by `elapsed` seconds, then redraw only when something changed.
        const frame = (elapsed) => {
            const s = cfg.current;
            const { W, H } = st;
            if (!W || !H) return;
            const VH = virtualHeight(s);
            const dims = gridDims(W, VH, s);
            const { cols, rows } = dims;
            // rows of the virtual view that overlap the canvas
            const cellH = VH / rows;
            const top = (VH - H) / 2;
            const first = Math.max(0, Math.floor(top / cellH));
            const count = Math.min(rows, Math.ceil((top + H) / cellH)) - first;
            const src = sourceFor(s);
            src.sync(s, dims);
            if (elapsed) src.advance(elapsed, s.rate, s);
            src.atStart = false;

            const drawKey = `${src.version}|${cfgKey.current}|${W}|${VH}|${H}`;
            if (drawKey === st.drawnKey) return;
            st.drawnKey = drawKey;
            if (st.bufKey !== `${cols}x${count}`) {
                st.bufKey = `${cols}x${count}`;
                st.toned = new Float32Array(cols * count);
                st.levels = new Uint16Array(cols * count);
                st.errBuf = ditherBuffer(cols, count);
            }
            const L = pixelLevelCount(s);
            const pKey = [L, s.colorMode, s.background, s.foreground, s.stops.join(','), s.reverseGradient].join('|');
            if (pKey !== st.paletteKey) {
                st.paletteKey = pKey;
                st.palette = pixelPalette(s, L);
            }
            const full = src.getField(s);
            const field = count === rows ? full : full.subarray(first * cols, (first + count) * cols);
            toneField(field, s, st.toned);
            quantize(st.toned, cols, count, L, s.dither, st.levels, st.errBuf);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(
                paintPixels(st.cache, st.levels, st.palette.rgba, cols, count),
                0, Math.round(first * cellH - top), W, Math.round(count * cellH),
            );
        };

        // Reduced motion: warm the flow up and let trails build, then hold.
        const prime = () => {
            if (st.primed) return;
            st.primed = true;
            const s = cfg.current;
            const src = sourceFor(s);
            if (!st.W || !st.H) return;
            src.sync(s, gridDims(st.W, virtualHeight(s), s));
            if (s.mode === 'fluid') {
                while (src.warmupLeft > 0) src.advance(0, 0, s);
                const n = s.render === 'trails' ? Math.ceil(Math.max(0, s.fade) * 30) : 1;
                for (let i = 0; i < n; i++) src.simulateFrame(1 / 30, s);
            }
            frame(0);
        };

        const tick = (now) => {
            const elapsed = st.last === null ? 0 : Math.min(MAX_DT, now - st.last);
            st.last = now;
            frame(elapsed);
        };

        const sync = () => {
            if (reduced) {
                if (st.visible) prime();
                return;
            }
            if (st.visible && !st.unsub) {
                st.last = null;
                st.unsub = subscribe(tick, fps);
            } else if (!st.visible && st.unsub) {
                st.unsub();
                st.unsub = null;
            }
        };

        measure();

        const ro = new ResizeObserver(() => {
            measure();
            frame(0);
        });
        ro.observe(canvas);

        const io = new IntersectionObserver(([entry]) => {
            st.visible = entry.isIntersecting;
            sync();
        }, { rootMargin });
        io.observe(canvas);

        return () => {
            ro.disconnect();
            io.disconnect();
            if (st.unsub) st.unsub();
        };
        // setup runs once; live settings are read through cfg
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <canvas
            ref={canvasRef}
            className={`${styles.field} ${className}`}
            style={style}
            aria-hidden="true"
        />
    );
}

export default ProceduralField;
