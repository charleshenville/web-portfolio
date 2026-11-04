// The protagonist as a placed object in the Scan Compositor.
//
// tetra animates him from what a player is doing (walking, aiming, sliding);
// none of that means anything on a bench, so this drives the same rig from a
// pose instead: an angle per joint, edited by hand, with three procedural
// layers on top of it - the ears' springs and twitches (as in the game), a
// head nod locked to a tempo, and a little breathing. The legs can be solved
// onto planted feet with the game's two-bone IK, so moving the hips keeps the
// feet on the ground.
//
// Three ways to draw him: the game's own textured hull, a wireframe of every
// part's feature edges, or a point cloud sampled over the surface. The rig is
// skinned rigidly (every vertex follows exactly one bone), so the edges and
// points are skinned on the CPU each frame, which is a handful of matrix
// multiplies per vertex and keeps them in step with the mesh.

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { buildProtagonist, bodyDims } from './model.js';
import { HULL_TEXTURE, hullTexture, instantiate, metalEnvironment } from './rig.js';
import { SLOTS } from './parts.js';
import { PROTAGONIST_SPEC, RARITY_COLOURS } from './spec.js';
import { mulberry32 } from './random.js';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const SIDES = [
    ['L', -1],
    ['R', 1],
];

/** Ears: spring stiffness and damping, and a twitch's flicks (share of its kick, seconds after it starts). As in the game. */
const EAR_K = 620;
const EAR_C = 13;
const TWITCH = [
    [1, 0],
    [-0.65, 0.085],
    [0.4, 0.16],
    [-0.2, 0.23],
];

