import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    Play, Pause, SlidersHorizontal, X, Download, Scissors,
    Camera, Trash2, RotateCcw, Save, Plus, Music, Boxes, Spline, Upload,
} from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import VfxNumberField from './VfxNumberField';
import {
    ASSETS, CURVES, MUSIC_ASSETS, PARAM_GROUPS, GEOM_KEYS, CURVE_GEOM_KEYS,
    fibonacciSphere, makeItem, makeCurveItem, buildPointCloudRecord,
    buildCurveRecord, applyAudioReactivity, applyRecordTransform,
    disposeRecord, loadPlyPoints, computeSpectrogram,
} from '../lib/audioScene';
import styles from './vfx.module.css';

// Camera poses come from backend/vidtrack: COLMAP solves a pose per frame, and
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

const EXPORT_SCALES = [
    { id: 0.5, name: '0.5x' },
    { id: 1, name: '1x' },
    { id: 1.5, name: '1.5x' },
];

// The layer stack. Everything here is snapshotted into a preset, so a cut can
// switch any of it mid-clip.
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

    meshOn: false,
    meshShading: 'matte',
    meshColor: '#2b4bdf',
    meshOpacity: 1,

    wireOn: false,
    wireColor: '#e8c56a',
    wireOpacity: 0.5,
};

