// Emissive point clouds: points that light what is around them.
//
// A cloud of tens of thousands of points can't be that many lights, so each
// emitting cloud is gathered into a few light sources (k-means over where its
// points rest, each source coloured by its points and as bright as its share
// of them), and the sources are real point lights in the scene: lit meshes,
// props, models and shapes take their light as they take the sun's.
//
// Surfaces that are not drawn lit take it too, through a glow catcher (the
// light's counterpart of the scan's shadow catcher): the scan mesh's surface,
// and stand-in shapes', drawn over what is already in the frame and brightening
// it by the light that lands there, so the glow falls on the footage where the
// real surfaces are, the mesh shown or not. It multiplies what is under it, as
// light on a surface does: a dark wall glows less than a white one.
//
// Models (the protagonist, Sackboy, the cat) take the real lights and, by
// their Catch glow, the catcher's brightening on their lit colour too
// (hookGlowCatch), so they glow as the scan's surface beside them does.
//
// The lights are made the first time anything emits and kept from then on,
// at a fixed number, so lit materials are compiled for them once.

import * as THREE from 'three';
import { MESH_CUT } from '../../../lib/scanAssets/windows';

export const MAX_EMIT_LIGHTS = 8;
const SAMPLE = 3000; // points k-means looks at
const ITERS = 8;

/** This frame's light sources, as the glow catchers read them (world space). */
export const EMIT = {
    uEmitN: { value: 0 },
    uEmitPos: { value: Array.from({ length: MAX_EMIT_LIGHTS }, () => new THREE.Vector3()) },
    uEmitCol: { value: Array.from({ length: MAX_EMIT_LIGHTS }, () => new THREE.Vector3()) },
    uEmitRD: { value: Array.from({ length: MAX_EMIT_LIGHTS }, () => new THREE.Vector2(1, 2)) }, // reach, falloff
};

const CATCH_VERT = /* glsl */ `
varying vec3 vEmitW;
varying vec4 vWinCutClip;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vEmitW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    vWinCutClip = gl_Position;
}`;

// The light as a lit material takes it (three's legacy lights, which this
// renderer uses: a point light reaches `reach` and falls off as
// (1 - d / reach)^falloff), on a white surface facing whichever way it is lit from.
const CATCH_FRAG = /* glsl */ `
#define MAX_EMIT ${MAX_EMIT_LIGHTS}
uniform int uEmitN;
uniform vec3 uEmitPos[MAX_EMIT];
uniform vec3 uEmitCol[MAX_EMIT];
uniform vec2 uEmitRD[MAX_EMIT];
uniform sampler2D tWinCut;
uniform float winCutOn;
varying vec3 vEmitW;
varying vec4 vWinCutClip;
void main() {
    if (winCutOn > 0.5 && vWinCutClip.w > 0.0
        && texture2D(tWinCut, vWinCutClip.xy / vWinCutClip.w * 0.5 + 0.5).r > 0.5) discard;
    // The surface's facing, from how its position changes across the pixel.
    // Seen edge-on (a ground plane toward the horizon) that change is nothing,
    // and normalising nothing is NaN, which turns the footage under it black:
    // such a surface takes no light instead.
    vec3 c = cross(dFdx(vEmitW), dFdy(vEmitW));
    float cl = length(c);
    if (!(cl > 1e-12)) discard;
    vec3 n = c / cl;
    vec3 L = vec3(0.0);
    for (int i = 0; i < MAX_EMIT; i++) {
        if (i >= uEmitN) break;
        vec3 d = uEmitPos[i] - vEmitW;
        float r = max(length(d), 1e-5);
        float base = uEmitRD[i].x > 0.0 ? clamp(1.0 - r / uEmitRD[i].x, 0.0, 1.0) : 1.0;
        // pow(0, y) is undefined for y <= 0 (falloff 0 is no falloff).
        float f = base > 0.0 ? pow(base, max(uEmitRD[i].y, 0.0)) : 0.0;
        L += uEmitCol[i] * abs(dot(n, d / r)) * f;
    }
    // Anything not a finite, positive amount of light lights nothing.
    if (!(L.r >= 0.0 && L.g >= 0.0 && L.b >= 0.0 && L.r < 1e4 && L.g < 1e4 && L.b < 1e4)) discard;
    gl_FragColor = vec4(L, 1.0);
}`;

/**
 * A glow catcher for `geometry`: drawn over the frame, it brightens what is
 * there by the light landing on that surface (dst + dst * light).
 */
export function makeGlowCatcher(geometry) {
    const m = new THREE.ShaderMaterial({
        uniforms: { ...EMIT, tWinCut: MESH_CUT.tWinCut, winCutOn: MESH_CUT.winCutOn },
        vertexShader: CATCH_VERT,
        fragmentShader: CATCH_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.DstColorFactor,
        blendDst: THREE.OneFactor,
        extensions: { derivatives: true },
    });
    const mesh = new THREE.Mesh(geometry, m);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 2; // after the shadow catcher, so shadowed footage glows less
    mesh.raycast = () => {};
    return mesh;
}

