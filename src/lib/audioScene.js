// Audio-reactive scene engine, shared by the Audio Visualizer and the Scan
// Compositor. Both place the same kinds of item - point clouds sampled from a
// PLY or a sphere, and dots flowing along a parametric curve - and drive them
// from the same FFT, so the behaviour stays identical between the two tools
// and there is only one copy of the maths to maintain.
//
// Everything here is renderer-agnostic: nothing touches a camera, a composer
// or the DOM. A host supplies the scene graph and the animation loop.

import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

// Available assets. `type` is one of 'sphere' | 'ply' | 'glb'.
export const ASSETS = [
    { id: 'sphere', name: 'Default Sphere', path: null, type: 'sphere' },
    { id: 'point_cloud', name: 'Point Cloud', path: 'assets/point_cloud.ply', type: 'ply' },
    { id: 'pepper', name: 'Pepper', path: 'assets/pepper.ply', type: 'ply' },
    { id: 'fairview_4a', name: 'Fairview 4A', path: 'assets/fairview_4a.ply', type: 'ply' },
    { id: 'fairview_2b', name: 'Fairview 2B', path: 'assets/fairview_2b.ply', type: 'ply' },
    { id: 'snow', name: 'Snow', path: 'assets/snow.ply', type: 'ply' },
    { id: 'asterisk', name: 'Asterisk (GLB)', path: 'assets/asterisk.gltf', type: 'glb' },
    { id: 'sleepycat', name: 'Sleepy Cat', path: 'assets/sleeepycat.ply', type: 'ply' },
];

// Bundled music tracks. Either tool can also play a file off disk.
export const MUSIC_ASSETS = [
    { id: 'test', name: 'Test Track', path: 'assets/test.mp3' },
    { id: 'sleepycat', name: 'Sleepy Cat', path: 'assets/sleepycat.mp3' },
    { id: 'maestro', name: 'Maestro', path: 'assets/maestro.mp3' },
];

// Single-variable parametric curves. `fn(t)` returns a point in roughly the
// [-1, 1] cube; it gets scaled by the per-curve `curveScale`.
export const CURVES = [
    {
        id: 'helix', name: 'Helix', tMin: 0, tMax: Math.PI * 6,
        fn: (t) => ({ x: Math.cos(t), y: (t / (Math.PI * 6)) * 2 - 1, z: Math.sin(t) }),
    },
    {
        id: 'lissajous', name: 'Lissajous', tMin: 0, tMax: Math.PI * 2,
        fn: (t) => ({ x: Math.sin(3 * t), y: Math.sin(2 * t), z: Math.cos(4 * t) }),
    },
    {
        id: 'rose', name: 'Rose', tMin: 0, tMax: Math.PI * 2,
        fn: (t) => { const r = Math.cos(4 * t); return { x: r * Math.cos(t), y: r * Math.sin(t), z: Math.sin(3 * t) * 0.25 }; },
    },
    {
        id: 'trefoil', name: 'Trefoil Knot', tMin: 0, tMax: Math.PI * 2,
        fn: (t) => ({
            x: (Math.sin(t) + 2 * Math.sin(2 * t)) / 3,
            y: (Math.cos(t) - 2 * Math.cos(2 * t)) / 3,
            z: -Math.sin(3 * t) / 3,
        }),
    },
    {
        id: 'figure8', name: 'Figure Eight', tMin: 0, tMax: Math.PI * 2,
        fn: (t) => ({ x: Math.sin(t), y: Math.sin(t) * Math.cos(t), z: Math.cos(t) * 0.3 }),
    },
    {
        id: 'spiral', name: 'Spiral', tMin: 0, tMax: Math.PI * 8,
        fn: (t) => { const k = t / (Math.PI * 8); return { x: k * Math.cos(t), y: k * 2 - 1, z: k * Math.sin(t) }; },
    },
    {
        id: 'torusKnot', name: 'Torus Knot', tMin: 0, tMax: Math.PI * 2,
        fn: (t) => {
            const p = 2, q = 3; const r = Math.cos(q * t) + 2;
            return { x: r * Math.cos(p * t) / 3, y: r * Math.sin(p * t) / 3, z: -Math.sin(q * t) / 3 };
        },
    },
];

// Per-object parameters. Every placed asset gets its own copy.
export const OBJECT_DEFAULTS = {
    // Geometry (rebuilds the point cloud)
    samples: 30000,
    radius: 8,
    jitter: 0.01,
    pointSize: 0.005,
    maxPoints: 150000,
    // Sphere colouring. Each dot blends from colour A to colour B by where it
    // sits on the sphere: its depth through the jittered shell, its height, or
    // a mix of the two. Changing these recolours in place, without a rebuild.
    sphereColorA: '#e87d7d',
    sphereColorB: '#e8c27d',
    sphereGradient: 0,
    sphereHueShift: 0,
    // Audio reactivity
    reactivity: 0.5,
    scatter: 0.002,
    // Fraction of the audio spectrum (0 = lowest bin, 1 = highest bin) the
    // point cloud reacts to. freqRangeMin/Max define the sub-band.
    freqRangeMin: 0,
    freqRangeMax: 1,
    originX: 0,
    originY: 0,
    originZ: 0,
    // Transform
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 1,
};

// Per-curve parameters. Every placed parametric curve gets its own copy.
export const CURVE_DEFAULTS = {
    // Shape / flow
    curveScale: 8,
    dotCount: 240,
    dotSize: 0.045,
    jitter: 0.05,
    flowSpeed: 0.15,
    startColor: '#ff3b3b',
    endColor: '#3bb0ff',
    // Audio reactivity
    reactivity: 0.6,
    // Transform
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 1,
};

