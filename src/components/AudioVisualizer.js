import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SlidersHorizontal, X, Plus, Crosshair, Move3d, Move, RotateCw, Maximize2, Spline, Video } from 'lucide-react';
import styles from './visualizer.module.css';

// Available assets. `type` is one of 'sphere' | 'ply' | 'glb'.
const ASSETS = [
    { id: 'sphere', name: 'Default Sphere', path: null, type: 'sphere' },
    { id: 'point_cloud', name: 'Point Cloud', path: 'assets/point_cloud.ply', type: 'ply' },
    { id: 'pepper', name: 'Pepper', path: 'assets/pepper.ply', type: 'ply' },
    { id: 'fairview_4a', name: 'Fairview 4A', path: 'assets/fairview_4a.ply', type: 'ply' },
    { id: 'fairview_2b', name: 'Fairview 2B', path: 'assets/fairview_2b.ply', type: 'ply' },
    { id: 'snow', name: 'Snow', path: 'assets/snow.ply', type: 'ply' },
    { id: 'asterisk', name: 'Asterisk (GLB)', path: 'assets/asterisk.gltf', type: 'glb' },
    { id: 'sleepycat', name: 'Sleepy Cat', path: 'assets/sleeepycat.ply', type: 'ply' },
];

// Available music tracks
const MUSIC_ASSETS = [
    { id: 'test', name: 'Test Track', path: 'assets/test.mp3' },
    { id: 'sleepycat', name: 'Sleepy Cat', path: 'assets/sleepycat.mp3' },
    { id: 'maestro', name: 'Maestro', path: 'assets/maestro.mp3' },
    // Add more tracks here: { id: 'unique_id', name: 'Display Name', path: 'assets/filename.mp3' },
];

// Output resolutions for the POV video renderer. `custom` uses the width/height
// the user types in the panel.
const RENDER_PRESETS = [
    { id: '720p', name: '720p (1280x720)', width: 1280, height: 720 },
    { id: '1080p', name: '1080p (1920x1080)', width: 1920, height: 1080 },
    { id: '1440p', name: '1440p (2560x1440)', width: 2560, height: 1440 },
    { id: '2160p', name: '4K (3840x2160)', width: 3840, height: 2160 },
    { id: 'custom', name: 'Custom', width: 1920, height: 1080 },
];

