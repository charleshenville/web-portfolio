// Sackboy as a placed, posable model - the same deal as tetra's protagonist
// (lib/protagonist/poser.js) and driven by the same controls: a pose of
// per-joint angles edited by hand or with the viewport gizmo, presets, a head
// nod to a tempo or the track's kicks, breathing, planted feet by two-bone
// IK, and three ways to draw him (textured, wireframe, points).
//
// The difference is the rig. The protagonist is built procedurally; Sackboy
// is a skinned GLB with its own skeleton, whose bones point along their own X
// in the T-pose it was bound in. Angles here are therefore read in his body's
// frame rather than each bone's: X pitches about his left-right axis, Y turns
// about his up axis, Z rolls about his facing axis - the same everywhere on
// him - applied at the joint on top of the T-pose. A joint's frame then moves
// with its parent, as you would expect (bending the hip carries the knee's
// axes with the thigh).
//
// The wireframe and points are skinned on the CPU every frame from the same
// bones, so they stay glued to the cloth.

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadAssetGltf } from './props';
import { MOD_DEFAULTS, modulate } from './modulate';
import { mulberry32 } from '../protagonist/random';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const X = new THREE.Vector3(1, 0, 0);
const SIDES = [['L', 1], ['R', -1]]; // his left is +X

/** The pose editor's joints: [id, label, bone names]. Ids match the protagonist's where they mean the same. */
export const SACKBOY_JOINTS = [
    ['pelvis', 'Hips', ['Pelvis_5']],
    ['spine', 'Waist', ['Spine_1_23']],
    ['chest', 'Chest', ['Spine_4_26']],
    ['neck', 'Neck', ['Neck_0_86']],
    ['head', 'Head', ['Head_0_97']],
    ['jaw', 'Jaw', ['Facial_Jaw_110']],
    ['clavicleL', 'Left collar', ['Clavicle_L_30']],
    ['shoulderL', 'Left shoulder', ['Shoulder_L_31']],
    ['elbowL', 'Left elbow', ['Elbow_L_33']],
    ['handL', 'Left wrist', ['Wrist_L_35']],
    ['fingersL', 'Left fingers', ['F_Mid_1_L_38', 'F_Mid_2_L_39', 'F_Pointer_1_L_46', 'F_Pointer_2_L_47', 'F_Ring_1_L_50', 'F_Ring_2_L_51', 'F_Pinky_1_L_42', 'F_Pinky_2_L_43']],
    ['thumbL', 'Left thumb', ['F_Thumb_1_L_54', 'F_Thumb_2_L_55']],
    ['clavicleR', 'Right collar', ['Clavicle_R_58']],
    ['shoulderR', 'Right shoulder', ['Shoulder_R_59']],
    ['elbowR', 'Right elbow', ['Elbow_R_61']],
    ['handR', 'Right wrist', ['Wrist_R_63']],
    ['fingersR', 'Right fingers', ['F_Mid_1_R_66', 'F_Mid_2_R_67', 'F_Pointer_1_R_74', 'F_Pointer_2_R_75', 'F_Ring_1_R_78', 'F_Ring_2_R_79', 'F_Pinky_1_R_70', 'F_Pinky_2_R_71']],
    ['thumbR', 'Right thumb', ['F_Thumb_1_R_82', 'F_Thumb_2_R_83']],
    ['hipL', 'Left hip', ['Hip_L_6']],
    ['kneeL', 'Left knee', ['Knee_L_8']],
    ['ankleL', 'Left ankle', ['Ankle_L_10']],
    ['toeL', 'Left toes', ['Ball_L_12']],
    ['hipR', 'Right hip', ['Hip_R_14']],
    ['kneeR', 'Right knee', ['Knee_R_16']],
    ['ankleR', 'Right ankle', ['Ankle_R_18']],
    ['toeR', 'Right toes', ['Ball_R_20']],
];
const JOINT_IDS = SACKBOY_JOINTS.map(([id]) => id);
export const SACKBOY_JOINT_MENU = SACKBOY_JOINTS.map(([id, label]) => [id, label]);
export const SACKBOY_LEG_JOINTS = ['hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];

/** His height in the GLB's units, and the pelvis's height above his feet in the T-pose. */
const RAW_HEIGHT = 1.331;
const REST_HIP = 0.295;

const zero = () => Object.fromEntries(JOINT_IDS.map((j) => [j, [0, 0, 0]]));
/** Mirror an angle triple through his mid-plane (x -> -x). */
export const mirrorSackAngles = ([x, y, z]) => [x, -y, -z];
function sym(p, joint, r) {
    p[`${joint}L`] = [...r];
    p[`${joint}R`] = mirrorSackAngles(r);
}

/**
 * Presets. Angles in his body frame on top of the T-pose; `op` is the
 * pose's own settings: pelvis height above his root (GLB units, the T-pose
 * stands at 0.295) and planted feet.
 */
export const SACKBOY_POSES = {
    stand: {
        name: 'Stand',
        make: () => {
            const p = zero();
            sym(p, 'shoulder', [8, 0, -72]);
            sym(p, 'elbow', [0, -18, 0]);
            sym(p, 'fingers', [0, 0, -18]);
            p.head = [4, 0, 0];
            return { pose: p, op: { hipHeight: 0.29, hipForward: 0, plantFeet: true, footForward: 0.01, footSpread: 0.0 } };
        },
    },
    sit: {
        seated: true,
        name: 'Sit',
        make: () => {
            const p = zero();
            sym(p, 'hip', [-88, 0, -4]);
            sym(p, 'knee', [72, 0, 0]);
            sym(p, 'ankle', [10, 0, 0]);
            p.spine = [6, 0, 0];
            p.head = [10, 0, 0];
            // Hands resting on the knees.
            sym(p, 'shoulder', [-38, 0, -62]);
            sym(p, 'elbow', [0, -42, 0]);
            sym(p, 'hand', [0, 0, -20]);
            sym(p, 'fingers', [0, 0, -28]);
            return { pose: p, op: { hipHeight: 0.07, hipForward: 0, plantFeet: false } };
        },
    },
    swing: {
        seated: true,
        name: 'Perch',
        make: () => {
            const p = zero();
            sym(p, 'hip', [-80, 0, -10]);
            p.kneeL = [96, 0, 0];
            p.kneeR = [52, 0, 0];
            p.spine = [-8, 0, 0];
            p.chest = [-6, 0, 0];
            p.head = [-4, 0, 0];
            // Propped on his hands either side.
            sym(p, 'shoulder', [12, 0, -78]);
            sym(p, 'elbow', [0, 8, 0]);
            sym(p, 'hand', [0, 0, 70]);
            return { pose: p, op: { hipHeight: 0.07, hipForward: 0, plantFeet: false } };
        },
    },
    wave: {
        name: 'Wave',
        make: () => {
            const p = SACKBOY_POSES.stand.make().pose;
            p.shoulderR = [0, 0, -70];
            p.elbowR = [0, 0, -60];
            p.handR = [0, 0, 10];
            p.fingersR = [0, 0, 0];
            p.head = [0, -12, -6];
            return { pose: p, op: { hipHeight: 0.29, hipForward: 0, plantFeet: true, footForward: 0.01, footSpread: 0 } };
        },
    },
    cheer: {
        name: 'Cheer',
        make: () => {
            const p = SACKBOY_POSES.stand.make().pose;
            sym(p, 'shoulder', [-10, 0, 62]);
            sym(p, 'elbow', [0, -14, 0]);
            sym(p, 'fingers', [0, 0, 0]);
            p.head = [-12, 0, 0];
            p.jaw = [0, 0, 14];
            return { pose: p, op: { hipHeight: 0.29, hipForward: 0, plantFeet: true, footForward: 0.01, footSpread: 0.03 } };
        },
    },
};

export const SACKBOY_DEFAULTS = {
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 1,
    height: 0.45, // metres, standing
    opacity: 1,
    depthLayer: 'front',

    viewTextured: true,
    viewWire: false,
    viewPoints: false,
    selfOcclude: true,
    wireMode: 'all', // 'all' | 'feature'
    wireAngle: 25,
    wireColorMode: 'model',
    wireColor: '#ffd28a',
    wireThickness: 0.0012,
    pointColorMode: 'model',
    pointColor: '#f2f0e6',
    pointCount: 20000,
    pointSize: 0.0025,
    castShadow: true,

    hipHeight: 0.29,
    hipForward: 0,
    plantFeet: true,
    footForward: 0.01,
    footSpread: 0,
    breathe: 0.6,

    nodOn: false,
    nodMode: 'bpm',
    bpm: 96,
    nodDepth: 10,
    nodSharpness: 1.6,
    nodPhase: 0,
    nodEvery: 1,
    nodGroove: 0.35,
    nodSync: true,
    kickLow: 40,
    kickHigh: 130,
    kickThreshold: 0.85,
    kickGap: 0.18,
    nodRelease: 0.3,

    // The jaw drops with a slice of the track, as if he is singing along.
    mouthDepth: 18,
    mouth: { ...MOD_DEFAULTS, low: 300, high: 3000, smooth: 0.08 },
};

export function makeSackboyItem(id, overrides = {}, poseId = 'stand') {
    const made = SACKBOY_POSES[poseId].make();
    return {
        id,
        kind: 'model',
        modelId: 'sackboy',
        reactive: false,
        op: { ...SACKBOY_DEFAULTS, mouth: { ...SACKBOY_DEFAULTS.mouth }, ...made.op, ...overrides },
        pose: made.pose,
    };
}

export function reviveSackboy(raw, id) {
    const base = makeSackboyItem(id, {}, 'stand');
    return {
        ...base,
        op: { ...base.op, ...raw.op, mouth: { ...SACKBOY_DEFAULTS.mouth, ...(raw.op && raw.op.mouth) } },
        pose: { ...base.pose, ...raw.pose },
    };
}

// ---- Helpers ---------------------------------------------------------------

const e1 = new THREE.Euler();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const q3 = new THREE.Quaternion();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const m1 = new THREE.Matrix4();
const eulerQuat = (deg, out) => out.setFromEuler(e1.set((deg?.[0] ?? 0) * D2R, (deg?.[1] ?? 0) * D2R, (deg?.[2] ?? 0) * D2R, 'XYZ'));

/** Give a bone the world rotation `world`, under its current parent. */
function setWorldQuat(bone, world) {
    bone.parent.getWorldQuaternion(q3);
    bone.quaternion.copy(q3.invert()).multiply(world);
}

/** Linear to sRGB-decoded texel colour sampler for a material's base map. */
function texSampler(material) {
    const img = material?.map?.image;
    const tint = material?.color ? material.color.clone() : new THREE.Color(1, 1, 1);
    if (!img || !img.width) return () => tint.clone();
    const cv = document.createElement('canvas');
    cv.width = Math.min(256, img.width);
    cv.height = Math.min(256, img.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    try {
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
    } catch (e) {
        return () => tint.clone();
    }
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const flip = material.map.flipY;
    return (u, v) => {
        const x = Math.max(0, Math.min(cv.width - 1, Math.floor((((u % 1) + 1) % 1) * cv.width)));
        let yy = (((v % 1) + 1) % 1);
        if (flip) yy = 1 - yy;
        const y = Math.max(0, Math.min(cv.height - 1, Math.floor(yy * cv.height)));
        const o = (y * cv.width + x) * 4;
        return new THREE.Color().setRGB(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, THREE.SRGBColorSpace).multiply(tint);
    };
}

// ---- The model -------------------------------------------------------------

export class SackboyModel {
    constructor(item) {
        this.object = new THREE.Group();
        this.object.userData.itemId = item.id;
        this.norm = new THREE.Group();
        this.object.add(this.norm);
        this.item = item;
        this.op = { ...SACKBOY_DEFAULTS, ...item.op };
        this.pose = { ...zero(), ...item.pose };
        this.bones = {};
        this.handles = [];
        this.offsets = {};
        this.dragJoint = null;
        this.editing = false;
        this.activeJoint = null;
        this.opacity = 1;
        this.envDirty = false;
        this.gizmoSpace = 'world';
        this.inst = null;
        this.onReady = null;
        this.reset();
        this.load();
    }

    get needsEnv() { return false; }

    captureEnv() {}

    twitchNow() {}

    reset(seed = 0x5ac) {
        this.rand = mulberry32(seed);
        this.time = 0;
        this.clock = 0;
        this.kick = { level: 0, dip: 0, flash: 0 };
        this.mouth = { input: 0, value: 0, flash: 0 };
    }

    async load() {
        let res;
        try {
            res = await loadAssetGltf('sackboy.glb');
        } catch (e) {
            this.error = e;
            return;
        }
        if (this.disposed) return;
        const scene = cloneSkinned(res.scene);
        scene.updateMatrixWorld(true);
        this.scene = scene;
        this.materials = [];
        this.meshes = [];
        scene.traverse((o) => {
            if (!o.isSkinnedMesh) return;
            const m = o.material.clone();
            m.userData.baseTransparent = m.transparent;
            o.material = m;
            o.frustumCulled = false;
            this.materials.push(m);
            this.meshes.push(o);
        });
        // Bones by name, and each one's bind state: its own rotation, and
        // its rotation in the model's frame, from which body-frame angles
        // are carried to and from the bone's own.
        const byName = {};
        scene.traverse((o) => { if (o.isBone) byName[o.name] = o; });
        this.byName = byName;
        const inv = m1.copy(scene.matrixWorld).invert();
        const sceneQ = new THREE.Quaternion();
        scene.getWorldQuaternion(sceneQ).invert();
        this.bind = new Map();
        Object.values(byName).forEach((b) => {
            const w = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(sceneQ);
            this.bind.set(b, {
                local: b.quaternion.clone(),
                world: w,
                pre: b.quaternion.clone().multiply(w.clone().invert()),
                position: b.position.clone(),
                at: b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv),
            });
        });
        this.jointBones = {};
        SACKBOY_JOINTS.forEach(([id, , names]) => {
            const list = names.map((n) => byName[n]).filter(Boolean);
            this.jointBones[id] = list;
            if (list[0]) this.bones[id] = list[0];
        });
        const at = (n) => this.bind.get(byName[n]).at;
        this.len = {};
        SIDES.forEach(([n]) => {
            const hip = n === 'L' ? 'Hip_L_6' : 'Hip_R_14';
            const knee = n === 'L' ? 'Knee_L_8' : 'Knee_R_16';
            const ankle = n === 'L' ? 'Ankle_L_10' : 'Ankle_R_18';
            this.len[n] = {
                thigh: at(hip).distanceTo(at(knee)),
                shin: at(knee).distanceTo(at(ankle)),
                hipX: Math.abs(at(hip).x),
                ankleY: at(ankle).y,
            };
        });

        this.norm.add(scene);
        this.inst = { object: scene };
        this.buildSkinData();
        this.buildDepth();
        this.buildWire();
        this.buildPoints();
        this.buildHandles();
        this.ready = true;
        this.sync(this.item);
        this.onReady?.(this);
    }

    /** Every vertex of every part, in bind space, with its bones - for CPU skinning. */
    buildSkinData() {
        const boneIndex = new Map();
        const boneList = [];
        const inverses = [];
        const idx = (bone, inverse) => {
            if (!boneIndex.has(bone)) {
                boneIndex.set(bone, boneList.length);
                boneList.push(bone);
                inverses.push(inverse);
            }
            return boneIndex.get(bone);
        };
        const pos = [];
        const skin = [];
        const weight = [];
        const color = [];
        const uvs = [];
        const tris = [];
        const parts = [];
        let base = 0;
        this.meshes.forEach((mesh) => {
            const g = mesh.geometry;
            const P = g.attributes.position;
            const J = g.attributes.skinIndex;
            const W = g.attributes.skinWeight;
            const UV = g.attributes.uv;
            const sample = texSampler(mesh.material);
            const bm = mesh.bindMatrix;
            const v = new THREE.Vector3();
            for (let i = 0; i < P.count; i++) {
                v.fromBufferAttribute(P, i).applyMatrix4(bm);
                pos.push(v.x, v.y, v.z);
                const js = [J.getX(i), J.getY(i), J.getZ(i), J.getW(i)];
                const ws = [W.getX(i), W.getY(i), W.getZ(i), W.getW(i)];
                for (let k = 0; k < 4; k++) {
                    skin.push(idx(mesh.skeleton.bones[js[k]], mesh.skeleton.boneInverses[js[k]]));
                    weight.push(ws[k]);
                }
                const c = UV ? sample(UV.getX(i), UV.getY(i)) : new THREE.Color(1, 1, 1);
                color.push(c.r, c.g, c.b);
                if (UV) uvs.push(UV.getX(i), UV.getY(i)); else uvs.push(0, 0);
            }
            const I = g.index ? g.index.array : Array.from({ length: P.count }, (_, i) => i);
            const first = tris.length;
            for (let t = 0; t < I.length; t++) tris.push(base + I[t]);
            parts.push({ first, count: I.length, base, verts: P.count });
            base += P.count;
        });
        this.skin = {
            count: base,
            pos: Float32Array.from(pos),
            bone: Uint16Array.from(skin),
            weight: Float32Array.from(weight),
            color: Float32Array.from(color),
            tris: Uint32Array.from(tris),
            parts,
            bones: boneList,
            inverses,
            mats: boneList.map(() => new THREE.Matrix4()),
            out: new Float32Array(base * 3),
        };
    }

    /** Skin every vertex into the scene's own space. */
    skinVertices() {
        const S = this.skin;
        const inv = m1.copy(this.scene.matrixWorld).invert();
        for (let i = 0; i < S.bones.length; i++) S.mats[i].multiplyMatrices(inv, S.bones[i].matrixWorld).multiply(S.inverses[i]);
        const { pos, bone, weight, out } = S;
        for (let v = 0; v < S.count; v++) {
            const o = v * 3;
            const x = pos[o];
            const y = pos[o + 1];
            const z = pos[o + 2];
            let ox = 0; let oy = 0; let oz = 0;
            for (let k = 0; k < 4; k++) {
                const w = weight[v * 4 + k];
                if (w === 0) continue;
                const m = S.mats[bone[v * 4 + k]].elements;
                ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
                oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
                oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
            }
            out[o] = ox; out[o + 1] = oy; out[o + 2] = oz;
        }
    }

    buildDepth() {
        this.depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 8, polygonOffsetUnits: 64 });
        this.depthMeshes = this.meshes.map((m) => {
            const d = new THREE.SkinnedMesh(m.geometry, this.depthMaterial);
            d.bind(m.skeleton, m.bindMatrix);
            d.frustumCulled = false;
            d.renderOrder = -0.5;
            m.parent.add(d);
            return d;
        });
    }

    /** Edges: every triangle edge, or only creases sharper than `wireAngle` (and open borders). */
    buildWire() {
        if (this.lines) {
            this.lines.removeFromParent();
            this.lines.geometry.dispose();
            this.lineMaterial.dispose();
        }
        const S = this.skin;
        const op = this.op;
        const pairs = [];
        const seen = new Set();
        const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
        if (op.wireMode === 'feature') {
            // Weld by position within each part, so seams in the UVs do not
            // read as creases.
            const cos = Math.cos(op.wireAngle * D2R);
            S.parts.forEach((part) => {
                const weld = new Map();
                const canon = new Int32Array(part.verts);
                for (let i = 0; i < part.verts; i++) {
                    const o = (part.base + i) * 3;
                    const k = `${Math.round(S.pos[o] * 1e4)},${Math.round(S.pos[o + 1] * 1e4)},${Math.round(S.pos[o + 2] * 1e4)}`;
                    if (!weld.has(k)) weld.set(k, part.base + i);
                    canon[i] = weld.get(k);
                }
                const edges = new Map();
                const n = new THREE.Vector3();
                for (let t = part.first; t < part.first + part.count; t += 3) {
                    const ids = [0, 1, 2].map((k) => canon[S.tris[t + k] - part.base]);
                    v1.fromArray(S.pos, ids[0] * 3);
                    v2.fromArray(S.pos, ids[1] * 3).sub(v1);
                    v3.fromArray(S.pos, ids[2] * 3).sub(v1);
                    n.crossVectors(v2, v3).normalize();
                    for (let k = 0; k < 3; k++) {
                        const a = ids[k];
                        const b = ids[(k + 1) % 3];
                        if (a === b) continue;
                        const kk = key(a, b);
                        const e = edges.get(kk);
                        if (e) e.n2 = n.clone(); else edges.set(kk, { a, b, n1: n.clone(), n2: null });
                    }
                }
                edges.forEach((e) => {
                    if (!e.n2 || e.n1.dot(e.n2) < cos) pairs.push(e.a, e.b);
                });
            });
        } else {
            for (let t = 0; t < S.tris.length; t += 3) {
                for (let k = 0; k < 3; k++) {
                    const a = S.tris[t + k];
                    const b = S.tris[t + ((k + 1) % 3)];
                    const kk = key(a, b);
                    if (seen.has(kk)) continue;
                    seen.add(kk);
                    pairs.push(a, b);
                }
            }
        }
        this.edgePairs = Uint32Array.from(pairs);
        this.wireKey = `${op.wireMode}|${op.wireAngle}`;
        const count = pairs.length / 2;
        const g = new LineSegmentsGeometry();
        g.setPositions(new Float32Array(count * 6));
        const col = new Float32Array(count * 6);
        for (let i = 0; i < pairs.length; i++) col.set(S.color.subarray(pairs[i] * 3, pairs[i] * 3 + 3), i * 3);
        g.setColors(col);
        this.lineMaterial = new LineMaterial({ color: 0xffffff, linewidth: 1, transparent: true, vertexColors: true });
        this.lines = new LineSegments2(g, this.lineMaterial);
        this.lines.frustumCulled = false;
        this.scene.add(this.lines);
    }

    /** Points spread over the surface by area, seeded so they sit still between builds. */
    buildPoints() {
        if (this.points) {
            this.points.removeFromParent();
            this.points.geometry.dispose();
            this.pointMaterial.dispose();
        }
        const S = this.skin;
        const n = Math.max(500, Math.round(this.op.pointCount));
        const triCount = S.tris.length / 3;
        const cum = new Float64Array(triCount);
        let total = 0;
        for (let t = 0; t < triCount; t++) {
            v1.fromArray(S.pos, S.tris[t * 3] * 3);
            v2.fromArray(S.pos, S.tris[t * 3 + 1] * 3).sub(v1);
            v3.fromArray(S.pos, S.tris[t * 3 + 2] * 3).sub(v1);
            total += v2.cross(v3).length() / 2;
            cum[t] = total;
        }
        const rand = mulberry32(0x5ac9);
        const tri = new Uint32Array(n);
        const bary = new Float32Array(n * 2);
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const r = rand() * total;
            let lo = 0;
            let hi = triCount - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (cum[mid] < r) lo = mid + 1; else hi = mid;
            }
            let a = rand();
            let b = rand();
            if (a + b > 1) { a = 1 - a; b = 1 - b; }
            tri[i] = lo;
            bary[i * 2] = a;
            bary[i * 2 + 1] = b;
            const i0 = S.tris[lo * 3];
            const i1 = S.tris[lo * 3 + 1];
            const i2 = S.tris[lo * 3 + 2];
            for (let k = 0; k < 3; k++) col[i * 3 + k] = S.color[i0 * 3 + k] * (1 - a - b) + S.color[i1 * 3 + k] * a + S.color[i2 * 3 + k] * b;
        }
        this.pointSample = { tri, bary, n };
        this.pointKey = this.op.pointCount;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.pointMaterial = new THREE.PointsMaterial({ size: 0.006, sizeAttenuation: true, vertexColors: true, transparent: true });
        this.points = new THREE.Points(g, this.pointMaterial);
        this.points.frustumCulled = false;
        this.scene.add(this.points);
    }

    buildHandles() {
        this.handleGeo = new THREE.OctahedronGeometry(0.022, 0);
        this.handles = JOINT_IDS.filter((j) => this.bones[j]).map((j) => {
            const m = new THREE.Mesh(this.handleGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85, toneMapped: false,
            }));
            m.renderOrder = 1000;
            m.userData.joint = j;
            m.userData.handle = true;
            m.visible = false;
            // Markers are sized in his units; the bones' own scale is 1.
            this.bones[j].add(m);
            return m;
        });
        this.setEditing(this.editing, this.activeJoint);
    }

    // ---- Parameters ----

    sync(item) {
        this.item = item;
        this.op = { ...SACKBOY_DEFAULTS, ...item.op, mouth: { ...SACKBOY_DEFAULTS.mouth, ...(item.op.mouth || {}) } };
        this.pose = { ...zero(), ...item.pose };
        const op = this.op;
        this.object.position.set(op.posX, op.posY, op.posZ);
        this.object.rotation.set(op.rotX * D2R, op.rotY * D2R, op.rotZ * D2R);
        this.object.scale.setScalar(op.scale);
        this.k = op.height / RAW_HEIGHT;
        this.norm.scale.setScalar(this.k);
        if (!this.ready) return;
        if (`${op.wireMode}|${op.wireAngle}` !== this.wireKey) this.buildWire();
        if (op.pointCount !== this.pointKey) this.buildPoints();
        this.applyView();
    }

    applyView() {
        const op = this.op;
        const hull = !!op.viewTextured;
        const overlay = !!op.viewWire || !!op.viewPoints;
        this.meshes.forEach((m) => {
            m.visible = hull;
            m.castShadow = !!op.castShadow;
            m.receiveShadow = true;
        });
        this.depthMeshes.forEach((d) => {
            d.visible = !hull && overlay && op.selfOcclude;
            d.castShadow = !hull && !!op.castShadow;
        });
        this.materials.forEach((m) => {
            if (m.polygonOffset !== (hull && overlay)) {
                m.polygonOffset = hull && overlay;
                m.polygonOffsetFactor = 8;
                m.polygonOffsetUnits = 64;
                m.needsUpdate = true;
            }
        });
        this.lines.visible = !!op.viewWire;
        this.points.visible = !!op.viewPoints;
        const lm = this.lineMaterial;
        const wireModel = op.wireColorMode === 'model';
        if (lm.vertexColors !== wireModel) { lm.vertexColors = wireModel; lm.needsUpdate = true; }
        lm.color.set(wireModel ? '#ffffff' : op.wireColor);
        const pm = this.pointMaterial;
        const ptModel = op.pointColorMode === 'model';
        if (pm.vertexColors !== ptModel) { pm.vertexColors = ptModel; pm.needsUpdate = true; }
        pm.color.set(ptModel ? '#ffffff' : op.pointColor);
        // Perspective point sizes are in view space, so metres whatever his scale.
        pm.size = op.pointSize;
        this.setOpacity(this.opacity);
    }

    setOpacity(v) {
        this.opacity = v;
        if (!this.ready) return;
        const a = Math.max(0, Math.min(1, v * (this.op.opacity ?? 1)));
        [...this.materials, this.pointMaterial, this.lineMaterial].forEach((m) => {
            const t = a < 1 || m === this.lineMaterial || m === this.pointMaterial || m.userData.baseTransparent;
            if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
            m.opacity = a;
            m.depthWrite = a >= 1 && m !== this.lineMaterial;
        });
        this.object.visible = a > 0.002;
    }

    setEditing(on, active = null) {
        this.editing = on;
        this.activeJoint = active;
        this.handles.forEach((h) => {
            h.visible = on;
            const j = h.userData.joint;
            h.material.color.set(j === active ? '#ffb347' : (/L$/.test(j) ? '#8fd3ff' : /R$/.test(j) ? '#ff9fb2' : '#ffffff'));
            h.scale.setScalar(j === active ? 1.5 : 1);
        });
    }

    hideHandles(hidden) {
        this.handles.forEach((h) => { h.visible = !hidden && this.editing; });
    }

    // ---- Pose <-> bones ----

    /** A bone's rotation for body-frame angles `R` (a quaternion) on top of its bind. */
    boneQuat(bone, R, out) {
        const b = this.bind.get(bone);
        return out.copy(b.pre).multiply(R).multiply(b.world);
    }

    /** Body-frame angles (degrees, XYZ) the bone is at now, the procedural layer taken back out. */
    jointAngles(j) {
        const bone = this.bones[j];
        if (!bone) return [0, 0, 0];
        const b = this.bind.get(bone);
        const R = q1.copy(b.pre).invert().multiply(bone.quaternion).multiply(q2.copy(b.world).invert());
        const off = this.offsets[j];
        if (off) R.multiply(q2.copy(off).invert());
        e1.setFromQuaternion(R, 'XYZ');
        const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
        const a = [e1.x / D2R, e1.y / D2R, e1.z / D2R];
        const alt = [wrap(a[0] + 180), wrap(180 - a[1]), wrap(a[2] + 180)];
        const prev = this.pose[j] || [0, 0, 0];
        const dist = (t) => t.reduce((s, v, i) => s + Math.abs(wrap(v - prev[i])), 0);
        const r = (v) => Math.round(v * 10) / 10;
        return (dist(alt) < dist(a) ? alt : a).map(r);
    }

    captureLegs() {
        return Object.fromEntries(SACKBOY_LEG_JOINTS.map((j) => [j, this.jointAngles(j)]));
    }

    // ---- Per frame ----

    kickDip(ctx) {
        const op = this.op;
        const k = this.kick;
        const K = ctx.kick;
        if (!K || !K.hits || !K.hits.length || K.hits[0] > K.time) {
            k.level = K ? K.level : 0;
            k.flash = 0;
            k.dip = 0;
            return 0;
        }
        const H = K.hits;
        const t = K.time;
        k.level = K.level;
        let lo = 0;
        let hi = H.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (H[mid] <= t) lo = mid; else hi = mid - 1;
        }
        k.flash = Math.max(0, 1 - (t - H[lo]) * 5);
        const N = Math.max(1, Math.round(op.nodEvery));
        const j = lo - (lo % N);
        const attack = 0.05;
        const release = Math.max(0.05, op.nodRelease);
        const ease = (u) => u * u * (3 - 2 * u);
        const shape = (since, from) => {
            if (since < attack) return from + (1 - from) * ease(since / attack);
            return 1 - ease(Math.min(1, (since - attack) / release));
        };
        const from = j - N >= 0 ? shape(H[j] - H[j - N], 0) : 0;
        k.dip = shape(t - H[j], from);
        return k.dip;
    }

    /**
     * Advance `dt` seconds. `ctx`: `{ beatTime, kick, music, musicTime,
     * drawWidth, drawHeight }`, as the protagonist gets, plus the decoded
     * track and where it is for the singing jaw.
     */
    update(dt, ctx = {}) {
        if (!this.ready) return;
        const op = this.op;
        const drag = this.dragJoint;
        this.time += dt;
        this.clock += dt;

        // Procedural layers, in the body frame, on top of the pose.
        const offs = {};
        const addOff = (j, axis, angle) => {
            if (j === drag || !angle) return;
            const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            offs[j] = offs[j] ? offs[j].multiply(q) : q;
        };
        addOff('chest', X, 0.02 * Math.sin(this.time * 1.7) * op.breathe);
        const kickDip = op.nodMode === 'kick' ? this.kickDip(ctx) : 0;
        if (op.nodOn && (op.nodMode === 'kick' || op.bpm > 0)) {
            let dip = kickDip;
            if (op.nodMode !== 'kick') {
                const t = ctx.beatTime ?? this.clock;
                const beats = (t * op.bpm) / 60 / Math.max(1, op.nodEvery) - op.nodPhase;
                const p = beats - Math.floor(beats);
                dip = Math.pow(0.5 + 0.5 * Math.cos(TAU * p), op.nodSharpness);
            }
            // Down is forward: he faces +Z, so a positive pitch tips him over.
            const nod = op.nodDepth * D2R * dip;
            addOff('neck', X, nod * 0.35);
            addOff('head', X, nod * 0.65);
            if (op.nodGroove > 0) {
                addOff('spine', X, nod * 0.12 * op.nodGroove);
                addOff('chest', X, nod * 0.2 * op.nodGroove);
            }
        }
        this.mouth = modulate(op.mouth, ctx.music, ctx.musicTime);
        if (op.mouth.source !== 'off') addOff('jaw', new THREE.Vector3(0, 0, 1), op.mouthDepth * D2R * this.mouth.value);
        this.offsets = offs;

        const R = new THREE.Quaternion();
        SACKBOY_JOINTS.forEach(([j]) => {
            const list = this.jointBones[j];
            if (!list || !list.length) return;
            eulerQuat(this.pose[j], R);
            if (offs[j]) R.multiply(offs[j]);
            list.forEach((bone, i) => {
                if (i === 0 && j === drag) return;
                this.boneQuat(bone, R, bone.quaternion);
            });
        });

        // The hips: height above his root and how far forward, in his frame.
        const pelvis = this.bones.pelvis;
        this.scene.updateMatrixWorld(true);
        if (pelvis) {
            const want = this.scene.localToWorld(v1.set(0, op.hipHeight, op.hipForward + this.bind.get(pelvis).at.z));
            pelvis.position.copy(pelvis.parent.worldToLocal(want));
        }
        this.scene.updateMatrixWorld(true);
        if (op.plantFeet) this.plantFeet();

        if (op.viewWire || op.viewPoints) this.skinVertices();
        if (op.viewWire) {
            this.skinLines();
            if (ctx.drawHeight) {
                this.lineMaterial.resolution.set(ctx.drawWidth, ctx.drawHeight);
                this.lineMaterial.linewidth = Math.max(0.5, op.wireThickness * ctx.drawHeight);
            }
        }
        if (op.viewPoints) this.skinPoints();
    }

    /** Two-bone IK for each leg onto a foot planted on his floor. */
    plantFeet() {
        const op = this.op;
        const rootQ = this.scene.getWorldQuaternion(new THREE.Quaternion());
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ);
        SIDES.forEach(([n, side]) => {
            if ([`hip${n}`, `knee${n}`, `ankle${n}`].includes(this.dragJoint)) return;
            const hip = this.bones[`hip${n}`];
            const knee = this.bones[`knee${n}`];
            const ankle = this.bones[`ankle${n}`];
            if (!hip || !knee || !ankle) return;
            const L = this.len[n];
            const target = this.scene.localToWorld(new THREE.Vector3(side * (L.hipX + op.footSpread), L.ankleY, op.footForward));
            const scale = this.scene.getWorldScale(new THREE.Vector3()).x;
            const l1 = L.thigh * scale;
            const l2 = L.shin * scale;
            const H = hip.getWorldPosition(new THREE.Vector3());
            const dir = target.clone().sub(H);
            const d = Math.min(l1 + l2 - 1e-5, Math.max(Math.abs(l1 - l2) + 1e-4, dir.length()));
            dir.normalize();
            const pole = forward.clone().addScaledVector(dir, -forward.dot(dir));
            if (pole.lengthSq() < 1e-8) pole.copy(forward);
            pole.normalize();
            const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
            const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
            const kneeAt = H.clone().addScaledVector(dir, a).addScaledVector(pole, h);
            // Swing the thigh so the knee lands there, then the shin onto the foot.
            const K = knee.getWorldPosition(new THREE.Vector3());
            const swing1 = new THREE.Quaternion().setFromUnitVectors(K.sub(H).normalize(), kneeAt.clone().sub(H).normalize());
            setWorldQuat(hip, swing1.multiply(hip.getWorldQuaternion(new THREE.Quaternion())));
            hip.updateMatrixWorld(true);
            const K2 = knee.getWorldPosition(new THREE.Vector3());
            const A = ankle.getWorldPosition(new THREE.Vector3());
            const swing2 = new THREE.Quaternion().setFromUnitVectors(A.sub(K2).normalize(), target.clone().sub(K2).normalize());
            setWorldQuat(knee, swing2.multiply(knee.getWorldQuaternion(new THREE.Quaternion())));
            knee.updateMatrixWorld(true);
            // Foot flat on his floor, turned by the ankle's pose.
            const b = this.bind.get(ankle);
            const flat = rootQ.clone().multiply(eulerQuat(this.pose[`ankle${n}`], q1)).multiply(b.world);
            setWorldQuat(ankle, flat);
            ankle.updateMatrixWorld(true);
        });
    }

    skinLines() {
        const data = this.lines.geometry.attributes.instanceStart.data;
        const out = data.array;
        const src = this.skin.out;
        const P = this.edgePairs;
        for (let i = 0; i < P.length; i++) {
            const s = P[i] * 3;
            out[i * 3] = src[s];
            out[i * 3 + 1] = src[s + 1];
            out[i * 3 + 2] = src[s + 2];
        }
        data.needsUpdate = true;
    }

    skinPoints() {
        const attr = this.points.geometry.attributes.position;
        const out = attr.array;
        const src = this.skin.out;
        const T = this.skin.tris;
        const { tri, bary, n } = this.pointSample;
        for (let i = 0; i < n; i++) {
            const t = tri[i] * 3;
            const a = bary[i * 2];
            const b = bary[i * 2 + 1];
            const c = 1 - a - b;
            const i0 = T[t] * 3;
            const i1 = T[t + 1] * 3;
            const i2 = T[t + 2] * 3;
            out[i * 3] = src[i0] * c + src[i1] * a + src[i2] * b;
            out[i * 3 + 1] = src[i0 + 1] * c + src[i1 + 1] * a + src[i2 + 1] * b;
            out[i * 3 + 2] = src[i0 + 2] * c + src[i1 + 2] * a + src[i2 + 2] * b;
        }
        attr.needsUpdate = true;
    }

    dispose() {
        this.disposed = true;
        if (this.ready) {
            this.handles.forEach((h) => { h.removeFromParent(); h.material.dispose(); });
            this.handleGeo?.dispose();
            this.materials.forEach((m) => m.dispose());
            this.depthMaterial.dispose();
            this.lines.geometry.dispose();
            this.lineMaterial.dispose();
            this.points.geometry.dispose();
            this.pointMaterial.dispose();
        }
        this.object.removeFromParent();
    }
}

/** The pose a preset makes, for the host's preset buttons. */
export function sackboyPreset(id) {
    return SACKBOY_POSES[id]?.make();
}

/** The T-pose hip height, for anyone placing him by hand. */
export const SACKBOY_REST_HIP = REST_HIP;
