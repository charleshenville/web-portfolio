// Text laid over the frame (2D), edited where it shows: a box over the
// engine's stage (the element the canvas fills, so it is the output frame
// exactly), in the text's frame coordinates.
//
//   drag the box          move it
//   drag a handle         size it from the opposite side (alt: about its
//                         middle, shift: keeping its shape)
//   drag the knob above   turn it (shift: in 15° steps)

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useComp } from './context';
import styles from '../compositor.module.css';

const D2R = Math.PI / 180;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

// Handles: [x side, y side] of the box, -1 left / top, 1 right / bottom, 0 the middle.
const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];

export default function FrameTextOverlay({ obj, mount }) {
    const comp = useComp();
    const [size, setSize] = useState({ w: 0, h: 0 });
    const drag = useRef(null);

    useEffect(() => {
        if (!mount) return undefined;
        const read = () => setSize({ w: mount.clientWidth, h: mount.clientHeight });
        read();
        const ro = new ResizeObserver(read);
        ro.observe(mount);
        return () => ro.disconnect();
    }, [mount]);

    if (!mount || !size.w || !size.h) return null;
    const p = obj.params;
    const { w: W, h: H } = size;
    const box = {
        cx: (p.frameX ?? 0.5) * W,
        cy: (p.frameY ?? 0.85) * H,
        bw: (p.frameW ?? 0.5) * W,
        bh: (p.frameH ?? 0.12) * H,
        rot: p.frameRot || 0,
    };

    const write = (b) => comp.updateObject(obj.id, (o) => ({
        ...o,
        params: {
            ...o.params,
            frameX: r5(b.cx / W),
            frameY: r5(b.cy / H),
            frameW: r5(Math.max(4, b.bw) / W),
            frameH: r5(Math.max(4, b.bh) / H),
            frameRot: Math.round(b.rot * 100) / 100,
        },
    }), false, `frameText:${obj.id}`);

    const start = (kind, e, side = null) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Out of any field, so ⌘C / ⌘V after this copy the text object.
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
        const rect = mount.getBoundingClientRect();
        drag.current = {
            kind, side, from: { ...box }, x: e.clientX, y: e.clientY, rect,
        };
        const move = (ev) => {
            const d = drag.current;
            if (!d) return;
            const dx = ev.clientX - d.x;
            const dy = ev.clientY - d.y;
            const f = d.from;
            if (d.kind === 'move') {
                write({ ...f, cx: f.cx + dx, cy: f.cy + dy });
            } else if (d.kind === 'turn') {
                const ax = ev.clientX - (d.rect.left + f.cx);
                const ay = ev.clientY - (d.rect.top + f.cy);
                let rot = Math.atan2(ay, ax) / D2R + 90;
                if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
                rot = ((rot + 540) % 360) - 180;
                write({ ...f, rot });
            } else {
                // The pointer's move in the box's own (turned) frame.
                const c = Math.cos(f.rot * D2R);
                const s = Math.sin(f.rot * D2R);
                const lx = dx * c + dy * s;
                const ly = -dx * s + dy * c;
                const [sx, sy] = d.side;
                const both = ev.altKey ? 2 : 1;
                let bw = sx ? Math.max(4, f.bw + sx * lx * both) : f.bw;
                let bh = sy ? Math.max(4, f.bh + sy * ly * both) : f.bh;
                if (ev.shiftKey && sx && sy) {
                    // Its shape kept: the larger stretch wins.
                    const k = Math.max(bw / f.bw, bh / f.bh);
                    bw = f.bw * k;
                    bh = f.bh * k;
                }
                let { cx, cy } = f;
                if (!ev.altKey) {
                    // The opposite side stays put.
                    const ox = sx * (bw - f.bw) / 2;
                    const oy = sy * (bh - f.bh) / 2;
                    cx += ox * c - oy * s;
                    cy += ox * s + oy * c;
                }
                write({
                    ...f, cx, cy, bw, bh,
                });
            }
        };
        const up = () => {
            drag.current = null;
            comp.commit();
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // Which way a handle's arrows point, turned with the box.
    const cursorFor = ([sx, sy]) => {
        const ang = ((((Math.atan2(sy, sx) / D2R) + box.rot) % 180) + 180) % 180;
        return CURSORS[Math.round(ang / 45) % 4];
    };

    return createPortal(
        <div className={styles.ftLayer}>
            <div
                className={styles.ftBox}
                style={{
                    left: box.cx - box.bw / 2,
                    top: box.cy - box.bh / 2,
                    width: box.bw,
                    height: box.bh,
                    transform: `rotate(${box.rot}deg)`,
                }}
                title={`${obj.name}: drag to move`}
                onPointerDown={(e) => start('move', e)}
            >
                {HANDLES.map((side) => (
                    <span
                        key={side.join()}
                        className={styles.ftHandle}
                        style={{ left: `${(side[0] + 1) * 50}%`, top: `${(side[1] + 1) * 50}%`, cursor: cursorFor(side) }}
                        onPointerDown={(e) => start('size', e, side)}
                    />
                ))}
                <span className={styles.ftStem} />
                <span className={styles.ftKnob} title="Turn (shift: 15° steps)" onPointerDown={(e) => start('turn', e)} />
            </div>
        </div>,
        mount,
    );
}
