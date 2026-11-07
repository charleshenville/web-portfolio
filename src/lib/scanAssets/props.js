// Static assets placed in a take: props (a rock, a boombox) and screens (a
// laptop, a synth's LCD) that carry a video.
//
// Each placed asset is three nested groups:
//   object - where the item puts it: position, turn, scale (with the
//            audio-driven pulse on top).
//   norm   - the library's sizing: the GLB scaled so its largest side is the
//            asset's `size` in metres, its footprint centred on the origin and
//            its base on it, so it stands on whatever it is placed on and
//            scales up from the floor.
//   the GLB itself, in its own units - which is also the space the screen
//            corners are written in, so a screen survives any re-sizing.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE, DEFAULT_SCREEN } from './library';
import { MOD_DEFAULTS, modulate } from './modulate';
import { ScreenVideo } from './screenVideo';

const D2R = Math.PI / 180;

export const PROP_DEFAULTS = {
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 1,
    opacity: 1,
    castShadow: true,
    // In front of the footage, or behind it (seen only through windows or
    // where the footage is faded).
    depthLayer: 'front',

    // Scale pulse: base * (1 + amount * curve(level)), per axis.
    reactAmount: 0.08,
    reactX: 1,
    reactY: 1,
    reactZ: 1,
    mod: { ...MOD_DEFAULTS },

    // Screens only.
    video: null, // source id, see screenVideo.js
    videoOffset: 0,
    videoRate: 1,
    fit: null, // null: the library's default for the asset
    rotate: 0, // 0 | 90 | 180 | 270
    flipX: false,
    brightness: 1.4,
    screenOn: true,
};

/** A new placed prop or screen. */
export function makePropItem(id, assetId, overrides = {}) {
    return {
        id,
        kind: 'prop',
        assetId,
        reactive: false,
        op: { ...PROP_DEFAULTS, mod: { ...MOD_DEFAULTS }, ...overrides },
    };
}

export function reviveProp(raw, id) {
    return {
        id,
        kind: 'prop',
        assetId: raw.assetId,
        reactive: false,
        op: {
            ...PROP_DEFAULTS,
            ...raw.op,
            mod: { ...MOD_DEFAULTS, ...(raw.op && raw.op.mod) },
        },
    };
}

// ---- GLB cache ----------------------------------------------------------

const gltfCache = new Map(); // file -> Promise<{ scene, box }>

export function loadAssetGltf(file) {
    if (!gltfCache.has(file)) {
        const p = new GLTFLoader().loadAsync(`${ASSET_BASE}/${file}`).then((gltf) => {
            gltf.scene.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(gltf.scene);
            return { scene: gltf.scene, box, gltf };
        });
        p.catch(() => gltfCache.delete(file));
        gltfCache.set(file, p);
    }
    return gltfCache.get(file);
}

// ---- Corner quads (screens and windows) ---------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/** A point on the bilinear patch through four corners (TL, TR, BR, BL), at u right, v up. */
export function bilinear(corners, u, v, out = new THREE.Vector3()) {
    _a.fromArray(corners[3]).lerp(_b.fromArray(corners[2]), u); // bottom edge
    _c.fromArray(corners[0]).lerp(_d.fromArray(corners[1]), u); // top edge
    return out.copy(_a).lerp(_c, v);
}

/**
 * A grid over the patch between `u0..u1` and `v0..v1` of the corners, with
 * texture coordinates from `uvAt(u, v)` (local 0..1 over the sub-patch).
 */
