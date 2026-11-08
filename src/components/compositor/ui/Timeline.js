// The timeline: video tracks (top first), audio tracks, and a lane per
// controller. Clips move and trim by dragging; media drops in from the
// outliner. Keyframe lanes take keys, Switch lanes take cuts, and the audio
// controllers draw what they hear so a link can be lined up against it.

import React, {
    useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
    Eye, EyeOff, Plus, ZoomIn, ZoomOut, Scissors, Magnet, Activity,
} from 'lucide-react';
import { Film, Music } from './icons';
import { clipEnd, fits, sourceSpan } from '../model/timeline';
import { CONTROLLER_TYPES, controllerTrace, kickTimes } from '../model/controllers';
import { useComp, useTick } from './context';
import styles from '../compositor.module.css';

const HEAD_W = 132;
const stateColor = (i, n) => `hsl(${(i * 360) / Math.max(1, n) + 200}, 55%, ${i === 0 ? 30 : 62}%)`;

function niceStep(pps) {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    return steps.find((s) => s * pps >= 70) || 600;
}

const fmtT = (s) => {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return m ? `${m}:${r.toFixed(0).padStart(2, '0')}` : `${r.toFixed(r % 1 ? 1 : 0)}s`;
};

// Controller lanes are drawn as SVG in timeline seconds (the viewBox spans
// the lane's whole length, stretched to its width), so zooming only rescales
// the vectors: they stay sharp, and nothing is re-sampled per zoom level.
const TRACE_RATE = 60; // samples a second of an audio controller's signal

