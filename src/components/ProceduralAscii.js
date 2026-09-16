import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, SlidersHorizontal, X, Download, Plus, Shuffle, RotateCcw,
    Rewind, FastForward, StepBack, StepForward,
} from 'lucide-react';
import VfxNumberField from './VfxNumberField';
import styles from './vfx.module.css';
import {
    TWO_PI, clamp, wrap, makeRng, BAYER8, FRACTAL_KIND, fractalNoise,
} from '../lib/noise';

// Procedural ascii generator: a live, interactive port of
// backend/tools/ascii_procedural_generator.py (fractal Perlin noise and a 2D
// Navier-Stokes flow), with playback controls, colour mapping and exports.

// width / height of one monospace character cell (same as the python tool)
const CHAR_ASPECT = 0.45;
const FRAME_DELIMITER = '---FRAME---';
const FONT_STACK = '"SF Mono", ui-monospace, Menlo, Monaco, monospace';
// real seconds a single preview tick may advance, so a background tab
// doesn't come back and try to simulate a minute in one frame
const MAX_TICK_DT = 1 / 20;
// memory budget for the fluid rewind buffer
const HISTORY_BYTES = 96 * 1024 * 1024;
const GRADIENT_BUCKETS = 32;
const MAX_STOPS = 8;
// pixel mode measures noise features as if the screen were this many
// characters wide, so changing the pixel size only changes resolution
const PIXEL_REF_COLS = 160;
// cap on the fluid trail buffer (cells x supersample^2)
const MAX_TRAIL_CELLS = 4e6;

const DEFAULTS = {
    mode: 'perlin',            // 'perlin' | 'fluid'
    style: 'ascii',            // 'ascii' | 'pixels'
    columns: 160,
    lineSpacing: 1,            // ascii row height relative to a normal line
    pixelSize: 12,             // screen pixels per cell; 1 = full resolution
    seed: 0,

    // perlin
    scale: 24,                 // base octave feature size, in character widths
    octaves: 4,
    persistence: 0.5,
    lacunarity: 2,
    fractal: 'fbm',            // 'fbm' | 'turbulence' | 'ridged'
    warp: 0,
    evolve: 0.3,               // lattice cells per second through time
    offsetX: 0,
    offsetY: 0,
    driftX: 0,
    driftY: 0,
    loopDuration: 10,          // seconds; the noise's time axis wraps at this

    // fluid simulation
    grid: 128,
    simSpeed: 0.6,             // sim time per second of playback
    viscosity: 0.0005,
    drag: 0.15,
    force: 3,
    forceK: 4,
    forceTau: 2,
    cfl: 0.7,
    warmup: 5,

    // fluid rendering
    render: 'trails',          // 'trails' | 'vorticity' | 'speed'
    particles: 250,
    fade: 1.8,
    respawn: 0.05,
    supersample: 3,
    exposure: 1.5,
    flowScale: 1,              // > 1 zooms into the flow, < 1 tiles it
    flowScaleX: 1,
    flowScaleY: 1,

    // characters & tone
    ramp: ' .*:o&8#@',
    invert: false,
    contrast: 1,
    brightness: 0,
    gamma: 1,
    dither: 'none',            // 'none' | 'bayer' | 'floyd' | 'atkinson'
    levels: 8,                 // pixel mode colour steps

    // colour
    background: '#000000',
    colorMode: 'solid',        // 'solid' | 'gradient'
    foreground: '#d4d4d4',
    stops: ['#3a3a3a', '#d4d4d4'],
    reverseGradient: false,
};

const CHARSET_PRESETS = [
    { id: 'default', name: 'Default', chars: ' .*:o&8#@' },
    { id: 'classic', name: 'Classic', chars: ' .:-=+*#%@' },
    { id: 'dense', name: 'Dense (70)', chars: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$' },
    { id: 'blocks', name: 'Blocks', chars: ' ░▒▓█' },
    { id: 'dots', name: 'Dots', chars: ' ·•●' },
    { id: 'lines', name: 'Lines', chars: ' -=≡' },
    { id: 'binary', name: 'Binary', chars: ' 01' },
    { id: 'hex', name: 'Hex', chars: ' 0123456789ABCDEF' },
];

const COLOR_PRESETS = [
    { id: 'mono', name: 'Mono', background: '#000000', colorMode: 'solid', foreground: '#d4d4d4' },
    { id: 'greyscale', name: 'Greyscale', background: '#000000', colorMode: 'gradient', stops: ['#262626', '#ffffff'] },
    { id: 'phosphor', name: 'Phosphor', background: '#010805', colorMode: 'gradient', stops: ['#0b3d1a', '#39ff88', '#eaffef'] },
    { id: 'amber', name: 'Amber', background: '#0a0600', colorMode: 'gradient', stops: ['#3d2400', '#ffb000', '#fff1c9'] },
    { id: 'ice', name: 'Ice', background: '#01050b', colorMode: 'gradient', stops: ['#0a2a4a', '#4fb3ff', '#eaf6ff'] },
    { id: 'ember', name: 'Ember', background: '#050000', colorMode: 'gradient', stops: ['#3a0000', '#d62d00', '#ffb300', '#fff6d5'] },
    { id: 'synth', name: 'Synth', background: '#07020f', colorMode: 'gradient', stops: ['#2b0a5c', '#ff2fb4', '#48f2ff'] },
    { id: 'paper', name: 'Paper', background: '#f2efe6', colorMode: 'gradient', stops: ['#c9c3b3', '#1b1b1b'] },
];

const EXPORT_SCALES = [1, 2, 3, 4];
const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];

// ---- Small helpers -----------------------------------------------------------

// Approximate percentile from at most scratch.length evenly spaced samples.
function percentile(values, q, scratch) {
    const stride = Math.max(1, Math.ceil(values.length / scratch.length));
    let n = 0;
    for (let i = 0; i < values.length; i += stride) scratch[n++] = values[i];
    const sorted = scratch.subarray(0, n).sort();
    return sorted[Math.min(n - 1, Math.floor(q * (n - 1)))];
}

const flowScale = (s, axis) => Math.max(0.01, (s.flowScale || 1) * (s[`flowScale${axis}`] || 1));

function charsOf(ramp) {
    const chars = Array.from(ramp || '');
    return chars.length ? chars : [' '];
}

// ---- Perlin noise (fractal primitives live in lib/noise) ---------------------

class PerlinSource {
    constructor() {
        this.t = 0;
        this.version = 0;
        this.cols = 0;
        this.rows = 0;
        this.field = new Float32Array(0);
        this.fieldKey = '';
        this.levelsKey = '';
        this.lo = 0;
        this.span = 1;
        this.unitX = 1;
        this.unitY = 1 / CHAR_ASPECT;
        this.atStart = false;
    }

    static noiseKey(s) {
        return [s.seed, s.scale, s.octaves, s.persistence, s.lacunarity, s.fractal, s.warp,
            s.evolve, s.offsetX, s.offsetY, s.driftX, s.driftY, s.loopDuration].join('|');
    }

    sync(s, dims) {
        const { cols, rows } = dims;
        this.unitX = dims.unitX;
        this.unitY = dims.unitY;
        if (cols !== this.cols || rows !== this.rows) {
            this.cols = cols;
            this.rows = rows;
            this.field = new Float32Array(cols * rows);
            this.fieldKey = '';
            this.levelsKey = '';
            this.version++;
        }
    }

    // Raw fractal noise at time t, every `stride`-th cell, written into out.
    raw(out, t, s, stride) {
        const d = Math.max(1e-3, s.loopDuration);
        const p = {
            octaves: clamp(Math.round(s.octaves), 1, 10),
            persistence: s.persistence,
            lacunarity: Math.max(1e-3, s.lacunarity),
            loopCells: Math.max(1, Math.round(s.evolve * d)),
        };
        const phase = wrap(t / d, 1);
        const scale = Math.max(1e-3, s.scale);
        const seed = s.seed | 0;
        const kind = FRACTAL_KIND[s.fractal] || 0;
        const ox = s.offsetX + s.driftX * t;
        const oy = s.offsetY + s.driftY * t;
        let k = 0;
        for (let r = 0; r < this.rows; r += stride) {
            const by = (r * this.unitY) / scale + oy;
            for (let c = 0; c < this.cols; c += stride) {
                let x = (c * this.unitX) / scale + ox;
                let y = by;
                if (s.warp) {
                    const qx = fractalNoise(x + 5.2, y + 1.3, phase, p, seed + 101, 0);
                    const qy = fractalNoise(x + 1.7, y + 9.2, phase, p, seed + 202, 0);
                    x += s.warp * qx;
                    y += s.warp * qy;
                }
                out[k++] = fractalNoise(x, y, phase, p, seed, kind);
            }
        }
        return k;
    }

    // Fix the levels from a handful of frames around the loop so brightness
    // doesn't pump from frame to frame.
    ensureLevels(s) {
        const key = `${PerlinSource.noiseKey(s)}|${this.cols}|${this.rows}|${this.unitX}|${this.unitY}`;
        if (key === this.levelsKey) return;
        this.levelsKey = key;
        const stride = Math.max(1, Math.ceil(Math.sqrt((this.cols * this.rows) / 10000)));
        const per = Math.ceil(this.cols / stride) * Math.ceil(this.rows / stride);
        const samples = new Float32Array(per * 6);
        let n = 0;
        const buf = new Float32Array(per);
        for (let i = 0; i < 6; i++) {
            const got = this.raw(buf, (i / 6) * Math.max(1e-3, s.loopDuration), s, stride);
            samples.set(buf.subarray(0, got), n);
            n += got;
        }
        const sorted = samples.subarray(0, n).sort();
        this.lo = sorted[Math.floor(0.01 * (n - 1))];
        const hi = sorted[Math.floor(0.99 * (n - 1))];
        this.span = Math.max(hi - this.lo, 1e-9);
    }

    fieldAt(out, t, s) {
        this.ensureLevels(s);
        this.raw(out, t, s, 1);
        const { lo, span } = this;
        for (let i = 0; i < out.length; i++) out[i] = clamp((out[i] - lo) / span, 0, 1);
        return out;
    }

    getField(s) {
        const key = `${PerlinSource.noiseKey(s)}|${this.t}|${this.cols}|${this.rows}|${this.unitX}|${this.unitY}`;
        if (key !== this.fieldKey) {
            this.fieldKey = key;
            this.fieldAt(this.field, this.t, s);
        }
        return this.field;
    }

