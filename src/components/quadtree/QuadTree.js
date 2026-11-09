import React, {
    useState, useEffect, useRef, useCallback,
} from 'react';
import {
    Play, Pause, SlidersHorizontal, X, Download, Plus, Shuffle, StepBack, StepForward,
    Upload, ChevronRight, Copy, Check, RotateCcw,
} from 'lucide-react';
import VfxNumberField from '../VfxNumberField';
import vfx from '../vfx.module.css';
import styles from './quadtree.module.css';
import Renderer from './engine/Renderer';
import { Analysis, buildTree } from './engine/tree';
import { ImageSeed, VideoSeed, ProceduralSeed } from './engine/seeds';
import {
    outputSize, activeSeed, effective, previewFrame, renderFrame, exportMp4, exportPng, exportSvg,
} from './engine/pipeline';
import { canEncodeMp4 } from '../../lib/mp4Writer';
import {
    listPresets, loadPreset, savePreset, deletePreset, downloadPreset, readPresetFile,
} from './presets';
import { DEFAULTS as PROC_DEFAULTS } from '../../lib/procedural';
import {
    DEFAULTS, PRESETS, ASPECTS, RAMPS,
} from './settings';

// Quad Trees: a seed (gradient, bouncing shapes, procedural art, an image, a
// or a video) subdivided wherever it varies, drawn as
// squares, circles or glyphs, with glow and a timeline that loops. The
// engine is in ./engine; this is the panel, the transport and the loop.

const wrap = (v, n) => ((v % n) + n) % n;
const STEP = 1 / 30;
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const GRADE_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'hue', 'gamma', 'lift', 'gain', 'invert', 'posterize', 'blur'];

const fmt = (t) => `${t.toFixed(2)}s`;

// ---- Small controls --------------------------------------------------------------

function Slider({
    label, value, min, max, step, onChange, int, title, disabled,
}) {
    const commit = (n) => onChange(int ? Math.round(n) : n);
    return (
        <div className={vfx.vfx_row}>
            <span className={vfx.vfx_label} title={title || label}>{label}</span>
            <input
                type="range"
                className={vfx.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                onChange={(e) => commit(parseFloat(e.target.value))}
            />
            <VfxNumberField value={value} min={min} max={max} step={step} disabled={disabled} onCommit={commit} />
        </div>
    );
}

function Seg({
    options, value, onPick, columns,
}) {
    return (
        <div className={vfx.vfx_segRow} style={{ gridTemplateColumns: `repeat(${columns || options.length}, 1fr)` }}>
            {options.map(([id, name]) => (
                <button
                    type="button"
                    key={String(id)}
                    className={`${vfx.vfx_segBtn} ${value === id ? vfx.vfx_segBtnOn : ''}`}
                    onClick={() => onPick(id)}
                >
                    {name}
                </button>
            ))}
        </div>
    );
}

function Switch({ label, value, onChange }) {
    return (
        <div
            className={vfx.vfx_checkRow}
            role="switch"
            aria-checked={!!value}
            tabIndex={0}
            onClick={() => onChange(!value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(!value); } }}
        >
            <span>{label}</span>
            <span className={`${vfx.vfx_switch} ${value ? vfx.vfx_switchOn : ''}`}>
                <span className={vfx.vfx_knob} />
            </span>
        </div>
    );
}

function ColorRow({ label, value, onChange }) {
    return (
        <div className={vfx.vfx_row}>
            <span className={vfx.vfx_label}>{label}</span>
            <input
                type="color"
                className={vfx.vfx_color}
                style={{ gridColumn: '2 / 4' }}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
        </div>
    );
}

