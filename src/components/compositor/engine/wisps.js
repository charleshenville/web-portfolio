// Wisps: ribbons that stream off a point cloud, like hair or smoke.
//
// Each ribbon starts at one of the cloud's points and follows a particle
// through a flow field: a divergence-free swirl (a sum of curled waves, so it
// curls without bunching up or thinning out) plus a steady drift and a
// splash that kicks it off in its own direction and dies away. A ribbon's
// points can gather toward the strand it shares with its neighbours, so the
// tips bundle into locks.
//
// The path is worked out in the vertex shader from the ribbon's seed and the
// time alone, with nothing carried from frame to frame: a paused frame holds
// still, scrubbing is exact, and an export draws what the preview showed.
//
//   strands  rooted at their point, the whole length swaying as the flow
//            changes;
//   streams  born at their point, carried off along the flow, and reborn
//            when their life is up (each on its own beat).

import * as THREE from 'three';
import {
    FIELD_GLSL, FLOW_DIRS, makeFieldUniforms, rng,
} from './flowField';

const MAX_STEPS = 40;
const STEPS = 32; // integration steps over a full life (streams) or length (strands)

export const WISP_DIRS = FLOW_DIRS;

const VERT = /* glsl */ `
#define MAX_STEPS ${MAX_STEPS}
${FIELD_GLSL}
uniform float uTime;
uniform float uLife;
uniform float uLen;
uniform float uStreams;
uniform float uFlow;
uniform float uInvScale;
uniform float uEvolve;
uniform vec3 uDrift;
uniform float uSplash;
uniform float uSplashTau;
uniform float uGather;
uniform float uWidth;
uniform float uTaper;
uniform float uOpacity;
uniform vec3 uColor;
uniform float uSolid;
uniform float uBright;
uniform vec2 uRes;
attribute vec3 aSeed;
attribute vec3 aGuide;
attribute vec3 aColor;
attribute vec4 aRand;
varying vec3 vColor;
varying float vAlpha;

// How fast a particle at p moves, u seconds into its path. Its field's clock
// runs with it (streams) or holds at now (strands).
vec3 vel(vec3 p, float u, float t0, float tk, vec3 kick) {
    return flowField(p * uInvScale, (t0 + tk * u) * uEvolve) * uFlow + uDrift + kick * (uSplash * exp(-u / uSplashTau));
}

void main() {
    float k = position.x;
    float side = position.y;
    float head;
    float tail;
    float t0;
    float tk;
    float fade = 1.0;
    float span;
    if (uStreams > 0.5) {
        float a = mod(uTime + aRand.x * uLife, uLife);
        head = a;
        tail = max(0.0, a - uLen);
        t0 = uTime - a;
        tk = 1.0;
        span = uLife;
        fade = smoothstep(0.0, 0.08 * uLife, a) * (1.0 - smoothstep(0.7 * uLife, uLife, a));
    } else {
        head = uLen * (0.55 + 0.45 * aRand.x);
        tail = 0.0;
        t0 = uTime;
        tk = 0.0;
        span = uLen;
    }
    float u = mix(tail, head, k);
    float h = max(span, 1e-3) / float(${STEPS});

    vec3 kick = flowDir(aRand.yzw);
    vec3 gkick = flowDir(flowHash3(aGuide * 17.31 + 0.5));
    vec3 p = aSeed;
    vec3 g = aGuide;
    float done = 0.0;
    for (int i = 0; i < MAX_STEPS; i++) {
        if (done >= u - 1e-5) break;
        float dt = min(h, u - done);
        p += vel(p, done, t0, tk, kick) * dt;
        if (uGather > 0.0) g += vel(g, done, t0, tk, gkick) * dt;
        done += dt;
    }
    vec3 tan = vel(p, u, t0, tk, kick);
    vec3 pos = p;
    if (uGather > 0.0) {
        // The ribbon's offset from its strand closes along its length.
        float ramp = smoothstep(0.0, max(uLen, 1e-3) * 0.7, u);
        pos = mix(p, g + (aSeed - aGuide) * (1.0 - ramp), uGather);
        tan = mix(tan, vel(g, u, t0, tk, gkick), uGather);
    }
    float tl = length(tan);
    tan = tl > 1e-6 ? tan / tl : vec3(0.0, 1.0, 0.0);

    // A ribbon facing the screen, uWidth pixels across.
    float eps = 0.01 / max(uInvScale, 1e-3);
    vec4 c0 = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    vec4 c1 = projectionMatrix * modelViewMatrix * vec4(pos + tan * eps, 1.0);
    vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uRes;
    float dl = length(d);
    d = dl > 1e-6 ? d / dl : vec2(1.0, 0.0);
    float along = uStreams > 0.5 ? k : 1.0 - k;
    float taper = mix(1.0, along, uTaper);
    float w = max(uWidth, 1.0) * mix(1.0, 0.35 + 0.65 * taper, uTaper);
    c0.xy += vec2(-d.y, d.x) * side * (w / uRes) * c0.w;
    gl_Position = c0;

    vColor = mix(aColor, uColor, uSolid) * uBright;
    // Thinner than a pixel draws a pixel, fainter.
    vAlpha = uOpacity * fade * taper * min(uWidth, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
    if (vAlpha < 0.002) discard;
    gl_FragColor = vec4(vColor, vAlpha);
    #include <encodings_fragment>
}
`;

