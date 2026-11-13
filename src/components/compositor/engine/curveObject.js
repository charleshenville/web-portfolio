// Equations and splines in a scene: a curve worked out every frame (its
// expressions read variables a controller can be driving) and drawn as a
// line or as points, once or as a series of copies.
//
//   solid   a ribbon facing the camera, mitred at its joins, its width in
//           the curve's own units (so it scales with it and with distance)
//           or in pixels; width and opacity can taper along it
//   points  instanced dots of any shape (flat squares and discs face the
//           camera; the solids can spin), flowing along it, jittered and
//           pulsed by the bass as the old Curve's were; solid, or drawn by
//           their edges alone (a cube's twelve, not its triangles')
//
// Everything is a function of the timeline's time, so a paused frame holds
// still and an export matches the preview.

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { bassLevel } from '../../../lib/audioScene';
import { isSeries, isPointsMode } from '../model/schema';
import { splineAt } from '../model/spline';
import { solveLoose, isSplineObject } from '../model/globals';
import { spinAt } from '../model/spin';

const D2R = Math.PI / 180;

const EASE = {
    linear: (x) => x,
    in: (x) => x * x,
    out: (x) => 1 - (1 - x) * (1 - x),
    inOut: (x) => x * x * (3 - 2 * x),
};

/** A repeatable random number in [0, 1) for point `i` of copy `k`, stream `s`. */
function hash3(i, k, s) {
    let h = (Math.imul(i + 1, 374761393) + Math.imul(k + 1, 668265263) + Math.imul(s + 1, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// ---- The line ----------------------------------------------------------------------

const RIBBON_VERT = /* glsl */`
uniform vec2 uRes;
uniform float uPixels;
uniform float uScale;
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute float aWidth;
attribute vec4 aColor;
varying vec4 vColor;
varying float vSide;
void main() {
    mat4 mvp = projectionMatrix * modelViewMatrix;
    vec4 c = mvp * vec4(position, 1.0);
    vec4 p = mvp * vec4(aPrev, 1.0);
    vec4 n = mvp * vec4(aNext, 1.0);
    float aspect = uRes.x / max(1.0, uRes.y);
    vec2 sc = c.xy / c.w * vec2(aspect, 1.0);
    vec2 sp = p.xy / p.w * vec2(aspect, 1.0);
    vec2 sn = n.xy / n.w * vec2(aspect, 1.0);
    vec2 d1 = sc - sp;
    vec2 d2 = sn - sc;
    float l1 = length(d1);
    float l2 = length(d2);
    vec2 dir = vec2(1.0, 0.0);
    float miter = 1.0;
    if (l1 > 1e-9 && l2 > 1e-9) {
        vec2 a = d1 / l1;
        vec2 b = d2 / l2;
        vec2 s = a + b;
        dir = length(s) > 1e-6 ? normalize(s) : a;
        miter = 1.0 / max(0.35, dot(vec2(-dir.y, dir.x), vec2(-a.y, a.x)));
    } else if (l1 > 1e-9) {
        dir = d1 / l1;
    } else if (l2 > 1e-9) {
        dir = d2 / l2;
    }
    vec2 nrm = vec2(-dir.y, dir.x);
    // Half the width, in the frame's height units (the frame is 2 tall).
#ifdef SHADOW_DEPTH
    // From the sun: always a width in the scene (uScale turns aWidth into scene units).
    float hw = 0.5 * aWidth * uScale * projectionMatrix[1][1] / max(1e-6, abs(c.w));
#else
    float hw = uPixels > 0.5 ? aWidth / 1080.0 : 0.5 * aWidth * uScale * projectionMatrix[1][1] / max(1e-6, abs(c.w));
#endif
    vec2 off = nrm * aSide * hw * miter;
    off.x /= aspect;
    c.xy += off * c.w;
    vColor = aColor;
    vSide = aSide;
    gl_Position = c;
}`;

const RIBBON_FRAG = /* glsl */`
uniform float uOpacity;
varying vec4 vColor;
varying float vSide;
void main() {
    float a = vColor.a * uOpacity;
    float fw = fwidth(vSide);
    a *= 1.0 - smoothstep(1.0 - fw * 1.5, 1.0, abs(vSide));
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor.rgb, a);
    #include <encodings_fragment>
}`;

// The ribbon as the sun sees it, for its shadow: the same strip, facing the
// light, written as depth. Faint parts (below a third opacity) cast nothing.
const RIBBON_DEPTH_FRAG = /* glsl */`
#include <packing>
uniform float uOpacity;
varying vec4 vColor;
void main() {
    if (vColor.a * uOpacity < 0.35) discard;
    gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}`;

class Ribbon {
    constructor() {
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uRes: { value: new THREE.Vector2(1, 1) },
                uPixels: { value: 0 },
                uScale: { value: 1 },
                uOpacity: { value: 1 },
            },
            vertexShader: RIBBON_VERT,
            fragmentShader: RIBBON_FRAG,
            transparent: true,
            side: THREE.DoubleSide,
            extensions: { derivatives: true },
        });
        this.geometry = new THREE.BufferGeometry();
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.frustumCulled = false;
        this.depth = new THREE.ShaderMaterial({
            uniforms: {
                uRes: { value: new THREE.Vector2(1, 1) },
                uPixels: { value: 0 },
                uScale: { value: 1 },
                uOpacity: this.material.uniforms.uOpacity,
            },
            defines: { SHADOW_DEPTH: '' },
            vertexShader: RIBBON_VERT,
            fragmentShader: RIBBON_DEPTH_FRAG,
            side: THREE.DoubleSide,
        });
        this.mesh.customDepthMaterial = this.depth;
        this.capacity = 0;
    }

    ensure(points) {
        if (points <= this.capacity) return;
        const cap = Math.max(64, Math.ceil(points * 1.25));
        this.capacity = cap;
        const V = cap * 2;
        const g = this.geometry;
        this.pos = new Float32Array(V * 3);
        this.prev = new Float32Array(V * 3);
        this.next = new Float32Array(V * 3);
        this.side = new Float32Array(V);
        this.width = new Float32Array(V);
        this.color = new Float32Array(V * 4);
        this.index = new Uint32Array(cap * 6);
        for (let i = 0; i < cap; i++) { this.side[i * 2] = -1; this.side[i * 2 + 1] = 1; }
        g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aPrev', new THREE.BufferAttribute(this.prev, 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aNext', new THREE.BufferAttribute(this.next, 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
        g.setAttribute('aWidth', new THREE.BufferAttribute(this.width, 1).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
        g.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    }

    /**
     * Lay out `strips`: each `{ n, xyz: Float32Array(n*3), ok: Uint8Array(n),
     * width: Float32Array(n), rgba: Float32Array(n*4) }`. A sample that isn't
     * a number breaks the line there.
     */
    write(strips) {
        const total = strips.reduce((a, s) => a + s.n, 0);
        this.ensure(total);
        const { pos, prev, next, width, color, index } = this;
        let v = 0;
        let ix = 0;
        strips.forEach((s) => {
            const start = v;
            for (let i = 0; i < s.n; i++) {
                const ok = s.ok[i];
                const pi = ok && i > 0 && s.ok[i - 1] ? i - 1 : i;
                const ni = ok && i < s.n - 1 && s.ok[i + 1] ? i + 1 : i;
                for (let side = 0; side < 2; side++) {
                    const o = (v * 2 + side) * 3;
                    for (let d = 0; d < 3; d++) {
                        pos[o + d] = ok ? s.xyz[i * 3 + d] : 0;
                        prev[o + d] = ok ? s.xyz[pi * 3 + d] : 0;
                        next[o + d] = ok ? s.xyz[ni * 3 + d] : 0;
                    }
                    width[v * 2 + side] = ok ? s.width[i] : 0;
                    const c = (v * 2 + side) * 4;
                    for (let d = 0; d < 4; d++) color[c + d] = s.rgba[i * 4 + d];
                }
                v++;
            }
            for (let i = 0; i < s.n - 1; i++) {
                if (!s.ok[i] || !s.ok[i + 1]) continue;
                const a = (start + i) * 2;
                const b = a + 2;
                index[ix++] = a; index[ix++] = a + 1; index[ix++] = b;
                index[ix++] = a + 1; index[ix++] = b + 1; index[ix++] = b;
            }
        });
        const g = this.geometry;
        ['position', 'aPrev', 'aNext', 'aWidth', 'aColor'].forEach((k) => {
            const a = g.getAttribute(k);
            a.needsUpdate = true;
            a.updateRange.count = -1;
        });
        g.index.needsUpdate = true;
        g.setDrawRange(0, ix);
        this.mesh.visible = ix > 0;
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
        this.depth.dispose();
        this.mesh.removeFromParent();
    }
}

// ---- Points ------------------------------------------------------------------------------

const SHAPES = {
    square: () => new THREE.PlaneGeometry(2, 2),
    disc: () => new THREE.CircleGeometry(1, 24),
    tetra: () => new THREE.TetrahedronGeometry(1, 0),
    cube: () => new THREE.BoxGeometry(1.15, 1.15, 1.15),
    octa: () => new THREE.OctahedronGeometry(1, 0),
    dodeca: () => new THREE.DodecahedronGeometry(1, 0),
    icosa: () => new THREE.IcosahedronGeometry(1, 0),
    sphere: () => new THREE.SphereGeometry(1, 16, 12),
};
export const FLAT_SHAPES = new Set(['square', 'disc']);

// A shape's own edges, as segment end points: where its faces meet at an
// angle, so the diagonals splitting a cube's faces aren't among them.
const edgeCache = new Map();
function shapeEdges(shape) {
    let e = edgeCache.get(shape);
    if (!e) {
        const geo = (SHAPES[shape] || SHAPES.tetra)();
        const edges = new THREE.EdgesGeometry(geo, 1);
        e = Float32Array.from(edges.getAttribute('position').array);
        geo.dispose();
        edges.dispose();
        edgeCache.set(shape, e);
    }
    return e;
}

/** Instanced dots of one shape, each with its own colour and opacity. */
export class Dots {
    constructor() {
        this.object = new THREE.Group();
        this.mesh = null;
        this.key = null;
        this.capacity = 0;
        this.m = new THREE.Matrix4();
        this.q = new THREE.Quaternion();
        this.s = new THREE.Vector3();
        this.v = new THREE.Vector3();
        this.axis = new THREE.Vector3();
        this.tmpQ = new THREE.Quaternion();
        this.wire = null;
    }

    /** The wide lines a wireframe is drawn with, made on first use. */
    ensureWire() {
        if (this.wire) return this.wire;
        const mat = new LineMaterial({
            color: 0xffffff, vertexColors: true, linewidth: 1.5, transparent: true, worldUnits: false,
        });
        const line = new LineSegments2(new LineSegmentsGeometry(), mat);
        line.frustumCulled = false;
        this.object.add(line);
        this.wire = line;
        return line;
    }

    material(lit, flat) {
        const opts = { color: 0xffffff, transparent: true, side: flat ? THREE.DoubleSide : THREE.FrontSide };
        const m = lit ? new THREE.MeshLambertMaterial({ ...opts, flatShading: true }) : new THREE.MeshBasicMaterial(opts);
        m.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstAlpha;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstAlpha = instanceAlpha;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nvarying float vInstAlpha;')
                .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vInstAlpha;\nif (diffuseColor.a <= 0.002) discard;');
        };
        m.customProgramCacheKey = () => `curve-dots-${lit ? 'lit' : 'flat'}`;
        return m;
    }

    ensure(shape, lit, count) {
        const key = `${shape}|${lit ? 1 : 0}`;
        if (this.mesh && key === this.key && count <= this.capacity) return;
        const cap = Math.max(16, Math.ceil(count * (this.key === key ? 1.25 : 1)));
        this.dispose(true);
        this.key = key;
        this.capacity = cap;
        const geo = (SHAPES[shape] || SHAPES.tetra)();
        this.mesh = new THREE.InstancedMesh(geo, this.material(lit, FLAT_SHAPES.has(shape)), cap);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('instanceAlpha', this.alpha);
        this.mesh.frustumCulled = false;
        this.mesh.count = 0;
        this.object.add(this.mesh);
    }

    /**
     * Place `n` dots: positions xyz (n*3), sizes, rgba (n*4), optional
     * per-dot spin (radians, n), facing `face` (a quaternion, for flat shapes).
     */
    write(n, xyz, size, rgba, opts) {
        if (opts.wire) { this.writeWire(n, xyz, size, rgba, opts); return; }
        if (this.wire) this.wire.visible = false;
        const { shape, lit, face, spin, opacity } = opts;
        this.spinAxis = opts.spinAxis || 'random';
        this.seed = opts.seed || 0;
        this.ensure(shape, lit, n);
        const mesh = this.mesh;
        mesh.castShadow = !!opts.castShadow;
        const flat = FLAT_SHAPES.has(shape);
        const col = mesh.instanceColor.array;
        const al = this.alpha.array;
        let j = 0;
        for (let i = 0; i < n; i++) {
            const s = size[i];
            if (!(s > 0) || !Number.isFinite(xyz[i * 3]) || !Number.isFinite(xyz[i * 3 + 1]) || !Number.isFinite(xyz[i * 3 + 2])) continue;
            this.turn(i, flat, face, spin);
            this.v.set(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
            this.s.setScalar(s);
            this.m.compose(this.v, this.q, this.s);
            mesh.setMatrixAt(j, this.m);
            col[j * 3] = rgba[i * 4];
            col[j * 3 + 1] = rgba[i * 4 + 1];
            col[j * 3 + 2] = rgba[i * 4 + 2];
            al[j] = rgba[i * 4 + 3];
            j++;
        }
        mesh.count = j;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        this.alpha.needsUpdate = true;
        mesh.material.opacity = Math.max(0, Math.min(1, opacity));
        mesh.visible = j > 0;
    }

    /**
     * Each dot's rotation into this.q, as write() turns them: about an axis
     * of its own (this.spinAxis 'random', seeded by its index plus
     * this.seed) or x, y or z. Flat ones face `face` and spin in its plane.
     */
    turn(i, flat, face, spin) {
        const a = spin ? spin[i] : 0;
        if (flat) {
            this.q.copy(face);
            if (a) this.q.multiply(this.tmpQ.setFromAxisAngle(this.axis.set(0, 0, 1), a));
        } else if (a) {
            const mode = this.spinAxis || 'random';
            if (mode === 'x') this.axis.set(1, 0, 0);
            else if (mode === 'y') this.axis.set(0, 1, 0);
            else if (mode === 'z') this.axis.set(0, 0, 1);
            else {
                const j = i + (this.seed || 0);
                this.axis.set(hash3(j, 0, 7) - 0.5, hash3(j, 0, 8) - 0.5, hash3(j, 0, 9) - 0.5).normalize();
            }
            this.q.setFromAxisAngle(this.axis, a);
        } else this.q.identity();
    }

    /**
     * The dots as wireframes: each shape's edges, placed and turned as the
     * solid would be, all in one set of wide lines `wireWidth` pixels (of a
     * 1080-tall frame) across.
     */
    writeWire(n, xyz, size, rgba, {
        shape, face, spin, opacity, wireWidth = 1.5, resolution, spinAxis = 'random', seed = 0,
    }) {
        if (this.mesh) this.mesh.visible = false;
        this.spinAxis = spinAxis;
        this.seed = seed;
        const E = shapeEdges(shape);
        const per = E.length / 3;
        const flat = FLAT_SHAPES.has(shape);
        const pos = new Float32Array(n * per * 3);
        const col = new Float32Array(n * per * 3);
        let o = 0;
        for (let i = 0; i < n; i++) {
            const s = size[i];
            if (!(s > 0) || !Number.isFinite(xyz[i * 3]) || !Number.isFinite(xyz[i * 3 + 1]) || !Number.isFinite(xyz[i * 3 + 2])) continue;
            this.turn(i, flat, face, spin);
            this.v.set(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
            this.s.setScalar(s);
            this.m.compose(this.v, this.q, this.s);
            const a = rgba[i * 4 + 3];
            for (let e = 0; e < per; e++) {
                this.axis.fromArray(E, e * 3).applyMatrix4(this.m);
                pos[o] = this.axis.x;
                pos[o + 1] = this.axis.y;
                pos[o + 2] = this.axis.z;
                // Wide lines have no alpha of their own per vertex: a faded dot is a darker one.
                col[o] = rgba[i * 4] * a;
                col[o + 1] = rgba[i * 4 + 1] * a;
                col[o + 2] = rgba[i * 4 + 2] * a;
                o += 3;
            }
        }
        const line = this.ensureWire();
        line.visible = o > 0;
        if (!o) return;
        const geo = new LineSegmentsGeometry();
        geo.setPositions(o === pos.length ? pos : pos.subarray(0, o));
        geo.setColors(o === col.length ? col : col.subarray(0, o));
        line.geometry.dispose();
        line.geometry = geo;
        const m = line.material;
        const h = resolution ? resolution.y : 1080;
        if (resolution) m.resolution.copy(resolution);
        m.linewidth = Math.max(0.25, wireWidth) * (h / 1080);
        m.opacity = Math.max(0, Math.min(1, opacity));
    }

    hide() {
        if (this.mesh) this.mesh.visible = false;
        if (this.wire) this.wire.visible = false;
    }

    dispose(keepGroup = false) {
        if (this.mesh) {
            this.mesh.removeFromParent();
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh.dispose?.();
            this.mesh = null;
        }
        if (!keepGroup) {
            if (this.wire) {
                this.wire.geometry.dispose();
                this.wire.material.dispose();
                this.wire.removeFromParent();
                this.wire = null;
            }
            this.object.removeFromParent();
        }
    }
}

// ---- The curve ------------------------------------------------------------------------------

/** How much of copy `k`'s range is drawn now, 0..1. */
function drawnFraction(p, k, time) {
    let f = Math.max(0, Math.min(1, p.reveal ?? 1));
    if (p.growOn) {
        const dur = Math.max(1e-3, p.growDur || 0);
        const x = Math.max(0, Math.min(1, (time - (p.growStart || 0) - k * (p.seriesStagger || 0)) / dur));
        f *= (EASE[p.growEase] || EASE.linear)(x);
    }
    return f;
}

/** Copy k's whole range, with its length change. */
function copyRange(p, k) {
    let a = Number.isFinite(p.rangeFrom) ? p.rangeFrom : 0;
    let b = Number.isFinite(p.rangeTo) ? p.rangeTo : 1;
    const L = k * (p.seriesLen || 0);
    if (L) {
        if (p.seriesLenAt === 'start') a -= L;
        else if (p.seriesLenAt === 'both') { a -= L / 2; b += L / 2; } else b += L;
    }
    return [a, b];
}

/** The drawn part of [a, b], grown by fraction f from where it grows from. */
function drawnRange(p, a, b, f) {
    const span = (b - a) * f;
    if (p.revealFrom === 'end') return [b - span, b];
    if (p.revealFrom === 'centre') { const m = (a + b) / 2; return [m - span / 2, m + span / 2]; }
    return [a, a + span];
}

/**
 * How far defining point `i` of a spline with settings `p` has turned at
 * `time` (radians): the spline's spin rate, each point from an angle of
 * its own unless they spin together.
 */
export function knotAngle(p, i, time) {
    const rate = (p.knotSpin || 0) * D2R;
    if (!rate) return 0;
    const start = p.knotSpinTogether ? 0 : hash3(i, 3, 11) * Math.PI * 2;
    return rate * (time || 0) + start;
}

/** The u span the curve's first copy draws now ([lo, hi]), or null while none of it is. */
export function drawnSpan(p, time) {
    const [a, b] = copyRange(p, 0);
    const frac = drawnFraction(p, 0, time || 0);
    if (frac <= 0 || a === b) return null;
    return drawnRange(p, a, b, frac);
}

/** Where each defining point sits along a solved spline, in u (0..1). */
export function knotU(sol) {
    if (!sol) return [];
    if (sol.single) return [0];
    if (!sol.N) return [];
    const total = sol.knots[sol.N] || 1;
    const n = sol.closed ? sol.N : sol.N + 1;
    return Array.from({ length: n }, (_, i) => sol.knots[i] / total);
}

/**
 * The u span a Manifold coming in with the music draws at timeline `time`:
 * up to where the sound is now, from where it was `trail` seconds ago (or
 * the start). `{ lo, hi, started }`, started once the sound has reached its
 * first keypoint; null for a static one, all of which is drawn.
 */
export function musicSpan(p, sol, time) {
    const g = p.gen;
    if (p.timing === 'static' || !g || !(g.to > g.from)) return null;
    const us = knotU(sol);
    const n = us.length;
    if (n < 2) return null;
    const toU = (s) => {
        const x = ((s - g.from) / (g.to - g.from)) * (n - 1);
        if (x <= 0) return 0;
        if (x >= n - 1) return sol.closed ? us[n - 1] : 1;
        const i = Math.floor(x);
        return us[i] + (us[i + 1] - us[i]) * (x - i);
    };
    const s = (time || 0) - (p.timeOffset || 0);
    return { lo: p.trail > 0 ? toU(s - p.trail) : 0, hi: toU(s), started: s >= g.from };
}

/** [lo, hi] cut to a music span (null when nothing of it is left). */
function withinMusic(lo, hi, ms) {
    if (!ms) return [lo, hi];
    if (!ms.started) return null;
    const a = Math.max(lo, ms.lo);
    const b = Math.min(hi, ms.hi);
    return b > a ? [a, b] : null;
}

export default class CurveAdapter {
    constructor(obj, parent) {
        // The spin turns this about the defining points' middle; inside it,
        // the group carries the object's own position, rotation and scale,
        // and is what the gizmo holds, so dragging never writes the spin in.
        this.spinNode = new THREE.Group();
        this.object = this.spinNode;
        parent.add(this.spinNode);
        this.group = new THREE.Group();
        this.spinNode.add(this.group);
        // What the gizmo holds: the object's own position, rotation and scale
        // in the scene's frame, beside the spin rather than inside it, so a
        // drag moves it along the scene's axes however it is spinning (the
        // spin turns about the points' centre, which the drag moves with it).
        this.handle = new THREE.Object3D();
        this.gizmoTarget = this.handle;
        this.spinQ = new THREE.Quaternion();
        this.spinC = new THREE.Vector3();
        this.ribbon = new Ribbon();
        this.group.add(this.ribbon.mesh);
        this.dots = new Dots();
        this.group.add(this.dots.object);
        this.knots = new Dots();
        this.group.add(this.knots.object);
        // A Manifold's marker at where the music is.
        this.head = new Dots();
        this.group.add(this.head.object);
        this.span = null;
        // Where it was drawn this frame, in its own frame, for the sun to aim its shadow at.
        this.bounds = new THREE.Box3();
        this.worldBounds = new THREE.Box3();
        // What the sun reads to decide whether this casts a shadow.
        this.model = { op: {} };
        this.ca = new THREE.Color();
        this.cb = new THREE.Color();
        this.cc = new THREE.Color();
        this.wq = new THREE.Quaternion();
        this.cq = new THREE.Quaternion();
        this.ws = new THREE.Vector3();
        this.size = new THREE.Vector2();
        this.error = null;
    }

    /** A function putting the curve at parameter x for copy k into out, or null (with this.error). */
    sampler(obj, p, g) {
        if (isSplineObject(obj)) {
            const st = g.spline(obj.id) || solveLoose(obj, g);
            this.splineState = st;
            if (!st?.sol || (!st.sol.N && !st.sol.single)) { this.error = st?.sol?.error || 'No points'; return null; }
            return (x, k, out) => splineAt(st.sol, x, out);
        }
        const fns = ['fx', 'fy', 'fz'].map((key) => g.compile(p[key] ?? '0'));
        const bad = fns.find((c) => !c.fn || c.type !== 'num');
        if (bad) { this.error = bad.error || 'Pick a coordinate (.x .y .z) of a spline point'; return null; }
        const ctx = g.context();
        const [fx, fy, fz] = fns.map((c) => c.fn);
        return (x, k, out) => {
            ctx.t = x;
            ctx.k = k;
            out[0] = fx(ctx);
            out[1] = fy(ctx);
            out[2] = fz(ctx);
            return out;
        };
    }

    sync(obj, p, f) {
        this.op = p;
        this.model.op = p;
        this.object.userData.objectId = obj.id;
        const g = this.group;
        g.position.set(p.posX || 0, p.posY || 0, p.posZ || 0);
        g.rotation.set((p.rotX || 0) * D2R, (p.rotY || 0) * D2R, (p.rotZ || 0) * D2R);
        g.scale.setScalar(p.scale ?? 1);
        if (this.spinNode.parent && this.handle.parent !== this.spinNode.parent) this.spinNode.parent.add(this.handle);
        if (!this.handle.userData.dragging) {
            this.handle.position.copy(g.position);
            this.handle.rotation.copy(g.rotation);
            this.handle.scale.copy(g.scale);
        }
        this.bounds.makeEmpty();
        this.ribbon.mesh.castShadow = !!p.castShadow;
        // Hidden, its children (a spline's points) go too; faded out, only the curve does.
        g.visible = p.visible !== false;
        this.object.visible = g.visible;
        if (!g.visible || !f?.globals) return;
        if ((p.opacity ?? 1) <= 0.002) { this.ribbon.mesh.visible = false; this.dots.hide(); this.knots.hide(); this.head.hide(); return; }
        this.error = null;
        f.renderer?.getDrawingBufferSize(this.size);
        const fn = this.sampler(obj, p, f.globals);
        if (!fn) { this.ribbon.mesh.visible = false; this.dots.hide(); this.knots.hide(); this.head.hide(); this.applySpin(null); return; }
        // (Held as it is while its points are dragged.)
        if (f.holdSpin !== obj.id) this.applySpin(isSplineObject(obj) && f.frame ? spinAt(obj, f.time, f.frame.project, f.frame.analysis) : null);
        this.span = obj.type === 'manifold' ? musicSpan(p, this.splineState?.sol, f.time) : null;
        this.object.updateMatrixWorld(true);
        if (isPointsMode(p)) {
            this.ribbon.mesh.visible = false;
            this.drawDots(p, f, fn);
        } else {
            this.dots.hide();
            this.drawLine(p, f, fn);
        }
        this.drawKnots(obj, p, f);
        this.drawHead(obj, p, f);
    }

    copies(p) { return isSeries(p) ? Math.max(1, Math.min(64, Math.round(p.seriesCount || 1))) : 1; }

    /**
     * Turned by `q` ([x, y, z, w], in the scene's frame, or null for not at
     * all) about the middle of its defining points where they are now.
     */
    applySpin(q) {
        const sn = this.spinNode;
        if (!q) { sn.position.set(0, 0, 0); sn.quaternion.identity(); return; }
        const pts = this.splineState?.points || [];
        const c = this.spinC.set(0, 0, 0);
        let n = 0;
        pts.forEach((pt) => {
            if (!pt.every(Number.isFinite)) return;
            c.x += pt[0]; c.y += pt[1]; c.z += pt[2];
            n++;
        });
        if (n) c.divideScalar(n);
        // The middle in the scene's frame, held still while the rest turns about it.
        this.group.updateMatrix();
        c.applyMatrix4(this.group.matrix);
        const R = this.spinQ.set(q[0], q[1], q[2], q[3]);
        sn.quaternion.copy(R);
        sn.position.copy(c).sub(c.clone().applyQuaternion(R));
    }

    /** Grow this frame's bounds by the point at xyz[o..o+2], r around it. */
    grow(xyz, o, r) {
        const b = this.bounds;
        for (let d = 0; d < 3; d++) {
            const v = xyz[o + d];
            if (!Number.isFinite(v)) return;
            const lo = d === 0 ? 'x' : d === 1 ? 'y' : 'z';
            if (v - r < b.min[lo]) b.min[lo] = v - r;
            if (v + r > b.max[lo]) b.max[lo] = v + r;
        }
    }

    /** Where it was drawn this frame, in the world, or null if nothing was (what the sun aims its shadow at). */
    shadowBox() {
        if (this.bounds.isEmpty()) return null;
        this.object.updateMatrixWorld(true);
        return this.worldBounds.copy(this.bounds).applyMatrix4(this.group.matrixWorld);
    }

    /** Scene units per pixel of a 1080-tall frame where the curve is, as `camera` sees it. */
    worldPerPixel(camera) {
        if (!camera) return 0.002;
        if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / (camera.zoom || 1) / 1080;
        const at = this.group.getWorldPosition(this.v1 || (this.v1 = new THREE.Vector3()));
        const eye = camera.getWorldPosition(this.v2 || (this.v2 = new THREE.Vector3()));
        const fwd = camera.getWorldDirection(this.v3 || (this.v3 = new THREE.Vector3()));
        const depth = Math.max(0.01, at.sub(eye).dot(fwd));
        return (2 * depth * Math.tan(((camera.fov || 50) * D2R) / 2)) / 1080;
    }

    /** Copy k's offset, and its colour (or null to colour along the curve). */
    copyLook(p, k, C) {
        const m = p.seriesCentre ? k - (C - 1) / 2 : k;
        const off = [m * (p.seriesDX || 0), m * (p.seriesDY || 0), m * (p.seriesDZ || 0)];
        let solid = null;
        if (isSeries(p) && p.seriesColors !== false) {
            solid = this.cc.set(p.seriesColorA || '#ffffff').lerp(this.cb.set(p.seriesColorB || '#ffffff'), C > 1 ? k / (C - 1) : 0).clone();
        }
        return { off, solid };
    }

    /** Colour and alpha at u (0..1 along the copy's whole range) into rgba at o. */
    shade(p, u, solid, rgba, o) {
        const c = solid || this.ca.set(p.colorStart || '#ffffff').lerp(this.cb.set(p.colorEnd || '#ffffff'), u);
        rgba[o] = c.r;
        rgba[o + 1] = c.g;
        rgba[o + 2] = c.b;
        const fs = p.fadeStart ?? 1;
        rgba[o + 3] = Math.max(0, fs + ((p.fadeEnd ?? 1) - fs) * u);
    }

    drawLine(p, f, fn) {
        const C = this.copies(p);
        const S = Math.max(2, Math.min(8000, Math.round(p.samples || 400)));
        const strips = this.strips || (this.strips = []);
        strips.length = 0;
        const out = [0, 0, 0];
        const ws = p.widthStart ?? 1;
        const we = p.widthEnd ?? 1;
        const pixels = p.thicknessUnits === 'pixels';
        for (let k = 0; k < C; k++) {
            const [a, b] = copyRange(p, k);
            const frac = drawnFraction(p, k, f.time || 0);
            if (frac <= 0 || a === b) continue;
            const cut = withinMusic(...drawnRange(p, a, b, frac), this.span);
            if (!cut) continue;
            const [lo, hi] = cut;
            const { off, solid } = this.copyLook(p, k, C);
            const n = S + 1;
            const s = this.strip(k, n);
            for (let i = 0; i < n; i++) {
                const x = lo + ((hi - lo) * i) / S;
                fn(x, k, out);
                const ok = Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
                s.ok[i] = ok ? 1 : 0;
                s.xyz[i * 3] = out[0] + off[0];
                s.xyz[i * 3 + 1] = out[1] + off[1];
                s.xyz[i * 3 + 2] = out[2] + off[2];
                const u = (x - a) / (b - a);
                s.width[i] = Math.max(0, (p.thickness ?? 0.02) * (ws + (we - ws) * u));
                if (ok) this.grow(s.xyz, i * 3, pixels ? 0 : s.width[i] / 2);
                this.shade(p, u, solid, s.rgba, i * 4);
            }
            strips.push(s);
        }
        const r = this.ribbon;
        r.write(strips);
        const u = r.material.uniforms;
        u.uRes.value.copy(this.size);
        u.uPixels.value = p.thicknessUnits === 'pixels' ? 1 : 0;
        // Widths in pixels are of a 1080-tall frame; scene widths scale with the curve.
        if (p.thicknessUnits === 'pixels') u.uScale.value = 1;
        else u.uScale.value = this.group.getWorldScale(this.ws).x;
        u.uOpacity.value = Math.max(0, Math.min(1, p.opacity ?? 1));
        // From the sun the ribbon is as wide in the scene as it looks: pixels become scene units where it is.
        r.depth.uniforms.uScale.value = pixels ? this.worldPerPixel(f.camera) : u.uScale.value;
        if (pixels && p.castShadow) this.bounds.expandByScalar(((p.thickness ?? 0.02) * Math.max(ws, we) * r.depth.uniforms.uScale.value) / Math.max(1e-6, u.uScale.value || 1));
        r.material.depthWrite = (p.opacity ?? 1) >= 0.999 && (p.fadeStart ?? 1) >= 0.999 && (p.fadeEnd ?? 1) >= 0.999;
    }

    /** A strip's buffers for copy k, kept between frames. */
    strip(k, n) {
        const pool = this.pool || (this.pool = []);
        let s = pool[k];
        if (!s || s.cap < n) {
            s = {
                cap: n, xyz: new Float32Array(n * 3), ok: new Uint8Array(n), width: new Float32Array(n), rgba: new Float32Array(n * 4),
            };
            pool[k] = s;
        }
        s.n = n;
        return s;
    }

    /** Which way flat dots face: the camera, in the curve's own frame. */
    facing(f) {
        const q = this.cq.identity();
        if (f.camera) {
            this.group.getWorldQuaternion(this.wq).invert();
            f.camera.getWorldQuaternion(q);
            q.premultiply(this.wq);
        }
        return q;
    }

    drawDots(p, f, fn) {
        const C = this.copies(p);
        const N = Math.max(1, Math.min(20000, Math.round(p.dotCount || 1)));
        const total = C * N;
        if (!this.dotBuf || this.dotBuf.cap < total) {
            this.dotBuf = {
                cap: total, xyz: new Float32Array(total * 3), size: new Float32Array(total), rgba: new Float32Array(total * 4), spin: new Float32Array(total),
            };
        }
        const B = this.dotBuf;
        const time = f.time || 0;
        const bass = f.live && f.freq ? bassLevel(f.freq) : 0;
        const jitter = (p.jitter || 0) * (1 + 4 * (p.reactivity || 0) * bass);
        const flow = p.flowSpeed || 0;
        const ws = p.widthStart ?? 1;
        const we = p.widthEnd ?? 1;
        const spinRate = (p.spin || 0) * D2R;
        const out = [0, 0, 0];
        let j = 0;
        for (let k = 0; k < C; k++) {
            const [a, b] = copyRange(p, k);
            const frac = drawnFraction(p, k, time);
            if (frac <= 0) continue;
            const cut = withinMusic(...drawnRange(p, a, b, frac), this.span);
            if (!cut) continue;
            const [lo, hi] = cut;
            const { off, solid } = this.copyLook(p, k, C);
            for (let i = 0; i < N; i++) {
                // Still, the dots span the drawn range end to end; flowing,
                // they move along it and wrap.
                let v = flow ? i / N + flow * time : (N > 1 ? i / (N - 1) : 0);
                if (flow) v -= Math.floor(v);
                const x = lo + (hi - lo) * v;
                fn(x, k, out);
                const o = j * 3;
                B.xyz[o] = out[0] + off[0] + (hash3(i, k, 0) * 2 - 1) * jitter;
                B.xyz[o + 1] = out[1] + off[1] + (hash3(i, k, 1) * 2 - 1) * jitter;
                B.xyz[o + 2] = out[2] + off[2] + (hash3(i, k, 2) * 2 - 1) * jitter;
                const u = b !== a ? (x - a) / (b - a) : 0;
                B.size[j] = Math.max(0, (p.dotSize ?? 0.04) * (ws + (we - ws) * u));
                this.grow(B.xyz, o, B.size[j]);
                B.spin[j] = spinRate * time + hash3(i, k, 3) * Math.PI * 2;
                this.shade(p, u, solid, B.rgba, j * 4);
                j++;
            }
        }
        this.dots.write(j, B.xyz, B.size, B.rgba, {
            shape: p.pointShape || 'tetra',
            lit: !!p.lit,
            face: this.facing(f),
            spin: spinRate ? B.spin : null,
            opacity: p.opacity ?? 1,
            wire: p.pointStyle === 'wire',
            wireWidth: p.pointWire,
            resolution: this.size,
            castShadow: !!p.castShadow,
        });
    }

    /** A spline's defining points, where they are now. */
    drawKnots(obj, p, f) {
        const st = isSplineObject(obj) ? this.splineState : null;
        if (!st || !p.showKnots || !st.points.length) { this.knots.hide(); return; }
        // Points that are objects of their own (the spline's children) draw their own markers.
        let idx = st.points.map((pt, i) => i).filter((i) => !this.knotOwners?.has(i));
        // A Manifold's keypoints: once the music (or the drawn u) has reached them.
        const grow = new Map();
        if (obj.type === 'manifold' && (this.span || p.pointsByU)) {
            const span = drawnSpan(p, f.time);
            const cut = span && withinMusic(span[0], span[1], this.span);
            const us = knotU(st.sol);
            const over = Math.max(0, p.pointsAppear || 0);
            const eps = 1e-6;
            idx = cut ? idx.filter((i) => {
                const u = us[i];
                if (!(u >= cut[0] - eps && u <= cut[1] + eps)) return false;
                if (over > 0) {
                    const lead = !this.span && p.revealFrom === 'end' ? u - cut[0]
                        : !this.span && p.revealFrom === 'centre' ? Math.min(u - cut[0], cut[1] - u) : cut[1] - u;
                    const x = Math.max(0, Math.min(1, lead / over));
                    grow.set(i, x * x * (3 - 2 * x));
                }
                return true;
            }) : [];
        }
        if (!idx.length) { this.knots.hide(); return; }
        const n = idx.length;
        const xyz = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const rgba = new Float32Array(n * 4);
        const spin = p.knotSpin ? new Float32Array(n) : null;
        const c = this.ca.set(p.knotColor || '#ffffff');
        idx.forEach((k, i) => {
            xyz.set(st.points[k], i * 3);
            size[i] = (p.knotSize ?? 0.035) * (grow.has(k) ? grow.get(k) : 1);
            this.grow(xyz, i * 3, size[i]);
            rgba.set([c.r, c.g, c.b, 1], i * 4);
            if (spin) spin[i] = knotAngle(p, k, f.time);
        });
        this.knots.write(n, xyz, size, rgba, {
            shape: p.knotShape || 'octa',
            lit: false,
            face: this.facing(f),
            spin,
            spinAxis: p.knotSpinAxis,
            opacity: p.opacity ?? 1,
            wire: p.knotStyle === 'wire',
            wireWidth: p.knotWire,
            resolution: this.size,
            castShadow: !!p.castShadow,
        });
    }

    /** A Manifold coming in with the music: a marker where the sound is now. */
    drawHead(obj, p, f) {
        const ms = this.span;
        const sol = this.splineState?.sol;
        const span = ms && p.headOn ? drawnSpan(p, f.time) : null;
        const cut = span && withinMusic(span[0], span[1], ms);
        if (!cut || !sol) { this.head.hide(); return; }
        const at = splineAt(sol, cut[1], [0, 0, 0]);
        if (!at.every(Number.isFinite)) { this.head.hide(); return; }
        const c = this.ca.set(p.headColor || '#ffffff');
        const xyz = Float32Array.from(at);
        this.grow(xyz, 0, p.headSize ?? 0.05);
        this.head.write(1, xyz, Float32Array.of(p.headSize ?? 0.05), Float32Array.of(c.r, c.g, c.b, 1), {
            shape: p.headShape || 'sphere',
            lit: false,
            face: this.facing(f),
            spin: null,
            opacity: p.opacity ?? 1,
            wire: false,
            resolution: this.size,
            castShadow: !!p.castShadow,
        });
    }

    update() {}

    dispose() {
        this.ribbon.dispose();
        this.dots.dispose();
        this.knots.dispose();
        this.head.dispose();
        this.spinNode.removeFromParent();
        this.handle.removeFromParent();
    }
}
