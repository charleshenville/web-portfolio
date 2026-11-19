// Placed objects in the engine. Each adapter wraps one of the libs the scan
// compositor already used (point clouds and curves from audioScene, the
// protagonist, Sackboy, the headphone cat, props and screens, windows)
// behind one interface:
//
//   object            the THREE.Object3D in the scene (picked, gizmo'd)
//   sync(obj, params, f)
//                     every frame, with the object's resolved parameters
//                     (f as for update, with `globals`: the variables and
//                     splines expressions read, model/globals.js)
//   update(dt, f)     advance animation; f = { music, time, take, freq,
//                     live, drawSize, renderer, scene, exporting, playing }
//   dispose()
//
// The libs keep their own parameter names, so a resolved parameter set goes
// straight through as their `op`.

import * as THREE from 'three';
import {
    ASSETS, buildPointCloudRecord, buildCurveRecord, applyRecordTransform, disposeRecord,
    fibonacciSphere, loadPlyPoints, recolorPointCloud, sphereColorKey, GEOM_KEYS, CURVE_GEOM_KEYS,
    applyAudioReactivity, applySceneOpacity,
} from '../../../lib/audioScene';
import { ProtagonistModel, makeModelItem } from '../../../lib/protagonist/poser';
import { metalEnvironment } from '../../../lib/protagonist/rig';
import { kickEnvelope, kickHits, kickLevelAt } from '../../../lib/protagonist/kicks';
import { SackboyModel, makeSackboyItem } from '../../../lib/scanAssets/sackboy';
import { CatModel, makeCatItem } from '../../../lib/scanAssets/headphoneCat/model';
import { PropModel } from '../../../lib/scanAssets/props';
import { WindowModel } from '../../../lib/scanAssets/windows';
import { ENV_LAYER } from './takeRig';
import { hookGlowCatch } from './emission';
import PatchScreen from './patchScreen';
import { loadPicture } from './pictures';
import TextObject from './textObject';
import CurveAdapter, {
    Dots, knotAngle, SHAPES, FLAT_SHAPES,
} from './curveObject';
import Wisps from './wisps';
import ParticleFlow from './particleFlow';
import ShapeAdapter from './shapeObject';
import { isTemplate, fillTemplate, formatValue } from '../model/expr';

// A spline point label's {{world.x}} / {{world.y:3}}: the point's coordinate in its scene's frame.
const WORLD_TEMPLATE = /\{\{\s*world\.(x|y|z)\s*(?::(\d+))?\}\}/g;

const plyCache = new Map();