/** Joints the pose editor exposes, in the order the menu lists them. */
export const JOINTS = [
    ['pelvis', 'Hips'],
    ['spine', 'Waist'],
    ['chest', 'Chest'],
    ['neck', 'Neck'],
    ['head', 'Head'],
    ['earL', 'Left ear'],
    ['earR', 'Right ear'],
    ['shoulderL', 'Left shoulder'],
    ['elbowL', 'Left elbow'],
    ['handL', 'Left wrist'],
    ['fingersL', 'Left fingers'],
    ['thumbL', 'Left thumb'],
    ['shoulderR', 'Right shoulder'],
    ['elbowR', 'Right elbow'],
    ['handR', 'Right wrist'],
    ['fingersR', 'Right fingers'],
    ['thumbR', 'Right thumb'],
    ['hipL', 'Left hip'],
    ['kneeL', 'Left knee'],
    ['ankleL', 'Left ankle'],
    ['toeL', 'Left toes'],
    ['hipR', 'Right hip'],
    ['kneeR', 'Right knee'],
    ['ankleR', 'Right ankle'],
    ['toeR', 'Right toes'],
];
const JOINT_IDS = JOINTS.map(([id]) => id);
/** What planting the feet takes over. */
export const LEG_JOINTS = ['hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];

/** A joint's counterpart on the other side, or null. */
export const mirrorJoint = (j) => (/L$/.test(j) ? `${j.slice(0, -1)}R` : /R$/.test(j) ? `${j.slice(0, -1)}L` : null);

/** An XYZ Euler (degrees) reflected through the body's mid-plane. */
export const mirrorAngles = ([x, y, z]) => [x, -y, -z];

const zero = () => Object.fromEntries(JOINT_IDS.map((j) => [j, [0, 0, 0]]));

/** Both sides at once: `{ shoulder: [x, y, z] }` sets L and R, mirrored. */
function sym(pose, joint, r) {
    pose[`${joint}R`] = [...r];
    pose[`${joint}L`] = mirrorAngles(r);
}

/**
 * Named poses. Each returns `{ pose, op }`: joint angles (degrees, XYZ, on
 * top of the bind pose: standing, arms hanging, palms in) and the pose's
 * own settings - hip height and planted feet. `dims` are the body's
 * proportions (see bodyDims), so a taller build stands taller.
 */
export const POSES = {
    sit: {
        seated: true,
        name: 'Sit',
        make: () => {
            const p = zero();
            p.spine = [-6, 0, 0];
            p.chest = [-8, 0, 0];
            p.neck = [2, 0, 0];
            p.head = [-4, 0, 0];
            // Hands resting on the thighs, palms down.
            sym(p, 'shoulder', [8, 0, -10]);
            sym(p, 'elbow', [51, 0, 0]);
            sym(p, 'hand', [0, 85, 0]);
            sym(p, 'fingers', [0, 0, -30]);
            sym(p, 'thumb', [-10, 0, -15]);
            sym(p, 'ear', [0, 0, 3.4]);
            return { pose: p, op: { hipHeight: 0.59, hipForward: 0, plantFeet: true, footForward: 0.38, footSpread: 0.07 } };
        },
    },
    lounge: {
        seated: true,
        name: 'Lounge',
        make: () => {
            const p = zero();
            p.pelvis = [6, 0, 0];
            p.spine = [6, 0, 0];
            p.chest = [5, 0, 0];
            p.head = [-6, 0, 0];
            // Propped on the seat, hands flat beside the hips.
            sym(p, 'shoulder', [-16, 0, 10]);
            sym(p, 'elbow', [30, 0, 0]);
            sym(p, 'hand', [0, 0, 75]);
            sym(p, 'fingers', [0, 0, -10]);
            sym(p, 'ear', [0, 0, 3.4]);
            return { pose: p, op: { hipHeight: 0.58, hipForward: -0.04, plantFeet: true, footForward: 0.6, footSpread: 0.12 } };
        },
    },
    leanIn: {
        seated: true,
        name: 'Lean in',
        make: () => {
            const p = zero();
            p.spine = [-12, 0, 0];
            p.chest = [-14, 0, 0];
            p.neck = [8, 0, 0];
            p.head = [14, 0, 0];
            // Forearms out over the knees, hands loose in front.
            sym(p, 'shoulder', [45, 10, -12]);
            sym(p, 'elbow', [42, -40, 0]);
            sym(p, 'hand', [0, 60, 0]);
            sym(p, 'fingers', [0, 0, -45]);
            sym(p, 'ear', [0, 0, 3.4]);
            return { pose: p, op: { hipHeight: 0.59, hipForward: 0.02, plantFeet: true, footForward: 0.34, footSpread: 0.1 } };
        },
    },
    stand: {
        name: 'Stand',
        make: (dims) => {
            const p = zero();
            sym(p, 'shoulder', [2, 0, 4]);
            sym(p, 'elbow', [8, 0, 0]);
            sym(p, 'fingers', [0, 0, -25]);
            sym(p, 'ear', [0, 0, 3.4]);
            const k = dims.scale;
            return { pose: p, op: { hipHeight: dims.pelvis * k * 0.985, hipForward: 0, plantFeet: true, footForward: 0.02, footSpread: 0.02 } };
        },
    },
};

/** Per-model parameters: one copy per placed protagonist. */
export const MODEL_DEFAULTS = {
    // Placement, in the scan's units (a scan is metric, so 1 = life size).
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 1,
    opacity: 1,

    // How he is drawn: any mix of the textured hull, the wireframe and the
    // point cloud.
    viewTextured: true,
    viewWire: false,
    viewPoints: false,
    // Hidden-surface removal for the wire and point views without the hull: a
    // depth-only copy of the body is laid down first, so only the near side
    // shows. (With the hull on, the hull itself does that.)
    selfOcclude: true,
    wireColorMode: 'model', // 'model' | 'solid'
    wireColor: '#9fd8ff',
    wireThickness: 0.0016, // fraction of frame height, like the scan's
    pointColorMode: 'model',
    pointColor: '#f2f0e6',
    pointCount: 24000,
    pointSize: 0.014,

    // Pose: the hips' height above his feet (metres before scale), how far
    // they slide forward, and where the planted feet go.
    hipHeight: 0.59,
    hipForward: 0,
    plantFeet: true,
    footForward: 0.38,
    footSpread: 0.07,
    breathe: 0.6,

    // Nod: down on every `nodEvery` beats at `bpm`, `nodPhase` beats late;
    // or, in 'kick' mode, on every `nodEvery`th kick the track plays.
    nodOn: false,
    nodMode: 'bpm', // 'bpm' | 'kick'
    bpm: 96,
    nodDepth: 12,
    nodSharpness: 1.6,
    nodPhase: 0,
    nodEvery: 1,
    nodGroove: 0.35,
    // Read the beat off the loaded track's clock, so the nod stays on the
    // music through pauses and seeks; otherwise a free-running clock.
    nodSync: true,
    // Kick: the band it lives in (Hz), the level that counts as a hit, the
    // shortest gap between two hits, and how long the head takes to come
    // back up after one.
    kickLow: 40,
    kickHigh: 130,
    kickThreshold: 0.85,
    kickGap: 0.18,
    nodRelease: 0.3,

    // Ears.
    twitchOn: true,
    twitchEvery: 3.5,
    twitchStrength: 1,
    earBounce: 1,

    // Body, frame colours and the five parts (-1 = stock, else a rarity).
    height: PROTAGONIST_SPEC.body.height,
    build: 1,
    shoulders: 1,
    headSize: 1,
    arms: 1,
    legs: 1,
    torso: 1,
    hull: PROTAGONIST_SPEC.look.hull,
    trim: PROTAGONIST_SPEC.look.trim,
    joint: PROTAGONIST_SPEC.look.joint,
    dark: PROTAGONIST_SPEC.look.dark,
    light: PROTAGONIST_SPEC.look.light,
    ears: -1,
    visor: -1,
    armor: -1,
    hydraulics: -1,
    processor: -1,

    // The hull's finish (tetra's [texture]): a tiling noise texture over the
    // colours, its highlight, and a share of reflection - of the scan around
    // him ('scan', captured from where he stands) or of tetra's banded sky.
    texRepeat: PROTAGONIST_SPEC.texture.repeat,
    texStrength: PROTAGONIST_SPEC.texture.strength,
    texPeriodX: PROTAGONIST_SPEC.texture.period[0],
    texPeriodY: PROTAGONIST_SPEC.texture.period[1],
    texOctaves: PROTAGONIST_SPEC.texture.octaves,
    texPersistence: PROTAGONIST_SPEC.texture.persistence,
    texContrast: PROTAGONIST_SPEC.texture.contrast,
    texLevels: PROTAGONIST_SPEC.texture.levels,
    texResolution: PROTAGONIST_SPEC.texture.resolution,
    texDither: PROTAGONIST_SPEC.texture.dither,
    shininess: PROTAGONIST_SPEC.texture.shininess,
    specular: PROTAGONIST_SPEC.texture.specular,
    reflectivity: PROTAGONIST_SPEC.texture.reflectivity,
    reflectSource: 'scan',
    castShadow: true,
};

/** The finish as the menu edits it, after tetra's HULL_FIELDS: [key, label, min, max, step]. */
export const FINISH_FIELDS = [
    ['reflectivity', 'Reflect', 0, 1, 0.01],
    ['shininess', 'Shininess', 1, 200, 1],
    ['specular', 'Specular', 0, 1, 0.01],
];
export const TEXTURE_FIELDS = [
    ['texRepeat', 'Tile (m)', 0.25, 12, 0.05],
    ['texStrength', 'Strength', 0, 1, 0.01],
    ['texPeriodX', 'Period X', 1, 16, 1],
    ['texPeriodY', 'Period Y', 1, 16, 1],
    ['texOctaves', 'Octaves', 1, 8, 1],
    ['texPersistence', 'Persist', 0, 1, 0.01],
    ['texContrast', 'Contrast', 0, 4, 0.05],
    ['texLevels', 'Greys', 2, 16, 1],
    ['texResolution', 'Pixels', 8, 256, 8],
];

/**
 * An item's parameters from before the views could be mixed, when there was
 * one `view` ('textured' | 'wire' | 'points'), brought up to date.
 */
export function migrateModelOp(op = {}) {
    if (op.view === undefined || op.viewTextured !== undefined) return op;
    const { view, ...rest } = op;
    return { ...rest, viewTextured: view === 'textured', viewWire: view === 'wire', viewPoints: view === 'points' };
}

/** Body proportions as the menu edits them: [key, label, min, max, step]. */
export const BODY_FIELDS = [
    ['height', 'Height (m)', 1.2, 2.6, 0.01],
    ['build', 'Build', 0.7, 1.5, 0.01],
    ['shoulders', 'Shoulders', 0.8, 1.4, 0.01],
    ['headSize', 'Head', 0.7, 1.4, 0.01],
    ['arms', 'Arms', 0.85, 1.2, 0.01],
    ['legs', 'Legs', 0.8, 1.25, 0.01],
    ['torso', 'Torso', 0.6, 1.8, 0.01],
];
export const COLOUR_FIELDS = [
    ['hull', 'Hull'],
    ['trim', 'Trim'],
    ['joint', 'Joints'],
    ['dark', 'Dark'],
    ['light', 'Lights'],
];

/** The tetra spec an item's parameters describe. */
export function specOf(op) {
    return {
        ...PROTAGONIST_SPEC,
        body: { height: op.height, build: op.build, shoulders: op.shoulders, head: op.headSize, arms: op.arms, legs: op.legs, torso: op.torso ?? 1 },
        look: { hull: op.hull, trim: op.trim, joint: op.joint, dark: op.dark, light: op.light },
        texture: {
            ...HULL_TEXTURE,
            ...PROTAGONIST_SPEC.texture,
            period: [Math.round(op.texPeriodX), Math.round(op.texPeriodY)],
            octaves: Math.round(op.texOctaves),
            persistence: op.texPersistence,
            contrast: op.texContrast,
            resolution: Math.round(op.texResolution / 8) * 8 || 8,
            levels: Math.round(op.texLevels),
            dither: !!op.texDither,
            repeat: op.texRepeat,
            strength: op.texStrength,
            shininess: op.shininess,
            specular: op.specular,
            reflectivity: op.reflectivity,
        },
    };
}
export const loadoutOf = (op) => SLOTS.map((s) => (Number.isFinite(op[s]) ? op[s] : -1));
/** Changes to anything in here mean a rebuild. */
const buildKey = (op) => JSON.stringify([specOf(op).body, specOf(op).look, loadoutOf(op)]);

/** A new placed protagonist, posed. */
export function makeModelItem(id, overrides = {}, poseId = 'sit') {
    const op = { ...MODEL_DEFAULTS, ...overrides };
    const made = POSES[poseId].make(bodyDims(specOf(op).body));
    return {
        id,
        kind: 'model',
        modelId: 'protagonist',
        reactive: false,
        op: { ...op, ...made.op, ...overrides },
        pose: made.pose,
    };
}

// ---- IK (from tetra's protagonist.js) --------------------------------------

const ik = {
    s: new THREE.Vector3(), dir: new THREE.Vector3(), perp: new THREE.Vector3(), e: new THREE.Vector3(),
    d1: new THREE.Vector3(), d2: new THREE.Vector3(), axis: new THREE.Vector3(), q: new THREE.Quaternion(), ql: new THREE.Quaternion(),
};
const m1 = new THREE.Matrix4();
const q3 = new THREE.Quaternion();

function frameQuat(down, axis, out) {
    const y = new THREE.Vector3().copy(down).negate();
    const x = new THREE.Vector3().copy(axis).addScaledVector(y, -axis.dot(y)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return out.setFromRotationMatrix(m1.makeBasis(x, y, z));
}

function setFrame(bone, down, axis, out) {
    frameQuat(down, axis, out);
    bone.parent.getWorldQuaternion(q3);
    bone.quaternion.copy(q3.invert()).multiply(out);
    return out;
}

function setWorldQuat(bone, world) {
    bone.parent.getWorldQuaternion(q3);
    bone.quaternion.copy(q3.invert()).multiply(world);
}

/** Two-bone chain `u` -> `l` reaching `target` (world), bending towards `pole`; `flip` for knees. */
function solveLimb(u, l, lenU, lenL, target, pole, flip = false) {
    const S = u.getWorldPosition(ik.s);
    const dir = ik.dir.subVectors(target, S);
    const dist = Math.min(lenU + lenL - 1e-4, Math.max(Math.abs(lenU - lenL) + 1e-3, dir.length()));
    dir.normalize();
    const perp = ik.perp.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (perp.lengthSq() < 1e-8) perp.set(0, 0, -1).addScaledVector(dir, dir.z);
    perp.normalize();
    const a = (lenU * lenU - lenL * lenL + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, lenU * lenU - a * a));
    const e = ik.e.copy(dir).multiplyScalar(a).addScaledVector(perp, h);
    const d1 = ik.d1.copy(e).normalize();
    const d2 = ik.d2.copy(dir).multiplyScalar(dist).sub(e).normalize();
    const axis = flip ? ik.axis.crossVectors(dir, perp) : ik.axis.crossVectors(perp, dir);
    axis.normalize();
    setFrame(u, d1, axis, ik.q);
    frameQuat(d2, axis, ik.ql);
    l.quaternion.copy(ik.q).invert().multiply(ik.ql);
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const v4 = new THREE.Vector3();
const v5 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const e1 = new THREE.Euler();

function aimPistons(bones, pistons) {
    for (const p of pistons) {
        const a = bones[p.a];
        const b = bones[p.b];
        a.parent.updateMatrixWorld(true);
        b.parent.updateMatrixWorld(true);
        const pa = a.getWorldPosition(v1);
        const pb = b.getWorldPosition(v2);
        const d = v3.subVectors(pb, pa);
        if (d.lengthSq() < 1e-10) continue;
        d.normalize();
        for (const [bone, dir] of [[a, d], [b, v4.copy(d).negate()]]) {
            bone.parent.getWorldQuaternion(q1);
            const local = v5.copy(dir).applyQuaternion(q1.invert());
            bone.quaternion.setFromUnitVectors(Y, local);
        }
    }
}

const eulerQuat = (deg, out) => out.setFromEuler(e1.set((deg?.[0] ?? 0) * D2R, (deg?.[1] ?? 0) * D2R, (deg?.[2] ?? 0) * D2R, 'XYZ'));

// ---- Surface sampling ----------------------------------------------------------

/**
 * Points spread over a skinned, non-indexed geometry by area, each with its
 * bone and colour (`tint` multiplies the vertex colour: the light colour for
 * the light mesh), lifted `lift` off the face so the hidden-surface pass
 * cannot swallow them. Seeded, so the cloud is the same every build.
 */
function sampleSurface(geometry, count, tint, rand, lift = 0) {
    const pos = geometry.attributes.position.array;
    const col = geometry.attributes.color.array;
    const skin = geometry.attributes.skinIndex.array;
    const tris = pos.length / 9;
    const cum = new Float64Array(tris);
    let total = 0;
    for (let t = 0; t < tris; t++) {
        const o = t * 9;
        v1.set(pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]);
        v2.set(pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]);
        total += v1.cross(v2).length() / 2;
        cum[t] = total;
    }
    const out = { position: new Float32Array(count * 3), bone: new Uint16Array(count), color: new Float32Array(count * 3) };
    for (let n = 0; n < count; n++) {
        const r = rand() * total;
        let lo = 0;
        let hi = tris - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] < r) lo = mid + 1;
            else hi = mid;
        }
        let a = rand();
        let b = rand();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const o = lo * 9;
        v1.set(pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]);
        v2.set(pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]);
        v1.cross(v2).normalize().multiplyScalar(lift);
        for (let k = 0; k < 3; k++) {
            out.position[n * 3 + k] = pos[o + k] + a * (pos[o + 3 + k] - pos[o + k]) + b * (pos[o + 6 + k] - pos[o + k]) + v1.getComponent(k);
        }
        const vi = lo * 3;
        out.bone[n] = skin[vi * 4];
        out.color[n * 3] = col[vi * 3] * tint.r;
        out.color[n * 3 + 1] = col[vi * 3 + 1] * tint.g;
        out.color[n * 3 + 2] = col[vi * 3 + 2] * tint.b;
    }
    return out;
}

