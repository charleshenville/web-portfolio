// Splines through points: a polynomial of the chosen degree on each stretch
// between two defining points, joined so that every derivative up to one
// less than the degree is the same on both sides of every defining point
// (a cubic's slope and curvature, a quintic's first four derivatives).
//
// With n points there are n - 1 stretches of degree k, k + 1 coefficients
// each. Passing through the points fixes two per stretch, and matching k - 1
// derivatives at each of the n - 2 inner points fixes the rest bar k - 1:
// those come from how the ends are treated, so there is exactly one spline.
//
//   natural   the highest derivatives are zero at the ends. Odd degrees put
//             the same number at each end (a cubic's curvature, a quintic's
//             third and fourth derivatives); even degrees can't split k - 1
//             evenly, so the start takes one more (a quadratic's first
//             stretch is straight; a quartic's first stretch is a quadratic
//             and its last a cubic).
//   clamped   the ends' derivatives are given: velocity (and acceleration)
//             at the start and end, as many as the degree needs. Measured
//             along the end stretch, start to end of it as 0 to 1, so a
//             velocity of P1 − P0 is the straight line's.
//   closed    it loops: the last point joins back to the first, matched like
//             every other. Even degrees through an even number of points
//             have no such spline (the conditions contradict each other).
//
// Spacing says how much of the parameter each stretch gets: uniform (the
// same each), chord length (in proportion to its length) or centripetal
// (the square root of that, which keeps sharp turns from looping).
//
// The parameter u runs 0 to 1 over the whole spline.

/** The handle that moves all of a spline's points at once, in viewport editing. */
export const ALL_POINTS = 1000;

export const SPLINE_DEGREES = [[1, 'Linear'], [2, 'Quadratic'], [3, 'Cubic'], [4, 'Quartic'], [5, 'Quintic']];
export const SPLINE_ENDS = [['natural', 'Natural'], ['clamped', 'Clamped (set the ends)'], ['closed', 'Closed loop']];
export const SPLINE_SPACING = [['uniform', 'Uniform'], ['chord', 'Chord length'], ['centripetal', 'Centripetal']];
const DEGREE_NAME = Object.fromEntries(SPLINE_DEGREES);

/** The derivative orders an open spline's ends fix: `{ start: [...], end: [...] }`. */
export function endOrders(degree, ends) {
    const k = Math.round(degree);
    const range = (a, b) => { const out = []; for (let r = a; r <= b; r++) out.push(r); return out; };
    if (k <= 1 || ends === 'closed') return { start: [], end: [] };
    if (ends === 'clamped') return { start: range(1, Math.ceil((k - 1) / 2)), end: range(1, Math.floor((k - 1) / 2)) };
    if (k % 2) {
        const m = (k + 1) / 2;
        return { start: range(m, k - 1), end: range(m, k - 1) };
    }
    const m = k / 2;
    return { start: range(m + 1, k), end: range(m + 2, k) };
}

const ORDER_NAME = ['position', 'velocity', 'acceleration', 'jerk', 'snap'];
export const orderName = (r) => ORDER_NAME[r] || `derivative ${r}`;

// Falling factorial j! / (j - r)!: the r-th derivative of s^j at s = 1.
const ff = (j, r) => { let v = 1; for (let i = 0; i < r; i++) v *= j - i; return v; };
const fact = (r) => ff(r, r);

// ---- The linear system ----------------------------------------------------------

const luCache = new Map();

/** LU-factor a dense n×n matrix (row-major) in place, with partial pivoting; null if singular. */
function luFactor(A, n) {
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    let scale = 0;
    for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(A[i]));
    const tiny = Math.max(1e-300, scale * 1e-11);
    for (let c = 0; c < n; c++) {
        let p = c;
        let best = Math.abs(A[c * n + c]);
        for (let r = c + 1; r < n; r++) {
            const v = Math.abs(A[r * n + c]);
            if (v > best) { best = v; p = r; }
        }
        if (best < tiny) return null;
        if (p !== c) {
            for (let j = 0; j < n; j++) { const t = A[c * n + j]; A[c * n + j] = A[p * n + j]; A[p * n + j] = t; }
            const t = perm[c]; perm[c] = perm[p]; perm[p] = t;
        }
        const d = A[c * n + c];
        for (let r = c + 1; r < n; r++) {
            const f = A[r * n + c] / d;
            if (f === 0) continue;
            A[r * n + c] = f;
            for (let j = c + 1; j < n; j++) A[r * n + j] -= f * A[c * n + j];
        }
    }
    return { A, perm, n };
}