// A point cloud's dots turned to face the camera, for flat shapes: each dot's
// own xyz laid along the camera's right, up and toward-it, as the object sees
// them (its instances only move, never turn). Runs before the Flow hook moves
// the dot, so a flowing flat dot still faces the camera.
function hookFacing(material, uniform) {
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        prev?.call(material, shader, renderer);
        shader.uniforms.uFaceCam = uniform;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uFaceCam;')
            .replace('#include <begin_vertex>', `#include <begin_vertex>
if (uFaceCam > 0.5) {
    mat3 fcM = mat3(modelViewMatrix);
    vec3 fcR = normalize(vec3(fcM[0][0], fcM[1][0], fcM[2][0]));
    vec3 fcU = normalize(vec3(fcM[0][1], fcM[1][1], fcM[2][1]));
    vec3 fcF = normalize(vec3(fcM[0][2], fcM[1][2], fcM[2][2]));
    transformed = fcR * transformed.x + fcU * transformed.y + fcF * transformed.z;
}`);
    };
    material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|faceCam`;
    material.needsUpdate = true;
}

/** Which things the lib's own sync should see change: everything but the per-frame values. */
const shallowSame = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => a[k] === b[k] || (typeof a[k] === 'object' && JSON.stringify(a[k]) === JSON.stringify(b[k])));
};

// ---- Point clouds and curves ----------------------------------------------------

class RecordAdapter {
    constructor(obj, parent) {
        this.parent = parent;
        this.group = new THREE.Group(); // stable handle for the gizmo and picking
        this.object = this.group;
        parent.add(this.group);
        this.rec = null;
        this.key = null;
        this.token = null;
        this.op = null;
        // A point cloud's wisps, in its own space (beside its dots, so they move with it).
        if (obj.type === 'cloud') {
            this.wisps = new Wisps();
            this.group.add(this.wisps.object);
            // And its dots set loose as particles.
            this.flow = new ParticleFlow();
        }
    }

    sync(obj, p) {
        this.op = p;
        const curve = obj.type === 'curve';
        const key = curve
            ? `${p.funcId}|${CURVE_GEOM_KEYS.map((k) => p[k]).join('|')}`
            : `${p.assetId}|${GEOM_KEYS.map((k) => p[k]).join('|')}`;
        if (key !== this.key) this.rebuild(obj, p, key, curve);
        this.group.position.set(p.posX, p.posY, p.posZ);
        this.group.rotation.set(THREE.MathUtils.degToRad(p.rotX), THREE.MathUtils.degToRad(p.rotY), THREE.MathUtils.degToRad(p.rotZ));
        this.group.scale.setScalar(p.scale);
        this.group.visible = p.visible !== false;
        if (!this.rec) return;
        this.rec.op = { ...p, posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1 };
        this.rec.reactive = true;
        if (curve) {
            this.rec.colA.set(p.startColor);
            this.rec.colB.set(p.endColor);
        } else if (this.rec.colorKey !== sphereColorKey(p)) {
            recolorPointCloud(this.rec, p);
            if (this.wisps) this.wisps.key = null; // their colours are taken from the dots
        }
        applyRecordTransform(this.rec, this.rec.op);
        if (!curve) this.setDotShape(p);
        if (this.opacityKey !== p.opacity) {
            this.opacityKey = p.opacity;
            applySceneOpacity([this.rec], p.opacity ?? 1);
        }
    }

    /**
     * A point cloud's dots in the chosen shape (the splines' shapes), as big
     * as the lib's tetrahedra were: `pointSize` × 1.2 across their unit shape.
     */
    setDotShape(p) {
        const mesh = this.rec?.instancedMesh;
        if (!mesh) return;
        const shape = SHAPES[p.dotShape] ? p.dotShape : 'tetra';
        const key = `${shape}|${p.pointSize}`;
        if (key === this.shapeKey) return;
        this.shapeKey = key;
        const g = SHAPES[shape]();
        g.scale(p.pointSize * 1.2, p.pointSize * 1.2, p.pointSize * 1.2);
        mesh.geometry.dispose();
        mesh.geometry = g;
        // Flow moves the dots from attributes on their geometry: give the new one them.
        if (this.flow && this.rec.basePositions) this.flow.attach(g, this.rec.basePositions, this.rec.count, true);
        if (this.faceCam) this.faceCam.value = FLAT_SHAPES.has(shape) ? 1 : 0;
        mesh.computeBoundingSphere?.();
    }

    rebuild(obj, p, key, curve) {
        this.key = key;
        const install = (rec) => {
            if (this.rec) disposeRecord(this.rec);
            this.rec = rec;
            rec.object3D.frustumCulled = false;
            rec.object3D.userData.objectId = obj.id;
            this.group.add(rec.object3D);
            this.opacityKey = null;
            if (this.wisps && rec.basePositions) {
                this.wisps.setSource(rec.basePositions, rec.instancedMesh?.instanceColor?.array || null, rec.count);
            }
            if (this.flow && rec.instancedMesh && rec.basePositions) {
                this.flow.attach(rec.instancedMesh.geometry, rec.basePositions, rec.count, true);
                this.flow.hook(rec.instancedMesh.material, true);
            }
            // Its dots' shape, set in sync (the lib always makes tetrahedra).
            if (!curve && rec.instancedMesh) {
                this.faceCam = { value: 0 };
                hookFacing(rec.instancedMesh.material, this.faceCam);
                rec.instancedMesh.material.side = THREE.DoubleSide;
                this.shapeKey = null;
            }
        };
        if (curve) {
            install(buildCurveRecord(p.funcId, p));
            return;
        }
        const asset = ASSETS.find((a) => a.id === p.assetId) || ASSETS[0];
        if (asset.type === 'sphere') {
            install(buildPointCloudRecord(fibonacciSphere(p.samples, p.radius, p.jitter), p, 'sphere'));
            return;
        }
        const token = {};
        this.token = token;
        loadPlyPoints(asset.path, plyCache).then((raw) => {
            if (this.token !== token || this.disposed) return;
            install(buildPointCloudRecord(raw, this.op || p, asset.type));
        }).catch(() => {});
    }

    update(dt, f) {
        if (!this.rec || this.rec.loading) return;
        applyAudioReactivity([this.rec], f.freq, dt, f.live);
        this.flow?.update(this.op, f.time);
        this.wisps?.update(this.op, f.time, f.drawSize, f.ss, this.group.visible);
    }

    dispose() {
        this.disposed = true;
        if (this.rec) disposeRecord(this.rec);
        this.wisps?.dispose();
        this.group.removeFromParent();
    }
}

// ---- Rigged models ----------------------------------------------------------------

const MODEL_KINDS = new Map([
    [ProtagonistModel, { make: makeModelItem, modelId: 'protagonist' }],
    [SackboyModel, { make: makeSackboyItem, modelId: 'sackboy' }],
    [CatModel, { make: makeCatItem, modelId: 'cat' }],
]);

class ModelAdapter {
    constructor(obj, parent, Kind) {
        const pose = obj.extra?.pose;
        const item = this.item(obj, obj.params, pose, Kind);
        this.model = new Kind(item);
        this.object = this.model.object;
        this.Kind = Kind;
        parent.add(this.object);
        this.last = null;
        this.lastPose = pose;
        // How strongly his lit surfaces catch emitted glow (0 when nothing emits).
        this.glow = { value: 0 };
        this.glowOn = false;
        // His points set loose as particles, as the scan's are (made when first on).
        this.flow = null;
        this.flowGeometry = null;
    }

    setGlowCatch(on) { this.glowOn = on; }

    /** Every lit material he is drawn with now catches the glow (each hooked once; a rebuild's new ones too). */
    hookGlow() {
        this.object.traverse((o) => {
            if (!o.isMesh) return;
            (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
                if (m && (m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshLambertMaterial)) hookGlowCatch(m, this.glow);
            });
        });
    }

    /** Drive the Flow on his points, re-attaching when they were remade. */
    updateFlow(op, time) {
        const src = op.viewPoints && op.simOn ? this.model.pointFlow?.() : null;
        if (!src) {
            if (this.flow) this.flow.uniforms.uSimOn.value = 0;
            return;
        }
        if (!this.flow) this.flow = new ParticleFlow();
        if (this.flowGeometry !== src.geometry) {
            this.flow.attach(src.geometry, src.homes, src.count, false);
            this.flowGeometry = src.geometry;
        }
        this.flow.hook(src.material, false);
        this.flow.update(op, time, src.unit);
    }

    item(obj, p, pose, Kind = this.Kind) {
        const { make, modelId } = MODEL_KINDS.get(Kind);
        // A model made without a pose takes its lib's default stance.
        const base = pose ? null : make(obj.id, {}, 'stand');
        return {
            id: obj.id,
            kind: 'model',
            modelId,
            op: { ...p },
            pose: pose || base.pose,
        };
    }

    sync(obj, p) {
        const pose = obj.extra?.pose;
        if (!shallowSame(this.last, p) || pose !== this.lastPose) {
            this.last = p;
            this.lastPose = pose;
            this.model.sync(this.item(obj, p, pose));
        }
        // The model's own fade decides its visibility, so hiding is a fade to 0.
        this.vis = p.visible !== false ? 1 : 0;
        this.model.setOpacity(this.vis);
        this.object.userData.objectId = obj.id;
    }

    update(dt, f) {
        const m = this.model;
        const op = m.op;
        if (m.needsEnv && f.envReady) m.captureEnv(f.renderer, f.scene, ENV_LAYER, metalEnvironment());
        let kick = null;
        if (op.nodMode === 'kick' && f.music && f.time != null) {
            const env = kickEnvelope(f.music, op.kickLow, op.kickHigh);
            kick = { hits: kickHits(env, op.kickThreshold, op.kickGap), level: kickLevelAt(env, f.time), time: f.time };
        }
        m.update(dt, {
            beatTime: op.nodSync && f.time != null ? f.time : null,
            drawWidth: f.drawSize.x,
            drawHeight: f.drawSize.y,
            kick,
            music: f.music,
            musicTime: f.time,
        });
        m.setOpacity(this.vis ?? 1);
        this.hookGlow();
        this.glow.value = this.glowOn ? Math.max(0, op.glowCatch ?? 1) : 0;
        this.updateFlow(op, f.time);
    }

    reset() { this.model.reset?.(); }

    dispose() {
        this.model.dispose();
        this.object.removeFromParent();
    }
}

// ---- Props and screens ----------------------------------------------------------

class PropAdapter {
    constructor(obj, parent, library) {
        this.parent = parent;
        this.library = library;
        this.model = null;
        this.object = new THREE.Group();
        parent.add(this.object);
        this.entryFile = null;
        this.last = null;
    }

    sync(obj, p) {
        const entry = this.library().assets.find((a) => a.id === p.assetId);
        if (!entry) return;
        const item = { id: obj.id, kind: 'prop', assetId: p.assetId, op: { ...p } };
        if (!this.model || this.entryFile !== entry.file) {
            this.model?.dispose();
            this.model = new PropModel(item, entry);
            this.entryFile = entry.file;
            this.object.add(this.model.object);
            this.last = null;
        }
        if (!shallowSame(this.last, p) || this.entry !== entry) {
            this.last = p;
            this.entry = entry;
            this.model.sync(item, entry);
        }
        this.object.visible = p.visible !== false;
        this.object.userData.objectId = obj.id;
    }

    // The prop's own transform lives on its model object; the gizmo moves that.
    get gizmoTarget() { return this.model?.object || null; }

    update(dt, f) {
        if (!this.model) return;
        this.model.update(dt, { music: f.music, time: f.time, clock: f.time ?? 0, playing: f.playing, exporting: f.exporting });
        this.model.setOpacity(1);
    }

    async exportFrame(clock) { await this.model?.exportFrame(clock); }
    async openExport() { await this.model?.openExport(); }
    closeExport() { this.model?.closeExport(); }

    dispose() {
        this.model?.dispose();
        this.object.removeFromParent();
    }
}

// ---- Windows --------------------------------------------------------------------

class WindowAdapter {
    constructor(obj, parent) {
        this.model = new WindowModel({ id: obj.id, kind: 'window', op: { ...obj.params } });
        this.object = this.model.object;
        parent.add(this.object);
        this.last = null;
        // A window can also be a screen: a video across its patch.
        this.screen = new PatchScreen(this.model);
    }

    sync(obj, p) {
        if (!shallowSame(this.last, p)) {
            this.last = p;
            this.model.sync({ id: obj.id, kind: 'window', op: { ...p } });
        }
        this.object.userData.objectId = obj.id;
        this.hidden = p.visible === false;
    }

    get open() { return !this.hidden && this.model.open; }

    update(dt, f) {
        this.model.update(f.music, f.time, { hold: f.holdWindow === this });
        // The picture follows the window as laid out now (its transform included).
        const op = this.last || {};
        this.screen.sync(this.model.corners || op.corners, this.hidden ? { ...op, screenOn: false } : op);
        this.screen.update(f.time, f.playing, f.exporting);
    }

    async openExport() { await this.screen.openExport(); }
    async exportFrame(clock) { await this.screen.exportFrame(clock); }
    closeExport() { this.screen.closeExport(); }

    dispose() {
        this.screen.dispose();
        this.model.dispose();
        this.object.removeFromParent();
    }
}

// ---- Text ------------------------------------------------------------------------

class TextAdapter {
    constructor(obj, parent) {
        this.text = new TextObject();
        this.object = this.text.object;
        parent.add(this.object);
        // What the sun reads to decide whether this casts a shadow.
        this.model = { op: {} };
    }

    sync(obj, p, f) {
        let q = p;
        // Dynamic text: {{θ}}, {{2ω_1:3}} worked out now.
        if (isTemplate(p.text) && f?.globals) {
            const g = f.globals;
            q = { ...q, text: fillTemplate(p.text, (src) => g.evaluate(src), g.digitsFor) };
        }
        if (p.space === 'frame') {
            // Over the frame: a box of the frame's proportions, placed each frame in update.
            const ds = f?.drawSize;
            const A = Math.max(1e-3, ((p.frameW ?? 0.5) * (ds ? ds.x : 16)) / Math.max(1e-6, (p.frameH ?? 0.1) * (ds ? ds.y : 9)));
            const r = (v) => Math.round(v * 1e5) / 1e5;
            q = {
                ...q,
                corners: [[r(-A / 2), 0.5, 0], [r(A / 2), 0.5, 0], [r(A / 2), -0.5, 0], [r(-A / 2), -0.5, 0]],
                lit: false,
                castShadow: false,
                hideBehindScan: false,
            };
        }
        // The scan's mesh and its textures, for text laid onto it.
        if (f?.scanSurface) q = { ...q, surface: f.scanSurface };
        this.text.sync(q);
        this.model.op = q;
        // What emission reads (engine/emission.js): faded, it lights less.
        this.op = q.emitOn ? { ...q, emitIntensity: (q.emitIntensity ?? 1) * Math.max(0, Math.min(1, q.opacity ?? 1)) } : q;
        this.object.userData.objectId = obj.id;
    }

    // Keep the letters rasterised at the size they are drawn on screen.
    update(dt, f) {
        if (this.model.op.space === 'frame') this.text.place2D(f.camera, this.model.op);
        else if (this.model.op.faceCamera) this.text.face(f.camera, !!this.anchor || !!this.aboutOrigin);
        this.text.fit(f.camera, f.drawSize, f.renderer);
        this.text.setTime(f.time);
    }

    setScanDepth(tex, size) { this.text.setScanDepth(tex, size); }

    /** Its letters as light sources, when it emits (engine/emission.js). */
    emitPoints() { return this.text.emitPoints(); }

    dispose() { this.text.dispose(); }
}

/**
 * An Image: a picture (PNG, JPEG, WebP, or an animated GIF) on a patch,
 * placed, lit, blended and roughened exactly as text is (it is text's
 * patch, with the picture drawn on it in place of letters).
 */
class ImageAdapter extends TextAdapter {
    sync(obj, p, f) {
        super.sync(obj, { ...p, text: '', textMode: 'plain', picture: loadPicture(p.image) || null, pictureTime: f?.time ?? 0 }, f);
    }
}

// ---- A spline's point -------------------------------------------------------------------

/**
 * One defining point of a spline, as its own object: a marker at its origin
 * (the engine hangs it on the point) and a label measured from there. The
 * engine hands it the spline's resolved settings as `look` before each sync.
 */
class SplinePointAdapter {
    constructor(obj, parent) {
        this.object = new THREE.Group();
        parent.add(this.object);
        this.label = new TextAdapter(obj, this.object);
        this.label.aboutOrigin = true;
        this.marker = new Dots();
        this.object.add(this.marker.object);
        this.model = this.label.model;
        this.look = {};
        this.size = new THREE.Vector2();
        this.wq = new THREE.Quaternion();
        this.cq = new THREE.Quaternion();
        this.col = new THREE.Color();
        this.wp = new THREE.Vector3();
    }

    /**
     * `text` with each {{world.x}} (y, z; :digits for decimals) filled in:
     * where this point is in its scene's frame, which is where the engine
     * has just hung it (on its spline, placed, turned, scaled and spun).
     */
    fillWorld(text) {
        if (typeof text !== 'string' || !text.includes('world.')) return text;
        let root = this.object;
        while (root.parent && !root.parent.isScene) root = root.parent;
        const w = this.object.getWorldPosition(this.wp);
        root.updateWorldMatrix(true, false);
        root.worldToLocal(w);
        return text.replace(WORLD_TEMPLATE, (all, axis, digits) => formatValue(w[axis], digits !== undefined ? parseInt(digits, 10) : 2));
    }

    /** The label's own node: its corners are in its frame. */
    get labelNode() { return this.label.object; }

    sync(obj, p, f) {
        const L = this.look || {};
        this.object.userData.objectId = obj.id;
        this.object.visible = p.visible !== false;
        // The label: a Text, in the scene, hidden with the spline's labels.
        const labelOn = L.labels === true && p.showLabel !== false;
        // The spline's label outline, unless this label has one of its own.
        const outline = (p.outline || 0) > 0 ? {} : { outline: L.labelOutline || 0, outlineColor: L.labelOutlineColor };
        this.label.sync(obj, {
            ...p, ...outline, text: labelOn ? this.fillWorld(p.text) : p.text, space: 'scene', visible: labelOn,
        }, f);
        this.drawMarker(p, f, L.showKnots !== false && p.showMarker !== false, obj.pointLabel?.index ?? 0);
    }

    drawMarker(p, f, on, index) {
        const L = this.look || {};
        if (!on) { this.marker.hide(); return; }
        const own = !!p.markerOwn;
        const shape = (own ? p.markerShape : L.knotShape) || 'octa';
        const style = own ? p.markerStyle : L.knotStyle;
        const c = this.col.set((own ? p.markerColor : L.knotColor) || '#ffffff');
        f?.renderer?.getDrawingBufferSize(this.size);
        // Flat markers face the camera, in this point's own frame.
        const face = this.cq.identity();
        if (f?.camera) {
            this.object.updateWorldMatrix(true, false);
            this.object.getWorldQuaternion(this.wq).invert();
            f.camera.getWorldQuaternion(face);
            face.premultiply(this.wq);
        }
        this.marker.write(1, [0, 0, 0], [(own ? p.markerSize : L.knotSize) ?? 0.035], [c.r, c.g, c.b, 1], {
            shape,
            lit: false,
            face,
            // The spline turns them all, each about an axis of its own (seeded by the point).
            spin: L.knotSpin ? [knotAngle(L, index, f?.time)] : null,
            spinAxis: L.knotSpinAxis,
            seed: index,
            opacity: L.opacity ?? 1,
            wire: style === 'wire',
            wireWidth: own ? p.markerWire : L.knotWire,
            resolution: this.size,
            // Casting as its spline does.
            castShadow: !!L.castShadow,
        });
    }

    update(dt, f) { this.label.update(dt, f); }

    /** As its spline's (CurveAdapter.setShadowTexel). */
    setShadowTexel(texel) {
        this.marker.shadowMin.value = 0.75 * texel;
    }

    setScanDepth(tex, size) { this.label.setScanDepth(tex, size); }

    dispose() {
        this.label.dispose();
        this.marker.dispose();
        this.object.removeFromParent();
    }
}

export function makeAdapter(obj, parent, ctx) {
    switch (obj.type) {
        case 'cloud':
        case 'curve': return new RecordAdapter(obj, parent);
        case 'protagonist': return new ModelAdapter(obj, parent, ProtagonistModel);
        case 'sackboy': return new ModelAdapter(obj, parent, SackboyModel);
        case 'cat': return new ModelAdapter(obj, parent, CatModel);
        case 'prop': return new PropAdapter(obj, parent, ctx.library);
        case 'shape': return new ShapeAdapter(obj, parent);
        case 'window': return new WindowAdapter(obj, parent);
        case 'text': return new TextAdapter(obj, parent);
        case 'image': return new ImageAdapter(obj, parent);
        case 'splinePoint': return new SplinePointAdapter(obj, parent);
        case 'equation':
        case 'spline':
        case 'manifold': return new CurveAdapter(obj, parent);
        default: return null;
    }
}

export { WindowAdapter, PropAdapter, ModelAdapter };