/** An audio or LFO controller's signal across its lane. */
function TraceSvg({ ctrl, seconds, width, height, analysis }) {
    const { line, area, hits } = useMemo(() => {
        if (!analysis?.music && (ctrl.type === 'kick' || ctrl.type === 'band')) return { line: '', area: '', hits: [] };
        const n = Math.max(2, Math.min(40000, Math.ceil(seconds * TRACE_RATE)));
        const vals = controllerTrace(ctrl, 0, seconds, n, analysis);
        const pts = [];
        for (let i = 0; i < n; i++) pts.push(`${((i / (n - 1)) * seconds).toFixed(3)},${(1 - vals[i]).toFixed(4)}`);
        const l = pts.join(' ');
        return {
            line: l,
            area: `0,1 ${l} ${seconds},1`,
            hits: ctrl.type === 'kick' && analysis?.music ? kickTimes(ctrl, analysis.music).filter((t) => t <= seconds) : [],
        };
    }, [ctrl, seconds, analysis]);
    return (
        <svg className={styles.trace} width={width} height={height} viewBox={`0 -0.06 ${seconds} 1.1`} preserveAspectRatio="none">
            <polygon points={area} fill={ctrl.color} fillOpacity="0.3" />
            <polyline points={line} fill="none" stroke={ctrl.color} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {hits.map((t) => <line key={t} x1={t} x2={t} y1={-0.06} y2={0.08} stroke="#ecebe6" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        </svg>
    );
}

/** A keyframe controller's curve, exactly through its keys. */
function keysPath(keys, interp, seconds) {
    if (!keys.length) return '';
    const y = (v) => (1 - v).toFixed(4);
    const pts = [`0,${y(keys[0].v)}`];
    keys.forEach((k, i) => {
        if (i > 0) {
            const a = keys[i - 1];
            if (interp === 'hold') pts.push(`${k.t},${y(a.v)}`);
            else if (interp === 'smooth') {
                for (let j = 1; j < 24; j++) {
                    const f = j / 24;
                    const e = f * f * (3 - 2 * f);
                    pts.push(`${(a.t + (k.t - a.t) * f).toFixed(4)},${y(a.v + (k.v - a.v) * e)}`);
                }
            }
        }
        pts.push(`${k.t},${y(k.v)}`);
    });
    pts.push(`${seconds},${y(keys[keys.length - 1].v)}`);
    return pts.join(' ');
}

/** Peaks of an audio buffer section, drawn across a clip. */
function WaveCanvas({ buffer, clip, media, width, height }) {
    const ref = useRef(null);
    useEffect(() => {
        const c = ref.current;
        if (!c || !buffer) return;
        const w = Math.max(1, Math.min(3000, Math.round(width)));
        c.width = w;
        c.height = height;
        const g = c.getContext('2d');
        g.clearRect(0, 0, w, height);
        const ch = buffer.getChannelData(0);
        const sr = buffer.sampleRate;
        const span = Math.min(sourceSpan(clip, media), buffer.duration - clip.in);
        g.fillStyle = 'rgba(255,255,255,0.7)';
        for (let x = 0; x < w; x++) {
            const tl = (x / w) * clip.dur * (clip.rate || 1);
            let s0 = tl;
            if (clip.loop !== 'off' && span > 0) s0 = tl % span;
            else if (tl > span) continue;
            const a = Math.floor((clip.in + s0) * sr);
            const b = Math.min(ch.length, a + Math.max(1, Math.floor((clip.dur * sr) / w)));
            let m = 0;
            for (let i = a; i < b; i += 4) { const v = Math.abs(ch[i]); if (v > m) m = v; }
            const h = m * (height - 4);
            g.fillRect(x, (height - h) / 2, 1, Math.max(1, h));
        }
    }, [buffer, clip, media, width, height]);
    return <canvas ref={ref} className={styles.clipWave} style={{ width, height }} />;
}

export default function Timeline() {
    const comp = useComp();
    const { project } = comp;
    const [pps, setPps] = useState(60); // pixels per second
    const [snap, setSnap] = useState(true);
    const [drop, setDrop] = useState(null);
    const scrollRef = useRef(null);
    const playheadRef = useRef(null);
    const timeRef = useRef(0);
    const duration = comp.duration;
    const width = Math.max((duration + 10) * pps, 600);

    const videoTracks = project.tracks.filter((t) => t.kind === 'video');
    const audioTracks = project.tracks.filter((t) => t.kind === 'audio');
    const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);

    useTick((t) => {
        timeRef.current = t;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${HEAD_W + t * pps}px)`;
        const sc = scrollRef.current;
        if (sc && comp.playing) {
            const x = HEAD_W + t * pps;
            // Either way: playing on past the right edge, or jumping back
            // (a loop, a ping-pong) behind the left one.
            if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft + HEAD_W) {
                sc.scrollLeft = Math.max(0, x - HEAD_W - 40);
            }
        }
    });

    // Zoom about the pointer with ctrl / cmd + wheel.
    useEffect(() => {
        const sc = scrollRef.current;
        if (!sc) return undefined;
        const onWheel = (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const box = sc.getBoundingClientRect();
            const x = e.clientX - box.left - HEAD_W + sc.scrollLeft;
            const t = x / pps;
            const next = Math.max(4, Math.min(800, pps * Math.exp(-e.deltaY * 0.0025)));
            setPps(next);
            requestAnimationFrame(() => { sc.scrollLeft = t * next - (e.clientX - box.left - HEAD_W); });
        };
        sc.addEventListener('wheel', onWheel, { passive: false });
        return () => sc.removeEventListener('wheel', onWheel);
    }, [pps]);

    const timeAt = useCallback((clientX) => {
        const sc = scrollRef.current;
        const box = sc.getBoundingClientRect();
        return Math.max(0, (clientX - box.left - HEAD_W + sc.scrollLeft) / pps);
    }, [pps]);

    // Snap points: the playhead, 0, and every clip edge.
    const snapTo = useCallback((t, ignoreId) => {
        if (!snap) return t;
        const cands = [0, timeRef.current];
        project.clips.forEach((c) => { if (c.id !== ignoreId) cands.push(c.start, clipEnd(c)); });
        const tol = 7 / pps;
        let best = t;
        let d = tol;
        cands.forEach((x) => { if (Math.abs(x - t) < d) { d = Math.abs(x - t); best = x; } });
        return best;
    }, [snap, project.clips, pps]);

    // ---- Scrubbing
    const scrub = (e) => {
        if (e.button !== 0) return;
        comp.seek(timeAt(e.clientX));
        const move = (ev) => comp.seek(timeAt(ev.clientX));
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // ---- Clips: move / trim
    const dragClip = (e, clip, mode) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        comp.select({ kind: 'clip', id: clip.id });
        const t0 = timeAt(e.clientX);
        const orig = { ...clip };
        const m = media.get(clip.mediaId);
        const track = project.tracks.find((t) => t.id === clip.trackId);
        const sameKind = project.tracks.filter((t) => t.kind === track.kind);
        let moved = false;
        const move = (ev) => {
            const dt = timeAt(ev.clientX) - t0;
            if (!moved && Math.abs(ev.clientX - e.clientX) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
            moved = true;
            comp.updateClip(clip.id, (c) => {
                if (mode === 'move') {
                    let start = Math.max(0, orig.start + dt);
                    const s1 = snapTo(start, clip.id);
                    const s2 = snapTo(start + orig.dur, clip.id) - orig.dur;
                    start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2;
                    // Up / down onto another track of the same kind.
                    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-track]');
                    const target = el && sameKind.find((t) => t.id === el.dataset.track);
                    const trackId = target && fits(comp.project, target.id, start, orig.dur, clip.id) ? target.id : c.trackId;
                    if (!fits(comp.project, trackId, start, orig.dur, clip.id)) return c;
                    return { ...c, start, trackId };
                }
                if (mode === 'left') {
                    let start = snapTo(Math.max(0, orig.start + dt), clip.id);
                    start = Math.min(start, clipEnd(orig) - 0.05);
                    const d = start - orig.start;
                    const inPt = m?.kind === 'stage' ? 0 : orig.in + d * (orig.rate || 1);
                    if (inPt < 0) return c;
                    if (!fits(comp.project, c.trackId, start, clipEnd(orig) - start, clip.id)) return c;
                    return { ...c, start, in: inPt, dur: clipEnd(orig) - start };
                }
                let end = snapTo(clipEnd(orig) + dt, clip.id);
                end = Math.max(orig.start + 0.05, end);
                if (!fits(comp.project, c.trackId, orig.start, end - orig.start, clip.id)) return c;
                return { ...c, dur: end - orig.start };
            }, false, `drag:${clip.id}`);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (moved) comp.commit();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // ---- Dropping media from the outliner
    const onDragOver = (e, track) => {
        if (!e.dataTransfer.types.includes('application/x-compositor-media')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDrop({ track: track.id, t: snapTo(timeAt(e.clientX)) });
    };
    const onDrop = (e, track) => {
        const id = e.dataTransfer.getData('application/x-compositor-media');
        setDrop(null);
        if (!id) return;
        e.preventDefault();
        comp.placeMedia(id, { trackId: track.id, at: snapTo(timeAt(e.clientX)) });
    };

    // ---- Keyframe lanes
    const keyLaneDown = (e, ctrl) => {
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        const t = snapTo(timeAt(e.clientX));
        const v = 1 - Math.max(0, Math.min(1, (e.clientY - box.top - 4) / (box.height - 8)));
        comp.addKey(ctrl.id, t, Math.round(v * 100) / 100);
    };
    const dragKey = (e, ctrl, key) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        comp.select({ kind: 'controller', id: ctrl.id });
        const lane = e.currentTarget.parentElement.getBoundingClientRect();
        const move = (ev) => {
            const t = snapTo(timeAt(ev.clientX));
            const v = 1 - Math.max(0, Math.min(1, (ev.clientY - lane.top - 4) / (lane.height - 8)));
            comp.updateController(ctrl.id, (c) => ({
                ...c,
                keys: c.keys.map((k) => (k.id === key.id ? { ...k, t, v: Math.round(v * 1000) / 1000 } : k)).sort((a, b) => a.t - b.t),
            }), false, `key:${key.id}`);
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); comp.commit(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // ---- Switch lanes
    const dragCut = (e, ctrl, cut) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const move = (ev) => {
            const t = Math.max(0, snapTo(timeAt(ev.clientX)));
            comp.updateController(ctrl.id, (c) => ({
                ...c, cuts: c.cuts.map((k) => (k.id === cut.id ? { ...k, t } : k)).sort((a, b) => a.t - b.t),
            }), false, `cut:${cut.id}`);
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); comp.commit(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    const selectedSwitch = comp.selection?.kind === 'controller'
        ? project.controllers.find((c) => c.id === comp.selection.id && c.type === 'switch') : null;

    const step = niceStep(pps);
    const ticks = [];
    for (let t = 0; t < width / pps; t += step) ticks.push(t);

    const laneHead = (key, label, on, onClick, extra) => (
        <div key={`h${key}`} className={`${styles.laneHead} ${on ? styles.laneHeadOn : ''}`} onClick={onClick}>
            {extra}
            <span className={styles.laneName}>{label}</span>
        </div>
    );

    const trackRow = (track) => {
        const on = comp.selection?.kind === 'track' && comp.selection.id === track.id;
        const vis = track.params?.visible !== false;
        const linked = !!track.links?.visible;
        const clips = project.clips.filter((c) => c.trackId === track.id);
        return (
            <div key={track.id} className={styles.lane}>
                {laneHead(track.id, track.name, on, () => comp.select({ kind: 'track', id: track.id }), (
                    <>
                        <button
                            type="button"
                            className={`${styles.olToggle} ${vis ? styles.olToggleOn : ''} ${linked ? styles.olLinked : ''}`}
                            title={linked ? 'Visibility follows a controller' : (vis ? 'Hide track' : 'Show track')}
                            onClick={(e) => { e.stopPropagation(); comp.updateTrack(track.id, (t) => ({ ...t, params: { ...t.params, visible: !vis } }), true); }}
                        >
                            {vis ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>
                        <span className={styles.olIcon}>{track.kind === 'audio' ? <Music size={11} /> : <Film size={11} />}</span>
                    </>
                ))}
                <div
                    className={`${styles.laneBody} ${on ? styles.laneBodyOn : ''}`}
                    style={{ width }}
                    data-track={track.id}
                    onDragOver={(e) => onDragOver(e, track)}
                    onDragLeave={() => setDrop(null)}
                    onDrop={(e) => onDrop(e, track)}
                    onPointerDown={(e) => { if (e.target === e.currentTarget) scrub(e); }}
                >
                    {clips.map((c) => {
                        const m = media.get(c.mediaId);
                        const kind = m?.kind;
                        const cls = comp.missingMedia.has(c.mediaId) ? styles.clipMissing
                            : kind === 'take' ? styles.clipTake : kind === 'stage' ? styles.clipStage
                                : kind === 'audio' ? styles.clipAudio : styles.clipVideo;
                        const sel = comp.selection?.kind === 'clip' && comp.selection.id === c.id;
                        const span = sourceSpan(c, m) / (c.rate || 1);
                        const loops = [];
                        if (Number.isFinite(span) && c.loop !== 'off') for (let x = span; x < c.dur && loops.length < 200; x += span) loops.push(x);
                        return (
                            <div
                                key={c.id}
                                className={`${styles.clip} ${cls} ${sel ? styles.clipOn : ''}`}
                                style={{ left: c.start * pps, width: Math.max(4, c.dur * pps) }}
                                onPointerDown={(e) => dragClip(e, c, 'move')}
                                title={`${m?.name || 'missing'} · ${c.dur.toFixed(2)}s`}
                            >
                                {kind === 'audio' && comp.audioBuffers.get(c.mediaId) && (
                                    <WaveCanvas buffer={comp.audioBuffers.get(c.mediaId)} clip={c} media={m} width={c.dur * pps} height={32} />
                                )}
                                {loops.map((x) => <span key={x} className={styles.clipLoopMark} style={{ left: x * pps }} />)}
                                <span className={styles.clipLabel}>{m?.name || 'Missing media'}{c.loop !== 'off' ? ` · ${c.loop === 'bounce' ? 'ping-pong' : 'loop'}` : ''}</span>
                                <span className={`${styles.trim} ${styles.trimL}`} onPointerDown={(e) => dragClip(e, c, 'left')} />
                                <span className={`${styles.trim} ${styles.trimR}`} onPointerDown={(e) => dragClip(e, c, 'right')} />
                            </div>
                        );
                    })}
                    {drop?.track === track.id && <span className={styles.dropHint} style={{ left: drop.t * pps, width: 80 }} />}
                </div>
            </div>
        );
    };

    const controllerRow = (ctrl) => {
        const on = comp.selection?.kind === 'controller' && comp.selection.id === ctrl.id;
        const type = CONTROLLER_TYPES[ctrl.type];
        let body;
        if (ctrl.type === 'switch') {
            const cuts = ctrl.cuts || [];
            body = cuts.map((c, i) => {
                const end = i + 1 < cuts.length ? cuts[i + 1].t : width / pps;
                return (
                    <React.Fragment key={c.id}>
                        <div
                            className={`${styles.seg2} ${on ? styles.seg2On : ''}`}
                            style={{ left: c.t * pps, width: Math.max(1, (end - c.t) * pps), background: stateColor(c.s, ctrl.states.length) }}
                            title={`${ctrl.states[c.s]} · alt-click to step its state`}
                            onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                comp.select({ kind: 'controller', id: ctrl.id });
                                if (e.altKey) {
                                    comp.updateController(ctrl.id, (x) => ({
                                        ...x, cuts: x.cuts.map((k) => (k.id === c.id ? { ...k, s: (k.s + 1) % x.states.length } : k)),
                                    }), true);
                                } else {
                                    scrub(e);
                                }
                            }}
                        >
                            {ctrl.states[c.s]}
                        </div>
                        {i > 0 && (
                            <span
                                className={styles.cutHandle}
                                style={{ left: c.t * pps }}
                                title="Drag to move the cut, double-click to remove it"
                                onPointerDown={(e) => dragCut(e, ctrl, c)}
                                onDoubleClick={() => comp.updateController(ctrl.id, (x) => ({ ...x, cuts: x.cuts.filter((k) => k.id !== c.id) }), true)}
                            />
                        )}
                    </React.Fragment>
                );
            });
        } else if (ctrl.type === 'keys') {
            // Keys sit 4px in from the lane's top and bottom (0..1 over 32px).
            body = (
                <>
                    {ctrl.keys.length > 0 && (
                        <svg className={styles.trace} width={width} height={40} viewBox={`0 ${-4 / 32} ${width / pps} ${40 / 32}`} preserveAspectRatio="none">
                            <polyline points={keysPath(ctrl.keys, ctrl.params.interp, width / pps)} fill="none" stroke={ctrl.color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
                        </svg>
                    )}
                    {ctrl.keys.map((k) => (
                        <span
                            key={k.id}
                            className={styles.key}
                            style={{ left: k.t * pps, top: 4 + (1 - k.v) * 32, background: ctrl.color }}
                            title={`${k.t.toFixed(2)}s · ${k.v.toFixed(2)}`}
                            onPointerDown={(e) => dragKey(e, ctrl, k)}
                            onDoubleClick={(e) => { e.stopPropagation(); comp.updateController(ctrl.id, (c) => ({ ...c, keys: c.keys.filter((x) => x.id !== k.id) }), true); }}
                        />
                    ))}
                </>
            );
        } else {
            body = <TraceSvg ctrl={ctrl} seconds={width / pps} width={width} height={40} analysis={comp.analysis} />;
        }
        return (
            <div key={ctrl.id} className={styles.lane}>
                {laneHead(ctrl.id, ctrl.name, on, () => comp.select({ kind: 'controller', id: ctrl.id }), (
                    <>
                        <span className={styles.swatch} style={{ background: ctrl.color }} />
                        <span className={styles.olIcon} title={type.label}><Activity size={11} /></span>
                    </>
                ))}
                <div
                    className={`${styles.laneBody} ${ctrl.type === 'keys' ? styles.laneBodyKeys : ''} ${on ? styles.laneBodyOn : ''}`}
                    style={{ width }}
                    onPointerDown={(e) => {
                        if (ctrl.type === 'keys') keyLaneDown(e, ctrl);
                        else if (e.target === e.currentTarget) { comp.select({ kind: 'controller', id: ctrl.id }); scrub(e); }
                    }}
                >
                    {body}
                </div>
            </div>
        );
    };

    useLayoutEffect(() => {
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${HEAD_W + timeRef.current * pps}px)`;
    }, [pps]);

    return (
        <section className={styles.timeline} style={{ '--head-w': `${HEAD_W}px` }}>
            <div className={styles.tlBar}>
                <button type="button" className={styles.btn} title="Add video track" onClick={() => comp.addTrack('video')}><Plus size={12} /><Film size={12} /></button>
                <button type="button" className={styles.btn} title="Add audio track" onClick={() => comp.addTrack('audio')}><Plus size={12} /><Music size={12} /></button>
                <span className={styles.barSep} />
                <button
                    type="button"
                    className={styles.btn}
                    title="Cut the selected clip or Switch at the playhead (S)"
                    disabled={!(comp.selection?.kind === 'clip' || selectedSwitch)}
                    onClick={() => (selectedSwitch ? comp.cutSwitch(selectedSwitch.id) : comp.splitClip(comp.selection.id))}
                >
                    <Scissors size={12} /> {selectedSwitch ? 'Cut' : 'Split'}
                </button>
                <button type="button" className={`${styles.btn} ${snap ? styles.btnOn : ''}`} title="Snap to edges and the playhead" onClick={() => setSnap(!snap)}><Magnet size={12} /></button>
                <span className={styles.spacer} />
                <span className={styles.olTag}>ctrl + wheel to zoom</span>
                <button type="button" className={styles.btn} title="Zoom out" onClick={() => setPps(Math.max(4, pps / 1.5))}><ZoomOut size={12} /></button>
                <button type="button" className={styles.btn} title="Zoom in" onClick={() => setPps(Math.min(800, pps * 1.5))}><ZoomIn size={12} /></button>
            </div>
            <div ref={scrollRef} className={styles.lanes}>
                <div className={styles.lanesInner} style={{ width: width + HEAD_W }}>
                    <div className={styles.ruler}>
                        <div className={styles.rulerPad} />
                        <div className={styles.rulerTrack} style={{ width }} onPointerDown={scrub}>
                            {ticks.map((t) => <span key={t} className={styles.tick} style={{ left: t * pps }}>{fmtT(t)}</span>)}
                        </div>
                    </div>
                    {videoTracks.map(trackRow)}
                    {audioTracks.map(trackRow)}
                    {project.controllers.map(controllerRow)}
                    <div ref={playheadRef} className={styles.playhead} style={{ left: 0 }}>
                        <span className={styles.playheadKnob} />
                    </div>
                </div>
            </div>
        </section>
    );
}
