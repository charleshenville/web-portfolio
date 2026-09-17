import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, SlidersHorizontal, X, Download, Plus, Shuffle, RotateCcw,
    Rewind, FastForward, StepBack, StepForward, Copy, Check,
} from 'lucide-react';
import VfxNumberField from './VfxNumberField';
import styles from './vfx.module.css';
import { clamp } from '../lib/noise';
import {
    CHAR_ASPECT, DEFAULTS, PerlinSource, FluidSource, gridDims, charsOf,
    paletteFor, toneField, ditherBuffer, quantize, colorBuckets,
    pixelLevelCount, pixelPalette, pixelLevels, paintPixels,
} from '../lib/procedural';

// Procedural ascii generator: a live, interactive port of
// backend/tools/ascii_procedural_generator.py (fractal Perlin noise and a 2D
// Navier-Stokes flow), with playback controls, colour mapping and exports.
// The engine lives in lib/procedural.

const FRAME_DELIMITER = '---FRAME---';
const FONT_STACK = '"SF Mono", ui-monospace, Menlo, Monaco, monospace';
// real seconds a single preview tick may advance, so a background tab
// doesn't come back and try to simulate a minute in one frame
const MAX_TICK_DT = 1 / 20;
const GRADIENT_BUCKETS = 32;
const MAX_STOPS = 8;

const CHARSET_PRESETS = [
    { id: 'default', name: 'Default', chars: ' .*:o&8#@' },
    { id: 'classic', name: 'Classic', chars: ' .:-=+*#%@' },
    { id: 'dense', name: 'Dense (70)', chars: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$' },
    { id: 'blocks', name: 'Blocks', chars: ' ░▒▓█' },
    { id: 'dots', name: 'Dots', chars: ' ·•●' },
    { id: 'lines', name: 'Lines', chars: ' -=≡' },
    { id: 'binary', name: 'Binary', chars: ' 01' },
    { id: 'hex', name: 'Hex', chars: ' 0123456789ABCDEF' },
];

const COLOR_PRESETS = [
    { id: 'mono', name: 'Mono', background: '#000000', colorMode: 'solid', foreground: '#d4d4d4' },
    { id: 'greyscale', name: 'Greyscale', background: '#000000', colorMode: 'gradient', stops: ['#262626', '#ffffff'] },
    { id: 'phosphor', name: 'Phosphor', background: '#010805', colorMode: 'gradient', stops: ['#0b3d1a', '#39ff88', '#eaffef'] },
    { id: 'amber', name: 'Amber', background: '#0a0600', colorMode: 'gradient', stops: ['#3d2400', '#ffb000', '#fff1c9'] },
    { id: 'ice', name: 'Ice', background: '#01050b', colorMode: 'gradient', stops: ['#0a2a4a', '#4fb3ff', '#eaf6ff'] },
    { id: 'ember', name: 'Ember', background: '#050000', colorMode: 'gradient', stops: ['#3a0000', '#d62d00', '#ffb300', '#fff6d5'] },
    { id: 'synth', name: 'Synth', background: '#07020f', colorMode: 'gradient', stops: ['#2b0a5c', '#ff2fb4', '#48f2ff'] },
    { id: 'paper', name: 'Paper', background: '#f2efe6', colorMode: 'gradient', stops: ['#c9c3b3', '#1b1b1b'] },
];

const EXPORT_SCALES = [1, 2, 3, 4];
const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];

function asciiCells(field, s, cols, rows, charCount, K) {
    const n = cols * rows;
    const toned = toneField(field, s, new Float32Array(n));
    const charIdx = new Uint16Array(n);
    const colorIdx = new Uint8Array(n);
    quantize(toned, cols, rows, charCount, s.dither, charIdx, ditherBuffer(cols, rows));
    colorBuckets(toned, s, K, colorIdx);
    return { charIdx, colorIdx };
}

function renderPixelPng(field, s, cols, rows, W, H) {
    const L = pixelLevelCount(s);
    const small = paintPixels({}, pixelLevels(field, s, cols, rows, L), pixelPalette(s, L).rgba, cols, rows);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, W, H);
    return canvas;
}

// The most common colour becomes the backdrop; every other horizontal run
// of equal pixels is one <rect>.
function renderPixelSvg(field, s, cols, rows, W, H) {
    const L = pixelLevelCount(s);
    const levels = pixelLevels(field, s, cols, rows, L);
    const { hex } = pixelPalette(s, L);
    const counts = new Uint32Array(L);
    for (let i = 0; i < levels.length; i++) counts[levels[i]]++;
    let bg = 0;
    for (let k = 1; k < L; k++) if (counts[k] > counts[bg]) bg = k;
    const cw = W / cols;
    const ch = H / rows;
    const f2 = (n) => String(Math.round(n * 100) / 100);
    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
        `<rect width="${W}" height="${H}" fill="${hex[bg]}"/>`,
    ];
    for (let r = 0; r < rows; r++) {
        let c = 0;
        while (c < cols) {
            const lv = levels[r * cols + c];
            let e = c + 1;
            while (e < cols && levels[r * cols + e] === lv) e++;
            if (lv !== bg) {
                out.push(`<rect x="${f2(c * cw)}" y="${f2(r * ch)}" width="${f2((e - c) * cw)}" height="${f2(ch)}" fill="${hex[lv]}"/>`);
            }
            c = e;
        }
    }
    out.push('</svg>');
    return out.join('\n');
}

