// Controllers: objects that put out a signal over the timeline, which any
// parameter can be linked to (model/maps.js shapes it on the way in).
//
// Every controller is a pure function of timeline time and the project's
// audio analysis, so the preview and an export read exactly the same value
// for the same frame, whatever order frames are drawn in.
//
//   kick     hits found in a band of the mix: an attack up to 1 on each hit,
//            then a release back down (lib/scanAssets/modulate's kick)
//   band     the level of a band of the mix, through an attack/release
//            follower and an input window
//   lfo      a periodic wave, free-running in Hz or locked to a tempo
//   keys     keyframes drawn in the controller's timeline lane
//   switch   named states, cut between in the timeline lane (by hand or by
//            the auto-cut tools); linking to one picks the state it is on in
//   logic    a switch worked out from others: On when its inputs (each a
//            switch or another logic in a chosen state, optionally NOT-ed)
//            combine to true under AND, OR or XOR. Anything that can follow
//            a switch can follow one.

import { kickEnvelope, kickHits, kickLevelAt } from '../../../lib/protagonist/kicks';
import { modulate, MOD_DEFAULTS } from '../../../lib/scanAssets/modulate';

export const CONTROLLER_COLORS = ['#ecebe6', '#e8553d', '#e8c547', '#6fd3ff', '#9b7bff', '#5fd39a', '#ff7bd0', '#ffb347'];

const num = (key, label, min, max, step, def, extra = {}) => ({ key, label, type: 'number', min, max, step, def, ...extra });

export const CONTROLLER_TYPES = {
    kick: {
        label: 'Kick',
        params: [
            num('low', 'Low (Hz)', 20, 400, 1, 40),
            num('high', 'High (Hz)', 40, 800, 1, 130),
            num('threshold', 'Threshold', 0, 1, 0.005, 0.85),
            num('gap', 'Min gap (s)', 0.03, 1, 0.01, 0.18),
            num('attack', 'Attack (s)', 0, 0.2, 0.001, 0.01),
            num('release', 'Release (s)', 0.02, 2, 0.01, 0.3),
            num('every', 'Every Nth', 1, 16, 1, 1),
        ],
    },
    band: {
        label: 'Band',
        params: [
            num('low', 'Low (Hz)', 20, 16000, 1, 30),
            num('high', 'High (Hz)', 40, 20000, 1, 150),
            num('attack', 'Attack (s)', 0, 1, 0.005, 0.03),
            num('release', 'Release (s)', 0, 2, 0.005, 0.25),
            num('floor', 'Floor', 0, 1, 0.01, 0.15),
            num('ceiling', 'Ceiling', 0, 1, 0.01, 0.9),
        ],
    },
    lfo: {
        label: 'LFO',
        params: [
            {
                key: 'shape', label: 'Shape', type: 'select', def: 'sine',
                options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['saw', 'Saw'], ['square', 'Square'], ['random', 'Random']],
            },
            {
                key: 'sync', label: 'Clock', type: 'select', def: 'hz',
                options: [['hz', 'Free (Hz)'], ['bpm', 'Tempo']],
            },
            num('rate', 'Rate (Hz)', 0.01, 20, 0.01, 0.5, { when: (p) => p.sync !== 'bpm' }),
            num('bpm', 'BPM', 30, 240, 0.1, 120, { when: (p) => p.sync === 'bpm' }),
            num('beats', 'Beats / cycle', 0.25, 32, 0.25, 1, { when: (p) => p.sync === 'bpm' }),
            num('phase', 'Phase', 0, 1, 0.01, 0),
            num('duty', 'Duty', 0.01, 0.99, 0.01, 0.5, { when: (p) => p.shape === 'square' }),
        ],
    },
    keys: {
        label: 'Keyframes',
        lane: true,
        params: [
            {
                key: 'interp', label: 'Between keys', type: 'select', def: 'linear',
                options: [['linear', 'Linear'], ['smooth', 'Smooth'], ['hold', 'Hold']],
            },
        ],
    },
    switch: {
        label: 'Switch',
        lane: true,
        params: [],
    },
    logic: {
        label: 'Logic',
        lane: true,
        params: [
            {
                key: 'op', label: 'Combine', type: 'select', def: 'and',
                options: [['and', 'AND (all are)'], ['or', 'OR (any is)'], ['xor', 'XOR (an odd number are)']],
            },
        ],
    },
};

/** Whether a controller has states to be on in: a Switch, or a Logic worked out from Switches. */
export const isSwitch = (c) => c?.type === 'switch' || c?.type === 'logic';

export const defaultsFor = (type) => Object.fromEntries(
    (CONTROLLER_TYPES[type]?.params || []).map((p) => [p.key, p.def]),
);