    advance(elapsed, rate) {
        if (!rate || !elapsed) return;
        this.t += rate * elapsed;
        this.version++;
    }

    stepFrame(dir) {
        this.t += dir / 24;
        this.version++;
    }

    seek(v, s) {
        const d = Math.max(1e-3, s.loopDuration);
        this.t = Math.floor(this.t / d) * d + v;
        this.version++;
    }

    reset() {
        this.t = 0;
        this.version++;
    }

    timeline(s) {
        const d = Math.max(1e-3, s.loopDuration);
        const value = wrap(this.t, d);
        return { value, min: 0, max: d, label: `${value.toFixed(1)}s`, warming: false };
    }
}

// ---- Fluid simulation --------------------------------------------------------

function makeFftTable(n) {
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
        cos[i] = Math.cos((TWO_PI * i) / n);
        sin[i] = Math.sin((TWO_PI * i) / n);
    }
    return { n, rev, cos, sin };
}

// In-place radix-2 FFT of the first tab.n entries, numpy conventions
// (forward unnormalised, inverse divides by n).
function fft1d(tab, re, im, inverse) {
    const { n, rev, cos, sin } = tab;
    for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
            for (let j = 0; j < half; j++) {
                const c = cos[j * step];
                const s = sgn * sin[j * step];
                const a = start + j;
                const b = a + half;
                const tr = re[b] * c + im[b] * s;
                const ti = im[b] * c - re[b] * s;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
    if (inverse) {
        const k = 1 / n;
        for (let i = 0; i < n; i++) {
            re[i] *= k;
            im[i] *= k;
        }
    }
}

// Bilinear lookup of field at fractional grid coordinates, wrapping at the edges.
function samplePeriodic(f, nx, ny, gx, gy) {
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const i0 = wrap(x0, nx);
    const j0 = wrap(y0, ny);
    const i1 = i0 + 1 === nx ? 0 : i0 + 1;
    const j1 = j0 + 1 === ny ? 0 : j0 + 1;
    const top = f[j0 * nx + i0] * (1 - fx) + f[j0 * nx + i1] * fx;
    const bottom = f[j1 * nx + i0] * (1 - fx) + f[j1 * nx + i1] * fx;
    return top * (1 - fy) + bottom * fy;
}

/*
 * 2D incompressible Navier-Stokes in vorticity form on a periodic domain:
 *
 *     dw/dt + (u . grad) w = nu lap(w) - mu w + f,   u = curl(psi),  lap(psi) = -w
 *
 * Pseudo-spectral with 2/3 dealiasing and integrating-factor RK4, exactly as
 * the python tool. The domain is 2*pi wide with height set by the aspect
 * ratio; both grid sizes are powers of two, so cells may be slightly
 * non-square. f is band-limited around wavenumber forceK and wanders as an
 * Ornstein-Uhlenbeck process so the flow never settles.
 */
class FluidSolver {
    constructor(nx, ny, aspect, s, rng) {
        this.nx = nx;
        this.ny = ny;
        this.N = nx * ny;
        this.rng = rng;
        this.dx = TWO_PI / nx;
        this.dy = (TWO_PI * aspect) / ny;
        this.tabX = makeFftTable(nx);
        this.tabY = makeFftTable(ny);
        const m = Math.max(nx, ny);
        this.bufRe = new Float64Array(m);
        this.bufIm = new Float64Array(m);

        // wavenumbers; the derivative versions drop the unpaired Nyquist mode
        this.dkx = new Float64Array(nx);
        this.dky = new Float64Array(ny);
        const kx = new Float64Array(nx);
        const ky = new Float64Array(ny);
        for (let i = 0; i < nx; i++) {
            const idx = i < nx / 2 ? i : i - nx;
            kx[i] = idx;
            this.dkx[i] = i === nx / 2 ? 0 : idx;
        }
        for (let j = 0; j < ny; j++) {
            const idx = j < ny / 2 ? j : j - ny;
            ky[j] = idx / aspect;
            this.dky[j] = j === ny / 2 ? 0 : idx / aspect;
        }

        const alloc = () => new Float64Array(this.N);
        this.k2 = alloc();
        this.invK2 = alloc();
        this.dealias = alloc();
        for (let j = 0; j < ny; j++) {
            const jIdx = j < ny / 2 ? j : j - ny;
            for (let i = 0; i < nx; i++) {
                const iIdx = i < nx / 2 ? i : i - nx;
                const idx = j * nx + i;
                const k2 = kx[i] * kx[i] + ky[j] * ky[j];
                this.k2[idx] = k2;
                this.invK2[idx] = k2 > 0 ? 1 / k2 : 0;
                this.dealias[idx] = (Math.abs(iIdx) < nx / 3 && Math.abs(jIdx) < ny / 3) ? 1 : 0;
            }
        }

        this.wRe = alloc(); this.wIm = alloc();
        this.fRe = alloc(); this.fIm = alloc();
        this.lin = alloc(); this.half = alloc(); this.full = alloc();
        this.k1Re = alloc(); this.k1Im = alloc();
        this.k2Re = alloc(); this.k2Im = alloc();
        this.k3Re = alloc(); this.k3Im = alloc();
        this.k4Re = alloc(); this.k4Im = alloc();
        this.tRe = alloc(); this.tIm = alloc();
        this.aRe = alloc(); this.aIm = alloc();
        this.bRe = alloc(); this.bIm = alloc();
        this.cRe = alloc(); this.cIm = alloc();
        this.dRe = alloc(); this.dIm = alloc();
        this.pRe = alloc(); this.pIm = alloc();
        this.u = alloc();
        this.v = alloc();
        this.band = alloc();
        this.forceK = null;
        this.force = 0;
        this.bandRmsValue = 0;
        this.forceScale = 0;

        this.setParams(s);

        // start from random eddies at the forcing scale with rms speed ~1
        this.bandNoise(this.wRe, this.wIm);
        const w0 = this.bandRmsValue > 0 ? s.forceK / this.bandRmsValue : 0;
        for (let i = 0; i < this.N; i++) {
            this.wRe[i] *= w0;
            this.wIm[i] *= w0;
        }
        this.computeVelocity();
    }

    setParams(s) {
        this.tau = Math.max(1e-3, s.forceTau);
        for (let i = 0; i < this.N; i++) this.lin[i] = s.viscosity * this.k2[i] + s.drag;

        if (s.forceK !== this.forceK) {
            this.forceK = s.forceK;
            const { nx, ny } = this;
            const idx = [];
            const partner = [];
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    if (Math.abs(Math.sqrt(this.k2[j * nx + i]) - s.forceK) > 1) continue;
                    idx.push(j * nx + i);
                    partner.push(((ny - j) % ny) * nx + ((nx - i) % nx));
                }
            }
            this.bandIdx = Int32Array.from(idx);
            this.bandPartner = Int32Array.from(partner);
            // Parseval: unit white noise band-passed to m of N modes has rms sqrt(m / N)
            this.bandRmsValue = Math.sqrt(idx.length / this.N);
            this.force = s.force;
            this.forceScale = this.bandRmsValue > 0 ? s.force / this.bandRmsValue : 0;
            this.bandNoise(this.fRe, this.fIm);
            for (let i = 0; i < this.N; i++) {
                this.fRe[i] *= this.forceScale;
                this.fIm[i] *= this.forceScale;
            }
        } else if (s.force !== this.force) {
            const next = this.bandRmsValue > 0 ? s.force / this.bandRmsValue : 0;
            if (this.forceScale > 0) {
                const r = next / this.forceScale;
                for (let i = 0; i < this.N; i++) {
                    this.fRe[i] *= r;
                    this.fIm[i] *= r;
                }
            } else {
                this.bandNoise(this.fRe, this.fIm);
                for (let i = 0; i < this.N; i++) {
                    this.fRe[i] *= next;
                    this.fIm[i] *= next;
                }
            }
            this.force = s.force;
            this.forceScale = next;
        }
    }

    fft2(re, im, inverse) {
        const { nx, ny, bufRe, bufIm } = this;
        for (let j = 0; j < ny; j++) {
            const o = j * nx;
            for (let i = 0; i < nx; i++) {
                bufRe[i] = re[o + i];
                bufIm[i] = im[o + i];
            }
            fft1d(this.tabX, bufRe, bufIm, inverse);
            for (let i = 0; i < nx; i++) {
                re[o + i] = bufRe[i];
                im[o + i] = bufIm[i];
            }
        }
        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
                bufRe[j] = re[j * nx + i];
                bufIm[j] = im[j * nx + i];
            }
            fft1d(this.tabY, bufRe, bufIm, inverse);
            for (let j = 0; j < ny; j++) {
                re[j * nx + i] = bufRe[j];
                im[j * nx + i] = bufIm[j];
            }
        }
    }

    // Spectrum of unit white noise band-passed to the forcing band, drawn
    // directly in spectral space (conjugate-symmetric, so its inverse is
    // real) instead of transforming a real-space noise field every step.
    bandNoise(re, im) {
        re.fill(0);
        im.fill(0);
        const { bandIdx, bandPartner, rng } = this;
        const sd = Math.sqrt(this.N / 2);
        for (let b = 0; b < bandIdx.length; b++) {
            const i = bandIdx[b];
            const p = bandPartner[b];
            if (p === i) {
                re[i] = rng.gauss() * sd * Math.SQRT2;
            } else if (p > i) {
                const r = rng.gauss() * sd;
                const m = rng.gauss() * sd;
                re[i] = r;
                im[i] = m;
                re[p] = r;
                im[p] = -m;
            }
        }
    }

    computeVelocity() {
        const { nx, ny, dkx, dky, invK2, wRe, wIm } = this;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const idx = j * nx + i;
                const inv = invK2[idx];
                this.aRe[idx] = -dky[j] * wIm[idx] * inv;
                this.aIm[idx] = dky[j] * wRe[idx] * inv;
                this.bRe[idx] = dkx[i] * wIm[idx] * inv;
                this.bIm[idx] = -dkx[i] * wRe[idx] * inv;
            }
        }
        this.fft2(this.aRe, this.aIm, true);
        this.fft2(this.bRe, this.bIm, true);
        this.u.set(this.aRe);
        this.v.set(this.bRe);
    }

    // Right-hand side in spectral space. With capture, u / v receive the
    // velocity of the input state.
    rhs(wRe, wIm, outRe, outIm, capture) {
        const { nx, ny, dkx, dky, invK2, dealias, N } = this;
        const { aRe, aIm, bRe, bIm, cRe, cIm, dRe, dIm, pRe, pIm } = this;
        for (let j = 0; j < ny; j++) {
            const ky = dky[j];
            for (let i = 0; i < nx; i++) {
                const idx = j * nx + i;
                const kx = dkx[i];
                const r = wRe[idx];
                const m = wIm[idx];
                const inv = invK2[idx];
                // u = i ky psi, v = -i kx psi, wx = i kx w, wy = i ky w
                aRe[idx] = -ky * m * inv; aIm[idx] = ky * r * inv;
                bRe[idx] = kx * m * inv; bIm[idx] = -kx * r * inv;
                cRe[idx] = -kx * m; cIm[idx] = kx * r;
                dRe[idx] = -ky * m; dIm[idx] = ky * r;
            }
        }
        this.fft2(aRe, aIm, true);
        this.fft2(bRe, bIm, true);
        this.fft2(cRe, cIm, true);
        this.fft2(dRe, dIm, true);
        for (let i = 0; i < N; i++) {
            pRe[i] = aRe[i] * cRe[i] + bRe[i] * dRe[i];
            pIm[i] = 0;
        }
        this.fft2(pRe, pIm, false);
        const { fRe, fIm } = this;
        for (let i = 0; i < N; i++) {
            outRe[i] = fRe[i] - pRe[i] * dealias[i];
            outIm[i] = fIm[i] - pIm[i] * dealias[i];
        }
        if (capture) {
            this.u.set(aRe);
            this.v.set(bRe);
        }
    }

    // Advance by dt; u / v end up holding the velocity at the start of the step.
    step(dt) {
        const { N, lin, half, full, wRe, wIm, tRe, tIm } = this;
        const { k1Re, k1Im, k2Re, k2Im, k3Re, k3Im, k4Re, k4Im } = this;
        for (let i = 0; i < N; i++) {
            const h = Math.exp(-lin[i] * 0.5 * dt);
            half[i] = h;
            full[i] = h * h;
        }
        // RK4 rather than RK2: RK2 amplifies pure advection every step,
        // which blows up the smallest eddies
        this.rhs(wRe, wIm, k1Re, k1Im, true);
        for (let i = 0; i < N; i++) {
            tRe[i] = half[i] * (wRe[i] + 0.5 * dt * k1Re[i]);
            tIm[i] = half[i] * (wIm[i] + 0.5 * dt * k1Im[i]);
        }
        this.rhs(tRe, tIm, k2Re, k2Im, false);
        for (let i = 0; i < N; i++) {
            tRe[i] = half[i] * wRe[i] + 0.5 * dt * k2Re[i];
            tIm[i] = half[i] * wIm[i] + 0.5 * dt * k2Im[i];
        }
        this.rhs(tRe, tIm, k3Re, k3Im, false);
        for (let i = 0; i < N; i++) {
            tRe[i] = full[i] * wRe[i] + dt * half[i] * k3Re[i];
            tIm[i] = full[i] * wIm[i] + dt * half[i] * k3Im[i];
        }
        this.rhs(tRe, tIm, k4Re, k4Im, false);
        const d6 = dt / 6;
        for (let i = 0; i < N; i++) {
            const d = this.dealias[i];
            wRe[i] = (full[i] * wRe[i] + d6 * (full[i] * k1Re[i] + 2 * half[i] * (k2Re[i] + k3Re[i]) + k4Re[i])) * d;
            wIm[i] = (full[i] * wIm[i] + d6 * (full[i] * k1Im[i] + 2 * half[i] * (k2Im[i] + k3Im[i]) + k4Im[i])) * d;
        }

        const a = Math.exp(-dt / this.tau);
        const b = Math.sqrt(1 - a * a) * this.forceScale;
        if (b > 0 || a < 1) {
            this.bandNoise(tRe, tIm);
            for (let i = 0; i < N; i++) {
                this.fRe[i] = a * this.fRe[i] + b * tRe[i];
                this.fIm[i] = a * this.fIm[i] + b * tIm[i];
            }
        }
    }

    maxSpeed() {
        let m = 0;
        for (let i = 0; i < this.N; i++) {
            const s = this.u[i] * this.u[i] + this.v[i] * this.v[i];
            if (s > m) m = s;
        }
        return Math.sqrt(m);
    }

    vorticity(out) {
        this.tRe.set(this.wRe);
        this.tIm.set(this.wIm);
        this.fft2(this.tRe, this.tIm, true);
        for (let i = 0; i < this.N; i++) out[i] = this.tRe[i];
    }
}

