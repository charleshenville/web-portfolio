import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SlidersHorizontal, X, Plus, Crosshair, Circle, Square, Move3d, Download } from 'lucide-react';
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
];

// Available music tracks
const MUSIC_ASSETS = [
    { id: 'test', name: 'Test Track', path: 'assets/test.mp3' },
    // Add more tracks here: { id: 'unique_id', name: 'Display Name', path: 'assets/filename.mp3' },
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
    originX: 0,
    originY: 0,
    originZ: 0,
    // Transform
    posX: 0,
    posY: 0,
    posZ: 0,
    scale: 1,
};

// Menu layout. `scope` is 'object' (selected asset) or 'global' (scene).
const PARAM_GROUPS = [
    {
        title: 'Geometry',
        scope: 'object',
        params: [
            { key: 'samples', label: 'Points', min: 1000, max: 300000, step: 1000, sphereOnly: true },
            { key: 'radius', label: 'Radius', min: 1, max: 20, step: 0.1, sphereOnly: true },
            { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.001, sphereOnly: true },
            { key: 'pointSize', label: 'Dot Size', min: 0.001, max: 0.05, step: 0.001, cloudOnly: true },
            { key: 'maxPoints', label: 'Max Dots', min: 1000, max: 150000, step: 1000, cloudOnly: true },
        ],
    },
    {
        title: 'Transform',
        scope: 'object',
        params: [
            { key: 'posX', label: 'Pos X', min: -50, max: 50, step: 0.1, point: 'transform' },
            { key: 'posY', label: 'Pos Y', min: -50, max: 50, step: 0.1, point: 'transform' },
            { key: 'posZ', label: 'Pos Z', min: -50, max: 50, step: 0.1, point: 'transform' },
            { key: 'scale', label: 'Scale', min: 0.05, max: 10, step: 0.05 },
        ],
    },
    {
        title: 'Audio Reactivity',
        scope: 'object',
        params: [
            { key: 'reactivity', label: 'Reactivity', min: 0, max: 3, step: 0.01 },
            { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.001, cloudOnly: true },
            { key: 'originX', label: 'Pulse X', min: -20, max: 20, step: 0.1, point: 'pulse', cloudOnly: true },
            { key: 'originY', label: 'Pulse Y', min: -20, max: 20, step: 0.1, point: 'pulse', cloudOnly: true },
            { key: 'originZ', label: 'Pulse Z', min: -20, max: 20, step: 0.1, point: 'pulse', cloudOnly: true },
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
    assetId,
    reactive,
    op: { ...OBJECT_DEFAULTS },
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
    const [transformMode, setTransformMode] = useState(false);

    // Flight path recording / playback
    const [isRecording, setIsRecording] = useState(false);
    const [isPlayingPath, setIsPlayingPath] = useState(false);
    const [hasPath, setHasPath] = useState(false);

    const audioRef = useRef(null);
    const canvasRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
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
    const pathTubeRef = useRef(null);

    // Navigation
    const keysRef = useRef({});
    const desiredTargetRef = useRef(null);

    // Flight path data
    const pathRef = useRef({ positions: [], targets: [], posCurve: null, targetCurve: null, duration: 0, playStart: 0, lastSample: 0 });
    const isRecordingRef = useRef(false);
    const isPlayingPathRef = useRef(false);

    // Debounced point-cloud rebuilds.
    const rebuildTimerRef = useRef(null);
    const rebuildSetRef = useRef(new Set());

    // Mirrors of state for the animation loop / event handlers (avoids stale closures)
    const paramsRef = useRef(params);
    const showHelpersRef = useRef(showHelpers);
    const isPlayingRef = useRef(isPlaying);
    const selectedIdRef = useRef(selectedId);
    const transformModeRef = useRef(transformMode);
    const sceneItemsRef = useRef(sceneItems);

    const hideTimerRef = useRef(null);

    // ---- Asset record building -----------------------------------------------

    // Build an InstancedMesh + cached buffers for a point cloud asset.
    const buildPointCloudRecord = useCallback((rawPoints, op, type) => {
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
        if (!dragging) {
            t.position.set(rec.op.posX, rec.op.posY, rec.op.posZ);
        }
        t.scale.setScalar(rec.op.scale);
    }, []);

    const applySelection = useCallback((rec, id) => {
        const selected = id === selectedIdRef.current;
        if (rec.boxHelper) {
            rec.boxHelper.material.color.setHex(selected ? SELECT_COLOR : BOX_COLOR);
            rec.boxHelper.visible = showHelpersRef.current || selected;
        }
        const tc = transformControlsRef.current;
        if (tc && selected) {
            if (transformModeRef.current && rec.transformTarget) {
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
    }, [buildPointCloudRecord, loadGLBRecord, loadPLYFile, disposeRecord, attachBoxHelper, applyTransform]);

    // Rebuild a point cloud in place (geometry params changed) keeping transform.
    const rebuildItem = useCallback((item) => {
        const asset = ASSETS.find((a) => a.id === item.assetId);
        if (!asset || asset.type === 'glb') return;
        const old = sceneObjectsRef.current.get(item.id);
        if (!old || old.loading) return;

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
    }, [buildPointCloudRecord, disposeRecord, attachBoxHelper, applyTransform]);

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

    // ---- Flight path contour -------------------------------------------------

    const buildPathTube = useCallback(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        if (pathTubeRef.current) {
            scene.remove(pathTubeRef.current);
            pathTubeRef.current.geometry.dispose();
            pathTubeRef.current.material.dispose();
            pathTubeRef.current = null;
        }
        const curve = pathRef.current.posCurve;
        if (!curve) return;

        const segs = Math.min(800, Math.max(40, pathRef.current.positions.length * 6));
        const geo = new THREE.TubeGeometry(curve, segs, 0.18, 8, false);
        const mat = new THREE.MeshStandardMaterial({
            color: BOX_COLOR,
            emissive: 0x123236,
            metalness: 0.1,
            roughness: 0.6,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = showHelpersRef.current;
        mesh.userData.isPathTube = true;
        scene.add(mesh);
        pathTubeRef.current = mesh;
    }, []);

    const exportPathGLB = useCallback(() => {
        const mesh = pathTubeRef.current;
        if (!mesh) return;
        const exporter = new GLTFExporter();
        exporter.parse(
            mesh,
            (result) => {
                const blob = new Blob([result], { type: 'model/gltf-binary' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'flightpath.glb';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            },
            (error) => console.error('GLB export failed:', error),
            { binary: true }
        );
    }, []);

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
            controls.enabled = !e.value && !isPlayingPathRef.current;
        });
        transformControls.addEventListener('objectChange', () => {
            const id = selectedIdRef.current;
            const rec = sceneObjectsRef.current.get(id);
            if (!rec || !rec.transformTarget) return;
            const p = rec.transformTarget.position;
            setSceneItems((prev) => prev.map((it) => (
                it.id === id ? { ...it, op: { ...it.op, posX: round2(p.x), posY: round2(p.y), posZ: round2(p.z) } } : it
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
            if (isPlayingPathRef.current) return;
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
            const playingPath = isPlayingPathRef.current;

            // --- Flight path playback (overrides manual control) ---
            if (playingPath && pathRef.current.posCurve) {
                const now = performance.now();
                const dur = pathRef.current.duration || 1;
                let u = (now - pathRef.current.playStart) / dur;
                if (u >= 1) {
                    u = 1;
                    isPlayingPathRef.current = false;
                    setIsPlayingPath(false);
                    controls.enabled = true;
                }
                camera.position.copy(pathRef.current.posCurve.getPoint(u));
                controls.target.copy(pathRef.current.targetCurve.getPoint(u));
                camera.lookAt(controls.target);
            } else {
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
            }

            // --- Flight path recording (fixed interval sampling) ---
            if (isRecordingRef.current) {
                const now = performance.now();
                if (now - pathRef.current.lastSample >= 50) {
                    pathRef.current.lastSample = now;
                    pathRef.current.positions.push(camera.position.clone());
                    pathRef.current.targets.push(controls.target.clone());
                }
            }

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
                        for (let i = 0; i < n; i++) {
                            const dx = base[i * 3] - ox;
                            const dy = base[i * 3 + 1] - oy;
                            const dz = base[i * 3 + 2] - oz;
                            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                            dists[i] = dist;
                            let fidx = Math.floor((dist / 64) * bins);
                            if (fidx >= bins) fidx = bins - 1;
                            else if (fidx < 0) fidx = 0;
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
                    if (selRec && selRec.transformTarget && selRec.op && selRec.type !== 'glb') {
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

    // Toggle helper visibility (axes, markers, bounding boxes, path tube).
    useEffect(() => {
        showHelpersRef.current = showHelpers;
        if (axesHelperRef.current) axesHelperRef.current.visible = showHelpers;
        if (targetMarkerRef.current) targetMarkerRef.current.visible = showHelpers;
        if (pulseMarkerRef.current && !showHelpers) pulseMarkerRef.current.visible = false;
        if (pathTubeRef.current) pathTubeRef.current.visible = showHelpers;
        sceneObjectsRef.current.forEach((rec, id) => {
            if (rec.boxHelper) rec.boxHelper.visible = showHelpers || id === selectedIdRef.current;
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

    // ---- Audio ---------------------------------------------------------------

    const initAudio = () => {
        if (!audioRef.current || analyserRef.current) return;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 4096;
        const source = audioContext.createMediaElementSource(audioRef.current);
        source.connect(analyser);
        analyser.connect(audioContext.destination);
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
        analyserRef.current = null;
        dataArrayRef.current = null;
        if (wasPlaying) {
            setTimeout(() => {
                if (audioRef.current) {
                    initAudio();
                    audioRef.current.play();
                    setIsPlaying(true);
                }
            }, 100);
        }
    };

    // ---- Composition controls ------------------------------------------------

    const addItem = () => {
        const item = makeItem(addAssetId, true);
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    };

    const removeItem = (id) => {
        setSceneItems((prev) => prev.filter((i) => i.id !== id));
    };

    const toggleReactive = (id) => {
        setSceneItems((prev) => prev.map((i) => (i.id === id ? { ...i, reactive: !i.reactive } : i)));
    };

    // ---- Flight path controls ------------------------------------------------

    const toggleRecord = () => {
        if (isRecording) {
            isRecordingRef.current = false;
            setIsRecording(false);
            const pts = pathRef.current.positions;
            const tgts = pathRef.current.targets;
            if (pts.length >= 2) {
                pathRef.current.posCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
                pathRef.current.targetCurve = new THREE.CatmullRomCurve3(tgts, false, 'catmullrom', 0.5);
                pathRef.current.duration = (pts.length - 1) * 50;
                buildPathTube();
                setHasPath(true);
            } else {
                setHasPath(false);
            }
        } else {
            if (isPlayingPathRef.current) return;
            pathRef.current.positions = [];
            pathRef.current.targets = [];
            pathRef.current.lastSample = 0;
            isRecordingRef.current = true;
            setIsRecording(true);
            setHasPath(false);
        }
    };

    const playPath = () => {
        if (!hasPath || isRecording || isPlayingPathRef.current) return;
        if (!pathRef.current.posCurve) return;
        pathRef.current.playStart = performance.now();
        isPlayingPathRef.current = true;
        setIsPlayingPath(true);
        if (controlsRef.current) controlsRef.current.enabled = false;
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
            i.id === selectedId ? { ...i, op: { ...OBJECT_DEFAULTS } } : i
        )));
    };

    const selectedMusicPath = MUSIC_ASSETS.find((m) => m.id === selectedMusic)?.path || 'assets/test.mp3';
    const selectedItem = sceneItems.find((i) => i.id === selectedId) || null;
    const selectedAsset = selectedItem ? ASSETS.find((a) => a.id === selectedItem.assetId) : null;
    const selType = selectedAsset?.type;

    const renderRow = (def, scope) => {
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
                                style={{ width: 34, height: 34, flex: '0 0 auto' }}
                            >
                                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <select
                                className={styles.av_select}
                                value={selectedMusic}
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
                            const asset = ASSETS.find((a) => a.id === item.assetId);
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
                                    <span className={styles.av_itemName} title={asset?.name || item.assetId}>
                                        {asset?.name || item.assetId}
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
                            <span><Move3d size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />Move Gizmo</span>
                            <span className={`${styles.av_switch} ${transformMode ? styles.av_switchOn : ''}`}>
                                <span className={styles.av_knob} />
                            </span>
                        </div>
                        <div className={styles.av_hint} style={{ marginTop: 8 }}>
                            Click an asset (here or in 3D) to select · selected box is red · switch toggles reactivity
                        </div>
                    </div>

                    {/* Camera flight path */}
                    <div className={styles.av_section}>
                        <div className={styles.av_sectionTitle}>Camera Path</div>
                        <div className={styles.av_btnRow}>
                            <button
                                type="button"
                                className={`${styles.av_select} ${isRecording ? styles.av_recActive : ''}`}
                                onClick={toggleRecord}
                                disabled={isPlayingPath}
                                style={{ textAlign: 'center' }}
                            >
                                {isRecording
                                    ? (<><Square size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />Stop</>)
                                    : (<><Circle size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />Record</>)}
                            </button>
                            <button
                                type="button"
                                className={styles.av_select}
                                onClick={playPath}
                                disabled={!hasPath || isRecording || isPlayingPath}
                                style={{ textAlign: 'center' }}
                            >
                                <Play size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />
                                {isPlayingPath ? 'Playing' : 'Play'}
                            </button>
                        </div>
                        <button
                            type="button"
                            className={styles.av_select}
                            onClick={exportPathGLB}
                            disabled={!hasPath}
                            style={{ textAlign: 'center', marginTop: 8 }}
                        >
                            <Download size={11} style={{ verticalAlign: '-1px', marginRight: 6 }} />
                            Export Path GLB
                        </button>
                        <div className={styles.av_hint} style={{ marginTop: 8 }}>
                            {isRecording
                                ? 'Recording — fly around, then Stop'
                                : hasPath
                                    ? 'Path ready — Play, or enable Helpers to see the contour'
                                    : 'Record a flight to build a Catmull-Rom tube contour'}
                        </div>
                    </div>

                    {/* Parameter groups */}
                    {PARAM_GROUPS.map((group) => (
                        <div className={styles.av_section} key={group.title}>
                            <div className={styles.av_sectionTitle}>
                                {group.title}
                                {group.scope === 'object' && (
                                    <span className={styles.av_scopeTag}>
                                        {selectedAsset ? selectedAsset.name : 'no selection'}
                                    </span>
                                )}
                            </div>
                            {group.params.map((def) => renderRow(def, group.scope))}
                            {group.title === 'Audio Reactivity' && (
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
