// A sound's acoustic features over its whole length, and the manifold they
// trace: keypoints spaced evenly in time, each placed by three features (one
// per axis), for a Manifold to draw a spline through.
//
// The sound is analysed once (per decoded buffer) with a short-time Fourier
// transform: Hann windows of FFT_SIZE samples every HOP samples. Each frame
// keeps its power in a few dozen bands (one FFT bin each at the bottom,
// widening logarithmically above) and the features below. A keypoint
// averages its frames over a window around its time, so changing an axis or
// the number of keypoints is quick; only a new sound is analysed again.
//
// Each axis is fitted to ±size: the middle 98% of its values span it (so a
// stray silence doesn't squash the rest), the time axis exactly. An axis can
// read its feature a delay earlier (delay embedding: x(t), x(t − τ),
// x(t − 2τ) unfolds one feature into a 3D shape of its own).
//
// No three.js, no React, no Web Audio: anything shaped like an AudioBuffer
// (sampleRate, length, numberOfChannels, getChannelData) will do.

export const FFT_SIZE = 2048;
const HOP = 1024;
export const MAX_KEYPOINTS = 400;
const F_MIN = 20;

/** What an axis can show, as [key, label]. */
export const MANIFOLD_FEATURES = [
    ['time', 'Time'],
    ['loudness', 'Loudness (dB)'],
    ['lows', 'Lows, 20–150 Hz (dB)'],
    ['mids', 'Mids, 250–2000 Hz (dB)'],
    ['highs', 'Highs, 5–16 kHz (dB)'],
    ['band', 'A band of your own (dB)'],
    ['centroid', 'Brightness (spectral centroid)'],
    ['spread', 'Spread (spectral bandwidth)'],
    ['rolloff', 'Roll-off (85% of the energy below)'],
    ['flatness', 'Noisiness (spectral flatness)'],
    ['flux', 'Onsets (spectral flux)'],
    ['zcr', 'Zero crossings'],
    ['pc1', 'Spectrum, principal component 1'],
    ['pc2', 'Spectrum, principal component 2'],
    ['pc3', 'Spectrum, principal component 3'],
];
const PRESET_BANDS = { lows: [20, 150], mids: [250, 2000], highs: [5000, 16000] };

// ---- The FFT ------------------------------------------------------------------------

const tables = new Map(); // size -> { rev, cos, sin }

function fftTables(n) {
    let t = tables.get(n);
    if (t) return t;
    const bits = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n);
        sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { rev, cos, sin };
    tables.set(n, t);
    return t;
}