// Changing any of these means the instanced geometry has to be rebuilt rather
// than just re-parameterised.
export const GEOM_KEYS = ['samples', 'radius', 'jitter', 'pointSize', 'maxPoints'];
export const CURVE_GEOM_KEYS = ['dotCount', 'dotSize'];
// Changing any of these only rewrites the instance colours.
export const SPHERE_COLOR_KEYS = ['sphereColorA', 'sphereColorB', 'sphereGradient', 'sphereHueShift'];
export const sphereColorKey = (op) => SPHERE_COLOR_KEYS.map((k) => op[k]).join('|');

// Menu layout. `scope` is 'object' (selected item) or 'global' (scene).
// Object groups carry a `kind`: 'asset', 'curve', or 'both'. A host shows
// whichever scopes it supports - the Scan Compositor has no fly camera or
// composer, so it renders the object scope only.
export const PARAM_GROUPS = [
    {
        title: 'Geometry',
        scope: 'object',
        kind: 'asset',
        params: [
            { key: 'samples', label: 'Points', min: 1000, max: 300000, step: 1000, sphereOnly: true },
            { key: 'radius', label: 'Radius', min: 1, max: 20, step: 0.1, sphereOnly: true },
            { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.001, sphereOnly: true },
            { key: 'pointSize', label: 'Dot Size', min: 0.001, max: 0.05, step: 0.001, cloudOnly: true },
            { key: 'maxPoints', label: 'Max Dots', min: 1000, max: 150000, step: 1000, cloudOnly: true },
        ],
    },
    {
        title: 'Sphere Colour',
        scope: 'object',
        kind: 'asset',
        sphereOnly: true,
        params: [
            { key: 'sphereColorA', label: 'Colour A', type: 'color', sphereOnly: true },
            { key: 'sphereColorB', label: 'Colour B', type: 'color', sphereOnly: true },
            { key: 'sphereGradient', label: 'Depth→Height', min: 0, max: 1, step: 0.01, sphereOnly: true },
            { key: 'sphereHueShift', label: 'Hue Shift', min: 0, max: 1, step: 0.01, sphereOnly: true },
        ],
    },
    {
        title: 'Curve',
        scope: 'object',
        kind: 'curve',
        params: [
            { key: 'curveScale', label: 'Size', min: 1, max: 24, step: 0.1 },
            { key: 'dotCount', label: 'Dots', min: 10, max: 3000, step: 10 },
            { key: 'dotSize', label: 'Dot Size', min: 0.005, max: 0.2, step: 0.005 },
            { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.005 },
            { key: 'flowSpeed', label: 'Flow', min: 0, max: 2, step: 0.01 },
            { key: 'startColor', label: 'Start Color', type: 'color' },
            { key: 'endColor', label: 'End Color', type: 'color' },
        ],
    },
    {
        title: 'Transform',
        scope: 'object',
        kind: 'both',
        params: [
            { key: 'posX', label: 'Pos X', min: -50, max: 50, step: 0.1, point: 'transform' },
            { key: 'posY', label: 'Pos Y', min: -50, max: 50, step: 0.1, point: 'transform' },
            { key: 'posZ', label: 'Pos Z', min: -50, max: 50, step: 0.1, point: 'transform' },
            { type: 'gizmoButtons' },
            { key: 'rotX', label: 'Rot X', min: -180, max: 180, step: 1 },
            { key: 'rotY', label: 'Rot Y', min: -180, max: 180, step: 1 },
            { key: 'rotZ', label: 'Rot Z', min: -180, max: 180, step: 1 },
            { key: 'scale', label: 'Scale', min: 0.05, max: 10, step: 0.05 },
        ],
    },
    {
        title: 'Audio Reactivity',
        scope: 'object',
        kind: 'asset',
        params: [
            { key: 'reactivity', label: 'Reactivity', min: 0, max: 3, step: 0.01 },
            { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.001, cloudOnly: true },
            { key: 'freqRangeMin', label: 'Freq Low', min: 0, max: 1, step: 0.01, cloudOnly: true },
            { key: 'freqRangeMax', label: 'Freq High', min: 0, max: 1, step: 0.01, cloudOnly: true },
            { key: 'originX', label: 'Pulse X', min: -20, max: 20, step: 0.1, point: 'pulse', cloudOnly: true },
            { key: 'originY', label: 'Pulse Y', min: -20, max: 20, step: 0.1, point: 'pulse', cloudOnly: true },
            { key: 'originZ', label: 'Pulse Z', min: -20, max: 20, step: 0.1, point: 'pulse', cloudOnly: true },
        ],
    },
    {
        title: 'Audio Reactivity',
        scope: 'object',
        kind: 'curve',
        params: [
            { key: 'reactivity', label: 'Reactivity', min: 0, max: 3, step: 0.01 },
        ],
    },
    {
        title: 'Post FX',
        scope: 'global',
        params: [
            { key: 'bloomStrength', label: 'Glow', min: 0, max: 3, step: 0.01 },
            { key: 'bloomRadius', label: 'Glow Spread', min: 0, max: 2, step: 0.01 },
            { key: 'bloomThreshold', label: 'Glow Floor', min: 0, max: 1, step: 0.01 },
            { key: 'haze', label: 'Haze', min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        title: 'Navigation',
        scope: 'global',
        params: [
            { key: 'moveSpeed', label: 'Fly Speed', min: 0, max: 100, step: 1 },
            { key: 'damping', label: 'Damping', min: 0, max: 0.3, step: 0.01 },
        ],
    },
];

// ---- Helpers ------------------------------------------------------------

export function getR(x, y, z) {
    const r = Math.abs(x) ** 2 + Math.abs(y) ** 2 + Math.abs(z) ** 2;
    return r ** 0.5;
}

// Uniform random sample of `k` items via partial Fisher-Yates. Always random,
// never order-dependent, so downsampling never carves out spatial holes.
export function sampleRandom(arr, k) {
    const n = arr.length;
    const out = arr.slice();
    const take = Math.min(k, n);
    for (let i = 0; i < take; i++) {
        const j = i + Math.floor(Math.random() * (n - i));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
    }
    return out.slice(0, take);
}

export function fibonacciSphere(samples = 1000, radius = 10, randomOffset = 0.1) {
    const points = [];
    const phi = Math.PI * (Math.sqrt(5) - 1);

    for (let i = 0; i < samples; i++) {
        let y = 1 - (i / (samples - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = phi * i;

        let x = Math.cos(theta) * r;
        let z = Math.sin(theta) * r;

        x += (Math.random() - 0.5) * randomOffset;
        y += (Math.random() - 0.5) * randomOffset;
        z += (Math.random() - 0.5) * randomOffset;

        points.push({ x: x * radius, y: y * radius, z: z * radius });
    }

    return points;
}

let instanceCounter = 0;
export const nextInstanceId = () => `item_${Date.now().toString(36)}_${(instanceCounter++)}`;

export const makeItem = (assetId, reactive = true, overrides = {}) => ({
    id: nextInstanceId(),
    kind: 'asset',
    assetId,
    reactive,
    op: { ...OBJECT_DEFAULTS, ...overrides },
});

export const makeCurveItem = (funcId, reactive = true, overrides = {}) => ({
    id: nextInstanceId(),
    kind: 'curve',
    funcId,
    reactive,
    op: { ...CURVE_DEFAULTS, ...overrides },
});

// ---- Loading ------------------------------------------------------------

/**
 * Read a PLY into the plain point array the builders expect, memoised by path.
 *
 * @param {string} path relative to PUBLIC_URL
 * @param {Map} cache  path -> points, shared by the caller across items
 * @returns {Promise<Array<{x,y,z,color?}>>}
 */
export function loadPlyPoints(path, cache) {
    const cached = cache.get(path);
    if (cached) return Promise.resolve(cached);

    return new PLYLoader()
        .loadAsync(`${process.env.PUBLIC_URL}/${path}`)
        .then((geometry) => {
            const pos = geometry.getAttribute('position');
            const col = geometry.getAttribute('color');
            const points = [];
            for (let i = 0; i < pos.count; i++) {
                points.push({
                    x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i),
                    color: col
                        ? { r: col.getX(i), g: col.getY(i), b: col.getZ(i) }
                        : null,
                });
            }
            geometry.dispose();
            cache.set(path, points);
            return points;
        });
}

// ---- Builders -----------------------------------------------------------

/**
 * Write generated colours for every instance that has no colour of its own.
 *
 * `t` runs 0..1 across the sphere and picks the blend between colour A and B:
 * at `sphereGradient` 0 it is the dot's depth through the jittered shell
 * (inner = A, outer = B), at 1 its height (bottom = A, top = B). The hue
 * shift then rotates the whole result around the colour wheel.
 *
 * @param {Float32Array} positions xyz per instance, in the record's local space
 * @param {Float32Array} out rgb per instance, written in place
 * @param {object} op per-object parameters
 */
export function writeSphereColors(positions, out, op) {
    const n = Math.min(positions.length, out.length) / 3;
    const radius = op.radius || 1;
    const jitter = op.jitter || 0;
    const g = Math.max(0, Math.min(1, op.sphereGradient ?? 0));
    const shift = op.sphereHueShift ?? 0;
    const colA = new THREE.Color(op.sphereColorA ?? OBJECT_DEFAULTS.sphereColorA);
    const colB = new THREE.Color(op.sphereColorB ?? OBJECT_DEFAULTS.sphereColorB);
    const scratch = new THREE.Color();
    const hsl = { h: 0, s: 0, l: 0 };
    for (let i = 0; i < n; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        // The jitter displaces each axis by up to half its amount, so the
        // shell is roughly radius * (1 +- jitter / 2) thick.
        const depth = jitter > 1e-6
            ? (getR(x, y, z) / radius - 1) / jitter + 0.5
            : 0.5;
        const height = y / radius * 0.5 + 0.5;
        let t = depth + (height - depth) * g;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        scratch.copy(colA).lerp(colB, t);
        if (shift) {
            scratch.getHSL(hsl);
            scratch.setHSL((hsl.h + shift) % 1, hsl.s, hsl.l);
        }
        out[i * 3] = scratch.r;
        out[i * 3 + 1] = scratch.g;
        out[i * 3 + 2] = scratch.b;
    }
}

/**
 * Recolour a point-cloud record whose dots carry no colour of their own (the
 * generated sphere), after its colour parameters change. No-op otherwise.
 */
export function recolorPointCloud(record, op) {
    if (!record || !record.instancedMesh || record.hasOriginalColors) return;
    const attr = record.instancedMesh.instanceColor;
    if (!attr) return;
    writeSphereColors(record.basePositions, attr.array, op);
    attr.needsUpdate = true;
    record.colorKey = sphereColorKey(op);
}

/**
 * Build an InstancedMesh of tetrahedra, one per point.
 *
 * @param {Array} rawPoints points with x/y/z and optional color
 * @param {object} op per-object parameters
 * @param {string} type 'sphere' | 'ply'
 * @returns {object} a scene record the update loop understands
 */
export function buildPointCloudRecord(rawPoints, op, type) {
    const limited = sampleRandom(rawPoints, op.maxPoints);
    const count = limited.length;

    const hasOriginalColors = count > 0 && !!limited[0].color;

    const geometry = new THREE.TetrahedronGeometry(op.pointSize * 1.2, 0);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
    const mesh = new THREE.InstancedMesh(geometry, material, count);

    const dummy = new THREE.Object3D();
    const colors = new Float32Array(count * 3);
    const basePositions = new Float32Array(count * 3);
    const scratch = new THREE.Color();

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    for (let i = 0; i < count; i++) {
        const p = limited[i];
        dummy.position.set(p.x, p.y, p.z);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        basePositions[i * 3] = p.x;
        basePositions[i * 3 + 1] = p.y;
        basePositions[i * 3 + 2] = p.z;

        if (p.color) {
            scratch.setRGB(p.color.r, p.color.g, p.color.b);
            colors[i * 3] = scratch.r;
            colors[i * 3 + 1] = scratch.g;
            colors[i * 3 + 2] = scratch.b;
        }

        if (p.x < min.x) min.x = p.x; if (p.y < min.y) min.y = p.y; if (p.z < min.z) min.z = p.z;
        if (p.x > max.x) max.x = p.x; if (p.y > max.y) max.y = p.y; if (p.z > max.z) max.z = p.z;
    }

    if (!hasOriginalColors) writeSphereColors(basePositions, colors, op);

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    mesh.frustumCulled = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();

    const localBox = count > 0
        ? new THREE.Box3(min, max)
        : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

    return {
        type,
        kind: 'asset',
        object3D: mesh,
        transformTarget: mesh,
        reactiveScaleTarget: null,
        instancedMesh: mesh,
        count,
        basePositions,
        hasOriginalColors,
        colorKey: sphereColorKey(op),
        localBox,
        dirs: null,
        dists: null,
        freqIndex: null,
        dirty: false,
    };
}

/**
 * Build an InstancedMesh of dots that flow along a parametric curve.
 *
 * @param {string} funcId id from CURVES
 * @param {object} op per-curve parameters
 * @returns {object} a scene record the update loop understands
 */
export function buildCurveRecord(funcId, op) {
    const curve = CURVES.find((c) => c.id === funcId) || CURVES[0];
    const count = Math.max(1, Math.round(op.dotCount));

    const geometry = new THREE.TetrahedronGeometry(op.dotSize * 1.2, 0);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
    const mesh = new THREE.InstancedMesh(geometry, material, count);

    const dummy = new THREE.Object3D();
    dummy.updateMatrix();
    const phases = new Float32Array(count);
    const jitterOffsets = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const colA = new THREE.Color(op.startColor);
    const colB = new THREE.Color(op.endColor);

    for (let i = 0; i < count; i++) {
        mesh.setMatrixAt(i, dummy.matrix);
        const u = i / count;
        phases[i] = u;
        jitterOffsets[i * 3] = Math.random() * 2 - 1;
        jitterOffsets[i * 3 + 1] = Math.random() * 2 - 1;
        jitterOffsets[i * 3 + 2] = Math.random() * 2 - 1;
        colors[i * 3] = colA.r + (colB.r - colA.r) * u;
        colors[i * 3 + 1] = colA.g + (colB.g - colA.g) * u;
        colors[i * 3 + 2] = colA.b + (colB.b - colA.b) * u;
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.frustumCulled = false;

    const amp = op.curveScale;
    const span = curve.tMax - curve.tMin;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const samplesN = 200;
    for (let i = 0; i <= samplesN; i++) {
        const t = curve.tMin + (i / samplesN) * span;
        const p = curve.fn(t);
        const x = p.x * amp, y = p.y * amp, z = p.z * amp;
        if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
        if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
    }

    return {
        kind: 'curve',
        type: 'curve',
        object3D: mesh,
        transformTarget: mesh,
        reactiveScaleTarget: null,
        instancedMesh: mesh,
        count,
        curve,
        phases,
        jitterOffsets,
        colA,
        colB,
        flow: 0,
        localBox: new THREE.Box3(min, max),
        dirty: false,
    };
}

/** Push an item's transform parameters onto its Object3D. */
export function applyRecordTransform(record, op) {
    const target = record.transformTarget;
    if (!target || !op) return;
    target.position.set(op.posX, op.posY, op.posZ);
    target.rotation.set(
        THREE.MathUtils.degToRad(op.rotX),
        THREE.MathUtils.degToRad(op.rotY),
        THREE.MathUtils.degToRad(op.rotZ),
    );
    target.scale.setScalar(op.scale);
}

/** Free a record's GPU resources. */
export function disposeRecord(record) {
    if (!record || !record.object3D) return;
    record.object3D.parent?.remove(record.object3D);
    record.object3D.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
    });
}

// ---- Audio --------------------------------------------------------------

/**
 * Mean of the lowest few FFT bins, normalised to 0..1.
 *
 * Used wherever something should pulse with the beat rather than with a
 * particular pitch.
 */
export function bassLevel(frequencyData) {
    if (!frequencyData) return 0;
    let sum = 0;
    for (let b = 0; b < 8; b++) sum += frequencyData[b];
    return sum / 8 / 255;
}

/**
 * Mean level of one slice of the spectrum, normalised to 0..1.
 *
 * `bassLevel` is the special case of this with the band pinned to the bottom
 * eight bins; anything that wants to listen to a chosen range of the music -
 * a kick, a hi-hat, a vocal - reads it through here instead.
 *
 * @param {Uint8Array|null} frequencyData FFT bins, or null when silent
 * @param {number} low band start as a fraction of the spectrum
 * @param {number} high band end as a fraction of the spectrum
 * @returns {number} 0..1
 */
export function bandLevel(frequencyData, low = 0, high = 1) {
    if (!frequencyData || !frequencyData.length) return 0;
    const bins = frequencyData.length;
    const a = Math.max(0, Math.min(1, low));
    const b = Math.max(0, Math.min(1, high));
    const lo = Math.round(Math.min(a, b) * (bins - 1));
    const hi = Math.round(Math.max(a, b) * (bins - 1));
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += frequencyData[k];
    return sum / (hi - lo + 1) / 255;
}

/**
 * Turn a band level into a 0..1 control signal.
 *
 * Two shapes, because the two are musically different: `band` follows the
 * level continuously above a floor, which breathes with the track, while
 * `gate` is a threshold - fully on or fully off - which snaps on the beat.
 * The follower is a plain exponential, so the same spectrum sequence always
 * produces the same envelope and an export matches its preview.
 *
 * @param {object} env mutable follower state, `{ v }`
 * @param {number} level 0..1 band level
 * @param {object} opts { mode, threshold, invert, smooth }
 * @returns {number} 0..1
 */
export function envelopeFollow(env, level, {
    mode = 'band', threshold = 0.3, invert = false, smooth = 0.5,
} = {}) {
    const thr = Math.max(0, Math.min(0.99, threshold));
    let target;
    if (mode === 'gate') {
        target = level >= thr ? 1 : 0;
    } else {
        target = Math.max(0, (level - thr) / (1 - thr));
    }
    if (invert) target = 1 - target;
    const k = Math.max(0, Math.min(0.95, smooth));
    env.v = k * (env.v ?? 0) + (1 - k) * target;
    return Math.max(0, Math.min(1, env.v));
}

/**
 * Set the opacity of every placed object in one go.
 *
 * Objects are built with their own materials rather than sharing one, so this
 * walks the records; it is the only way a host can fade the whole placed
 * scene without touching each item's parameters.
 *
 * @param {Iterable} records scene records from the builders
 * @param {number} value 0..1
 */
export function applySceneOpacity(records, value) {
    const v = Math.max(0, Math.min(1, value));
    records.forEach((rec) => {
        if (!rec || rec.loading || !rec.object3D) return;
        rec.object3D.traverse?.((o) => {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => {
                if (!m) return;
                m.transparent = true;
                m.opacity = v;
                m.depthWrite = v >= 1;
            });
        });
        rec.object3D.visible = v > 0.002;
    });
}

/**
 * Advance every record for one frame.
 *
 * Point clouds push each instance out along its own direction from the pulse
 * origin, by an amount read from the FFT bin its resting distance maps to -
 * so the cloud blooms outward in rings rather than uniformly. Curves flow
 * their dots along the path and widen their jitter with the bass. GLB assets
 * simply pulse in scale.
 *
 * @param {Iterable} records scene records from the builders
 * @param {Uint8Array|null} frequencyData FFT bins, or null when silent
 * @param {number} dt seconds since the previous frame
 * @param {boolean} playing whether audio is actually running
 */
export function applyAudioReactivity(records, frequencyData, dt, playing) {
    const live = playing && !!frequencyData;
    const bass = live ? bassLevel(frequencyData) : 0;

    records.forEach((rec) => {
        if (!rec || rec.loading || !rec.op) return;
        const op = rec.op;

        if (rec.kind === 'curve') {
            const mesh = rec.instancedMesh;
            if (!mesh) return;
            const { curve } = rec;
            const { count } = rec;
            const amp = op.curveScale;
            const span = curve.tMax - curve.tMin;
            const reactBoost = (rec.reactive && live) ? op.reactivity * bass : 0;
            rec.flow += op.flowSpeed * (1 + reactBoost) * dt;
            if (rec.flow > 1e6) rec.flow = 0; // avoid float drift over time
            const jitterAmp = op.jitter * amp * (1 + reactBoost * 4);
            const arr = mesh.instanceMatrix.array;
            const carr = mesh.instanceColor.array;
            const { colA, colB, jitterOffsets: jit, phases: ph } = rec;
            for (let i = 0; i < count; i++) {
                let u = ph[i] + rec.flow;
                u -= Math.floor(u);
                const t = curve.tMin + u * span;
                const p = curve.fn(t);
                const m = i * 16;
                arr[m + 12] = p.x * amp + jit[i * 3] * jitterAmp;
                arr[m + 13] = p.y * amp + jit[i * 3 + 1] * jitterAmp;
                arr[m + 14] = p.z * amp + jit[i * 3 + 2] * jitterAmp;
                carr[i * 3] = colA.r + (colB.r - colA.r) * u;
                carr[i * 3 + 1] = colA.g + (colB.g - colA.g) * u;
                carr[i * 3 + 2] = colA.b + (colB.b - colA.b) * u;
            }
            mesh.instanceMatrix.needsUpdate = true;
            mesh.instanceColor.needsUpdate = true;
            return;
        }

        if (rec.type === 'glb') {
            if (rec.reactive && live && rec.reactiveScaleTarget) {
                rec.reactiveScaleTarget.scale.setScalar(1 + op.reactivity * bass);
                rec.dirty = true;
            } else if (rec.dirty && rec.reactiveScaleTarget) {
                rec.reactiveScaleTarget.scale.setScalar(1);
                rec.dirty = false;
            }
            return;
        }

        const mesh = rec.instancedMesh;
        if (!mesh) return;

        const ox = op.originX, oy = op.originY, oz = op.originZ;
        const react = op.reactivity, scatter = op.scatter;

        if (rec.reactive && live) {
            if (!rec.dirs) {
                const n = rec.count;
                const base = rec.basePositions;
                const dirs = new Float32Array(n * 3);
                const dists = new Float32Array(n);
                const freqIndex = new Uint16Array(n);
                const bins = frequencyData.length;
                // Restrict reactivity to the chosen sub-band of the spectrum.
                const fLo = Math.max(0, Math.min(1, op.freqRangeMin ?? 0));
                const fHi = Math.max(0, Math.min(1, op.freqRangeMax ?? 1));
                const loBin = Math.round(Math.min(fLo, fHi) * (bins - 1));
                const hiBin = Math.round(Math.max(fLo, fHi) * (bins - 1));
                const bandSpan = Math.max(1, hiBin - loBin);
                for (let i = 0; i < n; i++) {
                    const dx = base[i * 3] - ox;
                    const dy = base[i * 3 + 1] - oy;
                    const dz = base[i * 3 + 2] - oz;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    dists[i] = dist;
                    let fidx = loBin + Math.floor((dist / 64) * bandSpan);
                    if (fidx > hiBin) fidx = hiBin;
                    else if (fidx < loBin) fidx = loBin;
                    freqIndex[i] = fidx;
                    if (dist > 1e-6) {
                        dirs[i * 3] = dx / dist;
                        dirs[i * 3 + 1] = dy / dist;
                        dirs[i * 3 + 2] = dz / dist;
                    }
                }
                rec.dirs = dirs;
                rec.dists = dists;
                rec.freqIndex = freqIndex;
            }

            const arr = mesh.instanceMatrix.array;
            const { dirs, dists, freqIndex: fi, count: n } = rec;
            for (let i = 0; i < n; i++) {
                const freq = frequencyData[fi[i]] / 255;
                const randomFactor = 0.5 + (Math.random() - 0.5) * scatter;
                const d = dists[i] * (1 + react * (freq * randomFactor));
                const m = i * 16;
                arr[m + 12] = ox + dirs[i * 3] * d;
                arr[m + 13] = oy + dirs[i * 3 + 1] * d;
                arr[m + 14] = oz + dirs[i * 3 + 2] * d;
            }
            mesh.instanceMatrix.needsUpdate = true;
            rec.dirty = true;
        } else if (rec.dirty) {
            // Settle back to the resting positions exactly once.
            const arr = mesh.instanceMatrix.array;
            const base = rec.basePositions;
            for (let i = 0; i < rec.count; i++) {
                const m = i * 16;
                arr[m + 12] = base[i * 3];
                arr[m + 13] = base[i * 3 + 1];
                arr[m + 14] = base[i * 3 + 2];
            }
            mesh.instanceMatrix.needsUpdate = true;
            rec.dirty = false;
        }
    });
}

// ---- Offline analysis ---------------------------------------------------
// An AnalyserNode only reports the spectrum of audio that is playing right
// now, which is useless to a frame-accurate exporter: it renders frame 37 of
// the timeline whenever it gets there, not 37/fps seconds after pressing play.
// So for export the spectrum is computed ahead of time, straight off the
// decoded samples, producing exactly what the analyser would have reported at
// each frame's timestamp.

/** In-place iterative radix-2 FFT on separate real/imaginary arrays. */
function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ar = re[i + k];
                const ai = im[i + k];
                const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ar + br;
                im[i + k] = ai + bi;
                re[i + k + len / 2] = ar - br;
                im[i + k + len / 2] = ai - bi;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

/**
 * Pre-compute one FFT frame per video frame, matching getByteFrequencyData.
 *
 * Mirrors the AnalyserNode's own pipeline - Blackman window, magnitude in dB,
 * mapped from [minDb, maxDb] onto 0..255, with the same exponential smoothing
 * between frames - so an exported clip reacts exactly as the preview did.
 *
 * @param {AudioBuffer} audioBuffer decoded audio
 * @param {object} opts
 * @param {number} opts.fps video frame rate
 * @param {number} opts.frameCount how many frames to analyse
 * @param {number} [opts.offset] seconds into the track that frame 0 sits at
 * @param {number} [opts.fftSize] power of two, default 4096 to match the live
 *   analyser
 * @returns {Uint8Array[]} one spectrum per frame
 */
export function computeSpectrogram(audioBuffer, {
    fps, frameCount, offset = 0, fftSize = 4096,
    smoothing = 0.8, minDb = -100, maxDb = -30,
}) {
    const bins = fftSize / 2;
    const sampleRate = audioBuffer.sampleRate;

    // Mix to mono; the live analyser sees the summed signal too.
    const mono = new Float32Array(audioBuffer.length);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i];
    }
    if (audioBuffer.numberOfChannels > 1) {
        for (let i = 0; i < mono.length; i++) mono[i] /= audioBuffer.numberOfChannels;
    }

    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
        const a0 = 0.42, a1 = 0.5, a2 = 0.08; // Blackman, as Web Audio uses
        const x = (2 * Math.PI * i) / (fftSize - 1);
        window[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x);
    }

    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const smoothed = new Float32Array(bins);
    const out = [];
    const range = maxDb - minDb;

    for (let f = 0; f < frameCount; f++) {
        // The analyser reports the window ending at "now", so look backwards.
        const end = Math.round((offset + f / fps) * sampleRate);
        const start = end - fftSize;

        for (let i = 0; i < fftSize; i++) {
            const idx = start + i;
            re[i] = (idx >= 0 && idx < mono.length ? mono[idx] : 0) * window[i];
            im[i] = 0;
        }
        fftRadix2(re, im);

        const frame = new Uint8Array(bins);
        for (let k = 0; k < bins; k++) {
            const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / fftSize;
            smoothed[k] = smoothing * smoothed[k] + (1 - smoothing) * mag;
            const db = 20 * Math.log10(smoothed[k] || 1e-12);
            const v = Math.round((255 * (db - minDb)) / range);
            frame[k] = v < 0 ? 0 : (v > 255 ? 255 : v);
        }
        out.push(frame);
    }
    return out;
}

