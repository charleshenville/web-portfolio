// Flow: a cloud's points set loose as particles, moving through the flow
// field (flowField.js) the way particles in a physics sim would.
//
// Each particle has a velocity. It is thrown off its point by a splash (its
// own random direction), then dragged toward the local flow plus a steady
// drift, with inertia setting how quickly it gives in: low inertia and it
// rides the flow at once; high and it carries its splash a long way first.
// Particles from neighbouring points can gather into shared strands.
//
// Each particle is traced from its home point in the vertex shader, from
// the time alone (nothing kept between frames), so the points themselves
// move, a paused frame holds still, scrubbing is exact, and an export
// matches the preview. Its time since release decides where it is:
//
//   continuous  every point leaves, flows for its life, fades and re-forms
//               at home, each on its own beat;
//   release     points let go from a start time, spread over a while (in
//               random order, or top first, or bottom first), and flow on
//               for their life, then fade away (or hold where they got to).
//
// Amount picks how many of the points move at all.
//
// Homes are in the points' own units; `unit` (update's third argument)
// is how many metres one of those is, so a model's points (in its rig's
// units, scaled to his height) flow in metres as the scan's do. Each
// particle is traced from its rest home and its offset added to wherever
// its point is now, so a skinned model's particles leave him as he moves.

import * as THREE from 'three';
import { FIELD_GLSL, FLOW_DIRS, makeFieldUniforms, strandCentres } from './flowField';

const STEPS = 32; // integration steps over a particle's life

export const SIM_DEFAULTS = {
    simOn: false,
    simMode: 'loop',
    simAmount: 1,
    simStart: 0,
    simSpread: 2,
    simOrder: 'random',
    simLife: 4,
    simFadeOut: true,
    simFlow: 0.4,
    simScale: 0.6,
    simChange: 0.3,
    simDrift: 0.2,
    simDriftDir: 'up',
    simSplash: 0.5,
    simInertia: 0.4,
    simGather: 0,
    simGatherSize: 0.15,
};

const ORDERS = { random: 0, top: 1, bottom: 2 };

const SIM_GLSL = /* glsl */ `
${FIELD_GLSL}
uniform float uSimOn;
uniform float uSimTime;
uniform float uSimLife;
uniform float uSimOnce;
uniform float uSimStart;
uniform float uSimSpread;
uniform float uSimOrder;
uniform float uSimFadeOut;
uniform float uSimAmount;
uniform float uSimFlow;
uniform float uSimInvScale;
uniform float uSimChange;
uniform vec3 uSimDrift;
uniform float uSimSplash;
uniform float uSimTau;
uniform float uSimGather;
uniform vec2 uSimY;
uniform float uSimUnit;
attribute vec3 aHome;
attribute vec3 aGuide;

// Where the particle that left 'home' is after 'u' seconds of travel,
// released at 'birth' (the field changes under it as it goes).
vec3 simTrace(vec3 home, float u, float birth, vec3 kick) {
    float h = max(uSimLife, 0.05) / float(${STEPS});
    float tau = max(uSimTau, 1e-3);
    float kFull = exp(-h / tau);
    vec3 p = home;
    vec3 v = kick * uSimSplash;
    float done = 0.0;
    for (int i = 0; i < ${STEPS + 2}; i++) {
        if (done >= u - 1e-5) break;
        float dt = min(h, u - done);
        vec3 target = flowField(p * uSimInvScale, (birth + done) * uSimChange) * uSimFlow + uSimDrift;
        // Drag toward the flow, exactly over the step (stable at any inertia).
        vec3 v1 = target + (v - target) * (dt < h ? exp(-dt / tau) : kFull);
        p += (v + v1) * 0.5 * dt;
        v = v1;
        done += dt;
    }
    return p;
}

// This point's offset from home now, and how much of it shows (0 to 1).
void simPoint(out vec3 off, out float fade) {
    off = vec3(0.0);
    fade = 1.0;
    if (uSimOn < 0.5) return;
    vec3 r = flowHash3(aHome * 31.71 + 0.17);
    if (r.x >= uSimAmount) return;
    float L = max(uSimLife, 0.05);
    float u;
    if (uSimOnce > 0.5) {
        float y = clamp((aHome.y - uSimY.x) / max(uSimY.y - uSimY.x, 1e-5), 0.0, 1.0);
        float order = uSimOrder < 0.5 ? r.y : (uSimOrder < 1.5 ? 1.0 - y : y);
        float a = uSimTime - (uSimStart + order * uSimSpread);
        u = clamp(a, 0.0, L);
        if (uSimFadeOut > 0.5) fade = 1.0 - smoothstep(0.6 * L, L, a);
    } else {
        u = mod(uSimTime + r.y * L, L);
        fade = smoothstep(0.0, 0.06 * L, u) * (1.0 - smoothstep(0.7 * L, L, u));
    }
    if (u <= 0.0 || fade <= 0.001) return;
    float birth = uSimTime - u;
    // Traced in metres, from the home in metres.
    vec3 home = aHome * uSimUnit;
    vec3 p = simTrace(home, u, birth, flowDir(flowHash3(aHome * 17.3 + 0.5)));
    if (uSimGather > 0.0) {
        // Toward the path the middle of its strand takes, closing as it goes.
        vec3 guide = aGuide * uSimUnit;
        vec3 g = simTrace(guide, u, birth, flowDir(flowHash3(aGuide * 17.31 + 0.5)));
        float ramp = smoothstep(0.0, 0.6 * L, u);
        p = mix(p, g + (home - guide) * (1.0 - ramp), uSimGather);
    }
    off = (p - home) / uSimUnit;
}
`;