/** In-place radix-2 FFT of (re, im), length a power of two. */
export function fft(re, im) {
    const n = re.length;
    const { rev, cos, sin } = fftTables(n);
    for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let s = 0; s < n; s += size) {
            for (let k = 0; k < half; k++) {
                const wr = cos[k * step];
                const wi = sin[k * step];
                const a = s + k;
                const b = a + half;
                const xr = re[b] * wr - im[b] * wi;
                const xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
}

// ---- Analysis -------------------------------------------------------------------------

/** Band edges in FFT bins: one bin each at the bottom, then widening by `ratio`. */
function bandEdges(sampleRate, n, ratio = 1.12) {
    const top = n / 2;
    const edges = [Math.max(1, Math.floor((F_MIN * n) / sampleRate))];
    while (edges[edges.length - 1] < top) {
        const e = edges[edges.length - 1];
        edges.push(Math.min(top, Math.max(e + 1, Math.round(e * ratio))));
    }
    return Int32Array.from(edges);
}

const analyses = new WeakMap(); // buffer -> Promise<analysis>

/**
 * The analysis of `buffer`, worked out once and kept: a promise of
 * `{ duration, sampleRate, rate, frames, hop, size, edges, bands, power, energy,
 * centroid, spread, rolloff, flatness, flux, zcr }`, the per-frame arrays
 * Float32Arrays (`power` frames × bands). It yields to the page every so often;
 * `onProgress(0..1)` hears how far it has got (the first caller's only).
 */
export function analyseSound(buffer, onProgress) {
    if (!buffer) return Promise.resolve(null);
    let pr = analyses.get(buffer);
    if (!pr) {
        pr = run(buffer, onProgress);
        analyses.set(buffer, pr);
    }
    return pr;
}

const pause = () => new Promise((r) => setTimeout(r, 0));

async function run(buffer, onProgress) {
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const C = buffer.numberOfChannels;
    const mono = new Float32Array(len);
    for (let c = 0; c < C; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += d[i];
    }
    if (C > 1) for (let i = 0; i < len; i++) mono[i] /= C;

    const N = FFT_SIZE;
    const H = HOP;
    const frames = Math.max(1, Math.floor(Math.max(0, len - N) / H) + 1);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const edges = bandEdges(sr, N);
    const B = edges.length - 1;
    const half = N / 2;
    const binHz = sr / N;
    const logHz = new Float64Array(half + 1);
    for (let k = 1; k <= half; k++) logHz[k] = Math.log2(k * binHz);

    const power = new Float32Array(frames * B);
    const energy = new Float32Array(frames);
    const centroid = new Float32Array(frames);
    const spread = new Float32Array(frames);
    const rolloff = new Float32Array(frames);
    const flatness = new Float32Array(frames);
    const flux = new Float32Array(frames);
    const zcr = new Float32Array(frames);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const P = new Float64Array(half + 1);
    let prevMag = new Float64Array(half + 1);
    let mag = new Float64Array(half + 1);
    // A full-scale sine through the Hann window peaks at about N / 4.
    const magScale = 4 / N;
    let lastYield = Date.now();

    for (let f = 0; f < frames; f++) {
        const s0 = f * H;
        let e = 0;
        let crossings = 0;
        let prev = 0;
        for (let i = 0; i < N; i++) {
            const x = s0 + i < len ? mono[s0 + i] : 0;
            e += x * x;
            if (i > 0 && (x >= 0) !== (prev >= 0)) crossings++;
            prev = x;
            re[i] = x * win[i];
            im[i] = 0;
        }
        energy[f] = e / N;
        zcr[f] = crossings / N;
        fft(re, im);
        let total = 0;
        let wHz = 0;
        let logSum = 0;
        for (let k = 1; k <= half; k++) {
            const p = re[k] * re[k] + im[k] * im[k];
            P[k] = p;
            total += p;
            wHz += p * logHz[k];
            logSum += Math.log(p + 1e-20);
            mag[k] = Math.sqrt(p) * magScale;
        }
        for (let b = 0; b < B; b++) {
            let s = 0;
            for (let k = edges[b]; k < edges[b + 1]; k++) s += P[k];
            power[f * B + b] = s;
        }
        const c = total > 0 ? wHz / total : logHz[1];
        let v = 0;
        let acc = 0;
        let roll = half;
        for (let k = 1; k <= half; k++) {
            const d = logHz[k] - c;
            v += P[k] * d * d;
            acc += P[k];
            if (roll === half && acc >= 0.85 * total) roll = k;
        }
        centroid[f] = c;
        spread[f] = total > 0 ? Math.sqrt(v / total) : 0;
        rolloff[f] = logHz[Math.max(1, roll)];
        const geo = Math.exp(logSum / half);
        flatness[f] = 10 * Math.log10(Math.max(1e-6, total > 0 ? geo / (total / half) : 1e-6));
        let fl = 0;
        if (f > 0) {
            for (let k = 1; k <= half; k++) {
                const d = Math.log1p(100 * mag[k]) - Math.log1p(100 * prevMag[k]);
                if (d > 0) fl += d;
            }
        }
        flux[f] = fl / half;
        [prevMag, mag] = [mag, prevMag];

        if (Date.now() - lastYield > 40) {
            onProgress?.(f / frames);
            // eslint-disable-next-line no-await-in-loop
            await pause();
            lastYield = Date.now();
        }
    }
    onProgress?.(1);
    return {
        duration: len / sr,
        sampleRate: sr,
        rate: sr / H,
        hop: H,
        size: N,
        frames,
        edges,
        bands: B,
        bandHz: Float64Array.from({ length: B + 1 }, (_, b) => edges[b] * binHz),
        power,
        energy,
        centroid,
        spread,
        rolloff,
        flatness,
        flux,
        zcr,
    };
}

// ---- Keypoints ----------------------------------------------------------------------

/** The frame whose window is centred on time `t` (s), fractionally. */
const frameAt = (A, t) => ((t * A.sampleRate) - A.size / 2) / A.hop;

/** The frames whose centres are within w/2 of t: [first, last], at least the nearest one. */
function framesAround(A, t, w) {
    const a = Math.ceil(frameAt(A, t - w / 2));
    const b = Math.floor(frameAt(A, t + w / 2));
    const clampF = (x) => Math.max(0, Math.min(A.frames - 1, x));
    if (b < a) {
        const near = clampF(Math.round(frameAt(A, t)));
        return [near, near];
    }
    return [clampF(a), clampF(b)];
}

/** How much of each band falls in [lo, hi] Hz (0..1 each). */
function bandWeights(A, lo, hi) {
    const w = new Float64Array(A.bands);
    const l = Math.min(lo, hi);
    const h = Math.max(lo, hi);
    for (let b = 0; b < A.bands; b++) {
        const a = A.bandHz[b];
        const z = A.bandHz[b + 1];
        const over = Math.min(z, h) - Math.max(a, l);
        if (over > 0) w[b] = over / (z - a);
    }
    // Narrower than a band: the band it is in.
    if (!w.some((x) => x > 0)) {
        const mid = (l + h) / 2;
        let best = 0;
        for (let b = 0; b < A.bands; b++) if (A.bandHz[b] <= mid) best = b;
        w[best] = 1;
    }
    return w;
}

const dB = (p) => 10 * Math.log10(p + 1e-12);

/** Feature `key` over frames [a, b]. */
function aggregate(A, key, a, b, weights) {
    const n = b - a + 1;
    if (key === 'loudness') {
        let s = 0;
        for (let f = a; f <= b; f++) s += A.energy[f];
        return Math.max(-100, dB(s / n));
    }
    if (weights) {
        let s = 0;
        for (let f = a; f <= b; f++) {
            const o = f * A.bands;
            for (let k = 0; k < A.bands; k++) if (weights[k]) s += weights[k] * A.power[o + k];
        }
        return Math.max(-100, dB(s / n));
    }
    if (key === 'flux') {
        let s = 0;
        for (let f = a; f <= b; f++) s += A.flux[f];
        return s / n;
    }
    // Spectral shape: louder frames count for more, so near-silence doesn't decide it.
    const arr = A[key];
    let s = 0;
    let wsum = 0;
    for (let f = a; f <= b; f++) {
        const w = A.energy[f] + 1e-10;
        s += arr[f] * w;
        wsum += w;
    }
    return s / wsum;
}

/** The log band spectrum over frames [a, b], for the principal components. */
function spectrumOver(A, a, b) {
    const out = new Float64Array(A.bands);
    for (let f = a; f <= b; f++) {
        const o = f * A.bands;
        for (let k = 0; k < A.bands; k++) out[k] += A.power[o + k];
    }
    const n = b - a + 1;
    for (let k = 0; k < A.bands; k++) out[k] = Math.max(-100, dB(out[k] / n));
    return out;
}

/** The mean and the top three principal directions of rows (each Float64Array(d)). */
function principal(rows, count = 3) {
    const d = rows[0].length;
    const n = rows.length;
    const mean = new Float64Array(d);
    rows.forEach((r) => { for (let k = 0; k < d; k++) mean[k] += r[k] / n; });
    const C = new Float64Array(d * d);
    rows.forEach((r) => {
        for (let i = 0; i < d; i++) {
            const a = r[i] - mean[i];
            if (!a) continue;
            for (let j = i; j < d; j++) C[i * d + j] += a * (r[j] - mean[j]);
        }
    });
    for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) C[i * d + j] = C[j * d + i];
    const dirs = [];
    for (let c = 0; c < count; c++) {
        // Power iteration from a fixed start, deflating the ones found.
        let v = Float64Array.from({ length: d }, (_, k) => 1 + ((k * 7919 + c * 104729) % 97) / 97);
        for (let it = 0; it < 200; it++) {
            const w = new Float64Array(d);
            for (let i = 0; i < d; i++) {
                let s = 0;
                for (let j = 0; j < d; j++) s += C[i * d + j] * v[j];
                w[i] = s;
            }
            dirs.forEach((u) => {
                let dot = 0;
                for (let k = 0; k < d; k++) dot += w[k] * u[k];
                for (let k = 0; k < d; k++) w[k] -= dot * u[k];
            });
            let norm = 0;
            for (let k = 0; k < d; k++) norm += w[k] * w[k];
            norm = Math.sqrt(norm);
            if (!(norm > 1e-12)) break;
            for (let k = 0; k < d; k++) w[k] /= norm;
            v = w;
        }
        // The same way round every time: more of everything is positive.
        let sum = 0;
        for (let k = 0; k < d; k++) sum += v[k];
        if (sum < 0) for (let k = 0; k < d; k++) v[k] = -v[k];
        dirs.push(v);
    }
    return { mean, dirs };
}