/**
 * Where the pulse comes from, as each vertex sees it: a direction to push
 * along and a distance from the source. Every shape of pulse reduces to that.
 *
 *   radial       from a point (ox, oy, oz), outwards in every direction
 *   directional  from the back of the cloud along `dir`, like a wave rising
 *                bottom to top: distance is how far along the axis a vertex
 *                sits, and it pushes along the axis
 *   plane        from a plane (a point on it and its normal), out of both
 *                faces, away from the plane
 *   line         from a line (a point on it and its direction), outwards
 *                from it like a tube swelling
 *
 * @param {object} op { mode, ox, oy, oz, dir, plane, line }
 * @returns {(x, y, z, out) => number} writes the push direction into out[0..2]
 *   and returns the distance
 */
function pulseField(op) {
    const mode = op.mode || 'radial';
    const unit = (v) => {
        const l = Math.hypot(v[0], v[1], v[2]);
        return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
    };
    if (mode === 'directional') {
        const [ax, ay, az] = unit(op.dir || [0, 1, 0]);
        // Distance runs from the back of the cloud; the caller shifts it so
        // the least advanced vertex sits at zero.
        return (x, y, z, out) => {
            out[0] = ax; out[1] = ay; out[2] = az;
            return x * ax + y * ay + z * az;
        };
    }
    if (mode === 'plane' && op.plane) {
        const [a, b, c] = op.plane;
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const [nx, ny, nz] = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
        return (x, y, z, out) => {
            const sd = (x - a[0]) * nx + (y - a[1]) * ny + (z - a[2]) * nz;
            const sg = sd < 0 ? -1 : 1;
            out[0] = nx * sg; out[1] = ny * sg; out[2] = nz * sg;
            return Math.abs(sd);
        };
    }
    if (mode === 'line' && op.line) {
        const [a, b] = op.line;
        const [ux, uy, uz] = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        return (x, y, z, out) => {
            const wx = x - a[0]; const wy = y - a[1]; const wz = z - a[2];
            const t = wx * ux + wy * uy + wz * uz;
            const px = wx - ux * t; const py = wy - uy * t; const pz = wz - uz * t;
            const d = Math.hypot(px, py, pz);
            if (d > 1e-9) { out[0] = px / d; out[1] = py / d; out[2] = pz / d; } else { out[0] = 0; out[1] = 0; out[2] = 0; }
            return d;
        };
    }
    const ox = op.ox || 0; const oy = op.oy || 0; const oz = op.oz || 0;
    return (x, y, z, out) => {
        const dx = x - ox; const dy = y - oy; const dz = z - oz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 1e-9) { out[0] = dx / d; out[1] = dy / d; out[2] = dz / d; } else { out[0] = 0; out[1] = 0; out[2] = 0; }
        return d;
    };
}