function luSolve({ A, perm, n }, b) {
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = b[perm[i]];
    for (let i = 0; i < n; i++) {
        let s = x[i];
        for (let j = 0; j < i; j++) s -= A[i * n + j] * x[j];
        x[i] = s;
    }
    for (let i = n - 1; i >= 0; i--) {
        let s = x[i];
        for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
        x[i] = s / A[i * n + i];
    }
    return x;
}

/**
 * The system for N stretches of degree k with stretch lengths h, and what
 * each row's right-hand side is: rows are { kind: 'pt', p } (a point's
 * coordinate), { kind: 'zero' } or { kind: 'end', side, r } (a clamped
 * derivative). Factored and cached: it depends on the shape, not the points.
 */
function system(N, k, h, closed, orders) {
    const key = `${N}|${k}|${closed ? 1 : 0}|${orders.start.join(',')}/${orders.end.join(',')}|${Array.from(h, (v) => v.toPrecision(10)).join(',')}`;
    const hit = luCache.get(key);
    if (hit !== undefined) return hit;
    const K = k + 1;
    const n = N * K;
    const A = new Float64Array(n * n);
    const rows = [];
    let r = 0;
    const at = (seg, j) => seg * K + j;
    for (let i = 0; i < N; i++) {
        // Through its start point and its end point.
        A[r * n + at(i, 0)] = 1;
        rows.push({ kind: 'pt', p: i });
        r++;
        for (let j = 0; j <= k; j++) A[r * n + at(i, j)] = 1;
        rows.push({ kind: 'pt', p: closed ? (i + 1) % N : i + 1 });
        r++;
    }
    // Derivatives 1..k-1 matched where each stretch meets the next.
    const joins = closed ? N : N - 1;
    for (let i = 0; i < joins; i++) {
        const nx = (i + 1) % N;
        const ratio = h[i] / h[nx];
        for (let d = 1; d < k; d++) {
            for (let j = d; j <= k; j++) A[r * n + at(i, j)] += ff(j, d);
            A[r * n + at(nx, d)] -= ratio ** d * fact(d);
            rows.push({ kind: 'zero' });
            r++;
        }
    }
    if (!closed) {
        orders.start.forEach((d) => {
            A[r * n + at(0, d)] = fact(d);
            rows.push({ kind: 'end', side: 'start', r: d });
            r++;
        });
        orders.end.forEach((d) => {
            for (let j = d; j <= k; j++) A[r * n + at(N - 1, j)] = ff(j, d);
            rows.push({ kind: 'end', side: 'end', r: d });
            r++;
        });
    }
    let out = null;
    if (r === n) {
        const lu = luFactor(A, n);
        out = lu ? { lu, rows, n } : null;
    }
    if (luCache.size > 64) luCache.delete(luCache.keys().next().value);
    luCache.set(key, out);
    return out;
}

// ---- Solving -----------------------------------------------------------------------

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** The parameter each stretch gets, normalised to a mean of 1. */
function spacingOf(points, closed, spacing) {
    const n = points.length;
    const N = closed ? n : n - 1;
    const h = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const d = dist(points[i], points[(i + 1) % n]);
        h[i] = spacing === 'chord' ? d : spacing === 'centripetal' ? Math.sqrt(d) : 1;
    }
    let mean = 0;
    for (let i = 0; i < N; i++) mean += h[i];
    mean /= Math.max(1, N);
    for (let i = 0; i < N; i++) h[i] = mean > 0 ? Math.max(h[i] / mean, 1e-4) : 1;
    return h;
}

/**
 * The spline through `points` ([[x, y, z], ...]):
 *   degree   1-5
 *   ends     'natural' | 'clamped' | 'closed'
 *   spacing  'uniform' | 'chord' | 'centripetal'
 *   clamp    for clamped ends, `{ start: { [r]: [x, y, z] }, end: { ... } }`:
 *            the derivatives endOrders() asks for, any left out taken from
 *            the end stretch's chord (a velocity) or as zero (higher ones)
 * Returns `{ degree, asked, closed, n, N, k, h, knots, coef, error, note }`;
 * coef holds, for each dimension, each stretch's k + 1 coefficients in its
 * own 0..1 parameter. When the degree asked for has no solution with these
 * points it drops a degree at a time, and `note` says so.
 */
