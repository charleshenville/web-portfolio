import React, { useRef, useState } from 'react';
import { exportProject } from '../engine/exporter';
import { projectDuration } from '../model/timeline';
import { NumberBox } from './Params';
import styles from '../compositor.module.css';

const SCALES = [0.5, 1, 1.5, 2];
const QUALITY = [[0.18, 'Draft'], [0.4, 'High'], [0.85, 'Max']];

export default function ExportDialog({
    engine, transport, project, onClose, onPause,
}) {
    const duration = projectDuration(project);
    const [scale, setScale] = useState(1);
    const [quality, setQuality] = useState(0.4);
    const [fps, setFps] = useState(project.output.fps || 30);
    const [t0, setT0] = useState(0);
    const [t1, setT1] = useState(duration);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const [label, setLabel] = useState('');
    const [error, setError] = useState('');
    const cancel = useRef(false);

    const w = Math.round((project.output.width * scale) / 2) * 2;
    const h = Math.round((project.output.height * scale) / 2) * 2;

    const run = async () => {
        transport.pause();
        onPause();
        setBusy(true);
        setError('');
        cancel.current = false;
        try {
            const out = await exportProject({
                engine,
                project,
                opts: { scale, quality, fps, t0, t1 },
                onProgress: (f, l) => { setProgress(f); setLabel(l); },
                cancelled: () => cancel.current,
            });
            if (out?.blob) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(out.blob);
                a.download = `${(project.name || 'compositor').replace(/[^a-zA-Z0-9 _.-]+/g, '-')}.mp4`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            }
            if (out) onClose();
        } catch (e) {
            setError(e.message || String(e));
        }
        setBusy(false);
    };

    return (
        <div className={styles.modal} onClick={() => { if (!busy) onClose(); }}>
            <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
                <h2 className={styles.dialogTitle}>Export MP4</h2>
                <div className={styles.row}>
                    <span className={styles.rowLabel}>Size</span>
                    <select className={styles.select} value={scale} disabled={busy} onChange={(e) => setScale(Number(e.target.value))}>
                        {SCALES.map((s) => <option key={s} value={s}>{`${s}× · ${Math.round((project.output.width * s) / 2) * 2}×${Math.round((project.output.height * s) / 2) * 2}`}</option>)}
                    </select>
                </div>
                <div className={styles.row}>
                    <span className={styles.rowLabel}>Quality</span>
                    <select className={styles.select} value={quality} disabled={busy} onChange={(e) => setQuality(Number(e.target.value))}>
                        {QUALITY.map(([q, l]) => <option key={q} value={q}>{l}</option>)}
                    </select>
                </div>
                <div className={styles.row}>
                    <span className={styles.rowLabel}>Frame rate</span>
                    <span style={{ gridColumn: '2 / 4' }}><NumberBox value={fps} step={0.001} onCommit={(v) => setFps(Math.max(1, v))} /></span>
                </div>
                <div className={styles.row}>
                    <span className={styles.rowLabel}>From (s)</span>
                    <span style={{ gridColumn: '2 / 4' }}><NumberBox value={t0} step={0.01} onCommit={(v) => setT0(Math.max(0, v))} /></span>
                </div>
                <div className={styles.row}>
                    <span className={styles.rowLabel}>To (s)</span>
                    <span style={{ gridColumn: '2 / 4' }}><NumberBox value={t1} step={0.01} onCommit={(v) => setT1(Math.max(t0 + 0.05, v))} /></span>
                </div>
                <p className={styles.hint}>{`${w}×${h}, ${(t1 - t0).toFixed(2)}s, ${Math.round((t1 - t0) * fps)} frames.`}</p>
                {busy && (
                    <>
                        <div className={styles.progress}><div className={styles.progressBar} style={{ width: `${progress * 100}%` }} /></div>
                        <p className={styles.hint}>{label}</p>
                    </>
                )}
                {error && <p className={`${styles.hint} ${styles.warn}`}>{error}</p>}
                <div className={styles.wideRow}>
                    {!busy && <button type="button" className={`${styles.btn} ${styles.btnOn}`} onClick={run}>Export</button>}
                    {busy && <button type="button" className={styles.btn} onClick={() => { cancel.current = true; }}>Cancel</button>}
                    {!busy && <button type="button" className={styles.btn} onClick={onClose}>Close</button>}
                </div>
            </div>
        </div>
    );
}
