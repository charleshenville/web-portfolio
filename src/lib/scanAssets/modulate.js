// Audio modulation for placed assets and windows: a slice of the track drives
// a value through a curve you draw.
//
// Two sources, both read off the decoded track (lib/protagonist/kicks) rather
// than the live analyser, so the preview and an export move on exactly the
// same frames:
//   'band' - the level of a frequency band (Hz), optionally smoothed over the
//            last few hundred ms. The curve maps that level (0..1) to the
//            output, so it is a transfer function: a gate, a soft knee, an
//            exaggerated peak.
//   'kick' - hits found in a band (a threshold crossed on the way up). Each
//            hit is an envelope: an attack up to 1, then a release back down
//            whose shape is the curve, read from 1 (the hit) to 0 (fully
//            released). So the curve is the motion of the thing after a kick.
// Either way the result is 0..1, scaled by whatever uses it.

import { kickEnvelope, kickHits, kickLevelAt } from '../protagonist/kicks';

export const MOD_DEFAULTS = {
    source: 'off', // 'off' | 'band' | 'kick'
    low: 40, // Hz
    high: 130,
    threshold: 0.85, // kick
    gap: 0.18, // kick: shortest time between hits (s)
    attack: 0.03, // kick (s)
    release: 0.35, // kick (s)
    every: 1, // kick: react to every Nth hit
    smooth: 0.05, // band: averaging window (s)
    curve: [[0, 0], [1, 1]],
    invert: false,
};

/** Curve shapes to start from. Each is a list of [x, y] points over 0..1. */
export const CURVE_PRESETS = [
    { id: 'linear', name: 'Linear', points: [[0, 0], [1, 1]] },
    { id: 'easeIn', name: 'Ease in', points: [[0, 0], [0.5, 0.18], [1, 1]] },
    { id: 'easeOut', name: 'Ease out', points: [[0, 0], [0.5, 0.82], [1, 1]] },
    { id: 'smooth', name: 'S-curve', points: [[0, 0], [0.3, 0.08], [0.7, 0.92], [1, 1]] },
    { id: 'punch', name: 'Punch', points: [[0, 0], [0.55, 0.1], [0.85, 0.6], [1, 1]] },
    { id: 'gate', name: 'Gate', points: [[0, 0], [0.48, 0], [0.52, 1], [1, 1]] },
    { id: 'bounce', name: 'Overshoot', points: [[0, 0], [0.35, -0.12], [0.7, 0.45], [1, 1]] },
];

const sortPts = (pts) => [...pts].sort((a, b) => a[0] - b[0]);

/**
 * A monotone-where-the-points-are cubic through the curve's points
 * (Fritsch-Carlson tangents), so it never rings between two points you put
 * down - except that y may leave 0..1 if you put a point there.
 */
export function evalCurve(points, x) {
    const p = sortPts(points && points.length >= 2 ? points : MOD_DEFAULTS.curve);
    if (x <= p[0][0]) return p[0][1];
    const n = p.length;
    if (x >= p[n - 1][0]) return p[n - 1][1];
    const d = [];
    const m = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = Math.max(1e-6, p[i + 1][0] - p[i][0]);
        d.push((p[i + 1][1] - p[i][1]) / dx);
    }
    m.push(d[0]);
    for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
    m.push(d[n - 2]);
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
            const t = 3 / Math.sqrt(s);
            m[i] = t * a * d[i];
            m[i + 1] = t * b * d[i];
        }
    }
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = Math.max(1e-6, p[i + 1][0] - p[i][0]);
    const t = (x - p[i][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i]
        + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
}

/** The band's level at `time`, averaged over the `smooth` seconds before it. */
function bandAt(env, time, smooth) {
    if (smooth <= 1e-3) return kickLevelAt(env, time);
    const k1 = Math.floor(time * env.rate);
    const k0 = Math.max(0, k1 - Math.max(1, Math.round(smooth * env.rate)));
    let s = 0;
    let n = 0;
    for (let k = k0; k <= k1; k++) {
        if (k >= 0 && k < env.level.length) { s += env.level[k]; n++; }
    }
    return n ? s / n : 0;
}

const ease = (u) => u * u * (3 - 2 * u);

/**
 * Where a modulator is at `time` seconds into `music` (an AudioBuffer).
 * Returns `{ input, value, flash, x }`: the raw level (for a meter), the
 * output after the curve (nominally 0..1), how recent the last hit was
 * (kick), and where on the curve's input axis that came from.
 */
export function modulate(mod, music, time) {
    const m = { ...MOD_DEFAULTS, ...(mod || {}) };
    if (m.source === 'off' || !music || time == null || !Number.isFinite(time)) {
        return { input: 0, value: 0, flash: 0, x: 0 };
    }
    const env = kickEnvelope(music, m.low, m.high);
    let input = 0;
    let value = 0;
    let flash = 0;
    // Where on the curve's input axis this is, for the editor's live dot.
    let x = 0;
    if (m.source === 'band') {
        input = bandAt(env, time, m.smooth);
        x = input;
        value = evalCurve(m.curve, input);
    } else {
        input = kickLevelAt(env, time);
        const H = kickHits(env, m.threshold, m.gap);
        if (H.length && H[0] <= time) {
            let lo = 0;
            let hi = H.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (H[mid] <= time) lo = mid;
                else hi = mid - 1;
            }
            flash = Math.max(0, 1 - (time - H[lo]) * 5);
            const N = Math.max(1, Math.round(m.every));
            const j = lo - (lo % N);
            const since = time - H[j];
            const attack = Math.max(0.001, m.attack);
            const release = Math.max(0.02, m.release);
            if (since < attack) {
                x = 1;
                value = ease(since / attack) * evalCurve(m.curve, 1);
            } else {
                const u = Math.min(1, (since - attack) / release);
                x = 1 - u;
                value = evalCurve(m.curve, x);
            }
        }
    }
    if (m.invert) value = 1 - value;
    return { input, value, flash, x };
}
