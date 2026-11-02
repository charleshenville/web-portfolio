import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    Play, Pause, SlidersHorizontal, X, Download,
    Camera, Trash2, RotateCcw, Save, Plus, Music, Boxes, Spline, Upload,
} from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
    Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget,
} from 'mp4-muxer';
import VfxNumberField from './VfxNumberField';
import useMediaQuery from '../lib/useMediaQuery';
import {
    ASSETS, CURVES, MUSIC_ASSETS, PARAM_GROUPS, GEOM_KEYS, CURVE_GEOM_KEYS,
    fibonacciSphere, makeItem, makeCurveItem, buildPointCloudRecord,
    buildCurveRecord, applyAudioReactivity, applyCloudReactivity,
    applyWireReactivity, buildWireTopology, applyRecordTransform,
    disposeRecord, loadPlyPoints, computeSpectrogram, bandLevel,
    envelopeFollow, applySceneOpacity,
} from '../lib/audioScene';
import { Mp4FrameReader } from '../lib/mp4Frames';
import styles from './vfx.module.css';

// Camera poses come from backend/vidtrack: a pose is solved per frame, and
// align.py carries those poses into the GLB's own coordinate frame. So the scan
// sits at the origin untransformed and the camera is what moves. The footage is
// undistorted by the same pipeline, which is what lets a plain pinhole frustum
// line up with it all the way into the corners.
const MANIFEST_URL = `${process.env.PUBLIC_URL}/mv/manifest.json`;

const SHADING = [
    { id: 'textured', name: 'Scan' },
    { id: 'matte', name: 'Matte' },
    { id: 'shaded', name: 'Shaded' },
    { id: 'normal', name: 'Normal' },
];

// Face budgets the pipeline writes per take. Picking one is a look, not a
// performance setting - a scan drawn at full density is a solid fill.
const WIRE_LEVELS = [
    { id: 'coarse', name: 'Coarse' },
    { id: 'medium', name: 'Medium' },
    { id: 'fine', name: 'Fine' },
];

const EXPORT_SCALES = [
    { id: 0.5, name: '0.5x' },
    { id: 1, name: '1x' },
    { id: 1.5, name: '1.5x' },
    { id: 2, name: '2x' },
];

// Bits per pixel per frame. The old exporter was fixed at 0.25, which is thin
// for a frame full of points and thin lines - exactly the high-frequency
// detail H.264 throws away first - and is the main reason an export looked
// softer and blockier than the preview.
const EXPORT_QUALITY = [
    { id: 0.18, name: 'Draft' },
    { id: 0.4, name: 'High' },
    { id: 0.85, name: 'Max' },
];

// How the clip behaves when it reaches its end: stop, jump back to the start,
// or run backwards to it. A bounce never repeats the turnaround frame, so a
// short take reads as one continuous move rather than a stutter on the end.
const LOOP_MODES = [
    { id: 'off', name: 'Once' },
    { id: 'loop', name: 'Loop' },
    { id: 'bounce', name: 'Ping-pong' },
];

// How much of the loop an export covers.
const EXPORT_LENGTHS = [
    { id: 'clip', name: 'One cycle' },
    { id: 'audio', name: 'Full track' },
    { id: 'loops', name: 'Cycles' },
];

// Supersample factor for the export, applied on top of the output scale: the
// scene is drawn this much larger and filtered down, which is what stops a
// point cloud crawling and a one-pixel wireframe breaking up.
const EXPORT_SS = 2;

// The layer stack. All of it is snapshotted into a view, so one key can
// swap the whole look of the shot.
const DEFAULT_LAYERS = {
    bgColor: '#000000',

    videoOn: true,
    videoOpacity: 1,

    cloudOn: false,
    cloudColorMode: 'scan',   // 'scan' = sampled texture colour, 'solid'
    cloudColor: '#f2f0e6',
    cloudSize: 1.6,
    cloudOpacity: 1,
    cloudDensity: 0.6,        // fraction of the 300k sampled points drawn
    cloudAttenuate: true,
    // The scan's own points react to the music like any placed cloud. Kept in
    // the layer stack rather than beside the scene objects so a cut can turn
    // the object itself into the thing that moves.
    cloudReact: 0,            // 0 leaves the scan geometrically true
    cloudScatter: 0.002,
    cloudFreqLow: 0,
    cloudFreqHigh: 1,
    cloudPulseX: 0,
    cloudPulseY: 0,
    cloudPulseZ: 0,

    meshOn: false,
    meshShading: 'matte',
    meshColor: '#2b4bdf',
    meshOpacity: 1,

    wireOn: false,
    wireColor: '#e8c56a',
    wireOpacity: 0.5,
    wireLevel: 'medium',
    // As a fraction of frame height, so the preview and a 1440p export show
    // the same weight of line rather than the same number of pixels.
    wireThickness: 0.0015,
    wireReact: 0,

    // Placed objects as one group, so the Scene panel's contents can be faded
    // in and out of a shot without editing each item.
    sceneOpacity: 1,

    // One envelope, read off a chosen slice of the spectrum, multiplying the
    // opacity of whichever layers opt in. In 'band' it breathes with the
    // level above a floor; in 'gate' it snaps on when the band crosses the
    // threshold, which is how you get points flashing on the beat.
    opacityReact: 0,
    opacityMode: 'band',      // 'band' | 'gate'
    opacityFreqLow: 0,
    opacityFreqHigh: 0.12,
    opacityThreshold: 0.25,
    opacityInvert: false,
    opacitySmooth: 0.4,
    opacityPoints: true,
    opacityWire: false,
    opacityMesh: false,
    opacityScene: false,
};