// (nOut) lists of [inIndex, weight] that box-filter nIn samples down to nOut.
function areaWeights(nIn, nOut) {
    const out = [];
    for (let o = 0; o < nOut; o++) {
        const a = (o * nIn) / nOut;
        const b = ((o + 1) * nIn) / nOut;
        const list = [];
        for (let i = Math.floor(a); i < Math.ceil(b); i++) {
            const w = Math.min(b, i + 1) - Math.max(a, i);
            if (w > 0) list.push([i, w / (b - a)]);
        }
        out.push(list);
    }
    return out;
}

// Rounded down: every doubling of the sim grid roughly triples the cost of a step.
function floorPow2(v) {
    return 2 ** Math.floor(Math.log2(Math.max(1, v)));
}

class FluidSource {
    constructor() {
        this.version = 0;
        this.solver = null;
        this.simKey = '';
        this.paramKey = '';
        this.resetRequested = false;
        this.cols = 0;
        this.rows = 0;
        this.ss = 0;
        this.field = new Float32Array(0);
        this.raw = new Float32Array(0);
        this.scratch = new Float32Array(0);
        this.trail = new Float32Array(0);
        this.px = new Float64Array(0);
        this.py = new Float64Array(0);
        this.frames = [];
        this.clocks = [];
        this.refs = [];
        this.headClock = 0;
        this.viewClock = 0;
        this.viewIdx = -1;
        this.reference = null;
        this.warmupLeft = 0;
        this.weightsKey = '';
        this.atStart = false;
    }

    sync(s, dims) {
        const { cols, rows } = dims;
        const aspect = rows / (cols * dims.cellAspect);
        const nx = s.grid;
        const ny = clamp(floorPow2(nx * aspect), 16, 1024);
        const simKey = `${s.seed}|${nx}|${ny}`;
        if (!this.solver || simKey !== this.simKey || this.resetRequested) {
            this.simKey = simKey;
            this.reinit(s, nx, ny, aspect);
        }

        const paramKey = [s.viscosity, s.drag, s.force, s.forceK, s.forceTau].join('|');
        if (paramKey !== this.paramKey) {
            this.paramKey = paramKey;
            this.solver.setParams(s);
        }

        let ss = clamp(Math.round(s.supersample), 1, 8);
        while (ss > 1 && cols * rows * ss * ss > MAX_TRAIL_CELLS) ss--;
        if (cols !== this.cols || rows !== this.rows || ss !== this.ss) {
            this.cols = cols;
            this.rows = rows;
            this.ss = ss;
            this.field = new Float32Array(cols * rows);
            this.raw = new Float32Array(cols * rows);
            this.scratch = new Float32Array(20000);
            this.trail = new Float32Array(cols * ss * rows * ss);
            this.clearHistory();
        }

        this.resizeParticles(clamp(Math.round(s.particles), 1, 20000));
    }

    reinit(s, nx, ny, aspect) {
        this.rng = makeRng(((s.seed | 0) * 7919) + 17);
        this.solver = new FluidSolver(nx, ny, aspect, s, this.rng);
        this.paramKey = [s.viscosity, s.drag, s.force, s.forceK, s.forceTau].join('|');
        this.px = new Float64Array(0);
        this.py = new Float64Array(0);
        this.trail.fill(0);
        this.reference = null;
        this.clearHistory();
        this.warmupLeft = s.simSpeed > 0 ? Math.max(0, s.warmup) * s.simSpeed : 0;
        this.resetRequested = false;
    }

    resizeParticles(n) {
        if (n === this.px.length) return;
        const { nx, ny } = this.solver;
        const px = new Float64Array(n);
        const py = new Float64Array(n);
        const keep = Math.min(n, this.px.length);
        px.set(this.px.subarray(0, keep));
        py.set(this.py.subarray(0, keep));
        for (let i = keep; i < n; i++) {
            px[i] = this.rng.next() * nx;
            py[i] = this.rng.next() * ny;
        }
        this.px = px;
        this.py = py;
    }

    clearHistory() {
        this.frames = [];
        this.clocks = [];
        this.refs = [];
        this.headClock = 0;
        this.viewClock = 0;
        this.viewIdx = -1;
        this.field.fill(0);
        this.version++;
    }

    reset() {
        this.resetRequested = true;
    }

    stepSim(simDt, s, particles) {
        const { solver } = this;
        const h = Math.min(solver.dx, solver.dy);
        const substeps = clamp(Math.ceil((simDt * solver.maxSpeed()) / (Math.max(0.05, s.cfl) * h)), 1, 64);
        const dt = simDt / substeps;
        for (let k = 0; k < substeps; k++) {
            solver.step(dt);
            if (particles) this.advect(dt, s);
        }
    }

    // Carry particles through the frozen velocity field (midpoint rule) and
    // draw each path as a line of splats weighted by length, so a streak is
    // equally bright however fast it moves.
    advect(dt, s) {
        const { solver, px, py, trail, cols, rows, ss } = this;
        const { nx, ny, u, v } = solver;
        const cellsX = dt / solver.dx;
        const cellsY = dt / solver.dy;
        const tx = cols * ss;
        const ty = rows * ss;
        // trail pixels per sim cell; a scale > 1 zooms in (splats past the
        // edge are dropped), < 1 repeats the periodic domain across the view
        const sx = (tx / nx) * flowScale(s, 'X');
        const sy = (ty / ny) * flowScale(s, 'Y');
        const periodX = nx * sx;
        const periodY = ny * sy;
        for (let p = 0; p < px.length; p++) {
            const x = px[p];
            const y = py[p];
            const mx = x + 0.5 * cellsX * samplePeriodic(u, nx, ny, x, y);
            const my = y + 0.5 * cellsY * samplePeriodic(v, nx, ny, x, y);
            const stepX = cellsX * samplePeriodic(u, nx, ny, mx, my);
            const stepY = cellsY * samplePeriodic(v, nx, ny, mx, my);
            const segX = stepX * sx;
            const segY = stepY * sy;
            const len = Math.hypot(segX, segY);
            const nSeg = Math.min(32, Math.max(1, Math.ceil(len / 0.75)));
            const w = len / nSeg;
            const bx = x * sx;
            const by = y * sy;
            for (let k = 1; k <= nSeg; k++) {
                const f = k / nSeg;
                const cx0 = wrap(bx + segX * f, periodX);
                for (let cy = wrap(by + segY * f, periodY); cy < ty; cy += periodY) {
                    const row = (cy | 0) * tx;
                    for (let cx = cx0; cx < tx; cx += periodX) trail[row + (cx | 0)] += w;
                }
            }
            px[p] = wrap(x + stepX, nx);
            py[p] = wrap(y + stepY, ny);
        }
    }

