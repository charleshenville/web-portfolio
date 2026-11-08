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
import { OBJECT_TYPES } from '../model/schema';
import { programAt, clipSourceTime } from '../model/timeline';
import { TakeRig, poseAt, applyIntrinsics } from './takeRig';
import { makeAdapter } from './adapters';
import { VideoPool } from './media';
import { GradeShader, GRADE_KEYS } from './passes';

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
        return { pos, quat, fov: a.fov ?? p.fov };
    }
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rotX * D2R, p.rotY * D2R, p.rotZ * D2R, 'YXZ'));
    return { pos: new THREE.Vector3(p.posX, p.posY, p.posZ), quat, fov: p.fov };
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
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.015;
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-2, -1, -2);
        [ambient, sun, fill].forEach((l) => { l.layers.enableAll(); scene.add(l); });
        scene.add(sun.target);
        Object.assign(this, { ambient, sun, fill });

        this.trackedCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 100);
        this.objectCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 500);
        this.freeCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.001, 1000);
        this.freeCamera.position.set(0, 0.5, 4);
        this.controls = new OrbitControls(this.freeCamera, renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.enabled = false;

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

        // Corner editing (windows, screens, the pulse plane and line): a
        // marker per corner plus one in the middle that moves them all, the
        // gizmo on a proxy standing where the picked one is, and lines
        // joining them.
        this.cornerProxy = new THREE.Object3D();
        scene.add(this.cornerProxy);
        this.cornerHandles = new THREE.Group();
        const cornerGeo = new THREE.OctahedronGeometry(1, 0);
        for (let i = 0; i < 5; i++) {
            const m = new THREE.Mesh(cornerGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9, toneMapped: false,
            }));
            m.layers.set(LAYER.OVERLAY);
            m.renderOrder = 1001;
            m.userData.handle = true;
            this.cornerHandles.add(m);
        }
        this.cornerHandles.visible = false;
        scene.add(this.cornerHandles);
        this.cornerGuide = new THREE.LineSegments(
            new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3)),
            new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }),
        );
        this.cornerGuide.layers.set(LAYER.OVERLAY);
        this.cornerGuide.frustumCulled = false;
        this.cornerGuide.renderOrder = 1000;
        this.cornerGuide.visible = false;
        scene.add(this.cornerGuide);

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
        this.controls?.dispose();
        this.windows?.dispose();
        this.holdout?.dispose();
        this.mattes?.dispose();
        this.composer?.dispose();
        this.glowPasses?.forEach((g) => { g.bloom.dispose(); g.point.dispose(); });
        this.postPasses?.forEach(({ pass }) => pass.dispose?.());
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
        if (mode !== 'preview' && !this.framed) this.frameActive();
        this.dirty = true;
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
        this.glowPasses = effects.filter((e) => e.type === 'glow').map((e) => {
            const point = new PointGlowPass();
            const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0.6, 0.5);
            point.enabled = false;
            bloom.enabled = false;
            c.addPass(point);
            c.addPass(bloom);
            return { id: e.id, point, bloom };
        });
        c.addPass(this.gamma);
        this.postPasses = effects.filter((e) => e.type !== 'glow').map((e) => {
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
            const pointsOnly = on && glow.source === 'points';
            bloom.enabled = on && !pointsOnly && glow.strength > 0;
            point.enabled = pointsOnly && (glow.strength > 0 || glow.bleed > 0);
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
                u.aspect.value = size.x / Math.max(1, size.y);
            }
            any = any || pass.enabled;
        });
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
            this.cornerHandles.children.forEach((h, i) => {
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
        if (obj.type === 'window') return null; // moved by its corners
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
        const one = this.gizmoKind === 'corners' && (this.cornerEdit?.handle ?? 4) !== 4;
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
            this.emit('corners', { objectId: t.obj.id, kind: t.kind, key: t.key, entryId: t.entry?.id, corners, done });
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

    /** The corners being edited, in the space they are written in, or null. */
    cornerTarget(objects, S) {
        const ed = this.cornerEdit;
        if (!ed || !S || this.exporting || this.roto?.on) return null;
        const obj = objects.find((o) => o.id === ed.objectId);
        if (!obj) return null;
        if (obj.type === 'window') return { obj, kind: 'window', corners: obj.params.corners, space: S.root };
        if (obj.type === 'prop') {
            const a = S.adapters.get(obj.id);
            const entry = this.library().assets.find((x) => x.id === obj.params.assetId);
            if (!a?.model?.ready || entry?.category !== 'screen') return null;
            return { obj, kind: 'screen', entry, corners: { ...DEFAULT_SCREEN, ...entry.screen }.corners, space: a.model.norm };
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
        const active = this.cornerEdit.handle ?? 4;
        const camAt = cam.getWorldPosition(new THREE.Vector3());
        const k = target.space.getWorldScale(new THREE.Vector3()).x || 1;
        const wp = new THREE.Vector3();
        H.children.forEach((m, i) => {
            m.visible = i < C.length || i === 4;
            m.position.copy(i < C.length ? C[i] : mid);
            m.material.color.set(i === active ? '#ffb347' : (i === 4 ? '#7fe3ff' : '#ffffff'));
            m.updateMatrixWorld(true);
            m.getWorldPosition(wp);
            m.scale.setScalar((wp.distanceTo(camAt) * (i === active ? 0.016 : 0.011)) / k);
        });
        // The outline, closed for a quad or plane; a line runs on past its ends.
        const attr = G.geometry.getAttribute('position');
        const segs = [];
        if (C.length === 2) {
            const d = C[1].clone().sub(C[0]);
            segs.push([C[0].clone().addScaledVector(d, -0.5), C[1].clone().addScaledVector(d, 0.5)]);
        } else {
            C.forEach((c, i) => segs.push([c, C[(i + 1) % C.length]]));
        }
        segs.slice(0, 8).forEach(([a, b], i) => {
            attr.setXYZ(i * 2, a.x, a.y, a.z);
            attr.setXYZ(i * 2 + 1, b.x, b.y, b.z);
        });
        G.geometry.setDrawRange(0, Math.min(8, segs.length) * 2);
        attr.needsUpdate = true;
        if (!this.dragging) {
            if (this.cornerProxy.parent !== target.space) target.space.add(this.cornerProxy);
            this.cornerProxy.position.copy(active < C.length ? C[active] : mid);
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
        const span = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) / 2);
        return cornersFacing(cam, S.root, dist, dist * span * 0.35);
    }

    /** Point the free camera at what the active scene holds. */
    frameActive() {
        const s = this.scenes.get(this.activeSceneId);
        const sphere = s?.rig?.sphere;
        if (!sphere) return;
        this.framed = true;
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
            this.activeSceneId = sceneId;
            if (this.mode !== 'preview') this.frameActive();
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
            const camObj = base?.clip.camera && base.clip.camera !== 'solve'
                ? P.objects.find((o) => o.id === base.clip.camera)
                : (base?.media.kind === 'stage' ? objects.find((o) => o.type === 'camera') : null);
            if (camObj) {
                const pose = cameraPoseAt(camObj, resolveObject(camObj, frame), t);
                cam = this.objectCamera;
                cam.position.copy(pose.pos);
                cam.quaternion.copy(pose.quat);
                cam.fov = pose.fov;
                cam.aspect = aspect;
                cam.updateProjectionMatrix();
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
        const live = !!freq;
        const behind = { points: false, mesh: false, wire: false };
        if (rig) {
            const pts = ofType('scanPoints');
            const mesh = ofType('scanMesh');
            const wire = ofType('scanWire');
            rig.apply({ take: takeP, points: pts, mesh, wire }, drawSize, this.ss);
            rig.react(pts, wire, freq, live);
            behind.points = pts?.depthLayer === 'behind';
            behind.mesh = mesh?.depthLayer === 'behind';
            behind.wire = wire?.depthLayer === 'behind';
        }
        const f = {
            music, time: t, take: takeTime, freq, live, drawSize, renderer: this.renderer, scene: this.scene,
            exporting, playing: !!opts.playing, envReady: !!rig?.envMesh,
            // A window shows at its drawn size while one of its corners is dragged.
            holdWindow: this.dragging && this.cornerTargetNow?.kind === 'window' ? S?.adapters.get(this.cornerTargetNow.obj.id) : null,
        };
        if (S) {
            objects.forEach((o) => {
                const a = S.adapters.get(o.id);
                if (!a) return;
                a.sync(o, resolved.get(o.id));
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
                a.object.traverse((o) => {
                    if (o.userData.handle) o.layers.set(LAYER.OVERLAY);
                    else if (o.layers.mask !== mask && o.layers.mask !== (1 << LAYER.WIN_CUT) && o.layers.mask !== (1 << LAYER.WIN_FX)) o.layers.mask = mask;
                });
                if (back && a.object.visible) behindCount++;
            });
        }

        // ---- Footage
        const showFootage = this.mode === 'preview' && base?.media.kind === 'take' && (footageP?.visible !== false || !!this.roto?.on);
        let footageTex = null;
        if (showFootage) {
            footageTex = opts.exportFrame ? opts.exportFrame(base.media.id) : this.pool.follow(base.clip, base.media, t, { playing: !!opts.playing });
        }
        this.bgQuad.visible = !!footageTex;
        if (footageTex) {
            if (this.bgQuad.material.map !== footageTex) { this.bgQuad.material.map = footageTex; this.bgQuad.material.needsUpdate = true; }
            this.bgQuad.material.opacity = footageP.opacity ?? 1;
            this.coverQuad(this.bgQuad, rig?.track?.intrinsics, aspect);
        }

        // Plain video layers over the base (preview only).
        const layers = [];
        if (this.mode === 'preview') {
            program.overlays.forEach((ov) => {
                const tex = opts.exportFrame ? opts.exportFrame(ov.media.id) : this.pool.follow(ov.clip, ov.media, t, { playing: !!opts.playing });
                if (!tex) return;
                const tr = resolveTrack(ov.track, frame);
                layers.push({ tex, opacity: tr.opacity ?? 1, media: ov.media });
            });
        }
        if (!exporting) {
            const keep = new Set();
            if (showFootage) keep.add(base.media.id);
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
        const mattesOn = showFootage && takeP?.mattesOn !== false && rig?.track && !rig.track.unsolved;
        let holdTex = [];
        if (S?.take) {
            this.mattes.set(S.take, mattesFor(S.take));
            if (mattesOn) {
                const holdMap = objects.find((o) => o.type === 'take')?.extra?.matteHoldout || {};
                const ids = Array.from(this.mattes.tracks.keys());
                const idx = Math.max(0, Math.min(rig.track.frame_count - 1, Math.floor(takeTime * rig.track.fps + 1e-3)));
                const winMattes = [];
                S.adapters.forEach((a) => { if (a.model?.op?.matte) winMattes.push(a.model.op.matte); });
                const all = Array.from(new Set([...ids.filter((id) => holdMap[id] !== false), ...winMattes]));
                if (!opts.exportFrame) this.mattes.follow(all, idx, src?.dir < 0);
                this.matteFrame = { all, idx, back: src?.dir < 0 };
                holdTex = ids.filter((id) => holdMap[id] !== false).map((id) => this.mattes.texture(id)).filter(Boolean);
            }
        }

        this.compose({ cam, behindCount, footage: !!footageTex, holdTex, layers, S, frame, sortNow: exporting, objects });
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
        const sun = p || { azimuth: 45, elevation: 47, intensity: 1.1, color: '#ffffff', ambient: 0.55, shadows: false, shadowOpacity: 0.4, shadowSoftness: 2 };
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
            if (a.object.visible && (a.model?.op?.castShadow ?? false)) box.expandByObject(a.object);
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
            const r = box.getBoundingSphere(new THREE.Sphere()).radius;
            const tall = box.max.y - box.min.y;
            const reach = r * 1.2 + Math.min(12, tall / Math.max(0.08, Math.tan(el)));
            const c = this.sun.shadow.camera;
            Object.assign(c, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 40 });
            c.updateProjectionMatrix();
            this.sun.shadow.radius = sun.shadowSoftness;
        }
    }

    /** A camera and a frustum drawn for it, in one colour, on the overlay. */
    makeFrustum(color) {
        const cam = new THREE.PerspectiveCamera(50, this.outputAspect, 0.05, 0.4);
        this.scene.add(cam);
        const h = new THREE.CameraHelper(cam);
        const c = new THREE.Color(color);
        h.setColors(c, c, c, c, c);
        h.userData.cam = cam;
        h.layers.set(LAYER.OVERLAY);
        h.material.depthTest = false;
        h.material.transparent = true;
        h.renderOrder = 999;
        this.helpers.add(h);
        return h;
    }

    /** Point a frustum's camera; its length follows the scene's size so it reads at any scale. */
    placeFrustum(h, pos, quat, fov, reach) {
        const c = h.userData.cam;
        c.position.copy(pos);
        c.quaternion.copy(quat);
        c.fov = fov;
        c.aspect = this.outputAspect;
        c.near = reach * 0.04;
        c.far = reach;
        c.updateProjectionMatrix();
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
            let h = this.cameraHelpers.get(o.id);
            if (!h) {
                h = this.makeFrustum('#ffb347');
                this.cameraHelpers.set(o.id, h);
            }
            const pose = cameraPoseAt(o, resolved.get(o.id), takeTime ?? this.lastTime);
            this.placeFrustum(h, pose.pos, pose.quat, pose.fov, reach);
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
    }

    compose({ cam, behindCount, footage, holdTex, layers, S, frame, sortNow, objects }) {
        const r = this.renderer;
        const takeObj = objects.find((o) => o.type === 'take');
        const bgColor = takeObj?.params.bgColor || '#000000';
        const fx = this.applyEffects(frame);
        this.glowPasses.forEach(({ point }) => {
            point.drawSource = point.enabled ? (rr) => this.drawPointSource(rr, cam) : null;
        });
        const out = fx ? this.composer.readBuffer : null;
        const drawScene = !!S;
        const wins = [];
        S?.adapters.forEach((a) => { if (a.model && a.model.cutMesh && a.open) wins.push(a.model); });
        const size = this.windows.ensure();
        // The footage quad is scaled up to cover the frame; mattes are cropped the same.
        const crop = this.matteCrop || (this.matteCrop = new THREE.Vector2());
        crop.set(1 / Math.max(1e-6, this.bgQuad.scale.x), 1 / Math.max(1e-6, this.bgQuad.scale.y));
        wins.forEach((w) => w.setMatte(footage && w.op.matte ? this.mattes.texture(w.op.matte) : null, size, crop));
        const hold = holdTex.length > 0 && drawScene;
        const target = hold ? this.holdout.baseRT : out;
        if (hold) this.holdout.build(holdTex, size, crop);

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
            const cutWins = footage ? wins.filter((w) => w.op.cut) : [];
            const fxWins = wins.filter((w) => w.hasFx);
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
                wins.forEach((w) => { w.fxMesh.visible = fxWins.includes(w); comp.prepareFx(w); });
                cam.layers.set(LAYER.WIN_FX);
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
            clearTo(out);
            this.windows.blit(this.holdout.baseRT.texture);
            cam.layers.set(LAYER.FRONT);
            r.shadowMap.needsUpdate = true;
            r.render(this.scene, cam);
            this.holdout.apply(this.holdout.baseRT.texture);
        }

        // Plain video layers over the composite, before the effects.
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
                if (q.material.map !== L.tex) { q.material.map = L.tex; q.material.needsUpdate = true; }
                q.material.opacity = L.opacity;
                q.renderOrder = i;
                const img = L.tex.image;
                const w = img?.videoWidth || img?.displayWidth || L.media.width || 16;
                const h = img?.videoHeight || img?.displayHeight || L.media.height || 9;
                const src = w / h;
                const aspect = this.renderer.getDrawingBufferSize(new THREE.Vector2());
                const a = aspect.x / Math.max(1, aspect.y);
                q.scale.set(a > src ? 1 : src / a, a > src ? a / src : 1, 1);
            });
            r.render(this.layerScene, this.bgCamera);
        }

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