// Kept out of presets: these describe the solve, not the look, so a cut should
// never change them.
const DEFAULT_RIG = {
    cameraMode: 'tracked',    // 'tracked' | 'free'
    offsetX: 0, offsetY: 0, offsetZ: 0,
    rotX: 0, rotY: 0, rotZ: 0,
    scale: 1,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function ScanCompositor() {
    const mountRef = useRef(null);
    const videoRef = useRef(null);

    const [clips, setClips] = useState([]);
    const [clipId, setClipId] = useState(null);
    const [track, setTrack] = useState(null);
    const [status, setStatus] = useState('Loading takes...');

    const [layers, setLayers] = useState(DEFAULT_LAYERS);
    const [rig, setRig] = useState(DEFAULT_RIG);
    const [menuOpen, setMenuOpen] = useState(true);

    const [presets, setPresets] = useState(() => Array(9).fill(null));
    const [activePreset, setActivePreset] = useState(null);
    const [cuts, setCuts] = useState([]);
    const [followCuts, setFollowCuts] = useState(true);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [loop, setLoop] = useState(true);
    const [muted, setMuted] = useState(true);
    const [speed, setSpeed] = useState(1);

    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);
    const [exportScale, setExportScale] = useState(1);

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

    useEffect(() => { sceneItemsRef.current = sceneItems; }, [sceneItems]);

    // Live mirrors so the render loop never closes over stale state.
    const layersRef = useRef(layers);
    const rigRef = useRef(rig);
    const trackRef = useRef(null);
    const cutsRef = useRef(cuts);
    const presetsRef = useRef(presets);
    const followCutsRef = useRef(followCuts);
    const activePresetRef = useRef(activePreset);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    useEffect(() => { layersRef.current = layers; }, [layers]);
    useEffect(() => { rigRef.current = rig; }, [rig]);
    useEffect(() => { cutsRef.current = cuts; }, [cuts]);
    useEffect(() => { presetsRef.current = presets; }, [presets]);
    useEffect(() => { followCutsRef.current = followCuts; }, [followCuts]);
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

    const selected = useMemo(
        () => sceneItems.find((i) => i.id === selectedId) || null,
        [sceneItems, selectedId],
    );

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
            t.wire.material.color.set(L.wireColor);
            t.wire.material.opacity = L.wireOpacity;
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
            m.size = L.cloudAttenuate
                ? (L.cloudSize / 1000) * 4
                : L.cloudSize * 1.5;
            m.opacity = L.cloudOpacity;
            m.transparent = L.cloudOpacity < 1;
            m.depthWrite = L.cloudOpacity >= 1;
            m.needsUpdate = true;

            const total = t.cloud.geometry.getAttribute('position').count;
            t.cloud.geometry.setDrawRange(
                0, Math.max(1, Math.floor(total * clamp01(L.cloudDensity))),
            );
        }

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
        [t.mesh, t.cloud, t.wire].forEach((obj) => {
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
        t.mesh = t.cloud = t.wire = null;

        const base = `${process.env.PUBLIC_URL}/mv/${clip.id}`;

        // A take without a solve is still worth opening: the scan loads and
        // free orbit works, there is just no footage to lock onto.
        const trackP = fetch(`${base}/track.json`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
        const glbP = new GLTFLoader().loadAsync(`${base}/${clip.id}.glb`);
        const plyP = new PLYLoader().loadAsync(`${base}/${clip.id}.ply`);
        // A scan runs to a few hundred thousand triangles, which as wireframe
        // covers every pixel and reads as a solid fill. The pipeline writes a
        // decimated copy for this layer; fall back if a take predates it.
        const wireP = new GLTFLoader()
            .loadAsync(`${base}/${clip.id}_wire.glb`)
            .catch(() => null);

        Promise.all([trackP, glbP, plyP, wireP])
            .then(([trackData, gltf, cloudGeo, wireGltf]) => {
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

                let wireGeo = geo;
                if (wireGltf) {
                    let lo = null;
                    wireGltf.scene.updateMatrixWorld(true);
                    wireGltf.scene.traverse((o) => {
                        if (!lo && o.isMesh) lo = o;
                    });
                    if (lo) {
                        wireGeo = lo.geometry.clone();
                        wireGeo.applyMatrix4(lo.matrixWorld);
                    }
                }
                const wire = new THREE.Mesh(
                    wireGeo,
                    new THREE.MeshBasicMaterial({
                        wireframe: true, transparent: true, depthWrite: false,
                    }),
                );
                wire.frustumCulled = false;
                t.wire = wire;
                t.modelRoot.add(wire);

                // --- point cloud. Points were sampled in random order by
                // glb_to_ply, so a draw range is already a uniform subset and
                // the density slider costs nothing.
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

    const attachVideo = useCallback((el) => {
        videoRef.current = el;
        const t = three.current;
        if (!el || !t.bgQuad) return;
        if (t.videoTexture) t.videoTexture.dispose();
        const tex = new THREE.VideoTexture(el);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        t.videoTexture = tex;
        t.bgQuad.material.map = tex;
        t.bgQuad.material.needsUpdate = true;
    }, []);

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
    }, [track]);

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
        t.needsRender = true;
    }, [rig]);

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
        const vid = videoRef.current;
        if (t.videoTexture && vid && vid.readyState >= 2) {
            if (!vid.paused || t.lastVideoTime !== vid.currentTime) {
                t.videoTexture.needsUpdate = true;
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

    // Cuts drive the look during playback: the active preset is whichever cut
    // the playhead has most recently passed.
    const presetForTime = useCallback((time) => {
        const list = cutsRef.current;
        let found = null;
        for (let i = 0; i < list.length; i++) {
            if (list[i].t <= time + 1e-6) found = list[i].preset;
            else break;
        }
        return found;
    }, []);

    useEffect(() => {
        const t = three.current;
        if (!t.renderer) return undefined;

        const tick = () => {
            t.raf = requestAnimationFrame(tick);
            if (exportingRef.current) return;

            const video = videoRef.current;
            const time = video ? video.currentTime : 0;

            // Advance the placed objects from whatever the analyser hears.
            const now = performance.now();
            const dt = Math.min(0.1, (now - (lastTickRef.current || now)) / 1000);
            lastTickRef.current = now;
            let freq = null;
            if (analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);
                freq = dataArrayRef.current;
            }
            const audioEl = audioRef.current;
            applyAudioReactivity(
                sceneObjectsRef.current, freq, dt,
                !!audioEl && !audioEl.paused,
            );

            if (followCutsRef.current) {
                const want = presetForTime(time);
                if (want != null && want !== activePresetRef.current) {
                    const snap = presetsRef.current[want];
                    if (snap) {
                        activePresetRef.current = want;
                        setActivePreset(want);
                        setLayers(snap);
                    }
                }
            }

            renderFrame(time);
        };
        t.raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(t.raf);
    }, [renderFrame, presetForTime, track]);

    // ---- Presets & cuts --------------------------------------------------

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

    const addCut = useCallback(() => {
        const video = videoRef.current;
        const i = activePresetRef.current;
        if (!video || i == null) return;
        const at = video.currentTime;
        setCuts((prev) => [...prev.filter((c) => Math.abs(c.t - at) > 1e-3),
            { t: at, preset: i }].sort((a, b) => a.t - b.t));
    }, []);

    const removeCut = useCallback((at) => {
        setCuts((prev) => prev.filter((c) => c.t !== at));
    }, []);

    // Editing while a cut is live should edit that cut, which is what makes
    // the panel feel like it is editing the shot under the playhead.
    const setLayer = useCallback((key) => (value) => {
        setLayers((prev) => {
            const next = { ...prev, [key]: value };
            const i = activePresetRef.current;
            if (followCutsRef.current && i != null && presetsRef.current[i]) {
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
        const v = videoRef.current;
        const a = audioRef.current;
        if (!v || exportingRef.current) return;
        if (v.paused) {
            v.play().catch(() => {});
            if (a && a.src) {
                attachAnalyser();
                audioCtxRef.current?.resume?.();
                a.play().catch(() => {});
            }
        } else {
            v.pause();
            a?.pause();
        }
    }, [attachAnalyser]);

    useEffect(() => {
        const v = videoRef.current;
        if (v) v.playbackRate = speed;
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
    // Frame-accurate: seek the video one frame at a time, pose the camera from
    // the solve for exactly that frame, apply whichever cut is live, render and
    // encode. Nothing depends on realtime playback, so the result never drops
    // or doubles a frame.
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
        const totalFrames = trackData.frame_count;

        const codecCandidates = ['avc1.640034', 'avc1.640033', 'avc1.640028',
            'avc1.64001f', 'avc1.4d0028', 'avc1.42e01e'];
        const bitrate = Math.min(80_000_000, Math.round(w * h * fps * 0.25));
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
            return;
        }

        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportProgress(0);

        // A live analyser only hears what is playing now, which is no use to a
        // loop that renders frame 37 whenever it gets there. Analyse the
        // decoded samples up front so each frame gets the spectrum it would
        // have had in the preview.
        let spectrum = null;
        if (audioBufferRef.current && sceneItemsRef.current.length) {
            setStatus('Analysing audio...');
            spectrum = computeSpectrogram(audioBufferRef.current, {
                fps, frameCount: totalFrames,
                offset: audioRef.current ? audioRef.current.currentTime : 0,
            });
            spectrogramRef.current = spectrum;
            setStatus('Exporting...');
        }

        const prevLoop = video.loop;
        const prevTime = video.currentTime;
        const prevSize = t.renderer.getSize(new THREE.Vector2());
        const prevRatio = t.renderer.getPixelRatio();
        const prevLayers = { ...layersRef.current };
        const prevActive = activePresetRef.current;

        video.loop = false;
        video.pause();
        setIsPlaying(false);
        t.renderer.setPixelRatio(1);
        t.renderer.setSize(w, h, false);

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

        const muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: { codec: 'avc', width: w, height: h, frameRate: fps },
            fastStart: 'in-memory',
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

        const frameUs = Math.round(1_000_000 / fps);
        let completed = false;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || encodeFailed) break;

                const time = Math.min(i / fps, Math.max(0, video.duration - 0.001));
                // eslint-disable-next-line no-await-in-loop
                await seekTo(time);

                if (followCutsRef.current) {
                    const want = presetForTime(time);
                    if (want != null && presetsRef.current[want]) {
                        layersRef.current = presetsRef.current[want];
                        activePresetRef.current = want;
                        applyLayers(layersRef.current);
                    }
                }

                // Deterministic per-frame reactivity: the same dt every frame,
                // so an export is reproducible rather than tied to how fast
                // the encode happened to run.
                applyAudioReactivity(
                    sceneObjectsRef.current,
                    spectrum ? spectrum[i] : null,
                    1 / fps,
                    !!spectrum,
                );

                if (t.videoTexture) t.videoTexture.needsUpdate = true;
                renderFrame(time);

                const vf = new window.VideoFrame(t.renderer.domElement, {
                    timestamp: i * frameUs,
                    duration: frameUs,
                });
                encoder.encode(vf, { keyFrame: i % Math.round(fps * 2) === 0 });
                vf.close();

                while (encoder.encodeQueueSize > 8 && !encodeFailed) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 5));
                }

                if (i % 3 === 0) setExportProgress((i + 1) / totalFrames);
            }

            if (!exportCanceledRef.current && !encodeFailed) {
                setExportProgress(1);
                await encoder.flush();
                muxer.finalize();
                completed = true;
            }
        } catch (e) {
            encodeFailed = e;
        } finally {
            try { encoder.close(); } catch (e) { /* already closed */ }
            video.loop = prevLoop;
            video.currentTime = prevTime;
            t.renderer.setPixelRatio(prevRatio);
            t.renderer.setSize(prevSize.x, prevSize.y, true);
            layersRef.current = prevLayers;
            activePresetRef.current = prevActive;
            applyLayers(prevLayers);
            exportingRef.current = false;
            setIsExporting(false);
            setExportProgress(0);
        }

        if (completed) {
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
    }, [clipId, exportScale, renderFrame, applyLayers, presetForTime]);

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
                        <video
                            ref={attachVideo}
                            key={clip.id}
                            src={`${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}.mp4`}
                            style={{ display: 'none' }}
                            muted={muted}
                            playsInline
                            loop={loop}
                            crossOrigin="anonymous"
                            onPlay={() => setIsPlaying(true)}
                            onPause={() => setIsPlaying(false)}
                            onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                            onLoadedMetadata={(e) => {
                                setDuration(e.target.duration);
                                e.target.playbackRate = speed;
                            }}
                        />
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
                    className={`${styles.vfx_toggle} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {!sceneOpen && (
                <button
                    type="button"
                    aria-label="Open scene controls"
                    onClick={() => setSceneOpen(true)}
                    // Clears the primary panel when it is open, otherwise sits
                    // beside the primary toggle.
                    style={menuOpen ? { right: 'calc(var(--gutter) + 306px)' } : undefined}
                    className={`${styles.vfx_toggle} ${styles.vfx_toggleSecondary} ${styles.vfx_visible}`}
                >
                    <Boxes size={18} />
                </button>
            )}

            {sceneOpen && (
                <div className={`${styles.vfx_panel} ${styles.vfx_panelSecondary}`}>
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
                            Plays with the clip. Export re-analyses the track
                            offline so every frame reacts exactly as previewed.
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
                <div className={styles.vfx_panel}>
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
                                    const v = videoRef.current;
                                    if (v) v.currentTime = parseFloat(e.target.value);
                                }}
                            />
                            <span className={styles.vfx_value}>{fmt(currentTime)}</span>
                        </div>
                        {slider('Speed', 'speed', 0.1, 2, 0.05,
                            { speed }, () => setSpeed)}
                        {toggle('Loop', 'loop', { loop }, () => setLoop)}
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
                        {colorRow('Colour', 'wireColor')}
                        {slider('Opacity', 'wireOpacity', 0, 1, 0.01)}
                    </div>

                    {/* Presets + cuts */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Views &amp; cuts</div>
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
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                disabled={activePreset == null || !presets[activePreset]}
                                onClick={addCut}
                            >
                                <Scissors size={12} />
                                Cut here
                            </button>
                        </div>
                        {toggle('Follow cuts', 'followCuts', { followCuts },
                            () => setFollowCuts)}

                        {!!cuts.length && (
                            <div className={styles.vfx_cutList}>
                                {cuts.map((c) => (
                                    <div className={styles.vfx_cutRow} key={c.t}>
                                        <button
                                            type="button"
                                            className={styles.vfx_cutJump}
                                            onClick={() => {
                                                const v = videoRef.current;
                                                if (v) v.currentTime = c.t;
                                            }}
                                        >
                                            {fmt(c.t)} → view {c.preset + 1}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Remove cut"
                                            className={styles.vfx_iconBtn}
                                            style={{ width: 20, height: 20 }}
                                            onClick={() => removeCut(c.t)}
                                        >
                                            <Trash2 size={11} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className={styles.vfx_hint}>
                            1–9 recall a view, shift+1–9 saves one. Space plays,
                            V/P/M/W toggle layers, F frees the camera.
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
                        <div className={styles.vfx_segRow}>
                            {EXPORT_SCALES.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    disabled={isExporting}
                                    className={`${styles.vfx_segBtn} ${exportScale === s.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportScale(s.id)}
                                >
                                    {s.name}
                                </button>
                            ))}
                        </div>
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
                            <div className={styles.vfx_progress} style={{ marginTop: 10 }}>
                                <div
                                    className={styles.vfx_progressFill}
                                    style={{ width: `${exportProgress * 100}%` }}
                                />
                            </div>
                        )}
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            Renders every frame at the solved resolution with cuts
                            applied, independent of playback.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ScanCompositor;