export function makeController(id, type, over = {}) {
    const base = {
        id,
        type,
        name: CONTROLLER_TYPES[type]?.label || type,
        color: CONTROLLER_COLORS[0],
        params: defaultsFor(type),
        keys: [],
        cuts: [],
        states: ['Off', 'On'],
    };
    if (type === 'keys') base.keys = [];
    if (type === 'switch') base.cuts = [{ id: `${id}_c0`, t: 0, s: 0 }];
    if (type === 'logic') base.inputs = [];
    return { ...base, ...over, params: { ...base.params, ...(over.params || {}) } };
}

/** The controllers a new project starts with: whatever drove the old tools. */
export function stockControllers(nextId) {
    return [
        makeController(nextId(), 'kick', { name: 'Kick', color: '#ecebe6' }),
        makeController(nextId(), 'band', { name: 'Lows', color: '#e8553d', params: { low: 30, high: 150 } }),
        makeController(nextId(), 'band', { name: 'Mids', color: '#e8c547', params: { low: 250, high: 2000 } }),
        makeController(nextId(), 'band', { name: 'Highs', color: '#6fd3ff', params: { low: 5000, high: 16000, release: 0.15 } }),
        makeController(nextId(), 'lfo', { name: 'Pulse', color: '#9b7bff', params: { sync: 'bpm', bpm: 120, beats: 1 } }),
    ];
}

// ---- Evaluation -------------------------------------------------------------

const smoothCache = new WeakMap(); // envelope -> Map(key -> Float32Array)

function smoothed(env, attack, release) {
    let byKey = smoothCache.get(env);
    if (!byKey) smoothCache.set(env, (byKey = new Map()));
    const key = `${attack.toFixed(4)}|${release.toFixed(4)}`;
    let s = byKey.get(key);
    if (s) return s;
    const L = env.level;
    s = new Float32Array(L.length);
    const ca = attack > 0 ? Math.exp(-1 / (attack * env.rate)) : 0;
    const cr = release > 0 ? Math.exp(-1 / (release * env.rate)) : 0;
    let y = 0;
    for (let k = 0; k < L.length; k++) {
        const x = L[k];
        const c = x > y ? ca : cr;
        y = c * y + (1 - c) * x;
        s[k] = y;
    }
    if (byKey.size >= 8) byKey.delete(byKey.keys().next().value);
    byKey.set(key, s);
    return s;
}

function sampleAt(arr, rate, t) {
    const x = t * rate;
    const k = Math.floor(x);
    if (k < 0 || !arr.length) return 0;
    if (k >= arr.length - 1) return arr[arr.length - 1];
    return arr[k] + (arr[k + 1] - arr[k]) * (x - k);
}

/** Hash noise for the random LFO: one value per cycle. */
const hash = (n) => {
    let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
};

function lfoAt(p, t) {
    const hz = p.sync === 'bpm' ? (p.bpm / 60) / Math.max(0.0625, p.beats) : p.rate;
    const x = t * hz + (p.phase || 0);
    const f = x - Math.floor(x);
    switch (p.shape) {
        case 'triangle': return f < 0.5 ? f * 2 : 2 - f * 2;
        case 'saw': return f;
        case 'square': return f < (p.duty ?? 0.5) ? 1 : 0;
        case 'random': return hash(Math.floor(x));
        default: return 0.5 - 0.5 * Math.cos(f * Math.PI * 2);
    }
}