/**
 * Cache the per-vertex geometry the displacement needs.
 *
 * Direction and distance from the pulse source, plus which FFT bin each
 * vertex listens to: the nearest vertices hear the bottom of the band and the
 * farthest the top, so the cloud moves in rings (or layers, or shells) out
 * from the source rather than swelling as one. Distances are normalised by the
 * cloud's own extent rather than the fixed divisor the instanced path uses,
 * because a scan is a couple of units across where a visualizer scene is tens
 * - without that, every vertex would read the same low bin and the whole thing
 * would throb as one lump.
 *
 * @param {object} state cache, keyed so it rebuilds only when inputs change
 * @param {Float32Array} base resting positions, xyz per vertex
 * @param {object} op { freqLow, freqHigh, mode, ox, oy, oz, dir, plane, line }
 * @param {number} bins FFT bin count
 */
function ensureRadialState(state, base, op, bins) {
    const key = JSON.stringify([op.mode || 'radial', op.ox, op.oy, op.oz, op.dir, op.plane, op.line,
        op.freqLow, op.freqHigh, bins]);
    if (state.key === key && state.dirs) return;

    const total = base.length / 3;
    const dirs = new Float32Array(total * 3);
    const dists = new Float32Array(total);
    const freqIndex = new Uint16Array(total);

    const fLo = Math.max(0, Math.min(1, op.freqLow ?? 0));
    const fHi = Math.max(0, Math.min(1, op.freqHigh ?? 1));
    const loBin = Math.round(Math.min(fLo, fHi) * (bins - 1));
    const hiBin = Math.round(Math.max(fLo, fHi) * (bins - 1));
    const bandSpan = Math.max(1, hiBin - loBin);

    const field = pulseField(op);
    const out = [0, 0, 0];
    let minDist = Infinity;
    let maxDist = -Infinity;
    for (let i = 0; i < total; i++) {
        const d = field(base[i * 3], base[i * 3 + 1], base[i * 3 + 2], out);
        dists[i] = d;
        dirs[i * 3] = out[0];
        dirs[i * 3 + 1] = out[1];
        dirs[i * 3 + 2] = out[2];
        if (d < minDist) minDist = d;
        if (d > maxDist) maxDist = d;
    }
    // A directional pulse measures from the back of the cloud, not the origin.
    if ((op.mode || 'radial') === 'directional' && Number.isFinite(minDist)) {
        for (let i = 0; i < total; i++) dists[i] -= minDist;
        maxDist -= minDist;
    }
    const inv = maxDist > 1e-9 ? 1 / maxDist : 0;
    for (let i = 0; i < total; i++) {
        let fidx = loBin + Math.floor(dists[i] * inv * bandSpan);
        if (fidx > hiBin) fidx = hiBin;
        else if (fidx < loBin) fidx = loBin;
        freqIndex[i] = fidx;
    }

    state.dirs = dirs;
    state.dists = dists;
    state.freqIndex = freqIndex;
    state.key = key;
}