    // grid field (ny, nx) -> this.raw (rows, cols)
    resample(src, s) {
        const { solver, cols, rows, raw } = this;
        const { nx, ny } = solver;
        const zx = flowScale(s, 'X');
        const zy = flowScale(s, 'Y');
        if (cols >= nx || zx !== 1 || zy !== 1) {
            for (let r = 0; r < rows; r++) {
                const gy = ((r + 0.5) * ny) / (rows * zy) - 0.5;
                for (let c = 0; c < cols; c++) {
                    raw[r * cols + c] = samplePeriodic(src, nx, ny, ((c + 0.5) * nx) / (cols * zx) - 0.5, gy);
                }
            }
            return;
        }
        const key = `${nx}|${ny}|${cols}|${rows}`;
        if (key !== this.weightsKey) {
            this.weightsKey = key;
            this.rowW = areaWeights(ny, rows);
            this.colW = areaWeights(nx, cols);
            this.tmp = new Float64Array(rows * nx);
        }
        const { rowW, colW, tmp } = this;
        tmp.fill(0);
        for (let o = 0; o < rows; o++) {
            for (const [j, w] of rowW[o]) {
                for (let i = 0; i < nx; i++) tmp[o * nx + i] += w * src[j * nx + i];
            }
        }
        for (let o = 0; o < rows; o++) {
            for (let c = 0; c < cols; c++) {
                let sum = 0;
                for (const [i, w] of colW[c]) sum += w * tmp[o * nx + i];
                raw[o * cols + c] = sum;
            }
        }
    }

    // Simulate one displayed frame covering videoDt seconds of playback and
    // push it onto the rewind buffer.
    simulateFrame(videoDt, s) {
        const { solver, cols, rows, ss, raw } = this;
        const simDt = videoDt * s.simSpeed;
        const trails = s.render === 'trails';

        if (trails) {
            const k = Math.exp(-videoDt / Math.max(1e-3, s.fade));
            const { trail } = this;
            for (let i = 0; i < trail.length; i++) trail[i] *= k;
        }
        if (simDt > 0) this.stepSim(simDt, s, trails);

        if (trails) {
            const respawn = 1 - Math.exp(-Math.max(0, s.respawn) * videoDt);
            for (let p = 0; p < this.px.length; p++) {
                if (this.rng.next() < respawn) {
                    this.px[p] = this.rng.next() * solver.nx;
                    this.py[p] = this.rng.next() * solver.ny;
                }
            }
            const tx = cols * ss;
            const norm = 1 / (ss * ss);
            const { trail } = this;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    let sum = 0;
                    for (let y = 0; y < ss; y++) {
                        const o = (r * ss + y) * tx + c * ss;
                        for (let x = 0; x < ss; x++) sum += trail[o + x];
                    }
                    raw[r * cols + c] = sum * norm;
                }
            }
        } else {
            const grid = solver.tRe;
            if (s.render === 'vorticity') {
                solver.vorticity(grid);
                for (let i = 0; i < solver.N; i++) grid[i] = Math.abs(grid[i]);
            } else {
                for (let i = 0; i < solver.N; i++) grid[i] = Math.hypot(solver.u[i], solver.v[i]);
            }
            this.resample(grid, s);
        }

        // brightness is normalised by a slow moving average of the frame's
        // 99th percentile, so sparse trails keep a dark background
        const peak = percentile(raw, 0.99, this.scratch);
        const smoothing = 1 - Math.exp(-videoDt / 2);
        this.reference = this.reference === null ? peak : this.reference + smoothing * (peak - this.reference);

        const cap = clamp(Math.floor(HISTORY_BYTES / (raw.length * 4)), 2, 4000);
        let buf;
        if (this.frames.length >= cap) {
            buf = this.frames.shift();
            this.clocks.shift();
            this.refs.shift();
        } else {
            buf = new Float32Array(raw.length);
        }
        buf.set(raw);
        this.headClock += videoDt;
        this.frames.push(buf);
        this.clocks.push(this.headClock);
        this.refs.push(this.reference);
        this.viewClock = this.headClock;
        this.viewIdx = this.frames.length - 1;
        this.version++;
    }

    showAt(clock) {
        const { clocks } = this;
        let lo = 0;
        let hi = clocks.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (clocks[mid] <= clock) lo = mid; else hi = mid - 1;
        }
        if (lo !== this.viewIdx) {
            this.viewIdx = lo;
            this.version++;
        }
    }

    advance(elapsed, rate, s) {
        if (this.warmupLeft > 0) {
            const start = performance.now();
            while (this.warmupLeft > 0 && performance.now() - start < 14) {
                const chunk = Math.min(this.warmupLeft, s.simSpeed / 24);
                this.stepSim(chunk, s, false);
                this.warmupLeft -= chunk;
            }
            if (this.warmupLeft <= 0) this.simulateFrame(1 / 60, s);
            return;
        }
        if (!rate || !elapsed) return;

        const n = this.frames.length;
        if (rate > 0) {
            if (n && this.viewIdx < n - 1) {
                // replaying the rewind buffer back up to the live head
                this.viewClock = Math.min(this.headClock, this.viewClock + rate * elapsed);
                this.showAt(this.viewClock);
                return;
            }
            this.simulateFrame(rate * elapsed, s);
            return;
        }
        if (!n) return;
        this.viewClock = Math.max(this.clocks[0], this.viewClock + rate * elapsed);
        if (this.viewClock <= this.clocks[0]) this.atStart = true;
        this.showAt(this.viewClock);
    }

    stepFrame(dir, s) {
        if (this.warmupLeft > 0) return;
        const n = this.frames.length;
        if (dir > 0) {
            if (n && this.viewIdx < n - 1) {
                this.viewIdx++;
                this.viewClock = this.clocks[this.viewIdx];
                this.version++;
            } else {
                this.simulateFrame(1 / 24, s);
            }
        } else if (this.viewIdx > 0) {
            this.viewIdx--;
            this.viewClock = this.clocks[this.viewIdx];
            this.version++;
        }
    }

    seek(v) {
        if (!this.frames.length) return;
        this.viewClock = clamp(v, this.clocks[0], this.headClock);
        this.showAt(this.viewClock);
    }

    getField(s) {
        const { field } = this;
        if (this.viewIdx < 0) {
            field.fill(0);
            return field;
        }
        const src = this.frames[this.viewIdx];
        const ref = this.refs[this.viewIdx];
        if (!(ref > 0)) {
            field.fill(0);
            return field;
        }
        const k = s.exposure / ref;
        for (let i = 0; i < field.length; i++) field[i] = 1 - Math.exp(-k * src[i]);
        return field;
    }

    timeline() {
        const n = this.frames.length;
        if (this.warmupLeft > 0 || !n) {
            return { value: 0, min: 0, max: 0, label: 'warm-up', warming: true };
        }
        const live = this.viewIdx >= n - 1;
        return {
            value: this.viewClock,
            min: this.clocks[0],
            max: this.headClock,
            label: live ? 'live' : `${(this.viewClock - this.headClock).toFixed(1)}s`,
            warming: false,
            buffer: this.headClock - this.clocks[0],
        };
    }
}

// ---- Tone, colour & rendering ------------------------------------------------

function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0xd4d4d4;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// K colours sampled evenly along the gradient (or just the foreground).
function paletteFor(s, K) {
    if (s.colorMode !== 'gradient' || !s.stops.length) return [s.foreground];
    const stops = s.stops.map(hexToRgb);
    if (stops.length === 1) return [s.stops[0]];
    const out = [];
    for (let k = 0; k < K; k++) {
        const t = K === 1 ? 0 : k / (K - 1);
        const pos = t * (stops.length - 1);
        const i = Math.min(stops.length - 2, Math.floor(pos));
        const f = pos - i;
        const a = stops[i];
        const b = stops[i + 1];
        out.push(rgbToHex([0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f))));
    }
    return out;
}

// Brightness / contrast / gamma / invert on the 0-1 field.
function toneField(field, s, out) {
    const g = s.gamma > 0 ? s.gamma : 1;
    for (let i = 0; i < field.length; i++) {
        let v = (field[i] - 0.5) * s.contrast + 0.5 + s.brightness;
        if (!(v > 0)) v = 0; else if (v > 1) v = 1;
        if (g !== 1) v **= g;
        out[i] = s.invert ? 1 - v : v;
    }
    return out;
}

const ditherBuffer = (cols, rows) => new Float32Array(cols * rows + 2 * cols + 2);

// Quantize toned values to `levels` steps (character or colour indices).
// Without dithering values split evenly into bins, like the python tool;
// with dithering each cell rounds to the nearest level after a Bayer
// threshold or diffused error from its neighbours.
function quantize(toned, cols, rows, levels, dither, out, err) {
    const n = cols * rows;
    const top = levels - 1;
    if (top <= 0) {
        out.fill(0, 0, n);
        return;
    }
    if (dither === 'bayer') {
        for (let r = 0; r < rows; r++) {
            const b = (r & 7) * 8;
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const q = Math.floor(toned[i] * top + BAYER8[b + (c & 7)]);
                out[i] = q < 0 ? 0 : (q > top ? top : q);
            }
        }
    } else if (dither === 'floyd' || dither === 'atkinson') {
        const floyd = dither === 'floyd';
        err.fill(0);
        for (let r = 0; r < rows; r++) {
            const down = r + 1 < rows;
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const e = toned[i] * top + err[i];
                let q = Math.round(e);
                q = q < 0 ? 0 : (q > top ? top : q);
                out[i] = q;
                const d = e - q;
                const right = c + 1 < cols;
                if (floyd) {
                    if (right) err[i + 1] += d * 0.4375;
                    if (down) {
                        if (c > 0) err[i + cols - 1] += d * 0.1875;
                        err[i + cols] += d * 0.3125;
                        if (right) err[i + cols + 1] += d * 0.0625;
                    }
                } else {
                    const a = d * 0.125;
                    if (right) err[i + 1] += a;
                    if (c + 2 < cols) err[i + 2] += a;
                    if (down) {
                        if (c > 0) err[i + cols - 1] += a;
                        err[i + cols] += a;
                        if (right) err[i + cols + 1] += a;
                        if (r + 2 < rows) err[i + 2 * cols] += a;
                    }
                }
            }
        }
    } else {
        for (let i = 0; i < n; i++) {
            const q = (toned[i] * levels) | 0;
            out[i] = q > top ? top : q;
        }
    }
}

