import { mulberry32 } from './random.js';

// Ported from tetra (frontend/src/terrain/textures.js): just the noise tile
// the robots' hull texture is made from. Tileable 2D Perlin fBm whose integer
// periods double each octave, normalized, given contrast, then posterized
// with Bayer dithering.

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Seeded 2D gradient noise that repeats every `px` x `py` lattice cells. */
function periodicNoise(seed) {
  const rand = mulberry32(seed);
  const p = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const D = Math.SQRT1_2;
  // Eight evenly spread directions, as in backend/src/terrain/noise.rs.
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x;
      case 1: return -x;
      case 2: return y;
      case 3: return -y;
      case 4: return (x + y) * D;
      case 5: return (-x + y) * D;
      case 6: return (x - y) * D;
      default: return (-x - y) * D;
    }
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, px, py) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const xi = ((x0 % px) + px) % px;
    const yi = ((y0 % py) + py) % py;
    const x1 = (xi + 1) % px;
    const y1 = (yi + 1) % py;
    const h = (a, b) => perm[perm[a & 255] + (b & 255)];
    const u = fade(fx);
    const v = fade(fy);
    const a = grad(h(xi, yi), fx, fy) + (grad(h(x1, yi), fx - 1, fy) - grad(h(xi, yi), fx, fy)) * u;
    const b = grad(h(xi, y1), fx, fy - 1) + (grad(h(x1, y1), fx - 1, fy - 1) - grad(h(xi, y1), fx, fy - 1)) * u;
    return a + (b - a) * v;
  };
}

/**
 * One grey tile (Uint8Array, `res` squared) from a texture spec
 * (`period`, `octaves`, `persistence`, `contrast`), posterized to `levels`.
 */
export function noiseTile(tex, res, levels, dither, seed) {
  const noise = periodicNoise(seed);
  const raw = new Float32Array(res * res);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0, i = 0; y < res; y++) {
    for (let x = 0; x < res; x++, i++) {
      const u = x / res;
      const v = y / res;
      let [px, py] = tex.period;
      let amp = 1;
      let sum = 0;
      for (let o = 0; o < tex.octaves; o++) {
        sum += noise(u * px, v * py, px, py) * amp;
        px = Math.min(px * 2, 256);
        py = Math.min(py * 2, 256);
        amp *= tex.persistence;
      }
      raw[i] = sum;
      lo = Math.min(lo, sum);
      hi = Math.max(hi, sum);
    }
  }
  const span = Math.max(hi - lo, 1e-9);
  const steps = Math.max(1, levels - 1);
  const out = new Uint8Array(res * res);
  for (let i = 0; i < raw.length; i++) {
    const n = Math.min(1, Math.max(0, ((raw[i] - lo) / span - 0.5) * tex.contrast + 0.5));
    const d = dither ? (BAYER4[(Math.floor(i / res) % 4) * 4 + ((i % res) % 4)] + 0.5) / 16 - 0.5 : 0;
    out[i] = Math.round((Math.min(steps, Math.max(0, Math.round(n * steps + d))) / steps) * 255);
  }
  return out;
}