/**
 * Displaced position of one vertex, written into out[0..2]: pushed away from
 * the pulse source along its direction, by its distance from the source times
 * how loud its band is - so the far side of the cloud travels furthest, as the
 * outer ring of a radial pulse always has.
 */
function displacedVertex(state, i, op, frequencyData, out) {
    const freq = frequencyData[state.freqIndex[i]] / 255;
    const randomFactor = 0.5 + (Math.random() - 0.5) * (op.scatter || 0);
    const push = state.dists[i] * op.reactivity * freq * randomFactor;
    const b = state.base;
    out[0] = b[i * 3] + state.dirs[i * 3] * push;
    out[1] = b[i * 3 + 1] + state.dirs[i * 3 + 1] * push;
    out[2] = b[i * 3 + 2] + state.dirs[i * 3 + 2] * push;
}

/**
 * Drive a plain THREE.Points cloud from the spectrum.
 *
 * The placed assets above are InstancedMeshes, but a scan's own point cloud is
 * a BufferGeometry of raw positions, so it needs its own writer. The motion is
 * deliberately the same: every point pushes out along its direction from a
 * pulse origin, by an amount read from the FFT bin its resting distance maps
 * to, so the cloud blooms outward in rings rather than swelling uniformly.
 *
 * Distances are normalised by the cloud's own extent rather than the fixed
 * divisor the instanced path uses, because a scan is a couple of units across
 * where a visualizer scene is tens - without that the whole cloud would read a
 * single low bin.
 *
 * @param {object} state cache held by the caller: { base, dirs, dists,
 *   freqIndex, key, dirty }
 * @param {THREE.BufferAttribute} attr the geometry's position attribute
 * @param {object} op { reactivity, scatter, freqLow, freqHigh, mode, ox, oy,
 *   oz, dir, plane, line } - see pulseField
 * @param {Uint8Array|null} frequencyData FFT bins, or null when silent
 * @param {boolean} playing whether audio is actually running
 * @param {number} count how many points to touch (respects the draw range)
 * @returns {boolean} whether the attribute was written
 */