export default class ParticleFlow {
    constructor() {
        this.uniforms = {
            ...makeFieldUniforms(11),
            uSimOn: { value: 0 },
            uSimTime: { value: 0 },
            uSimLife: { value: 4 },
            uSimOnce: { value: 0 },
            uSimStart: { value: 0 },
            uSimSpread: { value: 2 },
            uSimOrder: { value: 0 },
            uSimFadeOut: { value: 1 },
            uSimAmount: { value: 1 },
            uSimFlow: { value: 0.4 },
            uSimInvScale: { value: 1 },
            uSimChange: { value: 0.3 },
            uSimDrift: { value: new THREE.Vector3() },
            uSimSplash: { value: 0.5 },
            uSimTau: { value: 0.4 },
            uSimGather: { value: 0 },
            uSimY: { value: new THREE.Vector2(0, 1) },
            uSimUnit: { value: 1 },
        };
        this.target = null;
        this.cell = null;
    }

    /**
     * Move `material`'s points: a PointsMaterial (`instanced` false), or the
     * material of an InstancedMesh with a dot per point (true). Chains onto
     * whatever it already does before it compiles.
     */
    hook(material, instanced) {
        if (!material || material.userData.simFlow === this) return;
        material.userData.simFlow = this;
        const prev = material.onBeforeCompile;
        const prevKey = material.customProgramCacheKey;
        const uniforms = this.uniforms;
        material.onBeforeCompile = (shader, renderer) => {
            prev?.call(material, shader, renderer);
            Object.assign(shader.uniforms, uniforms);
            let vs = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${SIM_GLSL}`)
                .replace('#include <begin_vertex>', instanced
                    // Each dot moves with its point and shrinks away as it fades.
                    ? '#include <begin_vertex>\nvec3 simOff; float simFade; simPoint(simOff, simFade);\ntransformed = transformed * simFade + simOff;'
                    : '#include <begin_vertex>\nvec3 simOff; float simFade; simPoint(simOff, simFade);\ntransformed += simOff;');
            if (!instanced) vs = vs.replace('#include <fog_vertex>', '#include <fog_vertex>\ngl_PointSize *= simFade;');
            shader.vertexShader = vs;
        };
        material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|simFlow:${instanced ? 'i' : 'p'}`;
        material.needsUpdate = true;
    }

    /**
     * Give `geometry` its points' homes: `positions` (xyz, as they rest),
     * `count` of them. An InstancedMesh's geometry takes them per instance.
     */
    attach(geometry, positions, count, instanced) {
        const Attr = instanced ? THREE.InstancedBufferAttribute : THREE.BufferAttribute;
        geometry.setAttribute('aHome', new Attr(positions, 3));
        geometry.setAttribute('aGuide', new Attr(positions, 3));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < count; i++) {
            const y = positions[i * 3 + 1];
            if (y < lo) lo = y;
            if (y > hi) hi = y;
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        this.uniforms.uSimY.value.set(lo, hi);
        this.target = {
            geometry, positions, count, Attr,
        };
        this.cell = null;
    }

    /** Set this frame's motion: `p` the object's resolved parameters, `time` the timeline's, `unit` metres per home unit. */
    update(p, time, unit = 1) {
        const u = this.uniforms;
        const on = !!p?.simOn && !!this.target;
        u.uSimOn.value = on ? 1 : 0;
        if (!on) return;
        const fin = (v, d) => (Number.isFinite(v) ? v : d);
        u.uSimTime.value = fin(time, 0);
        u.uSimOnce.value = p.simMode === 'once' ? 1 : 0;
        u.uSimLife.value = Math.max(0.05, fin(p.simLife, 4));
        u.uSimStart.value = fin(p.simStart, 0);
        u.uSimSpread.value = Math.max(0, fin(p.simSpread, 0));
        u.uSimOrder.value = ORDERS[p.simOrder] ?? 0;
        u.uSimFadeOut.value = p.simFadeOut === false ? 0 : 1;
        u.uSimAmount.value = Math.max(0, Math.min(1, fin(p.simAmount, 1)));
        u.uSimFlow.value = Math.max(0, fin(p.simFlow, 0));
        u.uSimInvScale.value = 1 / Math.max(1e-3, fin(p.simScale, 0.6));
        u.uSimChange.value = fin(p.simChange, 0);
        u.uSimDrift.value.fromArray(FLOW_DIRS[p.simDriftDir] || FLOW_DIRS.up).multiplyScalar(fin(p.simDrift, 0));
        u.uSimSplash.value = Math.max(0, fin(p.simSplash, 0));
        u.uSimTau.value = Math.max(0.001, fin(p.simInertia, 0.4));
        u.uSimGather.value = Math.max(0, Math.min(1, fin(p.simGather, 0)));
        const k = Math.max(1e-6, fin(unit, 1));
        u.uSimUnit.value = k;
        // Each point's strand, worked out when gathering first needs it and when its size changes (in home units).
        const cell = Math.max(1e-3, fin(p.simGatherSize, 0.15)) / k;
        if (u.uSimGather.value > 0 && cell !== this.cell) {
            this.cell = cell;
            const { geometry, positions, count, Attr } = this.target;
            geometry.setAttribute('aGuide', new Attr(strandCentres(positions, count, cell), 3));
        }
    }
}
