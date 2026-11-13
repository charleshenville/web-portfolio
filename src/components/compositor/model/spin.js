// A spline's spin: an angular velocity about the scene's X, Y and Z axes
// (degrees a second, spinX/Y/Z), turned into how far it has turned by a
// time, as a quaternion [x, y, z, w] in the scene's frame.
//
// Unlinked, the rates are constant and the turn is exact: about the axis ω
// by |ω|·t. Linked to controllers, the rates change over time, so the turn
// is their integral, dq/dt = ½ ω q, stepped from 0 s at STEP intervals with
// the rate at each step's middle. The steps are kept per object, so a frame
// turns the same whether it was played to, scrubbed to or exported, and
// each stretch of the timeline is only worked out once. Controllers are
// pure functions of time, which is what makes that safe; the table starts
// again when the rates, their links, the controllers or the music change.

import { paramDefs } from './schema';
import { linkValue, makeFrame } from './resolve';

export const SPIN_KEYS = ['spinX', 'spinY', 'spinZ'];
const STEP = 1 / 120;
const D2R = Math.PI / 180;

const tables = new Map(); // object id -> { sig, controllers, analysis, q, n }

/** The turn by angular velocity w (rad/s) over dt, into out[o..o+3]. */
function turn(w, dt, out, o = 0) {
    const rate = Math.hypot(w[0], w[1], w[2]);
    const half = (rate * dt) / 2;
    const s = rate > 1e-12 ? Math.sin(half) / rate : 0;
    out[o] = w[0] * s;
    out[o + 1] = w[1] * s;
    out[o + 2] = w[2] * s;
    out[o + 3] = rate > 1e-12 ? Math.cos(half) : 1;
    return out;
}

/** a·b (a applied after b), into out[o..o+3]. */
function mul(a, ao, b, bo, out, o) {
    const ax = a[ao]; const ay = a[ao + 1]; const az = a[ao + 2]; const aw = a[ao + 3];
    const bx = b[bo]; const by = b[bo + 1]; const bz = b[bo + 2]; const bw = b[bo + 3];
    out[o] = aw * bx + ax * bw + ay * bz - az * by;
    out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
    out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
    out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
    const n = Math.hypot(out[o], out[o + 1], out[o + 2], out[o + 3]) || 1;
    for (let i = 0; i < 4; i++) out[o + i] /= n;
}

/** Whether `obj` spins at all: a rate, or a rate linked to a controller. */
export function spins(obj) {
    const p = obj?.params || {};
    return SPIN_KEYS.some((k) => (p[k] || 0) !== 0 || !!obj.links?.[k]);
}

/** The rates (rad/s) at time t, links applied. */
function rateAt(obj, defs, t, project, analysis) {
    const frame = makeFrame(project, t, analysis);
    return SPIN_KEYS.map((k) => {
        let v = obj.params?.[k] || 0;
        const link = obj.links?.[k];
        const def = defs.get(k);
        if (link && def && def.link !== false) {
            const x = linkValue(def, link, frame);
            if (Number.isFinite(x)) v = x;
        }
        return v * D2R;
    });
}

/**
 * How far `obj` has turned by timeline time `time`, as a quaternion
 * [x, y, z, w], or null when it doesn't spin. `project` and `analysis`
 * are what its links read (model/resolve's makeFrame).
 */
export function spinAt(obj, time, project, analysis) {
    if (!spins(obj)) return null;
    const p = obj.params || {};
    const t = Math.max(0, time || 0);
    const linked = SPIN_KEYS.some((k) => !!obj.links?.[k]);
    if (!linked) return turn(SPIN_KEYS.map((k) => (p[k] || 0) * D2R), t, [0, 0, 0, 1]);

    const sig = JSON.stringify([SPIN_KEYS.map((k) => p[k] || 0), SPIN_KEYS.map((k) => obj.links?.[k] || null)]);
    let e = tables.get(obj.id);
    if (!e || e.sig !== sig || e.controllers !== project.controllers || e.analysis !== analysis) {
        const q = new Float64Array(4 * 1024);
        q[3] = 1;
        e = {
            sig, controllers: project.controllers, analysis, q, n: 1,
        };
        tables.set(obj.id, e);
        if (tables.size > 64) tables.delete(tables.keys().next().value);
    }
    const defs = paramDefs(obj.type);
    const k = Math.floor(t / STEP);
    // Step on to k, keeping each step.
    if (e.n <= k) {
        if (e.q.length < 4 * (k + 1)) {
            const grown = new Float64Array(Math.max(4 * (k + 1), e.q.length * 2));
            grown.set(e.q);
            e.q = grown;
        }
        const d = [0, 0, 0, 1];
        for (let i = e.n - 1; i < k; i++) {
            turn(rateAt(obj, defs, (i + 0.5) * STEP, project, analysis), STEP, d);
            mul(d, 0, e.q, i * 4, e.q, (i + 1) * 4);
        }
        e.n = k + 1;
    }
    // And the part of the step to t, at that step's rate (so it meets the next step exactly).
    const d = turn(rateAt(obj, defs, (k + 0.5) * STEP, project, analysis), t - k * STEP, [0, 0, 0, 1]);
    const out = [0, 0, 0, 1];
    mul(d, 0, e.q, k * 4, out, 0);
    return out;
}
