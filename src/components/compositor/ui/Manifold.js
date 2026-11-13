// A Manifold's sound panel: which sound it reads (the project's music, or a
// file in the project's media), and its keypoints worked out from it, as
// you ask or whenever its settings change. The keypoints are kept in the
// project (params.points, with params.gen saying what they came from), so
// it draws, saves and exports without the sound being analysed again.

import React, { useEffect, useRef, useState } from 'react';
import { Upload, RefreshCw } from 'lucide-react';
import { analyseSound, manifoldKeypoints, manifoldSettings, manifoldKey } from '../model/acoustics';
import { scopeOf, splineSymbol } from '../model/globals';
import { SPLINE_LETTERS } from '../model/expr';
import { useComp } from './context';
import styles from '../compositor.module.css';

const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/** The sound `source` names, decoded (or null while it isn't, or there is none). */
function soundOf(comp, source) {
    if (!source || source === 'music') {
        return { buffer: comp.analysis?.music || null, label: 'the project’s music', mediaId: null };
    }
    const id = source.replace(/^media:/, '');
    const m = comp.project.media.find((x) => x.id === id);
    return { buffer: comp.audioBuffers.get(id) || null, label: m?.name || 'a file no longer in the project', mediaId: id, missing: !m };
}

/** Where a media file's 0 s falls on the timeline: its first clip's, or 0. */
function offsetOf(project, mediaId) {
    const c = mediaId && project.clips.filter((x) => x.mediaId === mediaId).sort((a, b) => a.start - b.start)[0];
    return c ? Math.round((c.start - (c.in || 0) / (c.rate || 1)) * 1000) / 1000 : 0;
}

export default function ManifoldEditor({ obj }) {
    const comp = useComp();
    const p = obj.params;
    const fileRef = useRef(null);
    const [busy, setBusy] = useState(null); // 0..1 while analysing
    const [error, setError] = useState(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const sound = soundOf(comp, p.source);
    const key = sound.buffer ? manifoldKey(p, sound.buffer.duration) : null;
    const stale = !!p.gen && !!key && p.gen.key !== key;
    const audioMedia = comp.project.media.filter((m) => m.kind === 'audio');

    // What a generation started with; the newest asked for wins.
    const run = useRef(0);
    const generate = async () => {
        const snd = soundOf(comp, p.source);
        if (!snd.buffer) return;
        const n = ++run.current;
        const settings = manifoldSettings(p);
        const genKey = manifoldKey(p, snd.buffer.duration);
        setError(null);
        setBusy(0);
        try {
            const A = await analyseSound(snd.buffer, (x) => { if (alive.current) setBusy(x); });
            if (n !== run.current) return;
            const res = manifoldKeypoints(A, settings);
            // A file's keypoints keep time with where it sits on the timeline, when it changes to it.
            const newSource = (p.gen?.sourceId ?? null) !== (p.source || 'music');
            comp.updateObject(obj.id, (o) => ({
                ...o,
                params: {
                    ...o.params,
                    points: res.points,
                    gen: {
                        key: genKey,
                        sourceId: p.source || 'music',
                        source: snd.label,
                        from: res.from,
                        to: res.to,
                        count: res.points.length,
                        duration: A.duration,
                    },
                    ...(newSource ? { timeOffset: offsetOf(comp.project, snd.mediaId) } : {}),
                },
            }), true);
        } catch (e) {
            if (alive.current) setError(e.message || String(e));
        }
        if (alive.current && n === run.current) setBusy(null);
    };
    const generateRef = useRef(generate);
    generateRef.current = generate;

    // Kept in step: once it has keypoints, new settings make new ones (a moment after the last change).
    useEffect(() => {
        if (!p.autoGen || !p.gen || !key || p.gen.key === key) return undefined;
        const t = setTimeout(() => generateRef.current(), 250);
        return () => clearTimeout(t);
    }, [p.autoGen, p.gen, key]);

    const pickFile = async (file) => {
        if (!file) return;
        const id = await comp.importAudio(file);
        comp.setParam(obj.id, 'source', `media:${id}`, true);
    };

    const scope = scopeOf(comp.project);
    const sym = splineSymbol(obj);
    const taken = new Set([
        ...scope.splineList.filter((o) => o.id !== obj.id).map(splineSymbol),
        ...scope.varList.map((v) => v.symbol),
    ]);

    let status = null;
    if (sound.missing) status = <p className={`${styles.hint} ${styles.warn}`}>File missing. Pick another sound.</p>;
    else if (!sound.buffer && !sound.mediaId) {
        status = <p className={`${styles.hint} ${styles.warn}`}>No music yet. Add some or load a file.</p>;
    } else if (!sound.buffer) status = <p className={styles.hint}>{`Reading ${sound.label}…`}</p>;

    return (
        <>
            <div className={styles.row}>
                <span className={styles.rowLabel}>Sound</span>
                <select
                    className={styles.select}
                    style={{ gridColumn: '2 / 3', minWidth: 0 }}
                    value={p.source || 'music'}
                    onChange={(e) => comp.setParam(obj.id, 'source', e.target.value, true)}
                >
                    <option value="music">The project&apos;s music (its audio tracks)</option>
                    {audioMedia.map((m) => <option key={m.id} value={`media:${m.id}`}>{m.name}</option>)}
                    {sound.missing && <option value={p.source}>(missing file)</option>}
                </select>
                <button type="button" className={styles.btn} style={{ gridColumn: '3 / 4' }} title="Load a sound file into the project (not onto the timeline)" onClick={() => fileRef.current?.click()}>
                    <Upload size={11} />
                    {' '}
                    File
                </button>
                <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" style={{ display: 'none' }} onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            {status}
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} disabled={!sound.buffer || busy !== null} onClick={generate}>
                    <RefreshCw size={11} />
                    {' '}
                    {p.gen ? 'Generate again' : 'Generate keypoints'}
                </button>
            </div>
            {busy !== null && (
                <>
                    <p className={styles.hint} style={{ margin: '2px 0' }}>{`Listening to ${sound.label}… ${Math.round(busy * 100)}%`}</p>
                    <div className={styles.progress} style={{ height: 4 }}>
                        <div className={styles.progressBar} style={{ width: `${Math.round(busy * 100)}%` }} />
                    </div>
                </>
            )}
            {error && <p className={`${styles.hint} ${styles.warn}`}>{error}</p>}
            {!p.gen && busy === null && sound.buffer && (
                <p className={styles.hint}>No keypoints yet.</p>
            )}
            {p.gen && (
                <p className={styles.hint} style={{ margin: '4px 0' }}>
                    {`${p.gen.count} keypoints, ${fmt(p.gen.from)} to ${fmt(p.gen.to)}.`}
                </p>
            )}
            {stale && !p.autoGen && <p className={`${styles.hint} ${styles.warn}`}>Out of date. Generate again.</p>}
            <div className={styles.row}>
                <span className={styles.rowLabel}>Symbol</span>
                <select
                    className={styles.select}
                    style={{ gridColumn: '2 / 4' }}
                    value={sym}
                    onChange={(e) => comp.setParam(obj.id, 'symbol', e.target.value, true)}
                >
                    {SPLINE_LETTERS.map(([c, nm]) => (
                        <option key={c} value={c} disabled={taken.has(c)}>{`${c}  ${nm}${taken.has(c) ? ' (taken)' : ''}`}</option>
                    ))}
                </select>
            </div>
            {scope.dupes.has(obj.id) && <p className={`${styles.hint} ${styles.warn}`}>{`${sym} is taken. Pick another symbol.`}</p>}
        </>
    );
}