export function applyCloudReactivity(state, attr, op, frequencyData, playing,
    count) {
    const base = state.base;
    if (!base || !attr) return false;

    const live = playing && !!frequencyData && op.reactivity > 0;
    const n = Math.min(count ?? base.length / 3, base.length / 3);
    const arr = attr.array;

    if (!live) {
        // Settle back to the scan's true shape exactly once.
        if (!state.dirty) return false;
        arr.set(base);
        attr.needsUpdate = true;
        state.dirty = false;
        return true;
    }

    ensureRadialState(state, base, op, frequencyData.length);

    const out = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        displacedVertex(state, i, op, frequencyData, out);
        arr[i * 3] = out[0];
        arr[i * 3 + 1] = out[1];
        arr[i * 3 + 2] = out[2];
    }
    attr.needsUpdate = true;
    state.dirty = true;
    return true;
}

/**
 * Drive a fat-line wireframe from the spectrum.
 *
 * The point cloud can move each vertex independently because nothing joins
 * them. A wireframe cannot: every edge has to keep hold of both its ends, or
 * the mesh tears apart into loose segments. So the displacement is computed
 * once per *vertex* and then scattered to every segment endpoint that refers
 * to it - shared corners move as one and the structure stays welded.
 *
 * Writes straight into the interleaved instance buffer LineSegmentsGeometry
 * builds (stride 6: start xyz, end xyz), rather than calling setPositions,
 * which would reallocate every frame.
 *
 * @param {object} state cache: { base, dirs, dists, freqIndex, key, dirty }
 * @param {THREE.InstancedInterleavedBuffer} buffer the geometry's instance buffer
 * @param {Int32Array} edges 2 vertex indices per segment
 * @param {object} op { reactivity, scatter, freqLow, freqHigh, ox, oy, oz }
 * @param {Uint8Array|null} frequencyData FFT bins, or null when silent
 * @param {boolean} playing whether audio is actually running
 * @returns {boolean} whether the buffer was written
 */