/** Concatenate two samples (body and lights). */
function joinSamples(a, b) {
    if (!b) return a;
    const cat = (x, y, T) => { const o = new T(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
    return { position: cat(a.position, b.position, Float32Array), bone: cat(a.bone, b.bone, Uint16Array), color: cat(a.color, b.color, Float32Array) };
}

// ---- The placed model ------------------------------------------------------------

export class ProtagonistModel {
    constructor(item) {
        // Placement lives on this group; the rig's own group sits inside it.
        this.object = new THREE.Group();
        this.object.userData.itemId = item.id;
        this.op = { ...MODEL_DEFAULTS, ...migrateModelOp(item.op) };
        this.pose = { ...zero(), ...item.pose };
        this.offsets = {};
        this.handles = [];
        this.editing = false;
        this.activeJoint = null;
        this.dragJoint = null;
        this.opacity = 1;
        this.reset();
        this.build();
        this.sync(item);
    }

    /** Back to a known animation state (exports call this, so they come out the same every time). */
    reset(seed = 0x5eed) {
        this.rand = mulberry32(seed);
        this.time = 0;
        this.clock = 0;
        this.ears = { L: { a: 0, v: 0 }, R: { a: 0, v: 0 } };
        this.twitch = { next: 1.2, t: undefined, done: 0, side: 0, amp: 0 };
        this.nod = { prev: null, vel: 0, beat: null };
        this.kick = { level: 0, dip: 0, flash: 0 };
    }

    // --- building -----------------------------------------------------------------

    build() {
        this.disposeRig();
        const op = this.op;
        const spec = specOf(op);
        const baked = buildProtagonist(spec, loadoutOf(op), RARITY_COLOURS);
        this.baked = baked;
        this.buildKey = buildKey(op);
        // The hull's own material, its finish set by applyFinish (tetra's
        // bodyMaterial, made editable and able to reflect the scan).
        this.material = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true });
        this.finishKey = null;
        const inst = instantiate(baked, this.material);
        this.inst = inst;
        inst.body.frustumCulled = false;
        inst.body.receiveShadow = true;
        if (inst.lights) inst.lights.frustumCulled = false;
        inst.lightMaterial.color.set(baked.palette.light);
        this.object.add(inst.object);
        this.bones = inst.bones;
        this.skeleton = inst.skeleton;
        const at = (name) => baked.bind.find((b) => b.name === name).position;
        this.k = baked.dims.scale;
        this.len = {
            thigh: at('kneeR').length(),
            shin: at('ankleR').length(),
            ankle: baked.dims.ankle * this.k,
            hipX: Math.abs(at('hipR').x),
        };

        // Depth-only body for the wire and point views' hidden-surface pass.
        // Pushed well back: the tracked camera's near plane is 5 mm, so
        // depth is coarse at the distances a take is shot from, and a small
        // offset lets the body swallow the very points and edges on it.
        this.depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 8, polygonOffsetUnits: 64 });
        this.depthBody = new THREE.SkinnedMesh(baked.geometry, this.depthMaterial);
        this.depthBody.bind(this.skeleton, new THREE.Matrix4());
        this.depthBody.frustumCulled = false;
        this.depthBody.renderOrder = -0.5;
        inst.object.add(this.depthBody);

        // Wireframe: every part's feature edges, skinned here each frame.
        const E = baked.edges;
        this.edgeCount = E.position.length / 3;
        const lineGeo = new LineSegmentsGeometry();
        lineGeo.setPositions(Float32Array.from(E.position));
        const light = new THREE.Color(baked.palette.light);
        const ec = new Float32Array(E.color.length);
        for (let i = 0; i < this.edgeCount; i++) {
            const l = E.light[i];
            ec[i * 3] = l ? light.r * Math.min(1.6, l) : E.color[i * 3];
            ec[i * 3 + 1] = l ? light.g * Math.min(1.6, l) : E.color[i * 3 + 1];
            ec[i * 3 + 2] = l ? light.b * Math.min(1.6, l) : E.color[i * 3 + 2];
        }
        lineGeo.setColors(ec);
        this.lineMaterial = new LineMaterial({ color: 0xffffff, linewidth: 1, transparent: true, vertexColors: true });
        this.lines = new LineSegments2(lineGeo, this.lineMaterial);
        this.lines.frustumCulled = false;
        inst.object.add(this.lines);

        this.buildPoints();
        this.buildHandles();
    }

    buildPoints() {
        if (this.points) {
            this.points.removeFromParent();
            this.points.geometry.dispose();
            this.pointMaterial.dispose();
        }
        const baked = this.baked;
        const n = Math.max(500, Math.round(this.op.pointCount));
        const rand = mulberry32(0x9017);
        const lightArea = baked.lightGeometry ? 0.12 : 0;
        const lift = 0.006 * this.k;
        const body = sampleSurface(baked.geometry, Math.round(n * (1 - lightArea)), new THREE.Color(1, 1, 1), rand, lift);
        const lights = baked.lightGeometry
            ? sampleSurface(baked.lightGeometry, Math.round(n * lightArea), new THREE.Color(baked.palette.light).multiplyScalar(1.4), rand, lift)
            : null;
        this.sample = joinSamples(body, lights);
        this.pointKey = this.op.pointCount;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(this.sample.position), 3));
        g.setAttribute('color', new THREE.BufferAttribute(this.sample.color, 3));
        this.pointMaterial = new THREE.PointsMaterial({ size: 0.006, sizeAttenuation: true, vertexColors: true, transparent: true });
        this.points = new THREE.Points(g, this.pointMaterial);
        this.points.frustumCulled = false;
        this.inst.object.add(this.points);
        this.boneMats = this.skeleton.bones.map(() => new THREE.Matrix4());
    }

    /** Pickable markers on every joint the editor exposes. */
    buildHandles() {
        this.handles.forEach((h) => { h.removeFromParent(); h.material.dispose(); });
        this.handleGeo?.dispose();
        this.handleGeo = new THREE.OctahedronGeometry(0.02 * this.k, 0);
        this.handles = JOINT_IDS.map((j) => {
            const m = new THREE.Mesh(this.handleGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85, toneMapped: false,
            }));
            m.renderOrder = 1000;
            m.userData.joint = j;
            m.userData.handle = true;
            m.visible = false;
            this.bones[j].add(m);
            return m;
        });
    }

    disposeRig() {
        if (!this.inst) return;
        this.handles.forEach((h) => { h.removeFromParent(); h.material.dispose(); });
        this.handles = [];
        this.handleGeo?.dispose();
        this.inst.object.removeFromParent();
        this.inst.lightMaterial.dispose();
        this.inst.skeleton.dispose();
        this.baked.geometry.dispose();
        this.baked.lightGeometry?.dispose();
        this.material.dispose();
        this.depthMaterial.dispose();
        this.lines.geometry.dispose();
        this.lineMaterial.dispose();
        this.points.geometry.dispose();
        this.pointMaterial.dispose();
        this.points = null;
        this.inst = null;
    }

    dispose() {
        this.disposeRig();
        this.envTarget?.dispose();
        this.envTarget = null;
        this.object.removeFromParent();
    }

    // --- finish and reflections -----------------------------------------------------

    /** Put the item's finish on the hull: texture, highlight, reflection. */
    applyFinish() {
        const op = this.op;
        const tex = specOf(op).texture;
        const m = this.material;
        const fromScan = op.reflectSource === 'scan' && this.envTarget;
        const key = `${JSON.stringify(tex)}|${fromScan ? this.envTarget.texture.uuid : 'sky'}`;
        if (key === this.finishKey) return;
        this.finishKey = key;
        m.map = hullTexture(tex);
        m.shininess = tex.shininess;
        m.specular.setScalar(tex.specular);
        const env = tex.reflectivity > 0 ? (fromScan ? this.envTarget.texture : metalEnvironment()) : null;
        if (m.envMap !== env) { m.envMap = env; m.needsUpdate = true; }
        m.combine = THREE.MixOperation;
        m.reflectivity = tex.reflectivity;
    }

    /** Whether the scan around him has to be captured (again) for his reflections. */
    get needsEnv() {
        const op = this.op;
        return op.reflectivity > 0 && op.reflectSource === 'scan' && (this.envDirty || !this.envTarget);
    }

    /**
     * Capture what surrounds him into a cube map, from the middle of his body:
     * whatever in `scene` is on `layer` (the host puts an unlit copy of the
     * scan there), over `background` where the scan has nothing (the sky).
     */
    captureEnv(renderer, scene, layer, background) {
        if (!this.envTarget) {
            this.envTarget = new THREE.WebGLCubeRenderTarget(256, {
                generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
            });
            this.cubeCamera = new THREE.CubeCamera(0.02, 200, this.envTarget);
            this.cubeCamera.children.forEach((c) => c.layers.set(layer));
        }
        this.object.updateMatrixWorld(true);
        this.cubeCamera.position.copy(this.object.localToWorld(new THREE.Vector3(0, 0.95 * this.k, 0)));
        this.cubeCamera.updateMatrixWorld(true);
        const prevBg = scene.background;
        const prevAuto = renderer.autoClear;
        const prevTarget = renderer.getRenderTarget();
        scene.background = background;
        renderer.autoClear = true;
        this.cubeCamera.update(renderer, scene);
        scene.background = prevBg;
        renderer.autoClear = prevAuto;
        renderer.setRenderTarget(prevTarget);
        this.envDirty = false;
        this.applyFinish();
    }

    // --- parameters -----------------------------------------------------------------

    /** Take on an item's parameters; rebuilds only when the body itself changed. */
    sync(item) {
        this.op = { ...MODEL_DEFAULTS, ...migrateModelOp(item.op) };
        this.pose = { ...zero(), ...item.pose };
        if (buildKey(this.op) !== this.buildKey) this.build();
        else if (this.op.pointCount !== this.pointKey) this.buildPoints();
        const op = this.op;
        this.object.position.set(op.posX, op.posY, op.posZ);
        this.object.rotation.set(op.rotX * D2R, op.rotY * D2R, op.rotZ * D2R);
        this.object.scale.setScalar(op.scale);
        // He moved: what he reflects changed with him.
        const where = [op.posX, op.posY, op.posZ, op.rotX, op.rotY, op.rotZ, op.scale, op.height].join('|');
        if (where !== this.envWhere) { this.envWhere = where; this.envDirty = true; }
        this.applyView();
        this.applyFinish();
    }

    applyView() {
        const op = this.op;
        const hull = !!op.viewTextured;
        const overlay = !!op.viewWire || !!op.viewPoints;
        this.inst.body.visible = hull;
        if (this.inst.lights) this.inst.lights.visible = hull;
        this.lines.visible = !!op.viewWire;
        this.points.visible = !!op.viewPoints;
        // Without the hull, a depth-only body hides the far side; with it, the
        // hull does the job itself.
        this.depthBody.visible = !hull && overlay && op.selfOcclude;
        // Lines and points sit exactly on the hull's surface, so with both
        // drawn the hull's depth is pushed back (as far as the depth-only
        // body's, for the same reason: the tracked camera's 5 mm near plane
        // leaves depth coarse) and they draw over it instead of flickering
        // in and out of it.
        for (const m of [this.material, this.inst.lightMaterial]) {
            if (m.polygonOffset !== (hull && overlay)) {
                m.polygonOffset = hull && overlay;
                m.polygonOffsetFactor = 8;
                m.polygonOffsetUnits = 64;
                m.needsUpdate = true;
            }
        }
        // Whichever solid body is in the scene casts the sun's shadow.
        this.inst.body.castShadow = !!op.castShadow;
        this.depthBody.castShadow = !!op.castShadow;

        const lm = this.lineMaterial;
        const wireModel = op.wireColorMode === 'model';
        if (lm.vertexColors !== wireModel) { lm.vertexColors = wireModel; lm.needsUpdate = true; }
        lm.color.set(wireModel ? '#ffffff' : op.wireColor);

        const pm = this.pointMaterial;
        const ptModel = op.pointColorMode === 'model';
        if (pm.vertexColors !== ptModel) { pm.vertexColors = ptModel; pm.needsUpdate = true; }
        pm.color.set(ptModel ? '#ffffff' : op.pointColor);
        pm.size = op.pointSize;
        this.setOpacity(this.opacity);
    }

    /** Fade the whole model (its own opacity times whatever the host asks for). */
    setOpacity(v) {
        this.opacity = v;
        const a = Math.max(0, Math.min(1, v * (this.op.opacity ?? 1)));
        for (const m of [this.material, this.inst.lightMaterial, this.pointMaterial, this.lineMaterial]) {
            const t = a < 1 || m === this.lineMaterial || m === this.pointMaterial;
            if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
            m.opacity = a;
            m.depthWrite = a >= 1 && m !== this.lineMaterial;
        }
        this.object.visible = a > 0.002;
    }

    /** Show the joint markers (pose editing) with `active` picked out. */
    setEditing(on, active = null) {
        this.editing = on;
        this.activeJoint = active;
        for (const h of this.handles) {
            h.visible = on;
            h.material.color.set(h.userData.joint === active ? '#ffb347' : (/L$/.test(h.userData.joint) ? '#8fd3ff' : /R$/.test(h.userData.joint) ? '#ff9fb2' : '#ffffff'));
            h.scale.setScalar(h.userData.joint === active ? 1.5 : 1);
        }
    }

    /** Hide or restore the editing furniture (exports call this). */
    hideHandles(hidden) {
        for (const h of this.handles) h.visible = !hidden && this.editing;
    }

    // --- pose capture (the viewport gizmo writes bones directly) ------------------

    /** A joint's angles (degrees, XYZ) as the pose would store them, with the procedural layer taken back out. */
    jointAngles(j) {
        const bone = this.bones[j];
        const off = this.offsets[j];
        const q = off ? q1.copy(bone.quaternion).multiply(q2.copy(off).invert()) : q1.copy(bone.quaternion);
        e1.setFromQuaternion(q, 'XYZ');
        // Every rotation has two XYZ triples; take the one nearer what the
        // sliders showed, so a drag reads as one angle moving rather than all
        // three flipping round.
        const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
        const a = [e1.x / D2R, e1.y / D2R, e1.z / D2R];
        const b = [wrap(a[0] + 180), wrap(180 - a[1]), wrap(a[2] + 180)];
        const prev = this.pose[j] || [0, 0, 0];
        const dist = (t) => t.reduce((s, v, i) => s + Math.abs(wrap(v - prev[i])), 0);
        const r = (v) => Math.round(v * 10) / 10;
        return (dist(b) < dist(a) ? b : a).map(r);
    }

    /** The legs as the IK has them now, for when planted feet hand over to the pose. */
    captureLegs() {
        return Object.fromEntries(LEG_JOINTS.map((j) => [j, this.jointAngles(j)]));
    }

    /** One twitch, right now. */
    twitchNow() {
        this.twitch.next = 0;
        this.forceTwitch = true;
    }

    // --- animation ---------------------------------------------------------------------

    /**
     * Advance `dt` seconds. `ctx`: `{ beatTime (seconds on the music's clock,
     * or null for the free clock), drawWidth, drawHeight (drawing buffer, for
     * line widths) }`.
     */
    update(dt, ctx = {}) {
        if (!this.inst) return;
        const op = this.op;
        const pose = this.pose;
        const bones = this.bones;
        this.time += dt;
        this.clock += dt;
        const drag = this.dragJoint;

        // Base pose. Anything the procedural layers add goes in `offsets`, so
        // the gizmo can hand back the angles alone.
        for (const j of JOINT_IDS) {
            if (j === drag) continue;
            eulerQuat(pose[j], bones[j].quaternion);
        }
        const finger = (n) => {
            if (`fingers${n}` !== drag) bones[`tips${n}`].quaternion.copy(bones[`fingers${n}`].quaternion).slerp(q1.identity(), 0.15);
        };
        finger('L');
        finger('R');
        bones.pelvis.position.set(0, op.hipHeight, -op.hipForward);
        const offs = {};
        const addOff = (j, q) => {
            if (j === drag) return;
            offs[j] = offs[j] ? offs[j].multiply(q) : q.clone();
        };

        // Breathing: the chest rises and settles.
        const breath = Math.sin(this.time * 1.7) * op.breathe;
        addOff('chest', new THREE.Quaternion().setFromAxisAngle(X, 0.014 * breath));

        // Nod: head down on the beat. Shared between neck and head like the
        // game's look-pitch, with some of it carried into the body.
        // Kicks are listened for whenever that mode is picked, so the menu's
        // meter shows what the threshold is catching even with the nod off.
        const kickDip = op.nodMode === 'kick' ? this.kickDip(ctx) : 0;
        let nodAngle = 0;
        if (op.nodOn && (op.nodMode === 'kick' || op.bpm > 0)) {
            let dip = kickDip;
            if (op.nodMode !== 'kick') {
                const t = ctx.beatTime ?? this.clock;
                const beats = (t * op.bpm) / 60 / Math.max(1, op.nodEvery) - op.nodPhase;
                const p = beats - Math.floor(beats);
                dip = Math.pow(0.5 + 0.5 * Math.cos(TAU * p), op.nodSharpness);
            }
            nodAngle = -op.nodDepth * D2R * dip;
            addOff('neck', new THREE.Quaternion().setFromAxisAngle(X, nodAngle * 0.35));
            addOff('head', new THREE.Quaternion().setFromAxisAngle(X, nodAngle * 0.65));
            if (op.nodGroove > 0) {
                addOff('spine', new THREE.Quaternion().setFromAxisAngle(X, nodAngle * 0.12 * op.nodGroove));
                addOff('chest', new THREE.Quaternion().setFromAxisAngle(X, nodAngle * 0.2 * op.nodGroove));
            }
        }
        for (const [j, q] of Object.entries(offs)) bones[j].quaternion.multiply(q);
        // Kept for the gizmo; the dragged joint keeps whatever it had.
        for (const j of Object.keys(this.offsets)) if (j !== drag && !offs[j]) delete this.offsets[j];
        Object.assign(this.offsets, offs);
        this.inst.object.updateMatrixWorld(true);

        // Legs: planted feet by IK, or straight from the pose.
        if (op.plantFeet) {
            const yaw = this.inst.object.getWorldQuaternion(new THREE.Quaternion());
            for (const [n, side] of SIDES) {
                if ([`hip${n}`, `knee${n}`, `ankle${n}`].includes(drag)) continue;
                const foot = new THREE.Vector3(side * (this.len.hipX + op.footSpread), this.len.ankle, -op.footForward);
                const target = this.inst.object.localToWorld(foot);
                const pole = new THREE.Vector3(side * 0.12, 0, -1).applyQuaternion(yaw);
                solveLimb(bones[`hip${n}`], bones[`knee${n}`], this.len.thigh, this.len.shin, target, pole, true);
                bones[`hip${n}`].updateMatrixWorld(true);
                const flat = q1.copy(yaw).multiply(eulerQuat(pose[`ankle${n}`], q2));
                setWorldQuat(bones[`ankle${n}`], flat);
            }
            this.inst.object.updateMatrixWorld(true);
        }

        this.updateEars(dt, nodAngle, ctx);
        aimPistons(bones, this.baked.pistons);
        this.inst.object.updateMatrixWorld(true);

        const glow = 0.88 + 0.12 * Math.sin(this.time * 2.1);
        this.inst.lightMaterial.color.set(this.baked.palette.light).multiplyScalar(glow);

        if (op.viewWire) {
            this.skinLines();
            if (ctx.drawHeight) {
                this.lineMaterial.resolution.set(ctx.drawWidth, ctx.drawHeight);
                this.lineMaterial.linewidth = Math.max(0.5, op.wireThickness * ctx.drawHeight);
            }
        }
        if (op.viewPoints) this.skinPoints();
    }

    /**
     * How far down the head is for the kick nod. `ctx.kick` is the track's
     * kick analysis (see kicks.js): `{ hits, level, time }`, the hit times,
     * the band's level now and where the music is. A pure function of the
     * music's time, so the preview and an export agree to the frame. Every
     * `nodEvery`th hit (counted from the top of the track) drops the head
     * fast and lets it back up over `nodRelease` seconds.
     */
    kickDip(ctx) {
        const op = this.op;
        const k = this.kick;
        const K = ctx.kick;
        if (!K || !K.hits || !K.hits.length) {
            k.level = K ? K.level : 0;
            k.flash = 0;
            k.dip = 0;
            return 0;
        }
        const H = K.hits;
        const t = K.time;
        k.level = K.level;
        // Last hit at or before now.
        let lo = 0;
        let hi = H.length - 1;
        if (H[0] > t) {
            k.flash = 0;
            k.dip = 0;
            return 0;
        }
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (H[mid] <= t) lo = mid;
            else hi = mid - 1;
        }
        k.flash = Math.max(0, 1 - (t - H[lo]) * 5);
        const N = Math.max(1, Math.round(op.nodEvery));
        const j = lo - (lo % N);
        const attack = 0.05;
        const release = Math.max(0.05, op.nodRelease);
        const ease = (u) => u * u * (3 - 2 * u);
        const shape = (since, from) => {
            if (since < attack) return from + (1 - from) * ease(since / attack);
            const u = Math.min(1, (since - attack) / release);
            return 1 - ease(u);
        };
        // A hit that lands mid-nod drops from where the head already is.
        const from = j - N >= 0 ? shape(H[j] - H[j - N], 0) : 0;
        k.dip = shape(t - H[j], from);
        return k.dip;
    }

    /** Damped springs, kicked by twitches and swung by the nod. */
    updateEars(dt, nodAngle, ctx) {
        const op = this.op;
        const bones = this.bones;
        // The head's angular acceleration from the nod: ears lag it.
        const nod = this.nod;
        let acc = 0;
        const beat = ctx.beatTime ?? this.clock;
        const jumped = nod.beat !== null && Math.abs(beat - nod.beat - dt) > 0.12;
        if (dt > 0 && nod.prev !== null && !jumped) {
            const vel = (nodAngle - nod.prev) / dt;
            acc = (vel - nod.vel) / dt;
            nod.vel = vel;
        } else {
            nod.vel = 0;
        }
        nod.prev = nodAngle;
        nod.beat = beat;
        acc = Math.max(-400, Math.min(400, acc));

        const tw = this.twitch;
        const rand = this.rand;
        tw.next -= dt;
        if (tw.next <= 0 && (op.twitchOn || this.forceTwitch)) {
            this.forceTwitch = false;
            tw.next = Math.max(0.3, op.twitchEvery) * (0.35 + 1.3 * rand());
            tw.t = 0;
            tw.done = 0;
            tw.side = rand() < 0.3 ? 0 : rand() < 0.5 ? -1 : 1;
            tw.amp = (6 + rand() * 4) * (rand() < 0.6 ? -1 : 1) * op.twitchStrength;
        } else if (tw.next <= 0) {
            tw.next = 0.5;
        }
        let kicks = 0;
        if (tw.t !== undefined) {
            tw.t += dt;
            while (tw.done < TWITCH.length && tw.t >= TWITCH[tw.done][1]) kicks += TWITCH[tw.done++][0];
            if (tw.done >= TWITCH.length) tw.t = undefined;
        }
        const steps = Math.max(1, Math.ceil(dt / 0.008));
        const h = dt / steps;
        const drive = acc * 0.0055 * op.earBounce;
        for (const [n, side] of SIDES) {
            const e = this.ears[n];
            if (kicks && (tw.side === 0 || tw.side === side)) e.v += tw.amp * kicks * (tw.side === 0 && side > 0 ? 0.8 : 1);
            for (let i = 0; i < steps; i++) {
                const force = -EAR_K * (e.a - drive) - EAR_C * e.v;
                e.v += force * h;
                e.a += e.v * h;
            }
            e.a = THREE.MathUtils.clamp(e.a, -0.7, 0.5);
            const j = `ear${n}`;
            if (j === this.dragJoint) continue;
            const off = new THREE.Quaternion().setFromEuler(e1.set(-e.a, 0, side * 0.04 * e.a, 'XYZ'));
            bones[j].quaternion.multiply(off);
            this.offsets[j] = off;
        }
    }

    /** Bone matrices relative to the rig's own group, bind pose taken out. */
    skinMatrices() {
        const inv = m1.copy(this.inst.object.matrixWorld).invert();
        const bones = this.skeleton.bones;
        const inverses = this.skeleton.boneInverses;
        for (let i = 0; i < bones.length; i++) this.boneMats[i].multiplyMatrices(inv, bones[i].matrixWorld).multiply(inverses[i]);
    }

    skinInto(src, bone, out, count) {
        this.skinMatrices();
        const M = this.boneMats;
        for (let n = 0; n < count; n++) {
            const m = M[bone[n]].elements;
            const o = n * 3;
            const x = src[o];
            const y = src[o + 1];
            const z = src[o + 2];
            out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
            out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
    }

    skinPoints() {
        const attr = this.points.geometry.attributes.position;
        this.skinInto(this.sample.position, this.sample.bone, attr.array, this.sample.bone.length);
        attr.needsUpdate = true;
    }

    skinLines() {
        const data = this.lines.geometry.attributes.instanceStart.data;
        this.skinInto(this.baked.edges.position, this.baked.edges.bone, data.array, this.edgeCount);
        data.needsUpdate = true;
    }
}