// Kept out of the views: these describe the solve, not the look, so recalling
// a view should never disturb them.
const DEFAULT_RIG = {
    cameraMode: 'tracked',    // 'tracked' | 'free'
    offsetX: 0, offsetY: 0, offsetZ: 0,
    rotX: 0, rotY: 0, rotZ: 0,
    scale: 1,
    // Pushes the overlays off the surface so the mesh does not clip through
    // them. The mesh itself stays at 1, so the scan keeps its true size.
    overscale: 1,
    // Shifts the points and wireframe bodily off the mesh. Swell can only
    // move them along the line from the centre; this detaches them in a
    // direction of your choosing, which is what a drifting double image of
    // the object needs.
    overlayX: 0, overlayY: 0, overlayZ: 0,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function ScanCompositor() {
    const mountRef = useRef(null);
    const videoRef = useRef(null);
    // The take reversed, published beside it. Ping-pong plays this forwards
    // rather than seeking the take backwards, which no browser does well.
    const revVideoRef = useRef(null);

    const [clips, setClips] = useState([]);
    const [clipId, setClipId] = useState(null);
    const [track, setTrack] = useState(null);
    const [status, setStatus] = useState('Loading takes...');

    const [layers, setLayers] = useState(DEFAULT_LAYERS);
    const [rig, setRig] = useState(DEFAULT_RIG);
    const [menuOpen, setMenuOpen] = useState(true);

    const [presets, setPresets] = useState(() => Array(9).fill(null));
    const [activePreset, setActivePreset] = useState(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [loopMode, setLoopMode] = useState('loop');
    // Jump over stretches the solver could not place a camera for, rather than
    // showing a frozen camera drifting against moving footage.
    const [skipUnsolved, setSkipUnsolved] = useState(true);
    const [muted, setMuted] = useState(false);
    const [revReady, setRevReady] = useState(false);
    const revReadyRef = useRef(false);
    // Set while a turnaround waits for the incoming copy's first frame.
    const handoverRef = useRef(null);
    useEffect(() => { revReadyRef.current = revReady; }, [revReady]);
    const [speed, setSpeed] = useState(1);

    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);
    const [exportStage, setExportStage] = useState('');
    const [exportScale, setExportScale] = useState(1);
    const [exportQuality, setExportQuality] = useState(0.4);
    const [exportLength, setExportLength] = useState('clip');
    const [exportLoops, setExportLoops] = useState(2);

    // ---- Audio-reactive scene (shared engine with the Audio Visualizer) ----
    const [sceneOpen, setSceneOpen] = useState(false);
    const [sceneItems, setSceneItems] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [addAssetId, setAddAssetId] = useState('sphere');
    const [addCurveId, setAddCurveId] = useState(CURVES[0].id);
    const [trackName, setTrackName] = useState('');
    const [audioReady, setAudioReady] = useState(false);
    // Depth-only draw of the scan, so overlays can be hidden where the real
    // object would be in front of them.
    const [occlude, setOcclude] = useState(false);

    const audioRef = useRef(null);
    const audioCtxRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const audioBufferRef = useRef(null);
    const audioUrlRef = useRef(null);
    const fileInputRef = useRef(null);
    const sceneObjectsRef = useRef(new Map());
    const plyCacheRef = useRef(new Map());
    const sceneItemsRef = useRef(sceneItems);
    const spectrogramRef = useRef(null);
    const lastTickRef = useRef(0);
    // The clip's own soundtrack, decoded out of its mp4 so the exporter can
    // mux it. Only fetched when something actually asks for it.
    const clipAudioRef = useRef({ id: null, buffer: null, promise: null });
    // Opacity envelope state. Held outside React so the render loop can
    // advance it without a re-render, and reset before an export so the
    // result does not depend on what the preview was doing beforehand.
    const opacityEnvRef = useRef({ v: 0 });

    useEffect(() => { sceneItemsRef.current = sceneItems; }, [sceneItems]);


    // Live mirrors so the render loop never closes over stale state.
    const layersRef = useRef(layers);
    const rigRef = useRef(rig);
    const trackRef = useRef(null);
    const presetsRef = useRef(presets);
    const activePresetRef = useRef(activePreset);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    useEffect(() => { layersRef.current = layers; }, [layers]);
    useEffect(() => { rigRef.current = rig; }, [rig]);
    useEffect(() => { presetsRef.current = presets; }, [presets]);
    useEffect(() => { activePresetRef.current = activePreset; }, [activePreset]);

    // three.js objects, built once and mutated in place.
    const three = useRef({
        renderer: null, scene: null, camera: null, freeCamera: null,
        controls: null, modelRoot: null, mesh: null, cloud: null, wire: null,
        bgScene: null, bgCamera: null, bgQuad: null, videoTexture: null,
        materials: {}, raf: 0, needsRender: true,
    });

    const clip = useMemo(
        () => clips.find((c) => c.id === clipId) || null,
        [clips, clipId],
    );

    // Two stacked control columns. Each element sits clear of whatever is to
    // its right: a panel takes a full column, a closed one only its toggle. So
    // the Scene panel moves aside only when the compositor panel is open, and
    // the compositor's toggle steps left when the Scene panel has taken the
    // right-hand column - which is what stops the toggle landing on top of the
    // other panel's close button.
    const narrow = useMediaQuery('(max-width: 820px)');
    const COL = 306; // panel width + gap
    const TOGGLE_COL = 46; // toggle width + gap
    const slide = (offset) => ({ right: `calc(var(--gutter) + ${offset}px)` });
    const layout = useMemo(() => {
        if (narrow) {
            // No room for two columns; only one panel is open at a time, so
            // everything can sit flush right.
            return {
                menuPanel: 0, menuToggle: 0, scenePanel: 0, sceneToggle: TOGGLE_COL,
            };
        }
        return {
            menuPanel: 0,
            menuToggle: sceneOpen ? COL : 0,
            scenePanel: menuOpen ? COL : 0,
            sceneToggle: menuOpen ? COL : TOGGLE_COL,
        };
    }, [narrow, menuOpen, sceneOpen]);

    // Narrow viewports have room for one column, so opening either panel puts
    // the other away rather than letting them overlap.
    useEffect(() => {
        if (narrow && menuOpen && sceneOpen) setSceneOpen(false);
    }, [narrow, menuOpen, sceneOpen]);

    const selected = useMemo(
        () => sceneItems.find((i) => i.id === selectedId) || null,
        [sceneItems, selectedId],
    );

    // Contiguous runs of solved frames, and a flat lookup for "is this frame
    // placed?". A take can be missing its tail, a stretch in the middle, or
    // nothing at all, so playback and export both work off these rather than
    // assuming the solve covers the clip.
    const coverage = useMemo(() => {
        if (!track || !track.frames || !track.frames.length) {
            return { spans: [], mask: null, unsolved: 0 };
        }
        const last = track.frames[track.frames.length - 1].i;
        const mask = new Uint8Array(last + 1);
        track.frames.forEach((f) => { mask[f.i] = f.solved ? 1 : 0; });

        const spans = [];
        let start = null;
        for (let i = 0; i <= last; i++) {
            if (mask[i] && start === null) start = i;
            else if (!mask[i] && start !== null) { spans.push([start, i - 1]); start = null; }
        }
        if (start !== null) spans.push([start, last]);

        let unsolved = 0;
        for (let i = 0; i <= last; i++) if (!mask[i]) unsolved++;
        return { spans, mask, unsolved };
    }, [track]);

    const coverageRef = useRef(coverage);
    const skipUnsolvedRef = useRef(skipUnsolved);
    const loopModeRef = useRef(loopMode);
    const speedRef = useRef(speed);
    // Transport state the tick owns. Running backwards means the video element
    // is paused and its clock is being driven by hand, so the element's own
    // paused flag can no longer say whether the transport is rolling.
    const playingRef = useRef(false);
    // Which copy of the clip is on screen: 1 the take, -1 its reversed copy.
    const dirRef = useRef(1);
    useEffect(() => { coverageRef.current = coverage; }, [coverage]);
    useEffect(() => { skipUnsolvedRef.current = skipUnsolved; }, [skipUnsolved]);
    useEffect(() => { speedRef.current = speed; }, [speed]);

    // Some parameters only apply to the generated sphere, not to a loaded PLY.
    const selectedAssetType = useMemo(() => (
        selected && selected.kind === 'asset'
            ? ASSETS.find((a) => a.id === selected.assetId)?.type
            : null
    ), [selected]);

    // ---- Manifest --------------------------------------------------------

    useEffect(() => {
        let alive = true;
        fetch(MANIFEST_URL)
            .then((r) => {
                if (!r.ok) throw new Error(`manifest ${r.status}`);
                return r.json();
            })
            .then((list) => {
                if (!alive) return;
                setClips(list);
                if (list.length) setClipId(list[0].id);
                else setStatus('No takes in public/mv/manifest.json');
            })
            .catch((e) => alive && setStatus(`Could not load takes: ${e.message}`));
        return () => { alive = false; };
    }, []);

    // ---- Scene graph -----------------------------------------------------

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return undefined;

        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            // The export path builds a VideoFrame straight off this canvas, so
            // the drawing buffer has to survive past the draw call.
            preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.autoClear = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';

        const scene = new THREE.Scene();
        const modelRoot = new THREE.Group();
        scene.add(modelRoot);

        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 1.1);
        key.position.set(2, 3, 2);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-2, -1, -2);
        scene.add(fill);

        // The tracked camera's frustum is rebuilt from the solved intrinsics
        // each frame, so its constructor arguments are placeholders.
        const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 100);
        const freeCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.001, 1000);
        freeCamera.position.set(0, 0, 4);

        const controls = new OrbitControls(freeCamera, renderer.domElement);
        controls.enableDamping = true;
        controls.enabled = false;

        // Background pass: the footage as a screen-filling quad drawn before
        // the scene, so one canvas holds the finished composite and export is
        // just an encode of that canvas.
        const bgScene = new THREE.Scene();
        const bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const bgQuad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
        );
        bgScene.add(bgQuad);

        three.current = {
            ...three.current,
            renderer, scene, camera, freeCamera, controls, modelRoot,
            bgScene, bgCamera, bgQuad,
        };

        return () => {
            cancelAnimationFrame(three.current.raf);
            controls.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode === mount) {
                mount.removeChild(renderer.domElement);
            }
        };
    }, []);

    // ---- Material / visibility sync --------------------------------------

    const applyLayers = useCallback((L) => {
        const t = three.current;
        if (!t.renderer) return;

        if (t.bgQuad) {
            const freeCam = rigRef.current.cameraMode === 'free';
            // In free orbit the footage no longer corresponds to the view, so
            // showing it would only mislead.
            t.bgQuad.visible = L.videoOn && !freeCam && !!t.videoTexture;
            t.bgQuad.material.opacity = L.videoOpacity;
        }

        if (t.mesh) {
            t.mesh.visible = L.meshOn;
            if (L.meshOn) {
                const want = L.meshShading;
                let mat = t.mesh.material;
                const needs = (type) => !mat || mat.userData.kind !== type;

                if (want === 'textured') {
                    if (mat !== t.materials.textured) {
                        t.mesh.material = t.materials.textured;
                        mat = t.mesh.material;
                    }
                } else if (want === 'normal') {
                    if (needs('normal')) {
                        mat = new THREE.MeshNormalMaterial();
                        mat.userData.kind = 'normal';
                        t.mesh.material = mat;
                    }
                } else if (want === 'shaded') {
                    if (needs('shaded')) {
                        mat = new THREE.MeshLambertMaterial();
                        mat.userData.kind = 'shaded';
                        t.mesh.material = mat;
                    }
                    mat.color.set(L.meshColor);
                } else {
                    if (needs('matte')) {
                        mat = new THREE.MeshBasicMaterial();
                        mat.userData.kind = 'matte';
                        t.mesh.material = mat;
                    }
                    mat.color.set(L.meshColor);
                }
                mat = t.mesh.material;
                mat.transparent = L.meshOpacity < 1;
                mat.opacity = L.meshOpacity;
                mat.depthWrite = L.meshOpacity >= 1;
                mat.needsUpdate = true;
            }
        }

        if (t.wire) {
            t.wire.visible = L.wireOn;
            const m = t.wire.material;
            m.color.set(L.wireColor);
            m.opacity = L.wireOpacity;
            // Fat lines need the draw size to turn a pixel width into clip
            // space, and the width itself is a fraction of frame height so the
            // preview and a full-resolution export match.
            const size = t.renderer.getDrawingBufferSize(new THREE.Vector2());
            m.resolution.set(size.x, size.y);
            m.linewidth = Math.max(0.5, L.wireThickness * size.y);
            m.needsUpdate = true;
        }

        if (t.cloud) {
            t.cloud.visible = L.cloudOn;
            const m = t.cloud.material;
            const useScan = L.cloudColorMode === 'scan'
                && !!t.cloud.geometry.getAttribute('color');
            m.vertexColors = useScan;
            m.color.set(useScan ? '#ffffff' : L.cloudColor);
            // With attenuation the size is in scan units, which keeps the
            // preview and the export looking identical; without it the size is
            // in screen pixels and so depends on the output resolution.
            m.sizeAttenuation = L.cloudAttenuate;
            // A screen-space size is in drawing-buffer pixels, so it has to
            // follow the export's supersample factor or the points would come
            // out smaller than previewed once the frame is filtered down.
            m.size = L.cloudAttenuate
                ? (L.cloudSize / 1000) * 4
                : L.cloudSize * 1.5 * (t.ss || 1);
            m.opacity = L.cloudOpacity;
            m.transparent = L.cloudOpacity < 1;
            m.depthWrite = L.cloudOpacity >= 1;
            m.needsUpdate = true;

            const total = t.cloud.geometry.getAttribute('position').count;
            t.cloud.geometry.setDrawRange(
                0, Math.max(1, Math.floor(total * clamp01(L.cloudDensity))),
            );
        }

        // Swell the overlays slightly off the surface. Scaling happens about
        // the model root, which a scan is centred on, so points and edges lift
        // away from the mesh evenly instead of sliding to one side. The offset
        // then slides them as a body, which swell cannot do.
        const R = rigRef.current;
        const over = R.overscale ?? 1;
        [t.cloud, t.wire].forEach((o) => {
            if (!o) return;
            o.scale.setScalar(over);
            o.position.set(R.overlayX ?? 0, R.overlayY ?? 0, R.overlayZ ?? 0);
        });

        t.renderer.setClearColor(new THREE.Color(L.bgColor), 1);
        t.needsRender = true;
    }, []);

    // ---- Audio-reactive scene --------------------------------------------

    // Visualizer defaults are sized for a free-flying scene tens of units
    // across; a scan is a couple of units. Scale new items to the take so they
    // arrive at a sensible size next to the object instead of swallowing it.
    const scaleForScan = useCallback(() => {
        const t = three.current;
        const r = t.cloud?.geometry?.boundingSphere?.radius;
        return r && Number.isFinite(r) ? r : 1;
    }, []);

    const addAsset = useCallback(() => {
        const r = scaleForScan();
        const item = makeItem(addAssetId, true, {
            radius: r * 1.4,
            pointSize: Math.max(0.0015, r * 0.004),
            maxPoints: 40000,
            samples: 20000,
            scale: 1,
        });
        // A PLY asset arrives in its own units, so fit it to the scan instead.
        if (ASSETS.find((a) => a.id === addAssetId)?.type === 'ply') {
            item.op.scale = r * 0.08;
        }
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    }, [addAssetId, scaleForScan]);

    const addCurve = useCallback(() => {
        const r = scaleForScan();
        const item = makeCurveItem(addCurveId, true, {
            curveScale: r * 1.2,
            dotSize: Math.max(0.01, r * 0.02),
        });
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    }, [addCurveId, scaleForScan]);

    const removeItem = useCallback((id) => {
        setSceneItems((prev) => prev.filter((i) => i.id !== id));
        setSelectedId((cur) => (cur === id ? null : cur));
    }, []);

    const setItemParam = useCallback((key) => (value) => {
        setSceneItems((prev) => prev.map((i) => (
            i.id === selectedId ? { ...i, op: { ...i.op, [key]: value } } : i
        )));
    }, [selectedId]);

    // Reconcile the scene graph with the item list: add what is new, drop what
    // is gone, and rebuild only the items whose geometry parameters moved.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        const map = sceneObjectsRef.current;
        const wanted = new Set(sceneItems.map((i) => i.id));

        Array.from(map.keys()).forEach((id) => {
            if (!wanted.has(id)) {
                disposeRecord(map.get(id));
                map.delete(id);
            }
        });

        const attach = (item, record) => {
            record.reactive = item.reactive;
            record.op = item.op;
            record.object3D.userData.itemId = item.id;
            record.object3D.frustumCulled = false;
            applyRecordTransform(record, item.op);
            t.modelRoot.add(record.object3D);
            map.set(item.id, record);
            t.needsRender = true;
        };

        sceneItems.forEach((item) => {
            const rec = map.get(item.id);

            if (item.kind === 'curve') {
                const key = CURVE_GEOM_KEYS.map((k) => item.op[k]).join('|');
                if (rec && rec.curveKey === key && rec.curve?.id === item.funcId) {
                    rec.op = item.op;
                    rec.reactive = item.reactive;
                    rec.colA = new THREE.Color(item.op.startColor);
                    rec.colB = new THREE.Color(item.op.endColor);
                    applyRecordTransform(rec, item.op);
                    return;
                }
                if (rec) { disposeRecord(rec); map.delete(item.id); }
                const next = buildCurveRecord(item.funcId, item.op);
                next.curveKey = key;
                attach(item, next);
                return;
            }

            const asset = ASSETS.find((a) => a.id === item.assetId);
            if (!asset || asset.type === 'glb') return;
            const key = GEOM_KEYS.map((k) => item.op[k]).join('|');
            if (rec && rec.geomKey === key) {
                rec.op = item.op;
                rec.reactive = item.reactive;
                // Pulse origin moved, so the cached directions are stale.
                rec.dirs = null;
                applyRecordTransform(rec, item.op);
                return;
            }
            if (rec && rec.loading) return;

            const build = (raw) => {
                const old = map.get(item.id);
                if (old) { disposeRecord(old); map.delete(item.id); }
                const next = buildPointCloudRecord(raw, item.op, asset.type);
                next.geomKey = key;
                attach(item, next);
            };

            if (asset.type === 'sphere') {
                build(fibonacciSphere(item.op.samples, item.op.radius, item.op.jitter));
            } else {
                map.set(item.id, { loading: true });
                loadPlyPoints(asset.path, plyCacheRef.current)
                    .then(build)
                    .catch(() => map.delete(item.id));
            }
        });
    }, [sceneItems]);

    // ---- Wireframe -------------------------------------------------------
    // Its own layer, loaded per resolution, because the useful density of a
    // wireframe is a look rather than a constant. Drawn as fat lines
    // (LineSegments2) since WebGL ignores lineWidth on ordinary LineSegments,
    // which is why thickness could not be configured before.
    useEffect(() => {
        const t = three.current;
        if (!clip || !t.modelRoot) return undefined;
        if (!layers.wireOn && !t.wire) return undefined;

        let alive = true;
        const level = layers.wireLevel;
        const url = `${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}_wire_${level}.glb`;

        new GLTFLoader().loadAsync(url)
            .then((gltf) => {
                if (!alive) return;
                let src = null;
                gltf.scene.updateMatrixWorld(true);
                gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
                if (!src) throw new Error('no mesh in wireframe GLB');

                const geo = src.geometry.clone();
                geo.applyMatrix4(src.matrixWorld);
                const topo = buildWireTopology(geo);
                geo.dispose();

                // Two endpoints per segment, laid out as the interleaved
                // buffer LineSegmentsGeometry expects.
                const flat = new Float32Array((topo.edges.length / 2) * 6);
                for (let i = 0; i < topo.edges.length / 2; i++) {
                    const a = topo.edges[i * 2] * 3;
                    const b = topo.edges[i * 2 + 1] * 3;
                    flat[i * 6] = topo.positions[a];
                    flat[i * 6 + 1] = topo.positions[a + 1];
                    flat[i * 6 + 2] = topo.positions[a + 2];
                    flat[i * 6 + 3] = topo.positions[b];
                    flat[i * 6 + 4] = topo.positions[b + 1];
                    flat[i * 6 + 5] = topo.positions[b + 2];
                }

                if (t.wire) {
                    t.modelRoot.remove(t.wire);
                    t.wire.geometry.dispose();
                    t.wire.material.dispose();
                }

                const lineGeo = new LineSegmentsGeometry();
                lineGeo.setPositions(flat);
                const mat = new LineMaterial({
                    color: new THREE.Color(layersRef.current.wireColor),
                    transparent: true,
                    depthWrite: false,
                    linewidth: 1,
                });
                const seg = new LineSegments2(lineGeo, mat);
                seg.frustumCulled = false;
                t.wire = seg;
                t.wireEdges = topo.edges;
                t.wireBuffer = lineGeo.attributes.instanceStart.data;
                t.wireState = {
                    base: topo.positions,
                    dirs: null, dists: null, freqIndex: null,
                    key: null, dirty: false, moved: null,
                };
                t.modelRoot.add(seg);
                applyLayers(layersRef.current);
                t.needsRender = true;
            })
            .catch((e) => alive && setStatus(`Wireframe failed: ${e.message}`));

        return () => { alive = false; };
    }, [clip, layers.wireLevel, layers.wireOn, applyLayers]);

    // Depth-only copy of the scan. Drawing it before everything else, with
    // colour writes off, means points, wireframe and placed objects are hidden
    // wherever the real object stands in front of them - whether or not the
    // mesh layer itself is being shown.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        if (t.occluder) {
            t.modelRoot.remove(t.occluder);
            t.occluder.material.dispose();
            t.occluder = null;
        }
        if (occlude && t.mesh) {
            const occ = new THREE.Mesh(
                t.mesh.geometry,
                new THREE.MeshBasicMaterial({ colorWrite: false }),
            );
            occ.frustumCulled = false;
            occ.renderOrder = -1; // lay the depth down first
            t.occluder = occ;
            t.modelRoot.add(occ);
        }
        t.needsRender = true;
    }, [occlude, track]);

    // ---- Audio -----------------------------------------------------------

    const attachAnalyser = useCallback(() => {
        const el = audioRef.current;
        if (!el || analyserRef.current) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        ctx.createMediaElementSource(el).connect(analyser);
        analyser.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    }, []);

    // Decoded separately from playback: the exporter cannot use a live
    // analyser, so it needs the samples to analyse offline.
    const loadAudio = useCallback(async (url, name) => {
        const el = audioRef.current;
        if (!el) return;
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = url.startsWith('blob:') ? url : null;

        el.src = url;
        el.load();
        setTrackName(name);
        setAudioReady(false);
        spectrogramRef.current = null;
        try {
            const buf = await fetch(url).then((r) => r.arrayBuffer());
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = audioCtxRef.current || new Ctx();
            audioCtxRef.current = ctx;
            audioBufferRef.current = await ctx.decodeAudioData(buf.slice(0));
            setAudioReady(true);
        } catch (e) {
            setStatus(`Could not decode audio: ${e.message}`);
        }
    }, []);

    const onAudioFile = useCallback((file) => {
        if (!file) return;
        loadAudio(URL.createObjectURL(file), file.name);
    }, [loadAudio]);

    // ---- Per-clip assets -------------------------------------------------

    useEffect(() => {
        if (!clip) return undefined;
        const t = three.current;
        if (!t.scene) return undefined;

        let alive = true;
        setStatus(`Loading ${clip.label}...`);
        setTrack(null);
        trackRef.current = null;

        // Drop whatever the previous take left behind.
        [t.mesh, t.cloud].forEach((obj) => {
            if (!obj) return;
            t.modelRoot.remove(obj);
            obj.geometry?.dispose();
            if (obj.material && obj.material !== t.materials.textured) {
                obj.material.dispose?.();
            }
        });
        if (t.materials.textured) {
            t.materials.textured.map?.dispose?.();
            t.materials.textured.dispose?.();
            t.materials.textured = null;
        }
        t.mesh = t.cloud = null;

        const base = `${process.env.PUBLIC_URL}/mv/${clip.id}`;

        // A take without a solve is still worth opening: the scan loads and
        // free orbit works, there is just no footage to lock onto.
        const trackP = fetch(`${base}/track.json`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
        const glbP = new GLTFLoader().loadAsync(`${base}/${clip.id}.glb`);
        const plyP = new PLYLoader().loadAsync(`${base}/${clip.id}.ply`);
        Promise.all([trackP, glbP, plyP])
            .then(([trackData, gltf, cloudGeo]) => {
                if (!alive) return;

                // --- mesh + wireframe
                let src = null;
                gltf.scene.updateMatrixWorld(true);
                gltf.scene.traverse((o) => {
                    if (!src && o.isMesh) src = o;
                });
                if (!src) throw new Error('no mesh in GLB');

                const geo = src.geometry.clone();
                geo.applyMatrix4(src.matrixWorld);
                geo.computeVertexNormals();

                t.materials.textured = src.material;
                const mesh = new THREE.Mesh(geo, src.material);
                mesh.frustumCulled = false;
                t.mesh = mesh;
                t.modelRoot.add(mesh);

                // PLY colours are sampled straight out of the scan's sRGB
                // texture, but three treats vertex colours as already being in
                // the linear working space. Without this the cloud reads
                // noticeably brighter than the same surface on the mesh.
                const colorAttr = cloudGeo.getAttribute('color');
                if (colorAttr) {
                    const a = colorAttr.array;
                    for (let i = 0; i < a.length; i++) {
                        a[i] = a[i] <= 0.04045
                            ? a[i] / 12.92
                            : ((a[i] + 0.055) / 1.055) ** 2.4;
                    }
                    colorAttr.needsUpdate = true;
                }

                cloudGeo.computeBoundingSphere();

                // Keep the scan's true positions; audio displacement is always
                // computed from these, never from the previous frame, so it
                // cannot accumulate drift.
                t.cloudReact = {
                    base: Float32Array.from(cloudGeo.getAttribute('position').array),
                    dirs: null,
                    dists: null,
                    freqIndex: null,
                    key: null,
                    dirty: false,
                };

                // Frame the free-orbit camera on the scan so switching to it
                // lands on the object rather than somewhere off in space.
                const sphere = cloudGeo.boundingSphere;
                if (sphere) {
                    t.controls.target.copy(sphere.center);
                    t.freeCamera.position.set(
                        sphere.center.x,
                        sphere.center.y,
                        sphere.center.z + sphere.radius * 2.6,
                    );
                    t.controls.update();
                }

                const cloud = new THREE.Points(
                    cloudGeo,
                    new THREE.PointsMaterial({ transparent: true }),
                );
                cloud.frustumCulled = false;
                t.cloud = cloud;
                t.modelRoot.add(cloud);

                // Without a solve there is no tracked camera to use, so fall
                // back to a plain viewer around the scan.
                const resolved = trackData || {
                    fps: 30,
                    frame_count: 1,
                    solved_count: 0,
                    frames: [],
                    intrinsics: { aspect: 4 / 3, width: 1440, height: 1080 },
                    unsolved: true,
                };
                setTrack(resolved);
                trackRef.current = resolved;
                // The layer state has not changed, so the effect that syncs
                // materials will not fire; push the current settings onto the
                // objects that were just built.
                applyLayers(layersRef.current);
                t.needsRender = true;

                if (resolved.unsolved) {
                    setRig((p) => ({ ...p, cameraMode: 'free' }));
                    setLayers((p) => ({ ...p, videoOn: false, meshOn: true }));
                    setStatus('No solve for this take — free orbit only');
                } else {
                    const pct = Math.round(
                        (resolved.solved_count / resolved.frame_count) * 100,
                    );
                    const q = resolved.alignment?.quality;
                    setStatus(
                        `${resolved.frame_count} frames, ${pct}% solved`
                        + (q ? ` · fit ${(q.inlier_fraction_2pct * 100).toFixed(0)}%` : ''),
                    );
                }
            })
            .catch((e) => alive && setStatus(`Load failed: ${e.message}`));

        return () => { alive = false; };
    }, [clip, applyLayers]);

    // ---- Video element / texture ----------------------------------------

    // Each element gets its own texture; turning around swaps which one the
    // background quad samples.
    const makeTexture = (el) => {
        const tex = new THREE.VideoTexture(el);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        return tex;
    };

    const showVideo = useCallback((dir) => {
        const t = three.current;
        handoverRef.current = null;
        dirRef.current = dir;
        const tex = dir < 0 ? t.texRev : t.texFwd;
        if (tex && t.bgQuad) {
            t.videoTexture = tex;
            t.bgQuad.material.map = tex;
            t.bgQuad.material.needsUpdate = true;
        }
        t.videoDirty = 3;
        t.needsRender = true;
    }, []);

    const attachVideo = useCallback((el) => {
        videoRef.current = el;
        const t = three.current;
        if (!el || !t.bgQuad) return;
        t.texFwd?.dispose();
        t.texFwd = makeTexture(el);
        if (dirRef.current > 0) {
            t.videoTexture = t.texFwd;
            t.bgQuad.material.map = t.texFwd;
            t.bgQuad.material.needsUpdate = true;
        }
    }, []);

    const attachRevVideo = useCallback((el) => {
        revVideoRef.current = el;
        const t = three.current;
        if (!el) return;
        t.texRev?.dispose();
        t.texRev = makeTexture(el);
    }, []);

    // The reversed copy runs on its own clock, so its position has to be read
    // back as a position in the take. Scaled by the two durations rather than
    // subtracted outright, so a copy that lands a frame short still maps onto
    // the take exactly at both ends.
    const takeTime = useCallback((el) => {
        if (!el) return 0;
        if (dirRef.current >= 0) return el.currentTime;
        const d = videoRef.current?.duration || el.duration || 0;
        const rd = el.duration || d || 1;
        return Math.max(0, d - (el.currentTime * d) / rd);
    }, []);

    // Put the playhead at a position in the take, whichever copy is running.
    const seekTake = useCallback((at) => {
        const fwd = videoRef.current;
        const rev = revVideoRef.current;
        if (dirRef.current < 0 && rev) {
            const d = fwd?.duration || rev.duration || 1;
            const rd = rev.duration || d;
            rev.currentTime = Math.max(0, ((d - at) * rd) / d);
        } else if (fwd) {
            fwd.currentTime = at;
        }
    }, []);

    // Put the other copy on screen only once it has a frame of its own up.
    // Switching straight away uploads whatever that element last decoded -
    // the far end of the take - under the turnaround's pose for a frame or
    // two. Until then the outgoing copy holds its last frame, and the
    // playhead with it. `after` runs once the switch is made.
    const handOver = useCallback((el, dir, after) => {
        const token = {};
        handoverRef.current = token;
        const finish = () => {
            if (handoverRef.current !== token) return;
            handoverRef.current = null;
            showVideo(dir);
            after?.();
        };
        if (el.requestVideoFrameCallback) {
            el.requestVideoFrameCallback(finish);
        } else {
            el.addEventListener('seeked', finish, { once: true });
            el.addEventListener('playing', finish, { once: true });
        }
        // A paused element presents nothing new, so don't wait on it forever.
        setTimeout(finish, 300);
    }, [showVideo]);

    // Hand the clip back to the take, from the top.
    const goForward = useCallback(() => {
        const fwd = videoRef.current;
        const rev = revVideoRef.current;
        if (handoverRef.current) return;
        rev?.pause();
        if (!fwd) { showVideo(1); return; }
        // Normally parked there already, and re-seeking would only make the
        // decoder fetch the same frame again.
        if (fwd.currentTime > 0.001) fwd.currentTime = 0;
        if (playingRef.current && !exportingRef.current) {
            fwd.play().catch(() => {});
        }
        // Park the reversed copy at its start, ready for the next way back.
        handOver(fwd, 1, () => { if (rev) rev.currentTime = 0; });
    }, [showVideo, handOver]);

    // The take ran out going forwards. In ping-pong the reversed copy takes
    // over; in the other modes this is simply the end.
    //
    // `from` is where in the take to turn around, which is the end of the
    // clip when it played all the way out, but the end of the solved footage
    // when a take's tail has no camera and the gap skipper got there first.
    const goBackward = useCallback((from) => {
        const rev = revVideoRef.current;
        if (exportingRef.current || !playingRef.current) return;
        if (loopModeRef.current === 'bounce' && rev && revReadyRef.current) {
            if (dirRef.current < 0 || handoverRef.current) return;
            const fwd = videoRef.current;
            const d = fwd?.duration || rev.duration || 1;
            const rd = rev.duration || d;
            const at = Number.isFinite(from) ? Math.min(from, d) : d;
            fwd?.pause();
            const target = Math.max(0, ((d - at) * rd) / d);
            if (Math.abs(rev.currentTime - target) > 0.001) {
                rev.currentTime = target;
            }
            rev.playbackRate = speedRef.current;
            rev.play().catch(() => {});
            // Park the take at its top, ready for the way forward again.
            handOver(rev, -1, () => { if (fwd) fwd.currentTime = 0; });
            return;
        }
        if (loopModeRef.current === 'off') {
            playingRef.current = false;
            setIsPlaying(false);
        }
    }, [handOver]);

    // A video element reaches its last frame a little short of the duration
    // it reports, so the end has to be tested with some room.
    const atEnd = useCallback(
        (v) => v.ended || v.currentTime >= v.duration - 0.05, [],
    );

    useEffect(() => {
        loopModeRef.current = loopMode;
        // Leaving ping-pong mid-return hands the clip back to the take.
        if (loopMode !== 'bounce' && dirRef.current < 0) goForward();
    }, [loopMode, goForward]);

    // ---- Sizing ----------------------------------------------------------
    // The canvas is locked to the footage's aspect and letterboxed, so image
    // space and render space agree exactly and the overlay cannot drift.

    useEffect(() => {
        const mount = mountRef.current;
        const t = three.current;
        if (!mount || !t.renderer || !track) return undefined;

        const aspect = track.intrinsics.aspect;

        const resize = () => {
            if (exportingRef.current) return;
            const box = mount.parentElement;
            if (!box) return;
            const availW = box.clientWidth;
            const availH = box.clientHeight;
            if (!availW || !availH) return;

            let w = availW;
            let h = w / aspect;
            if (h > availH) { h = availH; w = h * aspect; }

            mount.style.width = `${Math.round(w)}px`;
            mount.style.height = `${Math.round(h)}px`;
            t.renderer.setSize(Math.round(w), Math.round(h), true);
            applyLayers(layersRef.current);
            t.needsRender = true;
        };

        resize();
        const ro = new ResizeObserver(resize);
        if (mount.parentElement) ro.observe(mount.parentElement);
        window.addEventListener('resize', resize);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', resize);
        };
    }, [track, applyLayers]);

    // ---- Pose sampling ---------------------------------------------------

    // Interpolating between the two bracketing solved frames keeps scrubbing
    // and slow motion smooth instead of stepping frame to frame.
    const poseAt = useCallback((time, trackData) => {
        const frames = trackData.frames;
        if (!frames.length) return null;
        const x = Math.max(0, Math.min(frames.length - 1, time * trackData.fps));
        const i0 = Math.floor(x);
        const i1 = Math.min(frames.length - 1, i0 + 1);
        const f = x - i0;
        const a = frames[i0];
        const b = frames[i1];

        const pos = new THREE.Vector3(a.p[0], a.p[1], a.p[2]);
        const quat = new THREE.Quaternion(a.q[0], a.q[1], a.q[2], a.q[3]);
        if (i1 !== i0 && f > 0) {
            pos.lerp(new THREE.Vector3(b.p[0], b.p[1], b.p[2]), f);
            quat.slerp(new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), f);
        }
        return { pos, quat, solved: a.solved && b.solved };
    }, []);

    // Rebuild the frustum from fx/fy/cx/cy rather than trusting a single fov.
    // An off-centre principal point is a real shear in the projection, and
    // ignoring it would slide the overlay across the frame.
    const applyIntrinsics = useCallback((cam, intr) => {
        const { fx, fy, cx, cy, width, height } = intr;
        const near = 0.005;
        const far = 200;
        const left = (-cx / fx) * near;
        const right = ((width - cx) / fx) * near;
        const top = (cy / fy) * near;
        const bottom = (-(height - cy) / fy) * near;
        cam.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
        cam.near = near;
        cam.far = far;
    }, []);

    useEffect(() => { applyLayers(layers); }, [layers, applyLayers, rig.cameraMode]);

    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        t.modelRoot.position.set(rig.offsetX, rig.offsetY, rig.offsetZ);
        t.modelRoot.rotation.set(
            THREE.MathUtils.degToRad(rig.rotX),
            THREE.MathUtils.degToRad(rig.rotY),
            THREE.MathUtils.degToRad(rig.rotZ),
        );
        t.modelRoot.scale.setScalar(rig.scale);
        if (t.controls) t.controls.enabled = rig.cameraMode === 'free';
        applyLayers(layersRef.current);
        t.needsRender = true;
    }, [rig, applyLayers]);

    // ---- Render loop -----------------------------------------------------

    const renderFrame = useCallback((time) => {
        const t = three.current;
        const trackData = trackRef.current;
        if (!t.renderer || !trackData) return;

        const L = layersRef.current;
        const R = rigRef.current;
        let cam = t.camera;

        // VideoTexture only refreshes itself off the video's own frame
        // callbacks, which never fire while paused or mid-seek - so a still
        // frame can leave the quad showing an empty (white) texture. Upload
        // explicitly whenever the frame could have changed.
        //
        // The time comparison alone is not enough: an upload taken the instant
        // a seek lands can read a frame the decoder has not produced yet, and
        // since the time now matches, nothing ever uploads again and the
        // footage stays blank until playback resumes. So a settled seek asks
        // for several uploads and the texture is certain to catch up.
        const vid = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
        if (t.videoTexture && vid && vid.readyState >= 2) {
            const forced = (t.videoDirty || 0) > 0;
            if (!vid.paused || forced || t.lastVideoTime !== vid.currentTime) {
                t.videoTexture.needsUpdate = true;
                t.videoDirty = forced ? t.videoDirty - 1 : 0;
                t.lastVideoTime = vid.currentTime;
            }
        }

        if (R.cameraMode === 'free') {
            cam = t.freeCamera;
            const size = t.renderer.getSize(new THREE.Vector2());
            cam.aspect = size.x / Math.max(1, size.y);
            cam.updateProjectionMatrix();
            t.controls.update();
        } else {
            const pose = poseAt(time, trackData);
            if (pose) {
                cam.position.copy(pose.pos);
                cam.quaternion.copy(pose.quat);
                cam.updateMatrixWorld(true);
            }
            applyIntrinsics(cam, trackData.intrinsics);
        }

        t.renderer.clear();
        if (t.bgQuad.visible) {
            t.renderer.render(t.bgScene, t.bgCamera);
            t.renderer.clearDepth();
        }
        // Placed objects count too, so the 3D pass still runs when the scan's
        // own layers are all off and only the scene is being composited.
        if (L.cloudOn || L.meshOn || L.wireOn || sceneObjectsRef.current.size) {
            t.renderer.render(t.scene, cam);
        }
    }, [poseAt, applyIntrinsics]);

    // Push the spectrum through the scan's own point cloud. Only the points
    // actually being drawn are touched, so the density slider doubles as the
    // cost control on a 300k-point cloud.
    const driveCloud = useCallback((frequencyData, playing) => {
        const t = three.current;
        const L = layersRef.current;

        // Same displacement for the wireframe, except computed per vertex and
        // scattered to both ends of every edge so the mesh stays welded.
        if (t.wire && t.wireState && t.wireBuffer) {
            applyWireReactivity(
                t.wireState, t.wireBuffer, t.wireEdges,
                {
                    reactivity: L.wireOn ? L.wireReact : 0,
                    scatter: L.cloudScatter,
                    freqLow: L.cloudFreqLow,
                    freqHigh: L.cloudFreqHigh,
                    ox: L.cloudPulseX, oy: L.cloudPulseY, oz: L.cloudPulseZ,
                },
                frequencyData, playing,
            );
        }

        if (!t.cloud || !t.cloudReact) return;
        const attr = t.cloud.geometry.getAttribute('position');
        const drawn = t.cloud.geometry.drawRange.count;
        const count = Number.isFinite(drawn) && drawn > 0
            ? drawn : attr.count;
        applyCloudReactivity(
            t.cloudReact, attr,
            {
                reactivity: L.cloudOn ? L.cloudReact : 0,
                scatter: L.cloudScatter,
                freqLow: L.cloudFreqLow,
                freqHigh: L.cloudFreqHigh,
                ox: L.cloudPulseX, oy: L.cloudPulseY, oz: L.cloudPulseZ,
            },
            frequencyData, playing, count,
        );
    }, []);

    // Fade layers with the music. One envelope off a chosen band drives every
    // layer that opted in, so points, wireframe, mesh and the placed scene
    // breathe or flash together rather than drifting apart.
    const driveOpacity = useCallback((frequencyData, playing) => {
        const t = three.current;
        const L = layersRef.current;
        const live = playing && !!frequencyData && L.opacityReact > 0;

        let mult = 1;
        if (live) {
            const level = bandLevel(
                frequencyData, L.opacityFreqLow, L.opacityFreqHigh,
            );
            const env = envelopeFollow(opacityEnvRef.current, level, {
                mode: L.opacityMode,
                threshold: L.opacityThreshold,
                invert: L.opacityInvert,
                smooth: L.opacitySmooth,
            });
            // Depth: at 1 the layer goes all the way out on a quiet band.
            mult = 1 - clamp01(L.opacityReact) * (1 - env);
        } else {
            opacityEnvRef.current.v = 0;
        }

        if (t.cloud) {
            const v = clamp01(L.cloudOpacity * (L.opacityPoints ? mult : 1));
            const m = t.cloud.material;
            m.opacity = v;
            m.transparent = v < 1;
            m.depthWrite = v >= 1;
        }
        if (t.wire) {
            // Fat lines are always blended; only the level moves.
            t.wire.material.opacity = clamp01(
                L.wireOpacity * (L.opacityWire ? mult : 1),
            );
        }
        if (t.mesh && L.meshOn) {
            const v = clamp01(L.meshOpacity * (L.opacityMesh ? mult : 1));
            const m = t.mesh.material;
            m.opacity = v;
            m.transparent = v < 1;
            m.depthWrite = v >= 1;
        }
        if (sceneObjectsRef.current.size) {
            applySceneOpacity(
                sceneObjectsRef.current,
                L.sceneOpacity * (L.opacityScene ? mult : 1),
            );
        }
    }, []);

    useEffect(() => {
        const t = three.current;
        if (!t.renderer) return undefined;

        const tick = () => {
            t.raf = requestAnimationFrame(tick);
            if (exportingRef.current) return;

            const now = performance.now();
            const dt = Math.min(0.1, (now - (lastTickRef.current || now)) / 1000);
            lastTickRef.current = now;

            const cov = coverageRef.current;
            const trackData = trackRef.current;
            const back = dirRef.current < 0;
            const video = back ? revVideoRef.current : videoRef.current;
            // Both copies are played forwards by the element itself, so the
            // only thing to work out is where in the take we are.
            let time = takeTime(video);

            // Hop over unsolved stretches. Checked every frame rather than on
            // seek, because a gap can be reached by playing into it, by
            // looping round, or by the user scrubbing into it.
            if (video && skipUnsolvedRef.current && cov.unsolved && cov.mask
                && trackData && !handoverRef.current) {
                const fps = trackData.fps;
                const idx = Math.floor(time * fps);
                if (idx >= cov.mask.length || !cov.mask[idx]) {
                    // Running the reversed copy, the next solved frame is the
                    // one behind the playhead rather than ahead of it.
                    const span = back
                        ? [...cov.spans].reverse().find((sp) => sp[1] < idx)
                        : cov.spans.find((sp) => sp[0] > idx);
                    const looping = loopModeRef.current !== 'off';
                    if (span) {
                        // Land just inside the span so rounding cannot drop
                        // the playhead back into the gap.
                        time = (back ? span[1] - 0.25 : span[0] + 0.25) / fps;
                        seekTake(time);
                    } else if (back) {
                        goForward();
                        time = 0;
                    } else if (loopModeRef.current === 'bounce'
                        && revReadyRef.current && playingRef.current
                        && cov.spans.length) {
                        // The solved footage has run out rather than the
                        // clip: turn around here instead of cutting back.
                        time = cov.spans[cov.spans.length - 1][1] / fps;
                        goBackward(time);
                    } else if (looping && cov.spans.length) {
                        time = (cov.spans[0][0] + 0.25) / fps;
                        seekTake(time);
                    } else if (playingRef.current) {
                        playingRef.current = false;
                        video.pause();
                        setIsPlaying(false);
                    }
                }
            }

            // Advance the placed objects from whatever the analyser hears.
            let freq = null;
            if (analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);
                freq = dataArrayRef.current;
            }
            const audioEl = audioRef.current;
            const audioLive = !!audioEl && !audioEl.paused;
            applyAudioReactivity(sceneObjectsRef.current, freq, dt, audioLive);
            driveCloud(freq, audioLive);
            driveOpacity(freq, audioLive);

            renderFrame(time);
        };
        t.raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(t.raf);
    }, [renderFrame, driveCloud, driveOpacity, track, takeTime, seekTake,
        goForward, goBackward]);

    // ---- Views -----------------------------------------------------------

    const savePreset = useCallback((i) => {
        setPresets((prev) => {
            const next = [...prev];
            next[i] = { ...layersRef.current };
            return next;
        });
        setActivePreset(i);
    }, []);

    const recallPreset = useCallback((i) => {
        const snap = presetsRef.current[i];
        if (!snap) return;
        setLayers(snap);
        setActivePreset(i);
    }, []);

    // Editing a recalled view edits that view, so the slots behave like saved
    // looks you keep refining rather than snapshots that drift out of date.
    const setLayer = useCallback((key) => (value) => {
        setLayers((prev) => {
            const next = { ...prev, [key]: value };
            const i = activePresetRef.current;
            if (i != null && presetsRef.current[i]) {
                setPresets((ps) => {
                    const copy = [...ps];
                    copy[i] = next;
                    return copy;
                });
            }
            return next;
        });
    }, []);

    const setRigKey = useCallback((key) => (value) => {
        setRig((prev) => ({ ...prev, [key]: value }));
    }, []);

    // ---- Playback --------------------------------------------------------

    // One transport for both: the clip is a few seconds and loops, the music
    // runs its own length underneath, and they start and stop together.
    const togglePlay = useCallback(() => {
        const v = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
        const a = audioRef.current;
        if (!v || exportingRef.current) return;
        if (playingRef.current) {
            playingRef.current = false;
            v.pause();
            a?.pause();
            setIsPlaying(false);
            return;
        }
        playingRef.current = true;
        setIsPlaying(true);
        v.play().catch(() => {});
        if (a && a.src) {
            attachAnalyser();
            audioCtxRef.current?.resume?.();
            a.play().catch(() => {});
        }
    }, [attachAnalyser]);

    useEffect(() => {
        [videoRef.current, revVideoRef.current].forEach((v) => {
            if (v) v.playbackRate = speed;
        });
    }, [speed, clipId]);


    useEffect(() => {
        const onKey = (e) => {
            if (e.target.matches('input, select, textarea')) return;
            if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
            if (e.key >= '1' && e.key <= '9') {
                const i = Number(e.key) - 1;
                if (e.shiftKey) savePreset(i);
                else recallPreset(i);
                return;
            }
            const map = {
                v: 'videoOn', p: 'cloudOn', m: 'meshOn', w: 'wireOn',
            };
            const key = map[e.key.toLowerCase()];
            if (key) setLayer(key)(!layersRef.current[key]);
            if (e.key.toLowerCase() === 'f') {
                setRigKey('cameraMode')(
                    rigRef.current.cameraMode === 'free' ? 'tracked' : 'free',
                );
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, savePreset, recallPreset, setLayer, setRigKey]);

    // ---- Export ----------------------------------------------------------
    // Frame-accurate and independent of playback: the list of frames to write
    // is built first - the take, the way back if it is ping-ponging, repeated
    // to fill the music - and then each entry is decoded, posed from the
    // solve for exactly that frame, rendered and encoded. The soundtrack is
    // encoded from the decoded samples over the same list, so picture and
    // sound cannot drift however long the render takes.
    //
    // Pictures come straight from a WebCodecs decoder walking the file in
    // order (lib/mp4Frames), not from seeking the <video> element: a seek
    // re-decodes from the previous keyframe and round-trips the media
    // pipeline for every frame, which made export many times slower than the
    // preview. The way back of a ping-pong reads the reversed copy forwards,
    // exactly as playback does. Seeking remains as the fallback for a browser
    // or file the decoder cannot take.

    // The clip's own audio, which lives in the take's mp4. Decoded once per
    // take and kept, since the only thing that wants it is the exporter.
    const clipAudio = useCallback(() => {
        const id = clipId;
        const slot = clipAudioRef.current;
        if (!id) return Promise.resolve(null);
        if (slot.id === id) return slot.promise || Promise.resolve(slot.buffer);

        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = audioCtxRef.current || new Ctx();
        audioCtxRef.current = ctx;
        const promise = fetch(`${process.env.PUBLIC_URL}/mv/${id}/${id}.mp4`)
            .then((r) => r.arrayBuffer())
            .then((buf) => ctx.decodeAudioData(buf))
            .then((decoded) => {
                clipAudioRef.current = { id, buffer: decoded, promise: null };
                return decoded;
            })
            .catch(() => {
                // A take published before the pipeline started carrying audio
                // simply has none; that is not an error.
                clipAudioRef.current = { id, buffer: null, promise: null };
                return null;
            });
        clipAudioRef.current = { id, buffer: null, promise };
        return promise;
    }, [clipId]);

    // Lay out the export's soundtrack sample by sample.
    //
    // The clip's own sound is written per output frame, which is what keeps it
    // locked to the picture through everything the frame list can do: dropped
    // unsolved frames, repeats, and the reversed half of a ping-pong, where
    // the frame's audio is reversed with it. Music is read straight through
    // and wraps round, exactly as the <audio> element does in the preview.
    const buildExportAudio = useCallback(({
        frames, dirs, fps, music, musicOffset, clip: clipBuf,
    }) => {
        const rate = (music || clipBuf).sampleRate;
        const channels = Math.min(2, Math.max(
            music ? music.numberOfChannels : 1,
            clipBuf ? clipBuf.numberOfChannels : 1,
        ));
        const step = rate / fps;
        const total = Math.round(frames.length * step);
        if (!total) return null;

        const out = [];
        for (let c = 0; c < channels; c++) out.push(new Float32Array(total));

        if (music) {
            const src = [];
            for (let c = 0; c < channels; c++) {
                src.push(music.getChannelData(Math.min(c, music.numberOfChannels - 1)));
            }
            const start = Math.round(musicOffset * rate);
            const len = music.length;
            for (let i = 0; i < total; i++) {
                // Wrap rather than run out: the preview loops the track.
                const idx = ((start + i) % len + len) % len;
                for (let c = 0; c < channels; c++) out[c][i] += src[c][idx];
            }
        }

        if (clipBuf) {
            const src = [];
            for (let c = 0; c < channels; c++) {
                src.push(clipBuf.getChannelData(
                    Math.min(c, clipBuf.numberOfChannels - 1),
                ));
            }
            const len = clipBuf.length;
            for (let k = 0; k < frames.length; k++) {
                const from = Math.round(k * step);
                const to = Math.round((k + 1) * step);
                const span = to - from;
                const base = Math.round(frames[k] * step);
                const back = dirs[k] < 0;
                for (let j = 0; j < span; j++) {
                    const local = back ? span - 1 - j : j;
                    const idx = base + local;
                    if (idx < 0 || idx >= len) continue;
                    for (let c = 0; c < channels; c++) {
                        out[c][from + j] += src[c][idx];
                    }
                }
            }
        }

        // Two sources summed can exceed full scale; clip rather than let the
        // encoder wrap it round.
        for (let c = 0; c < channels; c++) {
            const a = out[c];
            for (let i = 0; i < a.length; i++) {
                if (a[i] > 1) a[i] = 1;
                else if (a[i] < -1) a[i] = -1;
            }
        }
        return { data: out, sampleRate: rate, channels, length: total };
    }, []);

    const startExport = useCallback(async () => {
        const video = videoRef.current;
        const trackData = trackRef.current;
        const t = three.current;
        if (!video || !trackData || exportingRef.current) return;
        if (typeof window.VideoEncoder === 'undefined'
            || typeof window.VideoFrame === 'undefined') {
            // eslint-disable-next-line no-alert
            window.alert('MP4 export needs WebCodecs support (Chrome / Edge / recent Safari).');
            return;
        }

        const intr = trackData.intrinsics;
        const w = Math.max(2, Math.round((intr.width * exportScale) / 2) * 2);
        const h = Math.max(2, Math.round((intr.height * exportScale) / 2) * 2);
        const fps = trackData.fps;

        // Exporting an unsolved frame would bake a frozen camera over moving
        // footage, so by default those frames are left out.
        const cov = coverageRef.current;
        const solved = (skipUnsolvedRef.current && cov.unsolved && cov.mask)
            ? Array.from(cov.mask).reduce((acc, ok, i) => {
                if (ok) acc.push(i);
                return acc;
            }, [])
            : Array.from({ length: trackData.frame_count }, (_, i) => i);
        if (!solved.length) {
            // eslint-disable-next-line no-alert
            window.alert('Nothing to export: no frames in this take are solved.');
            return;
        }

        // One cycle of the loop. Ping-pong adds the way back without
        // repeating either turnaround frame, so cycles butt together
        // seamlessly however many of them are written.
        const cycle = loopMode === 'bounce' && solved.length > 2
            ? solved.concat(solved.slice(1, -1).reverse())
            : solved.slice();

        const music = audioBufferRef.current;
        const musicOffset = music && audioRef.current
            ? Math.min(audioRef.current.currentTime, music.duration)
            : 0;
        let wanted = cycle.length;
        if (exportLength === 'audio' && music) {
            wanted = Math.max(1, Math.round((music.duration - musicOffset) * fps));
        } else if (exportLength === 'loops') {
            wanted = cycle.length * Math.max(1, Math.round(exportLoops));
        }

        const frames = new Int32Array(wanted);
        for (let i = 0; i < wanted; i++) frames[i] = cycle[i % cycle.length];
        // Which way the clip is running at each output frame, so the audio can
        // be reversed along with the picture. Read forwards where there is a
        // next frame to compare against - looking back instead would call the
        // first frame of a new cycle a reversal, since the frame before it is
        // the end of the last one.
        const dirs = new Int8Array(wanted);
        for (let i = 0; i < wanted; i++) {
            const a = frames[i];
            const b = i + 1 < wanted ? frames[i + 1] : a;
            if (b !== a) dirs[i] = b < a ? -1 : 1;
            else dirs[i] = i > 0 && a < frames[i - 1] ? -1 : 1;
        }
        const totalFrames = wanted;

        const bitrate = Math.min(
            120_000_000, Math.round(w * h * fps * exportQuality),
        );

        // A long render is far larger than anything worth holding in memory,
        // so write it straight to disk when the browser can. The picker has to
        // be opened while the click that started the export is still fresh,
        // which is why it comes before the codec probe.
        const estBytes = (bitrate / 8) * (totalFrames / fps);
        let fileStream = null;
        if (estBytes > 500_000_000 && window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: `${clipId}-composite.mp4`,
                    types: [{
                        description: 'MP4 video',
                        accept: { 'video/mp4': ['.mp4'] },
                    }],
                });
                fileStream = await handle.createWritable();
            } catch (e) {
                // Cancelled picker: fall back to assembling it in memory.
                fileStream = null;
            }
        }

        const codecCandidates = ['avc1.640034', 'avc1.640033', 'avc1.640028',
            'avc1.64001f', 'avc1.4d0028', 'avc1.42e01e'];
        let codec = null;
        for (const c of codecCandidates) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const support = await window.VideoEncoder.isConfigSupported({
                    codec: c, width: w, height: h, bitrate, framerate: fps,
                });
                if (support.supported) { codec = c; break; }
            } catch (e) { /* try next */ }
        }
        if (!codec) {
            // eslint-disable-next-line no-alert
            window.alert('No supported H.264 encoder found for this resolution.');
            if (fileStream) await fileStream.close();
            return;
        }

        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportProgress(0);
        setExportStage('Preparing...');

        // Started now so the fetch and parse overlap the audio work below.
        // The reversed copy is only worth opening if the list runs backwards.
        const base = `${process.env.PUBLIC_URL}/mv/${clipId}/${clipId}`;
        const runsBack = frames.some((f, i) => i > 0 && f < frames[i - 1]);
        const readersReady = Promise.all([
            Mp4FrameReader.open(`${base}.mp4`),
            runsBack ? Mp4FrameReader.open(`${base}_rev.mp4`) : null,
        ]);

        // A live analyser only hears what is playing now, which is no use to a
        // loop that renders frame 37 whenever it gets there. Analyse the
        // decoded samples up front so each frame gets the spectrum it would
        // have had in the preview.
        let spectrum = null;
        const L0 = layersRef.current;
        const scanReacts = (L0.cloudOn && L0.cloudReact > 0)
            || (L0.wireOn && L0.wireReact > 0)
            || L0.opacityReact > 0;
        if (music && (sceneItemsRef.current.length || scanReacts)) {
            setExportStage('Analysing audio...');
            await new Promise((r) => setTimeout(r, 0)); // let the label paint
            spectrum = computeSpectrogram(music, {
                fps, frameCount: totalFrames, offset: musicOffset,
            });
            spectrogramRef.current = spectrum;
        }

        // The take's own sound, plus the music, mixed over the frame list.
        setExportStage('Laying out audio...');
        const clipBuf = muted ? null : await clipAudio();
        const pcm = (music || clipBuf)
            ? buildExportAudio({
                frames, dirs, fps, music, musicOffset, clip: clipBuf,
            })
            : null;

        let audioCodec = null;
        if (pcm && typeof window.AudioEncoder !== 'undefined') {
            for (const [enc, box] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const sup = await window.AudioEncoder.isConfigSupported({
                        codec: enc,
                        sampleRate: pcm.sampleRate,
                        numberOfChannels: pcm.channels,
                        bitrate: 192_000,
                    });
                    if (sup.supported) { audioCodec = [enc, box]; break; }
                } catch (e) { /* try next */ }
            }
        }

        // Supersample unless the output is already enormous: a frame of points
        // and hairline edges is exactly the detail an encoder discards first,
        // and resolving it before the encoder sees it is most of what makes an
        // export look like the preview.
        const ss = w * h <= 3_600_000 ? EXPORT_SS : 1;
        const down = ss > 1 ? document.createElement('canvas') : null;
        let downCtx = null;
        if (down) {
            down.width = w;
            down.height = h;
            downCtx = down.getContext('2d', { alpha: false });
            downCtx.imageSmoothingEnabled = true;
            downCtx.imageSmoothingQuality = 'high';
        }

        const prevLoop = video.loop;
        const prevTime = video.currentTime;
        const prevSize = t.renderer.getSize(new THREE.Vector2());
        const prevRatio = t.renderer.getPixelRatio();
        const prevLayers = { ...layersRef.current };

        playingRef.current = false;
        revVideoRef.current?.pause();
        showVideo(1);
        video.loop = false;
        video.pause();
        setIsPlaying(false);
        opacityEnvRef.current.v = 0;
        t.ss = ss;
        t.renderer.setPixelRatio(1);
        t.renderer.setSize(w * ss, h * ss, false);
        applyLayers(layersRef.current);

        const seekTo = (time) => new Promise((resolve) => {
            if (Math.abs(video.currentTime - time) < 1 / 240 && video.readyState >= 2) {
                resolve();
                return;
            }
            let timer = null;
            const onSeeked = () => {
                clearTimeout(timer);
                video.removeEventListener('seeked', onSeeked);
                resolve();
            };
            timer = setTimeout(onSeeked, 2000); // fail-safe
            video.addEventListener('seeked', onSeeked);
            video.currentTime = time;
        });

        // The muxer takes its frame rate as the track's timescale and insists
        // on an integer, which 29.97 and 59.94 takes are not - they used to
        // fail here outright. NTSC rates are n/1001 exactly, so a timescale of
        // n gives every frame a whole number of ticks.
        const ntsc = Math.abs(fps * 1.001 - Math.round(fps * 1.001)) < 1e-3;
        const timescale = Number.isInteger(fps) ? fps
            : ntsc ? Math.round(fps * 1001) : 90000;
        const target = fileStream
            ? new FileSystemWritableFileStreamTarget(fileStream)
            : new ArrayBufferTarget();
        const muxer = new Muxer({
            target,
            video: { codec: 'avc', width: w, height: h, frameRate: timescale },
            ...(audioCodec ? {
                audio: {
                    codec: audioCodec[1],
                    numberOfChannels: pcm.channels,
                    sampleRate: pcm.sampleRate,
                },
            } : {}),
            // Streaming to disk cannot go back and rewrite the header, so the
            // index lands at the end of the file instead.
            fastStart: fileStream ? false : 'in-memory',
        });

        let encodeFailed = null;
        const encoder = new window.VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => { encodeFailed = e; },
        });
        encoder.configure({
            codec, width: w, height: h, bitrate, framerate: fps,
            latencyMode: 'quality',
        });

        let audioEncoder = null;
        if (audioCodec) {
            audioEncoder = new window.AudioEncoder({
                output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                error: (e) => { encodeFailed = e; },
            });
            audioEncoder.configure({
                codec: audioCodec[0],
                sampleRate: pcm.sampleRate,
                numberOfChannels: pcm.channels,
                bitrate: 192_000,
            });
        }

        // Sound is fed in step with the picture rather than all at once, so
        // the muxer sees both tracks in order and the file can be streamed
        // straight to disk.
        const AUDIO_CHUNK = 1024;
        let audioCursor = 0;
        const pumpAudio = (untilSample) => {
            if (!audioEncoder || !pcm) return;
            while (audioCursor < Math.min(untilSample, pcm.length)) {
                const n = Math.min(AUDIO_CHUNK, pcm.length - audioCursor);
                const planar = new Float32Array(n * pcm.channels);
                for (let c = 0; c < pcm.channels; c++) {
                    planar.set(
                        pcm.data[c].subarray(audioCursor, audioCursor + n),
                        c * n,
                    );
                }
                const data = new window.AudioData({
                    format: 'f32-planar',
                    sampleRate: pcm.sampleRate,
                    numberOfFrames: n,
                    numberOfChannels: pcm.channels,
                    timestamp: Math.round((audioCursor / pcm.sampleRate) * 1e6),
                    data: planar,
                });
                audioEncoder.encode(data);
                data.close();
                audioCursor += n;
            }
        };

        // Backpressure without a polling timer: wait for the encoders to take
        // a frame, which also keeps an export in a background tab from being
        // throttled to one timer tick a second.
        const encodersBusy = () => (encoder.encodeQueueSize > 8
            || (audioEncoder && audioEncoder.encodeQueueSize > 40)) && !encodeFailed;
        const waitForEncoders = () => new Promise((resolve) => {
            let timer = null;
            const targets = [encoder, audioEncoder].filter(Boolean);
            const done = () => {
                clearTimeout(timer);
                targets.forEach((e) => e.removeEventListener?.('dequeue', done));
                resolve();
            };
            targets.forEach((e) => e.addEventListener?.('dequeue', done));
            timer = setTimeout(done, 20);
        });

        // The decoder path, if this browser and file allow it. Its pictures go
        // onto their own texture for the length of the export; the element's
        // textures are put back afterwards.
        let [fwdReader, revReader] = await readersReady;
        let frameTex = null;
        const prevMap = t.bgQuad.material.map;
        const dropReaders = () => {
            fwdReader?.close();
            revReader?.close();
            fwdReader = null;
            revReader = null;
            if (frameTex) {
                t.bgQuad.material.map = prevMap;
                t.bgQuad.material.needsUpdate = true;
                frameTex.dispose();
                frameTex = null;
            }
        };
        if (!fwdReader) {
            revReader?.close();
            revReader = null;
        }
        const nFwd = fwdReader ? fwdReader.frameCount : 0;
        // Take frame k on the reversed copy. Scaled rather than subtracted,
        // for the same reason as takeTime: a copy a frame short still lines
        // up at both ends.
        const revIndex = (k) => {
            const nRev = revReader.frameCount;
            const x = nFwd > 1 ? (k * (nRev - 1)) / (nFwd - 1) : 0;
            return Math.max(0, Math.min(nRev - 1, nRev - 1 - Math.round(x)));
        };
        // Upload a decoded picture as the footage. WebGL takes a VideoFrame
        // directly; if this one cannot, the GL error says so on the first
        // frame and the export carries on by seeking instead.
        const showDecoded = (vf) => {
            const gl = t.renderer.getContext();
            const probe = !frameTex;
            if (probe) {
                frameTex = new THREE.VideoTexture(vf);
                frameTex.colorSpace = THREE.SRGBColorSpace;
                frameTex.minFilter = THREE.LinearFilter;
                frameTex.magFilter = THREE.LinearFilter;
                t.bgQuad.material.map = frameTex;
                t.bgQuad.material.needsUpdate = true;
                while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
            }
            frameTex.image = vf;
            frameTex.needsUpdate = true;
            if (probe) {
                t.renderer.initTexture(frameTex);
                if (gl.getError() !== gl.NO_ERROR) return false;
            }
            return true;
        };

        // Per frame rather than accumulated, so a rate that is not a whole
        // number of microseconds per frame cannot drift.
        const stampUs = (i) => Math.round((i * 1_000_000) / fps);
        const gop = Math.max(1, Math.round(fps * 2));
        let completed = false;
        setExportStage('Rendering...');
        // Timed from the end of the first frame, which carries the decoder
        // and texture setup and would make the early estimate wildly long.
        let started = 0;
        let lastReport = 0;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || encodeFailed) break;

                // i counts output frames; src is the frame of the take it came
                // from, which differs once unsolved frames are dropped and the
                // loop starts repeating.
                const src = frames[i];
                const time = Math.min(src / fps, Math.max(0, video.duration - 0.001));

                let decoded = false;
                if (fwdReader) {
                    const back = !!revReader && i > 0 && src < frames[i - 1];
                    // eslint-disable-next-line no-await-in-loop
                    const vf = back
                        ? await revReader.frame(revIndex(src))
                        : await fwdReader.frame(src);
                    if (vf && showDecoded(vf)) {
                        decoded = true;
                    } else if (!frameTex || i === 0) {
                        // Never worked: seek for the rest of the export.
                        dropReaders();
                    }
                }
                if (!decoded) {
                    if (frameTex) {
                        // A one-off miss: this frame comes off the element.
                        t.bgQuad.material.map = prevMap;
                        t.bgQuad.material.needsUpdate = true;
                    }
                    // eslint-disable-next-line no-await-in-loop
                    await seekTo(time);
                    if (t.videoTexture) t.videoTexture.needsUpdate = true;
                } else if (t.bgQuad.material.map !== frameTex) {
                    t.bgQuad.material.map = frameTex;
                    t.bgQuad.material.needsUpdate = true;
                }

                // Deterministic per-frame reactivity: the same dt every frame,
                // so an export is reproducible rather than tied to how fast
                // the encode happened to run.
                const freq = spectrum ? spectrum[i] : null;
                applyAudioReactivity(
                    sceneObjectsRef.current, freq, 1 / fps, !!spectrum,
                );
                driveCloud(freq, !!spectrum);
                driveOpacity(freq, !!spectrum);

                renderFrame(time);

                let source = t.renderer.domElement;
                if (downCtx) {
                    downCtx.drawImage(t.renderer.domElement, 0, 0, w, h);
                    source = down;
                }
                const vf = new window.VideoFrame(source, {
                    timestamp: stampUs(i),
                    duration: stampUs(i + 1) - stampUs(i),
                });
                encoder.encode(vf, { keyFrame: i % gop === 0 });
                vf.close();

                pumpAudio(Math.round(((i + 1) / fps) * (pcm ? pcm.sampleRate : 0)));

                while (encodersBusy()) {
                    // eslint-disable-next-line no-await-in-loop
                    await waitForEncoders();
                }

                // Every state update re-renders the whole tool, so the
                // progress readout is kept to a few times a second.
                const now = performance.now();
                if (i === 0) started = now;
                if (i > 0 && now - lastReport > 250) {
                    lastReport = now;
                    const rate = i / Math.max(0.001, (now - started) / 1000);
                    const left = (totalFrames - i - 1) / rate;
                    setExportProgress((i + 1) / totalFrames);
                    setExportStage(`Rendering ${i + 1}/${totalFrames} · `
                        + `${rate.toFixed(0)} fps · ${Math.ceil(left)}s left`);
                }
            }

            if (!exportCanceledRef.current && !encodeFailed) {
                setExportProgress(1);
                setExportStage('Finishing...');
                if (pcm) pumpAudio(pcm.length);
                await encoder.flush();
                if (audioEncoder) await audioEncoder.flush();
                muxer.finalize();
                completed = true;
            }
        } catch (e) {
            encodeFailed = e;
        } finally {
            dropReaders();
            try { encoder.close(); } catch (e) { /* already closed */ }
            try { audioEncoder?.close(); } catch (e) { /* already closed */ }
            if (fileStream) {
                try { await fileStream.close(); } catch (e) { /* gone */ }
            }
            video.loop = prevLoop;
            video.currentTime = prevTime;
            t.ss = 1;
            t.renderer.setPixelRatio(prevRatio);
            t.renderer.setSize(prevSize.x, prevSize.y, true);
            layersRef.current = prevLayers;
            applyLayers(prevLayers);
            exportingRef.current = false;
            setIsExporting(false);
            setExportProgress(0);
            setExportStage('');
        }

        if (completed && !fileStream) {
            const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${clipId}-composite.mp4`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } else if (encodeFailed) {
            // eslint-disable-next-line no-alert
            window.alert(`Export failed: ${encodeFailed.message || encodeFailed}`);
        }
        if (completed) {
            const secs = (totalFrames / fps).toFixed(1);
            setStatus(`Exported ${totalFrames} frames (${secs}s) at ${w}x${h}`
                + (audioCodec ? ' with sound' : ' (silent)'));
        }
    }, [clipId, exportScale, exportQuality, exportLength, exportLoops, loopMode,
        muted, renderFrame, applyLayers, driveCloud, driveOpacity, clipAudio,
        buildExportAudio, showVideo]);

    // ---- Control helpers -------------------------------------------------

    const slider = (label, key, min, max, step, source = layers, setter = setLayer) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={source[key]}
                onChange={(e) => setter(key)(parseFloat(e.target.value))}
            />
            <VfxNumberField
                value={source[key]}
                min={min}
                max={max}
                step={step}
                onCommit={setter(key)}
            />
        </div>
    );

    const toggle = (label, key, source = layers, setter = setLayer) => (
        <div
            className={styles.vfx_checkRow}
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => setter(key)(!source[key])}
            onKeyDown={(e) => { if (e.key === 'Enter') setter(key)(!source[key]); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${source[key] ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );

    const colorRow = (label, key) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="color"
                className={styles.vfx_color}
                style={{ gridColumn: '2 / 4' }}
                value={layers[key]}
                onChange={(e) => setLayer(key)(e.target.value)}
            />
        </div>
    );

    const fmt = (s) => {
        const m = Math.floor(s / 60);
        const r = (s % 60).toFixed(2).padStart(5, '0');
        return `${m}:${r}`;
    };

    // ---- Render ----------------------------------------------------------

    return (
        <div className={styles.vfx}>
            <div className={styles.vfx_stage}>
                <div className={styles.vfx_scanWrap}>
                    <div ref={mountRef} className={styles.vfx_scanCanvas} />
                    {/* The element is the texture source and the clock; it is
                        never shown, since the composite is drawn in WebGL. */}
                    {clip && (
                        <>
                            <video
                                ref={attachVideo}
                                key={clip.id}
                                src={`${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}.mp4`}
                                style={{ display: 'none' }}
                                muted={muted}
                                playsInline
                                loop={loopMode === 'loop'}
                                crossOrigin="anonymous"
                                onPlay={() => setIsPlaying(true)}
                                onPause={(e) => {
                                    // Running out of clip pauses the element
                                    // and fires 'pause' and 'ended' in an
                                    // order not worth relying on, so both are
                                    // read as the same thing.
                                    if (atEnd(e.target)) {
                                        goBackward();
                                        return;
                                    }
                                    if (!exportingRef.current) {
                                        playingRef.current = false;
                                        setIsPlaying(false);
                                    }
                                }}
                                onEnded={() => goBackward()}
                                onTimeUpdate={(e) => {
                                    if (dirRef.current > 0) {
                                        setCurrentTime(e.target.currentTime);
                                    }
                                }}
                                onSeeked={() => { three.current.videoDirty = 3; }}
                                onLoadedData={() => { three.current.videoDirty = 3; }}
                                onLoadedMetadata={(e) => {
                                    setDuration(e.target.duration);
                                    e.target.playbackRate = speed;
                                }}
                            />
                            {/* The take reversed. Ping-pong plays this
                                forwards, which is ordinary playback at full
                                rate - the only alternative is seeking the
                                take backwards a frame at a time, and no
                                browser can do that smoothly. A take published
                                before the pipeline wrote one simply has no
                                ping-pong. */}
                            <video
                                ref={attachRevVideo}
                                key={`${clip.id}-rev`}
                                src={`${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}_rev.mp4`}
                                style={{ display: 'none' }}
                                muted={muted}
                                playsInline
                                preload="auto"
                                crossOrigin="anonymous"
                                onLoadedMetadata={(e) => {
                                    setRevReady(true);
                                    e.target.playbackRate = speed;
                                }}
                                onError={() => setRevReady(false)}
                                onEnded={() => goForward()}
                                onTimeUpdate={(e) => {
                                    if (dirRef.current < 0) {
                                        setCurrentTime(takeTime(e.target));
                                    }
                                }}
                                onSeeked={() => { three.current.videoDirty = 3; }}
                                onLoadedData={() => { three.current.videoDirty = 3; }}
                            />
                        </>
                    )}
                    <div className={styles.vfx_scanStatus}>{status}</div>
                </div>
            </div>

            <audio ref={audioRef} loop style={{ display: 'none' }} />
            <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg"
                style={{ display: 'none' }}
                onChange={(e) => { onAudioFile(e.target.files[0]); e.target.value = ''; }}
            />

            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    style={slide(layout.menuToggle)}
                    className={`${styles.vfx_toggle} ${styles.vfx_slide} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {!sceneOpen && (
                <button
                    type="button"
                    aria-label="Open scene controls"
                    onClick={() => setSceneOpen(true)}
                    style={slide(layout.sceneToggle)}
                    className={`${styles.vfx_toggle} ${styles.vfx_slide} ${styles.vfx_visible}`}
                >
                    <Boxes size={18} />
                </button>
            )}

            {sceneOpen && (
                <div
                    style={slide(layout.scenePanel)}
                    className={`${styles.vfx_panel} ${styles.vfx_slide}`}
                >
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Scene</span>
                        <button
                            type="button"
                            aria-label="Close scene controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setSceneOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Audio */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Audio</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                disabled={isExporting}
                                onClick={() => fileInputRef.current.click()}
                            >
                                <Upload size={13} />
                                Upload MP3
                            </button>
                        </div>
                        <select
                            className={styles.vfx_select}
                            value=""
                            disabled={isExporting}
                            onChange={(e) => {
                                const m = MUSIC_ASSETS.find((x) => x.id === e.target.value);
                                if (m) loadAudio(`${process.env.PUBLIC_URL}/${m.path}`, m.name);
                            }}
                        >
                            <option value="">Or pick a bundled track...</option>
                            {MUSIC_ASSETS.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                        {trackName && (
                            <div className={styles.vfx_fileName} title={trackName}>
                                <Music size={9} style={{ marginRight: 4 }} />
                                {trackName}
                                {audioReady ? '' : ' (decoding...)'}
                            </div>
                        )}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Plays with the clip, and is mixed into the export
                            alongside the take&apos;s own sound. An export
                            starts from wherever the track is sitting now, and
                            re-analyses it offline so every frame reacts
                            exactly as previewed.
                        </div>
                    </div>

                    {/* Occlusion */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Realism</div>
                        {toggle('Hide behind scan', 'occlude', { occlude },
                            () => setOcclude)}
                        <div className={styles.vfx_hint}>
                            Depth-tests every overlay against the scanned mesh,
                            even when the mesh is not drawn, so points and
                            objects go behind the real object.
                        </div>
                    </div>

                    {/* Add */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Add to scene</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <select
                                className={styles.vfx_select}
                                value={addAssetId}
                                onChange={(e) => setAddAssetId(e.target.value)}
                            >
                                {ASSETS.filter((a) => a.type !== 'glb').map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add asset"
                                className={styles.vfx_iconBtn}
                                onClick={addAsset}
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                        <div className={styles.vfx_playRow}>
                            <select
                                className={styles.vfx_select}
                                value={addCurveId}
                                onChange={(e) => setAddCurveId(e.target.value)}
                            >
                                {CURVES.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add curve"
                                className={styles.vfx_iconBtn}
                                onClick={addCurve}
                            >
                                <Spline size={14} />
                            </button>
                        </div>
                    </div>

                    {/* Items */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>
                            Objects ({sceneItems.length})
                        </div>
                        {!sceneItems.length && (
                            <div className={styles.vfx_hint}>
                                Nothing placed yet. Objects sit in the scan&apos;s
                                own space, so they stay locked to the scene as
                                the camera moves.
                            </div>
                        )}
                        {sceneItems.map((item) => {
                            const name = item.kind === 'curve'
                                ? CURVES.find((c) => c.id === item.funcId)?.name
                                : ASSETS.find((a) => a.id === item.assetId)?.name;
                            return (
                                <div className={styles.vfx_cutRow} key={item.id}>
                                    <button
                                        type="button"
                                        className={styles.vfx_cutJump}
                                        style={{
                                            color: selectedId === item.id
                                                ? 'var(--accent)' : 'var(--fg)',
                                        }}
                                        onClick={() => setSelectedId(
                                            selectedId === item.id ? null : item.id,
                                        )}
                                    >
                                        {item.kind === 'curve' ? '~ ' : '• '}
                                        {name || item.assetId || item.funcId}
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Remove object"
                                        className={styles.vfx_iconBtn}
                                        style={{ width: 20, height: 20 }}
                                        onClick={() => removeItem(item.id)}
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {/* Selected object parameters, straight from the shared
                        menu definition so both tools expose the same knobs. */}
                    {selected && PARAM_GROUPS
                        .filter((g) => g.scope === 'object'
                            && (g.kind === 'both' || g.kind === selected.kind
                                || (g.kind === 'asset' && selected.kind === 'asset')))
                        .map((group) => (
                            <div className={styles.vfx_section} key={`${group.title}-${group.kind}`}>
                                <div className={styles.vfx_sectionTitle}>{group.title}</div>
                                {group.params.map((prm) => {
                                    if (prm.type === 'gizmoButtons') return null;
                                    if (prm.sphereOnly && selectedAssetType !== 'sphere') return null;
                                    if (prm.cloudOnly && selected.kind !== 'asset') return null;
                                    if (prm.type === 'color') {
                                        return (
                                            <div className={styles.vfx_row} key={prm.key}>
                                                <span className={styles.vfx_label}>{prm.label}</span>
                                                <input
                                                    type="color"
                                                    className={styles.vfx_color}
                                                    style={{ gridColumn: '2 / 4' }}
                                                    value={selected.op[prm.key]}
                                                    onChange={(e) => setItemParam(prm.key)(e.target.value)}
                                                />
                                            </div>
                                        );
                                    }
                                    return (
                                        <div className={styles.vfx_row} key={prm.key}>
                                            <span className={styles.vfx_label} title={prm.label}>
                                                {prm.label}
                                            </span>
                                            <input
                                                type="range"
                                                className={styles.vfx_slider}
                                                min={prm.min}
                                                max={prm.max}
                                                step={prm.step}
                                                value={selected.op[prm.key]}
                                                onChange={(e) => setItemParam(prm.key)(
                                                    parseFloat(e.target.value),
                                                )}
                                            />
                                            <VfxNumberField
                                                value={selected.op[prm.key]}
                                                min={prm.min}
                                                max={prm.max}
                                                step={prm.step}
                                                onCommit={setItemParam(prm.key)}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                </div>
            )}

            {menuOpen && (
                <div
                    style={slide(layout.menuPanel)}
                    className={`${styles.vfx_panel} ${styles.vfx_slide}`}
                >
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Scan Compositor</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Take */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Take</div>
                        <select
                            className={styles.vfx_select}
                            value={clipId || ''}
                            disabled={isExporting || !clips.length}
                            onChange={(e) => setClipId(e.target.value)}
                        >
                            {clips.map((c) => (
                                <option key={c.id} value={c.id}>{c.label}</option>
                            ))}
                        </select>
                        <div className={styles.vfx_fileName} title={status}>{status}</div>
                    </div>

                    {/* Playback */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Playback</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 10 }}>
                            <button
                                type="button"
                                className={styles.vfx_iconBtn}
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                disabled={isExporting || !track}
                                onClick={togglePlay}
                            >
                                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                            </button>
                            <input
                                type="range"
                                className={styles.vfx_slider}
                                min={0}
                                max={Math.max(0.01, duration)}
                                step={0.001}
                                value={currentTime}
                                disabled={isExporting || !track}
                                onChange={(e) => {
                                    // Always in the take's own time: dragging
                                    // during the return hands the clip back
                                    // to the forward copy first.
                                    const at = parseFloat(e.target.value);
                                    if (dirRef.current < 0) {
                                        revVideoRef.current?.pause();
                                        showVideo(1);
                                        if (playingRef.current) {
                                            videoRef.current?.play().catch(() => {});
                                        }
                                    }
                                    seekTake(at);
                                }}
                            />
                            <span className={styles.vfx_value}>{fmt(currentTime)}</span>
                        </div>
                        {slider('Speed', 'speed', 0.1, 2, 0.05,
                            { speed }, () => setSpeed)}
                        <div className={styles.vfx_segRow}>
                            {LOOP_MODES.map((m) => (
                                <button
                                    key={m.id}
                                    type="button"
                                    disabled={m.id === 'bounce' && !revReady}
                                    title={m.id === 'bounce' && !revReady
                                        ? 'This take has no reversed copy; re-run the export stage'
                                        : m.name}
                                    className={`${styles.vfx_segBtn} ${loopMode === m.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLoopMode(m.id)}
                                >
                                    {m.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_hint}>
                            Ping-pong plays the take&apos;s reversed copy back
                            to its start instead of cutting back, which turns a
                            few seconds of footage into a seamless loop.
                            Exports follow whichever mode is set here.
                        </div>
                        {!!coverage.unsolved && (
                            <>
                                {toggle('Skip unsolved', 'skipUnsolved',
                                    { skipUnsolved }, () => setSkipUnsolved)}
                                <div className={styles.vfx_hint}>
                                    {coverage.unsolved} frame
                                    {coverage.unsolved === 1 ? '' : 's'} have no
                                    camera. Skipped in playback and left out of
                                    the export.
                                </div>
                            </>
                        )}
                        {toggle('Audio', 'audio', { audio: !muted },
                            () => (v) => setMuted(!v))}
                    </div>

                    {/* Camera */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Camera</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {['tracked', 'free'].map((m) => (
                                <button
                                    key={m}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${rig.cameraMode === m ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setRigKey('cameraMode')(m)}
                                >
                                    {m === 'tracked' ? 'Solved' : 'Free orbit'}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_hint}>
                            Free orbit drops the footage and lets you inspect the
                            fit from any angle.
                        </div>
                    </div>

                    {/* Video layer */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Video</div>
                        {toggle('Show footage', 'videoOn')}
                        {slider('Opacity', 'videoOpacity', 0, 1, 0.01)}
                        {colorRow('Backdrop', 'bgColor')}
                    </div>

                    {/* Point cloud */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Point cloud</div>
                        {toggle('Show points', 'cloudOn')}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {[['scan', 'Scan colour'], ['solid', 'Solid']].map(([id, name]) => (
                                <button
                                    key={id}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${layers.cloudColorMode === id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLayer('cloudColorMode')(id)}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                        {layers.cloudColorMode === 'solid' && colorRow('Colour', 'cloudColor')}
                        {slider('Size', 'cloudSize', 0.1, 8, 0.1)}
                        {slider('Density', 'cloudDensity', 0.01, 1, 0.01)}
                        {slider('Opacity', 'cloudOpacity', 0, 1, 0.01)}
                        {toggle('Perspective size', 'cloudAttenuate')}
                    </div>

                    {/* The scan's own points, driven by whatever is loaded in
                        the Scene panel. Lives in the layer stack, so a cut can
                        switch the object itself into motion. */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Point reactivity</div>
                        {slider('Amount', 'cloudReact', 0, 3, 0.01)}
                        {layers.cloudReact > 0 && (
                            <>
                                {slider('Scatter', 'cloudScatter', 0, 1, 0.001)}
                                {slider('Freq low', 'cloudFreqLow', 0, 1, 0.01)}
                                {slider('Freq high', 'cloudFreqHigh', 0, 1, 0.01)}
                                {slider('Pulse X', 'cloudPulseX', -4, 4, 0.01)}
                                {slider('Pulse Y', 'cloudPulseY', -4, 4, 0.01)}
                                {slider('Pulse Z', 'cloudPulseZ', -4, 4, 0.01)}
                            </>
                        )}
                        <div className={styles.vfx_hint}>
                            {layers.cloudReact > 0
                                ? 'Points push out from the pulse point by the band their distance maps to.'
                                : 'Load a track in the Scene panel, then raise this to make the scanned object itself move.'}
                        </div>
                    </div>

                    {/* Opacity, driven by the music rather than by hand */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Audio opacity</div>
                        {slider('Depth', 'opacityReact', 0, 1, 0.01)}
                        {layers.opacityReact > 0 && (
                            <>
                                <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                                    {[['band', 'Follow band'], ['gate', 'Threshold']].map(([id, name]) => (
                                        <button
                                            key={id}
                                            type="button"
                                            className={`${styles.vfx_segBtn} ${layers.opacityMode === id ? styles.vfx_segBtnOn : ''}`}
                                            onClick={() => setLayer('opacityMode')(id)}
                                        >
                                            {name}
                                        </button>
                                    ))}
                                </div>
                                {slider('Freq low', 'opacityFreqLow', 0, 1, 0.01)}
                                {slider('Freq high', 'opacityFreqHigh', 0, 1, 0.01)}
                                {slider(layers.opacityMode === 'gate' ? 'Threshold' : 'Floor',
                                    'opacityThreshold', 0, 0.99, 0.01)}
                                {slider('Smoothing', 'opacitySmooth', 0, 0.95, 0.01)}
                                {toggle('Invert', 'opacityInvert')}
                                {toggle('Points', 'opacityPoints')}
                                {toggle('Wireframe', 'opacityWire')}
                                {toggle('Mesh', 'opacityMesh')}
                                {toggle('Placed scene', 'opacityScene')}
                            </>
                        )}
                        {slider('Scene opacity', 'sceneOpacity', 0, 1, 0.01)}
                        <div className={styles.vfx_hint}>
                            {layers.opacityReact > 0
                                ? (layers.opacityMode === 'gate'
                                    ? 'On while the band sits above the threshold, off below it. Smoothing softens the edge.'
                                    : 'Follows the band\u2019s level above the floor, so the layer breathes with the track.')
                                : 'Fades the layers you pick with a slice of the spectrum. Scene opacity below sets the base level for everything placed in the Scene panel.'}
                        </div>
                    </div>

                    {/* Mesh */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Mesh</div>
                        {toggle('Show mesh', 'meshOn')}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {SHADING.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${layers.meshShading === s.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLayer('meshShading')(s.id)}
                                >
                                    {s.name}
                                </button>
                            ))}
                        </div>
                        {layers.meshShading !== 'textured' && layers.meshShading !== 'normal'
                            && colorRow('Colour', 'meshColor')}
                        {slider('Opacity', 'meshOpacity', 0, 1, 0.01)}
                    </div>

                    {/* Wireframe */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Wireframe</div>
                        {toggle('Show wireframe', 'wireOn')}
                        <div className={styles.vfx_segRow}>
                            {WIRE_LEVELS.map((w) => (
                                <button
                                    key={w.id}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${layers.wireLevel === w.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLayer('wireLevel')(w.id)}
                                >
                                    {w.name}
                                </button>
                            ))}
                        </div>
                        {colorRow('Colour', 'wireColor')}
                        {slider('Thickness', 'wireThickness', 0.0002, 0.012, 0.0002)}
                        {slider('Opacity', 'wireOpacity', 0, 1, 0.01)}
                        {slider('Reactivity', 'wireReact', 0, 3, 0.01)}
                        <div className={styles.vfx_hint}>
                            Vertices move with the music like the points do,
                            but edges keep hold of both ends so the mesh stays
                            welded. Shares the point cloud&apos;s pulse point
                            and frequency band.
                        </div>
                    </div>

                    {/* Saved looks */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Views</div>
                        <div className={styles.vfx_presetGrid}>
                            {presets.map((p, i) => (
                                <button
                                    // eslint-disable-next-line react/no-array-index-key
                                    key={i}
                                    type="button"
                                    title={p ? `Recall view ${i + 1}` : `Save view ${i + 1}`}
                                    className={`${styles.vfx_segBtn} ${activePreset === i ? styles.vfx_segBtnOn : ''}`}
                                    style={{ opacity: p ? 1 : 0.4 }}
                                    onClick={() => (p ? recallPreset(i) : savePreset(i))}
                                >
                                    {i + 1}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                onClick={() => {
                                    // Overwrite the live view if there is one,
                                    // otherwise take the first empty slot.
                                    const empty = presets.findIndex((p) => !p);
                                    savePreset(activePreset ?? (empty === -1 ? 0 : empty));
                                }}
                            >
                                <Save size={12} />
                                Save view
                            </button>
                        </div>
                        <div className={styles.vfx_hint}>
                            A view is the whole layer stack. Recalling one and
                            then editing updates it, so the slots are looks you
                            keep refining. 1–9 recall, shift+1–9 saves. Space
                            plays, V/P/M/W toggle layers, F frees the camera.
                        </div>
                    </div>

                    {/* Alignment */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Alignment nudge</div>
                        <div className={styles.vfx_hint} style={{ marginBottom: 10 }}>
                            The solve is automatic; trim it here if the overlay
                            sits slightly off the object.
                        </div>
                        {slider('Offset X', 'offsetX', -0.5, 0.5, 0.001, rig, setRigKey)}
                        {slider('Offset Y', 'offsetY', -0.5, 0.5, 0.001, rig, setRigKey)}
                        {slider('Offset Z', 'offsetZ', -0.5, 0.5, 0.001, rig, setRigKey)}
                        {slider('Rotate X', 'rotX', -15, 15, 0.1, rig, setRigKey)}
                        {slider('Rotate Y', 'rotY', -15, 15, 0.1, rig, setRigKey)}
                        {slider('Rotate Z', 'rotZ', -15, 15, 0.1, rig, setRigKey)}
                        {slider('Scale', 'scale', 0.8, 1.25, 0.001, rig, setRigKey)}
                        {slider('Swell', 'overscale', 1, 1.08, 0.0005, rig, setRigKey)}
                        <div className={styles.vfx_hint} style={{ marginTop: 10, marginBottom: 10 }}>
                            Swell lifts the points and edges off the surface
                            evenly; these slide them bodily, which is how you
                            get a drifting double of the object rather than a
                            slightly inflated one. Neither moves the mesh.
                        </div>
                        {slider('Overlay X', 'overlayX', -0.3, 0.3, 0.001, rig, setRigKey)}
                        {slider('Overlay Y', 'overlayY', -0.3, 0.3, 0.001, rig, setRigKey)}
                        {slider('Overlay Z', 'overlayZ', -0.3, 0.3, 0.001, rig, setRigKey)}
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            onClick={() => setRig((p) => ({ ...DEFAULT_RIG, cameraMode: p.cameraMode }))}
                        >
                            <RotateCcw size={12} />
                            Reset nudge
                        </button>
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                            {EXPORT_SCALES.map((sc) => (
                                <button
                                    key={sc.id}
                                    type="button"
                                    disabled={isExporting}
                                    className={`${styles.vfx_segBtn} ${exportScale === sc.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportScale(sc.id)}
                                >
                                    {sc.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_segRow}>
                            {EXPORT_QUALITY.map((q) => (
                                <button
                                    key={q.id}
                                    type="button"
                                    disabled={isExporting}
                                    className={`${styles.vfx_segBtn} ${exportQuality === q.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportQuality(q.id)}
                                >
                                    {q.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_segRow}>
                            {EXPORT_LENGTHS.map((len) => (
                                <button
                                    key={len.id}
                                    type="button"
                                    disabled={isExporting
                                        || (len.id === 'audio' && !audioReady)}
                                    title={len.id === 'audio' && !audioReady
                                        ? 'Load a track in the Scene panel first'
                                        : len.name}
                                    className={`${styles.vfx_segBtn} ${exportLength === len.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportLength(len.id)}
                                >
                                    {len.name}
                                </button>
                            ))}
                        </div>
                        {exportLength === 'loops' && slider('Cycles', 'exportLoops',
                            1, 40, 1, { exportLoops }, () => setExportLoops)}
                        <button
                            type="button"
                            className={`${styles.vfx_select} ${isExporting ? styles.vfx_recActive : ''}`}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                            disabled={!track}
                            onClick={() => {
                                if (isExporting) exportCanceledRef.current = true;
                                else startExport();
                            }}
                        >
                            {isExporting ? <Camera size={13} /> : <Download size={13} />}
                            {isExporting
                                ? `Cancel (${Math.round(exportProgress * 100)}%)`
                                : 'Export MP4'}
                        </button>
                        {isExporting && (
                            <>
                                <div className={styles.vfx_progress} style={{ marginTop: 10 }}>
                                    <div
                                        className={styles.vfx_progressFill}
                                        style={{ width: `${exportProgress * 100}%` }}
                                    />
                                </div>
                                <div className={styles.vfx_fileName}>{exportStage}</div>
                            </>
                        )}
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            Every frame is rendered at
                            {' '}
                            {Math.round(track ? track.intrinsics.width * exportScale : 0)}
                            x
                            {Math.round(track ? track.intrinsics.height * exportScale : 0)}
                            {', '}
                            supersampled, with the clip&apos;s own sound and any
                            loaded track mixed in. Ping-pong and the cycle count
                            are written out in full, so a few seconds of footage
                            can carry a whole song.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ScanCompositor;