export function applyWireReactivity(state, buffer, edges, op, frequencyData,
    playing) {
    const base = state.base;
    if (!base || !buffer || !edges) return false;

    const live = playing && !!frequencyData && op.reactivity > 0;
    const arr = buffer.array;
    const segs = edges.length / 2;

    const writeRest = () => {
        for (let sgt = 0; sgt < segs; sgt++) {
            const a = edges[sgt * 2] * 3;
            const b = edges[sgt * 2 + 1] * 3;
            const m = sgt * 6;
            arr[m] = base[a]; arr[m + 1] = base[a + 1]; arr[m + 2] = base[a + 2];
            arr[m + 3] = base[b]; arr[m + 4] = base[b + 1]; arr[m + 5] = base[b + 2];
        }
    };

    if (!live) {
        if (!state.dirty) return false;
        writeRest();
        buffer.needsUpdate = true;
        state.dirty = false;
        return true;
    }

    ensureRadialState(state, base, op, frequencyData.length);

    // Displace per vertex first, then scatter, so a vertex shared by several
    // edges lands in exactly the same place in each of them.
    const total = base.length / 3;
    if (!state.moved || state.moved.length !== base.length) {
        state.moved = new Float32Array(base.length);
    }
    const moved = state.moved;
    const out = [0, 0, 0];
    for (let i = 0; i < total; i++) {
        displacedVertex(state, i, op, frequencyData, out);
        moved[i * 3] = out[0];
        moved[i * 3 + 1] = out[1];
        moved[i * 3 + 2] = out[2];
    }

    for (let sgt = 0; sgt < segs; sgt++) {
        const a = edges[sgt * 2] * 3;
        const b = edges[sgt * 2 + 1] * 3;
        const m = sgt * 6;
        arr[m] = moved[a]; arr[m + 1] = moved[a + 1]; arr[m + 2] = moved[a + 2];
        arr[m + 3] = moved[b]; arr[m + 4] = moved[b + 1]; arr[m + 5] = moved[b + 2];
    }
    buffer.needsUpdate = true;
    state.dirty = true;
    return true;
}

