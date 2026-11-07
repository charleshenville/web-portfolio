import React, { useCallback, useMemo, useRef, useState } from 'react';
import { CURVE_PRESETS, evalCurve } from '../lib/scanAssets/modulate';
import styles from './vfx.module.css';

// A curve from 0..1 to (about) 0..1, edited by dragging its points. Drag a
// point to move it; click empty space to add one; double-click a point to
// take it out. The two end points slide only up and down, so the curve
// always spans the whole input. `dotRef` gets a circle the caller can move
// to show where the input is right now.

const W = 240;
const H = 120;
const PAD = 8;
const Y_MIN = -0.25;
const Y_MAX = 1.25;

const toX = (x) => PAD + x * (W - PAD * 2);
const toY = (y) => H - PAD - ((y - Y_MIN) / (Y_MAX - Y_MIN)) * (H - PAD * 2);
const fromX = (px) => (px - PAD) / (W - PAD * 2);
const fromY = (py) => Y_MIN + ((H - PAD - py) / (H - PAD * 2)) * (Y_MAX - Y_MIN);
const round = (v) => Math.round(v * 1000) / 1000;

export default function CurveEditor({ points, onChange, dotRef, xLabel = 'in', yLabel = 'out' }) {
    const svgRef = useRef(null);
    const [drag, setDrag] = useState(null);
    const pts = useMemo(() => [...(points || [[0, 0], [1, 1]])].sort((a, b) => a[0] - b[0]), [points]);

    const path = useMemo(() => {
        let d = '';
        for (let i = 0; i <= 64; i++) {
            const x = i / 64;
            d += `${i ? 'L' : 'M'}${toX(x).toFixed(1)},${toY(evalCurve(pts, x)).toFixed(1)}`;
        }
        return d;
    }, [pts]);

    const local = useCallback((e) => {
        const r = svgRef.current.getBoundingClientRect();
        return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    }, []);

    const move = useCallback((e) => {
        if (drag == null) return;
        const [px, py] = local(e);
        const next = pts.map((p) => [...p]);
        const last = next.length - 1;
        let x = Math.max(0, Math.min(1, fromX(px)));
        if (drag === 0) x = 0;
        else if (drag === last) x = 1;
        else x = Math.max(next[drag - 1][0] + 0.005, Math.min(next[drag + 1][0] - 0.005, x));
        next[drag] = [round(x), round(Math.max(Y_MIN, Math.min(Y_MAX, fromY(py))))];
        onChange(next);
    }, [drag, local, pts, onChange]);

    const add = useCallback((e) => {
        if (e.target !== svgRef.current && !e.target.dataset.bg) return;
        const [px, py] = local(e);
        const x = Math.max(0.005, Math.min(0.995, fromX(px)));
        const next = [...pts.map((p) => [...p]), [round(x), round(Math.max(Y_MIN, Math.min(Y_MAX, fromY(py))))]]
            .sort((a, b) => a[0] - b[0]);
        onChange(next);
        setDrag(next.findIndex((p) => p[0] === round(x)));
        svgRef.current.setPointerCapture?.(e.pointerId);
    }, [local, pts, onChange]);

    return (
        <div style={{ marginBottom: 9 }}>
            <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${H}`}
                style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: drag != null ? 'grabbing' : 'crosshair', background: 'rgba(255,255,255,0.04)' }}
                onPointerDown={add}
                onPointerMove={move}
                onPointerUp={() => setDrag(null)}
                onPointerLeave={() => setDrag(null)}
            >
                <rect data-bg="1" x={0} y={0} width={W} height={H} fill="transparent" />
                {[0, 0.25, 0.5, 0.75, 1].map((g) => (
                    <g key={g} pointerEvents="none">
                        <line x1={toX(g)} x2={toX(g)} y1={toY(Y_MIN)} y2={toY(Y_MAX)} stroke="currentColor" strokeOpacity={0.08} />
                        <line x1={toX(0)} x2={toX(1)} y1={toY(g)} y2={toY(g)} stroke="currentColor" strokeOpacity={g === 0 || g === 1 ? 0.22 : 0.08} />
                    </g>
                ))}
                <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.6} pointerEvents="none" />
                {pts.map((p, i) => (
                    <circle
                        // eslint-disable-next-line react/no-array-index-key
                        key={i}
                        cx={toX(p[0])}
                        cy={toY(p[1])}
                        r={drag === i ? 5.5 : 4.5}
                        fill={drag === i ? 'var(--accent)' : 'var(--fg)'}
                        stroke="rgba(0,0,0,0.5)"
                        style={{ cursor: 'grab' }}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            setDrag(i);
                            svgRef.current.setPointerCapture?.(e.pointerId);
                        }}
                        onDoubleClick={(e) => {
                            e.stopPropagation();
                            if (i === 0 || i === pts.length - 1) return;
                            onChange(pts.filter((_, k) => k !== i));
                        }}
                    />
                ))}
                <circle ref={dotRef} cx={toX(0)} cy={toY(0)} r={3.5} fill="var(--accent)" opacity={0} pointerEvents="none" />
                <text x={W - PAD} y={H - 2} fontSize={8} textAnchor="end" fill="currentColor" opacity={0.4} pointerEvents="none">{xLabel}</text>
                <text x={PAD + 2} y={PAD + 6} fontSize={8} fill="currentColor" opacity={0.4} pointerEvents="none">{yLabel}</text>
            </svg>
            <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 5 }}>
                {CURVE_PRESETS.slice(0, 8).map((p) => (
                    <button key={p.id} type="button" className={styles.vfx_segBtn} onClick={() => onChange(p.points.map((q) => [...q]))}>
                        {p.name}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Put a CurveEditor's live dot at input `x` on `points`. */
export function placeCurveDot(el, points, x, visible = true) {
    if (!el) return;
    const xx = Math.max(0, Math.min(1, x));
    el.setAttribute('cx', toX(xx));
    el.setAttribute('cy', toY(Math.max(Y_MIN, Math.min(Y_MAX, evalCurve(points, xx)))));
    el.setAttribute('opacity', visible ? 1 : 0);
}
