// Filling a Switch from the soundtrack, as the track editor's auto-cutter
// did: a cut on every Nth kick, or on a tempo grid, stepping through the
// switch's states in order or shuffled (from a fixed seed, so the list does
// not change under you as you edit other things).

import { kickTimes } from './controllers';

function seeded(seed = 0x2545f491) {
    let s = seed;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Give each cut time a state: in turn, or shuffled without repeating the last. */
export function assignStates(times, states, order, seed) {
    const n = states.length;
    if (!n) return [];
    const rand = seeded(seed);
    let prev = -1;
    return times.map((t, k) => {
        let s = k % n;
        if (order === 'shuffle' && n > 1) {
            s = Math.floor(rand() * (n - 1));
            if (s >= prev && prev >= 0) s += 1;
            if (prev < 0) s = Math.floor(rand() * n);
        }
        prev = s;
        return { t, s: states[s] };
    });
}

/** Cut times on every `every`th kick of `kick` (a kick controller) within [t0, t1). */
export function kickCutTimes(kick, music, { every = 1, t0 = 0, t1 = Infinity, gap = 0 }) {
    const hits = kickTimes(kick, music).filter((t) => t >= t0 && t < t1);
    const out = [];
    let last = -Infinity;
    hits.forEach((t, i) => {
        if (i % Math.max(1, every)) return;
        if (t - last < gap) return;
        out.push(t);
        last = t;
    });
    return out;
}

/** Cut times on a tempo grid. */
export function gridCutTimes({ bpm, offset = 0, beats = 1, t0 = 0, t1 }) {
    const step = (60 / Math.max(1, bpm)) * Math.max(0.0625, beats);
    const out = [];
    const first = offset + Math.ceil((t0 - offset) / step - 1e-9) * step;
    for (let t = first; t < t1 && out.length < 20000; t += step) out.push(Math.round(t * 1e4) / 1e4);
    return out;
}

/**
 * Replace a switch's cuts inside [t0, t1) with `cuts` ({ t, s }), keeping
 * those outside, and holding whatever state was on at t1 after the range.
 */
export function mergeCuts(ctrl, cuts, t0, t1, idFor) {
    const before = (ctrl.cuts || []).filter((c) => c.t < t0);
    const after = (ctrl.cuts || []).filter((c) => c.t >= t1);
    const all = [...before, ...cuts.map((c) => ({ id: idFor(), t: c.t, s: c.s })), ...after]
        .sort((a, b) => a.t - b.t);
    if (!all.length || all[0].t > 0) all.unshift({ id: idFor(), t: 0, s: 0 });
    // Drop cuts that do not change anything.
    const out = [];
    all.forEach((c) => { if (!out.length || c.s !== out[out.length - 1].s) out.push(c); });
    return out;
}