/**
 * Unique edges of an indexed or non-indexed triangle geometry.
 *
 * Welds vertices by position first: a scan's triangles rarely share vertex
 * indices across a seam, and without welding every shared corner would be
 * several unrelated points that drift apart the moment they move.
 *
 * @param {THREE.BufferGeometry} geometry triangle geometry
 * @returns {{positions: Float32Array, edges: Int32Array}}
 */
export function buildWireTopology(geometry) {
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const triCount = index ? index.count : pos.count;
    const at = (k) => (index ? index.getX(k) : k);

    // Weld on rounded position so seam duplicates collapse to one vertex.
    const map = new Map();
    const remap = new Int32Array(pos.count).fill(-1);
    const verts = [];
    const keyOf = (i) => `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    const weld = (i) => {
        if (remap[i] !== -1) return remap[i];
        const key = keyOf(i);
        let id = map.get(key);
        if (id === undefined) {
            id = verts.length / 3;
            verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
            map.set(key, id);
        }
        remap[i] = id;
        return id;
    };

    const seen = new Set();
    const edges = [];
    for (let t = 0; t < triCount; t += 3) {
        const a = weld(at(t));
        const b = weld(at(t + 1));
        const c = weld(at(t + 2));
        [[a, b], [b, c], [c, a]].forEach(([u, v]) => {
            const lo = u < v ? u : v;
            const hi = u < v ? v : u;
            const key = lo * 1e7 + hi;
            if (seen.has(key)) return;
            seen.add(key);
            edges.push(lo, hi);
        });
    }

    return {
        positions: new Float32Array(verts),
        edges: Int32Array.from(edges),
    };
}