/** Keys sorted by time; held before the first and after the last. */
export function keysAt(keys, t, interp = 'linear') {
    if (!keys || !keys.length) return 0;
    if (t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = keys[lo];
    const b = keys[hi];
    if (interp === 'hold') return a.v;
    let f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    if (interp === 'smooth') f = f * f * (3 - 2 * f);
    return a.v + (b.v - a.v) * f;
}

/**
 * Whether a Logic controller is on at `t`. `lookup(id)` finds the controllers
 * it reads; `seen` stops a loop of Logics reading each other (a Logic already
 * being worked out counts as off).
 */
export function logicAt(ctrl, t, lookup, seen = new Set()) {
    if (!lookup || seen.has(ctrl.id)) return false;
    seen.add(ctrl.id);
    let count = 0;
    let on = 0;
    (ctrl.inputs || []).forEach((inp) => {
        const c = lookup(inp.controller);
        if (!isSwitch(c)) return;
        // eslint-disable-next-line no-use-before-define
        let v = switchAt(c, t, lookup, seen) === (Number.isInteger(inp.state) ? inp.state : 1);
        if (inp.not) v = !v;
        count++;
        if (v) on++;
    });
    seen.delete(ctrl.id);
    if (!count) return false;
    const op = ctrl.params?.op || 'and';
    if (op === 'or') return on > 0;
    if (op === 'xor') return on % 2 === 1;
    return on === count;
}

/**
 * The state a switch is in at `t` (an index into its states). A Logic is in
 * state 1 (On) or 0 (Off), and needs `lookup(id)` to read its inputs.
 */
export function switchAt(ctrl, t, lookup = null, seen = undefined) {
    if (ctrl.type === 'logic') return logicAt(ctrl, t, lookup, seen) ? 1 : 0;
    const cuts = ctrl.cuts || [];
    let s = cuts.length ? cuts[0].s : 0;
    for (let i = 0; i < cuts.length; i++) {
        if (cuts[i].t <= t + 1e-6) s = cuts[i].s; else break;
    }
    return Math.max(0, Math.min((ctrl.states?.length || 1) - 1, s));
}

/**
 * A controller's signal at timeline time `t`, 0..1. `ctx.music` is the
 * project's mixed soundtrack (an AudioBuffer starting at timeline 0), or
 * null with no audio, in which case the audio controllers sit at 0.
 */
export function controllerValue(ctrl, t, ctx, lookup = null) {
    if (!ctrl) return 0;
    const p = ctrl.params || {};
    switch (ctrl.type) {
        case 'kick': {
            if (!ctx?.music) return 0;
            const m = modulate({
                ...MOD_DEFAULTS,
                source: 'kick',
                low: p.low,
                high: p.high,
                threshold: p.threshold,
                gap: p.gap,
                attack: p.attack,
                release: p.release,
                every: p.every,
            }, ctx.music, t);
            return Math.max(0, Math.min(1, m.value));
        }
        case 'band': {
            if (!ctx?.music) return 0;
            const env = kickEnvelope(ctx.music, p.low, p.high);
            const s = smoothed(env, p.attack || 0, p.release || 0);
            const v = sampleAt(s, env.rate, t);
            const span = Math.max(1e-3, (p.ceiling ?? 1) - (p.floor ?? 0));
            return Math.max(0, Math.min(1, (v - (p.floor ?? 0)) / span));
        }
        case 'lfo': return lfoAt(p, t);
        case 'keys': return Math.max(0, Math.min(1, keysAt(ctrl.keys, t, p.interp)));
        case 'switch': {
            const n = Math.max(1, (ctrl.states?.length || 1) - 1);
            return switchAt(ctrl, t) / n;
        }
        case 'logic': return logicAt(ctrl, t, lookup) ? 1 : 0;
        default: return 0;
    }
}

/**
 * A Logic's state as cuts, `[{ t, s }]` from 0: it can only change where one
 * of the switches it reads (however deep) cuts, so those are the only times
 * it needs working out at.
 */
export function logicCuts(ctrl, lookup) {
    const times = new Set([0]);
    const walk = (c, seen) => {
        if (!c || seen.has(c.id)) return;
        seen.add(c.id);
        if (c.type === 'switch') (c.cuts || []).forEach((k) => times.add(Math.max(0, k.t)));
        if (c.type === 'logic') (c.inputs || []).forEach((inp) => walk(lookup(inp.controller), seen));
    };
    walk(ctrl, new Set());
    const out = [];
    Array.from(times).sort((a, b) => a - b).forEach((t) => {
        const s = logicAt(ctrl, t, lookup) ? 1 : 0;
        if (!out.length || out[out.length - 1].s !== s) out.push({ id: `${ctrl.id}_${t}`, t, s });
    });
    return out;
}

/** Whether `ctrl` reads `id`, directly or through other Logics (so it cannot be one of id's inputs). */
export function dependsOn(ctrl, id, lookup, seen = new Set()) {
    if (!ctrl || seen.has(ctrl.id)) return false;
    if (ctrl.id === id) return true;
    seen.add(ctrl.id);
    return ctrl.type === 'logic' && (ctrl.inputs || []).some((inp) => dependsOn(lookup(inp.controller), id, lookup, seen));
}

/** Kick hits for the auto-cut tools and the lane display. */
export function kickTimes(ctrl, music) {
    if (!music || ctrl.type !== 'kick') return [];
    const p = ctrl.params;
    const env = kickEnvelope(music, p.low, p.high);
    const hits = kickHits(env, p.threshold, p.gap);
    const n = Math.max(1, Math.round(p.every || 1));
    return n > 1 ? hits.filter((_, i) => i % n === 0) : hits;
}

/** A level trace of an audio controller across [t0, t1], for its lane. */
export function controllerTrace(ctrl, t0, t1, samples, ctx) {
    const out = new Float32Array(samples);
    const span = Math.max(1e-6, t1 - t0);
    for (let i = 0; i < samples; i++) out[i] = controllerValue(ctrl, t0 + (span * i) / Math.max(1, samples - 1), ctx);
    return out;
}

export { kickLevelAt };