export function patchGeometry(corners, { segs = 8, u0 = 0, u1 = 1, v0 = 0, v1 = 1, uvAt = null, lift = 0 } = {}) {
    const n = segs + 1;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const normal = quadNormal(corners);
    const p = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const lu = i / segs;
            const lv = j / segs;
            bilinear(corners, u0 + (u1 - u0) * lu, v0 + (v1 - v0) * lv, p).addScaledVector(normal, lift);
            const k = j * n + i;
            pos.set([p.x, p.y, p.z], k * 3);
            const t = uvAt ? uvAt(lu, lv) : [lu, lv];
            uv.set(t, k * 2);
        }
    }
    const idx = [];
    for (let j = 0; j < segs; j++) {
        for (let i = 0; i < segs; i++) {
            const a = j * n + i;
            const b = a + 1;
            const c = a + n;
            const d = c + 1;
            idx.push(a, b, d, a, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
}

/** The way the corners face (towards whoever reads the picture the right way round). */
export function quadNormal(corners) {
    const tl = new THREE.Vector3().fromArray(corners[0]);
    const tr = new THREE.Vector3().fromArray(corners[1]);
    const br = new THREE.Vector3().fromArray(corners[2]);
    const bl = new THREE.Vector3().fromArray(corners[3]);
    const right = tr.clone().sub(tl).add(br.clone().sub(bl));
    const up = tl.clone().sub(bl).add(tr.clone().sub(br));
    const n = new THREE.Vector3().crossVectors(right, up);
    return n.lengthSq() > 1e-12 ? n.normalize() : new THREE.Vector3(0, 0, 1);
}

/** Width over height of the patch, measured along its edges. */
export function quadAspect(corners) {
    const P = corners.map((c) => new THREE.Vector3().fromArray(c));
    const w = (P[0].distanceTo(P[1]) + P[3].distanceTo(P[2])) / 2;
    const h = (P[0].distanceTo(P[3]) + P[1].distanceTo(P[2])) / 2;
    return h > 1e-9 ? w / h : 1;
}

/**
 * Lay a picture of aspect `video` onto a patch of aspect `quad`. Returns the
 * part of the patch the picture covers and how a point in that part reads
 * the picture: 'cover' crops, 'contain' letterboxes, 'stretch' fills.
 */
export function fitPicture(fit, quad, video, rotate = 0, flipX = false) {
    const turned = rotate % 180 !== 0;
    const pic = turned ? 1 / video : video;
    let u0 = 0;
    let u1 = 1;
    let v0 = 0;
    let v1 = 1;
    let su = 1;
    let sv = 1;
    if (fit === 'cover') {
        if (pic > quad) su = quad / pic;
        else sv = pic / quad;
    } else if (fit === 'contain') {
        if (pic > quad) { const h = quad / pic; v0 = (1 - h) / 2; v1 = 1 - v0; } else { const w = pic / quad; u0 = (1 - w) / 2; u1 = 1 - u0; }
    }
    const uvAt = (lu, lv) => {
        let x = 0.5 + (lu - 0.5) * su;
        let y = 0.5 + (lv - 0.5) * sv;
        if (flipX) x = 1 - x;
        // Rotate the picture on the screen (clockwise).
        for (let r = 0; r < ((rotate / 90) % 4 + 4) % 4; r++) {
            const nx = 1 - y;
            y = x;
            x = nx;
        }
        return [x, y];
    };
    return { u0, u1, v0, v1, uvAt };
}

/**
 * Corners framing one part of a model (in `space`'s coordinates): the
 * part's dominant plane, by area, and its extent across it. Up on the
 * picture is the world's up as seen on that plane, or towards the back of a
 * part that faces the sky (a synth's display).
 */
export function fitCornersToMesh(mesh, space) {
    space.updateMatrixWorld(true);
    const toSpace = new THREE.Matrix4().copy(space.matrixWorld).invert().multiply(mesh.matrixWorld);
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const idx = g.index ? g.index.array : null;
    const tri = idx ? idx.length / 3 : pos.count / 3;
    const P = (k) => new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(toSpace);
    const nSum = new THREE.Vector3();
    const pts = [];
    for (let t = 0; t < tri; t++) {
        const a = P(idx ? idx[t * 3] : t * 3);
        const b = P(idx ? idx[t * 3 + 1] : t * 3 + 1);
        const c = P(idx ? idx[t * 3 + 2] : t * 3 + 2);
        const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
        // Area-weighted, folded onto one hemisphere so a double-sided part
        // does not cancel itself out.
        if (nSum.lengthSq() > 0 && n.dot(nSum) < 0) n.negate();
        nSum.add(n);
        pts.push(a, b, c);
    }
    if (!pts.length || nSum.lengthSq() < 1e-16) return null;
    const n = nSum.normalize();
    // A part facing down the model is most likely the back of a screen.
    if (n.z < -0.2 && Math.abs(n.y) < 0.9) n.negate();
    let up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(n.dot(up)) > 0.9) up = new THREE.Vector3(0, 0, -1);
    up.addScaledVector(n, -up.dot(n)).normalize();
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    let r0 = Infinity; let r1 = -Infinity; let s0 = Infinity; let s1 = -Infinity; let d = -Infinity;
    pts.forEach((p) => {
        const r = p.dot(right);
        const s = p.dot(up);
        r0 = Math.min(r0, r); r1 = Math.max(r1, r);
        s0 = Math.min(s0, s); s1 = Math.max(s1, s);
        d = Math.max(d, p.dot(n));
    });
    const at = (r, s) => right.clone().multiplyScalar(r).addScaledVector(up, s).addScaledVector(n, d).toArray().map((x) => Math.round(x * 1e5) / 1e5);
    return [at(r0, s1), at(r1, s1), at(r1, s0), at(r0, s0)];
}

// ---- The placed asset ----------------------------------------------------

export class PropModel {
    constructor(item, entry) {
        this.object = new THREE.Group();
        this.object.userData.itemId = item.id;
        this.norm = new THREE.Group();
        this.object.add(this.norm);
        this.item = item;
        this.entry = entry;
        this.op = { ...PROP_DEFAULTS, ...item.op };
        this.opacity = 1;
        this.materials = [];
        this.parts = [];
        this.mod = { input: 0, value: 0, flash: 0 };
        this.video = null;
        this.ready = false;
        this.onReady = null;
        this.load(entry);
    }

    async load(entry) {
        const token = {};
        this.loadToken = token;
        let res;
        try {
            res = await loadAssetGltf(entry.file);
        } catch (e) {
            this.error = e;
            return;
        }
        if (this.loadToken !== token || this.disposed) return;
        const scene = res.scene.clone(true);
        scene.traverse((o) => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const own = mats.map((m) => {
                const c = m.clone();
                c.userData.baseTransparent = c.transparent;
                c.userData.baseOpacity = c.opacity;
                this.materials.push(c);
                return c;
            });
            o.material = Array.isArray(o.material) ? own : own[0];
            o.frustumCulled = false;
            this.parts.push({ name: o.name || `Part ${this.parts.length + 1}`, mesh: o, material: (mats[0] && mats[0].name) || '' });
        });
        this.scene = scene;
        this.box = res.box.clone();
        this.norm.add(scene);
        this.ready = true;
        this.applyEntry(this.entry);
        this.sync(this.item, this.entry);
        this.onReady?.(this);
    }

    /** The library's sizing for this asset. */
    applyEntry(entry) {
        this.entry = entry;
        if (!this.box) return;
        const size = this.box.getSize(new THREE.Vector3());
        const s = (entry.size || 0.5) / Math.max(1e-6, size.x, size.y, size.z);
        const c = this.box.getCenter(new THREE.Vector3());
        this.norm.scale.setScalar(s);
        this.norm.position.set(-c.x * s, -this.box.min.y * s, -c.z * s);
        this.heightMetres = size.y * s;
    }

    get isScreen() { return this.entry.category === 'screen'; }

    get screenDef() { return { ...DEFAULT_SCREEN, ...(this.entry.screen || {}) }; }

    sync(item, entry) {
        this.item = item;
        const prevEntry = this.entry;
        if (entry && entry !== prevEntry) this.applyEntry(entry);
        this.op = { ...PROP_DEFAULTS, ...item.op, mod: { ...MOD_DEFAULTS, ...(item.op.mod || {}) } };
        if (!this.ready) return;
        const op = this.op;
        this.object.position.set(op.posX, op.posY, op.posZ);
        this.object.rotation.set(op.rotX * D2R, op.rotY * D2R, op.rotZ * D2R);
        this.applyScale(this.mod.value);
        this.scene.traverse((o) => {
            if (o.isMesh) { o.castShadow = !!op.castShadow; o.receiveShadow = true; }
        });
        this.syncScreen();
        this.setOpacity(this.opacity);
    }

    applyScale(value) {
        const op = this.op;
        const k = op.mod.source === 'off' ? 0 : op.reactAmount * value;
        const s = op.scale;
        this.object.scale.set(s * (1 + k * op.reactX), s * (1 + k * op.reactY), s * (1 + k * op.reactZ));
    }

    // ---- Screen ----

    syncScreen() {
        if (!this.isScreen) {
            this.dropScreen();
            return;
        }
        if (!this.video) {
            this.video = new ScreenVideo();
            this.video.onChange(() => { this.screenKey = null; this.syncScreen(); this.onReady?.(this); });
        }
        this.video.setSource(this.op.screenOn ? this.op.video : null);
        const def = this.screenDef;
        const op = this.op;
        const fit = op.fit || def.fit || 'cover';
        const aspect = this.video.aspect || 16 / 9;
        const key = JSON.stringify([def.corners, def.lift, fit, aspect, op.rotate, op.flipX, !!this.video.texture]);
        if (key !== this.screenKey) {
            this.screenKey = key;
            this.buildScreen(def, fit, aspect);
        }
        const tex = this.video.texture;
        const m = this.screenMat;
        if (m.map !== (tex || null)) { m.map = tex || null; m.needsUpdate = true; }
        m.color.setScalar(tex ? op.brightness : 0.02);
    }

    buildScreen(def, fit, aspect) {
        this.dropScreenMeshes();
        if (!this.screenMat) {
            this.screenMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
            this.backMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
            this.materials.push(this.screenMat, this.backMat);
            [this.screenMat, this.backMat].forEach((m) => {
                m.userData.baseTransparent = false;
                m.userData.baseOpacity = 1;
            });
        }
        const op = this.op;
        const layout = fitPicture(fit, quadAspect(def.corners), aspect, op.rotate, op.flipX);
        const lift = def.lift || 0;
        this.screenMesh = new THREE.Mesh(patchGeometry(def.corners, { ...layout, lift: lift * 1.5 }), this.screenMat);
        this.screenMesh.frustumCulled = false;
        this.screenMesh.renderOrder = 1;
        this.norm.add(this.screenMesh);
        if (fit === 'contain') {
            this.backMesh = new THREE.Mesh(patchGeometry(def.corners, { segs: 1, lift }), this.backMat);
            this.backMesh.frustumCulled = false;
            this.norm.add(this.backMesh);
        }
    }

    dropScreenMeshes() {
        [this.screenMesh, this.backMesh].forEach((m) => {
            if (!m) return;
            m.removeFromParent();
            m.geometry.dispose();
        });
        this.screenMesh = null;
        this.backMesh = null;
    }

    dropScreen() {
        this.dropScreenMeshes();
        this.screenKey = null;
        this.video?.dispose();
        this.video = null;
    }

    // ---- Per frame ----

    /**
     * `ctx`: `{ music, time }` - the decoded track and where it is (seconds),
     * which drive the pulse; `clock` and `playing` drive the screen.
     */
    update(dt, ctx = {}) {
        if (!this.ready) return;
        this.mod = modulate(this.op.mod, ctx.music, ctx.time);
        this.applyScale(this.mod.value);
        if (this.video && !ctx.exporting) this.video.sync(ctx.clock || 0, !!ctx.playing, this.op);
    }

    async exportFrame(clock) {
        if (!this.video || !this.screenMat) return;
        const tex = await this.video.exportFrame(clock, this.op);
        if (tex && this.screenMat.map !== tex) {
            this.screenMat.map = tex;
            this.screenMat.needsUpdate = true;
        }
    }

    async openExport() { await this.video?.openExport(); }

    closeExport() {
        this.video?.closeExport();
        if (this.screenMat && this.video) {
            this.screenMat.map = this.video.texture || null;
            this.screenMat.needsUpdate = true;
        }
    }

    setOpacity(v) {
        this.opacity = v;
        const a = Math.max(0, Math.min(1, v * (this.op.opacity ?? 1)));
        this.materials.forEach((m) => {
            const t = a < 1 || m.userData.baseTransparent;
            if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
            m.opacity = (m.userData.baseOpacity ?? 1) * a;
            m.depthWrite = a >= 1;
        });
        this.object.visible = a > 0.002;
    }

    dispose() {
        this.disposed = true;
        this.dropScreen();
        this.materials.forEach((m) => m.dispose());
        this.object.removeFromParent();
    }
}