function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const x = (sorted.length - 1) * q;
    const i = Math.floor(x);
    const j = Math.min(sorted.length - 1, i + 1);
    return sorted[i] + (sorted[j] - sorted[i]) * (x - i);
}

/** Values fitted to ±size: exactly (time) or by their middle 98%. */
function fit(values, size, exact) {
    const sorted = Float64Array.from(values).sort();
    const lo = exact ? sorted[0] : percentile(sorted, 0.01);
    const hi = exact ? sorted[sorted.length - 1] : percentile(sorted, 0.99);
    const span = hi - lo;
    if (!(span > 1e-9)) return values.map(() => 0);
    return values.map((v) => (((v - lo) / span) * 2 - 1) * size);
}

/** An axis's options, with defaults: `{ feature, low, high, lag, size }`. */
const axisOf = (ax = {}) => ({
    feature: MANIFOLD_FEATURES.some(([k]) => k === ax.feature) ? ax.feature : 'time',
    low: Number.isFinite(ax.low) ? ax.low : 2000,
    high: Number.isFinite(ax.high) ? ax.high : 5000,
    lag: Number.isFinite(ax.lag) ? ax.lag : 0,
    size: Number.isFinite(ax.size) ? ax.size : 1,
});

/**
 * Keypoints through analysis `A`:
 *   count      how many (2..MAX_KEYPOINTS), evenly spaced in time
 *   from, to   the stretch of the sound (s); `to` of 0 (or before `from`) is its end
 *   window     each keypoint averages this many keypoint spacings around it (≥ one frame)
 *   axes       three axis options (see axisOf)
 * Returns `{ points: [[x, y, z], ...], times: [s, ...], from, to }`.
 */