// Continuous colour bucket per cell for the ascii gradient.
function colorBuckets(toned, s, K, out) {
    for (let i = 0; i < toned.length; i++) {
        const cp = s.reverseGradient ? 1 - toned[i] : toned[i];
        const b = (cp * K) | 0;
        out[i] = b >= K ? K - 1 : b;
    }
}

function asciiCells(field, s, cols, rows, charCount, K) {
    const n = cols * rows;
    const toned = toneField(field, s, new Float32Array(n));
    const charIdx = new Uint16Array(n);
    const colorIdx = new Uint8Array(n);
    quantize(toned, cols, rows, charCount, s.dither, charIdx, ditherBuffer(cols, rows));
    colorBuckets(toned, s, K, colorIdx);
    return { charIdx, colorIdx };
}

const pixelLevelCount = (s) => clamp(Math.round(s.levels) || 2, 2, 256);

// Pixel palette: `levels` colours along the gradient, or from background to
// foreground in solid mode. rgba holds little-endian ImageData pixels.
function pixelPalette(s, levels) {
    let stops = s.colorMode === 'gradient' && s.stops.length ? s.stops : [s.background, s.foreground];
    if (stops.length === 1) stops = [stops[0], stops[0]];
    const hex = paletteFor({ colorMode: 'gradient', stops }, levels);
    if (s.reverseGradient && s.colorMode === 'gradient') hex.reverse();
    const rgba = new Uint32Array(hex.length);
    hex.forEach((h, i) => {
        const [r, g, b] = hexToRgb(h);
        rgba[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    });
    return { hex, rgba };
}

function pixelLevels(field, s, cols, rows, levels) {
    const n = cols * rows;
    const out = new Uint16Array(n);
    quantize(toneField(field, s, new Float32Array(n)), cols, rows, levels, s.dither, out, ditherBuffer(cols, rows));
    return out;
}

// Writes one ImageData pixel per cell into a cached cols x rows canvas.
function paintPixels(cache, levels, rgba, cols, rows) {
    if (!cache.canvas || cache.canvas.width !== cols || cache.canvas.height !== rows) {
        cache.canvas = document.createElement('canvas');
        cache.canvas.width = cols;
        cache.canvas.height = rows;
        cache.ctx = cache.canvas.getContext('2d');
        cache.img = cache.ctx.createImageData(cols, rows);
        cache.d32 = new Uint32Array(cache.img.data.buffer);
    }
    const { d32 } = cache;
    for (let i = 0; i < d32.length; i++) d32[i] = rgba[levels[i]];
    cache.ctx.putImageData(cache.img, 0, 0);
    return cache.canvas;
}

function renderPixelPng(field, s, cols, rows, W, H) {
    const L = pixelLevelCount(s);
    const small = paintPixels({}, pixelLevels(field, s, cols, rows, L), pixelPalette(s, L).rgba, cols, rows);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, W, H);
    return canvas;
}

// The most common colour becomes the backdrop; every other horizontal run
// of equal pixels is one <rect>.
function renderPixelSvg(field, s, cols, rows, W, H) {
    const L = pixelLevelCount(s);
    const levels = pixelLevels(field, s, cols, rows, L);
    const { hex } = pixelPalette(s, L);
    const counts = new Uint32Array(L);
    for (let i = 0; i < levels.length; i++) counts[levels[i]]++;
    let bg = 0;
    for (let k = 1; k < L; k++) if (counts[k] > counts[bg]) bg = k;
    const cw = W / cols;
    const ch = H / rows;
    const f2 = (n) => String(Math.round(n * 100) / 100);
    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
        `<rect width="${W}" height="${H}" fill="${hex[bg]}"/>`,
    ];
    for (let r = 0; r < rows; r++) {
        let c = 0;
        while (c < cols) {
            const lv = levels[r * cols + c];
            let e = c + 1;
            while (e < cols && levels[r * cols + e] === lv) e++;
            if (lv !== bg) {
                out.push(`<rect x="${f2(c * cw)}" y="${f2(r * ch)}" width="${f2((e - c) * cw)}" height="${f2(ch)}" fill="${hex[lv]}"/>`);
            }
            c = e;
        }
    }
    out.push('</svg>');
    return out.join('\n');
}

function fontSizeFor(cellW, cellH) {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `100px ${FONT_STACK}`;
    const advance = probe.measureText('M').width / 100 || 0.6;
    return Math.max(1, Math.min(cellW / advance, cellH * 0.95));
}

// Pre-rendered (character x colour) glyph sprites for the live preview.
function buildAtlas(chars, s, cellW, cellH) {
    const fontSize = fontSizeFor(cellW, cellW / CHAR_ASPECT);
    const slotW = Math.ceil(cellW) + 2;
    // glyphs keep their size when line spacing is tightened, so they may
    // overhang their row
    const slotH = Math.ceil(Math.max(cellH, fontSize * 1.3)) + 2;
    let K = s.colorMode === 'gradient' ? GRADIENT_BUCKETS : 1;
    // keep the sprite sheet under ~16M px (Safari's canvas area limit)
    while (K > 2 && slotW * slotH * chars.length * K > 16e6) K >>= 1;
    const colors = paletteFor(s, K);
    K = colors.length;
    const total = chars.length * K;
    const perRow = Math.max(1, Math.floor(4096 / slotW));
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(total, perRow) * slotW;
    canvas.height = Math.ceil(total / perRow) * slotH;
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const sx = new Int32Array(total);
    const sy = new Int32Array(total);
    const blank = new Uint8Array(chars.length);
    for (let ci = 0; ci < chars.length; ci++) {
        blank[ci] = chars[ci].trim() === '' ? 1 : 0;
        for (let b = 0; b < K; b++) {
            const slot = ci * K + b;
            sx[slot] = (slot % perRow) * slotW;
            sy[slot] = Math.floor(slot / perRow) * slotH;
            if (blank[ci]) continue;
            ctx.fillStyle = colors[b];
            ctx.fillText(chars[ci], sx[slot] + slotW / 2, sy[slot] + slotH / 2 + fontSize * 0.35);
        }
    }
    return { canvas, slotW, slotH, K, sx, sy, blank };
}

function drawWithAtlas(ctx, W, H, cols, rows, charIdx, colorIdx, atlas, background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    const cw = W / cols;
    const ch = H / rows;
    const { canvas, slotW, slotH, K, sx, sy, blank } = atlas;
    const ox = cw / 2 - slotW / 2;
    const oy = ch / 2 - slotH / 2;
    for (let r = 0; r < rows; r++) {
        const y = Math.round(r * ch + oy);
        const base = r * cols;
        for (let c = 0; c < cols; c++) {
            const i = base + c;
            const ci = charIdx[i];
            if (blank[ci]) continue;
            const slot = ci * K + colorIdx[i];
            ctx.drawImage(canvas, sx[slot], sy[slot], slotW, slotH, Math.round(c * cw + ox), y, slotW, slotH);
        }
    }
}

function frameToText(field, s, cols, rows) {
    const chars = charsOf(s.ramp);
    const idx = new Uint16Array(field.length);
    const toned = toneField(field, s, new Float32Array(field.length));
    quantize(toned, cols, rows, chars.length, s.dither, idx, ditherBuffer(cols, rows));
    const lines = [];
    for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) line += chars[idx[r * cols + c]];
        lines.push(line);
    }
    return lines.join('\n');
}

function renderPngCanvas(field, s, cols, rows, W, H, transparent) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!transparent) {
        ctx.fillStyle = s.background;
        ctx.fillRect(0, 0, W, H);
    }
    const chars = charsOf(s.ramp);
    const colors = paletteFor(s, 64);
    const { charIdx, colorIdx } = asciiCells(field, s, cols, rows, chars.length, colors.length);
    const cw = W / cols;
    const ch = H / rows;
    const fontSize = fontSizeFor(cw, cw / CHAR_ASPECT);
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let current = -1;
    for (let r = 0; r < rows; r++) {
        const y = (r + 0.5) * ch + fontSize * 0.35;
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const glyph = chars[charIdx[i]];
            if (glyph.trim() === '') continue;
            if (colorIdx[i] !== current) {
                current = colorIdx[i];
                ctx.fillStyle = colors[current];
            }
            ctx.fillText(glyph, (c + 0.5) * cw, y);
        }
    }
    return canvas;
}

const escapeXml = (t) => t.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[m]));

// One <text> per row; runs of same-coloured glyphs share a <tspan> whose x
// list pins every character to its grid column.
function renderSvg(field, s, cols, rows, W, H, transparent) {
    const chars = charsOf(s.ramp);
    const colors = paletteFor(s, 64);
    const { charIdx, colorIdx } = asciiCells(field, s, cols, rows, chars.length, colors.length);
    const cw = W / cols;
    const ch = H / rows;
    const fontSize = fontSizeFor(cw, cw / CHAR_ASPECT);
    const f2 = (n) => String(Math.round(n * 100) / 100);

    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    ];
    if (!transparent) out.push(`<rect width="${W}" height="${H}" fill="${s.background}"/>`);
    out.push(`<g font-family="'SF Mono', ui-monospace, Menlo, Monaco, monospace" font-size="${f2(fontSize)}" text-anchor="middle" xml:space="preserve">`);
    for (let r = 0; r < rows; r++) {
        const spans = [];
        let runColor = -1;
        let runText = '';
        let runXs = [];
        const flush = () => {
            if (runText) spans.push(`<tspan x="${runXs.join(' ')}" fill="${colors[runColor]}">${escapeXml(runText)}</tspan>`);
            runText = '';
            runXs = [];
        };
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const glyph = chars[charIdx[i]];
            if (glyph.trim() === '') continue;
            if (colorIdx[i] !== runColor) {
                flush();
                runColor = colorIdx[i];
            }
            runText += glyph;
            runXs.push(f2((c + 0.5) * cw));
        }
        flush();
        if (spans.length) out.push(`<text y="${f2((r + 0.5) * ch + fontSize * 0.35)}">${spans.join('')}</text>`);
    }
    out.push('</g>', '</svg>');
    return out.join('\n');
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Grid size for a W x H device-pixel canvas. unitX / unitY are noise units
// per cell (character widths in ascii mode).
function gridDims(W, H, s) {
    if (s.style === 'pixels') {
        const px = clamp(Math.round(s.pixelSize) || 1, 1, 512);
        const cols = Math.max(1, Math.round(W / px));
        const rows = Math.max(1, Math.round(H / px));
        const cellAspect = (W / cols) / (H / rows);
        const unitX = PIXEL_REF_COLS / cols;
        return { cols, rows, cellAspect, unitX, unitY: unitX / cellAspect };
    }
    const cols = clamp(Math.round(s.columns) || 1, 8, 1000);
    const cellW = W / cols;
    const spacing = clamp(s.lineSpacing || 1, 0.1, 4);
    const rows = Math.max(1, Math.round(H / ((cellW / CHAR_ASPECT) * spacing)));
    const cellAspect = cellW / (H / rows);
    return { cols, rows, cellAspect, unitX: 1, unitY: 1 / cellAspect };
}

