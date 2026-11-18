// The flow field that wisps and flowing points move through: a sum of
// curled waves, so it swirls without bunching things up or thinning them
// out (divergence-free), and changes smoothly over time. Evaluated in
// shaders, from uniforms made here.

import * as THREE from 'three';

export const WAVES = 6;

/** A small seeded PRNG, so the same cloud always moves the same way. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The field's waves as uniforms: wave vectors, curled amplitudes, phases and speeds. */
export function makeFieldUniforms(seed = 7) {
    const r = rng(seed);
    const unit = () => {
        const z = r() * 2 - 1;
        const a = r() * Math.PI * 2;
        const s = Math.sqrt(1 - z * z);
        return new THREE.Vector3(s * Math.cos(a), s * Math.sin(a), z);
    };
    const freqs = [1, 1.63, 2.41, 3.37, 4.93, 7.13];
    const K = [];
    const C = [];
    const PW = [];
    let power = 0;
    freqs.forEach((f) => {
        const k = unit();
        // The curl of sin(k·p) e is cos(k·p) (k × e): flow across the wave.
        const c = k.clone().cross(unit()).normalize().multiplyScalar(f ** -0.8);
        power += c.lengthSq() / 2;
        K.push(k.multiplyScalar(f));
        C.push(c);
        PW.push(new THREE.Vector2(r() * Math.PI * 2, (0.5 + r()) * Math.sqrt(f) * (r() < 0.5 ? -1 : 1)));
    });
    // About unit speed on average, so a strength reads in the scene's units a second.
    const norm = 1 / Math.sqrt(power);
    C.forEach((c) => c.multiplyScalar(norm));
    return { uFK: { value: K }, uFC: { value: C }, uFPW: { value: PW } };
}

/** The field (flowField(p * 1/scale, time)), and hashes for per-point randomness. */
export const FIELD_GLSL = /* glsl */ `
#define FLOW_WAVES ${WAVES}
uniform vec3 uFK[FLOW_WAVES];
uniform vec3 uFC[FLOW_WAVES];
uniform vec2 uFPW[FLOW_WAVES];
vec3 flowField(vec3 p, float t) {
    vec3 v = vec3(0.0);
    for (int i = 0; i < FLOW_WAVES; i++) v += cos(dot(uFK[i], p) + uFPW[i].x + uFPW[i].y * t) * uFC[i];
    return v;
}
vec3 flowHash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}
vec3 flowDir(vec3 r) {
    vec3 d = r * 2.0 - 1.0;
    float l = length(d);
    return l > 1e-4 ? d / l : vec3(0.0, 1.0, 0.0);
}
`;

export const FLOW_DIRS = {
    up: [0, 1, 0], down: [0, -1, 0], right: [1, 0, 0], left: [-1, 0, 0], toward: [0, 0, 1], away: [0, 0, -1],
};

/**
 * Each point's strand for gathering: the middle of the points sharing its
 * cell of side `cell`. `positions` xyz, `count` of them.
 */
export function strandCentres(positions, count, cell) {
    let lo = [Infinity, Infinity, Infinity];
    for (let i = 0; i < count; i++) {
        for (let a = 0; a < 3; a++) lo[a] = Math.min(lo[a], positions[i * 3 + a]);
    }
    if (!Number.isFinite(lo[0])) lo = [0, 0, 0];
    const idx = new Float64Array(count);
    const sums = new Map();
    let nx = 1;
    let ny = 1;
    for (let i = 0; i < count; i++) {
        const ix = Math.floor((positions[i * 3] - lo[0]) / cell);
        const iy = Math.floor((positions[i * 3 + 1] - lo[1]) / cell);
        if (ix + 1 > nx) nx = ix + 1;
        if (iy + 1 > ny) ny = iy + 1;
    }
    for (let i = 0; i < count; i++) {
        const ix = Math.floor((positions[i * 3] - lo[0]) / cell);
        const iy = Math.floor((positions[i * 3 + 1] - lo[1]) / cell);
        const iz = Math.floor((positions[i * 3 + 2] - lo[2]) / cell);
        const key = ix + nx * (iy + ny * iz);
        idx[i] = key;
        let s = sums.get(key);
        if (!s) { s = [0, 0, 0, 0]; sums.set(key, s); }
        s[0] += positions[i * 3]; s[1] += positions[i * 3 + 1]; s[2] += positions[i * 3 + 2]; s[3]++;
    }
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const s = sums.get(idx[i]);
        out[i * 3] = s[0] / s[3]; out[i * 3 + 1] = s[1] / s[3]; out[i * 3 + 2] = s[2] / s[3];
    }
    return out;
}