export function solveSpline(points, opts = {}) {
    const pts = (points || []).filter((p) => p && p.every(Number.isFinite));
    const asked = Math.max(1, Math.min(5, Math.round(opts.degree || 3)));
    const closed = opts.ends === 'closed' && pts.length >= 3;
    // Too few points to close: an open, natural one.
    const ends = closed ? 'closed' : (opts.ends === 'clamped' ? 'clamped' : 'natural');
    const n = pts.length;
    const base = { asked, closed, n, error: null, note: null };
    if (n < (points || []).length) base.note = 'Some points don\'t work out to numbers and are left out.';
    if (n === 0) return { ...base, degree: 0, N: 0, error: 'No points' };
    if (n === 1) return { ...base, degree: 0, N: 0, single: pts[0] };
    const N = closed ? n : n - 1;
    const h = spacingOf(pts, closed, opts.spacing);
    for (let k = asked; k >= 1; k--) {
        const orders = endOrders(k, ends);
        const sys = system(N, k, h, closed, orders);
        if (!sys) continue;
        const K = k + 1;
        const coef = [0, 1, 2].map((dim) => {
            const b = new Float64Array(sys.n);
            sys.rows.forEach((row, i) => {
                if (row.kind === 'pt') b[i] = pts[row.p][dim];
                else if (row.kind === 'end' && ends === 'clamped') {
                    const given = opts.clamp?.[row.side]?.[row.r];
                    if (given && Number.isFinite(given[dim])) b[i] = given[dim];
                    else if (row.r === 1) b[i] = row.side === 'start' ? pts[1][dim] - pts[0][dim] : pts[n - 1][dim] - pts[n - 2][dim];
                    else b[i] = 0;
                }
            });
            return luSolve(sys.lu, b);
        });
        const knots = new Float64Array(N + 1);
        for (let i = 0; i < N; i++) knots[i + 1] = knots[i] + h[i];
        let note = base.note;
        if (k < asked) {
            const why = closed && asked % 2 === 0 && n % 2 === 0
                ? `A closed ${DEGREE_NAME[asked].toLowerCase()} spline through an even number of points has no solution`
                : `A ${DEGREE_NAME[asked].toLowerCase()} spline with these ends needs more points`;
            note = `${why}, so it's drawn ${DEGREE_NAME[k].toLowerCase()}.`;
        }
        return { ...base, note, degree: k, k, K, N, h, knots, coef };
    }
    return { ...base, degree: 0, N: 0, error: 'No spline fits these points' };
}

/** Which stretch `u` (0..1) is in, and where along it (0..1). */
function locate(sol, u) {
    const total = sol.knots[sol.N];
    let U;
    if (sol.closed) U = (((u % 1) + 1) % 1) * total;
    else U = Math.max(0, Math.min(1, u)) * total;
    let lo = 0;
    let hi = sol.N - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (sol.knots[mid] <= U) lo = mid; else hi = mid - 1;
    }
    return [lo, Math.max(0, Math.min(1, (U - sol.knots[lo]) / sol.h[lo]))];
}

/** The spline at `u` into `out` ([x, y, z]). */
export function splineAt(sol, u, out = [0, 0, 0]) {
    if (sol.single) { out[0] = sol.single[0]; out[1] = sol.single[1]; out[2] = sol.single[2]; return out; }
    if (!sol.N) { out[0] = NaN; out[1] = NaN; out[2] = NaN; return out; }
    const [seg, s] = locate(sol, u);
    const K = sol.K;
    for (let dim = 0; dim < 3; dim++) {
        const c = sol.coef[dim];
        let v = 0;
        for (let j = K - 1; j >= 0; j--) v = v * s + c[seg * K + j];
        out[dim] = v;
    }
    return out;
}

/** The r-th derivative at `u` along its stretch's own 0..1 (how continuity is checked). */
export function splineDerivAt(sol, u, r = 1, out = [0, 0, 0]) {
    if (!sol.N) { out.fill(0); return out; }
    const [seg, s] = locate(sol, u);
    const K = sol.K;
    for (let dim = 0; dim < 3; dim++) {
        const c = sol.coef[dim];
        let v = 0;
        for (let j = K - 1; j >= r; j--) v = v * s + c[seg * K + j] * ff(j, r);
        out[dim] = v;
    }
    return out;
}

/** What expressions read a spline through: its points and its curve. */
export function splineReader(points, sol) {
    const n = points.length;
    return {
        count: n,
        point: (i) => points[Math.max(0, Math.min(n - 1, i))] || [NaN, NaN, NaN],
        at: (u) => splineAt(sol, u, [0, 0, 0]),
    };
}
