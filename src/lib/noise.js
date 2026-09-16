// Shared procedural primitives: seeded RNG, improved Perlin noise with a
// looping time axis, fractal sums and ordered-dither thresholds. Used by the
// ProceduralAscii tool and the lightweight AsciiField frames / separators.

export const TWO_PI = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
export const wrap = (v, n) => {
    const r = v % n;
    return r < 0 ? r + n : r;
};

// mulberry32 with a Box-Muller gaussian on top
export function makeRng(seed) {
    let a = (seed | 0) ^ 0x6d2b79f5;
    let spare = null;
    const next = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => {
        if (spare !== null) {
            const s = spare;
            spare = null;
            return s;
        }
        let u = 0;
        while (u === 0) u = next();
        const m = Math.sqrt(-2 * Math.log(u));
        const th = TWO_PI * next();
        spare = m * Math.sin(th);
        return m * Math.cos(th);
    };
    return { next, gauss };
}

// 8x8 ordered-dither thresholds in (0, 1)
export const BAYER8 = (() => {
    let m = [[0]];
    for (let k = 0; k < 3; k++) {
        const n = m.length;
        const next = Array.from({ length: n * 2 }, () => new Array(n * 2));
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const v = 4 * m[y][x];
                next[y][x] = v;
                next[y][x + n] = v + 2;
                next[y + n][x] = v + 3;
                next[y + n][x + n] = v + 1;
            }
        }
        m = next;
    }
    return Float32Array.from(m.flat(), (v) => (v + 0.5) / 64);
})();

// the 12 cube-edge gradients from Ken Perlin's improved noise
const GRAD_X = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GRAD_Y = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GRAD_Z = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

// Hash an integer lattice point to a gradient and dot it with the offset.
function gradDot(ix, iy, iz, seed, x, y, z) {
    let h = Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca77) ^ Math.imul(iz, 0xc2b2ae3d) ^ seed;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    const g = (h >>> 0) % 12;
    return GRAD_X[g] * x + GRAD_Y[g] * y + GRAD_Z[g] * z;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// Gradient noise in roughly [-1, 1]. The lattice wraps every zPeriod cells
// along z, which is what lets the animation loop.
export function perlin3(x, y, z, zPeriod, seed) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const dx = x - x0;
    const dy = y - y0;
    const dz = z - z0;
    const ix = x0 | 0;
    const iy = y0 | 0;
    const iz = wrap(z0, zPeriod);
    const iz1 = (iz + 1) % zPeriod;
    const u = fade(dx);
    const v = fade(dy);
    const w = fade(dz);

    const n000 = gradDot(ix, iy, iz, seed, dx, dy, dz);
    const n100 = gradDot(ix + 1, iy, iz, seed, dx - 1, dy, dz);
    const n010 = gradDot(ix, iy + 1, iz, seed, dx, dy - 1, dz);
    const n110 = gradDot(ix + 1, iy + 1, iz, seed, dx - 1, dy - 1, dz);
    const n001 = gradDot(ix, iy, iz1, seed, dx, dy, dz - 1);
    const n101 = gradDot(ix + 1, iy, iz1, seed, dx - 1, dy, dz - 1);
    const n011 = gradDot(ix, iy + 1, iz1, seed, dx, dy - 1, dz - 1);
    const n111 = gradDot(ix + 1, iy + 1, iz1, seed, dx - 1, dy - 1, dz - 1);

    const a0 = n000 + u * (n100 - n000);
    const a1 = n010 + u * (n110 - n010);
    const b0 = n001 + u * (n101 - n001);
    const b1 = n011 + u * (n111 - n011);
    const near = a0 + v * (a1 - a0);
    const far = b0 + v * (b1 - b0);
    return near + w * (far - near);
}

export const FRACTAL_KIND = { fbm: 0, turbulence: 1, ridged: 2 };

// Sum of octaves. phase in [0, 1) is the position around the time loop.
export function fractalNoise(x, y, phase, p, seed, kind) {
    let total = 0;
    let amplitude = 1;
    let frequency = 1;
    let norm = 0;
    for (let o = 0; o < p.octaves; o++) {
        // each octave must fit a whole number of lattice cells into the loop
        const period = Math.max(1, Math.round(p.loopCells * frequency));
        // the shift keeps lattice points of different octaves from lining up
        const shift = o * 17.31;
        let n = perlin3(x * frequency + shift, y * frequency + shift, phase * period, period, (seed + o * 1000003) | 0);
        if (kind === 1) {
            n = Math.abs(n);
        } else if (kind === 2) {
            n = 1 - Math.abs(n);
            n *= n;
        }
        total += amplitude * n;
        norm += amplitude;
        amplitude *= p.persistence;
        frequency *= p.lacunarity;
    }
    return norm ? total / norm : 0;
}
