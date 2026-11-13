// The compositor's renderer: one WebGL canvas that draws the program at any
// timeline time, in one of three modes:
//
//   preview  the program camera (a take's solve, or a camera object) over
//            the footage, with effects, nearly as an export renders it
//   orbit    a free camera (drag to orbit, WASD to fly) with effects on;
//            the footage stays hidden since it no longer lines up
//   edit     the free camera with no post processing, plus a grid, camera
//            frustums and the sun, for placing things
//
// It knows nothing of React. The host hands it the project (setProject),
// the selection, the audio analysis and a time to draw (renderAt), and
// listens for edits made in the viewport (gizmo drags, picks).
//
// The per-frame compositing is the scan compositor's: things behind the
// footage, the footage, windows cutting it back out and their effects, then
// things in front, with object mattes holding the front pass out where a
// real object stands in front of it. Plain video clips over the base clip
// are drawn last, as flat layers, before the effects.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import DreamHazeShader from '../../../lib/dreamHaze';
import { PointGlowPass } from '../../../lib/pointGlow';
import { WindowCompositor, LAYER, cornersFacing } from '../../../lib/scanAssets/windows';
import { MatteSet, HoldoutPass, mattesFor } from '../../../lib/scanAssets/roto';
import { DEFAULT_SCREEN } from '../../../lib/scanAssets/library';
import { makeFrame, resolveObject, resolveTrack } from '../model/resolve';
import { globalsOf } from '../model/globals';
import { ALL_POINTS } from '../model/spline';
import { switchAt as switchStateAt, isSwitch } from '../model/controllers';
import { OBJECT_TYPES } from '../model/schema';
import { programAt, clipSourceTime } from '../model/timeline';
import { TakeRig, poseAt, applyIntrinsics } from './takeRig';
import { makeAdapter } from './adapters';
import { drawnSpan, knotU } from './curveObject';
import { VideoPool } from './media';
import {
    GradeShader, GRADE_KEYS, MatteSnapPass, MatteTopShader,
} from './passes';
import QuadTreeFx from '../../quadtree/engine/threeFx';
import SortFx from './sortFx';
import BlobFx from './blobFx';
import { setReactSeed } from '../../../lib/audioScene';
import { quadAspect } from '../../../lib/scanAssets/props';

// Effects that run on a picture (the program's or one track's) in compose, not as composer passes.
// They run in effect order, each on the picture the ones before it left.
const PICTURE_FX = new Set(['quadtree', 'pixelsort', 'blobs']);
const NOT_PASSES = PICTURE_FX;
const PICTURE_KIND = { quadtree: 'qt', pixelsort: 'sort', blobs: 'blobs' };

