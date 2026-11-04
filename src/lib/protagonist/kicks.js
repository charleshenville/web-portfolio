// Kicks, found once from the decoded track rather than from a live
// spectrum.
//
// The nod used to listen to whatever spectrum the frame had: the analyser's
// in the preview (sampled at the display rate) and an offline rebuild of it
// in the export (sampled at the take's rate, with the same per-frame
// smoothing - so twice as smeared at 30 fps as at 60). The two disagreed
// about where the gaps between kicks were, and the render skipped nods the
// preview made. Here the track is band-passed and its level measured every
// few milliseconds, independent of any frame rate, and the hits are picked
// off that once. Preview and export then both just ask "where is the music
// now?", so they nod on exactly the same kicks.

const HOP = 256; // samples between level readings (~5.8 ms at 44.1 kHz)
const WINDOW = 4; // hops averaged into one reading (~23 ms)
const RANGE_DB = 30; // the level scale spans this far below the track's loudest kicks

const monos = new WeakMap(); // AudioBuffer -> Float32Array
const envelopes = new WeakMap(); // AudioBuffer -> Map(band key -> envelope)

function monoOf(buffer) {
    let m = monos.get(buffer);
    if (m) return m;
    m = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < m.length; i++) m[i] += d[i];
    }
    if (buffer.numberOfChannels > 1) for (let i = 0; i < m.length; i++) m[i] /= buffer.numberOfChannels;
    monos.set(buffer, m);
    return m;
}

/** RBJ biquad coefficients, Butterworth Q. */
function biquad(type, f, rate) {
    const w = (2 * Math.PI * Math.max(1, Math.min(f, rate * 0.49))) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b = type === 'low'
        ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
        : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function filterInPlace(x, c) {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const v = x[i];
        const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = y;
        x[i] = y;
    }
}

/**
 * The level of `buffer` between `low` and `high` Hz, `rate` readings a
 * second, as 0..1: 1 at the track's loudest kicks (its 99.5th percentile),
 * 0 at RANGE_DB below that. Each reading covers the ~23 ms ending at it, as
 * an analyser's window does. Memoised per buffer and band.
 */
export function kickEnvelope(buffer, low, high) {
    let byBand = envelopes.get(buffer);
    if (!byBand) envelopes.set(buffer, (byBand = new Map()));
    const lo = Math.max(10, Math.min(low, high - 1));
    const hi = Math.max(lo + 1, high);
    const key = `${lo.toFixed(1)}|${hi.toFixed(1)}`;
    let env = byBand.get(key);
    if (env) return env;

    const sr = buffer.sampleRate;
    const x = Float32Array.from(monoOf(buffer));
    // Two passes each way round for a steeper band (fourth order).
    const hp = biquad('high', lo, sr);
    const lp = biquad('low', hi, sr);
    filterInPlace(x, hp);
    filterInPlace(x, hp);
    filterInPlace(x, lp);
    filterInPlace(x, lp);

    const n = Math.floor(x.length / HOP);
    const energy = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        let s = 0;
        for (let i = k * HOP; i < (k + 1) * HOP; i++) s += x[i] * x[i];
        energy[k] = s;
    }
    const db = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        let s = 0;
        for (let j = Math.max(0, k - WINDOW + 1); j <= k; j++) s += energy[j];
        db[k] = 10 * Math.log10(s / (HOP * WINDOW) + 1e-12);
    }
    const sorted = Float32Array.from(db).sort();
    const top = sorted[Math.floor((sorted.length - 1) * 0.995)] ?? 0;
    const level = new Float32Array(n);
    for (let k = 0; k < n; k++) level[k] = Math.max(0, Math.min(1, (db[k] - (top - RANGE_DB)) / RANGE_DB));

    env = { rate: sr / HOP, level, duration: buffer.duration, hits: new Map() };
    // A handful of bands is plenty to keep while a slider is dragged about.
    if (byBand.size >= 6) byBand.delete(byBand.keys().next().value);
    byBand.set(key, env);
    return env;
}

/**
 * Hit times (seconds) in an envelope: the level crossing `threshold` on its
 * way up. After a hit the next one counts once the level has fallen back -
 * under the threshold, or a little way off its peak - so a kick that rings
 * on is one hit, and `gap` keeps a flam from counting twice. Memoised.
 */
export function kickHits(env, threshold, gap) {
    const key = `${threshold.toFixed(4)}|${gap.toFixed(4)}`;
    let hits = env.hits.get(key);
    if (hits) return hits;
    const out = [];
    const L = env.level;
    let armed = true;
    let peak = 0;
    let prev = 0;
    let last = -Infinity;
    for (let k = 0; k < L.length; k++) {
        const v = L[k];
        const t = k / env.rate;
        if (!armed) {
            peak = Math.max(peak, v);
            if (v < threshold || v < peak - 0.06) armed = true;
        }
        if (armed && v >= threshold && v > prev && t - last >= gap) {
            out.push(t);
            last = t;
            armed = false;
            peak = v;
        }
        prev = v;
    }
    hits = Float64Array.from(out);
    if (env.hits.size >= 12) env.hits.delete(env.hits.keys().next().value);
    env.hits.set(key, hits);
    return hits;
}

/** The envelope's level at `time` seconds into the track. */
export function kickLevelAt(env, time) {
    const k = Math.floor(time * env.rate);
    return k >= 0 && k < env.level.length ? env.level[k] : 0;
}