/** The wisp parameters an object carries (scan points and point clouds alike). */
export const WISP_DEFAULTS = {
    wispOn: false,
    wispStyle: 'strands',
    wispCount: 6000,
    wispDetail: 24,
    wispFrom: 0,
    wispTo: 1,
    wispLength: 1.2,
    wispLife: 3,
    wispFlow: 0.35,
    wispFlowScale: 0.6,
    wispEvolve: 0.3,
    wispDrift: 0.2,
    wispDriftDir: 'up',
    wispSplash: 0,
    wispSplashDecay: 0.3,
    wispGather: 0.5,
    wispGatherSize: 0.15,
    wispWidth: 0.8,
    wispTaper: 0.8,
    wispColorMode: 'points',
    wispColor: '#ffffff',
    wispBright: 1,
    wispOpacity: 0.5,
    wispBlend: 'add',
};

export default class Wisps {
    constructor() {
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                ...makeFieldUniforms(7),
                uTime: { value: 0 },
                uLife: { value: 3 },
                uLen: { value: 1 },
                uStreams: { value: 0 },
                uFlow: { value: 0.35 },
                uInvScale: { value: 1 },
                uEvolve: { value: 0.3 },
                uDrift: { value: new THREE.Vector3() },
                uSplash: { value: 0 },
                uSplashTau: { value: 0.3 },
                uGather: { value: 0 },
                uWidth: { value: 1 },
                uTaper: { value: 0.8 },
                uOpacity: { value: 0.5 },
                uColor: { value: new THREE.Color() },
                uSolid: { value: 0 },
                uBright: { value: 1 },
                uRes: { value: new THREE.Vector2(1, 1) },
            },
        });
        this.geometry = new THREE.InstancedBufferGeometry();
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.renderOrder = 2;
        // Its geometry is only a ribbon template the shader bends into place: nothing to pick.
        this.mesh.raycast = () => {};
        this.object = this.mesh;
        this.key = null;
        this.source = null;
    }

    /**
     * The points to grow from: `positions` (xyz, in the object's space),
     * `colors` (linear rgb, or null), `count` of them. Kept by identity; a
     * new array means new seeds.
     */
    setSource(positions, colors, count) {
        if (this.source && this.source.positions === positions && this.source.count === count) return;
        this.source = { positions, colors, count };
        this.key = null;
    }

    /** Pick seeds and lay out the ribbons, when what decides them changes. */
    build(p) {
        const src = this.source;
        const detail = Math.max(2, Math.min(64, Math.round(p.wispDetail || 24)));
        const want = Math.max(0, Math.min(200000, Math.round(p.wispCount || 0)));
        const from = Math.min(p.wispFrom ?? 0, p.wispTo ?? 1);
        const to = Math.max(p.wispFrom ?? 0, p.wispTo ?? 1);
        const cell = Math.max(1e-3, p.wispGatherSize || 0.15);
        const key = [detail, want, from, to, cell].join('|');
        if (key === this.key) return;
        this.key = key;

        // The ribbon: two rows of vertices down its length, (k along, side).
        if (this.detail !== detail) {
            this.detail = detail;
            const n = detail + 1;
            const pos = new Float32Array(n * 2 * 3);
            for (let j = 0; j < n; j++) {
                pos.set([j / detail, -1, 0, j / detail, 1, 0], j * 6);
            }
            const idx = [];
            for (let j = 0; j < detail; j++) {
                const a = j * 2;
                idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
            this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            this.geometry.setIndex(idx);
        }

        // Seeds: points in the height band, picked at random (but always the same ones).
        const { positions, colors, count } = src;
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < count; i++) {
            const y = positions[i * 3 + 1];
            if (y < lo) lo = y;
            if (y > hi) hi = y;
        }
        const range = hi - lo || 1;
        const yLo = lo + from * range - 1e-6;
        const yHi = lo + to * range + 1e-6;
        const pool = new Uint32Array(count);
        let m = 0;
        for (let i = 0; i < count; i++) {
            const y = positions[i * 3 + 1];
            if (y >= yLo && y <= yHi) pool[m++] = i;
        }
        const n = Math.min(want, m);
        const r = rng(1234 + count);
        for (let i = 0; i < n; i++) {
            const j = i + Math.floor(r() * (m - i));
            const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        const seed = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const rand = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const s = pool[i];
            seed.set(positions.subarray(s * 3, s * 3 + 3), i * 3);
            if (colors) col.set(colors.subarray(s * 3, s * 3 + 3), i * 3);
            else col.fill(1, i * 3, i * 3 + 3);
            rand.set([r(), r(), r(), r()], i * 4);
        }
        // Each ribbon's strand: the middle of the seeds sharing its cell.
        const cells = new Map();
        const cellOf = new Array(n);
        for (let i = 0; i < n; i++) {
            const c = `${Math.floor(seed[i * 3] / cell)},${Math.floor(seed[i * 3 + 1] / cell)},${Math.floor(seed[i * 3 + 2] / cell)}`;
            cellOf[i] = c;
            const acc = cells.get(c) || [0, 0, 0, 0];
            acc[0] += seed[i * 3]; acc[1] += seed[i * 3 + 1]; acc[2] += seed[i * 3 + 2]; acc[3]++;
            cells.set(c, acc);
        }
        const guide = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const acc = cells.get(cellOf[i]);
            guide.set([acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]], i * 3);
        }
        const g = this.geometry;
        g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
        g.setAttribute('aGuide', new THREE.InstancedBufferAttribute(guide, 3));
        g.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
        g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
        g.instanceCount = n;
    }

    /**
     * Draw this frame: `p` the object's resolved parameters, `time` the
     * timeline's, `drawSize` the drawing buffer, `ss` the export's supersample.
     */
    update(p, time, drawSize, ss = 1, shown = true) {
        const on = shown && !!p?.wispOn && !!this.source && this.source.count > 0 && (p.wispOpacity ?? 0) > 0.001;
        this.mesh.visible = on;
        if (!on) return;
        this.build(p);
        if (!this.geometry.instanceCount) { this.mesh.visible = false; return; }
        const u = this.material.uniforms;
        const fin = (v, d) => (Number.isFinite(v) ? v : d);
        u.uTime.value = fin(time, 0);
        u.uStreams.value = p.wispStyle === 'streams' ? 1 : 0;
        u.uLife.value = Math.max(0.05, fin(p.wispLife, 3));
        u.uLen.value = Math.max(0, fin(p.wispLength, 1));
        u.uFlow.value = Math.max(0, fin(p.wispFlow, 0));
        u.uInvScale.value = 1 / Math.max(1e-3, fin(p.wispFlowScale, 0.6));
        u.uEvolve.value = fin(p.wispEvolve, 0);
        const dir = WISP_DIRS[p.wispDriftDir] || WISP_DIRS.up;
        u.uDrift.value.fromArray(dir).multiplyScalar(fin(p.wispDrift, 0));
        u.uSplash.value = Math.max(0, fin(p.wispSplash, 0));
        u.uSplashTau.value = Math.max(0.01, fin(p.wispSplashDecay, 0.3));
        u.uGather.value = Math.max(0, Math.min(1, fin(p.wispGather, 0)));
        u.uWidth.value = Math.max(0, fin(p.wispWidth, 1)) * ss;
        u.uTaper.value = Math.max(0, Math.min(1, fin(p.wispTaper, 0.8)));
        u.uOpacity.value = Math.max(0, Math.min(1, fin(p.wispOpacity, 0.5)));
        u.uColor.value.set(p.wispColor || '#ffffff');
        u.uSolid.value = p.wispColorMode === 'solid' || !this.source.colors ? 1 : 0;
        u.uBright.value = Math.max(0, fin(p.wispBright, 1));
        u.uRes.value.set(drawSize?.x || 1, drawSize?.y || 1);
        const blending = p.wispBlend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
        if (this.material.blending !== blending) this.material.blending = blending;
    }

    dispose() {
        this.mesh.removeFromParent();
        this.geometry.dispose();
        this.material.dispose();
    }
}