// A window's picture laid flat: its patch drawn in its own UV space, each
// point reading the composite where the camera sees that point of the
// window. Clip coordinates are linear across each triangle in UV space, so
// dividing per fragment is exact perspective.
const UNWARP_VERT = /* glsl */`
varying vec4 vClip;
void main() {
    vClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;
const UNWARP_FRAG = /* glsl */`
uniform sampler2D tComp;
varying vec4 vClip;
void main() {
    if (vClip.w <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 s = vClip.xy / vClip.w * 0.5 + 0.5;
    if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    gl_FragColor = vec4(texture2D(tComp, s).rgb, 1.0);
}`;

const D2R = Math.PI / 180;
const OVERLAY_ONLY = 1 << LAYER.OVERLAY;

/** A camera object's pose at `t`: its recorded path, or its placement. */
export function cameraPoseAt(obj, p, t) {
    const path = obj.extra?.path;
    if (p.usePath !== false && path && path.length) {
        let i = 0;
        while (i < path.length - 1 && path[i + 1].t <= t) i++;
        const a = path[i];
        const b = path[Math.min(path.length - 1, i + 1)];
        const pos = new THREE.Vector3().fromArray(a.p);
        const quat = new THREE.Quaternion().fromArray(a.q);
        if (b !== a && t > a.t) {
            const f = Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t));
            pos.lerp(new THREE.Vector3().fromArray(b.p), f);
            quat.slerp(new THREE.Quaternion().fromArray(b.q), f);
        }
        return { pos, quat, fov: a.fov ?? p.fov, ...projectionOf(p) };
    }
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rotX * D2R, p.rotY * D2R, p.rotZ * D2R, 'YXZ'));
    return { pos: new THREE.Vector3(p.posX, p.posY, p.posZ), quat, fov: p.fov, ...projectionOf(p) };
}

/** Whether a camera object draws orthographically, and how much it sees top to bottom. */
const projectionOf = (p) => ({ ortho: p.projection === 'orthographic', height: Math.max(1e-3, p.orthoHeight ?? 4) });

/** Frame an orthographic camera `height` tall at `aspect`. */
function setOrtho(cam, height, aspect, near, far) {
    const h = height / 2;
    cam.left = -h * aspect;
    cam.right = h * aspect;
    cam.top = h;
    cam.bottom = -h;
    cam.near = near;
    cam.far = far;
    cam.zoom = 1;
    cam.updateProjectionMatrix();
}

// ---- Scene views, kept in this browser ------------------------------------------

const VIEWS_KEY = 'compositor.sceneViews.v1';
const MAX_VIEWS = 300;

/** The views kept for scenes (sceneId -> view), or none if storage is unavailable. */
function loadViews() {
    try {
        const raw = window.localStorage.getItem(VIEWS_KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return new Map(obj && typeof obj === 'object' ? Object.entries(obj) : []);
    } catch (e) {
        return new Map();
    }
}

function saveViews(views) {
    try {
        let entries = Array.from(views.entries());
        if (entries.length > MAX_VIEWS) {
            entries = entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_VIEWS);
            views.clear();
            entries.forEach(([k, v]) => views.set(k, v));
        }
        window.localStorage.setItem(VIEWS_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {
        // Private browsing, or storage full: views last as long as the page.
    }
}

export default class Engine {
    constructor() {
        this.project = null;
        this.mode = 'preview';
        this.selectedId = null;
        this.analysis = { music: null, spectrum: null, spectrumAt: () => null };
        this.library = () => ({ assets: [] });
        this.scenes = new Map(); // scene id -> { root, rig, adapters, take }
        this.activeSceneId = null;
        this.listeners = {
            edit: new Set(), pick: new Set(), change: new Set(), cornerPick: new Set(), corners: new Set(),
        };
        this.size = new THREE.Vector2(1, 1);
        this.outputAspect = 4 / 3;
        this.ss = 1;
        this.exporting = false;
        this.lastTime = 0;
        this.keys = {};
        this.flySpeed = 1.5;
        this.recording = null;
        this.status = '';
        // Quad tree effects and windows, each with its own runner, by id.
        this.qtFx = new Map();
        // Pixel sort effects, likewise.
        this.sortFx = new Map();
        // Quad tree and pixel sort effects on now, in effect order: { obj, p, kind, target }.
        this.pictureFx = [];
        this.drawNo = 0;
        // Blob Tracker effects, by id, and those on now: { obj, p, fx, target }.
        this.blobFx = new Map();
        this.blobActive = [];
    }

    on(kind, fn) {
        this.listeners[kind].add(fn);
        return () => this.listeners[kind].delete(fn);
    }

    emit(kind, ...args) { this.listeners[kind].forEach((fn) => fn(...args)); }

    // ---- Setup -----------------------------------------------------------------

    mount(el) {
        this.el = el;
        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.autoClear = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.shadowMap.autoUpdate = false;
        renderer.domElement.style.display = 'block';
        // The canvas sits in a box exactly its size, so overlays (the roto
        // editor's) can be laid over the picture and nothing else.
        this.stage = document.createElement('div');
        this.stage.style.position = 'absolute';
        this.stage.appendChild(renderer.domElement);
        el.appendChild(this.stage);
        this.renderer = renderer;

        const scene = new THREE.Scene();
        this.scene = scene;
        const ambient = new THREE.AmbientLight(0xffffff, 0.55);
        const sun = new THREE.DirectionalLight(0xffffff, 1.1);
        // Thin curves and small points need fine texels; as fine as the GPU allows, up to 4096.
        const mapSize = Math.min(4096, renderer.capabilities.maxTextureSize || 2048);
        sun.shadow.mapSize.set(mapSize, mapSize);
        this.maxShadowSize = mapSize;
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.015;
        // Things drawn behind the footage cast shadows too (the shadow camera sees only layer 0 by default).
        sun.shadow.camera.layers.enable(LAYER.BEHIND);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-2, -1, -2);
        [ambient, sun, fill].forEach((l) => { l.layers.enableAll(); scene.add(l); });
        scene.add(sun.target);
        Object.assign(this, { ambient, sun, fill });

        this.trackedCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 100);
        this.objectCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 500);
        this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
        this.freeCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.001, 1000);
        this.freeCamera.position.set(0, 0.5, 4);
        this.controls = new OrbitControls(this.freeCamera, renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.enabled = false;
        // Where the free camera was left in each scene (sceneId -> view), so
        // coming back to a scene comes back to that view; kept in this
        // browser, not the project. viewScene is the scene the camera's
        // view now belongs to.
        this.sceneViews = loadViews();
        this.viewScene = null;
        this.viewKept = { key: '', at: 0 };

        // The footage, and plain video layers over everything, as quads.
        this.bgScene = new THREE.Scene();
        this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        this.bgScene.add(this.bgQuad);
        this.layerScene = new THREE.Scene();
        this.layerQuads = [];

        // Post. The composite goes into fxTarget when any effect is on.
        const fxTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(renderer, fxTarget);
        // Each Glow effect gets its own passes before gamma (glow works in
        // linear light); haze and grade come after it, on display colour.
        // Within each group they run in the outliner's order.
        this.gamma = new ShaderPass(GammaCorrectionShader);
        this.composer.addPass(this.gamma);
        // Mattes over the glows: the frame before them, laid back where a matte is.
        this.matteSnap = new MatteSnapPass();
        this.matteTop = new ShaderPass(MatteTopShader);
        this.matteSnap.enabled = false;
        this.matteTop.enabled = false;
        this.glowPasses = []; // [{ id, bloom, point }]
        this.postPasses = []; // [{ id, type, pass }]

        this.windows = new WindowCompositor(renderer);
        this.holdout = new HoldoutPass(renderer);
        this.mattes = new MatteSet();

        // Editing furniture, on the overlay layer.
        this.helpers = new THREE.Group();
        scene.add(this.helpers);
        this.grid = new THREE.GridHelper(20, 40, 0x555555, 0x2a2a2a);
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.6;
        this.helpers.add(this.grid);
        this.sunHelper = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), 0.6, 0xffd34d, 0.12, 0.06);
        this.helpers.add(this.sunHelper);
        this.cameraHelpers = new Map();
        this.helpers.traverse((o) => o.layers.set(LAYER.OVERLAY));

        this.gizmo = new TransformControls(this.freeCamera, renderer.domElement);
        this.gizmo.setSize(0.7);
        this.gizmo.enabled = false;
        this.gizmo.visible = false;
        scene.add(this.gizmo);
        // Drawn last, on the overlay layer, so effects never touch it. Its
        // raycaster only sees layer 0 by default, which would leave every
        // handle unclickable.
        this.gizmo.traverse((o) => o.layers.set(LAYER.OVERLAY));
        this.gizmo.getRaycaster().layers.enableAll();
        this.gizmo.addEventListener('dragging-changed', (e) => {
            this.controls.enabled = !e.value && this.mode !== 'preview';
            this.dragging = e.value;
            // What it holds isn't reset from the project mid-drag (a spline's handle).
            if (this.gizmo.object) this.gizmo.object.userData.dragging = e.value;
            const ct = this.cornerTargetNow;
            if (e.value) {
                // Where the corners were as the drag began: every step of it,
                // the last included, is applied to these.
                this.cornerDrag = ct ? {
                    corners: ct.corners.map((c) => [...c]),
                    mid: ct.corners.reduce((a, c) => a.add(new THREE.Vector3().fromArray(c)), new THREE.Vector3()).multiplyScalar(1 / ct.corners.length),
                } : null;
                return;
            }
            this.commitGizmo(true);
            this.cornerDrag = null;
        });
        this.gizmo.addEventListener('objectChange', () => this.commitGizmo(false));
        this.cameraProxy = new THREE.Object3D();
        scene.add(this.cameraProxy);

        // Corner editing (windows, screens, the pulse plane and line, a
        // spline's points): a marker per corner plus one in the middle that
        // moves them all, the gizmo on a proxy standing where the picked one
        // is, and lines joining them. Markers are made as many as needed.
        this.cornerProxy = new THREE.Object3D();
        scene.add(this.cornerProxy);
        this.cornerHandles = new THREE.Group();
        this.cornerGeo = new THREE.OctahedronGeometry(1, 0);
        this.cornerMarkers = [];
        this.cornerMid = this.makeMarker();
        this.cornerHandles.visible = false;
        scene.add(this.cornerHandles);
        this.cornerGuide = new THREE.LineSegments(
            new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3)),
            new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }),
        );
        this.cornerGuide.layers.set(LAYER.OVERLAY);
        // Its parent may be a placed object (a prop's screen, a spline), whose layers the frame resets: not this.
        this.cornerGuide.userData.handle = true;
        this.cornerGuide.frustumCulled = false;
        this.cornerGuide.renderOrder = 1000;
        this.cornerGuide.visible = false;
        scene.add(this.cornerGuide);

        this.cornerHandles.add(this.cornerMid);
        this.pool = new VideoPool((missing) => { this.dirty = true; if (missing) this.emit('change'); });

        this.onPointerDown = (e) => this.pick(e);
        // The viewport is never a source of text selection or native drags
        // (a stray selection would otherwise be dragged off as a clipping
        // instead of orbiting the camera).
        this.onNoDrag = (e) => e.preventDefault();
        this.onClearSelection = () => window.getSelection?.()?.removeAllRanges();
        el.addEventListener('dragstart', this.onNoDrag);
        el.addEventListener('selectstart', this.onNoDrag);
        el.addEventListener('pointerdown', this.onClearSelection, true);
        renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
        // Held keys, with when each last said so (its auto-repeat keeps that
        // fresh). A Mac sends no keyup for a key let go while ⌘ is down, so
        // ⌘S would otherwise leave S held and fly the camera backwards:
        // shortcuts are not flying, letting go of ⌘ or leaving the window
        // drops everything, and a key that has gone quiet is dropped too.
        this.onKey = (e) => {
            if (e.key === 'Meta' || e.key === 'Control') {
                if (e.type === 'keyup') this.keys = {};
                return;
            }
            if (e.type === 'keyup') { delete this.keys[e.code]; return; }
            // A key the tool used as a shortcut (S cutting a switch) is not flying.
            if (e.defaultPrevented) return;
            if (e.metaKey || e.ctrlKey || e.altKey) { this.keys = {}; return; }
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            // `repeating` once the OS has started auto-repeating it: only
            // then does going quiet mean it was let go.
            this.keys[e.code] = { at: performance.now(), repeating: !!e.repeat || !!this.keys[e.code] };
        };
        this.dropKeys = () => { this.keys = {}; };
        window.addEventListener('keydown', this.onKey);
        window.addEventListener('keyup', this.onKey);
        window.addEventListener('blur', this.dropKeys);
        document.addEventListener('visibilitychange', this.dropKeys);
        this.resizeObserver = new ResizeObserver(() => this.fit());
        this.resizeObserver.observe(el);
        this.fit();
    }

    /** A corner marker: on top of everything, on the overlay. */
    makeMarker() {
        const m = new THREE.Mesh(this.cornerGeo, new THREE.MeshBasicMaterial({
            color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9, toneMapped: false,
        }));
        m.layers.set(LAYER.OVERLAY);
        m.renderOrder = 1001;
        m.userData.handle = true;
        return m;
    }

    /** The handle that moves all of the target's corners at once. */
    allHandle(target) { return target?.kind === 'spline' ? ALL_POINTS : 4; }

    dispose() {
        this.resizeObserver?.disconnect();
        window.removeEventListener('keydown', this.onKey);
        window.removeEventListener('keyup', this.onKey);
        window.removeEventListener('blur', this.dropKeys);
        document.removeEventListener('visibilitychange', this.dropKeys);
        this.renderer?.domElement.removeEventListener('pointerdown', this.onPointerDown);
        this.scenes.forEach((s) => this.dropScene(s));
        this.scenes.clear();
        this.pool?.dispose();
        this.gizmo?.detach();
        this.gizmo?.dispose();
        this.rememberView();
        this.matteSnap?.dispose();
        this.matteTop?.dispose?.();
        this.controls?.dispose();
        this.windows?.dispose();
        this.holdout?.dispose();
        this.footRT?.dispose();
        this.scanDepthRT?.dispose();
        this.blackTex?.dispose();
        this.mattes?.dispose();
        this.composer?.dispose();
        this.glowPasses?.forEach((g) => { g.bloom.dispose(); g.point.dispose(); });
        this.postPasses?.forEach(({ pass }) => pass.dispose?.());
        this.qtFx?.forEach((fx) => fx.dispose());
        this.qtFx?.clear();
        this.sortFx?.forEach((fx) => fx.dispose());
        this.sortFx?.clear();
        this.blobFx?.forEach((fx) => fx.dispose());
        this.blobFx?.clear();
        this.soloLayer?.quad.material.dispose();
        this.unwarp?.targets.forEach((rt) => rt.dispose());
        this.unwarp?.mat.dispose();
        this.renderer?.dispose();
        this.stage?.remove();
    }

    /** Size the canvas to the largest output-aspect box that fits the mount. */
    fit() {
        if (!this.el || !this.renderer || this.exporting) return;
        const W = this.el.clientWidth;
        const H = this.el.clientHeight;
        if (!W || !H) return;
        // Rotoscoping draws the take as it is, so the frame is the take's shape.
        const aspect = this.roto?.on && this.roto.aspect ? this.roto.aspect : this.outputAspect;
        let w = W;
        let h = w / aspect;
        if (h > H) { h = H; w = h * aspect; }
        w = Math.max(2, Math.round(w));
        h = Math.max(2, Math.round(h));
        this.renderer.setSize(w, h, true);
        Object.assign(this.stage.style, {
            left: `${Math.round((W - w) / 2)}px`, top: `${Math.round((H - h) / 2)}px`, width: `${w}px`, height: `${h}px`,
        });
        this.dirty = true;
    }

    // ---- State from the host ------------------------------------------------------

    /** Roto mode: `{ on, plain, aspect }`. Plain draws the footage and nothing else. */
    setRoto(roto) {
        const was = this.roto?.on ? this.roto.aspect : null;
        this.roto = roto;
        if ((roto?.on ? roto.aspect : null) !== was) this.fit();
        this.dirty = true;
    }

    /** Corner editing: `{ objectId, handle }` (0-3 a corner, 4 all of them), or null. */
    setCornerEdit(edit) {
        this.cornerEdit = edit;
        this.dirty = true;
    }

    setMode(mode) {
        this.mode = mode;
        this.controls.enabled = mode !== 'preview';
        if (mode !== 'preview') this.viewActive();
        this.dirty = true;
    }

    /** The free camera's view now: where it is, what it orbits, its lens and fly speed. */
    currentView() {
        const r = (v) => Math.round(v * 1e5) / 1e5;
        return {
            p: this.freeCamera.position.toArray().map(r),
            t: this.controls.target.toArray().map(r),
            fov: this.freeCamera.fov,
            fly: this.flySpeed,
            at: Date.now(),
        };
    }

    /** Keep the free camera's view as scene `id`'s (if the view is that scene's). */
    rememberView(id = this.activeSceneId) {
        if (!id || this.viewScene !== id) return;
        this.sceneViews.set(id, this.currentView());
        saveViews(this.sceneViews);
    }

    /** Put the free camera back where it was left in scene `id`; false if it never was. */
    restoreView(id) {
        const v = id && this.sceneViews.get(id);
        if (!v || !Array.isArray(v.p) || !Array.isArray(v.t)) return false;
        this.freeCamera.position.fromArray(v.p);
        this.controls.target.fromArray(v.t);
        if (Number.isFinite(v.fov) && v.fov !== this.freeCamera.fov) {
            this.freeCamera.fov = v.fov;
            this.freeCamera.updateProjectionMatrix();
        }
        if (Number.isFinite(v.fly)) this.flySpeed = v.fly;
        this.controls.update();
        this.framed = true;
        this.viewScene = id;
        return true;
    }

    /** The active scene's view on the free camera: where it was left, else (editing) framed on its scan. */
    viewActive() {
        const id = this.activeSceneId;
        if (!id || this.viewScene === id) return;
        if (this.restoreView(id)) return;
        if (this.mode !== 'preview') this.frameActive();
    }

    setSelection(id) {
        this.selectedId = id;
        this.dirty = true;
    }

    setAnalysis(a) {
        this.analysis = a || { music: null, spectrum: null, spectrumAt: () => null };
        this.dirty = true;
    }

    setLibrary(fn) { this.library = fn; }

    /** Where to read each take's scan colour correction from: `() => ({ take: look })`. */
    setLooks(fn) { this.looks = fn; this.dirty = true; }

    setGizmoMode(m) {
        this.userGizmoMode = m;
        this.dirty = true;
    }

    setProject(project) {
        this.project = project;
        const out = project.output || {};
        const aspect = (out.width || 4) / (out.height || 3);
        if (Math.abs(aspect - this.outputAspect) > 1e-4) { this.outputAspect = aspect; this.fit(); }
        // Scenes: make what is new, drop what is gone.
        const wanted = new Set(project.scenes.map((s) => s.id));
        this.scenes.forEach((s, id) => { if (!wanted.has(id)) { this.dropScene(s); this.scenes.delete(id); } });
        project.scenes.forEach((sc) => {
            if (this.scenes.has(sc.id)) return;
            const root = new THREE.Group();
            root.visible = false;
            this.scene.add(root);
            const s = { id: sc.id, root, adapters: new Map(), take: sc.take, rig: null };
            if (sc.take) s.rig = new TakeRig(sc.take, root, () => { this.dirty = true; this.emit('change'); });
            this.scenes.set(sc.id, s);
        });
        // Objects: adapters for the placed ones.
        const byScene = new Map();
        project.objects.forEach((o) => {
            if (!o.sceneId) return;
            if (!byScene.has(o.sceneId)) byScene.set(o.sceneId, []);
            byScene.get(o.sceneId).push(o);
        });
        this.scenes.forEach((s, id) => {
            const objs = byScene.get(id) || [];
            const ids = new Set(objs.map((o) => o.id));
            s.adapters.forEach((a, oid) => {
                if (ids.has(oid)) return;
                if (this.gizmo.object && (this.gizmo.object === a.object || this.gizmo.object === a.gizmoTarget)) this.gizmo.detach();
                a.dispose();
                a.anchor?.removeFromParent();
                s.adapters.delete(oid);
            });
            objs.forEach((o) => {
                if (s.adapters.has(o.id)) return;
                const a = makeAdapter(o, s.root, { library: () => this.library() });
                if (a) s.adapters.set(o.id, a);
            });
        });
        // Media no longer used by any clip.
        const used = new Set(project.clips.map((c) => c.mediaId));
        Array.from(this.pool.items.keys()).forEach((id) => { if (!used.has(id)) this.pool.drop(id); });
        this.rebuildPost();
        this.dirty = true;
    }

    dropScene(s) {
        s.adapters.forEach((a) => a.dispose());
        s.adapters.clear();
        s.rig?.dispose();
        s.root.removeFromParent();
    }

    rig(sceneId) { return this.scenes.get(sceneId)?.rig || null; }

    /** Media ids the pool could not find. */
    get missingMedia() { return this.pool ? this.pool.missing : new Set(); }

    // ---- Effects ----------------------------------------------------------------------

    rebuildPost() {
        const effects = this.project.objects.filter((o) => !o.sceneId && OBJECT_TYPES[o.type]?.category === 'effect');
        const key = effects.map((e) => `${e.id}:${e.type}`).join(',');
        if (key === this.postKey) return;
        this.postKey = key;
        const c = this.composer;
        [...c.passes].forEach((pass) => c.removePass(pass));
        this.glowPasses.forEach((g) => { g.bloom.dispose(); g.point.dispose(); });
        this.postPasses.forEach(({ pass }) => pass.dispose?.());
        c.addPass(this.matteSnap);
        this.glowPasses = effects.filter((e) => e.type === 'glow').map((e) => {
            const point = new PointGlowPass();
            const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0.6, 0.5);
            point.enabled = false;
            bloom.enabled = false;
            c.addPass(point);
            c.addPass(bloom);
            return { id: e.id, point, bloom };
        });
        c.addPass(this.matteTop);
        c.addPass(this.gamma);
        this.postPasses = effects.filter((e) => e.type !== 'glow' && !NOT_PASSES.has(e.type)).map((e) => {
            const pass = new ShaderPass(e.type === 'grade' ? GradeShader : DreamHazeShader);
            c.addPass(pass);
            return { id: e.id, type: e.type, pass };
        });
        // New passes size themselves from the composer at the next frame.
        this.composerSized = null;
    }

    /** Push the effects' parameters onto the passes; returns whether any pass runs. */
    applyEffects(frame) {
        const fx = this.mode !== 'edit';
        const effects = this.project.objects.filter((o) => !o.sceneId);
        let any = false;
        this.glowPasses.forEach(({ id, bloom, point }) => {
            const obj = effects.find((o) => o.id === id);
            // Resolved, so a glow whose visibility follows a controller turns on and off with it.
            const glow = obj ? resolveObject(obj, frame) : null;
            const on = fx && !!glow && glow.visible !== false;
            // Points only, or the 3D objects only: their own source, bloomed and laid over the frame.
            const own = on && (glow.source === 'points' || glow.source === 'scene');
            bloom.enabled = on && !own && glow.strength > 0;
            point.enabled = own && (glow.strength > 0 || glow.bleed > 0);
            point.mode = glow?.source === 'scene' ? 'scene' : 'points';
            point.threshold = point.mode === 'scene' ? (glow.threshold ?? 0.8) : 0;
            if (on) {
                bloom.strength = glow.strength;
                bloom.radius = glow.radius;
                bloom.threshold = glow.threshold;
                point.halo = glow.strength;
                point.spread = glow.radius;
                point.bleed = glow.bleed;
                point.reach = glow.reach;
            }
            any = any || bloom.enabled || point.enabled;
        });
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        this.postPasses.forEach(({ id, type, pass }) => {
            const obj = effects.find((o) => o.id === id);
            const p = obj ? resolveObject(obj, frame) : null;
            pass.enabled = fx && !!p && p.visible !== false;
            if (!pass.enabled) return;
            const u = pass.uniforms;
            if (type === 'haze') {
                pass.enabled = p.amount > 0;
                u.intensity.value = p.amount;
                u.tint.value = Math.min(1, p.amount);
                u.time.value = frame.t;
            } else {
                GRADE_KEYS.forEach((k) => { u[k].value = p[k]; });
                u.invert.value = p.invert ? 1 : 0;
                u.aspect.value = size.x / Math.max(1, size.y);
            }
            any = any || pass.enabled;
        });
        // Quad trees, pixel sorts and Blob Trackers run in compose (some on
        // one track's picture only); here they are resolved, and their
        // runners kept or let go.
        this.pictureFx = fx ? effects.filter((o) => PICTURE_FX.has(o.type)).map((obj) => {
            const p = resolveObject(obj, frame);
            const qt = obj.type === 'quadtree';
            return {
                obj, p, kind: PICTURE_KIND[obj.type],
                target: (qt ? p.qt_target : p.target) || 'program',
                mix: qt ? (p.qt_mix ?? 1) : obj.type === 'pixelsort' ? (p.sortMix ?? 1) : 1,
                preview: qt ? p.qt_preview : p.preview,
            };
        }).filter((e) => e.p.visible !== false && e.mix > 0 && (this.exporting || e.preview !== false)) : [];
        any = any || this.pictureFx.length > 0;
        const keepSort = new Set(effects.filter((o) => o.type === 'pixelsort').map((o) => o.id));
        // Blob Trackers that are on (their mattes are loaded with the take's).
        this.blobActive = this.pictureFx.filter((e) => e.kind === 'blobs');
        const keepBlobs = new Set(effects.filter((o) => o.type === 'blobs').map((o) => o.id));
        this.blobFx.forEach((b, id) => { if (!keepBlobs.has(id)) { b.dispose(); this.blobFx.delete(id); } });
        this.sortFx.forEach((q, id) => { if (!keepSort.has(id)) { q.dispose(); this.sortFx.delete(id); } });
        const keepQt = new Set(effects.filter((o) => o.type === 'quadtree').map((o) => o.id));
        // Windows with a quad tree need the frame in a target they can read.
        let winQt = false;
        this.blobActive.forEach(({ obj }) => this.blobFx.get(obj.id)?.windows.forEach((w) => {
            if (!w.model.op?.qt_on) return;
            keepQt.add(`win:${w.id}`);
            winQt = true;
        }));
        this.scenes.forEach((sc) => sc.adapters.forEach((a, id) => {
            const op = a.model?.op;
            if (!op?.qt_on) return;
            keepQt.add(`win:${id}`);
            if (sc.id === this.activeSceneId && (this.exporting || op.qt_preview !== false)) winQt = true;
        }));
        any = any || winQt;
        this.qtFx.forEach((q, id) => { if (!keepQt.has(id)) { q.dispose(); this.qtFx.delete(id); } });
        this.unwarp?.targets.forEach((rt, id) => { if (!keepQt.has(`win:${id}`)) { rt.dispose(); this.unwarp.targets.delete(id); } });
        const cur = this.composer.renderTarget1;
        const sizeKey = `${size.x}x${size.y}`;
        if (cur.width !== size.x || cur.height !== size.y || this.composerSized !== sizeKey) {
            this.composerSized = sizeKey;
            this.composer.setPixelRatio(1);
            this.composer.setSize(size.x, size.y);
        }
        return any;
    }

    // ---- Picking and the gizmo ------------------------------------------------------------

    adapterOf(id) {
        for (const s of this.scenes.values()) {
            const a = s.adapters.get(id);
            if (a) return { scene: s, adapter: a };
        }
        return null;
    }

    pick(e) {
        if (e.button !== 0 || this.gizmo.dragging || this.gizmo.axis || !this.activeCamera) return;
        const s = this.scenes.get(this.activeSceneId);
        if (!s) return;
        const box = this.renderer.domElement.getBoundingClientRect();
        // A corner marker, by distance on screen: they are only a few pixels across.
        if (this.cornerTargetNow && this.cornerHandles.visible) {
            const p = new THREE.Vector3();
            let best = null;
            const all = this.allHandle(this.cornerTargetNow);
            [...this.cornerMarkers.map((h, i) => [h, i]), [this.cornerMid, all]].forEach(([h, i]) => {
                if (!h.visible) return;
                h.getWorldPosition(p).project(this.activeCamera);
                if (p.z < -1 || p.z > 1) return;
                const d = Math.hypot(((p.x + 1) / 2) * box.width + box.left - e.clientX, ((1 - p.y) / 2) * box.height + box.top - e.clientY);
                if (d < 18 && (!best || d < best.d)) best = { d, i };
            });
            if (best) { this.emit('cornerPick', best.i); return; }
        }
        const ndc = new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.params.Points.threshold = 0.02;
        ray.layers.enableAll();
        ray.setFromCamera(ndc, this.activeCamera);
        const targets = [];
        s.adapters.forEach((a) => { if (a.object?.visible !== false) targets.push(a.object); });
        const hits = ray.intersectObjects(targets, true);
        this.pickStart = { x: e.clientX, y: e.clientY };
        const up = (ev) => {
            window.removeEventListener('pointerup', up);
            // A drag is an orbit, not a pick.
            if (Math.hypot(ev.clientX - this.pickStart.x, ev.clientY - this.pickStart.y) > 4) return;
            for (const h of hits) {
                let o = h.object;
                while (o && !o.userData.objectId) o = o.parent;
                if (o) { this.emit('pick', o.userData.objectId); return; }
            }
            this.emit('pick', null);
        };
        window.addEventListener('pointerup', up);
    }

    /** What the gizmo should hold for the selected object, if anything. */
    gizmoTargetFor(obj) {
        if (!obj || obj.gizmo === false || this.exporting) return null;
        if (obj.type === 'take') {
            const s = this.scenes.get(obj.sceneId);
            return s ? { node: s.root, kind: 'take' } : null;
        }
        if (obj.type === 'camera') return { node: this.cameraProxy, kind: 'camera' };
        const a = this.adapterOf(obj.id)?.adapter;
        if (!a) return null;
        if (obj.type === 'window' || obj.type === 'text' || obj.type === 'splinePoint') return null; // moved by their corners
        const node = a.gizmoTarget || a.object;
        return node ? { node, kind: 'object' } : null;
    }

    syncGizmo() {
        const obj = this.project?.objects.find((o) => o.id === this.selectedId);
        let target = obj && obj.sceneId === this.activeSceneId ? this.gizmoTargetFor(obj) : null;
        if (this.cornerTargetNow) target = { node: this.cornerProxy, kind: 'corners' };
        if (this.roto?.on || this.exporting) target = null;
        this.gizmoKind = target?.kind || null;
        // One corner only moves; all of them together move, turn and size
        // about their middle like any object.
        const one = this.gizmoKind === 'corners' && (this.cornerEdit?.handle ?? 4) < (this.cornerTargetNow?.corners.length ?? 4);
        const want = one ? 'translate' : (this.userGizmoMode || 'translate');
        if (this.gizmo.mode !== want && !this.dragging) this.gizmo.setMode(want);
        if (target && obj.type === 'camera' && !this.dragging) {
            const p = obj.params;
            this.cameraProxy.position.set(p.posX, p.posY, p.posZ);
            this.cameraProxy.rotation.set(p.rotX * D2R, p.rotY * D2R, p.rotZ * D2R, 'YXZ');
        }
        if (target) {
            if (this.gizmo.object !== target.node) this.gizmo.attach(target.node);
            this.gizmo.enabled = true;
            this.gizmo.visible = true;
        } else if (this.gizmo.object) {
            this.gizmo.detach();
            this.gizmo.enabled = false;
            this.gizmo.visible = false;
        }
    }

    commitGizmo(done) {
        const r = (v, k = 1e4) => Math.round(v * k) / k;
        if (this.gizmoKind === 'corners') {
            const t = this.cornerTargetNow;
            const start = this.cornerDrag;
            if (!t) return;
            const p = this.cornerProxy.position;
            const h = this.cornerEdit?.handle ?? 4;
            let corners;
            if (h < t.corners.length) {
                corners = t.corners.map((c, k) => (k === h ? [r(p.x), r(p.y), r(p.z)] : c));
            } else {
                // All of them, from where they were when the drag began: the
                // proxy started at their middle, unturned and unscaled, so
                // its transform now is what the drag did to them.
                const from = start || { corners: t.corners, mid: new THREE.Vector3() };
                this.cornerProxy.updateMatrix();
                const m = this.cornerProxy.matrix;
                corners = from.corners.map((c) => new THREE.Vector3().fromArray(c).sub(from.mid).applyMatrix4(m).toArray().map((v) => r(v)));
            }
            if (t.toOwn) corners = corners.map(t.toOwn);
            this.emit('corners', {
                objectId: t.obj.id, kind: t.kind, key: t.key, entryId: t.entry?.id, corners, done, handle: h,
            });
            return;
        }
        const obj = this.project?.objects.find((o) => o.id === this.selectedId);
        const node = this.gizmo.object;
        if (!obj || !node) return;
        const deg = (v) => r(v / D2R, 100);
        const e = node.rotation;
        let patch;
        if (this.gizmoKind === 'take') {
            patch = {
                offsetX: r(node.position.x), offsetY: r(node.position.y), offsetZ: r(node.position.z),
                rotX: deg(e.x), rotY: deg(e.y), rotZ: deg(e.z), scale: r(node.scale.x),
            };
        } else {
            patch = { posX: r(node.position.x), posY: r(node.position.y), posZ: r(node.position.z) };
            if (this.gizmoKind === 'camera') node.rotation.reorder('YXZ');
            patch.rotX = deg(node.rotation.x);
            patch.rotY = deg(node.rotation.y);
            patch.rotZ = deg(node.rotation.z);
            if (this.gizmoKind !== 'camera') patch.scale = r(node.scale.x);
        }
        this.emit('edit', obj.id, patch, done);
    }

    /**
     * Hang an object's node where it belongs: in its scene, or in its
     * parent's frame; a spline's point label on an anchor at its point
     * (shown while the spline shows labels).
     */
    attach(o, a, S, resolved, f) {
        const node = a.object;
        if (!node) return;
        let want = S.root;
        const pa = o.parentId ? S.adapters.get(o.parentId) : null;
        const frameOf = pa ? (pa.group || pa.object) : null;
        if (frameOf) {
            if (o.pointLabel) {
                if (!a.anchor) a.anchor = new THREE.Group();
                if (a.anchor.parent !== frameOf) frameOf.add(a.anchor);
                // (A spline whose symbol another has is solved by its adapter alone.)
                const st = f.globals?.spline(o.parentId) || pa.splineState;
                const i = o.pointLabel.index;
                const pt = st?.points?.[i];
                const ok = !!pt && pt.every(Number.isFinite);
                if (ok) a.anchor.position.set(pt[0], pt[1], pt[2]);
                const sp = resolved.get(o.parentId) || {};
                // A Text label (from before points were objects) shows with the labels.
                let shown = ok && (o.type === 'splinePoint' || sp.labels === true);
                let grow = 1;
                if (shown && sp.pointsByU) {
                    // Only once the drawn part of the curve has reached it.
                    const u = knotU(st.sol)[i];
                    const span = drawnSpan(sp, f.time);
                    const eps = 1e-6;
                    shown = !!span && Number.isFinite(u) && u >= span[0] - eps && u <= span[1] + eps;
                    const over = Math.max(0, sp.pointsAppear || 0);
                    if (shown && over > 0) {
                        const lead = sp.revealFrom === 'end' ? u - span[0] : sp.revealFrom === 'centre' ? Math.min(u - span[0], span[1] - u) : span[1] - u;
                        const x = Math.max(0, Math.min(1, lead / over));
                        grow = x * x * (3 - 2 * x);
                    }
                }
                a.anchor.visible = shown && grow > 1e-4;
                a.anchor.scale.setScalar(Math.max(1e-4, grow));
                want = a.anchor;
            } else {
                want = frameOf;
            }
        }
        if (want !== a.anchor && a.anchor) { a.anchor.removeFromParent(); a.anchor = null; }
        if (node.parent !== want) want.add(node);
    }

    /** The corners being edited, in the space they are written in, or null. */
    cornerTarget(objects, S) {
        const ed = this.cornerEdit;
        if (!ed || !S || this.exporting || this.roto?.on) return null;
        const obj = objects.find((o) => o.id === ed.objectId);
        if (!obj) return null;
        // Windows and text are both drawn by their corners, written to `corners`
        // (text over the frame is placed in frame coordinates instead).
        if (obj.type === 'text' && obj.params.space === 'frame') return null;
        if (obj.type === 'text' || obj.type === 'splinePoint') {
            // In the text's own frame: its parent's (a label's, from its point),
            // turned with it when it faces the camera, so the markers sit on it.
            const a = S.adapters.get(obj.id);
            if (obj.type === 'splinePoint' && (a?.look?.labels !== true || obj.params.showLabel === false)) return null;
            const node = a?.labelNode || a?.object;
            return { obj, kind: 'window', corners: obj.params.corners, space: node?.parent ? node : S.root };
        }
        if (obj.type === 'window') return { obj, kind: 'window', corners: obj.params.corners, space: S.root };
        if (obj.type === 'prop') {
            const a = S.adapters.get(obj.id);
            const entry = this.library().assets.find((x) => x.id === obj.params.assetId);
            if (!a?.model?.ready || entry?.category !== 'screen') return null;
            return { obj, kind: 'screen', entry, corners: { ...DEFAULT_SCREEN, ...entry.screen }.corners, space: a.model.norm };
        }
        if (obj.type === 'spline') {
            // Where its points are now (expressions worked out), in its own frame.
            const a = S.adapters.get(obj.id);
            // Edited in the scene's frame (its X, Y and Z, whatever the spline's
            // rotation, scale or spin), and written back in the spline's own.
            const pts = a?.splineState?.points;
            if (!pts?.length) return null;
            S.root.updateMatrixWorld(true);
            a.object.updateMatrixWorld(true);
            const toScene = new THREE.Matrix4().copy(S.root.matrixWorld).invert().multiply(a.group.matrixWorld);
            const toOwn = toScene.clone().invert();
            const v = new THREE.Vector3();
            const r = (x) => Math.round(x * 1e4) / 1e4;
            return {
                obj,
                kind: 'spline',
                corners: pts.map((pt) => v.set(...pt.map((x) => (Number.isFinite(x) ? x : 0))).applyMatrix4(toScene).toArray()),
                toOwn: (c) => v.fromArray(c).applyMatrix4(toOwn).toArray().map(r),
                space: S.root,
                path: true,
                closed: obj.params.ends === 'closed',
            };
        }
        if (obj.type === 'scanPoints' && S.rig?.cloud) {
            const key = obj.params.pulseMode === 'plane' ? 'pulsePlane' : obj.params.pulseMode === 'line' ? 'pulseLine' : null;
            const pts = key && obj.params[key];
            if (!pts) return null;
            return { obj, kind: 'pulse', key, corners: pts, space: S.rig.overlay };
        }
        return null;
    }

    syncCorners(target, cam) {
        this.cornerTargetNow = target;
        const H = this.cornerHandles;
        const G = this.cornerGuide;
        if (!target) { H.visible = false; G.visible = false; return; }
        if (H.parent !== target.space) target.space.add(H);
        if (G.parent !== target.space) target.space.add(G);
        target.space.updateMatrixWorld(true);
        H.visible = true;
        G.visible = true;
        const C = target.corners.map((c) => new THREE.Vector3().fromArray(c));
        const mid = C.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(1 / C.length);
        const all = this.allHandle(target);
        const picked = this.cornerEdit.handle ?? all;
        const active = picked < C.length ? picked : all;
        const camAt = cam.getWorldPosition(new THREE.Vector3());
        const k = target.space.getWorldScale(new THREE.Vector3()).x || 1;
        const wp = new THREE.Vector3();
        while (this.cornerMarkers.length < C.length) {
            const m = this.makeMarker();
            this.cornerMarkers.push(m);
            H.add(m);
        }
        const place = (m, at, on, color) => {
            m.position.copy(at);
            m.material.color.set(on ? '#ffb347' : color);
            m.updateMatrixWorld(true);
            m.getWorldPosition(wp);
            m.scale.setScalar((wp.distanceTo(camAt) * (on ? 0.016 : 0.011)) / k);
        };
        this.cornerMarkers.forEach((m, i) => {
            m.visible = i < C.length;
            if (m.visible) place(m, C[i], i === active, '#ffffff');
        });
        this.cornerMid.visible = true;
        place(this.cornerMid, mid, active === all, '#7fe3ff');
        // The outline, closed for a quad or plane; a line runs on past its
        // ends; a spline's points are joined in order (back to the first if it loops).
        const segs = [];
        if (target.path) {
            for (let i = 0; i < C.length - 1; i++) segs.push([C[i], C[i + 1]]);
            if (target.closed && C.length > 2) segs.push([C[C.length - 1], C[0]]);
        } else if (C.length === 2) {
            const d = C[1].clone().sub(C[0]);
            segs.push([C[0].clone().addScaledVector(d, -0.5), C[1].clone().addScaledVector(d, 0.5)]);
        } else {
            C.forEach((c, i) => segs.push([c, C[(i + 1) % C.length]]));
        }
        let attr = G.geometry.getAttribute('position');
        if (attr.count < segs.length * 2) {
            attr = new THREE.BufferAttribute(new Float32Array(Math.ceil(segs.length * 1.5) * 2 * 3), 3);
            G.geometry.setAttribute('position', attr);
        }
        segs.forEach(([a, b], i) => {
            attr.setXYZ(i * 2, a.x, a.y, a.z);
            attr.setXYZ(i * 2 + 1, b.x, b.y, b.z);
        });
        G.geometry.setDrawRange(0, segs.length * 2);
        attr.needsUpdate = true;
        if (!this.dragging) {
            if (this.cornerProxy.parent !== target.space) target.space.add(this.cornerProxy);
            this.cornerProxy.position.copy(active !== all && active < C.length ? C[active] : mid);
            this.cornerProxy.rotation.set(0, 0, 0);
            this.cornerProxy.scale.set(1, 1, 1);
            this.cornerProxy.updateMatrixWorld(true);
        }
    }

    /**
     * A pulse plane (three points) or line (two) for the scan points of
     * `sceneId`, set from the camera as it is now, in the points' own frame.
     */
    pulsePreset(sceneId, kind, which) {
        const S = this.scenes.get(sceneId);
        const sp = S?.rig?.overlay;
        const cam = this.activeCamera;
        if (!sp || !cam || !S.rig.sphere) return null;
        sp.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(sp.matrixWorld).invert();
        const q = cam.getWorldQuaternion(new THREE.Quaternion());
        const toLocal = (v) => v.clone().applyQuaternion(q).transformDirection(inv);
        const f = {
            up: new THREE.Vector3(0, 1, 0).transformDirection(inv),
            right: toLocal(new THREE.Vector3(1, 0, 0)),
            camUp: toLocal(new THREE.Vector3(0, 1, 0)),
            toward: toLocal(new THREE.Vector3(0, 0, 1)),
            c: S.rig.sphere.center.clone(),
            r: S.rig.sphere.radius * 0.5,
        };
        const r4 = (v) => Math.round(v * 1e4) / 1e4;
        const pts = (...vs) => vs.map((v) => v.toArray().map(r4));
        const at = (d, k) => f.c.clone().addScaledVector(d, k * f.r);
        const presets = {
            plane: {
                flat: () => pts(f.c, at(f.right, 1), at(f.up.clone().cross(f.right).normalize(), 1)),
                facing: () => pts(f.c, at(f.right, 1), at(f.camUp, 1)),
                upright: () => pts(f.c, at(f.toward, 1), at(f.up, 1)),
            },
            line: {
                upright: () => pts(at(f.up, -1), at(f.up, 1)),
                across: () => pts(at(f.right, -1), at(f.right, 1)),
                into: () => pts(at(f.toward, 1), at(f.toward, -1)),
            },
        };
        return presets[kind]?.[which]?.() || null;
    }

    /** A new window's corners: square to the camera, as far off as the scan, a third of the frame across. */
    windowCorners(sceneId) {
        const S = this.scenes.get(sceneId);
        const cam = this.activeCamera;
        if (!S || !cam) return null;
        S.root.updateMatrixWorld(true);
        const c = S.rig?.sphere ? S.root.localToWorld(S.rig.sphere.center.clone()) : new THREE.Vector3();
        const dist = Math.max(0.3, c.distanceTo(cam.getWorldPosition(new THREE.Vector3())));
        const span = cam.isOrthographicCamera
            ? (cam.top - cam.bottom) / (cam.zoom || 1) / dist
            : 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) / 2);
        return cornersFacing(cam, S.root, dist, dist * span * 0.35);
    }

    /** Point the free camera at what the active scene holds. */
    frameActive() {
        const s = this.scenes.get(this.activeSceneId);
        const sphere = s?.rig?.sphere;
        if (!sphere) return;
        this.framed = true;
        this.viewScene = this.activeSceneId;
        const c = s.root.localToWorld(sphere.center.clone());
        this.controls.target.copy(c);
        this.freeCamera.position.set(c.x, c.y + sphere.radius * 0.6, c.z + sphere.radius * 2.6);
        this.flySpeed = Math.max(0.2, sphere.radius);
        this.controls.update();
    }

    /** WASD / space / shift fly for the free camera. */
    fly(dt) {
        // A key the OS has been auto-repeating that has said nothing for a
        // second is no longer held, whatever happened to its keyup. Keys that
        // never repeat (repeat turned off, or a Mac's press-and-hold accent
        // menu, or Shift) rely on their keyup and the resets above.
        const now = performance.now();
        Object.keys(this.keys).forEach((code) => {
            const k = this.keys[code];
            if (k.repeating && now - k.at > 1000) delete this.keys[code];
        });
        const k = this.keys;
        if (this.mode === 'preview' || !(k.KeyW || k.KeyS || k.KeyA || k.KeyD || k.KeyQ || k.KeyE)) return;
        const cam = this.freeCamera;
        const fwd = cam.getWorldDirection(new THREE.Vector3());
        const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
        const move = new THREE.Vector3();
        if (k.KeyW) move.add(fwd);
        if (k.KeyS) move.sub(fwd);
        if (k.KeyD) move.add(right);
        if (k.KeyA) move.sub(right);
        if (k.KeyE) move.y += 1;
        if (k.KeyQ) move.y -= 1;
        if (!move.lengthSq()) return;
        const fast = k.ShiftLeft || k.ShiftRight ? 3 : 1;
        move.normalize().multiplyScalar(this.flySpeed * fast * dt);
        cam.position.add(move);
        this.controls.target.add(move);
        this.dirty = true;
    }

    // ---- Export --------------------------------------------------------------------------

    /** Draw at a fixed size, as the program, with no editing furniture. */
    beginExport(w, h, ss) {
        this.exporting = true;
        this.saved = {
            mode: this.mode,
            size: this.renderer.getSize(new THREE.Vector2()),
            ratio: this.renderer.getPixelRatio(),
        };
        this.mode = 'preview';
        this.ss = ss;
        this.recording = null;
        this.gizmo.detach();
        this.gizmo.visible = false;
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(w, h, false);
        this.scenes.forEach((s) => s.adapters.forEach((a) => a.reset?.()));
        // Tracking starts from nothing, so an export's boxes are its own.
        this.blobFx.forEach((b) => b.reset());
    }

    endExport() {
        const s = this.saved;
        this.exporting = false;
        this.ss = 1;
        if (!s) return;
        this.mode = s.mode;
        this.renderer.setPixelRatio(s.ratio);
        this.renderer.setSize(s.size.x, s.size.y, true);

        this.saved = null;
        this.blobFx.forEach((b) => b.reset());
        this.fit();
        this.dirty = true;
    }

    // ---- Camera paths ----------------------------------------------------------------------

    /** Start capturing the free camera into a camera object's path. */
    startRecording(objectId) { this.recording = { id: objectId, samples: [] }; }

    /** Stop capturing; returns { id, samples } or null. */
    stopRecording() {
        const r = this.recording;
        this.recording = null;
        return r && r.samples.length ? r : null;
    }

    // ---- Drawing -------------------------------------------------------------------------

    /**
     * Draw the program at timeline time `t`. `opts.playing` says whether the
     * transport is running (video elements play rather than seek), `opts.dt`
     * the seconds since the last frame, `opts.exportFrame` supplies decoded
     * pictures by media id during an export.
     */
    renderAt(t, opts = {}) {
        const P = this.project;
        if (!this.renderer || !P) return;
        const dt = opts.dt ?? 0;
        const exporting = !!opts.exporting;
        // Flying runs on the wall clock: the timeline's step is zero while
        // it is paused, which is when you most want to look around.
        const now = performance.now();
        const flyDt = Math.min(0.1, (now - (this.lastDrawAt || now)) / 1000);
        this.lastDrawAt = now;
        if (this.roto?.on && this.mode !== 'preview') this.setMode('preview');
        if (!exporting) this.fly(flyDt);
        // Self-healing: a gizmo detached mid-drag (its object went with a
        // scene change) never says the drag ended, which would leave the
        // camera controls off for good.
        if (this.dragging && !this.gizmo.dragging) this.dragging = false;
        this.controls.enabled = this.mode !== 'preview' && !this.dragging && !this.roto?.on;
        if (this.mode !== 'preview') this.controls.update();

        const frame = makeFrame(P, t, this.analysis);
        this.lastFrame = frame;
        this.drawNo++;
        const program = programAt(P, t, (tr) => resolveTrack(tr, frame).visible !== false);
        const base = program.base;

        // Which scene is on: the base clip's, or (between clips, while
        // editing) whatever the selection belongs to.
        let sceneId = null;
        if (base) {
            sceneId = base.media.kind === 'stage'
                ? base.media.sceneId
                : P.scenes.find((s) => s.take === base.media.src?.take)?.id;
        }
        if (!sceneId && this.mode !== 'preview') {
            const sel = P.objects.find((o) => o.id === this.selectedId);
            sceneId = sel?.sceneId || this.activeSceneId;
        }
        if (sceneId !== this.activeSceneId) {
            // The scene left keeps its view; the one come to gets its own back.
            this.rememberView(this.activeSceneId);
            this.activeSceneId = sceneId;
        }
        // (Again each frame until it takes: a scene whose scan is still loading can't be framed yet.)
        this.viewActive();
        // While editing, the view is kept as it moves too (a second apart at most), so a reload comes back to it.
        if (this.mode !== 'preview' && sceneId && this.viewScene === sceneId) {
            const v = this.currentView();
            const key = `${v.p.join(',')}|${v.t.join(',')}|${v.fov}`;
            if (key !== this.viewKept.key && v.at - this.viewKept.at > 1000) {
                this.viewKept = { key, at: v.at };
                this.rememberView(sceneId);
            }
        }
        this.scenes.forEach((s, id) => { s.root.visible = id === sceneId; });
        const S = this.scenes.get(sceneId);
        const objects = S ? P.objects.filter((o) => o.sceneId === sceneId) : [];
        const resolved = new Map(objects.map((o) => [o.id, resolveObject(o, frame)]));
        const ofType = (type) => {
            const o = objects.find((x) => x.type === type);
            return o ? resolved.get(o.id) : null;
        };
        const takeP = ofType('take');
        const footageP = ofType('footage');
        const sunP = ofType('sun');

        // Source time in the base clip.
        const src = base ? clipSourceTime(base.clip, base.media, t) : null;
        const takeTime = src ? src.time : null;

        // ---- Camera
        const rig = S?.rig;
        const drawSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        const aspect = drawSize.x / Math.max(1, drawSize.y);
        let cam;
        if (this.mode !== 'preview') {
            cam = this.freeCamera;
            cam.aspect = aspect;
            cam.updateProjectionMatrix();
        } else {
            // The clip's camera, or, when it follows a Switch, the camera
            // the Switch's state now picks.
            let camId = base?.clip.camera;
            const sw = base?.clip.cameraSwitch;
            const swCtrl = sw && P.controllers.find((c) => c.id === sw.controller && isSwitch(c));
            if (swCtrl) camId = sw.map?.[switchStateAt(swCtrl, t, frame.controller)] ?? camId;
            const camObj = camId && camId !== 'solve'
                ? objects.find((o) => o.id === camId && o.type === 'camera')
                : (base?.media.kind === 'stage' ? objects.find((o) => o.type === 'camera') : null);
            if (camObj) {
                const pose = cameraPoseAt(camObj, resolveObject(camObj, frame), t);
                cam = pose.ortho ? this.orthoCamera : this.objectCamera;
                cam.position.copy(pose.pos);
                cam.quaternion.copy(pose.quat);
                if (pose.ortho) {
                    setOrtho(cam, pose.height, aspect, 0.01, 1000);
                } else {
                    cam.fov = pose.fov;
                    cam.aspect = aspect;
                    cam.updateProjectionMatrix();
                }
            } else if (rig?.track && !rig.track.unsolved && takeTime != null) {
                cam = this.trackedCamera;
                const pose = poseAt(takeTime, rig.track);
                if (pose) { cam.position.copy(pose.pos); cam.quaternion.copy(pose.quat); }
                applyIntrinsics(cam, rig.track.intrinsics, aspect);
            } else {
                cam = this.freeCamera;
                cam.aspect = aspect;
                cam.updateProjectionMatrix();
            }
        }
        cam.updateMatrixWorld(true);
        this.activeCamera = cam;
        this.gizmo.camera = cam;

        // Recording a path: the free camera, sampled on the timeline.
        if (this.recording && opts.playing && this.mode !== 'preview') {
            this.recording.samples.push({
                t: Math.round(t * 1000) / 1000,
                p: this.freeCamera.position.toArray().map((v) => Math.round(v * 1e4) / 1e4),
                q: this.freeCamera.quaternion.toArray().map((v) => Math.round(v * 1e5) / 1e5),
                fov: this.freeCamera.fov,
            });
        }

        // ---- Scene contents
        const music = this.analysis.music;
        const freq = this.analysis.spectrumAt?.(t) || null;
        // The audio reaction's scatter follows the timeline's frame, so a
        // paused frame holds still (and what is tracked in it does too).
        setReactSeed(Math.floor(t * (P.output?.fps || 30) + 1e-6));
        const live = !!freq;
        const behind = { points: false, mesh: false, wire: false };
        if (rig) {
            const pts = ofType('scanPoints');
            const mesh = ofType('scanMesh');
            const wire = ofType('scanWire');
            rig.apply({ take: takeP, points: pts, mesh, wire }, drawSize, this.ss);
            rig.applyLook(this.looks?.()[S.take]);
            rig.react(pts, wire, freq, live);
            behind.points = pts?.depthLayer === 'behind';
            behind.mesh = mesh?.depthLayer === 'behind';
            behind.wire = wire?.depthLayer === 'behind';
        }
        const f = {
            // What expressions read now: variables and splines.
            globals: globalsOf(frame, P),
            // What links read at other times (a spline's spin adds its rates up from 0 s).
            frame,
            // A spline whose points are being dragged holds its spin still, so they go where they're pulled.
            holdSpin: this.dragging && this.cornerTargetNow?.kind === 'spline' ? this.cornerTargetNow.obj.id : null,
            music, time: t, take: takeTime, freq, live, drawSize, renderer: this.renderer, scene: this.scene, camera: cam,
            exporting, playing: !!opts.playing, envReady: !!rig?.envMesh,
            // A window shows at its drawn size while one of its corners is dragged.
            holdWindow: this.dragging && this.cornerTargetNow?.kind === 'window' ? S?.adapters.get(this.cornerTargetNow.obj.id) : null,
        };
        if (S) {
            // Parents first, so their children are placed from where they are now.
            const order = objects.some((o) => o.parentId) ? [...objects.filter((o) => !o.parentId), ...objects.filter((o) => o.parentId)] : objects;
            // Which of each spline's points are objects of their own (and draw their own markers).
            const owners = new Map();
            objects.forEach((o) => {
                if (o.type !== 'splinePoint' || !o.pointLabel) return;
                if (!owners.has(o.parentId)) owners.set(o.parentId, new Set());
                owners.get(o.parentId).add(o.pointLabel.index);
            });
            order.forEach((o) => {
                const a = S.adapters.get(o.id);
                if (!a) return;
                if (o.type === 'spline') a.knotOwners = owners.get(o.id) || null;
                if (o.type === 'splinePoint') a.look = resolved.get(o.parentId) || {};
                this.attach(o, a, S, resolved, f);
                a.sync(o, resolved.get(o.id), f);
                a.update(dt, f);
            });
        }
        this.placeSun(S, sunP);
        this.syncHelpers(objects, resolved, S, takeTime);
        this.syncCorners(this.cornerTarget(objects, S), cam);
        this.syncGizmo();

        // ---- Layers: behind or in front of the footage
        let behindCount = rig ? rig.assignLayers(behind) : 0;
        if (S) {
            S.adapters.forEach((a, id) => {
                // Windows keep the camera layers their passes draw them on.
                if (a.model?.cutMesh) return;
                const p = resolved.get(id);
                const back = p?.depthLayer === 'behind';
                const mask = 1 << (back ? LAYER.BEHIND : LAYER.FRONT);
                const walk = (o) => {
                    // A child object's nodes are its own to set.
                    if (o !== a.object && o.userData.objectId && o.userData.objectId !== id) return;
                    if (o.userData.handle) o.layers.set(LAYER.OVERLAY);
                    else if (o.layers.mask !== mask && o.layers.mask !== (1 << LAYER.WIN_CUT) && o.layers.mask !== (1 << LAYER.WIN_FX)) o.layers.mask = mask;
                    o.children.forEach(walk);
                };
                walk(a.object);
                if (back && a.object.visible) behindCount++;
            });
        }

        // ---- Footage
        const showFootage = this.mode === 'preview' && base?.media.kind === 'take' && (footageP?.visible !== false || !!this.roto?.on);
        // With footage hidden, mattes can still put the real object in front:
        // the footage is then followed but only ever drawn inside a matte.
        const matteOnly = !showFootage && this.mode === 'preview' && base?.media.kind === 'take'
            && !!takeP?.mattesOverHidden && takeP?.mattesOn !== false;
        let footageTex = null;
        if (showFootage || matteOnly) {
            footageTex = opts.exportFrame ? opts.exportFrame(base.media.id) : this.pool.follow(base.clip, base.media, t, { playing: !!opts.playing });
        }
        this.bgQuad.visible = !!footageTex && showFootage;
        if (footageTex) {
            if (this.bgQuad.material.map !== footageTex) { this.bgQuad.material.map = footageTex; this.bgQuad.material.needsUpdate = true; }
            this.bgQuad.material.opacity = showFootage ? (footageP?.opacity ?? 1) : 1;
            this.coverQuad(this.bgQuad, rig?.track?.intrinsics, aspect);
        }

        // Plain video layers over the base (preview only).
        const layers = [];
        if (this.mode === 'preview') {
            program.overlays.forEach((ov) => {
                const tex = opts.exportFrame ? opts.exportFrame(ov.media.id) : this.pool.follow(ov.clip, ov.media, t, { playing: !!opts.playing });
                if (!tex) return;
                const tr = resolveTrack(ov.track, frame);
                layers.push({ tex, opacity: tr.opacity ?? 1, media: ov.media, trackId: ov.track.id });
            });
        }
        if (!exporting) {
            const keep = new Set();
            if (showFootage || matteOnly) keep.add(base.media.id);
            program.overlays.forEach((o) => keep.add(o.media.id));
            this.pool.park(keep);
        }

        // Rotoscoping on plain footage: the frame and nothing over it.
        if (this.roto?.on && this.roto.plain) {
            const r0 = this.renderer;
            r0.setRenderTarget(null);
            r0.setClearColor(0x000000, 1);
            r0.clear();
            if (footageTex) {
                this.bgQuad.scale.set(1, 1, 1);
                this.bgQuad.material.opacity = 1;
                r0.render(this.bgScene, this.bgCamera);
            }
            this.lastTime = t;
            return;
        }

        // Mattes on the take's frame.
        const mattesOn = (showFootage || (matteOnly && !!footageTex)) && takeP?.mattesOn !== false && rig?.track && !rig.track.unsolved;
        let holdTex = [];
        if (S?.take) {
            this.mattes.set(S.take, mattesFor(S.take));
            if (mattesOn) {
                const holdMap = objects.find((o) => o.type === 'take')?.extra?.matteHoldout || {};
                const ids = Array.from(this.mattes.tracks.keys());
                const idx = Math.max(0, Math.min(rig.track.frame_count - 1, Math.floor(takeTime * rig.track.fps + 1e-3)));
                const winMattes = [];
                S.adapters.forEach((a) => { if (a.model?.op?.matte) winMattes.push(a.model.op.matte); });
                this.blobActive.forEach(({ p }) => { if (p.spawnWindows && p.matte) winMattes.push(p.matte); });
                const all = Array.from(new Set([...ids.filter((id) => holdMap[id] !== false), ...winMattes]));
                if (!opts.exportFrame) this.mattes.follow(all, idx, src?.dir < 0);
                this.matteFrame = { all, idx, back: src?.dir < 0 };
                holdTex = ids.filter((id) => holdMap[id] !== false).map((id) => this.mattes.texture(id)).filter(Boolean);
            }
        }

        this.compose({
            cam, behindCount, footage: this.bgQuad.visible, matteFootage: matteOnly && !!footageTex, holdTex, layers, S, frame, sortNow: exporting, objects,
            baseTrack: base?.track?.id || null,
        });
        this.lastTime = t;
        this.dirty = false;
    }

    /** Scale the footage quad to cover an output of `aspect`, as the solve's frustum is. */
    coverQuad(quad, intr, aspect) {
        const src = intr ? intr.width / intr.height : aspect;
        const sx = aspect > src ? 1 : src / aspect;
        const sy = aspect > src ? aspect / src : 1;
        quad.scale.set(sx, sy, 1);
    }

    placeSun(S, p) {
        const sun = p || { azimuth: 45, elevation: 47, intensity: 1.1, color: '#ffffff', ambient: 0.55, shadows: false, shadowOpacity: 0.4, shadowSoftness: 0.5 };
        const az = sun.azimuth * D2R;
        const el = sun.elevation * D2R;
        const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        if (S) dir.applyQuaternion(S.root.getWorldQuaternion(new THREE.Quaternion())).normalize();
        this.sun.color.set(sun.color);
        this.sun.intensity = sun.intensity;
        this.ambient.intensity = sun.ambient;
        this.fill.intensity = sun.ambient * 0.64;
        const box = new THREE.Box3();
        S?.adapters.forEach((a) => {
            if (!a.object.visible || !(a.model?.op?.castShadow ?? false)) return;
            // A curve rewrites its geometry every frame, so it says where it is itself.
            const own = a.shadowBox ? a.shadowBox() : undefined;
            if (own) box.union(own);
            else if (own === undefined) box.expandByObject(a.object);
        });
        const casting = !!sun.shadows && !box.isEmpty();
        this.sun.castShadow = casting;
        if (S?.rig?.catcher) {
            S.rig.catcher.visible = casting;
            S.rig.catcher.material.opacity = sun.shadowOpacity;
        }
        const center = box.isEmpty() ? (S?.rig?.sphere ? S.root.localToWorld(S.rig.sphere.center.clone()) : new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
        this.sun.target.position.copy(center);
        this.sun.target.updateMatrixWorld();
        this.sun.position.copy(center).addScaledVector(dir, 20);
        this.sun.updateMatrixWorld();
        this.sunHelper.position.copy(center).addScaledVector(dir, 0.8);
        this.sunHelper.setDirection(dir.clone().negate());
        if (casting) {
            // The shadow map covers exactly what casts, as the sun sees it: a
            // shadow falls straight behind its caster along the light, so
            // that is all it needs, and every texel goes on the casters (a
            // bounding sphere would waste most of them, and thin curves and
            // small points vanish once a texel is wider than they are).
            const c = this.sun.shadow.camera;
            c.position.copy(this.sun.position);
            c.lookAt(this.sun.target.position);
            c.updateMatrixWorld(true);
            const view = c.matrixWorldInverse;
            const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
            const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
            const v = new THREE.Vector3();
            for (let i = 0; i < 8; i++) {
                v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view);
                lo.min(v);
                hi.max(v);
            }
            const pad = Math.max(0.02, 0.04 * Math.max(hi.x - lo.x, hi.y - lo.y));
            Object.assign(c, {
                left: lo.x - pad,
                right: hi.x + pad,
                bottom: lo.y - pad,
                top: hi.y + pad,
                // From just before the nearest caster to well past the farthest, where its shadow lands.
                near: Math.max(0.01, -hi.z - 1),
                far: -lo.z + 40,
            });
            c.updateProjectionMatrix();
            // Softness is a size in the scene (cm: hundredths of a scene unit),
            // the same however much the map covers. Three's filter blurs over
            // `radius` texels with 17 samples; past a few texels they show as
            // separate copies, so a soft shadow gets a coarser map (and a
            // radius of a couple of texels) rather than a wide one.
            const sh = this.sun.shadow;
            const extent = Math.max(c.right - c.left, c.top - c.bottom);
            const unit = S ? S.root.getWorldScale(new THREE.Vector3()).x : 1;
            const soft = Math.max(0, sun.shadowSoftness ?? 0.5) * 0.01 * unit;
            let size = this.maxShadowSize;
            if (soft > 0) while (size > 512 && soft / (extent / size) > 2.5) size /= 2;
            if (sh.mapSize.x !== size) {
                sh.mapSize.set(size, size);
                sh.map?.dispose();
                sh.map = null;
            }
            sh.radius = soft / (extent / size);
        }
    }

    /** A camera and a frustum drawn for it, in one colour, on the overlay. */
    makeFrustum(color, ortho = false) {
        const cam = ortho ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 0.4) : new THREE.PerspectiveCamera(50, this.outputAspect, 0.05, 0.4);
        this.scene.add(cam);
        const h = new THREE.CameraHelper(cam);
        const c = new THREE.Color(color);
        h.setColors(c, c, c, c, c);
        h.userData.cam = cam;
        h.layers.set(LAYER.OVERLAY);
        h.material.depthTest = false;
        h.material.transparent = true;
        h.renderOrder = 999;
        h.userData.ortho = ortho;
        this.helpers.add(h);
        return h;
    }

    /** Point a frustum's camera; its length follows the scene's size so it reads at any scale. */
    placeFrustum(h, pos, quat, fov, reach, orthoHeight = null) {
        const c = h.userData.cam;
        c.position.copy(pos);
        c.quaternion.copy(quat);
        if (c.isOrthographicCamera) {
            // An orthographic one shows its true width, its length the scene's.
            setOrtho(c, orthoHeight || 1, this.outputAspect, reach * 0.04, reach);
        } else {
            c.fov = fov;
            c.aspect = this.outputAspect;
            c.near = reach * 0.04;
            c.far = reach;
            c.updateProjectionMatrix();
        }
        c.updateMatrixWorld(true);
        h.update();
    }

    /**
     * Edit mode's furniture: the grid, every camera object's frustum (orange)
     * and the take's solved camera where it is now (cyan).
     */
    syncHelpers(objects, resolved, S, takeTime = null) {
        const edit = this.mode === 'edit' && !this.exporting;
        this.helpers.visible = edit;
        const sphere = S?.rig?.sphere;
        const reach = sphere ? Math.max(0.15, sphere.radius * 0.35) : 0.4;
        if (sphere) {
            const c = S.root.localToWorld(sphere.center.clone());
            this.grid.position.set(c.x, c.y - sphere.radius * 0.6, c.z);
        }
        const cams = objects.filter((o) => o.type === 'camera');
        const ids = new Set(cams.map((c) => c.id));
        this.cameraHelpers.forEach((h, id) => {
            if (ids.has(id)) return;
            h.removeFromParent();
            h.userData.cam.removeFromParent();
            this.cameraHelpers.delete(id);
        });
        cams.forEach((o) => {
            const pose = cameraPoseAt(o, resolved.get(o.id), takeTime ?? this.lastTime);
            let h = this.cameraHelpers.get(o.id);
            if (h && h.userData.ortho !== pose.ortho) {
                h.removeFromParent();
                h.userData.cam.removeFromParent();
                h = null;
            }
            if (!h) {
                h = this.makeFrustum('#ffb347', pose.ortho);
                h.traverse((x) => x.layers.set(LAYER.OVERLAY));
                this.cameraHelpers.set(o.id, h);
            }
            this.placeFrustum(h, pose.pos, pose.quat, pose.fov, reach, pose.height);
        });
        // The solve: where the real camera was at this moment of the take.
        if (!this.solveHelper) this.solveHelper = this.makeFrustum('#6fd3ff');
        const track = S?.rig?.track;
        const pose = track && !track.unsolved && takeTime != null ? poseAt(takeTime, track) : null;
        this.solveHelper.visible = !!pose;
        if (pose) {
            const fov = THREE.MathUtils.radToDeg(2 * Math.atan(track.intrinsics.height / (2 * track.intrinsics.fy)));
            this.placeFrustum(this.solveHelper, pose.pos, pose.quat, fov, reach);
        }
    }

    /**
     * The 3D-objects glow's source: everything in the scene in front of the
     * footage, over black. The footage and video layers are drawn apart from
     * the scene, so they are not in it; text laid over the frame is set aside.
     */
    drawSceneSource(r, cam) {
        const flat = [];
        this.scene.traverseVisible((o) => { if (o.userData.frame2D) flat.push(o); });
        flat.forEach((o) => { o.visible = false; });
        cam.layers.set(LAYER.FRONT);
        r.render(this.scene, cam);
        flat.forEach((o) => { o.visible = true; });
        this.holdOutSource();
    }

    /** A held-out (matted) object stands in front of everything drawn: nothing behind it glows through it or lights it. */
    holdOutSource() {
        if (!this.pointHold) return;
        if (!this.blackTex) {
            this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
            this.blackTex.needsUpdate = true;
        }
        this.holdout.apply(this.blackTex);
    }

    /** The points-only glow's source: points in front of the footage, solids still writing depth. */
    drawPointSource(r, cam) {
        const points = [];
        const solids = [];
        const lines = [];
        this.scene.traverseVisible((o) => {
            if (o.isPoints || o.isInstancedMesh) points.push(o);
            else if (o.isLineSegments2 || o.isLine) lines.push(o);
            else if (o.isMesh) solids.push(o);
        });
        const mats = [];
        solids.forEach((o) => (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
            if (m && m.colorWrite) { m.colorWrite = false; mats.push(m); }
        }));
        points.forEach((o) => { o.visible = false; });
        lines.forEach((o) => { o.visible = false; });
        cam.layers.set(LAYER.FRONT);
        r.render(this.scene, cam);
        mats.forEach((m) => { m.colorWrite = true; });
        solids.forEach((o) => { o.visible = false; });
        points.forEach((o) => { o.visible = true; });
        r.render(this.scene, cam);
        solids.forEach((o) => { o.visible = true; });
        lines.forEach((o) => { o.visible = true; });
        this.holdOutSource();
    }

    /**
     * The scan's depth from `cam`, into a depth texture the size of the
     * drawing buffer, whether or not the mesh is shown. Null without a scan.
     */
    renderScanDepth(S, cam, size) {
        const rig = S?.rig;
        if (!rig?.mesh) return null;
        if (!this.scanDepthRT || this.scanDepthRT.width !== size.x || this.scanDepthRT.height !== size.y) {
            this.scanDepthRT?.dispose();
            this.scanDepthRT = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: true });
            this.scanDepthRT.depthTexture = new THREE.DepthTexture(size.x, size.y);
        }
        if (!this.depthScene) {
            this.depthScene = new THREE.Scene();
            this.depthMesh = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
            this.depthMesh.matrixAutoUpdate = false;
            this.depthMesh.frustumCulled = false;
            this.depthScene.add(this.depthMesh);
        }
        this.depthMesh.geometry = rig.mesh.geometry;
        S.root.updateMatrixWorld(true);
        this.depthMesh.matrix.copy(S.root.matrixWorld);
        this.depthMesh.matrixWorld.copy(S.root.matrixWorld);
        const r = this.renderer;
        const prev = r.getRenderTarget();
        cam.layers.set(LAYER.FRONT);
        r.setRenderTarget(this.scanDepthRT);
        r.setClearColor(0x000000, 1);
        r.clear(true, true, false);
        r.render(this.depthScene, cam);
        r.setRenderTarget(prev);
        return this.scanDepthRT.depthTexture;
    }

    /** The footage alone, full frame, into its own target: what a matte shows over hidden footage. */
    footageOnly(size) {
        if (!this.footRT) this.footRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        if (this.footRT.width !== size.x || this.footRT.height !== size.y) this.footRT.setSize(size.x, size.y);
        const r = this.renderer;
        r.setRenderTarget(this.footRT);
        r.setClearColor(0x000000, 1);
        r.clear();
        this.bgQuad.visible = true;
        r.render(this.bgScene, this.bgCamera);
        this.bgQuad.visible = false;
        return this.footRT.texture;
    }

    /** The runner for a quad tree effect or window, made on first use. */
    qtRunner(id) {
        let q = this.qtFx.get(id);
        if (!q) { q = new QuadTreeFx(this.renderer); this.qtFx.set(id, q); }
        return q;
    }

    /** Scale a full-frame quad `q` to cover the drawing buffer with layer `L`'s picture. */
    layerScale(L, q, bufSize) {
        const img = L.tex.image;
        const w = img?.videoWidth || img?.displayWidth || L.media.width || 16;
        const h = img?.videoHeight || img?.displayHeight || L.media.height || 9;
        const src = w / h;
        const a = bufSize.x / Math.max(1, bufSize.y);
        q.scale.set(a > src ? 1 : src / a, a > src ? a / src : 1, 1);
    }

    /** Draw video layer `L` alone, framed as the program draws it, into the bound target. */
    drawLayerAlone(L, bufSize) {
        if (!this.soloLayer) {
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }));
            const scene = new THREE.Scene();
            scene.add(quad);
            this.soloLayer = { quad, scene };
        }
        const { quad, scene } = this.soloLayer;
        if (quad.material.map !== L.tex) { quad.material.map = L.tex; quad.material.needsUpdate = true; }
        this.layerScale(L, quad, bufSize);
        this.renderer.render(scene, this.bgCamera);
    }

    /** The runner for a Blob Tracker effect, made on first use. */
    blobRunner(id) {
        let b = this.blobFx.get(id);
        if (!b) {
            b = new BlobFx(this.renderer, this.windows, id);
            this.blobFx.set(id, b);
        }
        return b;
    }

    /**
     * A Blob Tracker at its place in the effects, on `rt` (the picture the
     * effects before it left): it looks at that picture, before anything of
     * its own is on it, then puts its windows over the boxes and draws its
     * boxes and labels, in place. Effects after it see all of that.
     */
    runBlobs(obj, p, rt, t) {
        const bf = this.blobRunner(obj.id);
        const o = this.project.output || {};
        const outW = o.width || 1440;
        const cam = this.composeCam;
        bf.begin(this.drawNo);
        bf.captureTexture(rt.texture, rt.width, rt.height, this.exporting);
        bf.step(p, t);
        bf.placeWindows(cam, p, outW, { music: this.analysis.music, time: t, take: null });
        this.blobWindowsOver(bf, rt, cam, t);
        bf.drawOver(rt, p, outW, o.height || 1080);
    }

    /**
     * Draw a Blob Tracker's windows over `rt` with the window passes the
     * placed windows use: each window's cut, then its hue shift, pixel sort
     * and quad tree, read from `rt` as it is and held to the window's shape
     * (feather, matte, the scan in front).
     */
    blobWindowsOver(bf, rt, cam, t) {
        const r = this.renderer;
        const comp = this.windows;
        const ctx = this.winCtx || {};
        const wins = bf.windows.filter((w) => w.open).map((w) => w.model);
        bf.windows.forEach((w) => {
            if (w.open) return;
            w.model.cutMesh.visible = false;
            w.model.fxMesh.visible = false;
        });
        if (!wins.length) return;
        wins.forEach((w) => {
            w.setScanDepth(ctx.scanDepth || null);
            w.setMatte(ctx.matteOn && w.op.matte ? this.mattes.texture(w.op.matte) : null, comp.size, ctx.crop);
        });
        const cutWins = wins.filter((w) => w.op.cut);
        if (cutWins.length) {
            r.setRenderTarget(rt);
            wins.forEach((w) => { w.cutMesh.visible = cutWins.includes(w); comp.prepareCut(w); });
            cam.layers.set(LAYER.WIN_CUT);
            r.render(bf.scene, cam);
        }
        const qtOn = (w) => w.op.qt_on && (this.exporting || w.op.qt_preview !== false);
        wins.forEach((w) => { if (!qtOn(w)) w.qt = null; });
        const fxWins = wins.filter((w) => w.op.hueOn || w.op.sortOn || qtOn(w));
        if (fxWins.length) {
            r.setRenderTarget(comp.compRT);
            comp.blit(rt.texture);
            fxWins.filter((w) => w.op.sortOn).forEach((w) => comp.sortWindow(w, cam, this.exporting));
            fxWins.filter(qtOn).forEach((w) => this.windowQuadTree(w, cam, t));
            r.setRenderTarget(rt);
            wins.forEach((w) => { w.fxMesh.visible = fxWins.includes(w); comp.prepareFx(w, 'all'); });
            cam.layers.set(LAYER.WIN_FX);
            r.render(bf.scene, cam);
        }
        cam.layers.set(LAYER.FRONT);
    }

    /** The runner for a pixel sort effect, made on first use. */
    sortRunner(id) {
        let s = this.sortFx.get(id);
        if (!s) { s = new SortFx(this.renderer, this.windows); this.sortFx.set(id, s); }
        return s;
    }

    /**
     * Run the picture effects `list` (quad trees and pixel sorts, from
     * pictureFx) in order on `src`, a render target; returns the target
     * holding the result (`src` itself when the list is empty). Lengths are
     * in output pixels.
     */
    runPictureFx(list, src, t) {
        const out = this.project.output || {};
        const outW = out.width || 1440;
        const outH = out.height || 1080;
        let cur = src;
        list.forEach(({ obj, p, kind }) => {
            // In place: the picture stays where it is.
            if (kind === 'blobs') { this.runBlobs(obj, p, cur, t); return; }
            cur = kind === 'qt'
                ? this.qtRunner(obj.id).run({
                    src: cur, params: { ...p, qt_mix: p.qt_mix ?? 1 }, outW, outH, time: t,
                })
                : this.sortRunner(obj.id).run({
                    src: cur, params: p, outW, now: this.exporting, drawNo: this.drawNo,
                });
        });
        return cur;
    }

    /** Run the picture effects `list` on `rt` and draw the result back into it. */
    applyPictureFx(list, rt, t) {
        if (!list.length) return;
        const res = this.runPictureFx(list, rt, t);
        if (res === rt) return;
        this.renderer.setRenderTarget(rt);
        this.windows.blit(res.texture);
    }

    /**
     * A window's picture, unwarped into its own plane at w x h: what the
     * window would show seen face on. Kept per window between frames.
     */
    unwarpWindow(win, cam, id, w, h) {
        const r = this.renderer;
        if (!this.unwarp) {
            const mat = new THREE.ShaderMaterial({
                uniforms: { tComp: { value: null } },
                vertexShader: UNWARP_VERT,
                fragmentShader: UNWARP_FRAG,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
            mesh.matrixAutoUpdate = false;
            mesh.frustumCulled = false;
            const scene = new THREE.Scene();
            scene.add(mesh);
            this.unwarp = { mesh, mat, scene, targets: new Map() };
        }
        const U = this.unwarp;
        let rt = U.targets.get(id);
        if (!rt) {
            rt = new THREE.WebGLRenderTarget(w, h, {
                type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            });
            U.targets.set(id, rt);
        } else if (rt.width !== w || rt.height !== h) {
            rt.setSize(w, h);
        }
        win.fxMesh.updateMatrixWorld(true);
        U.mesh.geometry = win.fxMesh.geometry;
        U.mesh.matrix.copy(win.fxMesh.matrixWorld);
        U.mesh.matrixWorldNeedsUpdate = true;
        U.mat.uniforms.tComp.value = this.windows.compRT.texture;
        const mask = cam.layers.mask;
        cam.layers.enableAll();
        r.setRenderTarget(rt);
        r.setClearColor(0x000000, 1);
        r.clear();
        r.render(U.scene, cam);
        cam.layers.mask = mask;
        return rt;
    }

    /**
     * A window's quad tree, for its effect pass. On the window plane: the
     * picture is unwarped into the window's own space, subdivided there at
     * the plane resolution, and drawn back through the window's UVs, so the
     * quads lie on the plane in perspective and follow it frame by frame.
     * On the screen: subdivided over the window's box on screen, as drawn.
     */
    windowQuadTree(win, cam, t) {
        const op = win.op;
        const id = win.item?.id || win.object.userData.itemId;
        if (op.qt_space === 'plane') {
            const aspect = Math.max(0.05, Math.min(20, quadAspect(win.corners || op.corners)));
            const res = Math.max(64, Math.min(4096, Math.round(op.qt_planeRes || 768)));
            let h = res;
            let w = Math.round(res * aspect);
            if (w > 4096) { w = 4096; h = Math.round(4096 / aspect); }
            const flat = this.unwarpWindow(win, cam, id, Math.max(2, w), Math.max(2, h));
            const res2 = this.qtRunner(`win:${id}`).run({
                src: flat, params: op, outW: flat.width, outH: flat.height, time: t,
            });
            win.qt = { tex: res2.texture, rect: null, plane: true };
            return;
        }
        const rect = this.windows.screenRect(win, cam);
        if (!rect) { win.qt = null; return; }
        const out = this.project.output || {};
        const k = (out.width || 1440) / Math.max(1, this.windows.size.x);
        const res = this.qtRunner(`win:${id}`).run({
            src: this.windows.compRT, rect, params: win.op, outW: rect.w * k, outH: rect.h * k, time: t,
        });
        win.qt = { tex: res.texture, rect, plane: false };
    }

    compose({
        cam, behindCount, footage, matteFootage, holdTex, layers, S, frame, sortNow, objects, baseTrack,
    }) {
        const r = this.renderer;
        // A take's backdrop, or a stage's. Resolved, so one linked to a controller follows it.
        const takeObj = objects.find((o) => o.type === 'take' || o.type === 'stage');
        const bgColor = (takeObj ? resolveObject(takeObj, frame) : null)?.bgColor || '#000000';
        const fx = this.applyEffects(frame);
        this.glowPasses.forEach(({ point }) => {
            if (!point.enabled) point.drawSource = null;
            else point.drawSource = point.mode === 'scene' ? (rr) => this.drawSceneSource(rr, cam) : (rr) => this.drawPointSource(rr, cam);
        });
        const out = fx ? this.composer.readBuffer : null;
        const drawScene = !!S;
        const bufSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        this.composeCam = cam;
        const wins = [];
        let screens = false;
        S?.adapters.forEach((a) => {
            if (!a.model?.cutMesh) return;
            if (a.open) {
                wins.push(a.model);
                if (a.screen?.showing) screens = true;
            } else {
                // A window that is hidden (or squashed to nothing) draws none
                // of its passes, and forgets its sort: otherwise its meshes keep
                // the visibility they last had and the last sort stays stuck
                // on screen while other windows draw.
                a.model.cutMesh.visible = false;
                if (a.model.fxMesh) a.model.fxMesh.visible = false;
                a.model.dropSort?.();
            }
        });
        const size = this.windows.ensure();
        // Windows and text that hide behind the scan read its depth.
        let wantDepth = wins.some((w) => w.op.hideBehindScan);
        S?.adapters.forEach((a) => { if (a.setScanDepth && a.model?.op?.hideBehindScan) wantDepth = true; });
        if (this.blobActive.some(({ p }) => p.spawnWindows && p.hideBehindScan)) wantDepth = true;
        const scanDepth = wantDepth ? this.renderScanDepth(S, cam, size) : null;
        wins.forEach((w) => w.setScanDepth(scanDepth));
        S?.adapters.forEach((a) => a.setScanDepth?.(scanDepth, size));
        // The footage quad is scaled up to cover the frame; mattes are cropped the same.
        const crop = this.matteCrop || (this.matteCrop = new THREE.Vector2());
        crop.set(1 / Math.max(1e-6, this.bgQuad.scale.x), 1 / Math.max(1e-6, this.bgQuad.scale.y));
        // A window holds to its matte wherever that object is in the picture:
        // over the footage, or over hidden footage when the take's mattes put
        // the real object back in front.
        wins.forEach((w) => w.setMatte((footage || matteFootage) && w.op.matte ? this.mattes.texture(w.op.matte) : null, size, crop));
        // The same for the Blob Trackers' windows, drawn later with the effects.
        this.winCtx = { scanDepth, matteOn: !!(footage || matteFootage), crop };
        const hold = holdTex.length > 0 && drawScene;
        const target = hold ? this.holdout.baseRT : out;
        // Over hidden footage a half-on patch inside a matte would let the
        // scene show through the person; firm it up so only the outline is soft.
        if (hold) this.holdout.build(holdTex, size, crop, matteFootage ? [0.25, 0.45] : null);
        this.pointHold = hold;
        // With a glow on, the matted part of the frame goes back over it afterwards.
        const glowing = this.glowPasses.some((g) => g.point.enabled || g.bloom.enabled);
        this.matteSnap.enabled = hold && !!out && glowing;
        this.matteTop.enabled = this.matteSnap.enabled;
        if (this.matteTop.enabled) {
            this.matteTop.uniforms.tBase.value = this.matteSnap.snap.texture;
            this.matteTop.uniforms.tHold.value = this.holdout.holdRT.texture;
        }
        // The glow's halo and light stay off the held-out objects too, not just its points.
        this.glowPasses.forEach(({ point }) => { point.hold = hold ? this.holdout.holdRT.texture : null; });

        // Windows that work on everything (3D too) wait for the finished
        // frame, after the scene in front is drawn; the rest work on the
        // footage, under it. Without post (editing) there is no finished
        // frame to read, so they all work on the footage.
        const late = (w) => !!out && w.op.fxStage === 'all';
        const earlyWins = wins.filter((w) => !late(w));
        const lateWins = wins.filter(late);

        const bg = this.backdrop || (this.backdrop = new THREE.Color());
        bg.set(bgColor);
        const clearTo = (tg) => { r.setRenderTarget(tg); r.setClearColor(bg, 1); r.clear(); };

        if (!behindCount && !wins.length) {
            clearTo(target);
            if (footage) { r.render(this.bgScene, this.bgCamera); r.clearDepth(); }
            if (!hold && drawScene) {
                cam.layers.set(LAYER.FRONT);
                r.shadowMap.needsUpdate = true;
                r.render(this.scene, cam);
            }
        } else {
            const comp = this.windows;
            const cutWins = footage ? earlyWins.filter((w) => w.op.cut) : [];
            // Hue shift and sort here; quad trees go last, over everything.
            const fxWins = earlyWins.filter((w) => w.op.hueOn || w.op.sortOn);
            clearTo(comp.behindRT);
            if (behindCount) {
                cam.layers.set(LAYER.BEHIND);
                r.shadowMap.needsUpdate = true;
                r.render(this.scene, cam);
            } else {
                comp.resolve();
            }
            clearTo(fxWins.length ? comp.compRT : target);
            comp.blit(comp.behindRT.texture);
            if (footage) r.render(this.bgScene, this.bgCamera);
            if (cutWins.length) {
                wins.forEach((w) => { w.cutMesh.visible = cutWins.includes(w); comp.prepareCut(w); });
                cam.layers.set(LAYER.WIN_CUT);
                r.render(this.scene, cam);
            }
            if (fxWins.length) {
                fxWins.filter((w) => w.op.sortOn).forEach((w) => comp.sortWindow(w, cam, !!sortNow));
                clearTo(target);
                comp.blit(comp.compRT.texture);
                wins.forEach((w) => { w.fxMesh.visible = fxWins.includes(w); comp.prepareFx(w, 'early'); });
                cam.layers.set(LAYER.WIN_FX);
                r.render(this.scene, cam);
            }
            // Windows showing a video: the picture over the window's cut and
            // effects, as part of the window's own composite.
            if (screens) {
                cam.layers.set(LAYER.WIN_SCREEN);
                r.render(this.scene, cam);
            }
            if (!hold && drawScene) {
                r.clearDepth();
                cam.layers.set(LAYER.FRONT);
                r.shadowMap.needsUpdate = true;
                r.render(this.scene, cam);
            }
        }
        if (hold) {
            // Footage hidden: the matte shows the footage, not the shot under it.
            const over = matteFootage ? this.footageOnly(size) : this.holdout.baseRT.texture;
            clearTo(out);
            this.windows.blit(this.holdout.baseRT.texture);
            cam.layers.set(LAYER.FRONT);
            r.shadowMap.needsUpdate = true;
            r.render(this.scene, cam);
            this.holdout.apply(over);
        }

        // Windows on the finished frame (footage, windows, and the meshes,
        // props, points and text in front): the cuts of those that work on
        // everything, which lay what is behind the video over all of it,
        // then their hue shifts and sorts, and every window's quad tree,
        // drawn over it and held to each window's shape. Quad trees are left
        // out of the preview when asked; exports always have them.
        const lateCut = lateWins.filter((w) => w.op.cut);
        if (lateCut.length) {
            const comp = this.windows;
            r.setRenderTarget(out);
            wins.forEach((w) => { w.cutMesh.visible = lateCut.includes(w); comp.prepareCut(w); });
            cam.layers.set(LAYER.WIN_CUT);
            r.render(this.scene, cam);
        }
        const qtWins = out ? wins.filter((w) => w.op.qt_on && (this.exporting || w.op.qt_preview !== false)) : [];
        wins.forEach((w) => { if (!qtWins.includes(w)) w.qt = null; });
        const lateFx = lateWins.filter((w) => w.op.hueOn || w.op.sortOn);
        if (qtWins.length || lateFx.length) {
            const comp = this.windows;
            r.setRenderTarget(comp.compRT);
            comp.blit(out.texture);
            lateFx.filter((w) => w.op.sortOn).forEach((w) => comp.sortWindow(w, cam, !!sortNow));
            qtWins.forEach((w) => this.windowQuadTree(w, cam, frame.t));
            r.setRenderTarget(out);
            wins.forEach((w) => {
                w.fxMesh.visible = qtWins.includes(w) || lateFx.includes(w);
                comp.prepareFx(w, late(w) ? 'all' : 'late');
            });
            cam.layers.set(LAYER.WIN_FX);
            r.render(this.scene, cam);
        }

        // Quad trees and pixel sorts on the base track's picture (a take or
        // stage), before the plain video layers go over it.
        const fxOn = (target) => this.pictureFx.filter((e) => e.target === target);
        if (out && baseTrack) this.applyPictureFx(fxOn(baseTrack), out, frame.t);

        // Plain video layers over the composite, before the effects.
        const layerScale = (L, q) => this.layerScale(L, q, bufSize);
        // A layer with a quad tree or pixel sort on its track: the layer
        // alone, framed as it would be drawn, through those, then drawn as that.
        layers.forEach((L) => {
            const list = out ? fxOn(L.trackId) : [];
            L.qt = null;
            if (!list.length) return;
            if (!this.qtLayerRT) this.qtLayerRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
            if (this.qtLayerRT.width !== bufSize.x || this.qtLayerRT.height !== bufSize.y) this.qtLayerRT.setSize(bufSize.x, bufSize.y);
            r.setRenderTarget(this.qtLayerRT);
            r.setClearColor(0x000000, 1);
            r.clear();
            this.drawLayerAlone(L, bufSize);
            L.qt = this.runPictureFx(list, this.qtLayerRT, frame.t).texture;
        });
        if (layers.length) {
            r.setRenderTarget(out);
            while (this.layerQuads.length < layers.length) {
                const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
                this.layerQuads.push(q);
                this.layerScene.add(q);
            }
            this.layerQuads.forEach((q, i) => {
                const L = layers[i];
                q.visible = !!L;
                if (!L) return;
                const map = L.qt || L.tex;
                if (q.material.map !== map) { q.material.map = map; q.material.needsUpdate = true; }
                q.material.opacity = L.opacity;
                q.renderOrder = i;
                if (L.qt) q.scale.set(1, 1, 1);
                else layerScale(L, q);
            });
            r.render(this.layerScene, this.bgCamera);
        }

        // Quad trees, pixel sorts and Blob Trackers over the whole program,
        // in effect order, before the other effects.
        if (out) this.applyPictureFx(fxOn('program'), out, frame.t);

        if (fx) {
            r.setRenderTarget(null);
            this.composer.render();
        }
        if (!this.exporting) {
            r.setRenderTarget(null);
            cam.layers.set(LAYER.OVERLAY);
            r.render(this.scene, cam);
        }
        cam.layers.set(LAYER.FRONT);
    }
}

export { OVERLAY_ONLY };