/**
 * Let a lit material (a model's: Standard, Phong, Lambert) catch the glow as
 * the scan's surface does: its lit colour brightened by the light that lands
 * on it, by the catcher's formula (lit + lit * light, either side facing),
 * times `strength` (a uniform, so 0 turns it off without recompiling). On
 * top of the real point lights, which light it as any lit surface. Chains
 * onto whatever the material already does before it compiles; once per
 * material.
 */
export function hookGlowCatch(material, strength) {
    if (!material || material.userData.glowCatch === strength) return;
    material.userData.glowCatch = strength;
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        prev?.call(material, shader, renderer);
        Object.assign(shader.uniforms, EMIT, { uGlowCatch: strength });
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vGlowW;\nvarying vec3 vGlowN;')
            .replace('#include <project_vertex>', `#include <project_vertex>
vGlowW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGlowN = (vec4(transformedNormal, 0.0) * viewMatrix).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
#define MAX_EMIT ${MAX_EMIT_LIGHTS}
uniform int uEmitN;
uniform vec3 uEmitPos[MAX_EMIT];
uniform vec3 uEmitCol[MAX_EMIT];
uniform vec2 uEmitRD[MAX_EMIT];
uniform float uGlowCatch;
varying vec3 vGlowW;
varying vec3 vGlowN;`)
            .replace('#include <output_fragment>', `if (uGlowCatch > 0.0 && uEmitN > 0) {
#ifdef FLAT_SHADED
    vec3 gn = cross(dFdx(vGlowW), dFdy(vGlowW));
#else
    vec3 gn = vGlowN;
#endif
    float gLen = length(gn);
    if (gLen > 1e-12) {
        gn /= gLen;
        vec3 gL = vec3(0.0);
        for (int i = 0; i < MAX_EMIT; i++) {
            if (i >= uEmitN) break;
            vec3 d = uEmitPos[i] - vGlowW;
            float r = max(length(d), 1e-5);
            float base = uEmitRD[i].x > 0.0 ? clamp(1.0 - r / uEmitRD[i].x, 0.0, 1.0) : 1.0;
            float f = base > 0.0 ? pow(base, max(uEmitRD[i].y, 0.0)) : 0.0;
            gL += uEmitCol[i] * abs(dot(gn, d / r)) * f;
        }
        if (gL.r >= 0.0 && gL.g >= 0.0 && gL.b >= 0.0 && gL.r < 1e4 && gL.g < 1e4 && gL.b < 1e4) outgoingLight *= 1.0 + uGlowCatch * gL;
    }
}
#include <output_fragment>`);
    };
    material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|glowCatch`;
    material.needsUpdate = true;
}

const lin = new THREE.Color();

/**
 * Gather `count` points (`pos` xyz, `col` rgb or null) into `k` sources:
 * each { at: [x, y, z], color: [r, g, b] (linear, mean of its points), share }.
 */
export function clusterPoints(pos, col, count, k) {
    const n = Math.min(count, SAMPLE);
    if (n < 1) return [];
    // A seeded random sample (a fixed stride can fall in step with how the points are ordered).
    let seed = 0x9e3779b9;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const idx = n === count
        ? Array.from({ length: n }, (_, i) => i * 3)
        : Array.from({ length: n }, () => Math.floor(rand() * count) * 3);
    k = Math.max(1, Math.min(k, n));
    // Seeds spread far apart: the first sample, then each the farthest from those so far.
    const cen = [[pos[idx[0]], pos[idx[0] + 1], pos[idx[0] + 2]]];
    const near = new Float64Array(n).fill(Infinity);
    const d2 = (j, c) => { const dx = pos[j] - c[0]; const dy = pos[j + 1] - c[1]; const dz = pos[j + 2] - c[2]; return dx * dx + dy * dy + dz * dz; };
    while (cen.length < k) {
        let best = 0;
        let far = -1;
        for (let i = 0; i < n; i++) {
            near[i] = Math.min(near[i], d2(idx[i], cen[cen.length - 1]));
            if (near[i] > far) { far = near[i]; best = i; }
        }
        cen.push([pos[idx[best]], pos[idx[best] + 1], pos[idx[best] + 2]]);
    }
    const of = new Int32Array(n);
    for (let it = 0; it < ITERS; it++) {
        const sum = cen.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            let b = 0;
            let bd = Infinity;
            for (let c = 0; c < k; c++) { const d = d2(idx[i], cen[c]); if (d < bd) { bd = d; b = c; } }
            of[i] = b;
            const s = sum[b];
            s[0] += pos[idx[i]]; s[1] += pos[idx[i] + 1]; s[2] += pos[idx[i] + 2]; s[3]++;
        }
        sum.forEach((s, c) => { if (s[3]) cen[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    }
    const out = cen.map((at) => ({ at, color: [0, 0, 0], share: 0 }));
    for (let i = 0; i < n; i++) {
        const o = out[of[i]];
        o.share++;
        if (col) { o.color[0] += col[idx[i]]; o.color[1] += col[idx[i] + 1]; o.color[2] += col[idx[i] + 2]; }
    }
    return out.filter((o) => o.share > 0).map((o) => ({
        at: o.at,
        color: col ? o.color.map((v) => v / o.share) : [1, 1, 1],
        share: o.share / n,
    }));
}

/**
 * Points in order along something (a curve's samples, its dots) gathered
 * into `k` runs of neighbours, each a source at the middle of its run: the
 * same stretch of the curve stays one light as it moves and grows.
 */
export function chunkPoints(pos, col, count, k) {
    k = Math.max(1, Math.min(k, count));
    const out = [];
    for (let c = 0; c < k; c++) {
        const a = Math.floor((c * count) / k);
        const b = Math.floor(((c + 1) * count) / k);
        if (b <= a) continue;
        const at = [0, 0, 0];
        const color = [0, 0, 0];
        for (let i = a; i < b; i++) {
            for (let d = 0; d < 3; d++) {
                at[d] += pos[i * 3 + d];
                if (col) color[d] += col[i * 3 + d];
            }
        }
        const m = b - a;
        out.push({ at: at.map((v) => v / m), color: col ? color.map((v) => v / m) : [1, 1, 1], share: m / count });
    }
    return out;
}

export class Emission {
    constructor(scene) {
        this.scene = scene;
        this.lights = null;
        this.cache = new Map(); // source id -> { key, clusters }
        this.v = new THREE.Vector3();
    }

    ensure() {
        if (this.lights) return;
        this.lights = Array.from({ length: MAX_EMIT_LIGHTS }, () => {
            const l = new THREE.PointLight(0xffffff, 0, 1, 2);
            l.castShadow = false;
            l.layers.enableAll();
            this.scene.add(l);
            return l;
        });
    }

    /**
     * This frame's emitters: each { id, pos, col (rgb, linear, or null), count,
     * matrixWorld, unit (scene units to world), p (its resolved parameters) }.
     * Returns whether anything is lighting hidden surfaces.
     */
    update(sources) {
        const on = sources.filter((s) => s.count > 0 && (s.p.emitIntensity ?? 1) > 0);
        if (!on.length && !this.lights) { EMIT.uEmitN.value = 0; return false; }
        this.ensure();
        // Each its own number of sources, all of them fitting in the pool.
        const want = on.map((s) => Math.max(1, Math.round(s.p.emitLights ?? 4)));
        let total = want.reduce((a, b) => a + b, 0);
        while (total > MAX_EMIT_LIGHTS) {
            const i = want.indexOf(Math.max(...want));
            if (want[i] <= 1) break;
            want[i]--;
            total--;
        }
        let li = 0;
        let ci = 0; // catcher lights: those of emitters that light hidden surfaces
        const fin = (v, d) => (Number.isFinite(v) ? v : d);
        on.forEach((s, si) => {
            if (li >= MAX_EMIT_LIGHTS) return;
            const p = s.p;
            const solid = p.emitColorMode === 'solid' || !s.col;
            const key = `${want[si]}|${s.count}|${solid}`;
            let c = this.cache.get(s.id);
            if (s.ordered) {
                // A curve: drawn afresh every frame, so gathered every frame (cheaply).
                c = { key, clusters: chunkPoints(s.pos, solid ? null : s.col, s.count, want[si]) };
            } else if (!c || c.key !== key || c.pos !== s.pos || c.col !== s.col) {
                c = { key, pos: s.pos, col: s.col, clusters: clusterPoints(s.pos, solid ? null : s.col, s.count, want[si]) };
                this.cache.set(s.id, c);
            }
            if (solid) lin.set(p.emitColor || '#ffd9a0');
            const intensity = Math.max(0, fin(p.emitIntensity, 1));
            const reach = Math.max(1e-3, fin(p.emitReach, 1.5)) * s.unit;
            const falloff = Math.max(0, fin(p.emitFalloff, 2));
            c.clusters.forEach((k) => {
                if (li >= MAX_EMIT_LIGHTS) return;
                const l = this.lights[li];
                const at = this.v.set(k.at[0], k.at[1], k.at[2]).applyMatrix4(s.matrixWorld);
                l.position.copy(at);
                l.updateMatrixWorld();
                if (solid) l.color.copy(lin); else l.color.setRGB(k.color[0], k.color[1], k.color[2]);
                l.intensity = intensity * k.share;
                l.distance = reach;
                l.decay = falloff;
                if (p.emitOnHidden !== false) {
                    EMIT.uEmitPos.value[ci].copy(at);
                    EMIT.uEmitCol.value[ci].set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity);
                    EMIT.uEmitRD.value[ci].set(reach, falloff);
                    ci++;
                }
                li++;
            });
        });
        for (let i = li; i < MAX_EMIT_LIGHTS; i++) this.lights[i].intensity = 0;
        EMIT.uEmitN.value = ci;
        const ids = new Set(on.map((s) => s.id));
        Array.from(this.cache.keys()).forEach((id) => { if (!ids.has(id)) this.cache.delete(id); });
        return ci > 0;
    }
}