function Stops({ stops, onChange, max = 8 }) {
    return (
        <div className={styles.stops}>
            {stops.map((c, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div className={styles.stop} key={i}>
                    <input
                        type="color"
                        className={vfx.vfx_color}
                        value={c}
                        onChange={(e) => onChange(stops.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    {stops.length > 1 && (
                        <button type="button" aria-label="Remove colour" onClick={() => onChange(stops.filter((_, j) => j !== i))}>×</button>
                    )}
                </div>
            ))}
            {stops.length < max && (
                <button
                    type="button"
                    className={vfx.vfx_segBtn}
                    aria-label="Add colour"
                    onClick={() => onChange([...stops, stops[stops.length - 1] || '#ffffff'])}
                >
                    <Plus size={12} />
                </button>
            )}
        </div>
    );
}

function Section({
    id, title, open, onToggle, children, extra,
}) {
    const isOpen = open[id] !== false;
    return (
        <div className={vfx.vfx_section}>
            <div
                className={`${styles.sectionHead} ${isOpen ? '' : styles.closed}`}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => onToggle(id)}
                onKeyDown={(e) => { if (e.key === 'Enter') onToggle(id); }}
            >
                <div className={vfx.vfx_sectionTitle}>{title}</div>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {extra}
                    <ChevronRight size={13} className={`${styles.chev} ${isOpen ? styles.chevOpen : ''}`} />
                </span>
            </div>
            {isOpen && children}
        </div>
    );
}

const Hint = ({ children, style }) => <div className={vfx.vfx_hint} style={{ marginTop: 8, ...style }}>{children}</div>;

// ---- Export dialog ------------------------------------------------------------------

const QUALITY = [[0.12, 'Draft'], [0.3, 'High'], [0.7, 'Max']];

function ExportDialog({
    run, loop, outW, outH, hasSound, onClose,
}) {
    const [scale, setScale] = useState(1);
    const [quality, setQuality] = useState(0.3);
    const [fps, setFps] = useState(30);
    const [t0, setT0] = useState(0);
    const [t1, setT1] = useState(loop);
    const [sound, setSound] = useState(true);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const [label, setLabel] = useState('');
    const [error, setError] = useState('');
    const cancel = useRef(false);
    const w = Math.round((outW * scale) / 2) * 2;
    const h = Math.round((outH * scale) / 2) * 2;

    const go = async () => {
        setBusy(true);
        setError('');
        cancel.current = false;
        try {
            const out = await run({
                scale, quality, fps, t0, t1, sound,
            }, (f, l) => { setProgress(f); setLabel(l); }, () => cancel.current);
            if (out) onClose();
        } catch (e) {
            setError(e.message || String(e));
        }
        setBusy(false);
    };

    return (
        <div className={styles.modal} onClick={() => { if (!busy) onClose(); }} role="presentation">
            <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export MP4">
                <h2 className={styles.dialogTitle}>Export MP4</h2>
                <div className={vfx.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                    <span className={vfx.vfx_label}>Size</span>
                    <select className={vfx.vfx_select} value={scale} disabled={busy} onChange={(e) => setScale(Number(e.target.value))}>
                        {[0.5, 1, 1.5, 2].map((sc) => <option key={sc} value={sc}>{`${sc}× · ${Math.round((outW * sc) / 2) * 2}×${Math.round((outH * sc) / 2) * 2}`}</option>)}
                    </select>
                </div>
                <div className={vfx.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                    <span className={vfx.vfx_label}>Quality</span>
                    <select className={vfx.vfx_select} value={quality} disabled={busy} onChange={(e) => setQuality(Number(e.target.value))}>
                        {QUALITY.map(([q, l]) => <option key={q} value={q}>{l}</option>)}
                    </select>
                </div>
                <Slider label="Frame rate" value={fps} min={12} max={60} step={1} int onChange={(v) => setFps(Math.max(1, v))} disabled={busy} />
                <Slider label="From s" value={t0} min={0} max={loop} step={0.01} onChange={(v) => setT0(Math.max(0, v))} disabled={busy} />
                <Slider label="To s" value={t1} min={0} max={loop * 4} step={0.01} onChange={(v) => setT1(Math.max(t0 + 0.05, v))} disabled={busy} />
                {hasSound && <Switch label="Include sound" value={sound} onChange={setSound} />}
                <Hint>
                    {`${w}×${h}, ${(t1 - t0).toFixed(2)}s, ${Math.round((t1 - t0) * fps)} frames. Rendered offline and frame-exact (WebCodecs), supersampled below 4K. Past the loop length it loops.`}
                </Hint>
                {busy && (
                    <>
                        <div className={vfx.vfx_progress} style={{ marginTop: 10 }}>
                            <div className={vfx.vfx_progressFill} style={{ width: `${Math.round(progress * 100)}%` }} />
                        </div>
                        <Hint>{label}</Hint>
                    </>
                )}
                {error && <Hint style={{ opacity: 1 }}><span className={styles.warn}>{error}</span></Hint>}
                <div className={styles.buttons}>
                    {!busy && <button type="button" className={vfx.vfx_select} style={{ textAlign: 'center' }} onClick={go}>Export</button>}
                    {busy && <button type="button" className={`${vfx.vfx_select} ${vfx.vfx_recActive}`} style={{ textAlign: 'center' }} onClick={() => { cancel.current = true; }}>Cancel</button>}
                    {!busy && <button type="button" className={vfx.vfx_select} style={{ textAlign: 'center' }} onClick={onClose}>Close</button>}
                </div>
            </div>
        </div>
    );
}

// ---- The tool -----------------------------------------------------------------------

function QuadTree() {
    const [s, setS] = useState(DEFAULTS);
    const [menuOpen, setMenuOpen] = useState(true);
    const [playing, setPlayingState] = useState(true);
    const [rate, setRateState] = useState(1);
    const [open, setOpen] = useState({
        noise: true, grade: false, post: false, output: true,
    });
    const [loaded, setLoaded] = useState({});
    const [busySeed, setBusySeed] = useState('');
    const [seedError, setSeedError] = useState('');
    const [stats, setStats] = useState({
        count: 0, ms: 0, aw: 0, ah: 0, capped: false, bake: 0,
    });
    const [glError, setGlError] = useState('');
    const [exporting, setExporting] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [pngScale, setPngScale] = useState(2);
    const [copied, setCopied] = useState(false);
    const [dropping, setDropping] = useState(false);
    const [procText, setProcText] = useState('');
    const [procMsg, setProcMsg] = useState('');
    // Presets
    const [presets, setPresets] = useState(null);
    const [presetName, setPresetName] = useState('');
    const [presetMsg, setPresetMsg] = useState('');

    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const rangeRef = useRef(null);
    const timeRef = useRef(null);
    const fileRef = useRef(null);
    const presetFileRef = useRef(null);
    const settingsRef = useRef(s);
    const verRef = useRef(0);
    const loadedRef = useRef({});
    const procRef = useRef(null);
    const rendererRef = useRef(null);
    const clockRef = useRef({ t: 0, playing: true, rate: 1 });
    const dirtyRef = useRef(true);
    const exportingRef = useRef(false);
    const treeRef = useRef(null);
    const scrubbingRef = useRef(false);
    const loopRef = useRef(DEFAULTS.loop);

    if (!procRef.current) procRef.current = new ProceduralSeed();

    useEffect(() => {
        settingsRef.current = s;
        verRef.current += 1;
    }, [s]);

    const set = useCallback((key) => (v) => setS((p) => ({ ...p, [key]: v })), []);
    const patch = useCallback((obj) => setS((p) => ({ ...p, ...obj })), []);
    const setProc = (key) => (v) => setS((p) => ({ ...p, proc: { ...p.proc, [key]: v } }));
    const toggle = (id) => setOpen((o) => ({ ...o, [id]: o[id] === false }));
    const proc = { ...PROC_DEFAULTS, ...s.proc };

    const seedFor = (st) => (st.seed === 'procedural' ? procRef.current : loadedRef.current[st.seed] || null);

    // ---- Renderer and the loop ---------------------------------------------------------

    useEffect(() => {
        let r;
        try {
            r = new Renderer(canvasRef.current);
        } catch (e) {
            setGlError(e.message || String(e));
            return undefined;
        }
        rendererRef.current = r;
        const an = new Analysis();
        const scratch = {};
        const shapeCache = {};
        let raf = 0;
        let last = performance.now();
        let drawnKey = '';
        let frameIndex = 0;
        let lastStats = 0;
        let lastLabel = '';

        const tick = (now) => {
            raf = requestAnimationFrame(tick);
            const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
            last = now;
            if (exportingRef.current || r.lost) return;
            const s0 = settingsRef.current;
            const L = loadedRef.current;
            const seedObj = seedFor(s0);
            const kind = activeSeed(s0, seedObj);
            const S = effective(s0, kind);
            const timed = kind === 'video';
            const loop = Math.max(0.05, timed ? seedObj.duration : s0.loop);
            loopRef.current = loop;
            const c = clockRef.current;

            if (L.video && kind !== 'video' && !L.video.el.paused) L.video.el.pause();

            if (kind === 'video') {
                seedObj.sync(c.t, c.playing, c.rate);
                const vt = seedObj.clock;
                if (c.playing && c.rate > 0 && vt != null) c.t = Math.min(vt, loop);
                else if (c.playing) c.t = wrap(c.t + dt * c.rate, loop);
            } else if (c.playing) {
                c.t = wrap(c.t + dt * c.rate, loop);
            }
            if (c.t > loop) c.t = wrap(c.t, loop);

            // Letterbox the output frame in the stage.
            const { outW, outH } = outputSize(s0, seedObj);
            // Refs go before effect cleanups run: a frame can land between.
            const box = stageRef.current;
            if (!box || !canvasRef.current) return;
            const BW = box.clientWidth;
            const BH = box.clientHeight;
            if (!BW || !BH) return;
            let cw = BW;
            let ch = (cw * outH) / outW;
            if (ch > BH) { ch = BH; cw = (ch * outW) / outH; }
            cw = Math.max(2, Math.floor(cw));
            ch = Math.max(2, Math.floor(ch));
            const cv = canvasRef.current;
            const css = `${cw}x${ch}`;
            if (cv.dataset.size !== css) {
                cv.dataset.size = css;
                Object.assign(cv.style, {
                    width: `${cw}px`, height: `${ch}px`, left: `${Math.floor((BW - cw) / 2)}px`, top: `${Math.floor((BH - ch) / 2)}px`,
                });
            }
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            r.setSize(cw * dpr, ch * dpr);

            // Transport readout.
            const label = `${fmt(c.t)} / ${fmt(loop)}`;
            if (label !== lastLabel && timeRef.current) { timeRef.current.textContent = label; lastLabel = label; }
            if (rangeRef.current && !scrubbingRef.current) {
                rangeRef.current.max = String(loop);
                rangeRef.current.value = String(c.t);
            }

            const key = `${verRef.current}|${kind}|${c.t}|${r.w}|${r.h}|${seedObj?.name || ''}`;
            const busy = kind === 'procedural' && seedObj.baking > 0;
            if (key === drawnKey && !busy && !dirtyRef.current) return;
            const ctx = {
                phase: c.t / loop, loop, outW, outH, playing: c.playing, dt,
            };
            const frame = previewFrame(kind, seedObj, S, c.t, ctx, shapeCache);
            if (!frame && (kind === 'video' || kind === 'procedural')) {
                // Not ready yet: keep the last picture and try again.
                dirtyRef.current = true;
                if (kind === 'procedural' && now - lastStats > 250) {
                    lastStats = now;
                    const bake = seedObj.baking;
                    setStats((p) => (p.bake === bake ? p : { ...p, bake }));
                }
                return;
            }
            drawnKey = key;
            dirtyRef.current = false;
            const t0 = performance.now();
            const tree = renderFrame(r, an, scratch, frame, S, outW, outH, ctx.phase, frameIndex++);
            treeRef.current = tree;
            if (now - lastStats > 250) {
                lastStats = now;
                const next = {
                    count: tree.count,
                    ms: Math.round(performance.now() - t0),
                    aw: an.w,
                    ah: an.h,
                    capped: tree.capped,
                    bake: kind === 'procedural' ? seedObj.baking : 0,
                };
                setStats((p) => (Object.keys(next).every((k) => p[k] === next[k]) ? p : next));
            }
        };
        raf = requestAnimationFrame(tick);
        // A handle for poking at it from the console while developing.
        if (process.env.NODE_ENV !== 'production') {
            window.__quadtree = {
                r,
                settings: () => settingsRef.current,
                set: (o) => setS((p) => ({ ...p, ...o })),
                clock: clockRef.current,
                /** An MP4 export kept in memory (nothing downloaded): resolves to its size. */
                async exportTest(opts = {}) {
                    const st = settingsRef.current;
                    const seedObj = seedFor(st);
                    const out = await exportMp4({
                        s: st,
                        seed: seedObj,
                        loop: loopRef.current,
                        opts: {
                            scale: 0.5, quality: 0.12, fps: 30, t0: 0, t1: 1, sound: true, ...opts,
                        },
                        onProgress: () => {},
                        cancelled: () => false,
                        name: 'test',
                        save: false,
                    });
                    this.lastBlob = out?.blob || null;
                    return out?.blob ? { bytes: out.blob.size, type: out.blob.type } : out;
                },
                /** Time each stage over `n` frames at the current settings. */
                profile(n = 20) {
                    const s0 = settingsRef.current;
                    const seedObj = seedFor(s0);
                    const kind = activeSeed(s0, seedObj);
                    const S = effective(s0, kind);
                    const { outW, outH } = outputSize(s0, seedObj);
                    const loop = kind === 'video' ? seedObj.duration : s0.loop;
                    const acc = {
                        seed: 0, grade: 0, analyse: 0, tables: 0, tree: 0, scene: 0, post: 0,
                    };
                    let count = 0;
                    for (let i = 0; i < n; i++) {
                        const t = (i / n) * loop;
                        const ctx = {
                            phase: t / loop, loop, outW, outH, playing: false, dt: 0,
                        };
                        let a = performance.now();
                        const lap = (k) => { const b = performance.now(); acc[k] += b - a; a = b; };
                        r.drawSeed(previewFrame(kind, seedObj, S, t, ctx, shapeCache), S, outW, outH, ctx.phase); lap('seed');
                        r.grade(S, outH); lap('grade');
                        const { px, w, h } = r.analyse(S, outW, outH, ctx.phase); lap('analyse');
                        an.update(px, w, h, S.metric); lap('tables');
                        const tree = buildTree(an, S, outW, outH, ctx.phase, scratch); lap('tree');
                        count = tree.count;
                        r.drawScene(tree, S, outW, outH); lap('scene');
                        r.composite(S, i);
                        r.gl.finish(); lap('post');
                    }
                    const out = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +(v / n).toFixed(2)]));
                    out.quads = count;
                    out.size = `${r.w}x${r.h}`;
                    return out;
                },
            };
        }
        return () => {
            cancelAnimationFrame(raf);
            r.dispose();
            rendererRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Seeds go when the tool does.
    useEffect(() => () => {
        Object.values(loadedRef.current).forEach((x) => x?.dispose?.());
        loadedRef.current = {};
    }, []);

    // ---- Playback --------------------------------------------------------------------

    const setPlaying = useCallback((v) => {
        clockRef.current.playing = v;
        setPlayingState(v);
    }, []);
    const togglePlay = useCallback(() => setPlaying(!clockRef.current.playing), [setPlaying]);
    const setRate = (v) => {
        clockRef.current.rate = v;
        setRateState(v);
    };
    const seek = (v) => {
        const c = clockRef.current;
        c.t = Math.max(0, Math.min(loopRef.current, v));
        const vid = loadedRef.current.video;
        if (vid && settingsRef.current.seed === 'video') vid.el.currentTime = c.t;
        dirtyRef.current = true;
    };
    const step = useCallback((dir) => {
        setPlaying(false);
        const c = clockRef.current;
        c.t = wrap(c.t + dir * STEP, loopRef.current);
        dirtyRef.current = true;
    }, [setPlaying]);

    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || e.target?.isContentEditable) return;
            if (exportingRef.current) return;
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); } else if (e.key === 'ArrowRight') step(1);
            else if (e.key === 'ArrowLeft') step(-1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, step]);

    // ---- Seeds -------------------------------------------------------------------------

    const putSeed = (kind, obj) => {
        const prev = loadedRef.current[kind];
        if (prev && prev !== obj) prev.dispose?.();
        loadedRef.current = { ...loadedRef.current, [kind]: obj };
        if (obj?.kind === 'video') obj.onSeeked = () => { dirtyRef.current = true; };
        setLoaded(loadedRef.current);
        clockRef.current.t = 0;
        dirtyRef.current = true;
        setS((p) => ({ ...p, seed: kind }));
    };

    const openFile = async (file) => {
        if (!file) return;
        setSeedError('');
        const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
        setBusySeed(isVideo ? 'video' : 'image');
        try {
            const obj = isVideo ? await VideoSeed.fromFile(file) : await ImageSeed.fromFile(file);
            putSeed(obj.kind, obj);
        } catch (e) {
            setSeedError(e.message || String(e));
        }
        setBusySeed('');
    };

    useEffect(() => {
        if (process.env.NODE_ENV !== 'production' && window.__quadtree) window.__quadtree.open = openFile;
    });

    // ---- Presets ---------------------------------------------------------------------

    const refreshPresets = useCallback(() => listPresets().then(setPresets), []);
    useEffect(() => { refreshPresets(); }, [refreshPresets]);

    const applyPreset = (settings, name) => {
        // A preset carries no seed file: keep what is loaded here.
        setS((p) => ({ ...p, ...settings, seed: settings.seed === 'image' || settings.seed === 'video' ? p.seed : settings.seed }));
        setPresetName(name);
        setPresetMsg(`Loaded ${name}.`);
        dirtyRef.current = true;
    };
    const openPreset = async (name) => {
        if (!name) return;
        try {
            const pr = await loadPreset(name);
            applyPreset(pr.settings, name);
        } catch (e) { setPresetMsg(e.message); }
    };
    const saveCurrent = async () => {
        const name = presetName.trim();
        if (!name) { setPresetMsg('Name it first.'); return; }
        try {
            const where = await savePreset(name, settingsRef.current);
            setPresetMsg(`Saved to ${where}.`);
            refreshPresets();
        } catch (e) { setPresetMsg(e.message); }
    };
    const removePreset = async () => {
        const name = presetName.trim();
        if (!name || !presets?.some((x) => x.name === name)) return;
        try {
            await deletePreset(name);
            setPresetMsg(`Deleted ${name}.`);
            refreshPresets();
        } catch (e) { setPresetMsg(e.message); }
    };

    const applyProc = () => {
        try {
            const obj = JSON.parse(procText);
            const keep = Object.fromEntries(Object.entries(obj).filter(([k]) => k in PROC_DEFAULTS && k !== 'style'));
            setS((p) => ({ ...p, proc: { ...p.proc, ...keep } }));
            setProcMsg(`Applied ${Object.keys(keep).length} settings.`);
        } catch (e) {
            setProcMsg('Not JSON: paste what Copy Settings gives in Procedural Art.');
        }
    };

    // ---- Exports -----------------------------------------------------------------------

    const current = () => {
        const st = settingsRef.current;
        const seedObj = seedFor(st);
        const kind = activeSeed(st, seedObj);
        return {
            st, seedObj, kind, name: `quadtree_${kind}`,
        };
    };

    const runExport = async (opts, onProgress, cancelled) => {
        const { st, seedObj, name } = current();
        setPlaying(false);
        exportingRef.current = true;
        setExporting(true);
        try {
            return await exportMp4({
                s: st, seed: seedObj, loop: loopRef.current, opts, onProgress, cancelled, name,
            });
        } finally {
            exportingRef.current = false;
            setExporting(false);
            dirtyRef.current = true;
        }
    };

    const doPng = async () => {
        const { st, seedObj, name } = current();
        exportingRef.current = true;
        setExporting(true);
        try {
            await exportPng({
                s: st, seed: seedObj, loop: loopRef.current, t: clockRef.current.t, scale: pngScale, name,
            });
        } catch (e) {
            setSeedError(e.message || String(e));
        } finally {
            exportingRef.current = false;
            setExporting(false);
            dirtyRef.current = true;
        }
    };

    const doSvg = () => {
        const { st, seedObj, name } = current();
        if (treeRef.current) {
            exportSvg({
                tree: treeRef.current, s: st, seed: seedObj, name,
            });
        }
    };

    const copySettings = () => {
        const out = {};
        Object.keys(DEFAULTS).forEach((k) => {
            if (JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k])) out[k] = s[k];
        });
        navigator.clipboard?.writeText(JSON.stringify(out, null, 4)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    // ---- Render -----------------------------------------------------------------------

    const seedObj = s.seed === 'procedural' ? procRef.current : loaded[s.seed] || null;
    const kind = activeSeed(s, seedObj);
    const { outW, outH } = outputSize(s, seedObj);
    const timed = kind === 'video';
    const presetId = (PRESETS.find((p) => Object.entries(p.set).every(([k, v]) => JSON.stringify(s[k]) === JSON.stringify(v))) || { id: '' }).id;
    const rampId = (RAMPS.find(([, r]) => r === s.ramp) || ['custom'])[0];
    const btn = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 };
    const missing = (s.seed === 'image' || s.seed === 'video') && !loaded[s.seed];

    const onDrop = (e) => {
        e.preventDefault();
        setDropping(false);
        const f = e.dataTransfer.files?.[0];
        if (f) openFile(f);
    };

    return (
        <div className={vfx.vfx}>
            <div
                ref={stageRef}
                className={`${styles.stage} ${menuOpen ? styles.stagePanel : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
                onDragLeave={() => setDropping(false)}
                onDrop={onDrop}
            >
                <canvas
                    ref={canvasRef}
                    className={`${styles.canvas} ${dropping ? styles.dropping : ''}`}
                    onClick={togglePlay}
                    aria-label="Quad tree preview; click to play or pause"
                />
                {glError && <div className={vfx.vfx_hint} style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', opacity: 0.8 }}>{glError}</div>}
            </div>

            <div className={`${styles.transport} ${menuOpen ? styles.transportPanel : ''}`}>
                <button type="button" className={vfx.vfx_iconBtn} aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay} disabled={exporting}>
                    {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button type="button" className={vfx.vfx_iconBtn} aria-label="Step back" onClick={() => step(-1)}><StepBack size={13} /></button>
                <button type="button" className={vfx.vfx_iconBtn} aria-label="Step forward" onClick={() => step(1)}><StepForward size={13} /></button>
                <input
                    ref={rangeRef}
                    type="range"
                    className={vfx.vfx_slider}
                    min={0}
                    max={DEFAULTS.loop}
                    step={0.001}
                    defaultValue={0}
                    aria-label="Time"
                    onPointerDown={() => { scrubbingRef.current = true; }}
                    onPointerUp={() => { scrubbingRef.current = false; }}
                    onChange={(e) => seek(parseFloat(e.target.value))}
                />
                <span ref={timeRef} className={styles.time}>0.00s</span>
                <select className={`${vfx.vfx_select} ${styles.speed}`} value={rate} aria-label="Speed" onChange={(e) => setRate(Number(e.target.value))}>
                    {SPEEDS.map((v) => <option key={v} value={v}>{`${v}x`}</option>)}
                    {kind !== 'video' && SPEEDS.map((v) => <option key={-v} value={-v}>{`-${v}x`}</option>)}
                </select>
                <span className={styles.stats}>
                    {`${stats.count.toLocaleString()} quads · ${stats.ms}ms`}
                    {stats.capped ? ' · capped' : ''}
                    {stats.bake > 0 ? ` · baking ${Math.round(stats.bake * 100)}%` : ''}
                </span>
            </div>

            {!menuOpen && (
                <button type="button" aria-label="Open controls" onClick={() => setMenuOpen(true)} className={`${vfx.vfx_toggle} ${vfx.vfx_visible}`}>
                    <SlidersHorizontal size={18} />
                </button>
            )}

            <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            <input
                ref={presetFileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                        const pr = await readPresetFile(f);
                        applyPreset(pr.settings, pr.name);
                    } catch (err) { setPresetMsg(err.message); }
                }}
            />

            {menuOpen && (
                <div className={vfx.vfx_panel}>
                    <div className={vfx.vfx_head}>
                        <span className={vfx.vfx_title}>Quad Trees</span>
                        <button type="button" aria-label="Close controls" className={vfx.vfx_iconBtn} onClick={() => setMenuOpen(false)}>
                            <X size={16} />
                        </button>
                    </div>

                    {/* Looks */}
                    <div className={vfx.vfx_section}>
                        <div className={vfx.vfx_sectionTitle}>Look</div>
                        <select
                            className={vfx.vfx_select}
                            value={presetId}
                            onChange={(e) => {
                                const p = PRESETS.find((x) => x.id === e.target.value);
                                if (p) patch(p.set);
                            }}
                        >
                            {!presetId && <option value="">Custom</option>}
                            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <Hint>Looks set the subdivision, style, colour and post; the seed stays.</Hint>
                    </div>

                    {/* Saved presets */}
                    <Section id="presets" title="Presets" open={open} onToggle={toggle}>
                        {presets && presets.length > 0 && (
                            <select
                                className={vfx.vfx_select}
                                style={{ marginBottom: 8 }}
                                value={presets.some((x) => x.name === presetName) ? presetName : ''}
                                onChange={(e) => openPreset(e.target.value)}
                            >
                                <option value="">Load a preset…</option>
                                {presets.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                            </select>
                        )}
                        <input
                            type="text"
                            className={vfx.vfx_text}
                            style={{ marginBottom: 8 }}
                            placeholder="Preset name"
                            value={presetName}
                            onChange={(e) => setPresetName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveCurrent(); }}
                            spellCheck={false}
                        />
                        <div className={vfx.vfx_segRow} style={{ gridTemplateColumns: presets ? '1fr 1fr' : '1fr 1fr', marginBottom: 0 }}>
                            {presets ? (
                                <>
                                    <button type="button" className={vfx.vfx_select} style={btn} onClick={saveCurrent}>Save</button>
                                    <button type="button" className={vfx.vfx_select} style={btn} disabled={!presets.some((x) => x.name === presetName.trim())} onClick={removePreset}>Delete</button>
                                </>
                            ) : (
                                <>
                                    <button type="button" className={vfx.vfx_select} style={btn} onClick={() => downloadPreset(presetName.trim() || 'preset', settingsRef.current)}>Download</button>
                                    <button type="button" className={vfx.vfx_select} style={btn} onClick={() => presetFileRef.current.click()}>Open</button>
                                </>
                            )}
                        </div>
                        <Hint>
                            {presetMsg && <span>{`${presetMsg} `}</span>}
                            {presets
                                ? 'Saved into quadtree-presets/ by the dev server (gitignored). The Compositor\'s Quad Tree effect loads these too. Seed files are never saved.'
                                : 'No dev server here: download a preset or open one from a file.'}
                        </Hint>
                    </Section>

                    {/* Seed */}
                    <Section id="seed" title="Seed" open={open} onToggle={toggle}>
                        <Seg
                            columns={3}
                            value={s.seed}
                            onPick={(v) => { set('seed')(v); dirtyRef.current = true; }}
                            options={[['gradient', 'Gradient'], ['shapes', 'Shapes'], ['procedural', 'Procedural'], ['image', 'Image'], ['video', 'Video']]}
                        />

                        {kind === 'gradient' && !missing && (
                            <>
                                <Seg columns={5} value={s.gradType} onPick={set('gradType')} options={[['linear', 'Lin'], ['radial', 'Rad'], ['conic', 'Con'], ['corners', 'Crn'], ['waves', 'Wave']]} />
                                <Stops stops={s.gradStops} onChange={set('gradStops')} />
                                <Slider label="Scale" value={s.gradScale} min={0.2} max={6} step={0.01} onChange={set('gradScale')} />
                                {s.gradType !== 'corners' && <Slider label="Angle" value={s.gradAngle} min={0} max={360} step={1} onChange={set('gradAngle')} />}
                                <Slider label="Spin" value={s.gradSpin} min={-4} max={4} step={1} int onChange={set('gradSpin')} title="Turns per loop" />
                                <Slider label="Cycles" value={s.gradCycles} min={-6} max={6} step={1} int onChange={set('gradCycles')} title="Colour cycles per loop" />
                                <Hint>The default seed. Spin and cycles are whole turns per loop, so it loops seamlessly.</Hint>
                            </>
                        )}

                        {s.seed === 'shapes' && (
                            <>
                                <Seg columns={5} value={s.shapeKind} onPick={set('shapeKind')} options={[['circle', 'Circ'], ['square', 'Sqr'], ['triangle', 'Tri'], ['ring', 'Ring'], ['mixed', 'Mix']]} />
                                <Slider label="Count" value={s.shapeCount} min={1} max={64} step={1} int onChange={set('shapeCount')} />
                                <Slider label="Size" value={s.shapeSize} min={0.02} max={1} step={0.01} onChange={set('shapeSize')} />
                                <Slider label="Size var" value={s.shapeSizeVar} min={0} max={1} step={0.01} onChange={set('shapeSizeVar')} />
                                <Slider label="Speed" value={s.shapeRate} min={0} max={8} step={0.01} onChange={set('shapeRate')} title="Speed of the motion; whole numbers keep the loop seamless" />
                                <Slider label="Bounces" value={s.shapeSpeed} min={0} max={12} step={1} int onChange={set('shapeSpeed')} title="Trips across the frame per loop" />
                                <Slider label="Spin" value={s.shapeSpin} min={0} max={6} step={1} int onChange={set('shapeSpin')} title="Turns per loop" />
                                <Slider label="Blur" value={s.shapeBlur} min={0} max={0.25} step={0.001} onChange={set('shapeBlur')} title="Fraction of the frame height" />
                                <Slider label="Softness" value={s.shapeSoft} min={0} max={0.2} step={0.001} onChange={set('shapeSoft')} />
                                <Seg value={s.shapeBlend} onPick={set('shapeBlend')} options={[['over', 'Over'], ['add', 'Add'], ['screen', 'Screen']]} />
                                <Seg value={s.shapePalette} onPick={set('shapePalette')} options={[['rainbow', 'Rainbow'], ['stops', 'Palette']]} />
                                {s.shapePalette === 'rainbow'
                                    ? <Slider label="Saturation" value={s.shapeSat} min={0} max={1} step={0.01} onChange={set('shapeSat')} />
                                    : <Stops stops={s.shapeStops} onChange={set('shapeStops')} />}
                                <ColorRow label="Backdrop" value={s.shapeBg} onChange={set('shapeBg')} />
                                <div className={vfx.vfx_row}>
                                    <span className={vfx.vfx_label}>Seed</span>
                                    <input type="range" className={vfx.vfx_slider} min={0} max={999} step={1} value={s.shapeSeed} onChange={(e) => set('shapeSeed')(parseInt(e.target.value, 10))} />
                                    <button type="button" className={vfx.vfx_iconBtn} style={{ justifySelf: 'end' }} aria-label="Random seed" onClick={() => set('shapeSeed')(Math.floor(Math.random() * 1000))}><Shuffle size={12} /></button>
                                </div>
                                <Hint>Analytic shapes in one shader pass, blurred on the GPU. Each crosses the frame a whole number of times per loop.</Hint>
                            </>
                        )}

                        {s.seed === 'procedural' && (
                            <>
                                <Seg value={proc.mode} onPick={setProc('mode')} options={[['perlin', 'Perlin Noise'], ['fluid', 'Fluid Sim']]} />
                                {proc.mode === 'perlin' ? (
                                    <>
                                        <Seg value={proc.fractal} onPick={setProc('fractal')} options={[['fbm', 'Fbm'], ['turbulence', 'Turb'], ['ridged', 'Ridged']]} />
                                        <Slider label="Scale" value={proc.scale} min={2} max={200} step={0.5} onChange={setProc('scale')} />
                                        <Slider label="Octaves" value={proc.octaves} min={1} max={8} step={1} int onChange={setProc('octaves')} />
                                        <Slider label="Persistence" value={proc.persistence} min={0} max={1} step={0.01} onChange={setProc('persistence')} />
                                        <Slider label="Warp" value={proc.warp} min={0} max={6} step={0.05} onChange={setProc('warp')} />
                                        <Slider label="Evolve" value={proc.evolve} min={0} max={3} step={0.01} onChange={setProc('evolve')} />
                                    </>
                                ) : (
                                    <>
                                        <Seg value={proc.render} onPick={setProc('render')} options={[['trails', 'Trails'], ['vorticity', 'Vorticity'], ['speed', 'Speed']]} />
                                        <Seg value={proc.grid} onPick={setProc('grid')} options={[[64, '64'], [128, '128'], [256, '256']]} />
                                        <Slider label="Sim speed" value={proc.simSpeed} min={0.05} max={3} step={0.01} onChange={setProc('simSpeed')} />
                                        <Slider label="Force" value={proc.force} min={0} max={10} step={0.1} onChange={setProc('force')} />
                                        {proc.render === 'trails' && <Slider label="Particles" value={proc.particles} min={1} max={3000} step={1} int onChange={setProc('particles')} />}
                                        {proc.render === 'trails' && <Slider label="Fade s" value={proc.fade} min={0.1} max={10} step={0.1} onChange={setProc('fade')} />}
                                        <Slider label="Exposure" value={proc.exposure} min={0.1} max={6} step={0.05} onChange={setProc('exposure')} />
                                    </>
                                )}
                                <Slider label="Levels" value={proc.levels} min={2} max={64} step={1} int onChange={setProc('levels')} title="Colours taken from the palette" />
                                <Slider label="Seed" value={proc.seed} min={0} max={9999} step={1} int onChange={setProc('seed')} />
                                <Slider label="Resolution" value={s.procRes} min={32} max={480} step={1} int onChange={set('procRes')} title="Noise columns" />
                                <Stops stops={proc.stops} onChange={(v) => setS((p) => ({ ...p, proc: { ...p.proc, stops: v, colorMode: 'gradient' } }))} />
                                <textarea
                                    className={vfx.vfx_text}
                                    rows={3}
                                    style={{ resize: 'vertical', fontSize: 10, marginBottom: 6 }}
                                    placeholder="Paste Copy Settings from Procedural Art"
                                    value={procText}
                                    onChange={(e) => setProcText(e.target.value)}
                                    spellCheck={false}
                                />
                                <button type="button" className={vfx.vfx_select} style={{ textAlign: 'center' }} disabled={!procText.trim()} onClick={applyProc}>Apply Pasted Settings</button>
                                <Hint>
                                    {procMsg && <span>{procMsg} </span>}
                                    {proc.mode === 'fluid'
                                        ? `The flow is baked into a ${s.loop}s loop that crossfades back into its start${stats.bake > 0 ? ` (baking ${Math.round(stats.bake * 100)}%)` : ''}. Settings that change the flow rebake it.`
                                        : `The Procedural Art engine, its noise time looping every ${s.loop}s.`}
                                </Hint>
                            </>
                        )}

                        {(s.seed === 'image' || s.seed === 'video') && (
                            <>
                                <button type="button" className={`${vfx.vfx_select} ${styles.fileBtn}`} style={{ marginBottom: 9 }} disabled={!!busySeed} onClick={() => fileRef.current.click()}>
                                    <Upload size={13} />
                                    {busySeed ? 'Loading…' : `Open ${s.seed === 'video' ? 'Video' : 'Image'}`}
                                </button>
                                {loaded[s.seed] && <div className={styles.name}>{`${loaded[s.seed].name} · ${loaded[s.seed].width}×${loaded[s.seed].height}${loaded[s.seed].duration ? ` · ${loaded[s.seed].duration.toFixed(2)}s` : ''}`}</div>}
                                <Seg value={s.fit} onPick={set('fit')} options={[['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch']]} />
                                <Slider label="Zoom" value={s.seedZoom} min={0.25} max={4} step={0.01} onChange={set('seedZoom')} />
                                <Hint>{missing ? 'Nothing loaded yet: the gradient stands in. ' : ''}Or drop a file on the preview.{s.seed === 'video' ? ' The video sets the loop; exports decode every frame exactly.' : ''}</Hint>
                            </>
                        )}

                        {seedError && <Hint style={{ opacity: 1 }}><span className={styles.warn}>{seedError}</span></Hint>}
                    </Section>

                    {/* Grade */}
                    <Section
                        id="grade"
                        title="Seed Grade"
                        open={open}
                        onToggle={toggle}
                        extra={(
                            <button
                                type="button"
                                className={vfx.vfx_iconBtn}
                                style={{ width: 20, height: 20 }}
                                aria-label="Reset grade"
                                title="Reset grade"
                                onClick={(e) => { e.stopPropagation(); patch(Object.fromEntries(GRADE_KEYS.map((k) => [k, DEFAULTS[k]]))); }}
                            >
                                <RotateCcw size={11} />
                            </button>
                        )}
                    >
                        <Slider label="Exposure" value={s.exposure} min={-3} max={3} step={0.01} onChange={set('exposure')} />
                        <Slider label="Contrast" value={s.contrast} min={0} max={3} step={0.01} onChange={set('contrast')} />
                        <Slider label="Saturation" value={s.saturation} min={0} max={3} step={0.01} onChange={set('saturation')} />
                        <Slider label="Temperature" value={s.temperature} min={-1} max={1} step={0.01} onChange={set('temperature')} />
                        <Slider label="Tint" value={s.tint} min={-1} max={1} step={0.01} onChange={set('tint')} />
                        <Slider label="Hue" value={s.hue} min={-180} max={180} step={1} onChange={set('hue')} />
                        <Slider label="Gamma" value={s.gamma} min={0.2} max={3} step={0.01} onChange={set('gamma')} />
                        <Slider label="Lift" value={s.lift} min={-0.5} max={0.5} step={0.01} onChange={set('lift')} />
                        <Slider label="Gain" value={s.gain} min={0} max={2} step={0.01} onChange={set('gain')} />
                        <Slider label="Posterize" value={s.posterize} min={0} max={16} step={1} int onChange={set('posterize')} />
                        <Slider label="Blur" value={s.blur} min={0} max={0.2} step={0.001} onChange={set('blur')} title="Fraction of the frame height" />
                        <Switch label="Invert" value={s.invert} onChange={set('invert')} />
                        <Hint>Graded before anything is measured, so it moves the splits as well as the colours.</Hint>
                    </Section>

                    {/* Subdivision */}
                    <Section id="tree" title="Subdivision" open={open} onToggle={toggle}>
                        <Seg
                            columns={3}
                            value={s.metric}
                            onPick={set('metric')}
                            options={[['color', 'Colour'], ['luma', 'Bright'], ['noise', 'Noise'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]}
                        />
                        <Slider label="Threshold" value={s.threshold} min={0} max={0.4} step={0.001} onChange={set('threshold')} title="A quad splits while the spread (standard deviation) of the metric over it is above this" />
                        <Slider label="Max depth" value={s.maxDepth} min={0} max={12} step={1} int onChange={set('maxDepth')} />
                        <Slider label="Min depth" value={s.minDepth} min={0} max={8} step={1} int onChange={set('minDepth')} title="Always split at least this deep" />
                        <Slider label="Min size" value={s.minSize} min={0.5} max={64} step={0.5} onChange={set('minSize')} title="Smallest quad, in output pixels" />
                        <Slider label="Root cells" value={s.rootCols} min={1} max={32} step={1} int onChange={set('rootCols')} title="Square root cells across the frame" />
                        <Slider label="Falloff" value={s.falloff} min={0.5} max={1.5} step={0.01} onChange={set('falloff')} title="Threshold x falloff^depth: above 1 deep splits get harder" />
                        <div className={vfx.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                            <span className={vfx.vfx_label}>Analysis</span>
                            <Seg value={s.analysisRes} onPick={set('analysisRes')} options={[[256, '256'], [512, '512'], [1024, '1024']]} />
                        </div>
                        <Hint>
                            {`Splits wherever the ${{
                                color: 'colour', luma: 'brightness', noise: 'noise map', r: 'red', g: 'green', b: 'blue',
                            }[s.metric]} varies by more than the threshold.`}
                            {` Analysis ${stats.aw}×${stats.ah}.`}
                            {stats.capped ? ' Capped at 250k quads.' : ''}
                        </Hint>
                    </Section>

                    {s.metric === 'noise' && (
                        <Section id="noise" title="Noise Map" open={open} onToggle={toggle}>
                            <Slider label="Scale" value={s.noiseScale} min={0.2} max={20} step={0.05} onChange={set('noiseScale')} />
                            <Slider label="Octaves" value={s.noiseOctaves} min={1} max={8} step={1} int onChange={set('noiseOctaves')} />
                            <Slider label="Evolve" value={s.noiseEvolve} min={1} max={8} step={1} int onChange={set('noiseEvolve')} title="Noise cycles per loop" />
                            <Slider label="Contrast" value={s.noiseContrast} min={0.1} max={4} step={0.01} onChange={set('noiseContrast')} />
                            <Slider label="Warp" value={s.noiseWarp} min={0} max={3} step={0.01} onChange={set('noiseWarp')} />
                            <Slider label="Seed" value={s.noiseSeed} min={0} max={999} step={1} int onChange={set('noiseSeed')} />
                            <Hint>The splits follow this noise; the colours still come from the seed. It loops with the timeline.</Hint>
                        </Section>
                    )}

                    {/* Style */}
                    <Section id="style" title="Style" open={open} onToggle={toggle}>
                        <Seg value={s.shape} onPick={set('shape')} options={[['square', 'Square'], ['circle', 'Circle'], ['mixed', 'Mixed'], ['ascii', 'Ascii']]} />
                        {s.shape !== 'ascii' ? (
                            <>
                                {s.shape !== 'circle' && <Slider label="Rounding" value={s.radius} min={0} max={1} step={0.01} onChange={set('radius')} />}
                                {s.shape === 'mixed' && <Slider label="Circles" value={s.mixRatio} min={0} max={1} step={0.01} onChange={set('mixRatio')} title="Share of quads drawn as circles" />}
                                <Slider label="Gap" value={s.gap} min={0} max={24} step={0.25} onChange={set('gap')} title="Output pixels" />
                                <Slider label="Size" value={s.size} min={0.1} max={1.5} step={0.01} onChange={set('size')} />
                                <Slider label="Halftone" value={s.halftone} min={0} max={1} step={0.01} onChange={set('halftone')} title="Shrink shapes by brightness" />
                                {s.halftone > 0 && <Switch label="Halftone: dark is big" value={s.halftoneInvert} onChange={set('halftoneInvert')} />}
                                <Switch label="Fill" value={s.fill} onChange={set('fill')} />
                                <Slider label="Outline" value={s.outline} min={0} max={16} step={0.25} onChange={set('outline')} title="Output pixels" />
                                {s.outline > 0 && <Seg value={s.outlineMode} onPick={set('outlineMode')} options={[['solid', 'Colour'], ['cell', 'Cell'], ['shade', 'Shade']]} />}
                                {s.outline > 0 && s.outlineMode === 'solid' && <ColorRow label="Outline" value={s.outlineColor} onChange={set('outlineColor')} />}
                            </>
                        ) : (
                            <>
                                <select
                                    className={vfx.vfx_select}
                                    style={{ marginBottom: 8 }}
                                    value={rampId}
                                    onChange={(e) => { const r = RAMPS.find(([n]) => n === e.target.value); if (r) set('ramp')(r[1]); }}
                                >
                                    {RAMPS.map(([n]) => <option key={n} value={n}>{n}</option>)}
                                    {rampId === 'custom' && <option value="custom">Custom</option>}
                                </select>
                                <input type="text" className={vfx.vfx_text} style={{ marginBottom: 9 }} value={s.ramp} onChange={(e) => set('ramp')(e.target.value || ' ')} spellCheck={false} />
                                <Slider label="Glyph size" value={s.size} min={0.3} max={1.5} step={0.01} onChange={set('size')} />
                                <Slider label="Cell fill" value={s.glyphBg} min={0} max={1} step={0.01} onChange={set('glyphBg')} title="A dim block of the cell's colour behind each glyph" />
                                <Switch label="Invert ramp" value={s.rampInvert} onChange={set('rampInvert')} />
                            </>
                        )}
                        <Slider label="Opacity" value={s.quadOpacity} min={0} max={1} step={0.01} onChange={set('quadOpacity')} />
                        {s.shape === 'mixed' && <Slider label="Mix seed" value={s.styleSeed} min={0} max={999} step={1} int onChange={set('styleSeed')} />}
                    </Section>

                    {/* Colour */}
                    <Section id="colour" title="Colour" open={open} onToggle={toggle}>
                        <Seg value={s.colorSource} onPick={set('colorSource')} options={[['seed', 'Seed'], ['gradient', 'Map'], ['depth', 'Depth']]} />
                        {s.colorSource !== 'seed' && <Stops stops={s.stops} onChange={set('stops')} />}
                        <Slider label="Levels" value={s.levels} min={0} max={16} step={1} int onChange={set('levels')} title="Posterize quad colours; 0 = continuous" />
                        <ColorRow label="Background" value={s.background} onChange={set('background')} />
                        <Slider label="Underlay" value={s.underlay} min={0} max={1} step={0.01} onChange={set('underlay')} title="The graded seed drawn behind the quads" />
                        <Hint>Seed: each quad's mean colour. Map: its brightness through the colours. Depth: by how deep it is. Underlay puts the seed (procedural art, a video…) behind the quads.</Hint>
                    </Section>

                    {/* Post */}
                    <Section id="post" title="Glow & Post" open={open} onToggle={toggle}>
                        <Slider label="Glow" value={s.glow} min={0} max={4} step={0.01} onChange={set('glow')} />
                        {s.glow > 0 && (
                            <>
                                <Slider label="Radius" value={s.glowRadius} min={0} max={1} step={0.01} onChange={set('glowRadius')} />
                                <Slider label="Threshold" value={s.glowThreshold} min={0} max={1} step={0.01} onChange={set('glowThreshold')} />
                                <ColorRow label="Tint" value={s.glowTint} onChange={set('glowTint')} />
                                <Switch label="Normalise glow" value={s.glowNormalize} onChange={set('glowNormalize')} />
                                {!s.glowNormalize && <Hint style={{ marginTop: -2, marginBottom: 9 }}>Off: every blur level adds in full, for a blown-out bloom.</Hint>}
                            </>
                        )}
                        <Slider label="Aberration" value={s.aberration} min={0} max={2} step={0.01} onChange={set('aberration')} />
                        <Slider label="Vignette" value={s.vignette} min={0} max={1} step={0.01} onChange={set('vignette')} />
                        <Slider label="Grain" value={s.grain} min={0} max={1} step={0.01} onChange={set('grain')} />
                    </Section>

                    {/* Output */}
                    <Section id="output" title="Output & Export" open={open} onToggle={toggle}>
                        <div className={vfx.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                            <span className={vfx.vfx_label}>Aspect</span>
                            <select className={vfx.vfx_select} value={s.aspect} onChange={(e) => set('aspect')(e.target.value)}>
                                {ASPECTS.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
                            </select>
                        </div>
                        <Slider label="Long side" value={s.outLong} min={256} max={3840} step={2} int onChange={set('outLong')} title="Output pixels" />
                        {!timed && <Slider label="Loop s" value={s.loop} min={0.5} max={60} step={0.5} onChange={(v) => set('loop')(Math.max(0.1, v))} />}
                        <Hint style={{ marginTop: 0, marginBottom: 10 }}>
                            {`${outW}×${outH}. `}
                            {timed ? 'Loop set by the video.' : 'Everything animated turns a whole number of times per loop.'}
                        </Hint>
                        <button type="button" className={vfx.vfx_select} style={{ ...btn, marginBottom: 8 }} disabled={exporting || !canEncodeMp4()} onClick={() => { setPlaying(false); setDialog(true); }}>
                            <Download size={13} />
                            Export MP4…
                        </button>
                        <div className={vfx.vfx_segRow} style={{ gridTemplateColumns: '1fr 1fr' }}>
                            <button type="button" className={vfx.vfx_select} style={btn} disabled={exporting} onClick={doPng}>
                                <Download size={13} />
                                {`PNG ${pngScale}x`}
                            </button>
                            <button type="button" className={vfx.vfx_select} style={btn} disabled={exporting} onClick={doSvg}>
                                <Download size={13} />
                                SVG
                            </button>
                        </div>
                        <div className={vfx.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                            <span className={vfx.vfx_label}>PNG scale</span>
                            <Seg value={pngScale} onPick={setPngScale} options={[[1, '1x'], [2, '2x'], [4, '4x']]} />
                        </div>
                        <Hint>
                            {canEncodeMp4() ? '' : 'MP4 needs WebCodecs (Chrome, Edge, recent Safari). '}
                            MP4 renders offline, frame by frame, like the Compositor. PNG is this frame; SVG is the quads as vectors (no post).
                        </Hint>
                    </Section>

                    <div className={vfx.vfx_section}>
                        <div className={vfx.vfx_segRow} style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 0 }}>
                            <button type="button" className={vfx.vfx_select} style={btn} onClick={copySettings}>
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                                {copied ? 'Copied' : 'Copy'}
                            </button>
                            <button type="button" className={vfx.vfx_select} style={btn} onClick={() => setS((p) => ({ ...DEFAULTS, seed: p.seed }))}>
                                <RotateCcw size={13} />
                                Reset
                            </button>
                        </div>
                        <Hint>Space plays / pauses, arrows step a frame. Type next to a slider to go past its range.</Hint>
                    </div>
                </div>
            )}

            {dialog && (
                <ExportDialog
                    run={runExport}
                    loop={loopRef.current}
                    outW={outW}
                    outH={outH}
                    hasSound={kind === 'video'}
                    onClose={() => setDialog(false)}
                />
            )}
        </div>
    );
}

export default QuadTree;
