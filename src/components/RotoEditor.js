// The Scan Compositor's Roto mode: cut objects out of the take with SAM 2,
// correct them, and publish them as mattes.
//
// The panel lives in the Scene panel; the overlay is drawn over the footage
// (a portal into the compositor's canvas box) while Roto mode is on. All the
// model work happens in backend/vidtrack/roto_server.py, reached through the
// dev server - see lib/scanAssets/roto.js.
//
// On the footage, with the Click tool:
//   click              include this (a positive click)
//   alt-click or right-click   exclude this (a negative click)
//   drag on empty footage      a box round the object (one per frame)
//   drag a click        move it
//   right-click a click remove it
// With Brush or Eraser, paint; the paint overrides the model on that frame
// and survives re-propagation. Alt inverts the brush. [ and ] size it; , and
// . step a frame; C, B and E pick the tool.

import React, {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
    Eye, EyeOff, Trash2, Plus, Scissors, ChevronLeft, ChevronRight, Square, Undo2, FileDown,
} from 'lucide-react';
import { rotoApi, setWritten, mattesFor } from '../lib/scanAssets/roto';
import styles from './vfx.module.css';

const TOOLS = [['click', 'Click / box'], ['brush', 'Brush'], ['erase', 'Eraser']];
const HIT_PX = 9; // how close (on screen) a press has to be to grab a click
const DRAG_PX = 5; // how far a press moves before it is a box rather than a click