// ---- Component ---------------------------------------------------------------

function ProceduralAscii() {
    const [settings, setSettings] = useState(DEFAULTS);
    const [menuOpen, setMenuOpen] = useState(true);
    const [isPlaying, setIsPlaying] = useState(true);
    const [rate, setRate] = useState(1);
    const [status, setStatus] = useState({
        value: 0, min: 0, max: 10, label: '0.0s', warming: false, cols: 0, rows: 0, buffer: 0,
    });

    // Export
    const [exportScale, setExportScale] = useState(2);
    const [transparentBg, setTransparentBg] = useState(false);
    const [loopSeconds, setLoopSeconds] = useState(10);
    const [loopFps, setLoopFps] = useState(24);
    const [loopBlend, setLoopBlend] = useState(1);
    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);

    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const settingsRef = useRef(settings);
    const settingsVersionRef = useRef(0);
    const playingRef = useRef(true);
    const rateRef = useRef(1);
    const engineRef = useRef(null);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    if (!engineRef.current) {
        engineRef.current = { perlin: new PerlinSource(), fluid: new FluidSource(), dims: null };
    }

    useEffect(() => {
        settingsRef.current = settings;
        settingsVersionRef.current += 1;
    }, [settings]);

    useEffect(() => () => {
        exportCanceledRef.current = true;
    }, []);

    const set = (key) => (value) => setSettings((prev) => ({ ...prev, [key]: value }));

    const activeSource = () => {
        const eng = engineRef.current;
        return settingsRef.current.mode === 'fluid' ? eng.fluid : eng.perlin;
    };

    // Preview loop: advance the active source, then redraw only when the
    // frame, settings or canvas size changed.
    useEffect(() => {
        const stage = stageRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const eng = engineRef.current;
        let raf;
        let last = performance.now();
        let lastStatus = 0;
        let drawnKey = '';
        let atlasKey = '';
        let atlas = null;
        let bufKey = '';
        let toned = null;
        let charIdx = null;
        let colorIdx = null;
        let errBuf = null;
        let paletteKey = '';
        let palette = null;
        const pixelCache = {};

        const tick = (now) => {
            raf = requestAnimationFrame(tick);
            const elapsed = Math.min(MAX_TICK_DT, Math.max(0, (now - last) / 1000));
            last = now;
            if (exportingRef.current) return;

            const s = settingsRef.current;
            const dpr = window.devicePixelRatio || 1;
            const W = Math.round(stage.clientWidth * dpr);
            const H = Math.round(stage.clientHeight * dpr);
            if (!W || !H) return;
            if (canvas.width !== W || canvas.height !== H) {
                canvas.width = W;
                canvas.height = H;
            }

            const dims = gridDims(W, H, s);
            const { cols, rows } = dims;
            eng.dims = dims;
            const src = s.mode === 'fluid' ? eng.fluid : eng.perlin;
            src.sync(s, dims);
            src.advance(elapsed, playingRef.current ? rateRef.current : 0, s);
            if (src.atStart) {
                src.atStart = false;
                playingRef.current = false;
                setIsPlaying(false);
            }

            const key = `${s.mode}|${src.version}|${settingsVersionRef.current}|${W}|${H}`;
            if (key !== drawnKey) {
                drawnKey = key;
                if (bufKey !== `${cols}x${rows}`) {
                    bufKey = `${cols}x${rows}`;
                    toned = new Float32Array(cols * rows);
                    charIdx = new Uint16Array(cols * rows);
                    colorIdx = new Uint8Array(cols * rows);
                    errBuf = ditherBuffer(cols, rows);
                }
                toneField(src.getField(s), s, toned);

                if (s.style === 'pixels') {
                    const L = pixelLevelCount(s);
                    const pKey = [L, s.colorMode, s.background, s.foreground, s.stops.join(','), s.reverseGradient].join('|');
                    if (pKey !== paletteKey) {
                        paletteKey = pKey;
                        palette = pixelPalette(s, L);
                    }
                    quantize(toned, cols, rows, L, s.dither, charIdx, errBuf);
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(paintPixels(pixelCache, charIdx, palette.rgba, cols, rows), 0, 0, W, H);
                } else {
                    const chars = charsOf(s.ramp);
                    const cw = W / cols;
                    const ch = H / rows;
                    const aKey = [s.ramp, s.colorMode, s.foreground, s.stops.join(','), Math.round(cw * 100), Math.round(ch * 100)].join('|');
                    if (aKey !== atlasKey) {
                        atlasKey = aKey;
                        atlas = buildAtlas(chars, s, cw, ch);
                    }
                    quantize(toned, cols, rows, chars.length, s.dither, charIdx, errBuf);
                    colorBuckets(toned, s, atlas.K, colorIdx);
                    drawWithAtlas(ctx, W, H, cols, rows, charIdx, colorIdx, atlas, s.background);
                }
            }

            if (now - lastStatus > 100) {
                lastStatus = now;
                const tl = src.timeline(s);
                const next = { buffer: 0, ...tl, value: Math.round(tl.value * 100) / 100, cols, rows };
                setStatus((prev) => (
                    Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next
                ));
            }
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    // ---- Playback -------------------------------------------------------------

    const setPlaying = useCallback((v) => {
        playingRef.current = v;
        setIsPlaying(v);
    }, []);

    const togglePlay = useCallback(() => {
        if (exportingRef.current) return;
        setPlaying(!playingRef.current);
    }, [setPlaying]);

    const setRateValue = useCallback((r) => {
        rateRef.current = r;
        setRate(r);
    }, []);

    const stepFrame = useCallback((dir) => {
        if (exportingRef.current) return;
        setPlaying(false);
        activeSource().stepFrame(dir, settingsRef.current);
    }, [setPlaying]);

    const seek = (v) => {
        if (exportingRef.current) return;
        activeSource().seek(v, settingsRef.current);
    };

    const restart = () => {
        if (exportingRef.current) return;
        activeSource().reset();
    };

    // Space toggles playback, arrows step a frame (ignored while typing).
    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
            if (e.target && e.target.isContentEditable) return;
            if (e.code === 'Space') {
                e.preventDefault();
                togglePlay();
            } else if (e.key === 'ArrowRight') {
                stepFrame(1);
            } else if (e.key === 'ArrowLeft') {
                stepFrame(-1);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, stepFrame]);

    // ---- Exports --------------------------------------------------------------

    const currentFrame = () => {
        const eng = engineRef.current;
        const s = settingsRef.current;
        const { cols, rows } = eng.dims || {};
        return { field: activeSource().getField(s), cols, rows, s };
    };

    const exportSize = () => {
        const stage = stageRef.current;
        return {
            w: Math.max(1, Math.round((stage ? stage.clientWidth : 1280) * exportScale)),
            h: Math.max(1, Math.round((stage ? stage.clientHeight : 720) * exportScale)),
        };
    };

    const exportTxt = () => {
        const { field, cols, rows, s } = currentFrame();
        if (!cols || s.style === 'pixels') return;
        const text = frameToText(field, s, cols, rows);
        downloadBlob(new Blob([text], { type: 'text/plain' }), `${s.mode}_${cols}x${rows}.txt`);
    };

    const exportPng = () => {
        const { field, cols, rows, s } = currentFrame();
        if (!cols) return;
        const { w, h } = exportSize();
        const canvas = s.style === 'pixels'
            ? renderPixelPng(field, s, cols, rows, w, h)
            : renderPngCanvas(field, s, cols, rows, w, h, transparentBg);
        canvas.toBlob((blob) => {
            if (blob) downloadBlob(blob, `${s.mode}_${w}x${h}.png`);
        }, 'image/png');
    };

    const exportSvg = () => {
        const { field, cols, rows, s } = currentFrame();
        if (!cols) return;
        const stage = stageRef.current;
        const w = Math.round(stage.clientWidth);
        const h = Math.round(stage.clientHeight);
        const svg = s.style === 'pixels'
            ? renderPixelSvg(field, s, cols, rows, w, h)
            : renderSvg(field, s, cols, rows, w, h, transparentBg);
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${s.mode}_${cols}x${rows}.svg`);
    };

    // Multi-frame txt in the python tool's format (frames separated by
    // ---FRAME---), for AsciiBackground. Perlin renders one full time loop;
    // fluid simulates forward from the current state and crossfades its end
    // back into its start.
    const exportLoop = useCallback(async () => {
        if (exportingRef.current) return;
        const eng = engineRef.current;
        const s = { ...settingsRef.current };
        const { cols, rows } = eng.dims || {};
        if (!cols || s.style === 'pixels') return;
        const fluid = s.mode === 'fluid';
        if (fluid && eng.fluid.warmupLeft > 0) return;

        const fps = clamp(Math.round(loopFps), 1, 120);
        const seconds = fluid ? loopSeconds : s.loopDuration;
        const n = Math.max(1, Math.round(seconds * fps));
        const blend = fluid ? Math.min(Math.round(loopBlend * fps), Math.floor(n / 2)) : 0;
        const total = n + blend;

        const wasPlaying = playingRef.current;
        setPlaying(false);
        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportProgress(0);

        const texts = [];
        const head = [];
        const buf = new Float32Array(cols * rows);
        const t0 = eng.perlin.t;
        try {
            for (let i = 0; i < total; i++) {
                if (exportCanceledRef.current) break;
                let frame;
                if (fluid) {
                    eng.fluid.simulateFrame(1 / fps, s);
                    frame = Float32Array.from(eng.fluid.getField(s));
                    if (i < blend) {
                        head.push(frame);
                    } else {
                        const k = i - n;
                        if (k >= 0) {
                            const a = (k + 1) / (blend + 1);
                            const h = head[k];
                            for (let j = 0; j < frame.length; j++) frame[j] = (1 - a) * frame[j] + a * h[j];
                        }
                    }
                } else {
                    frame = eng.perlin.fieldAt(buf, t0 + i / fps, s);
                }
                if (i >= blend) texts.push(frameToText(frame, s, cols, rows));

                if (i % 4 === 0) {
                    setExportProgress((i + 1) / total);
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
                }
            }
        } finally {
            exportingRef.current = false;
            setIsExporting(false);
            setExportProgress(0);
            if (wasPlaying) setPlaying(true);
        }

        if (!exportCanceledRef.current && texts.length === n) {
            const text = texts.join(`\n${FRAME_DELIMITER}\n`);
            downloadBlob(new Blob([text], { type: 'text/plain' }), `${s.mode}_loop_${cols}x${rows}_${fps}fps.txt`);
        }
    }, [loopFps, loopSeconds, loopBlend, setPlaying]);

    const cancelExport = useCallback(() => {
        exportCanceledRef.current = true;
    }, []);

    // ---- UI helpers -----------------------------------------------------------

    const numRow = (label, value, onCommit, min, max, step, opts = {}) => (
        <div className={styles.vfx_row} key={label}>
            <span className={styles.vfx_label} title={opts.title || label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={opts.disabled}
                onChange={(e) => onCommit(parseFloat(e.target.value))}
            />
            <VfxNumberField
                value={value}
                min={min}
                max={max}
                step={step}
                disabled={opts.disabled}
                onCommit={onCommit}
            />
        </div>
    );

    const sliderRow = (label, key, min, max, step, opts) => (
        numRow(label, settings[key], (n) => set(key)(opts && opts.int ? Math.round(n) : n), min, max, step, opts)
    );

    const switchRow = (label, value, onToggle) => (
        <div
            className={styles.vfx_checkRow}
            key={label}
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${value ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );

    const segRow = (options, value, onPick, columns) => (
        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${columns || options.length}, 1fr)` }}>
            {options.map(([id, name]) => (
                <button
                    type="button"
                    key={id}
                    className={`${styles.vfx_segBtn} ${value === id ? styles.vfx_segBtnOn : ''}`}
                    onClick={() => onPick(id)}
                >
                    {name}
                </button>
            ))}
        </div>
    );

    const colorRow = (label, value, onChange, trailing) => (
        <div className={styles.vfx_row} key={label}>
            <span className={styles.vfx_label}>{label}</span>
            <input
                type="color"
                className={styles.vfx_color}
                style={{ gridColumn: trailing ? '2 / 3' : '2 / 4' }}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            {trailing}
        </div>
    );

    const buttonStyle = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 };

    const isFluid = settings.mode === 'fluid';
    const isPixels = settings.style === 'pixels';
    const direction = rate < 0 ? -1 : 1;
    const charsetId = (CHARSET_PRESETS.find((p) => p.chars === settings.ramp) || { id: 'custom' }).id;
    const colorPresetId = (COLOR_PRESETS.find((p) => (
        p.background === settings.background
        && p.colorMode === settings.colorMode
        && (p.colorMode === 'solid'
            ? p.foreground === settings.foreground
            : p.stops.join() === settings.stops.join())
    )) || { id: 'custom' }).id;

    const updateStop = (i, color) => set('stops')(settings.stops.map((c, j) => (j === i ? color : c)));
    const removeStop = (i) => set('stops')(settings.stops.filter((_, j) => j !== i));
    const addStop = () => set('stops')([...settings.stops, settings.stops[settings.stops.length - 1] || '#ffffff']);

    const { w: pngW, h: pngH } = stageRef.current ? exportSize() : { w: 0, h: 0 };

    return (
        <div className={styles.vfx}>
            <div ref={stageRef} className={styles.vfx_fullStage}>
                <canvas
                    ref={canvasRef}
                    className={styles.vfx_asciiCanvas}
                    onClick={togglePlay}
                />
            </div>

            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    className={`${styles.vfx_toggle} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {menuOpen && (
                <div className={styles.vfx_panel}>
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Procedural Ascii</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Source */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Source</div>
                        {segRow([['perlin', 'Perlin Noise'], ['fluid', 'Fluid Sim']], settings.mode, set('mode'))}
                        <div style={{ marginBottom: -9 }}>
                            {segRow([['ascii', 'Ascii'], ['pixels', 'Pixels']], settings.style, set('style'))}
                        </div>
                    </div>

                    {/* Playback */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Playback</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 10 }}>
                            <button
                                type="button"
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                className={styles.vfx_iconBtn}
                                onClick={togglePlay}
                                disabled={isExporting}
                                style={{ width: 34, height: 34, flex: '0 0 auto' }}
                            >
                                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <input
                                type="range"
                                className={styles.vfx_slider}
                                min={status.min}
                                max={status.max}
                                step={0.01}
                                value={clamp(status.value, status.min, status.max)}
                                disabled={isExporting || status.warming || status.max <= status.min}
                                onChange={(e) => seek(parseFloat(e.target.value))}
                            />
                            <span className={styles.vfx_value} style={{ flex: '0 0 auto', minWidth: 44 }}>
                                {status.label}
                            </span>
                        </div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                            <button type="button" className={styles.vfx_segBtn} title="Step back" aria-label="Step back" onClick={() => stepFrame(-1)}>
                                <StepBack size={13} />
                            </button>
                            <button
                                type="button"
                                className={`${styles.vfx_segBtn} ${direction < 0 ? styles.vfx_segBtnOn : ''}`}
                                title="Play in reverse"
                                aria-label="Play in reverse"
                                onClick={() => { setRateValue(-Math.abs(rate || 1)); setPlaying(true); }}
                            >
                                <Rewind size={13} />
                            </button>
                            <button
                                type="button"
                                className={`${styles.vfx_segBtn} ${direction > 0 ? styles.vfx_segBtnOn : ''}`}
                                title="Play forward"
                                aria-label="Play forward"
                                onClick={() => { setRateValue(Math.abs(rate || 1)); setPlaying(true); }}
                            >
                                <FastForward size={13} />
                            </button>
                            <button type="button" className={styles.vfx_segBtn} title="Step forward" aria-label="Step forward" onClick={() => stepFrame(1)}>
                                <StepForward size={13} />
                            </button>
                        </div>
                        {numRow('Speed x', rate, setRateValue, -4, 4, 0.05, { title: 'Playback rate; negative plays in reverse' })}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${SPEED_PRESETS.length}, 1fr)`, marginBottom: 0 }}>
                            {SPEED_PRESETS.map((sp) => (
                                <button
                                    type="button"
                                    key={sp}
                                    className={`${styles.vfx_segBtn} ${Math.abs(rate) === sp ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setRateValue(sp * direction)}
                                >
                                    {sp}x
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            {isFluid
                                ? `The flow can't run backwards, so reverse replays a rewind buffer (${(status.buffer || 0).toFixed(1)}s held). Playing forward catches back up to live.`
                                : 'Noise time is exact in both directions. Space = play / pause, arrows = step.'}
                        </div>
                    </div>

                    {/* Grid */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Grid</div>
                        {isPixels
                            ? sliderRow('Pixel Size', 'pixelSize', 1, 64, 1, { int: true, title: 'Screen pixels per cell; 1 = full resolution' })
                            : (
                                <>
                                    {sliderRow('Columns', 'columns', 40, 400, 1, { int: true })}
                                    {sliderRow('Line Space', 'lineSpacing', 0.3, 1.5, 0.01, { title: 'Row height relative to a normal line' })}
                                </>
                            )}
                        {sliderRow('Seed', 'seed', 0, 9999, 1, { int: true })}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 0 }}>
                            <button type="button" className={styles.vfx_segBtn} style={{ gap: 6 }} onClick={() => set('seed')(Math.floor(Math.random() * 10000))}>
                                <Shuffle size={12} />
                                Random Seed
                            </button>
                            <button type="button" className={styles.vfx_segBtn} style={{ gap: 6 }} onClick={restart}>
                                <RotateCcw size={12} />
                                Restart
                            </button>
                        </div>
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            {status.cols} x {status.rows}
                            {isPixels
                                ? ' pixels. 1 = full resolution, which is slow with warped noise or the fluid sim.'
                                : ' characters. Rows follow the viewport and line spacing.'}
                        </div>
                    </div>

                    {/* Perlin parameters */}
                    {!isFluid && (
                        <div className={styles.vfx_section}>
                            <div className={styles.vfx_sectionTitle}>Noise</div>
                            {segRow([['fbm', 'Fbm'], ['turbulence', 'Turbulence'], ['ridged', 'Ridged']], settings.fractal, set('fractal'))}
                            {sliderRow('Scale', 'scale', 2, 200, 0.5, { title: 'Base feature size in character widths' })}
                            {sliderRow('Octaves', 'octaves', 1, 8, 1, { int: true })}
                            {sliderRow('Persistence', 'persistence', 0, 1, 0.01)}
                            {sliderRow('Lacunarity', 'lacunarity', 1, 4, 0.01)}
                            {sliderRow('Warp', 'warp', 0, 6, 0.05, { title: 'Domain warp strength in lattice cells' })}
                            {sliderRow('Evolve', 'evolve', 0, 3, 0.01, { title: 'Lattice cells per second through time' })}
                            {sliderRow('Offset X', 'offsetX', -50, 50, 0.1)}
                            {sliderRow('Offset Y', 'offsetY', -50, 50, 0.1)}
                            {sliderRow('Drift X', 'driftX', -5, 5, 0.01)}
                            {sliderRow('Drift Y', 'driftY', -5, 5, 0.01)}
                            {sliderRow('Loop s', 'loopDuration', 1, 60, 0.5, { title: 'Length of the seamless time loop' })}
                            <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                Fbm: smooth clouds. Turbulence: billowy creases. Ridged: sharp
                                veins. Warp 1-4 gives marbled shapes. Drift breaks the seamless loop.
                            </div>
                        </div>
                    )}

                    {/* Fluid parameters */}
                    {isFluid && (
                        <>
                            <div className={styles.vfx_section}>
                                <div className={styles.vfx_sectionTitle}>Simulation</div>
                                {segRow([[64, '64'], [128, '128'], [256, '256']], settings.grid, set('grid'))}
                                {sliderRow('Scale', 'flowScale', 0.25, 4, 0.01, { title: 'Zoom into (> 1) or tile (< 1) the flow' })}
                                {sliderRow('Scale X', 'flowScaleX', 0.25, 4, 0.01, { title: 'Horizontal scale multiplier' })}
                                {sliderRow('Scale Y', 'flowScaleY', 0.25, 4, 0.01, { title: 'Vertical scale multiplier' })}
                                {sliderRow('Sim Speed', 'simSpeed', 0.05, 3, 0.01, { title: 'Simulation time per second of playback' })}
                                {sliderRow('Viscosity', 'viscosity', 0, 0.005, 0.00005)}
                                {sliderRow('Drag', 'drag', 0, 1, 0.01)}
                                {sliderRow('Force', 'force', 0, 10, 0.1, { title: 'Strength of the stirring force' })}
                                {sliderRow('Force k', 'forceK', 1, 16, 0.5, { title: 'Stirring wavenumber (eddies across the width)' })}
                                {sliderRow('Force tau', 'forceTau', 0.1, 10, 0.1, { title: 'How long the stirring pattern persists' })}
                                {sliderRow('CFL', 'cfl', 0.1, 0.9, 0.01, { title: 'Time step safety factor' })}
                                {sliderRow('Warmup s', 'warmup', 0, 20, 0.5)}
                                <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                    {status.warming ? 'Warming up the flow… ' : ''}
                                    Grid is the simulation resolution (256 is heavy). Scale above 1
                                    zooms into the flow, below 1 tiles its periodic domain. Seed,
                                    grid and warmup take effect on restart.
                                </div>
                            </div>

                            <div className={styles.vfx_section}>
                                <div className={styles.vfx_sectionTitle}>Rendering</div>
                                {segRow([['trails', 'Trails'], ['vorticity', 'Vorticity'], ['speed', 'Speed']], settings.render, set('render'))}
                                {settings.render === 'trails' && (
                                    <>
                                        {sliderRow('Particles', 'particles', 1, 3000, 1, { int: true })}
                                        {sliderRow('Fade s', 'fade', 0.1, 10, 0.1, { title: 'Seconds for a trail to fade to ~37%' })}
                                        {sliderRow('Respawn', 'respawn', 0, 1, 0.01, { title: 'Fraction of particles relocated per second' })}
                                        {sliderRow('Supersample', 'supersample', 1, 6, 1, { int: true })}
                                    </>
                                )}
                                {sliderRow('Exposure', 'exposure', 0.1, 6, 0.05)}
                            </div>
                        </>
                    )}

                    {/* Characters */}
                    {!isPixels && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Characters</div>
                        <select
                            className={styles.vfx_select}
                            style={{ marginBottom: 8 }}
                            value={charsetId}
                            onChange={(e) => {
                                const p = CHARSET_PRESETS.find((c) => c.id === e.target.value);
                                if (p) set('ramp')(p.chars);
                            }}
                        >
                            {CHARSET_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                            {charsetId === 'custom' && <option value="custom">Custom</option>}
                        </select>
                        <input
                            type="text"
                            className={styles.vfx_text}
                            style={{ marginBottom: 10 }}
                            value={settings.ramp}
                            onChange={(e) => set('ramp')(e.target.value)}
                            placeholder="sparse -> dense ramp"
                            spellCheck={false}
                        />
                        {switchRow('Invert (dense <-> sparse)', settings.invert, () => set('invert')(!settings.invert))}
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ textAlign: 'center' }}
                            onClick={() => set('ramp')(Array.from(settings.ramp).reverse().join(''))}
                        >
                            Reverse Character Order
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Characters ordered sparsest to densest; low field values map to
                            the first character.
                        </div>
                    </div>
                    )}

                    {/* Tone */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Tone</div>
                        {sliderRow('Contrast', 'contrast', 0, 4, 0.01)}
                        {sliderRow('Brightness', 'brightness', -1, 1, 0.01)}
                        {sliderRow('Gamma', 'gamma', 0.1, 4, 0.01, { title: '> 1 darkens mid tones, < 1 brightens them' })}
                    </div>

                    {/* Dither */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Dither</div>
                        {segRow([['none', 'None'], ['bayer', 'Bayer'], ['floyd', 'Floyd'], ['atkinson', 'Atkinson']], settings.dither, set('dither'))}
                        {isPixels && sliderRow('Levels', 'levels', 2, 64, 1, { int: true, title: 'Colours sampled from the palette' })}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            {isPixels
                                ? 'Levels is how many colours are taken from the palette. With dithering off, raise it for smooth shading.'
                                : 'Dithers between neighbouring characters of the ramp.'}
                            {' '}Bayer is an ordered pattern; Floyd-Steinberg and Atkinson diffuse error.
                        </div>
                    </div>

                    {/* Colour */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Colour</div>
                        <select
                            className={styles.vfx_select}
                            style={{ marginBottom: 10 }}
                            value={colorPresetId}
                            onChange={(e) => {
                                const p = COLOR_PRESETS.find((c) => c.id === e.target.value);
                                if (!p) return;
                                const { id, name, ...fields } = p;
                                setSettings((prev) => ({ ...prev, ...fields }));
                            }}
                        >
                            {COLOR_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                            {colorPresetId === 'custom' && <option value="custom">Custom</option>}
                        </select>
                        {segRow([['solid', 'Solid'], ['gradient', 'Gradient']], settings.colorMode, set('colorMode'))}
                        {colorRow('Background', settings.background, set('background'))}
                        {settings.colorMode === 'solid' && colorRow(isPixels ? 'Foreground' : 'Text', settings.foreground, set('foreground'))}
                        {settings.colorMode === 'solid' && isPixels && (
                            <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                Pixels blend from the background to the foreground colour.
                            </div>
                        )}
                        {settings.colorMode === 'gradient' && (
                            <>
                                {settings.stops.map((c, i) => colorRow(
                                    i === 0 ? 'Sparse' : (i === settings.stops.length - 1 ? 'Dense' : `Stop ${i + 1}`),
                                    c,
                                    (v) => updateStop(i, v),
                                    <button
                                        type="button"
                                        aria-label="Remove stop"
                                        className={styles.vfx_iconBtn}
                                        style={{ justifySelf: 'end' }}
                                        disabled={settings.stops.length <= 2}
                                        onClick={() => removeStop(i)}
                                    >
                                        <X size={13} />
                                    </button>,
                                ))}
                                <button
                                    type="button"
                                    className={styles.vfx_select}
                                    style={{ ...buttonStyle, margin: '4px 0 10px' }}
                                    disabled={settings.stops.length >= MAX_STOPS}
                                    onClick={addStop}
                                >
                                    <Plus size={13} />
                                    Add Stop
                                </button>
                                {switchRow('Reverse Gradient', settings.reverseGradient, () => set('reverseGradient')(!settings.reverseGradient))}
                                <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                    {isPixels
                                        ? 'The gradient runs from low field values to high (after invert); the background colour is unused.'
                                        : 'The gradient runs from the sparsest character to the densest (after invert); reverse it to light the sparse end instead.'}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export Frame</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                            {[['TXT', exportTxt], ['PNG', exportPng], ['SVG', exportSvg]].map(([name, fn]) => (
                                <button
                                    type="button"
                                    key={name}
                                    className={styles.vfx_select}
                                    style={buttonStyle}
                                    disabled={isExporting || (isPixels && name === 'TXT')}
                                    onClick={fn}
                                >
                                    <Download size={13} />
                                    {name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_row} style={{ gridTemplateColumns: '78px 1fr' }}>
                            <span className={styles.vfx_label}>PNG Scale</span>
                            <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${EXPORT_SCALES.length}, 1fr)`, marginBottom: 0 }}>
                                {EXPORT_SCALES.map((sc) => (
                                    <button
                                        type="button"
                                        key={sc}
                                        className={`${styles.vfx_segBtn} ${exportScale === sc ? styles.vfx_segBtnOn : ''}`}
                                        onClick={() => setExportScale(sc)}
                                    >
                                        {sc}x
                                    </button>
                                ))}
                            </div>
                        </div>
                        {!isPixels && switchRow('Transparent Background', transparentBg, () => setTransparentBg((v) => !v))}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Exports the frame on screen right now. PNG: {pngW} x {pngH} px.
                            {isPixels
                                ? ' SVG draws runs of pixels as rects (large at small pixel sizes).'
                                : ' SVG keeps every glyph as live text.'}
                        </div>
                    </div>

                    {!isPixels && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export Loop</div>
                        {isFluid
                            ? numRow('Duration s', loopSeconds, setLoopSeconds, 1, 60, 0.5, { disabled: isExporting })
                            : null}
                        {numRow('FPS', loopFps, (n) => setLoopFps(Math.round(n)), 6, 60, 1, { disabled: isExporting })}
                        {isFluid && numRow('Blend s', loopBlend, setLoopBlend, 0, 5, 0.1, { disabled: isExporting, title: 'Crossfade from the end back to the start' })}
                        {!isExporting && (
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={buttonStyle}
                                disabled={isFluid && status.warming}
                                onClick={exportLoop}
                            >
                                <Download size={13} />
                                Export Animation (txt)
                            </button>
                        )}
                        {!isExporting && (
                            <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                {isFluid
                                    ? 'Simulates forward from the current state and crossfades the end into the start. Frames are separated by ---FRAME---, ready for AsciiBackground.'
                                    : `Renders one full ${settings.loopDuration}s noise loop (set by Loop s). Frames are separated by ---FRAME---, ready for AsciiBackground.`}
                            </div>
                        )}
                        {isExporting && (
                            <>
                                <div className={styles.vfx_progress} style={{ marginTop: 8 }}>
                                    <div
                                        className={styles.vfx_progressFill}
                                        style={{ width: `${Math.round(exportProgress * 100)}%` }}
                                    />
                                </div>
                                <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                                    Rendering frames · {Math.round(exportProgress * 100)}%
                                </div>
                                <button
                                    type="button"
                                    className={`${styles.vfx_select} ${styles.vfx_recActive}`}
                                    style={{ textAlign: 'center', marginTop: 8 }}
                                    onClick={cancelExport}
                                >
                                    Cancel
                                </button>
                            </>
                        )}
                    </div>
                    )}

                    <div className={styles.vfx_section}>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ textAlign: 'center' }}
                            onClick={() => setSettings(DEFAULTS)}
                        >
                            Reset Defaults
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            Click the preview or press space to play / pause. Type a value
                            next to any slider to override its range.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ProceduralAscii;