function fontSizeFor(cellW, cellH) {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `100px ${FONT_STACK}`;
    const advance = probe.measureText('M').width / 100 || 0.6;
    return Math.max(1, Math.min(cellW / advance, cellH * 0.95));
}

// Pre-rendered (character x colour) glyph sprites for the live preview.
function buildAtlas(chars, s, cellW, cellH) {
    const fontSize = fontSizeFor(cellW, cellW / CHAR_ASPECT);
    const slotW = Math.ceil(cellW) + 2;
    // glyphs keep their size when line spacing is tightened, so they may
    // overhang their row
    const slotH = Math.ceil(Math.max(cellH, fontSize * 1.3)) + 2;
    let K = s.colorMode === 'gradient' ? GRADIENT_BUCKETS : 1;
    // keep the sprite sheet under ~16M px (Safari's canvas area limit)
    while (K > 2 && slotW * slotH * chars.length * K > 16e6) K >>= 1;
    const colors = paletteFor(s, K);
    K = colors.length;
    const total = chars.length * K;
    const perRow = Math.max(1, Math.floor(4096 / slotW));
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(total, perRow) * slotW;
    canvas.height = Math.ceil(total / perRow) * slotH;
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const sx = new Int32Array(total);
    const sy = new Int32Array(total);
    const blank = new Uint8Array(chars.length);
    for (let ci = 0; ci < chars.length; ci++) {
        blank[ci] = chars[ci].trim() === '' ? 1 : 0;
        for (let b = 0; b < K; b++) {
            const slot = ci * K + b;
            sx[slot] = (slot % perRow) * slotW;
            sy[slot] = Math.floor(slot / perRow) * slotH;
            if (blank[ci]) continue;
            ctx.fillStyle = colors[b];
            ctx.fillText(chars[ci], sx[slot] + slotW / 2, sy[slot] + slotH / 2 + fontSize * 0.35);
        }
    }
    return { canvas, slotW, slotH, K, sx, sy, blank };
}

function drawWithAtlas(ctx, W, H, cols, rows, charIdx, colorIdx, atlas, background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    const cw = W / cols;
    const ch = H / rows;
    const { canvas, slotW, slotH, K, sx, sy, blank } = atlas;
    const ox = cw / 2 - slotW / 2;
    const oy = ch / 2 - slotH / 2;
    for (let r = 0; r < rows; r++) {
        const y = Math.round(r * ch + oy);
        const base = r * cols;
        for (let c = 0; c < cols; c++) {
            const i = base + c;
            const ci = charIdx[i];
            if (blank[ci]) continue;
            const slot = ci * K + colorIdx[i];
            ctx.drawImage(canvas, sx[slot], sy[slot], slotW, slotH, Math.round(c * cw + ox), y, slotW, slotH);
        }
    }
}

function frameToText(field, s, cols, rows) {
    const chars = charsOf(s.ramp);
    const idx = new Uint16Array(field.length);
    const toned = toneField(field, s, new Float32Array(field.length));
    quantize(toned, cols, rows, chars.length, s.dither, idx, ditherBuffer(cols, rows));
    const lines = [];
    for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) line += chars[idx[r * cols + c]];
        lines.push(line);
    }
    return lines.join('\n');
}

function renderPngCanvas(field, s, cols, rows, W, H, transparent) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!transparent) {
        ctx.fillStyle = s.background;
        ctx.fillRect(0, 0, W, H);
    }
    const chars = charsOf(s.ramp);
    const colors = paletteFor(s, 64);
    const { charIdx, colorIdx } = asciiCells(field, s, cols, rows, chars.length, colors.length);
    const cw = W / cols;
    const ch = H / rows;
    const fontSize = fontSizeFor(cw, cw / CHAR_ASPECT);
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let current = -1;
    for (let r = 0; r < rows; r++) {
        const y = (r + 0.5) * ch + fontSize * 0.35;
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const glyph = chars[charIdx[i]];
            if (glyph.trim() === '') continue;
            if (colorIdx[i] !== current) {
                current = colorIdx[i];
                ctx.fillStyle = colors[current];
            }
            ctx.fillText(glyph, (c + 0.5) * cw, y);
        }
    }
    return canvas;
}

const escapeXml = (t) => t.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[m]));

// One <text> per row; runs of same-coloured glyphs share a <tspan> whose x
// list pins every character to its grid column.
function renderSvg(field, s, cols, rows, W, H, transparent) {
    const chars = charsOf(s.ramp);
    const colors = paletteFor(s, 64);
    const { charIdx, colorIdx } = asciiCells(field, s, cols, rows, chars.length, colors.length);
    const cw = W / cols;
    const ch = H / rows;
    const fontSize = fontSizeFor(cw, cw / CHAR_ASPECT);
    const f2 = (n) => String(Math.round(n * 100) / 100);

    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    ];
    if (!transparent) out.push(`<rect width="${W}" height="${H}" fill="${s.background}"/>`);
    out.push(`<g font-family="'SF Mono', ui-monospace, Menlo, Monaco, monospace" font-size="${f2(fontSize)}" text-anchor="middle" xml:space="preserve">`);
    for (let r = 0; r < rows; r++) {
        const spans = [];
        let runColor = -1;
        let runText = '';
        let runXs = [];
        const flush = () => {
            if (runText) spans.push(`<tspan x="${runXs.join(' ')}" fill="${colors[runColor]}">${escapeXml(runText)}</tspan>`);
            runText = '';
            runXs = [];
        };
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const glyph = chars[charIdx[i]];
            if (glyph.trim() === '') continue;
            if (colorIdx[i] !== runColor) {
                flush();
                runColor = colorIdx[i];
            }
            runText += glyph;
            runXs.push(f2((c + 0.5) * cw));
        }
        flush();
        if (spans.length) out.push(`<text y="${f2((r + 0.5) * ch + fontSize * 0.35)}">${spans.join('')}</text>`);
    }
    out.push('</g>', '</svg>');
    return out.join('\n');
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- Component ---------------------------------------------------------------

