// Placed objects in the engine. Each adapter wraps one of the libs the scan
// compositor already used (point clouds and curves from audioScene, the
// protagonist, Sackboy, props and screens, windows) behind one interface:
//
//   object            the THREE.Object3D in the scene (picked, gizmo'd)
//   sync(obj, params) every frame, with the object's resolved parameters
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
import { PropModel } from '../../../lib/scanAssets/props';
import { WindowModel } from '../../../lib/scanAssets/windows';
import { ENV_LAYER } from './takeRig';

const plyCache = new Map();

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
        }
        applyRecordTransform(this.rec, this.rec.op);
        if (this.opacityKey !== p.opacity) {
            this.opacityKey = p.opacity;
            applySceneOpacity([this.rec], p.opacity ?? 1);
        }
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
    }

    dispose() {
        this.disposed = true;
        if (this.rec) disposeRecord(this.rec);
        this.group.removeFromParent();
    }
}

// ---- Rigged models ----------------------------------------------------------------

class ModelAdapter {
    constructor(obj, parent, Kind) {
        const pose = obj.extra?.pose;
        const item = this.item(obj, obj.params, pose, Kind);
        this.model = Kind === SackboyModel ? new SackboyModel(item) : new ProtagonistModel(item);
        this.object = this.model.object;
        this.Kind = Kind;
        parent.add(this.object);
        this.last = null;
        this.lastPose = pose;
    }

    item(obj, p, pose, Kind = this.Kind) {
        const sack = Kind === SackboyModel;
        // A model made without a pose takes its lib's default stance.
        const base = pose ? null : (sack ? makeSackboyItem(obj.id, {}, 'stand') : makeModelItem(obj.id, {}, 'stand'));
        return {
            id: obj.id,
            kind: 'model',
            modelId: sack ? 'sackboy' : 'protagonist',
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

    update(dt, f) { this.model.update(f.music, f.time, { take: f.take, hold: f.holdWindow === this }); }

    dispose() {
        this.model.dispose();
        this.object.removeFromParent();
    }
}

export function makeAdapter(obj, parent, ctx) {
    switch (obj.type) {
        case 'cloud':
        case 'curve': return new RecordAdapter(obj, parent);
        case 'protagonist': return new ModelAdapter(obj, parent, ProtagonistModel);
        case 'sackboy': return new ModelAdapter(obj, parent, SackboyModel);
        case 'prop': return new PropAdapter(obj, parent, ctx.library);
        case 'window': return new WindowAdapter(obj, parent);
        default: return null;
    }
}

export { WindowAdapter, PropAdapter, ModelAdapter };