const hexRgb = (hex) => {
    const n = parseInt((hex || '#ff5a5a').slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// A mask (grayscale, as the server sends it) as a tinted overlay: a wash over
// the object and a solid line round it, at a size that redraws quickly.
function tintMask(bitmap, color) {
    const w = Math.min(bitmap.width, 1280);
    const h = Math.round((bitmap.height * w) / bitmap.width);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const [r, g, b] = hexRgb(color);
    const on = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < on.length; i++, p += 4) on[i] = d[p] > 127 ? 1 : 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const p = i * 4;
            const v = d[p] / 255;
            const o = on[i];
            const edge = (x + 1 < w && on[i + 1] !== o) || (y + 1 < h && on[i + w] !== o)
                || (x > 0 && on[i - 1] !== o) || (y > 0 && on[i - w] !== o);
            d[p] = r;
            d[p + 1] = g;
            d[p + 2] = b;
            d[p + 3] = edge ? 235 : Math.round(v * 105);
        }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

const inRuns = (runs, f) => runs.some(([a, b]) => f >= a && f <= b);

// ---- Overlay --------------------------------------------------------------------

function RotoOverlay({
    size, frame, objects, activeId, hidden, masks, tool, radius, setRadius,
    prompt, onPrompt, onStroke, busy, drawTick,
}) {
    const canvasRef = useRef(null);
    const drag = useRef(null);
    const [hover, setHover] = useState(null);
    const [, setLive] = useState(0);
    const bump = () => setLive((v) => v + 1);
    const active = objects.find((o) => o.id === activeId) || null;
    const W = size.width;
    const H = size.height;

    // Where an event is, in the take's pixels and on screen.
    const at = (e) => {
        const r = canvasRef.current.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        return { x: (sx / r.width) * W, y: (sy / r.height) * H, sx, sy, k: r.width / W };
    };

    const draw = useCallback(() => {
        const c = canvasRef.current;
        if (!c) return;
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.max(1, Math.round(r.width * dpr));
        const ch = Math.max(1, Math.round(r.height * dpr));
        if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        // Masks, the active one last so it reads on top.
        const order = [...objects.filter((o) => o.id !== activeId), ...(active ? [active] : [])];
        order.forEach((o) => {
            if (hidden[o.id]) return;
            const m = masks.current.get(`${o.id}|${frame}`);
            if (m && m.canvas) {
                ctx.globalAlpha = o.id === activeId ? 1 : 0.6;
                ctx.drawImage(m.canvas, 0, 0, cw, ch);
            }
        });
        ctx.globalAlpha = 1;
        const sx = cw / W;
        const sy = ch / H;
        // The active object's box and clicks on this frame.
        const d = drag.current;
        const bx = d?.kind === 'box' ? d.box : (d?.boxKeep ?? prompt?.box ?? null);
        if (bx) {
            ctx.strokeStyle = active?.color || '#fff';
            ctx.lineWidth = 2 * dpr;
            ctx.setLineDash([6 * dpr, 4 * dpr]);
            ctx.strokeRect(bx[0] * sx, bx[1] * sy, (bx[2] - bx[0]) * sx, (bx[3] - bx[1]) * sy);
            ctx.setLineDash([]);
        }
        (d?.points || prompt?.points || []).forEach((p) => {
            const x = p[0] * sx;
            const y = p[1] * sy;
            const rr = 6.5 * dpr;
            ctx.beginPath();
            ctx.arc(x, y, rr, 0, Math.PI * 2);
            ctx.fillStyle = p[2] ? '#2ee66b' : '#ff3b3b';
            ctx.fill();
            ctx.lineWidth = 2 * dpr;
            ctx.strokeStyle = '#000';
            ctx.stroke();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.6 * dpr;
            ctx.beginPath();
            ctx.moveTo(x - 3.2 * dpr, y);
            ctx.lineTo(x + 3.2 * dpr, y);
            if (p[2]) { ctx.moveTo(x, y - 3.2 * dpr); ctx.lineTo(x, y + 3.2 * dpr); }
            ctx.stroke();
        });
        // A stroke being painted.
        if (d?.kind === 'stroke' && d.pts.length) {
            ctx.strokeStyle = d.mode === 'erase' ? 'rgba(0,0,0,0.65)' : (active?.color || '#fff');
            ctx.globalAlpha = 0.75;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 2 * radius * sx;
            ctx.beginPath();
            d.pts.forEach((p, i) => (i ? ctx.lineTo(p[0] * sx, p[1] * sy) : ctx.moveTo(p[0] * sx, p[1] * sy)));
            if (d.pts.length === 1) ctx.lineTo(d.pts[0][0] * sx + 0.01, d.pts[0][1] * sy);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        // The brush.
        if (hover && tool !== 'click') {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.2 * dpr;
            ctx.beginPath();
            ctx.arc(hover.x * sx, hover.y * sy, radius * sx, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = '#000';
            ctx.beginPath();
            ctx.arc(hover.x * sx, hover.y * sy, radius * sx + 1.2 * dpr, 0, Math.PI * 2);
            ctx.stroke();
        }
    }, [objects, activeId, active, hidden, masks, frame, W, H, prompt, hover, tool, radius]);

    useEffect(() => { draw(); }, [draw, drawTick]);
    useEffect(() => {
        const c = canvasRef.current;
        if (!c || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => draw());
        ro.observe(c);
        return () => ro.disconnect();
    }, [draw]);

    const nearest = (e) => {
        const p = at(e);
        let best = -1;
        let bd = HIT_PX;
        (prompt?.points || []).forEach((q, i) => {
            const d = Math.hypot((q[0] - p.x) * p.k, (q[1] - p.y) * p.k);
            if (d < bd) { bd = d; best = i; }
        });
        return best;
    };

    const onDown = (e) => {
        if (!active) return;
        e.preventDefault();
        canvasRef.current.setPointerCapture?.(e.pointerId);
        const p = at(e);
        if (tool === 'click') {
            if (busy) return;
            const hit = nearest(e);
            const points = (prompt?.points || []).map((q) => [...q]);
            if (hit >= 0 && e.button === 2) {
                points.splice(hit, 1);
                onPrompt(points, prompt?.box || null);
                return;
            }
            if (hit >= 0) {
                drag.current = { kind: 'point', idx: hit, points, boxKeep: prompt?.box || null, moved: false };
            } else {
                drag.current = {
                    kind: 'pending', x0: p.x, y0: p.y, sx: p.sx, sy: p.sy,
                    label: e.altKey || e.button === 2 ? 0 : 1,
                };
            }
        } else {
            const mode = (tool === 'erase') !== e.altKey ? 'erase' : 'add';
            drag.current = { kind: 'stroke', mode, pts: [[p.x, p.y]] };
        }
        bump();
        draw();
    };

    const onMove = (e) => {
        const p = at(e);
        setHover({ x: p.x, y: p.y });
        const d = drag.current;
        if (!d) return;
        if (d.kind === 'point') {
            d.points[d.idx][0] = Math.max(0, Math.min(W, p.x));
            d.points[d.idx][1] = Math.max(0, Math.min(H, p.y));
            d.moved = true;
        } else if (d.kind === 'pending' && Math.hypot(p.sx - d.sx, p.sy - d.sy) > DRAG_PX) {
            drag.current = { kind: 'box', x0: d.x0, y0: d.y0, box: [d.x0, d.y0, p.x, p.y], points: prompt?.points || [] };
        } else if (d.kind === 'box') {
            d.box = [d.x0, d.y0, Math.max(0, Math.min(W, p.x)), Math.max(0, Math.min(H, p.y))];
        } else if (d.kind === 'stroke') {
            const last = d.pts[d.pts.length - 1];
            if (Math.hypot(p.x - last[0], p.y - last[1]) >= Math.max(1, radius / 4)) d.pts.push([p.x, p.y]);
        }
        draw();
    };

    const onUp = (e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const old = prompt?.points || [];
        if (d.kind === 'point') {
            if (d.moved) onPrompt(d.points, prompt?.box || null);
        } else if (d.kind === 'pending') {
            onPrompt([...old.map((q) => [...q]), [d.x0, d.y0, d.label]], prompt?.box || null);
        } else if (d.kind === 'box') {
            const [x0, y0, x1, y1] = d.box;
            onPrompt(old, [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
        } else if (d.kind === 'stroke') {
            onStroke({ stroke: { mode: d.mode, r: radius, pts: d.pts } });
        }
        bump();
        draw();
        e.preventDefault();
    };

    const cursor = !active ? 'not-allowed' : tool === 'click' ? (busy ? 'wait' : 'crosshair') : 'none';
    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 3, cursor, touchAction: 'none',
            }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => { drag.current = null; draw(); }}
            onPointerLeave={() => setHover(null)}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => {
                if (tool === 'click' || !e.altKey) return;
                setRadius((r) => Math.max(2, Math.min(300, r * (e.deltaY > 0 ? 0.9 : 1.1))));
            }}
        />
    );
}

// ---- Panel ------------------------------------------------------------------------

export default function RotoEditor({
    take, info, frame, seekFrame, active, setActive, plain, setPlain, mountEl,
    holdout, setHoldout, onWritten,
}) {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const [note, setNote] = useState('');
    const [activeId, setActiveId] = useState(null);
    const [hidden, setHidden] = useState({});
    const [tool, setTool] = useState('click');
    const [radius, setRadius] = useState(14);
    const [drawTick, setDrawTick] = useState(0);
    const [waiting, setWaiting] = useState(false);
    const [matte, setMatte] = useState(null);
    const masks = useRef(new Map()); // `${obj}|${frame}` -> { rev, canvas }
    const fetching = useRef(new Map());
    const takeRef = useRef(take);
    takeRef.current = take;
    const n = info?.frames || 1;

    const objects = useMemo(() => status?.objects || [], [status]);
    const job = status?.job || null;
    const running = !!job && !job.finished;
    const activeObj = objects.find((o) => o.id === activeId) || null;
    const prompt = activeObj?.prompts?.[String(frame)] || null;

    const refresh = useCallback(async (first = false) => {
        try {
            const s = await (first ? rotoApi.session(take) : rotoApi.status(take));
            if (takeRef.current !== take) return null;
            setStatus(s);
            setError(null);
            if (first && s.matte) setMatte(s.matte);
            return s;
        } catch (e) {
            setError(e.message);
            return null;
        }
    }, [take]);

    // Open the take on the server when Roto mode comes on.
    useEffect(() => {
        if (!active || !take) return undefined;
        masks.current.clear();
        setStatus(null);
        setNote('');
        refresh(true).then((s) => {
            if (s && s.objects.length) setActiveId((id) => (s.objects.some((o) => o.id === id) ? id : s.objects[0].id));
        });
        return undefined;
    }, [active, take, refresh]);

    // Poll: quickly while a job runs, slowly while the model loads.
    useEffect(() => {
        if (!active || !status) return undefined;
        const busy = running || !status.loaded;
        if (!busy) return undefined;
        const id = setTimeout(() => refresh(), running ? 400 : 1000);
        return () => clearTimeout(id);
    }, [active, status, running, refresh]);

    // A write that just finished: hand the new mattes to the compositor.
    const lastJob = useRef(null);
    useEffect(() => {
        if (!job || !job.finished || lastJob.current === job.started) return;
        lastJob.current = job.started;
        if (job.error) setNote(`${job.kind} failed: ${job.error}`);
        else if (job.kind === 'write' && job.result) {
            setWritten(take, job.result);
            onWritten?.();
            setNote(`Wrote ${job.result.objects.length} matte${job.result.objects.length === 1 ? '' : 's'} in ${job.seconds}s`);
        } else if (job.kind === 'propagate') {
            setNote(`${job.cancelled ? 'Stopped after' : 'Tracked'} ${job.done} frames in ${job.seconds}s`
                + (job.perFrame ? ` (${job.perFrame.toFixed(2)} s/frame)` : ''));
        }
    }, [job, take, onWritten]);

    // Masks for this frame, for every visible object whose mask is newer
    // than the one held.
    useEffect(() => {
        if (!active || !status) return;
        objects.forEach((o) => {
            if (hidden[o.id]) return;
            const key = `${o.id}|${frame}`;
            const have = masks.current.get(key);
            if (have && have.rev >= o.rev) return;
            if (!inRuns(o.masked, frame) && !o.strokes.includes(frame)) {
                masks.current.set(key, { rev: o.rev, canvas: null });
                setDrawTick((v) => v + 1);
                return;
            }
            const token = {};
            fetching.current.set(o.id, token);
            rotoApi.mask(take, o.id, frame, o.rev).then(({ bitmap, rev }) => {
                if (fetching.current.get(o.id) !== token) return;
                masks.current.set(key, { rev: Math.max(rev, o.rev), canvas: bitmap ? tintMask(bitmap, o.color) : null });
                bitmap?.close();
                if (masks.current.size > 80) masks.current.delete(masks.current.keys().next().value);
                setDrawTick((v) => v + 1);
            }).catch(() => {});
        });
    }, [active, status, objects, frame, hidden, take]);

    const landMask = useCallback((obj, f, reply) => {
        const o = objects.find((x) => x.id === obj);
        masks.current.set(`${obj}|${f}`, {
            rev: reply.rev,
            canvas: reply.bitmap ? tintMask(reply.bitmap, o?.color) : null,
        });
        reply.bitmap?.close();
        setDrawTick((v) => v + 1);
    }, [objects]);

    // Optimistic: show the clicks at once, the mask when it comes.
    const sendPrompt = useCallback(async (points, box) => {
        if (!activeObj) return;
        const obj = activeObj.id;
        const f = frame;
        setStatus((s) => s && {
            ...s,
            objects: s.objects.map((o) => (o.id !== obj ? o : {
                ...o, prompts: { ...o.prompts, [String(f)]: { points, box } },
            })),
        });
        setWaiting(true);
        try {
            const reply = await rotoApi.prompt(take, obj, f, points, box);
            landMask(obj, f, reply);
            setNote('');
        } catch (e) {
            setNote(e.message);
        } finally {
            setWaiting(false);
            refresh();
        }
    }, [activeObj, frame, take, landMask, refresh]);

    const sendStroke = useCallback(async (body) => {
        if (!activeObj) return;
        const obj = activeObj.id;
        const f = frame;
        try {
            landMask(obj, f, await rotoApi.stroke(take, obj, f, body));
        } catch (e) {
            setNote(e.message);
        }
        refresh();
    }, [activeObj, frame, take, landMask, refresh]);

    const objectOp = useCallback(async (body) => {
        try {
            const s = await rotoApi.object(take, body);
            setStatus(s);
            return s;
        } catch (e) {
            setNote(e.message);
            return null;
        }
    }, [take]);

    const propagate = useCallback(async (mode) => {
        if (!activeObj) return;
        try {
            await rotoApi.propagate(take, activeObj.id, mode, frame);
            setNote('');
            refresh();
        } catch (e) { setNote(e.message); }
    }, [activeObj, take, frame, refresh]);

    const writeMattes = useCallback(async () => {
        try {
            await rotoApi.write(take, matte || undefined);
            setNote('');
            refresh();
        } catch (e) { setNote(e.message); }
    }, [take, matte, refresh]);

    // Keys while Roto mode is on.
    useEffect(() => {
        if (!active) return undefined;
        const onKey = (e) => {
            if (e.target.matches?.('input, select, textarea')) return;
            const k = e.key;
            if (k === ',' || k === '.') {
                e.preventDefault();
                seekFrame(Math.max(0, Math.min(n - 1, frame + (k === ',' ? -1 : 1) * (e.shiftKey ? 10 : 1))));
            } else if (k === '[' || k === ']') {
                setRadius((r) => Math.max(2, Math.min(300, r * (k === '[' ? 0.8 : 1.25))));
            } else if (k === 'c' || k === 'C') setTool('click');
            else if (k === 'b' || k === 'B') setTool('brush');
            else if (k === 'e' || k === 'E') setTool('erase');
            else return;
            e.stopPropagation();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [active, frame, n, seekFrame]);

    // ---- Timeline strip: what each object has, frame by frame ----
    const stripRef = useRef(null);
    useEffect(() => {
        const c = stripRef.current;
        if (!c || !active) return;
        const w = c.clientWidth * (window.devicePixelRatio || 1);
        const rows = Math.max(1, objects.length);
        const rowH = 7 * (window.devicePixelRatio || 1);
        c.width = Math.max(1, w);
        c.height = rows * rowH + 2;
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'rgba(127,127,127,0.18)';
        ctx.fillRect(0, 0, c.width, c.height);
        const x = (f) => (f / n) * c.width;
        objects.forEach((o, i) => {
            const y = i * rowH + 1;
            ctx.globalAlpha = hidden[o.id] ? 0.25 : 0.55;
            ctx.fillStyle = o.color;
            o.masked.forEach(([a, b]) => ctx.fillRect(x(a), y, Math.max(1, x(b + 1) - x(a)), rowH - 1));
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#fff';
            o.keys.forEach((f) => ctx.fillRect(x(f), y, 2, rowH - 1));
            ctx.fillStyle = '#ffd54a';
            o.strokes.forEach((f) => ctx.fillRect(x(f) + 2, y + rowH / 2, 2, rowH / 2 - 1));
        });
        if (running && job.frame != null) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fillRect(x(job.frame), 0, 1, c.height);
        }
        ctx.fillStyle = '#ff3b3b';
        ctx.fillRect(x(frame + 0.5) - 1, 0, 2, c.height);
    }, [active, objects, hidden, frame, n, running, job]);

    const keysOf = activeObj ? activeObj.keys : [];
    const prevKey = [...keysOf].reverse().find((f) => f < frame);
    const nextKey = keysOf.find((f) => f > frame);
    const published = mattesFor(take);

    const btn = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 };
    const seg = (options, value, pick) => (
        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
            {options.map(([id, name, title]) => (
                <button
                    key={id}
                    type="button"
                    title={title}
                    className={`${styles.vfx_segBtn} ${value === id ? styles.vfx_segBtnOn : ''}`}
                    onClick={() => pick(id)}
                >
                    {name}
                </button>
            ))}
        </div>
    );
    const sw = (label, on, flip, title) => (
        <div
            className={styles.vfx_checkRow}
            role="button"
            tabIndex={0}
            title={title}
            onClick={flip}
            onKeyDown={(e) => { if (e.key === 'Enter') flip(); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${on ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );
    const range = (label, value, min, max, step, set, shown = value) => (
        <div className={styles.vfx_row}>
            <span className={styles.vfx_label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => set(parseFloat(e.target.value))}
            />
            <span className={styles.vfx_value}>{shown}</span>
        </div>
    );

    const pct = running && job.total ? Math.round((job.done / job.total) * 100) : 0;
    const eta = running && job.done > 2
        ? Math.round(((Date.now() / 1000 - job.started) / job.done) * (job.total - job.done)) : null;

    const panel = (
        <div className={styles.vfx_section}>
            <div className={styles.vfx_sectionTitle}>Roto (object mattes)</div>
            <button
                type="button"
                className={`${styles.vfx_select} ${active ? styles.vfx_segBtnOn : ''}`}
                style={{ ...btn, marginBottom: 9 }}
                disabled={!take || !info}
                onClick={() => setActive(!active)}
            >
                <Scissors size={13} />
                {active ? 'Leave Roto mode' : 'Roto mode'}
            </button>

            {!active && published.length > 0 && (
                <div className={styles.vfx_hint} style={{ marginBottom: 6 }}>
                    {published.length} matte{published.length === 1 ? '' : 's'} on this take.
                </div>
            )}

            {active && (
                <>
                    {error && (
                        <div className={styles.vfx_hint} style={{ opacity: 0.85, color: '#ff8080', marginBottom: 8 }}>
                            {error}
                            {' '}
                            Rotoscoping runs SAM 2 on this machine through
                            {' '}
                            <code>npm start</code>
                            ; the server log is backend/vidtrack/roto_server.log.
                        </div>
                    )}
                    {!status && !error && <div className={styles.vfx_hint}>Opening the take...</div>}
                    {status && (
                        <>
                            <div className={styles.vfx_hint} style={{ marginBottom: 8 }}>
                                SAM 2
                                {' '}
                                {status.model}
                                {' · '}
                                {status.openError ? `failed: ${status.openError}` : status.loaded ? 'ready' : 'loading the model...'}
                            </div>

                            {sw('Plain footage', plain, () => setPlain(!plain), 'Hide the 3D layers while rotoscoping')}

                            <div className={styles.vfx_playRow} style={{ margin: '4px 0 9px' }}>
                                <button type="button" className={styles.vfx_iconBtn} aria-label="Previous keyframe" disabled={prevKey == null} onClick={() => seekFrame(prevKey)} title="Previous frame with clicks">
                                    <ChevronLeft size={12} />
                                    <ChevronLeft size={12} style={{ marginLeft: -8 }} />
                                </button>
                                <button type="button" className={styles.vfx_iconBtn} aria-label="Previous frame" onClick={() => seekFrame(Math.max(0, frame - 1))} title="Previous frame (,)">
                                    <ChevronLeft size={14} />
                                </button>
                                <span className={styles.vfx_value} style={{ flex: 1, textAlign: 'center' }}>
                                    Frame
                                    {' '}
                                    {frame}
                                    {' / '}
                                    {n - 1}
                                </span>
                                <button type="button" className={styles.vfx_iconBtn} aria-label="Next frame" onClick={() => seekFrame(Math.min(n - 1, frame + 1))} title="Next frame (.)">
                                    <ChevronRight size={14} />
                                </button>
                                <button type="button" className={styles.vfx_iconBtn} aria-label="Next keyframe" disabled={nextKey == null} onClick={() => seekFrame(nextKey)} title="Next frame with clicks">
                                    <ChevronRight size={12} />
                                    <ChevronRight size={12} style={{ marginLeft: -8 }} />
                                </button>
                            </div>
                            <canvas
                                ref={stripRef}
                                style={{ width: '100%', height: Math.max(1, objects.length) * 7 + 2, display: 'block', cursor: 'pointer', marginBottom: 10 }}
                                onClick={(e) => {
                                    const r = e.currentTarget.getBoundingClientRect();
                                    seekFrame(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
                                }}
                                title="Each object's frames: tinted where it has a mask, white where it has clicks, yellow where it is painted. Click to go there."
                            />

                            {objects.map((o) => (
                                <div
                                    key={o.id}
                                    className={styles.vfx_playRow}
                                    style={{
                                        marginBottom: 6,
                                        padding: '3px 4px',
                                        outline: o.id === activeId ? '1px solid var(--accent)' : 'none',
                                    }}
                                >
                                    <button
                                        type="button"
                                        aria-label={`Edit ${o.name}`}
                                        title="Edit this object"
                                        onClick={() => setActiveId(o.id)}
                                        style={{
                                            width: 14, height: 14, flex: 'none', border: 'none', cursor: 'pointer', background: o.color,
                                        }}
                                    />
                                    <input
                                        className={styles.vfx_select}
                                        style={{ flex: 1, minWidth: 0, padding: '4px 6px' }}
                                        defaultValue={o.name}
                                        key={`${o.id}-${o.name}`}
                                        onFocus={() => setActiveId(o.id)}
                                        onBlur={(e) => {
                                            const v = e.target.value.trim();
                                            if (v && v !== o.name) objectOp({ action: 'update', obj: o.id, name: v });
                                        }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                    />
                                    {o.stale && <span className={styles.vfx_hint} title="Clicks changed since this object was last propagated through the whole take">*</span>}
                                    <button
                                        type="button"
                                        className={styles.vfx_iconBtn}
                                        aria-label={hidden[o.id] ? 'Show' : 'Hide'}
                                        title={hidden[o.id] ? 'Show its mask' : 'Hide its mask'}
                                        onClick={() => setHidden((h) => ({ ...h, [o.id]: !h[o.id] }))}
                                    >
                                        {hidden[o.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.vfx_iconBtn}
                                        aria-label="Delete"
                                        title="Delete this object, its clicks, paint and masks"
                                        disabled={running}
                                        onClick={() => {
                                            // eslint-disable-next-line no-alert
                                            if (!window.confirm(`Delete "${o.name}" and everything drawn for it?`)) return;
                                            objectOp({ action: 'delete', obj: o.id }).then((s) => {
                                                if (s && activeId === o.id) setActiveId(s.objects[0]?.id || null);
                                            });
                                        }}
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ ...btn, marginBottom: 10 }}
                                onClick={() => objectOp({ action: 'add' }).then((s) => s && setActiveId(s.obj))}
                            >
                                <Plus size={13} />
                                Add an object
                            </button>

                            {activeObj && (
                                <>
                                    {seg(TOOLS, tool, setTool)}
                                    {tool !== 'click' && range('Brush', radius, 2, 200, 1, setRadius, `${Math.round(radius)}px`)}
                                    <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                                        <button
                                            type="button"
                                            className={styles.vfx_segBtn}
                                            disabled={!prompt || running}
                                            title="Remove the clicks and box on this frame"
                                            onClick={() => sendPrompt([], null)}
                                        >
                                            Clear clicks
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.vfx_segBtn}
                                            disabled={!prompt?.box || running}
                                            title="Remove just the box"
                                            onClick={() => sendPrompt(prompt.points || [], null)}
                                        >
                                            <Square size={10} style={{ marginRight: 4 }} />
                                            No box
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.vfx_segBtn}
                                            disabled={!activeObj.strokes.includes(frame)}
                                            title="Take back the last brush stroke on this frame"
                                            onClick={() => sendStroke({ undo: true })}
                                        >
                                            <Undo2 size={10} style={{ marginRight: 4 }} />
                                            Stroke
                                        </button>
                                    </div>

                                    <div className={styles.vfx_hint} style={{ margin: '4px 0 6px' }}>
                                        Track
                                        {' '}
                                        {activeObj.name}
                                    </div>
                                    <div className={styles.vfx_segRow} style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
                                        <button type="button" className={styles.vfx_segBtn} disabled={running || !activeObj.keys.length} onClick={() => propagate('all')} title="From its first clicked frame forwards to the end, then backwards to the start">
                                            Whole take
                                        </button>
                                        <button type="button" className={styles.vfx_segBtn} disabled={running || !activeObj.keys.length} onClick={() => propagate('backward')} title="From this frame back to the start">
                                            ← here
                                        </button>
                                        <button type="button" className={styles.vfx_segBtn} disabled={running || !activeObj.keys.length} onClick={() => propagate('forward')} title="From this frame on to the end">
                                            here →
                                        </button>
                                    </div>
                                </>
                            )}

                            {running && (
                                <div style={{ marginBottom: 9 }}>
                                    <div style={{ height: 3, background: 'var(--line)', margin: '2px 0 6px' }}>
                                        <div style={{ height: 3, width: `${pct}%`, background: 'var(--accent)' }} />
                                    </div>
                                    <div className={styles.vfx_playRow}>
                                        <span className={styles.vfx_hint} style={{ flex: 1, opacity: 0.8 }}>
                                            {job.kind === 'write' ? 'Writing mattes' : `Tracking ${objects.find((o) => o.id === job.obj)?.name || ''}`}
                                            {' '}
                                            {job.done}
                                            /
                                            {job.total || '?'}
                                            {eta != null ? ` · ${eta}s left` : ''}
                                        </span>
                                        <button type="button" className={styles.vfx_segBtn} onClick={() => rotoApi.cancel(take).then(() => refresh())}>
                                            Stop
                                        </button>
                                    </div>
                                </div>
                            )}
                            {(note || waiting) && (
                                <div className={styles.vfx_hint} style={{ opacity: 0.75, marginBottom: 8 }}>
                                    {waiting ? 'Segmenting...' : note}
                                </div>
                            )}

                            <div className={styles.vfx_hint} style={{ margin: '8px 0 6px' }}>Matte output</div>
                            {matte && (
                                <>
                                    {range('Feather', matte.feather, 0, 8, 0.1, (v) => setMatte((m) => ({ ...m, feather: v })), `${matte.feather.toFixed(1)}px`)}
                                    {range('Smooth', matte.smooth, 0, 3, 1, (v) => setMatte((m) => ({ ...m, smooth: v })), `±${matte.smooth}f`)}
                                    {range('Choke', matte.choke, -1, 1, 0.05, (v) => setMatte((m) => ({ ...m, choke: v })), matte.choke.toFixed(2))}
                                </>
                            )}
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ ...btn, marginBottom: 8 }}
                                disabled={running || !objects.length}
                                onClick={writeMattes}
                            >
                                <FileDown size={13} />
                                Write mattes
                            </button>
                            <div className={styles.vfx_hint}>
                                Pick an object (or add one), then on the
                                footage: click to include, alt-click or
                                right-click to exclude, drag for a box, drag
                                a click to move it, right-click one to remove
                                it. Track it through the take, scrub with , and
                                ., fix a bad frame with more clicks and track
                                again - or paint it with the brush (alt
                                inverts, [ ] sizes), which wins over the model
                                on that frame. Everything saves as you go, to
                                backend/vidtrack/roto/
                                {take}
                                .json. Write mattes publishes each object as a
                                grayscale video beside the take.
                            </div>
                        </>
                    )}
                </>
            )}

            {published.length > 0 && (
                <>
                    <div className={styles.vfx_hint} style={{ margin: '10px 0 6px' }}>Holdouts</div>
                    {published.map((m) => (
                        <React.Fragment key={m.id}>
                            {sw(
                                m.name,
                                holdout[m.id] !== false,
                                () => setHoldout(m.id, holdout[m.id] === false),
                                'Hide anything placed in front of the video wherever this object is',
                            )}
                        </React.Fragment>
                    ))}
                    <div className={styles.vfx_hint}>
                        A held-out object stays in front: whatever is placed
                        in front of the video is hidden where it is, as if
                        it passed behind the real thing. Windows can also be
                        held to a matte, in each window&apos;s panel.
                    </div>
                </>
            )}
        </div>
    );

    const overlay = active && status && mountEl ? createPortal(
        <RotoOverlay
            size={{ width: status.width, height: status.height }}
            frame={frame}
            objects={objects}
            activeId={activeId}
            hidden={hidden}
            masks={masks}
            tool={tool}
            radius={radius}
            setRadius={setRadius}
            prompt={prompt}
            onPrompt={sendPrompt}
            onStroke={sendStroke}
            busy={running || waiting}
            drawTick={drawTick}
        />,
        mountEl,
    ) : null;

    return (
        <>
            {panel}
            {overlay}
        </>
    );
}