// Available single-variable parametric curves. `fn(t)` returns a point in
// roughly the [-1, 1] cube; it gets scaled by the per-curve `curveScale`.
const CURVES = [
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

// Scene-wide parameters (camera + post processing).
const GLOBAL_DEFAULTS = {
    bloomStrength: 0.5,
    bloomRadius: 0.6,
    bloomThreshold: 0.5,
    haze: 0.7,
    moveSpeed: 20,
    damping: 0.08,
};

// Per-object parameters. Every placed asset gets its own copy.
const OBJECT_DEFAULTS = {
    // Geometry (rebuilds the point cloud)
    samples: 30000,
    radius: 8,
    jitter: 0.01,
    pointSize: 0.005,
    maxPoints: 150000,
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
const CURVE_DEFAULTS = {
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

// Menu layout. `scope` is 'object' (selected item) or 'global' (scene).
// Object groups carry a `kind`: 'asset', 'curve', or 'both'.
const PARAM_GROUPS = [
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

const SELECT_COLOR = 0xff3b3b;
const BOX_COLOR = 0x4ad4d4;
const GEOM_KEYS = ['samples', 'radius', 'jitter', 'pointSize', 'maxPoints'];
const CURVE_GEOM_KEYS = ['dotCount', 'dotSize'];

// Custom dream-like haze shader
const DreamHazeShader = {
    uniforms: {
        tDiffuse: { value: null },
        time: { value: 0 },
        intensity: { value: 0.5 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float intensity;
        varying vec2 vUv;
        
        void main() {
            vec2 uv = vUv;
            
            // Soft glow effect
            vec4 color = texture2D(tDiffuse, uv);
            
            // Subtle chromatic aberration for dream-like quality
            float offset = 0.002 * intensity;
            vec4 r = texture2D(tDiffuse, uv + vec2(offset, 0.0));
            vec4 b = texture2D(tDiffuse, uv - vec2(offset, 0.0));
            color.r = mix(color.r, r.r, 0.3);
            color.b = mix(color.b, b.b, 0.3);
            
            // Subtle color shift for dreamy atmosphere
            color.rgb *= vec3(1.05, 0.98, 1.1);
            
            gl_FragColor = color;
        }
    `
};

// Text field that lets you type freely (decimals, minus sign) while still
// staying in sync with its slider. Commits only valid numbers.
function NumberField({ value, min, max, step, disabled, onCommit }) {
    const [text, setText] = useState(String(value));
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!focused) setText(String(value));
    }, [value, focused]);

    return (
        <input
            className={styles.av_num}
            type="number"
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); setText(String(value)); }}
            onChange={(e) => {
                setText(e.target.value);
                const n = parseFloat(e.target.value);
                if (!Number.isNaN(n)) onCommit(n);
            }}
        />
    );
}

function getR(x, y, z) {
    const r = Math.abs(x) ** 2 + Math.abs(y) ** 2 + Math.abs(z) ** 2;
    return r ** 0.5;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Uniform random sample of `k` items via partial Fisher-Yates. Always random,
// never order-dependent, so downsampling never carves out spatial holes.
function sampleRandom(arr, k) {
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

// Fibonacci sphere generation
function fibonacciSphere(samples = 1000, radius = 10, randomOffset = 0.1) {
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

let _instanceCounter = 0;
const nextInstanceId = () => `item_${Date.now().toString(36)}_${(_instanceCounter++)}`;
const makeItem = (assetId, reactive = true) => ({
    id: nextInstanceId(),
    kind: 'asset',
    assetId,
    reactive,
    op: { ...OBJECT_DEFAULTS },
});
const makeCurveItem = (funcId, reactive = true) => ({
    id: nextInstanceId(),
    kind: 'curve',
    funcId,
    reactive,
    op: { ...CURVE_DEFAULTS },
});

function AudioVisualizer() {
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedMusic, setSelectedMusic] = useState('test');
    const [params, setParams] = useState(GLOBAL_DEFAULTS);
    const [menuOpen, setMenuOpen] = useState(false);
    const [showHelpers, setShowHelpers] = useState(false);
    const [cursorActive, setCursorActive] = useState(true);
    const [sceneReady, setSceneReady] = useState(false);

    // Scene composition: an ordered list of placed assets.
    const [sceneItems, setSceneItems] = useState(() => [makeItem('fairview_4a', true)]);
    const [selectedId, setSelectedId] = useState(null);
    const [addAssetId, setAddAssetId] = useState('sphere');
    const [addCurveId, setAddCurveId] = useState(CURVES[0].id);
    const [transformMode, setTransformMode] = useState(false);
    const [gizmoMode, setGizmoMode] = useState('translate');

    // POV video rendering
    const [renderPreset, setRenderPreset] = useState('1080p');
    const [customW, setCustomW] = useState(1920);
    const [customH, setCustomH] = useState(1080);
    const [renderFps, setRenderFps] = useState(60);
    const [isRendering, setIsRendering] = useState(false);
    const [renderProgress, setRenderProgress] = useState(0);
    const [renderStage, setRenderStage] = useState('');

    const audioRef = useRef(null);
    const canvasRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const audioCtxRef = useRef(null);

    // POV video rendering
    const recordDestRef = useRef(null); // MediaStreamAudioDestinationNode (captured audio)
    const mediaRecorderRef = useRef(null);
    const isRenderingRef = useRef(false);
    const renderCanceledRef = useRef(false);
    const renderStopRef = useRef(null);
    const sceneRef = useRef(null);
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const composerRef = useRef(null);
    const controlsRef = useRef(null);
    const transformControlsRef = useRef(null);
    const bloomPassRef = useRef(null);
    const dreamHazePassRef = useRef(null);
    const animationFrameRef = useRef(null);

    // Scene composition objects, keyed by instance id.
    const sceneObjectsRef = useRef(new Map());
    const plyCacheRef = useRef(new Map()); // path -> raw points (avoids re-fetch)

    // Spatial helpers
    const axesHelperRef = useRef(null);
    const pulseMarkerRef = useRef(null);
    const targetMarkerRef = useRef(null);

    // Navigation
    const keysRef = useRef({});
    const desiredTargetRef = useRef(null);

    // Debounced point-cloud rebuilds.
    const rebuildTimerRef = useRef(null);
    const rebuildSetRef = useRef(new Set());

    // Mirrors of state for the animation loop / event handlers (avoids stale closures)
    const paramsRef = useRef(params);
    const showHelpersRef = useRef(showHelpers);
    const isPlayingRef = useRef(isPlaying);
    const selectedIdRef = useRef(selectedId);
    const transformModeRef = useRef(transformMode);
    const gizmoModeRef = useRef(gizmoMode);
    const sceneItemsRef = useRef(sceneItems);

    const hideTimerRef = useRef(null);

    // ---- Asset record building -----------------------------------------------

    // Build an InstancedMesh + cached buffers for a point cloud asset.
    const buildPointCloudRecord = useCallback((rawPoints, op, type) => {
        const limited = sampleRandom(rawPoints, op.maxPoints);
        const count = limited.length;

        const hasOriginalColors = count > 0 && !!limited[0].color;

        // const geometry = new THREE.SphereGeometry(op.pointSize * 1.2, 8, 8,);
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
            } else {
                const r = getR(p.x, p.y, p.z);
                const hue = (r - (op.radius - op.jitter / 2)) / op.jitter / 100;
                scratch.setHSL(hue, 0.7, 0.7);
            }
            colors[i * 3] = scratch.r;
            colors[i * 3 + 1] = scratch.g;
            colors[i * 3 + 2] = scratch.b;

            if (p.x < min.x) min.x = p.x; if (p.y < min.y) min.y = p.y; if (p.z < min.z) min.z = p.z;
            if (p.x > max.x) max.x = p.x; if (p.y > max.y) max.y = p.y; if (p.z > max.z) max.z = p.z;
        }

        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

        // Proper frustum culling for the whole cloud.
        mesh.frustumCulled = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();

        const localBox = count > 0 ? new THREE.Box3(min, max) : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

        return {
            type,
            object3D: mesh,
            transformTarget: mesh,
            reactiveScaleTarget: null,
            instancedMesh: mesh,
            count,
            basePositions,
            hasOriginalColors,
            localBox,
            dirs: null,
            dists: null,
            freqIndex: null,
            dirty: false,
        };
    }, []);

    // Build an InstancedMesh of dots that flow along a parametric curve.
    const buildCurveRecord = useCallback((funcId, op) => {
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

        // Bounds (local space) from sampling the curve at this scale.
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
        const margin = op.jitter * amp + 0.5;
        min.subScalar(margin);
        max.addScalar(margin);
        const localBox = new THREE.Box3(min, max);

        return {
            kind: 'curve',
            type: 'curve',
            object3D: mesh,
            transformTarget: mesh,
            reactiveScaleTarget: null,
            instancedMesh: mesh,
            count,
            funcId,
            curve,
            phases,
            jitterOffsets,
            colA,
            colB,
            flow: 0,
            localBox,
            dirty: false,
        };
    }, []);

    const loadPLYFile = useCallback((path) => {
        return new Promise((resolve, reject) => {
            const loader = new PLYLoader();
            loader.load(
                path,
                (geometry) => {
                    const positions = geometry.attributes.position;
                    const colors = geometry.attributes.color;
                    const points = [];

                    geometry.computeBoundingBox();
                    const bbox = geometry.boundingBox;
                    const center = new THREE.Vector3();
                    bbox.getCenter(center);
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const maxDim = Math.max(size.x, size.y, size.z) || 1;
                    const scale = 24 / maxDim;

                    for (let i = 0; i < positions.count; i++) {
                        const point = {
                            x: (positions.getX(i) - center.x) * scale,
                            y: (positions.getY(i) - center.y) * scale,
                            z: (positions.getZ(i) - center.z) * scale
                        };
                        if (colors) {
                            point.color = {
                                r: colors.getX(i),
                                g: colors.getY(i),
                                b: colors.getZ(i)
                            };
                        }
                        points.push(point);
                    }
                    resolve(points);
                },
                undefined,
                (error) => reject(error)
            );
        });
    }, []);

    const loadGLBRecord = useCallback((path) => {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(
                path,
                (gltf) => {
                    const root = gltf.scene;
                    const box = new THREE.Box3().setFromObject(root);
                    const center = new THREE.Vector3();
                    box.getCenter(center);
                    const size = new THREE.Vector3();
                    box.getSize(size);
                    const maxDim = Math.max(size.x, size.y, size.z) || 1;
                    const scale = 16 / maxDim;

                    // Normalize the model around the origin, then nest it:
                    // container (transform) -> pivot (reactive pulse) -> root.
                    root.scale.setScalar(scale);
                    root.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

                    const pivot = new THREE.Group();
                    pivot.add(root);

                    const container = new THREE.Group();
                    container.add(pivot);

                    const localBox = new THREE.Box3().setFromObject(pivot);

                    resolve({
                        type: 'glb',
                        object3D: container,
                        transformTarget: container,
                        reactiveScaleTarget: pivot,
                        instancedMesh: null,
                        count: 0,
                        localBox,
                        dirty: false,
                    });
                },
                undefined,
                (error) => reject(error)
            );
        });
    }, []);

    // ---- Helpers / selection -------------------------------------------------

    const applyTransform = useCallback((rec) => {
        const t = rec.transformTarget;
        if (!t || !rec.op) return;
        const tc = transformControlsRef.current;
        const dragging = tc && tc.dragging && selectedIdRef.current === t.userData.itemId;
        if (dragging) return; // don't fight the gizmo mid-drag
        t.position.set(rec.op.posX, rec.op.posY, rec.op.posZ);
        t.rotation.set(
            THREE.MathUtils.degToRad(rec.op.rotX || 0),
            THREE.MathUtils.degToRad(rec.op.rotY || 0),
            THREE.MathUtils.degToRad(rec.op.rotZ || 0)
        );
        t.scale.setScalar(rec.op.scale);
    }, []);

    const applySelection = useCallback((rec, id) => {
        const selected = id === selectedIdRef.current;
        if (rec.boxHelper) {
            rec.boxHelper.material.color.setHex(selected ? SELECT_COLOR : BOX_COLOR);
            // Bounding boxes (including the selected/red one) only show with helpers on.
            rec.boxHelper.visible = showHelpersRef.current;
        }
        const tc = transformControlsRef.current;
        if (tc && selected) {
            if (transformModeRef.current && rec.transformTarget) {
                tc.setMode(gizmoModeRef.current);
                tc.attach(rec.transformTarget);
                tc.visible = true;
                tc.enabled = true;
            } else {
                tc.detach();
                tc.visible = false;
                tc.enabled = false;
            }
        }
    }, []);

    const attachBoxHelper = useCallback((rec, id) => {
        if (!rec.transformTarget || !rec.localBox) return;
        const helper = new THREE.Box3Helper(rec.localBox, BOX_COLOR);
        rec.transformTarget.add(helper);
        rec.boxHelper = helper;
        applySelection(rec, id);
    }, [applySelection]);

    const disposeRecord = useCallback((rec) => {
        const scene = sceneRef.current;
        const tc = transformControlsRef.current;
        if (tc && rec.transformTarget && tc.object === rec.transformTarget) {
            tc.detach();
            tc.visible = false;
            tc.enabled = false;
        }
        if (rec.object3D && scene) {
            scene.remove(rec.object3D);
            rec.object3D.traverse?.((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose && m.dispose());
                    else if (child.material.dispose) child.material.dispose();
                }
            });
            if (rec.instancedMesh) {
                rec.instancedMesh.geometry?.dispose();
                rec.instancedMesh.material?.dispose();
            }
        }
    }, []);

    // ---- Scene composition syncing ------------------------------------------

    const addSceneItem = useCallback(async (item) => {
        if (!sceneRef.current || sceneObjectsRef.current.has(item.id)) return;

        // Parametric curves build synchronously, no asset loading needed.
        if (item.kind === 'curve') {
            const record = buildCurveRecord(item.funcId, item.op);
            record.reactive = item.reactive;
            record.op = item.op;
            record.curveKey = CURVE_GEOM_KEYS.map((k) => item.op[k]).join('|');
            record.object3D.userData.itemId = item.id;
            record.transformTarget.userData.itemId = item.id;
            applyTransform(record);
            sceneRef.current.add(record.object3D);
            attachBoxHelper(record, item.id);
            sceneObjectsRef.current.set(item.id, record);
            return;
        }

        const asset = ASSETS.find((a) => a.id === item.assetId);
        if (!asset) return;

        sceneObjectsRef.current.set(item.id, { type: asset.type, reactive: item.reactive, loading: true });
        setIsLoading(true);

        try {
            let record;
            const op = item.op || OBJECT_DEFAULTS;
            if (asset.type === 'sphere') {
                const raw = fibonacciSphere(op.samples, op.radius, op.jitter);
                record = buildPointCloudRecord(raw, op, 'sphere');
            } else if (asset.type === 'glb') {
                record = await loadGLBRecord(asset.path);
            } else {
                let raw = plyCacheRef.current.get(asset.path);
                if (!raw) {
                    raw = await loadPLYFile(asset.path);
                    plyCacheRef.current.set(asset.path, raw);
                }
                record = buildPointCloudRecord(raw, op, 'ply');
            }

            if (!sceneObjectsRef.current.has(item.id)) {
                disposeRecord(record); // removed while loading
                return;
            }

            record.assetId = item.assetId;
            record.reactive = item.reactive;
            record.op = item.op;
            record.geomKey = GEOM_KEYS.map((k) => item.op[k]).join('|');
            record.object3D.userData.itemId = item.id;
            record.transformTarget.userData.itemId = item.id;
            applyTransform(record);
            sceneRef.current.add(record.object3D);
            attachBoxHelper(record, item.id);
            sceneObjectsRef.current.set(item.id, record);
        } catch (error) {
            console.error('Failed to load asset:', asset.id, error);
            sceneObjectsRef.current.delete(item.id);
        } finally {
            setIsLoading(false);
        }
    }, [buildPointCloudRecord, buildCurveRecord, loadGLBRecord, loadPLYFile, disposeRecord, attachBoxHelper, applyTransform]);

    // Rebuild a point cloud / curve in place (geometry params changed) keeping transform.
    const rebuildItem = useCallback((item) => {
        const old = sceneObjectsRef.current.get(item.id);
        if (!old || old.loading) return;

        if (item.kind === 'curve') {
            disposeRecord(old);
            const record = buildCurveRecord(item.funcId, item.op);
            record.reactive = item.reactive;
            record.op = item.op;
            record.curveKey = CURVE_GEOM_KEYS.map((k) => item.op[k]).join('|');
            record.object3D.userData.itemId = item.id;
            record.transformTarget.userData.itemId = item.id;
            applyTransform(record);
            sceneRef.current.add(record.object3D);
            attachBoxHelper(record, item.id);
            sceneObjectsRef.current.set(item.id, record);
            return;
        }

        const asset = ASSETS.find((a) => a.id === item.assetId);
        if (!asset || asset.type === 'glb') return;

        let raw;
        if (asset.type === 'sphere') {
            raw = fibonacciSphere(item.op.samples, item.op.radius, item.op.jitter);
        } else {
            raw = plyCacheRef.current.get(asset.path);
            if (!raw) return;
        }
        disposeRecord(old);
        const record = buildPointCloudRecord(raw, item.op, asset.type);
        record.assetId = item.assetId;
        record.reactive = item.reactive;
        record.op = item.op;
        record.geomKey = GEOM_KEYS.map((k) => item.op[k]).join('|');
        record.object3D.userData.itemId = item.id;
        record.transformTarget.userData.itemId = item.id;
        applyTransform(record);
        sceneRef.current.add(record.object3D);
        attachBoxHelper(record, item.id);
        sceneObjectsRef.current.set(item.id, record);
    }, [buildPointCloudRecord, buildCurveRecord, disposeRecord, attachBoxHelper, applyTransform]);

    const flushRebuilds = useCallback(() => {
        const ids = rebuildSetRef.current;
        if (ids.size === 0) return;
        ids.forEach((id) => {
            const item = sceneItemsRef.current.find((i) => i.id === id);
            if (item) rebuildItem(item);
        });
        ids.clear();
    }, [rebuildItem]);

    // Keep a ref of the current items for the rebuild timer closure.
    useEffect(() => { sceneItemsRef.current = sceneItems; }, [sceneItems]);

    const syncScene = useCallback(() => {
        if (!sceneRef.current) return;
        const map = sceneObjectsRef.current;
        const wanted = new Set(sceneItems.map((i) => i.id));

        for (const id of Array.from(map.keys())) {
            if (!wanted.has(id)) {
                disposeRecord(map.get(id));
                map.delete(id);
            }
        }

        let needsRebuild = false;
        sceneItems.forEach((item) => {
            const rec = map.get(item.id);
            if (!rec) {
                addSceneItem(item);
                return;
            }
            if (rec.loading) return;

            if (rec.kind === 'curve') {
                rec.reactive = item.reactive;
                rec.op = item.op;
                rec.curve = CURVES.find((c) => c.id === item.funcId) || rec.curve;
                rec.colA = new THREE.Color(item.op.startColor);
                rec.colB = new THREE.Color(item.op.endColor);
                applyTransform(rec);
                const curveKey = CURVE_GEOM_KEYS.map((k) => item.op[k]).join('|');
                if (curveKey !== rec.curveKey) {
                    rebuildSetRef.current.add(item.id);
                    needsRebuild = true;
                }
                return;
            }

            if (rec.reactive && !item.reactive) rec.dirty = true; // reset on next frame
            rec.reactive = item.reactive;
            rec.op = item.op;
            rec.dirs = null; // recompute reactive math against (possibly) new origin
            applyTransform(rec);

            const geomKey = GEOM_KEYS.map((k) => item.op[k]).join('|');
            if (rec.type !== 'glb' && geomKey !== rec.geomKey) {
                rebuildSetRef.current.add(item.id);
                needsRebuild = true;
            }
        });

        if (needsRebuild) {
            clearTimeout(rebuildTimerRef.current);
            rebuildTimerRef.current = setTimeout(flushRebuilds, 160);
        }
    }, [sceneItems, addSceneItem, disposeRecord, applyTransform, flushRebuilds]);

    // ---- Scene initialization (runs once) ------------------------------------

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const pixelRatio = Math.min(window.devicePixelRatio, 2); // cap for perf
        const sceneObjects = sceneObjectsRef.current; // stable Map ref for cleanup

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.position.set(0, 0, 30);

        // GLB assets need light to be visible.
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(20, 30, 20);
        scene.add(dirLight);

        sceneRef.current = scene;
        cameraRef.current = camera;
        rendererRef.current = renderer;

        // Orbit controls (rotate / zoom / pan around a target)
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = paramsRef.current.damping;
        controls.minDistance = 2;
        controls.maxDistance = 200;
        controls.target.set(0, 0, 0);
        controlsRef.current = controls;

        // Transform gizmo (move selected object)
        const transformControls = new TransformControls(camera, renderer.domElement);
        transformControls.setMode('translate');
        transformControls.setSize(0.85);
        transformControls.visible = false;
        transformControls.enabled = false;
        transformControls.addEventListener('dragging-changed', (e) => {
            controls.enabled = !e.value;
        });
        transformControls.addEventListener('objectChange', () => {
            const id = selectedIdRef.current;
            const rec = sceneObjectsRef.current.get(id);
            if (!rec || !rec.transformTarget) return;
            const o = rec.transformTarget;
            const p = o.position, r = o.rotation, s = o.scale;
            const r2d = THREE.MathUtils.radToDeg;
            setSceneItems((prev) => prev.map((it) => (
                it.id === id ? {
                    ...it,
                    op: {
                        ...it.op,
                        posX: round2(p.x), posY: round2(p.y), posZ: round2(p.z),
                        rotX: round2(r2d(r.x)), rotY: round2(r2d(r.y)), rotZ: round2(r2d(r.z)),
                        scale: round2((s.x + s.y + s.z) / 3),
                    },
                } : it
            )));
        });
        scene.add(transformControls);
        transformControlsRef.current = transformControls;

        // Post-processing
        const composer = new EffectComposer(renderer);
        composer.setPixelRatio(pixelRatio);
        composer.setSize(window.innerWidth, window.innerHeight);

        composer.addPass(new RenderPass(scene, camera));

        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            paramsRef.current.bloomStrength,
            paramsRef.current.bloomRadius,
            paramsRef.current.bloomThreshold
        );
        composer.addPass(bloomPass);

        const dreamHazePass = new ShaderPass(DreamHazeShader);
        dreamHazePass.uniforms.intensity.value = paramsRef.current.haze;
        composer.addPass(dreamHazePass);

        composerRef.current = composer;
        bloomPassRef.current = bloomPass;
        dreamHazePassRef.current = dreamHazePass;

        // Spatial helpers (hidden until toggled)
        const axes = new THREE.AxesHelper(6);
        axes.visible = false;
        scene.add(axes);
        axesHelperRef.current = axes;

        const pulseMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.35, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xd4d4d4, wireframe: true })
        );
        pulseMarker.visible = false;
        scene.add(pulseMarker);
        pulseMarkerRef.current = pulseMarker;

        const targetMarker = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.5, 0.5),
            new THREE.MeshBasicMaterial({ color: 0xd4d4d4, wireframe: true })
        );
        targetMarker.visible = false;
        scene.add(targetMarker);
        targetMarkerRef.current = targetMarker;

        // Click (not drag) to select an object + set a new orbit focus.
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const pointerDown = { x: 0, y: 0, t: 0 };

        const onPointerDown = (e) => {
            pointerDown.x = e.clientX;
            pointerDown.y = e.clientY;
            pointerDown.t = Date.now();
        };

        const onPointerUp = (e) => {
            if (transformControls.dragging || transformControls.axis) return; // interacting with gizmo
            const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
            const elapsed = Date.now() - pointerDown.t;
            if (moved > 5 || elapsed > 300) return; // it was a drag, not a click

            const rect = canvas.getBoundingClientRect();
            ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, camera);

            const targets = [];
            sceneObjectsRef.current.forEach((rec) => { if (rec.object3D) targets.push(rec.object3D); });

            let focus = null;
            if (targets.length > 0) {
                const hits = raycaster.intersectObjects(targets, true);
                if (hits.length > 0) {
                    focus = hits[0].point.clone();
                    let o = hits[0].object;
                    while (o) {
                        if (o.userData && o.userData.itemId) { setSelectedId(o.userData.itemId); break; }
                        o = o.parent;
                    }
                }
            }
            if (!focus) {
                const dist = camera.position.distanceTo(controls.target);
                focus = raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(dist));
            }
            desiredTargetRef.current = focus;
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);

        // Keyboard fly controls (WASD + space / shift)
        const onKeyDown = (e) => {
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            keysRef.current[e.code] = true;
            if (e.code === 'Space') e.preventDefault();
        };
        const onKeyUp = (e) => { keysRef.current[e.code] = false; };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        const handleResize = () => {
            const pr = Math.min(window.devicePixelRatio, 2);
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setPixelRatio(pr);
            renderer.setSize(window.innerWidth, window.innerHeight);
            composer.setPixelRatio(pr);
            composer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        // Animation loop
        const clock = new THREE.Clock();
        const forward = new THREE.Vector3();
        const right = new THREE.Vector3();
        const move = new THREE.Vector3();
        const scratchVec = new THREE.Vector3();

        const animate = () => {
            const time = Date.now() * 0.001;
            const dt = clock.getDelta();
            const cfg = paramsRef.current;

            // --- Manual fly / orbit control ---
            const keys = keysRef.current;
            const moving = keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD ||
                keys.Space || keys.ShiftLeft || keys.ShiftRight;
            if (moving) {
                camera.getWorldDirection(forward);
                forward.normalize();
                right.crossVectors(forward, camera.up).normalize();
                move.set(0, 0, 0);
                if (keys.KeyW) move.add(forward);
                if (keys.KeyS) move.sub(forward);
                if (keys.KeyD) move.add(right);
                if (keys.KeyA) move.sub(right);
                if (keys.Space) move.add(camera.up);
                if (keys.ShiftLeft || keys.ShiftRight) move.sub(camera.up);
                if (move.lengthSq() > 0) {
                    move.normalize().multiplyScalar(cfg.moveSpeed * dt);
                    camera.position.add(move);
                    controls.target.add(move);
                    desiredTargetRef.current = null;
                }
            }

            if (desiredTargetRef.current) {
                controls.target.lerp(desiredTargetRef.current, 0.12);
                if (controls.target.distanceTo(desiredTargetRef.current) < 0.01) {
                    desiredTargetRef.current = null;
                }
            }

            controls.update();

            // --- Audio data ---
            let frequencyData = null;
            if (analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);
                frequencyData = dataArrayRef.current;
            }
            const playing = isPlayingRef.current && !!frequencyData;

            let bass = 0;
            if (playing) {
                let sum = 0;
                for (let b = 0; b < 8; b++) sum += frequencyData[b];
                bass = sum / 8 / 255;
            }

            // --- Per-asset reactivity ---
            sceneObjectsRef.current.forEach((rec) => {
                if (rec.loading || !rec.op) return;
                const op = rec.op;

                // Parametric curves: dots continuously flow along the curve.
                if (rec.kind === 'curve') {
                    const mesh = rec.instancedMesh;
                    if (!mesh) return;
                    const curve = rec.curve;
                    const count = rec.count;
                    const amp = op.curveScale;
                    const span = curve.tMax - curve.tMin;
                    const reactBoost = (rec.reactive && playing) ? op.reactivity * bass : 0;
                    rec.flow += op.flowSpeed * (1 + reactBoost) * dt;
                    if (rec.flow > 1e6) rec.flow = 0; // avoid float drift over time
                    const jitterAmp = op.jitter * amp * (1 + reactBoost * 4);
                    const arr = mesh.instanceMatrix.array;
                    const carr = mesh.instanceColor.array;
                    const colA = rec.colA, colB = rec.colB;
                    const jit = rec.jitterOffsets, ph = rec.phases;
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
                    if (rec.reactive && playing && rec.reactiveScaleTarget) {
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

                if (rec.reactive && playing) {
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
                    const dirs = rec.dirs, dists = rec.dists, fi = rec.freqIndex;
                    const n = rec.count;
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
                    const arr = mesh.instanceMatrix.array;
                    const base = rec.basePositions;
                    const n = rec.count;
                    for (let i = 0; i < n; i++) {
                        const m = i * 16;
                        arr[m + 12] = base[i * 3];
                        arr[m + 13] = base[i * 3 + 1];
                        arr[m + 14] = base[i * 3 + 2];
                    }
                    mesh.instanceMatrix.needsUpdate = true;
                    rec.dirty = false;
                }
            });

            // --- Helper markers ---
            if (showHelpersRef.current) {
                const selRec = sceneObjectsRef.current.get(selectedIdRef.current);
                if (pulseMarkerRef.current) {
                    if (selRec && selRec.transformTarget && selRec.op && selRec.type !== 'glb' && selRec.kind !== 'curve') {
                        scratchVec.set(selRec.op.originX, selRec.op.originY, selRec.op.originZ);
                        selRec.transformTarget.localToWorld(scratchVec);
                        pulseMarkerRef.current.position.copy(scratchVec);
                        pulseMarkerRef.current.visible = true;
                    } else {
                        pulseMarkerRef.current.visible = false;
                    }
                }
                if (targetMarkerRef.current) targetMarkerRef.current.position.copy(controls.target);
            }

            if (dreamHazePassRef.current) {
                dreamHazePassRef.current.uniforms.time.value = time;
            }
            if (composerRef.current) composerRef.current.render();

            animationFrameRef.current = requestAnimationFrame(animate);
        };

        setSceneReady(true);
        animate();

        return () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('resize', handleResize);
            transformControls.dispose();
            controls.dispose();
            sceneObjects.forEach((rec) => disposeRecord(rec));
            sceneObjects.clear();
        };
    }, [disposeRecord]);

    // Sync scene composition whenever the item list changes.
    useEffect(() => {
        if (sceneReady) syncScene();
    }, [sceneReady, syncScene]);

    // Pick an initial selection once the scene is ready.
    useEffect(() => {
        if (sceneReady && selectedId === null && sceneItems.length > 0) {
            setSelectedId(sceneItems[0].id);
        }
    }, [sceneReady, selectedId, sceneItems]);

    // Keep selection valid + reflect it in the scene (box color, gizmo).
    useEffect(() => {
        selectedIdRef.current = selectedId;
        transformModeRef.current = transformMode;
        if (selectedId !== null && !sceneItems.some((i) => i.id === selectedId)) {
            setSelectedId(sceneItems[0]?.id ?? null);
            return;
        }
        sceneObjectsRef.current.forEach((rec, id) => applySelection(rec, id));
    }, [selectedId, transformMode, sceneItems, sceneReady, showHelpers, applySelection]);

    // Keep the gizmo's transform mode (translate / rotate / scale) in sync.
    useEffect(() => {
        gizmoModeRef.current = gizmoMode;
        const tc = transformControlsRef.current;
        if (tc && tc.object) tc.setMode(gizmoMode);
    }, [gizmoMode]);

    // Push live params to three.js objects + keep the loop's ref in sync.
    useEffect(() => {
        paramsRef.current = params;
        if (bloomPassRef.current) {
            bloomPassRef.current.strength = params.bloomStrength;
            bloomPassRef.current.radius = params.bloomRadius;
            bloomPassRef.current.threshold = params.bloomThreshold;
        }
        if (dreamHazePassRef.current) dreamHazePassRef.current.uniforms.intensity.value = params.haze;
        if (controlsRef.current) controlsRef.current.dampingFactor = params.damping;
    }, [params]);

    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

    // Toggle helper visibility (axes, markers, bounding boxes).
    useEffect(() => {
        showHelpersRef.current = showHelpers;
        if (axesHelperRef.current) axesHelperRef.current.visible = showHelpers;
        if (targetMarkerRef.current) targetMarkerRef.current.visible = showHelpers;
        if (pulseMarkerRef.current && !showHelpers) pulseMarkerRef.current.visible = false;
        sceneObjectsRef.current.forEach((rec) => {
            if (rec.boxHelper) rec.boxHelper.visible = showHelpers;
        });
    }, [showHelpers]);

    // Reveal the menu toggle on cursor movement; hide after inactivity.
    useEffect(() => {
        const onMove = () => {
            setCursorActive(true);
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = setTimeout(() => setCursorActive(false), 2500);
        };
        window.addEventListener('mousemove', onMove);
        hideTimerRef.current = setTimeout(() => setCursorActive(false), 2500);
        return () => {
            window.removeEventListener('mousemove', onMove);
            clearTimeout(hideTimerRef.current);
        };
    }, []);

    // Stop any in-flight render if the component unmounts.
    useEffect(() => () => {
        renderCanceledRef.current = true;
        if (renderStopRef.current) renderStopRef.current();
    }, []);

    // ---- Audio ---------------------------------------------------------------

    const initAudio = () => {
        if (!audioRef.current || analyserRef.current) return;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 4096;
        const source = audioContext.createMediaElementSource(audioRef.current);
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        // Tap the same signal into a stream node so the renderer can mux audio.
        const recordDest = audioContext.createMediaStreamDestination();
        analyser.connect(recordDest);
        audioCtxRef.current = audioContext;
        recordDestRef.current = recordDest;
        analyserRef.current = analyser;
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    };

    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            if (!analyserRef.current) initAudio();
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    const handleMusicSelect = (musicId) => {
        const wasPlaying = isPlaying;
        if (audioRef.current && isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        }
        setSelectedMusic(musicId);
        // Keep the existing audio graph: an <audio> element can only ever be
        // bound to one MediaElementSourceNode, so we reuse it across tracks.
        // Changing `src` (via selectedMusic) makes the same graph follow the
        // new track automatically.
        if (wasPlaying) {
            setTimeout(() => {
                if (audioRef.current) {
                    if (!analyserRef.current) initAudio();
                    audioRef.current.play();
                    setIsPlaying(true);
                }
            }, 100);
        }
    };

    // ---- POV video rendering -------------------------------------------------

    // Records the live composited canvas (current camera POV, with audio
    // reactivity) plus the track audio into a webm for the full song duration.
    const startRender = useCallback(async () => {
        if (isRenderingRef.current) return;
        const renderer = rendererRef.current;
        const camera = cameraRef.current;
        const composer = composerRef.current;
        const audio = audioRef.current;
        if (!renderer || !camera || !composer || !audio) return;
        if (typeof MediaRecorder === 'undefined' || !renderer.domElement.captureStream) {
            // eslint-disable-next-line no-alert
            window.alert('Video capture is not supported in this browser.');
            return;
        }

        const preset = RENDER_PRESETS.find((p) => p.id === renderPreset) || RENDER_PRESETS[1];
        const width = Math.max(2, Math.round(preset.id === 'custom' ? customW : preset.width));
        const height = Math.max(2, Math.round(preset.id === 'custom' ? customH : preset.height));
        const fps = Math.max(1, Math.min(120, Math.round(renderFps)));

        setIsRendering(true);
        isRenderingRef.current = true;
        renderCanceledRef.current = false;
        setRenderStage('Preparing');
        setRenderProgress(0);

        // Ensure the audio graph exists and is running.
        if (!analyserRef.current) initAudio();
        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
            try { await audioCtxRef.current.resume(); } catch (e) { /* ignore */ }
        }

        // Make sure we know how long the track is.
        if (!Number.isFinite(audio.duration) || audio.duration === 0) {
            await new Promise((resolve) => {
                const onMeta = () => { audio.removeEventListener('loadedmetadata', onMeta); resolve(); };
                audio.addEventListener('loadedmetadata', onMeta);
                audio.load();
                setTimeout(resolve, 4000); // fail-safe
            });
        }
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;

        // Remember the on-screen size so we can restore it afterwards.
        const prevSize = new THREE.Vector2();
        renderer.getSize(prevSize);
        const prevPixelRatio = renderer.getPixelRatio();
        const prevAspect = camera.aspect;

        // Render at the requested resolution (pixelRatio 1 → buffer == W×H).
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        composer.setPixelRatio(1);
        composer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        if (bloomPassRef.current) bloomPassRef.current.setSize(width, height);

        const restoreSize = () => {
            renderer.setPixelRatio(prevPixelRatio);
            renderer.setSize(prevSize.x, prevSize.y, false);
            composer.setPixelRatio(prevPixelRatio);
            composer.setSize(prevSize.x, prevSize.y);
            camera.aspect = prevAspect;
            camera.updateProjectionMatrix();
            if (bloomPassRef.current) bloomPassRef.current.setSize(prevSize.x, prevSize.y);
        };

        // Build a combined video (canvas) + audio (track) stream.
        const canvasStream = renderer.domElement.captureStream(fps);
        const tracks = [...canvasStream.getVideoTracks()];
        if (recordDestRef.current) {
            const audioTrack = recordDestRef.current.stream.getAudioTracks()[0];
            if (audioTrack) tracks.push(audioTrack);
        }
        const combined = new MediaStream(tracks);

        const mimeCandidates = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
        ];
        const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';

        let recorder;
        try {
            recorder = new MediaRecorder(combined, mimeType
                ? { mimeType, videoBitsPerSecond: 16_000_000 }
                : {});
        } catch (e) {
            restoreSize();
            isRenderingRef.current = false;
            setIsRendering(false);
            setRenderStage('');
            // eslint-disable-next-line no-alert
            window.alert('Failed to start the video recorder.');
            return;
        }
        mediaRecorderRef.current = recorder;

        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

        let progressTimer = null;
        const finish = () => {
            if (renderStopRef.current !== finish) return; // already stopped
            renderStopRef.current = null;
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
            audio.removeEventListener('ended', finish);
            if (recorder.state !== 'inactive') recorder.stop();
            audio.pause();
            setIsPlaying(false);
        };
        renderStopRef.current = finish;

        recorder.onstop = () => {
            canvasStream.getTracks().forEach((t) => t.stop());
            restoreSize();
            mediaRecorderRef.current = null;
            isRenderingRef.current = false;
            setIsRendering(false);
            setRenderStage('');
            setRenderProgress(0);

            if (!renderCanceledRef.current && chunks.length > 0) {
                const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
                const url = URL.createObjectURL(blob);
                const musicName = MUSIC_ASSETS.find((m) => m.id === selectedMusic)?.name || 'render';
                const safeName = musicName.replace(/\s+/g, '_').toLowerCase();
                const a = document.createElement('a');
                a.href = url;
                a.download = `${safeName}_${width}x${height}_${fps}fps.webm`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            }
        };

        // Start from the top so the whole song is captured with reactivity.
        audio.pause();
        try { audio.currentTime = 0; } catch (e) { /* ignore */ }
        audio.addEventListener('ended', finish);

        recorder.start(1000); // gather data in 1s chunks
        setRenderStage('Recording');
        try {
            await audio.play();
        } catch (e) {
            finish();
            return;
        }
        setIsPlaying(true);

        progressTimer = setInterval(() => {
            if (duration > 0) {
                const p = Math.min(1, audio.currentTime / duration);
                setRenderProgress(p);
                if (audio.currentTime >= duration - 0.05) finish();
            } else {
                // Unknown duration: reflect elapsed time loosely.
                setRenderProgress((prev) => Math.min(0.99, prev + 0.01));
            }
        }, 200);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderPreset, customW, customH, renderFps, selectedMusic]);

    const cancelRender = useCallback(() => {
        renderCanceledRef.current = true;
        if (renderStopRef.current) renderStopRef.current();
    }, []);

    // ---- Composition controls ------------------------------------------------

    const addItem = () => {
        const item = makeItem(addAssetId, true);
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    };

    const addCurve = () => {
        const item = makeCurveItem(addCurveId, true);
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    };

    const removeItem = (id) => {
        setSceneItems((prev) => prev.filter((i) => i.id !== id));
    };

    const toggleReactive = (id) => {
        setSceneItems((prev) => prev.map((i) => (i.id === id ? { ...i, reactive: !i.reactive } : i)));
    };

    // ---- Param handling ------------------------------------------------------

    const updateParam = (key, value) => {
        if (Number.isNaN(value)) return;
        setParams((prev) => ({ ...prev, [key]: value }));
    };

    const updateObjectParam = (key, value) => {
        if (Number.isNaN(value) || selectedId === null) return;
        setSceneItems((prev) => prev.map((i) => (
            i.id === selectedId ? { ...i, op: { ...i.op, [key]: value } } : i
        )));
    };

    const snapPulseToCenter = () => {
        const rec = sceneObjectsRef.current.get(selectedId);
        const t = controlsRef.current?.target;
        if (!rec || !t || !rec.transformTarget) return;
        const local = rec.transformTarget.worldToLocal(t.clone());
        setSceneItems((prev) => prev.map((i) => (
            i.id === selectedId
                ? { ...i, op: { ...i.op, originX: round2(local.x), originY: round2(local.y), originZ: round2(local.z) } }
                : i
        )));
    };

    const resetSelected = () => {
        setParams(GLOBAL_DEFAULTS);
        if (selectedId === null) return;
        setSceneItems((prev) => prev.map((i) => (
            i.id === selectedId
                ? { ...i, op: { ...(i.kind === 'curve' ? CURVE_DEFAULTS : OBJECT_DEFAULTS) } }
                : i
        )));
    };

    const selectedMusicPath = MUSIC_ASSETS.find((m) => m.id === selectedMusic)?.path || 'assets/test.mp3';
    const selectedItem = sceneItems.find((i) => i.id === selectedId) || null;
    const selKind = selectedItem?.kind || 'asset';
    const selectedAsset = selectedItem && selKind === 'asset' ? ASSETS.find((a) => a.id === selectedItem.assetId) : null;
    const selectedCurve = selectedItem && selKind === 'curve' ? CURVES.find((c) => c.id === selectedItem.funcId) : null;
    const selType = selectedAsset?.type;
    const selectedLabel = selectedAsset?.name || selectedCurve?.name || (selectedItem ? 'no selection' : 'no selection');

    const renderRow = (def, scope) => {
        // Gizmo mode selector (Move / Rotate / Scale) lives under the position sliders.
        if (def.type === 'gizmoButtons') {
            const modes = [
                ['translate', 'Move', Move],
                ['rotate', 'Rotate', RotateCw],
                ['scale', 'Scale', Maximize2],
            ];
            return (
                <div className={styles.av_gizmoRow} key="gizmoBtns">
                    {modes.map(([mode, label, Icon]) => (
                        <button
                            key={mode}
                            type="button"
                            disabled={!selectedItem}
                            className={`${styles.av_gizmoBtn} ${transformMode && gizmoMode === mode ? styles.av_gizmoBtnOn : ''}`}
                            onClick={() => { setGizmoMode(mode); setTransformMode(true); }}
                        >
                            <Icon size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
                            {label}
                        </button>
                    ))}
                </div>
            );
        }

        let disabled;
        let value;
        if (scope === 'global') {
            disabled = false;
            value = params[def.key];
        } else {
            disabled = !selectedItem
                || (def.sphereOnly && selType !== 'sphere')
                || (def.cloudOnly && selType === 'glb');
            value = selectedItem ? selectedItem.op[def.key] : OBJECT_DEFAULTS[def.key];
        }
        const commit = scope === 'global' ? updateParam : updateObjectParam;

        // Color picker rows (curve start / end dot colors).
        if (def.type === 'color') {
            return (
                <div className={styles.av_row} key={def.key} style={disabled ? { opacity: 0.35 } : undefined}>
                    <span className={styles.av_label} title={def.label}>{def.label}</span>
                    <input
                        className={styles.av_color}
                        type="color"
                        value={value || '#ffffff'}
                        disabled={disabled}
                        onChange={(e) => commit(def.key, e.target.value)}
                        style={{ gridColumn: '2 / span 2' }}
                    />
                </div>
            );
        }

        return (
            <div className={styles.av_row} key={def.key} style={disabled ? { opacity: 0.35 } : undefined}>
                <span className={styles.av_label} title={def.label}>
                    {def.point ? `◇ ${def.label}` : def.label}
                </span>
                <input
                    className={styles.av_slider}
                    type="range"
                    min={def.min}
                    max={def.max}
                    step={def.step}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => commit(def.key, parseFloat(e.target.value))}
                />
                <NumberField
                    value={value}
                    min={def.min}
                    max={def.max}
                    step={def.step}
                    disabled={disabled}
                    onCommit={(n) => commit(def.key, n)}
                />
            </div>
        );
    };

    return (
        <div className={styles.av} style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000', position: 'relative' }}>
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    touchAction: 'none',
                    cursor: 'grab',
                    zIndex: 1
                }}
            />

            <audio
                ref={audioRef}
                src={selectedMusicPath}
                onEnded={() => setIsPlaying(false)}
                style={{ display: 'none' }}
            />

            {isLoading && <div className={styles.av_loading}>Loading</div>}

            {/* POV render progress overlay */}
            {isRendering && (
                <div className={styles.av_renderOverlay}>
                    <div className={styles.av_renderCard}>
                        <div className={styles.av_renderTitle}>
                            <Video size={14} style={{ verticalAlign: '-2px', marginRight: 8 }} />
                            Rendering POV Video
                        </div>
                        <div className={styles.av_renderSub}>
                            {renderStage || 'Working'} · {renderFps} fps
                        </div>
                        <div className={styles.av_progress} style={{ marginTop: 14 }}>
                            <div
                                className={styles.av_progressFill}
                                style={{ width: `${Math.round(renderProgress * 100)}%` }}
                            />
                        </div>
                        <div className={styles.av_renderPct}>{Math.round(renderProgress * 100)}%</div>
                        <button
                            type="button"
                            className={`${styles.av_select} ${styles.av_recActive}`}
                            onClick={cancelRender}
                            style={{ textAlign: 'center', marginTop: 4 }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Menu reveal button (auto-hides when the cursor is idle) */}
            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    className={`${styles.av_toggle} ${cursorActive ? styles.av_visible : styles.av_hidden}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {/* Control panel */}
            {menuOpen && (
                <div className={styles.av_panel}>
                    <div className={styles.av_head}>
                        <span className={styles.av_title}>Visualizer</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.av_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Playback */}
                    <div className={styles.av_section}>
                        <div className={styles.av_sectionTitle}>Playback</div>
                        <div className={styles.av_playRow}>
                            <button
                                type="button"
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                className={styles.av_iconBtn}
                                onClick={togglePlay}
                                disabled={isRendering}
                                style={{ width: 34, height: 34, flex: '0 0 auto' }}
                            >
                                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <select
                                className={styles.av_select}
                                value={selectedMusic}
                                disabled={isRendering}
                                onChange={(e) => handleMusicSelect(e.target.value)}
                            >
                                {MUSIC_ASSETS.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Scene composition */}
                    <div className={styles.av_section}>
                        <div className={styles.av_sectionTitle}>Scene</div>
                        {sceneItems.map((item) => {
                            const isCurve = item.kind === 'curve';
                            const asset = isCurve
                                ? CURVES.find((c) => c.id === item.funcId)
                                : ASSETS.find((a) => a.id === item.assetId);
                            const displayName = (isCurve ? `~ ${asset?.name || item.funcId}` : asset?.name) || item.assetId;
                            const isSel = item.id === selectedId;
                            return (
                                <div
                                    className={`${styles.av_item} ${isSel ? styles.av_itemSel : ''}`}
                                    key={item.id}
                                    onClick={() => setSelectedId(item.id)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(item.id); }}
                                >
                                    <span className={styles.av_itemName} title={displayName}>
                                        {displayName}
                                    </span>
                                    <span
                                        className={`${styles.av_switch} ${item.reactive ? styles.av_switchOn : ''}`}
                                        onClick={(e) => { e.stopPropagation(); toggleReactive(item.id); }}
                                        role="button"
                                        tabIndex={0}
                                        title="Audio reactive"
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); toggleReactive(item.id); } }}
                                    >
                                        <span className={styles.av_knob} />
                                    </span>
                                    <button
                                        type="button"
                                        className={styles.av_miniBtn}
                                        aria-label="Remove asset"
                                        onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                                    >
                                        <X size={13} />
                                    </button>
                                </div>
                            );
                        })}
                        <div className={styles.av_addRow}>
                            <select
                                className={styles.av_select}
                                value={addAssetId}
                                onChange={(e) => setAddAssetId(e.target.value)}
                            >
                                {ASSETS.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                className={styles.av_miniBtn}
                                aria-label="Add asset"
                                onClick={addItem}
                            >
                                <Plus size={15} />
                            </button>
                        </div>
                        <div className={styles.av_addRow} style={{ marginTop: 8 }}>
                            <Spline size={15} style={{ flex: '0 0 auto', opacity: 0.6 }} />
                            <select
                                className={styles.av_select}
                                value={addCurveId}
                                onChange={(e) => setAddCurveId(e.target.value)}
                            >
                                {CURVES.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                className={styles.av_miniBtn}
                                aria-label="Add curve"
                                onClick={addCurve}
                            >
                                <Plus size={15} />
                            </button>
                        </div>
                        <div
                            className={styles.av_checkRow}
                            onClick={() => setShowHelpers((v) => !v)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') setShowHelpers((v) => !v); }}
                            style={{ marginTop: 12 }}
                        >
                            <span>Show Helpers</span>
                            <span className={`${styles.av_switch} ${showHelpers ? styles.av_switchOn : ''}`}>
                                <span className={styles.av_knob} />
                            </span>
                        </div>
                        <div
                            className={styles.av_checkRow}
                            onClick={() => setTransformMode((v) => !v)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') setTransformMode((v) => !v); }}
                            style={{ marginTop: 10 }}
                        >
                            <span><Move3d size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />Gizmo</span>
                            <span className={`${styles.av_switch} ${transformMode ? styles.av_switchOn : ''}`}>
                                <span className={styles.av_knob} />
                            </span>
                        </div>
                        <div className={styles.av_hint} style={{ marginTop: 8 }}>
                            Click an item (here or in 3D) to select · selected box is red · switch toggles reactivity
                        </div>
                    </div>

                    {/* Parameter groups (object groups filtered by the selected kind) */}
                    {PARAM_GROUPS.filter((group) => (
                        group.scope === 'global' || group.kind === 'both' || group.kind === selKind
                    )).map((group) => (
                        <div className={styles.av_section} key={`${group.title}-${group.kind || group.scope}`}>
                            <div className={styles.av_sectionTitle}>
                                {group.title}
                                {group.scope === 'object' && (
                                    <span className={styles.av_scopeTag}>
                                        {selectedLabel}
                                    </span>
                                )}
                            </div>
                            {group.params.map((def) => renderRow(def, group.scope))}
                            {group.title === 'Audio Reactivity' && group.kind === 'asset' && (
                                <button
                                    type="button"
                                    className={styles.av_select}
                                    onClick={snapPulseToCenter}
                                    disabled={!selectedItem || selType === 'glb'}
                                    style={{ textAlign: 'center', marginTop: 4 }}
                                >
                                    <Crosshair size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />
                                    Snap Pulse to Center
                                </button>
                            )}
                        </div>
                    ))}

                    {/* POV video render */}
                    <div className={styles.av_section}>
                        <div className={styles.av_sectionTitle}>Render POV Video</div>
                        <select
                            className={styles.av_select}
                            value={renderPreset}
                            disabled={isRendering}
                            onChange={(e) => setRenderPreset(e.target.value)}
                        >
                            {RENDER_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>

                        {renderPreset === 'custom' && (
                            <div className={styles.av_addRow} style={{ marginTop: 8 }}>
                                <NumberField
                                    value={customW}
                                    min={2}
                                    max={7680}
                                    step={2}
                                    disabled={isRendering}
                                    onCommit={(n) => setCustomW(Math.round(n))}
                                />
                                <span style={{ opacity: 0.6, fontSize: 12 }}>×</span>
                                <NumberField
                                    value={customH}
                                    min={2}
                                    max={4320}
                                    step={2}
                                    disabled={isRendering}
                                    onCommit={(n) => setCustomH(Math.round(n))}
                                />
                            </div>
                        )}

                        <div className={styles.av_row} style={{ marginTop: 8 }}>
                            <span className={styles.av_label} title="Frames per second">FPS</span>
                            <input
                                className={styles.av_slider}
                                type="range"
                                min={24}
                                max={120}
                                step={1}
                                value={renderFps}
                                disabled={isRendering}
                                onChange={(e) => setRenderFps(parseFloat(e.target.value))}
                            />
                            <NumberField
                                value={renderFps}
                                min={1}
                                max={120}
                                step={1}
                                disabled={isRendering}
                                onCommit={(n) => setRenderFps(Math.round(n))}
                            />
                        </div>

                        {!isRendering ? (
                            <button
                                type="button"
                                className={styles.av_select}
                                onClick={startRender}
                                style={{ textAlign: 'center', marginTop: 8 }}
                            >
                                <Video size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                                Render Full Song
                            </button>
                        ) : (
                            <>
                                <div className={styles.av_progress} style={{ marginTop: 10 }}>
                                    <div
                                        className={styles.av_progressFill}
                                        style={{ width: `${Math.round(renderProgress * 100)}%` }}
                                    />
                                </div>
                                <div className={styles.av_hint} style={{ marginTop: 6 }}>
                                    {renderStage} · {Math.round(renderProgress * 100)}%
                                </div>
                                <button
                                    type="button"
                                    className={`${styles.av_select} ${styles.av_recActive}`}
                                    onClick={cancelRender}
                                    style={{ textAlign: 'center', marginTop: 8 }}
                                >
                                    Cancel
                                </button>
                            </>
                        )}
                        <div className={styles.av_hint} style={{ marginTop: 8 }}>
                            Captures the live camera POV (with reactivity) + audio for the
                            whole track. Move the camera before rendering to frame your shot.
                        </div>
                    </div>

                    {/* Footer */}
                    <div className={styles.av_section} style={{ borderBottom: 'none' }}>
                        <button
                            type="button"
                            className={styles.av_select}
                            onClick={resetSelected}
                            style={{ textAlign: 'center', cursor: 'pointer' }}
                        >
                            Reset Defaults
                        </button>
                        <div className={styles.av_hint} style={{ marginTop: 10 }}>
                            Drag to orbit · Scroll to zoom · Click to select / refocus<br />
                            WASD to fly · Space / Shift up &amp; down · ◇ = point in space
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default AudioVisualizer;