export function manifoldKeypoints(A, {
    count = 96, from = 0, to = 0, window = 1, axes = [],
} = {}) {
    const n = Math.max(2, Math.min(MAX_KEYPOINTS, Math.round(count) || 2));
    let t0 = Math.max(0, Math.min(A.duration, from || 0));
    let t1 = to > t0 ? Math.min(A.duration, to) : A.duration;
    if (!(t1 - t0 > 1e-3)) { t0 = 0; t1 = A.duration; }
    const dt = (t1 - t0) / (n - 1);
    const w = Math.max(1 / A.rate, (window > 0 ? window : 1) * dt);
    const times = Array.from({ length: n }, (_, i) => t0 + i * dt);
    const ax = [0, 1, 2].map((d) => axisOf(axes[d]));

    // The spectrum's principal directions, from the keypoints themselves.
    let pca = null;
    if (ax.some((a) => /^pc[123]$/.test(a.feature))) {
        pca = principal(times.map((t) => spectrumOver(A, ...framesAround(A, t, w))));
    }

    const coords = ax.map((a) => {
        const { feature } = a;
        const band = feature === 'band' ? [a.low, a.high] : PRESET_BANDS[feature];
        const weights = band ? bandWeights(A, band[0], band[1]) : null;
        const values = times.map((t) => {
            const at = t - a.lag;
            if (feature === 'time') return at;
            const [fa, fb] = framesAround(A, at, w);
            if (pca && feature.startsWith('pc')) {
                const s = spectrumOver(A, fa, fb);
                const dir = pca.dirs[Number(feature[2]) - 1];
                let v = 0;
                for (let k = 0; k < s.length; k++) v += (s[k] - pca.mean[k]) * dir[k];
                return v;
            }
            return aggregate(A, feature, fa, fb, weights);
        });
        return fit(values, a.size, feature === 'time');
    });
    const r = (v) => Math.round(v * 1e4) / 1e4;
    return {
        points: times.map((_, i) => [r(coords[0][i]), r(coords[1][i]), r(coords[2][i])]),
        times,
        from: t0,
        to: t1,
    };
}

// ---- A Manifold object's settings ------------------------------------------------------

/** What manifoldKeypoints takes, from a Manifold's parameters. */
export function manifoldSettings(p) {
    return {
        count: p.keypoints,
        from: p.timeFrom,
        to: p.timeTo,
        window: p.window,
        axes: ['X', 'Y', 'Z'].map((A) => ({
            feature: p[`axis${A}`],
            low: p[`axis${A}Low`],
            high: p[`axis${A}High`],
            lag: p[`axis${A}Lag`],
            size: p[`axis${A}Size`],
        })),
    };
}

/**
 * What a Manifold's keypoints were made from, as a string: the same for the
 * same settings and sound (by its length; a sound edited to the same length
 * wants Generate pressing).
 */
export const manifoldKey = (p, duration) => JSON.stringify([p.source || 'music', Math.round((duration || 0) * 1000), manifoldSettings(p)]);