function ProceduralAscii() {
    const [settings, setSettings] = useState(DEFAULTS);
    const [menuOpen, setMenuOpen] = useState(true);
    const [isPlaying, setIsPlaying] = useState(true);
    const [rate, setRate] = useState(1);
    const [status, setStatus] = useState({
        value: 0, min: 0, max: 10, label: '0.0s', warming: false, cols: 0, rows: 0, buffer: 0,
    });

    // Export
    const [exportScale, setExportScale] = useState(2);
    const [transparentBg, setTransparentBg] = useState(false);
    const [loopSeconds, setLoopSeconds] = useState(10);
    const [loopFps, setLoopFps] = useState(24);
    const [loopBlend, setLoopBlend] = useState(1);
    const [isExporting, setIsExporting] = useState(false);
    const [copied, setCopied] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);

    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const settingsRef = useRef(settings);
    const settingsVersionRef = useRef(0);
    const playingRef = useRef(true);
    const rateRef = useRef(1);
    const engineRef = useRef(null);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    if (!engineRef.current) {
        engineRef.current = { perlin: new PerlinSource(), fluid: new FluidSource(), dims: null };
    }

    useEffect(() => {
        settingsRef.current = settings;
        settingsVersionRef.current += 1;
    }, [settings]);

    useEffect(() => () => {
        exportCanceledRef.current = true;
    }, []);

    const set = (key) => (value) => setSettings((prev) => ({ ...prev, [key]: value }));

    const activeSource = () => {
        const eng = engineRef.current;
        return settingsRef.current.mode === 'fluid' ? eng.fluid : eng.perlin;
    };

    // Preview loop: advance the active source, then redraw only when the
    // frame, settings or canvas size changed.
    useEffect(() => {
        const stage = stageRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const eng = engineRef.current;
        let raf;
        let last = performance.now();
        let lastStatus = 0;
        let drawnKey = '';
        let atlasKey = '';
        let atlas = null;
        let bufKey = '';
        let toned = null;
        let charIdx = null;
        let colorIdx = null;
        let errBuf = null;
        let paletteKey = '';
        let palette = null;
        const pixelCache = {};

        const tick = (now) => {
            raf = requestAnimationFrame(tick);
            const elapsed = Math.min(MAX_TICK_DT, Math.max(0, (now - last) / 1000));
            last = now;
            if (exportingRef.current) return;

            const s = settingsRef.current;
            const dpr = window.devicePixelRatio || 1;
            const W = Math.round(stage.clientWidth * dpr);
            const H = Math.round(stage.clientHeight * dpr);
            if (!W || !H) return;
            if (canvas.width !== W || canvas.height !== H) {
                canvas.width = W;
                canvas.height = H;
            }

            const dims = gridDims(W, H, s);
            const { cols, rows } = dims;
            eng.dims = dims;
            const src = s.mode === 'fluid' ? eng.fluid : eng.perlin;
            src.sync(s, dims);
            src.advance(elapsed, playingRef.current ? rateRef.current : 0, s);
            if (src.atStart) {
                src.atStart = false;
                playingRef.current = false;
                setIsPlaying(false);
            }

            const key = `${s.mode}|${src.version}|${settingsVersionRef.current}|${W}|${H}`;
            if (key !== drawnKey) {
                drawnKey = key;
                if (bufKey !== `${cols}x${rows}`) {
                    bufKey = `${cols}x${rows}`;
                    toned = new Float32Array(cols * rows);
                    charIdx = new Uint16Array(cols * rows);
                    colorIdx = new Uint8Array(cols * rows);
                    errBuf = ditherBuffer(cols, rows);
                }
                toneField(src.getField(s), s, toned);

                if (s.style === 'pixels') {
                    const L = pixelLevelCount(s);
                    const pKey = [L, s.colorMode, s.background, s.foreground, s.stops.join(','), s.reverseGradient].join('|');
                    if (pKey !== paletteKey) {
                        paletteKey = pKey;
                        palette = pixelPalette(s, L);
                    }
                    quantize(toned, cols, rows, L, s.dither, charIdx, errBuf);
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(paintPixels(pixelCache, charIdx, palette.rgba, cols, rows), 0, 0, W, H);
                } else {
                    const chars = charsOf(s.ramp);
                    const cw = W / cols;
                    const ch = H / rows;
                    const aKey = [s.ramp, s.colorMode, s.foreground, s.stops.join(','), Math.round(cw * 100), Math.round(ch * 100)].join('|');
                    if (aKey !== atlasKey) {
                        atlasKey = aKey;
                        atlas = buildAtlas(chars, s, cw, ch);
                    }
                    quantize(toned, cols, rows, chars.length, s.dither, charIdx, errBuf);
                    colorBuckets(toned, s, atlas.K, colorIdx);
                    drawWithAtlas(ctx, W, H, cols, rows, charIdx, colorIdx, atlas, s.background);
                }
            }

            if (now - lastStatus > 100) {
                lastStatus = now;
                const tl = src.timeline(s);
                const next = { buffer: 0, ...tl, value: Math.round(tl.value * 100) / 100, cols, rows };
                setStatus((prev) => (
                    Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next
                ));
            }
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    // ---- Playback -------------------------------------------------------------

    const setPlaying = useCallback((v) => {
        playingRef.current = v;
        setIsPlaying(v);
    }, []);

    const togglePlay = useCallback(() => {
        if (exportingRef.current) return;
        setPlaying(!playingRef.current);
    }, [setPlaying]);

    const setRateValue = useCallback((r) => {
        rateRef.current = r;
        setRate(r);
    }, []);

    const stepFrame = useCallback((dir) => {
        if (exportingRef.current) return;
        setPlaying(false);
        activeSource().stepFrame(dir, settingsRef.current);
    }, [setPlaying]);

    const seek = (v) => {
        if (exportingRef.current) return;
        activeSource().seek(v, settingsRef.current);
    };

    const restart = () => {
        if (exportingRef.current) return;
        activeSource().reset();
    };

    // Space toggles playback, arrows step a frame (ignored while typing).
    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
            if (e.target && e.target.isContentEditable) return;
            if (e.code === 'Space') {
                e.preventDefault();
                togglePlay();
            } else if (e.key === 'ArrowRight') {
                stepFrame(1);
            } else if (e.key === 'ArrowLeft') {
                stepFrame(-1);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, stepFrame]);

    // ---- Exports --------------------------------------------------------------

    const currentFrame = () => {
        const eng = engineRef.current;
        const s = settingsRef.current;
        const { cols, rows } = eng.dims || {};
        return { field: activeSource().getField(s), cols, rows, s };
    };

    const exportSize = () => {
        const stage = stageRef.current;
        return {
            w: Math.max(1, Math.round((stage ? stage.clientWidth : 1280) * exportScale)),
            h: Math.max(1, Math.round((stage ? stage.clientHeight : 720) * exportScale)),
        };
    };

    const exportTxt = () => {
        const { field, cols, rows, s } = currentFrame();
        if (!cols || s.style === 'pixels') return;
        const text = frameToText(field, s, cols, rows);
        downloadBlob(new Blob([text], { type: 'text/plain' }), `${s.mode}_${cols}x${rows}.txt`);
    };

    const exportPng = () => {
        const { field, cols, rows, s } = currentFrame();
        if (!cols) return;
        const { w, h } = exportSize();
        const canvas = s.style === 'pixels'
            ? renderPixelPng(field, s, cols, rows, w, h)
            : renderPngCanvas(field, s, cols, rows, w, h, transparentBg);
        canvas.toBlob((blob) => {
            if (blob) downloadBlob(blob, `${s.mode}_${w}x${h}.png`);
        }, 'image/png');
    };

    const exportSvg = () => {
        const { field, cols, rows, s } = currentFrame();
        if (!cols) return;
        const stage = stageRef.current;
        const w = Math.round(stage.clientWidth);
        const h = Math.round(stage.clientHeight);
        const svg = s.style === 'pixels'
            ? renderPixelSvg(field, s, cols, rows, w, h)
            : renderSvg(field, s, cols, rows, w, h, transparentBg);
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${s.mode}_${cols}x${rows}.svg`);
    };

    // Multi-frame txt in the python tool's format (frames separated by
    // ---FRAME---), for AsciiBackground. Perlin renders one full time loop;
    // fluid simulates forward from the current state and crossfades its end
    // back into its start.
    const exportLoop = useCallback(async () => {
        if (exportingRef.current) return;
        const eng = engineRef.current;
        const s = { ...settingsRef.current };
        const { cols, rows } = eng.dims || {};
        if (!cols || s.style === 'pixels') return;
        const fluid = s.mode === 'fluid';
        if (fluid && eng.fluid.warmupLeft > 0) return;

        const fps = clamp(Math.round(loopFps), 1, 120);
        const seconds = fluid ? loopSeconds : s.loopDuration;
        const n = Math.max(1, Math.round(seconds * fps));
        const blend = fluid ? Math.min(Math.round(loopBlend * fps), Math.floor(n / 2)) : 0;
        const total = n + blend;

        const wasPlaying = playingRef.current;
        setPlaying(false);
        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportProgress(0);

        const texts = [];
        const head = [];
        const buf = new Float32Array(cols * rows);
        const t0 = eng.perlin.t;
        try {
            for (let i = 0; i < total; i++) {
                if (exportCanceledRef.current) break;
                let frame;
                if (fluid) {
                    eng.fluid.simulateFrame(1 / fps, s);
                    frame = Float32Array.from(eng.fluid.getField(s));
                    if (i < blend) {
                        head.push(frame);
                    } else {
                        const k = i - n;
                        if (k >= 0) {
                            const a = (k + 1) / (blend + 1);
                            const h = head[k];
                            for (let j = 0; j < frame.length; j++) frame[j] = (1 - a) * frame[j] + a * h[j];
                        }
                    }
                } else {
                    frame = eng.perlin.fieldAt(buf, t0 + i / fps, s);
                }
                if (i >= blend) texts.push(frameToText(frame, s, cols, rows));

                if (i % 4 === 0) {
                    setExportProgress((i + 1) / total);
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
                }
            }
        } finally {
            exportingRef.current = false;
            setIsExporting(false);
            setExportProgress(0);
            if (wasPlaying) setPlaying(true);
        }

        if (!exportCanceledRef.current && texts.length === n) {
            const text = texts.join(`\n${FRAME_DELIMITER}\n`);
            downloadBlob(new Blob([text], { type: 'text/plain' }), `${s.mode}_loop_${cols}x${rows}_${fps}fps.txt`);
        }
    }, [loopFps, loopSeconds, loopBlend, setPlaying]);

    const cancelExport = useCallback(() => {
        exportCanceledRef.current = true;
    }, []);

    // Settings that differ from the defaults (plus the playback rate), as the
    // object literal src/data/footerField.js and ProceduralField take.
    const copySettings = () => {
        const out = {};
        Object.keys(DEFAULTS).forEach((k) => {
            if (JSON.stringify(settings[k]) !== JSON.stringify(DEFAULTS[k])) out[k] = settings[k];
        });
        if (rate !== 1) out.rate = rate;
        const text = JSON.stringify(out, null, 4);
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    // ---- UI helpers -----------------------------------------------------------

    const numRow = (label, value, onCommit, min, max, step, opts = {}) => (
        <div className={styles.vfx_row} key={label}>
            <span className={styles.vfx_label} title={opts.title || label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={opts.disabled}
                onChange={(e) => onCommit(parseFloat(e.target.value))}
            />
            <VfxNumberField
                value={value}
                min={min}
                max={max}
                step={step}
                disabled={opts.disabled}
                onCommit={onCommit}
            />
        </div>
    );

    const sliderRow = (label, key, min, max, step, opts) => (
        numRow(label, settings[key], (n) => set(key)(opts && opts.int ? Math.round(n) : n), min, max, step, opts)
    );

    const switchRow = (label, value, onToggle) => (
        <div
            className={styles.vfx_checkRow}
            key={label}
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${value ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );

    const segRow = (options, value, onPick, columns) => (
        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${columns || options.length}, 1fr)` }}>
            {options.map(([id, name]) => (
                <button
                    type="button"
                    key={id}
                    className={`${styles.vfx_segBtn} ${value === id ? styles.vfx_segBtnOn : ''}`}
                    onClick={() => onPick(id)}
                >
                    {name}
                </button>
            ))}
        </div>
    );

    const colorRow = (label, value, onChange, trailing) => (
        <div className={styles.vfx_row} key={label}>
            <span className={styles.vfx_label}>{label}</span>
            <input
                type="color"
                className={styles.vfx_color}
                style={{ gridColumn: trailing ? '2 / 3' : '2 / 4' }}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            {trailing}
        </div>
    );

    const buttonStyle = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 };

    const isFluid = settings.mode === 'fluid';
    const isPixels = settings.style === 'pixels';
    const direction = rate < 0 ? -1 : 1;
    const charsetId = (CHARSET_PRESETS.find((p) => p.chars === settings.ramp) || { id: 'custom' }).id;
    const colorPresetId = (COLOR_PRESETS.find((p) => (
        p.background === settings.background
        && p.colorMode === settings.colorMode
        && (p.colorMode === 'solid'
            ? p.foreground === settings.foreground
            : p.stops.join() === settings.stops.join())
    )) || { id: 'custom' }).id;

    const updateStop = (i, color) => set('stops')(settings.stops.map((c, j) => (j === i ? color : c)));
    const removeStop = (i) => set('stops')(settings.stops.filter((_, j) => j !== i));
    const addStop = () => set('stops')([...settings.stops, settings.stops[settings.stops.length - 1] || '#ffffff']);

    const { w: pngW, h: pngH } = stageRef.current ? exportSize() : { w: 0, h: 0 };

    return (
        <div className={styles.vfx}>
            <div ref={stageRef} className={styles.vfx_fullStage}>
                <canvas
                    ref={canvasRef}
                    className={styles.vfx_asciiCanvas}
                    onClick={togglePlay}
                />
            </div>

            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    className={`${styles.vfx_toggle} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {menuOpen && (
                <div className={styles.vfx_panel}>
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Procedural Ascii</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Source */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Source</div>
                        {segRow([['perlin', 'Perlin Noise'], ['fluid', 'Fluid Sim']], settings.mode, set('mode'))}
                        <div style={{ marginBottom: -9 }}>
                            {segRow([['ascii', 'Ascii'], ['pixels', 'Pixels']], settings.style, set('style'))}
                        </div>
                    </div>

                    {/* Playback */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Playback</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 10 }}>
                            <button
                                type="button"
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                className={styles.vfx_iconBtn}
                                onClick={togglePlay}
                                disabled={isExporting}
                                style={{ width: 34, height: 34, flex: '0 0 auto' }}
                            >
                                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <input
                                type="range"
                                className={styles.vfx_slider}
                                min={status.min}
                                max={status.max}
                                step={0.01}
                                value={clamp(status.value, status.min, status.max)}
                                disabled={isExporting || status.warming || status.max <= status.min}
                                onChange={(e) => seek(parseFloat(e.target.value))}
                            />
                            <span className={styles.vfx_value} style={{ flex: '0 0 auto', minWidth: 44 }}>
                                {status.label}
                            </span>
                        </div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                            <button type="button" className={styles.vfx_segBtn} title="Step back" aria-label="Step back" onClick={() => stepFrame(-1)}>
                                <StepBack size={13} />
                            </button>
                            <button
                                type="button"
                                className={`${styles.vfx_segBtn} ${direction < 0 ? styles.vfx_segBtnOn : ''}`}
                                title="Play in reverse"
                                aria-label="Play in reverse"
                                onClick={() => { setRateValue(-Math.abs(rate || 1)); setPlaying(true); }}
                            >
                                <Rewind size={13} />
                            </button>
                            <button
                                type="button"
                                className={`${styles.vfx_segBtn} ${direction > 0 ? styles.vfx_segBtnOn : ''}`}
                                title="Play forward"
                                aria-label="Play forward"
                                onClick={() => { setRateValue(Math.abs(rate || 1)); setPlaying(true); }}
                            >
                                <FastForward size={13} />
                            </button>
                            <button type="button" className={styles.vfx_segBtn} title="Step forward" aria-label="Step forward" onClick={() => stepFrame(1)}>
                                <StepForward size={13} />
                            </button>
                        </div>
                        {numRow('Speed x', rate, setRateValue, -4, 4, 0.05, { title: 'Playback rate; negative plays in reverse' })}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${SPEED_PRESETS.length}, 1fr)`, marginBottom: 0 }}>
                            {SPEED_PRESETS.map((sp) => (
                                <button
                                    type="button"
                                    key={sp}
                                    className={`${styles.vfx_segBtn} ${Math.abs(rate) === sp ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setRateValue(sp * direction)}
                                >
                                    {sp}x
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            {isFluid
                                ? `The flow can't run backwards, so reverse replays a rewind buffer (${(status.buffer || 0).toFixed(1)}s held). Playing forward catches back up to live.`
                                : 'Noise time is exact in both directions. Space = play / pause, arrows = step.'}
                        </div>
                    </div>

                    {/* Grid */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Grid</div>
                        {isPixels
                            ? sliderRow('Pixel Size', 'pixelSize', 1, 64, 1, { int: true, title: 'Screen pixels per cell; 1 = full resolution' })
                            : (
                                <>
                                    {sliderRow('Columns', 'columns', 40, 400, 1, { int: true })}
                                    {sliderRow('Line Space', 'lineSpacing', 0.3, 1.5, 0.01, { title: 'Row height relative to a normal line' })}
                                </>
                            )}
                        {sliderRow('Seed', 'seed', 0, 9999, 1, { int: true })}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 0 }}>
                            <button type="button" className={styles.vfx_segBtn} style={{ gap: 6 }} onClick={() => set('seed')(Math.floor(Math.random() * 10000))}>
                                <Shuffle size={12} />
                                Random Seed
                            </button>
                            <button type="button" className={styles.vfx_segBtn} style={{ gap: 6 }} onClick={restart}>
                                <RotateCcw size={12} />
                                Restart
                            </button>
                        </div>
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            {status.cols} x {status.rows}
                            {isPixels
                                ? ' pixels. 1 = full resolution, which is slow with warped noise or the fluid sim.'
                                : ' characters. Rows follow the viewport and line spacing.'}
                        </div>
                    </div>

                    {/* Perlin parameters */}
                    {!isFluid && (
                        <div className={styles.vfx_section}>
                            <div className={styles.vfx_sectionTitle}>Noise</div>
                            {segRow([['fbm', 'Fbm'], ['turbulence', 'Turbulence'], ['ridged', 'Ridged']], settings.fractal, set('fractal'))}
                            {sliderRow('Scale', 'scale', 2, 200, 0.5, { title: 'Base feature size in character widths' })}
                            {sliderRow('Octaves', 'octaves', 1, 8, 1, { int: true })}
                            {sliderRow('Persistence', 'persistence', 0, 1, 0.01)}
                            {sliderRow('Lacunarity', 'lacunarity', 1, 4, 0.01)}
                            {sliderRow('Warp', 'warp', 0, 6, 0.05, { title: 'Domain warp strength in lattice cells' })}
                            {sliderRow('Evolve', 'evolve', 0, 3, 0.01, { title: 'Lattice cells per second through time' })}
                            {sliderRow('Offset X', 'offsetX', -50, 50, 0.1)}
                            {sliderRow('Offset Y', 'offsetY', -50, 50, 0.1)}
                            {sliderRow('Drift X', 'driftX', -5, 5, 0.01)}
                            {sliderRow('Drift Y', 'driftY', -5, 5, 0.01)}
                            {sliderRow('Loop s', 'loopDuration', 1, 60, 0.5, { title: 'Length of the seamless time loop' })}
                            <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                Fbm: smooth clouds. Turbulence: billowy creases. Ridged: sharp
                                veins. Warp 1-4 gives marbled shapes. Drift breaks the seamless loop.
                            </div>
                        </div>
                    )}

                    {/* Fluid parameters */}
                    {isFluid && (
                        <>
                            <div className={styles.vfx_section}>
                                <div className={styles.vfx_sectionTitle}>Simulation</div>
                                {segRow([[64, '64'], [128, '128'], [256, '256']], settings.grid, set('grid'))}
                                {sliderRow('Scale', 'flowScale', 0.25, 4, 0.01, { title: 'Zoom into (> 1) or tile (< 1) the flow' })}
                                {sliderRow('Scale X', 'flowScaleX', 0.25, 4, 0.01, { title: 'Horizontal scale multiplier' })}
                                {sliderRow('Scale Y', 'flowScaleY', 0.25, 4, 0.01, { title: 'Vertical scale multiplier' })}
                                {sliderRow('Sim Speed', 'simSpeed', 0.05, 3, 0.01, { title: 'Simulation time per second of playback' })}
                                {sliderRow('Viscosity', 'viscosity', 0, 0.005, 0.00005)}
                                {sliderRow('Drag', 'drag', 0, 1, 0.01)}
                                {sliderRow('Force', 'force', 0, 10, 0.1, { title: 'Strength of the stirring force' })}
                                {sliderRow('Force k', 'forceK', 1, 16, 0.5, { title: 'Stirring wavenumber (eddies across the width)' })}
                                {sliderRow('Force tau', 'forceTau', 0.1, 10, 0.1, { title: 'How long the stirring pattern persists' })}
                                {sliderRow('CFL', 'cfl', 0.1, 0.9, 0.01, { title: 'Time step safety factor' })}
                                {sliderRow('Warmup s', 'warmup', 0, 20, 0.5)}
                                <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                    {status.warming ? 'Warming up the flow… ' : ''}
                                    Grid is the simulation resolution (256 is heavy). Scale above 1
                                    zooms into the flow, below 1 tiles its periodic domain. Seed,
                                    grid and warmup take effect on restart.
                                </div>
                            </div>

                            <div className={styles.vfx_section}>
                                <div className={styles.vfx_sectionTitle}>Rendering</div>
                                {segRow([['trails', 'Trails'], ['vorticity', 'Vorticity'], ['speed', 'Speed']], settings.render, set('render'))}
                                {settings.render === 'trails' && (
                                    <>
                                        {sliderRow('Particles', 'particles', 1, 3000, 1, { int: true })}
                                        {sliderRow('Fade s', 'fade', 0.1, 10, 0.1, { title: 'Seconds for a trail to fade to ~37%' })}
                                        {sliderRow('Respawn', 'respawn', 0, 1, 0.01, { title: 'Fraction of particles relocated per second' })}
                                        {sliderRow('Supersample', 'supersample', 1, 6, 1, { int: true })}
                                    </>
                                )}
                                {sliderRow('Exposure', 'exposure', 0.1, 6, 0.05)}
                            </div>
                        </>
                    )}

                    {/* Characters */}
                    {!isPixels && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Characters</div>
                        <select
                            className={styles.vfx_select}
                            style={{ marginBottom: 8 }}
                            value={charsetId}
                            onChange={(e) => {
                                const p = CHARSET_PRESETS.find((c) => c.id === e.target.value);
                                if (p) set('ramp')(p.chars);
                            }}
                        >
                            {CHARSET_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                            {charsetId === 'custom' && <option value="custom">Custom</option>}
                        </select>
                        <input
                            type="text"
                            className={styles.vfx_text}
                            style={{ marginBottom: 10 }}
                            value={settings.ramp}
                            onChange={(e) => set('ramp')(e.target.value)}
                            placeholder="sparse -> dense ramp"
                            spellCheck={false}
                        />
                        {switchRow('Invert (dense <-> sparse)', settings.invert, () => set('invert')(!settings.invert))}
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ textAlign: 'center' }}
                            onClick={() => set('ramp')(Array.from(settings.ramp).reverse().join(''))}
                        >
                            Reverse Character Order
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Characters ordered sparsest to densest; low field values map to
                            the first character.
                        </div>
                    </div>
                    )}

                    {/* Tone */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Tone</div>
                        {sliderRow('Contrast', 'contrast', 0, 4, 0.01)}
                        {sliderRow('Brightness', 'brightness', -1, 1, 0.01)}
                        {sliderRow('Gamma', 'gamma', 0.1, 4, 0.01, { title: '> 1 darkens mid tones, < 1 brightens them' })}
                    </div>

                    {/* Dither */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Dither</div>
                        {segRow([['none', 'None'], ['bayer', 'Bayer'], ['floyd', 'Floyd'], ['atkinson', 'Atkinson']], settings.dither, set('dither'))}
                        {isPixels && sliderRow('Levels', 'levels', 2, 64, 1, { int: true, title: 'Colours sampled from the palette' })}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            {isPixels
                                ? 'Levels is how many colours are taken from the palette. With dithering off, raise it for smooth shading.'
                                : 'Dithers between neighbouring characters of the ramp.'}
                            {' '}Bayer is an ordered pattern; Floyd-Steinberg and Atkinson diffuse error.
                        </div>
                    </div>

                    {/* Colour */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Colour</div>
                        <select
                            className={styles.vfx_select}
                            style={{ marginBottom: 10 }}
                            value={colorPresetId}
                            onChange={(e) => {
                                const p = COLOR_PRESETS.find((c) => c.id === e.target.value);
                                if (!p) return;
                                const { id, name, ...fields } = p;
                                setSettings((prev) => ({ ...prev, ...fields }));
                            }}
                        >
                            {COLOR_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                            {colorPresetId === 'custom' && <option value="custom">Custom</option>}
                        </select>
                        {segRow([['solid', 'Solid'], ['gradient', 'Gradient']], settings.colorMode, set('colorMode'))}
                        {colorRow('Background', settings.background, set('background'))}
                        {settings.colorMode === 'solid' && colorRow(isPixels ? 'Foreground' : 'Text', settings.foreground, set('foreground'))}
                        {settings.colorMode === 'solid' && isPixels && (
                            <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                Pixels blend from the background to the foreground colour.
                            </div>
                        )}
                        {settings.colorMode === 'gradient' && (
                            <>
                                {settings.stops.map((c, i) => colorRow(
                                    i === 0 ? 'Sparse' : (i === settings.stops.length - 1 ? 'Dense' : `Stop ${i + 1}`),
                                    c,
                                    (v) => updateStop(i, v),
                                    <button
                                        type="button"
                                        aria-label="Remove stop"
                                        className={styles.vfx_iconBtn}
                                        style={{ justifySelf: 'end' }}
                                        disabled={settings.stops.length <= 2}
                                        onClick={() => removeStop(i)}
                                    >
                                        <X size={13} />
                                    </button>,
                                ))}
                                <button
                                    type="button"
                                    className={styles.vfx_select}
                                    style={{ ...buttonStyle, margin: '4px 0 10px' }}
                                    disabled={settings.stops.length >= MAX_STOPS}
                                    onClick={addStop}
                                >
                                    <Plus size={13} />
                                    Add Stop
                                </button>
                                {switchRow('Reverse Gradient', settings.reverseGradient, () => set('reverseGradient')(!settings.reverseGradient))}
                                <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                    {isPixels
                                        ? 'The gradient runs from low field values to high (after invert); the background colour is unused.'
                                        : 'The gradient runs from the sparsest character to the densest (after invert); reverse it to light the sparse end instead.'}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export Frame</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                            {[['TXT', exportTxt], ['PNG', exportPng], ['SVG', exportSvg]].map(([name, fn]) => (
                                <button
                                    type="button"
                                    key={name}
                                    className={styles.vfx_select}
                                    style={buttonStyle}
                                    disabled={isExporting || (isPixels && name === 'TXT')}
                                    onClick={fn}
                                >
                                    <Download size={13} />
                                    {name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                            <span className={styles.vfx_label}>PNG Scale</span>
                            <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${EXPORT_SCALES.length}, 1fr)`, marginBottom: 0 }}>
                                {EXPORT_SCALES.map((sc) => (
                                    <button
                                        type="button"
                                        key={sc}
                                        className={`${styles.vfx_segBtn} ${exportScale === sc ? styles.vfx_segBtnOn : ''}`}
                                        onClick={() => setExportScale(sc)}
                                    >
                                        {sc}x
                                    </button>
                                ))}
                            </div>
                        </div>
                        {!isPixels && switchRow('Transparent Background', transparentBg, () => setTransparentBg((v) => !v))}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Exports the frame on screen right now. PNG: {pngW} x {pngH} px.
                            {isPixels
                                ? ' SVG draws runs of pixels as rects (large at small pixel sizes).'
                                : ' SVG keeps every glyph as live text.'}
                        </div>
                    </div>

                    {!isPixels && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export Loop</div>
                        {isFluid
                            ? numRow('Duration s', loopSeconds, setLoopSeconds, 1, 60, 0.5, { disabled: isExporting })
                            : null}
                        {numRow('FPS', loopFps, (n) => setLoopFps(Math.round(n)), 6, 60, 1, { disabled: isExporting })}
                        {isFluid && numRow('Blend s', loopBlend, setLoopBlend, 0, 5, 0.1, { disabled: isExporting, title: 'Crossfade from the end back to the start' })}
                        {!isExporting && (
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={buttonStyle}
                                disabled={isFluid && status.warming}
                                onClick={exportLoop}
                            >
                                <Download size={13} />
                                Export Animation (txt)
                            </button>
                        )}
                        {!isExporting && (
                            <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                {isFluid
                                    ? 'Simulates forward from the current state and crossfades the end into the start. Frames are separated by ---FRAME---, ready for AsciiBackground.'
                                    : `Renders one full ${settings.loopDuration}s noise loop (set by Loop s). Frames are separated by ---FRAME---, ready for AsciiBackground.`}
                            </div>
                        )}
                        {isExporting && (
                            <>
                                <div className={styles.vfx_progress} style={{ marginTop: 8 }}>
                                    <div
                                        className={styles.vfx_progressFill}
                                        style={{ width: `${Math.round(exportProgress * 100)}%` }}
                                    />
                                </div>
                                <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                                    Rendering frames · {Math.round(exportProgress * 100)}%
                                </div>
                                <button
                                    type="button"
                                    className={`${styles.vfx_select} ${styles.vfx_recActive}`}
                                    style={{ textAlign: 'center', marginTop: 8 }}
                                    onClick={cancelExport}
                                >
                                    Cancel
                                </button>
                            </>
                        )}
                    </div>
                    )}

                    <div className={styles.vfx_section}>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ ...buttonStyle, marginBottom: 8 }}
                            onClick={copySettings}
                        >
                            {copied ? <Check size={13} /> : <Copy size={13} />}
                            {copied ? 'Copied' : 'Copy Settings'}
                        </button>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ textAlign: 'center' }}
                            onClick={() => setSettings(DEFAULTS)}
                        >
                            Reset Defaults
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            Click the preview or press space to play / pause. Type a value
                            next to any slider to override its range. Copy Settings copies
                            the changed values, ready to paste into a site field config.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ProceduralAscii;
