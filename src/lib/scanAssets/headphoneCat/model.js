// The headphone cat as a placed, posable model, driven by the same controls
// as Sackboy and the protagonist: a pose of per-joint angles with presets, a
// head nod to a tempo or the track's kicks, three ways to draw him (textured,
// wireframe, points), plus what is his own:
//
//   - his animation clips (Idle, Wave, Walk, Hop), cross-faded, under the pose;
//   - a face: an eyes and a mouth preset, every shape key as its own amount
//     on top (so a controller can drive any one of them), blush, and blinking;
//   - a look (head pitch / turn / tilt), ear flicks and a tail wag, all
//     linkable, layered on the pose like the nod;
//   - headphones and glasses to take on and off, every colour, and the Cat
//     Rig page's shape parameters (which rebuild him);
//   - a subtle tiling noise over his fur (or everything), the protagonist's
//     hull texture laid on triplanar in his bind pose, so it rides the skin.
//
// The rig itself (rig.js) is built procedurally; its defaults rebuild
// headphone_cat_rig.glb exactly. This extends SackboyModel for what the two
// share as is: the depth pass, the CPU-skinned wireframe and points, the
// views, the fade and the kick nod.

import * as THREE from 'three';
import { SackboyModel } from '../sackboy';
import { hullTexture, HULL_TEXTURE } from '../../protagonist/rig';
import { mulberry32 } from '../../protagonist/random';
import {
    buildCatRig, makeCatMaterials, applyCatLook, paintCatFace, CAT_SHAPE_DEFAULTS, CAT_COLOUR_DEFAULTS, CAT_MORPHS, CAT_EYES, CAT_MOUTHS,
} from './rig';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** The pose editor's joints: [id, label, bones]. A joint over several bones turns each by its angles (the tail curls). */
export const CAT_JOINTS = [
    ['hips', 'Hips', ['hips']],
    ['spine', 'Waist', ['spine']],
    ['chest', 'Chest', ['chest']],
    ['neck', 'Neck', ['neck']],
    ['head', 'Head', ['head']],
    ['earL', 'Left ear', ['ear_L']],
    ['earR', 'Right ear', ['ear_R']],
    ['armL', 'Left arm', ['arm_L']],
    ['handL', 'Left hand', ['hand_L']],
    ['armR', 'Right arm', ['arm_R']],
    ['handR', 'Right hand', ['hand_R']],
    ['legL', 'Left leg', ['leg_L']],
    ['footL', 'Left foot', ['foot_L']],
    ['legR', 'Right leg', ['leg_R']],
    ['footR', 'Right foot', ['foot_R']],
    ['tail', 'Tail', ['tail_1', 'tail_2', 'tail_3']],
];
const JOINT_IDS = CAT_JOINTS.map(([id]) => id);
// His top half: what a preset that leaves his legs alone sets.
const UPPER = ['spine', 'chest', 'neck', 'head', 'earL', 'earR', 'armL', 'handL', 'armR', 'handR'];
export const CAT_JOINT_MENU = CAT_JOINTS.map(([id, label]) => [id, label]);

/** The animation clips, by the names rig.js gives them. */
export const CAT_ANIMS = [['none', 'None (pose only)'], ['Idle', 'Idle'], ['Wave', 'Wave'], ['Walk', 'Walk'], ['Hop', 'Hop']];

const zero = () => Object.fromEntries(JOINT_IDS.map((j) => [j, [0, 0, 0]]));
/** Mirror an angle triple through his mid-plane (x -> -x). */
const mirror = ([x, y, z]) => [x, -y, -z];
function sym(p, joint, r) {
    p[`${joint}L`] = [...r];
    p[`${joint}R`] = mirror(r);
}

/**
 * Presets. Angles (degrees, XYZ) in his body frame, on his rest pose: X
 * pitches (positive tips forward), Y turns, Z rolls (positive lifts his left
 * arm). `op` is the pose's own settings: how far the hips sink (a share of
 * his leg length) and which clip plays under it.
 */
export const CAT_POSES = {
    stand: { name: 'Stand', make: () => ({ pose: zero(), op: { hipDrop: 0 } }) },
    wave: {
        name: 'Wave',
        make: () => {
            const p = zero();
            p.armR = [0, 0, -115];
            p.handR = [0, 0, -15];
            p.head = [0, 0, 8];
            return { pose: p, op: { hipDrop: 0 } };
        },
    },
    cheer: {
        name: 'Cheer',
        make: () => {
            const p = zero();
            sym(p, 'arm', [0, 0, 120]);
            p.head = [-10, 0, 0];
            sym(p, 'ear', [0, 0, -12]);
            return { pose: p, op: { hipDrop: 0 } };
        },
    },
    shrug: {
        name: 'Shrug',
        make: () => {
            const p = zero();
            sym(p, 'arm', [0, 0, 40]);
            sym(p, 'hand', [0, 0, 30]);
            p.head = [0, 0, -12];
            sym(p, 'ear', [0, 0, 18]);
            return { pose: p, op: { hipDrop: 0 } };
        },
    },
    sit: {
        name: 'Sit',
        make: () => {
            const p = zero();
            sym(p, 'leg', [-85, 0, 6]);
            sym(p, 'foot', [10, 0, 0]);
            sym(p, 'arm', [-20, 0, -10]);
            p.tail = [8, 0, 0];
            return { pose: p, op: { hipDrop: 0.55, anim: 'none' } };
        },
    },
    // The next two are his top half only (`only`), so he sulks or types
    // standing or sitting, whatever his legs and tail are doing.
    sulk: {
        name: 'Sulk',
        only: UPPER,
        make: () => {
            const p = zero();
            // Hunched over, head hung, ears drooping.
            p.spine = [5, 0, 0];
            p.chest = [8, 0, 0];
            p.neck = [10, 0, 0];
            p.head = [20, 0, 0];
            sym(p, 'ear', [0, 0, 30]);
            // Arms lifted out level and swung round to the front, paws turned
            // up and in: his arms are short of his face, so his face comes down
            // into them.
            sym(p, 'arm', [-20, -85, 58]);
            sym(p, 'hand', [-35, -30, 0]);
            return { pose: p, op: {} };
        },
    },
    work: {
        name: 'Type',
        only: UPPER,
        make: () => {
            const p = zero();
            // Leaning in to the screen, paws out in front over the keys.
            p.chest = [6, 0, 0];
            p.neck = [6, 0, 0];
            p.head = [10, 0, 0];
            sym(p, 'arm', [10, -84, 52]);
            sym(p, 'hand', [30, -15, 0]);
            return { pose: p, op: {} };
        },
        // Paws flopping up and down on the keys, not quite in step. `rate`
        // taps a second for each paw, `depth` degrees from the keys up.
        move: (t, rate, depth) => {
            const tap = (ph) => {
                const s = Math.sin(TAU * rate * t + ph) + 0.35 * Math.sin(TAU * rate * 1.73 * t + ph * 2.1);
                return Math.max(0, s) / 1.35;
            };
            const l = tap(0);
            const r = tap(Math.PI * 0.9);
            return {
                handL: [-depth * l, 0, 0],
                handR: [-depth * r, 0, 0],
                // His arms are short, so the forearm lifts too, or the tap barely shows.
                armL: [-depth * 0.5 * l, 0, 0],
                armR: [-depth * 0.5 * r, 0, 0],
            };
        },
    },
};

/** What the pose blend can start or end on: his own (edited) pose, or a preset. */
export const CAT_BLEND_MENU = [['own', 'Edited pose'], ...Object.entries(CAT_POSES).map(([id, p]) => [id, p.name])];

// Every shape key is its own parameter, `sk_<name>`, added to the presets'.
export const CAT_KEY_PARAMS = CAT_MORPHS.map((n) => `sk_${n}`);

export const CAT_DEFAULTS = {
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scale: 1,
    height: 0.35, // metres, to the top of his ears
    opacity: 1,
    depthLayer: 'front',

    viewTextured: true,
    viewWire: false,
    viewPoints: false,
    selfOcclude: true,
    wireMode: 'all',
    wireAngle: 25,
    wireColorMode: 'model',
    wireColor: '#ffd28a',
    wireThickness: 0.0012,
    pointColorMode: 'model',
    pointColor: '#f2f0e6',
    pointCount: 20000,
    pointSize: 0.0025,
    castShadow: true,

    // Motion: a clip under the pose, how fast, and how long a change of clip fades.
    anim: 'Idle',
    animSpeed: 1,
    animFade: 0.3,
    hipDrop: 0,
    breathe: 0,

    // Two poses and how far from the first to the second (link Mix to a
    // controller to move between them). A preset that moves (Type) moves
    // as much as it is mixed in.
    poseBlend: false,
    poseFrom: 'own',
    poseTo: 'work',
    poseMix: 0,
    typeRate: 4, // taps a second, each paw
    typeDepth: 25, // degrees a paw lifts off the keys

    // Look and the small motions, on top of pose and clip (degrees).
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    earL: 0,
    earR: 0,
    earSpacing: 0, // ear spread added, as a share of his head's half-width
    earHeight: 0, // how far the tips rise, as a share of the ears' length
    tailWag: 0,
    tailRate: 1.5, // Hz

    // Nod, as Sackboy's.
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

    // Face.
    eyes: 'neutral',
    mouth: 'cat',
    blush: 1,
    blinkOn: false,
    blinkEvery: 3.5,
    faceEase: 0.07, // seconds to settle on a new expression (0 = at once)
    // How the face is drawn: 'layers', thin shapes standing just off his head
    // (their shape keys move them), or 'paint', painted into his fur's
    // colour as texels, `facePixels` across.
    faceMode: 'layers',
    facePixels: '2048',
    ...Object.fromEntries(CAT_KEY_PARAMS.map((k) => [k, 0])),

    headphones: true,
    glasses: true,
    ...CAT_COLOUR_DEFAULTS,
    ...CAT_SHAPE_DEFAULTS,

    // Noise texture (the protagonist's hull texture), off as exported.
    texOn: false,
    texParts: 'fur', // 'fur' | 'all'
    texRepeat: 0.12, // metres one tile covers
    texStrength: 0.2,
    texPeriodX: HULL_TEXTURE.period[0],
    texPeriodY: HULL_TEXTURE.period[1],
    texOctaves: HULL_TEXTURE.octaves,
    texPersistence: HULL_TEXTURE.persistence,
    texContrast: HULL_TEXTURE.contrast,
    texLevels: HULL_TEXTURE.levels,
    texResolution: HULL_TEXTURE.resolution,
    texDither: HULL_TEXTURE.dither,
};

/** The noise fields: [key, label, min, max, step]. */
export const CAT_TEXTURE_FIELDS = [
    ['texRepeat', 'Tile (m)', 0.01, 2, 0.005],
    ['texStrength', 'Strength', 0, 1, 0.01],
    ['texPeriodX', 'Period X', 1, 16, 1],
    ['texPeriodY', 'Period Y', 1, 16, 1],
    ['texOctaves', 'Octaves', 1, 8, 1],
    ['texPersistence', 'Persist', 0, 1, 0.01],
    ['texContrast', 'Contrast', 0, 4, 0.05],
    ['texLevels', 'Greys', 2, 16, 1],
    ['texResolution', 'Pixels', 8, 256, 8],
];

export function makeCatItem(id, overrides = {}, poseId = 'stand') {
    const made = CAT_POSES[poseId].make();
    return {
        id,
        kind: 'model',
        modelId: 'cat',
        reactive: false,
        op: { ...CAT_DEFAULTS, ...made.op, ...overrides },
        pose: made.pose,
    };
}

const shapeKey = (op) => JSON.stringify(Object.keys(CAT_SHAPE_DEFAULTS).map((k) => op[k]));
const texSpec = (op) => ({
    ...HULL_TEXTURE,
    period: [Math.round(op.texPeriodX), Math.round(op.texPeriodY)],
    octaves: Math.round(op.texOctaves),
    persistence: op.texPersistence,
    contrast: op.texContrast,
    resolution: Math.round(op.texResolution / 8) * 8 || 8,
    levels: Math.round(op.texLevels),
    dither: !!op.texDither,
    repeat: 1, // tiles are sized in the shader
    strength: op.texStrength,
});

/**
 * Lay a tiling grey texture over a material's colour, triplanar in the mesh's
 * own (bind-pose) coordinates, so it sticks to him as he moves and needs no
 * UVs. `u` holds the shared uniforms (texture, tiles per unit); `on` is this
 * material's own switch.
 */
function addNoise(material, u, on) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.catNoise = u.map;
        shader.uniforms.catNoiseScale = u.scale;
        shader.uniforms.catNoiseOn = on;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCatP;\nvarying vec3 vCatN;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCatP = position;\nvCatN = normal;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform sampler2D catNoise;\nuniform float catNoiseScale;\nuniform float catNoiseOn;\nvarying vec3 vCatP;\nvarying vec3 vCatN;')
            .replace('#include <map_fragment>', `#include <map_fragment>
if (catNoiseOn > 0.5) {
    vec3 cw = pow(abs(normalize(vCatN)), vec3(4.0));
    cw /= max(1e-5, cw.x + cw.y + cw.z);
    vec3 cp = vCatP * catNoiseScale;
    float cg = texture2D(catNoise, cp.zy).r * cw.x + texture2D(catNoise, cp.xz).r * cw.y + texture2D(catNoise, cp.xy).r * cw.z;
    diffuseColor.rgb *= cg;
}`);
    };
    material.customProgramCacheKey = () => 'catNoise';
    material.needsUpdate = true;
}

/**
 * Paint the face into a material's colour: the painted texture `u.map` holds
 * how much ink, blush and tongue show (red, green, blue, premultiplied), laid
 * flat over his head looking down -Z (the catFace attribute: the head's x and
 * height, and how much it faces forward), within `u.box`. Their colours and
 * roughness mix in over the fur's, after the noise (which never marks the
 * face). Chains onto whatever the material already does before it compiles.
 */
function addFacePaint(material, u) {
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        prev?.call(material, shader, renderer);
        Object.assign(shader.uniforms, {
            catFaceMap: u.map, catFaceBox: u.box, catFaceOn: u.on, catInk: u.ink, catBlush: u.blush, catTongue: u.tongue, catFaceRough: u.rough,
        });
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute vec3 catFace;\nvarying vec3 vCatFace;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCatFace = catFace;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
uniform sampler2D catFaceMap;
uniform vec4 catFaceBox;
uniform float catFaceOn;
uniform vec3 catInk;
uniform vec3 catBlush;
uniform vec3 catTongue;
uniform vec3 catFaceRough;
varying vec3 vCatFace;`)
            .replace('#include <color_fragment>', `#include <color_fragment>
vec2 catFaceUv = (vCatFace.xy - catFaceBox.xy) / catFaceBox.zw;
vec4 catFaceW = texture2D(catFaceMap, clamp(catFaceUv, 0.0, 1.0));
vec2 catFaceIn = step(vec2(0.0), catFaceUv) * step(catFaceUv, vec2(1.0));
catFaceW *= catFaceOn * catFaceIn.x * catFaceIn.y * clamp(vCatFace.z * 8.0, 0.0, 1.0);
diffuseColor.rgb = diffuseColor.rgb * (1.0 - catFaceW.a) + catInk * catFaceW.r + catBlush * catFaceW.g + catTongue * catFaceW.b;`)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = roughnessFactor * (1.0 - catFaceW.a) + dot(catFaceW.rgb, catFaceRough);`);
    };
    material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|catFace`;
    material.needsUpdate = true;
}

export class CatModel extends SackboyModel {
    get needsEnv() { return false; }

    reset(seed = 0xca7) {
        super.reset(seed);
        this.blinkSeed = seed;
        // The clip starts over too, so an export moves the same each time.
        this.animNow = undefined;
        this.animT = 0;
        this.animFromT = 0;
        this.faceSet = false;
    }

    async load() {
        // After the constructor, so the instance is whole when this runs.
        await Promise.resolve();
        if (this.disposed) return;
        this.M = makeCatMaterials();
        // The noise: on the fur, and on the headphones and glasses when it is on everything (never the face).
        this.noise = { map: { value: null }, scale: { value: 1 }, fur: { value: 0 }, rest: { value: 0 } };
        addNoise(this.M.fur, this.noise, this.noise.fur);
        ['shell', 'pad', 'frame'].forEach((k) => addNoise(this.M[k], this.noise, this.noise.rest));
        // The painted face, on the fur (only his head reaches it). Colours by reference, so they follow the look.
        this.facePaint = {
            map: { value: null },
            box: { value: new THREE.Vector4(0, 0, 1, 1) },
            on: { value: 0 },
            ink: { value: this.M.ink.color },
            blush: { value: this.M.blush.color },
            tongue: { value: this.M.tongue.color },
            rough: { value: new THREE.Vector3(this.M.ink.roughness, this.M.blush.roughness, this.M.tongue.roughness) },
        };
        addFacePaint(this.M.fur, this.facePaint);
        this.materials = Object.values(this.M);
        this.materials.forEach((m) => { m.userData.baseTransparent = false; });
        this.op = { ...CAT_DEFAULTS, ...this.item.op };
        applyCatLook(this.M, this.op);
        this.build(this.op);
        this.ready = true;
        this.sync(this.item);
        this.onReady?.(this);
    }

    /** (Re)build the rig for the shape in `op`, and everything drawn from it. */
    build(op) {
        this.teardown();
        const rig = buildCatRig({ ...CAT_SHAPE_DEFAULTS, ...op }, this.M);
        this.rig = rig;
        this.shapeKey = shapeKey(op);
        this.scene = rig.model;
        this.meshes = [rig.mesh];
        this.accessories = [...rig.headphones.children, ...rig.glasses.children];
        this.norm.add(rig.model);
        this.inst = { object: rig.model };
        this.bonesByName = Object.fromEntries(rig.bones.map((b) => [b.name, b]));
        this.jointBones = {};
        this.bones = {};
        CAT_JOINTS.forEach(([id, , names]) => {
            this.jointBones[id] = names.map((n) => this.bonesByName[n]);
            this.bones[id] = this.jointBones[id][0];
        });
        // The clips, sampled by hand so they compose with the pose.
        this.clips = Object.fromEntries(rig.model.animations.map((c) => [c.name, {
            clip: c,
            tracks: c.tracks.map((t) => {
                const [name, prop] = t.name.split('.');
                return { bone: this.bonesByName[name], prop, interp: t.createInterpolant() };
            }),
        }]));
        this.influence = new Float32Array(CAT_MORPHS.length);
        this.buildDerived();
    }

    /** What is drawn from the rig and the parts shown: skin data, depth, wire, points. */
    buildDerived() {
        this.buildSkinData();
        this.buildDepth();
        this.buildWire();
        this.buildPoints();
        this.handles = [];
        this.derivedKey = this.derivedKeyOf(this.op);
    }

    derivedKeyOf(op) {
        return JSON.stringify([op.headphones, op.glasses, ...Object.keys(CAT_COLOUR_DEFAULTS).map((k) => op[k])]);
    }

    teardown() {
        if (!this.rig) return;
        this.depthMeshes?.forEach((d) => d.removeFromParent());
        this.depthMaterial?.dispose();
        this.lines?.removeFromParent();
        this.lines?.geometry.dispose();
        this.lineMaterial?.dispose();
        this.points?.removeFromParent();
        this.points?.geometry.dispose();
        this.pointMaterial?.dispose();
        this.lines = null;
        this.points = null;
        this.rig.model.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        this.rig.model.removeFromParent();
        this.rig = null;
    }

    buildHandles() { this.handles = []; }

    /** The accessories shown now. */
    shownAccessories() {
        const op = this.op;
        return this.accessories.filter((m) => (m.parent === this.rig.headphones ? op.headphones : op.glasses));
    }

    /** Every vertex drawn, in bind space, with its bones and colour - for CPU skinning (accessories ride the head). */
    buildSkinData() {
        const rig = this.rig;
        const mesh = rig.mesh;
        const g = mesh.geometry;
        const sk = mesh.skeleton;
        const head = sk.bones.indexOf(rig.bone.head);
        const pos = []; const skin = []; const weight = []; const color = []; const tris = []; const parts = [];
        const v = new THREE.Vector3();
        const P = g.attributes.position; const J = g.attributes.skinIndex; const W = g.attributes.skinWeight;
        // Each vertex's colour is its material group's.
        const vColor = new Array(P.count);
        g.groups.forEach((gr) => {
            const c = mesh.material[gr.materialIndex].color;
            for (let t = gr.start; t < gr.start + gr.count; t++) vColor[g.index.getX(t)] = c;
        });
        const white = new THREE.Color(1, 1, 1);
        for (let i = 0; i < P.count; i++) {
            v.fromBufferAttribute(P, i).applyMatrix4(mesh.bindMatrix);
            pos.push(v.x, v.y, v.z);
            skin.push(J.getX(i), J.getY(i), J.getZ(i), J.getW(i));
            weight.push(W.getX(i), W.getY(i), W.getZ(i), W.getW(i));
            const c = vColor[i] || white;
            color.push(c.r, c.g, c.b);
        }
        g.groups.forEach((gr) => {
            let lo = Infinity; let hi = -1;
            for (let t = gr.start; t < gr.start + gr.count; t++) { const k = g.index.getX(t); lo = Math.min(lo, k); hi = Math.max(hi, k); tris.push(k); }
            if (hi >= 0) parts.push({ first: tris.length - gr.count, count: gr.count, base: lo, verts: hi - lo + 1 });
        });
        // Shape keys, kept sparse (only the face moves).
        const morphs = g.morphAttributes.position.map((a) => {
            const idx = []; const d = [];
            for (let i = 0; i < a.count; i++) {
                const x = a.getX(i); const y = a.getY(i); const z = a.getZ(i);
                if (x || y || z) { idx.push(i); d.push(x, y, z); }
            }
            return { idx: Uint32Array.from(idx), d: Float32Array.from(d) };
        });
        // The accessories, at rest in the model's frame, wholly on the head.
        let base = P.count;
        rig.model.updateMatrixWorld(true);
        const toModel = new THREE.Matrix4().copy(rig.model.matrixWorld).invert();
        this.shownAccessories().forEach((m) => {
            const mg = m.geometry; const MP = mg.attributes.position;
            const mm = new THREE.Matrix4().multiplyMatrices(toModel, m.matrixWorld);
            const c = m.material.color;
            for (let i = 0; i < MP.count; i++) {
                v.fromBufferAttribute(MP, i).applyMatrix4(mm);
                pos.push(v.x, v.y, v.z);
                skin.push(head, 0, 0, 0);
                weight.push(1, 0, 0, 0);
                color.push(c.r, c.g, c.b);
            }
            const I = mg.index ? mg.index.array : Array.from({ length: MP.count }, (_, i) => i);
            const first = tris.length;
            for (let t = 0; t < I.length; t++) tris.push(base + I[t]);
            parts.push({ first, count: I.length, base, verts: MP.count });
            base += MP.count;
        });
        this.skin = {
            count: base,
            skinnedCount: P.count,
            pos: Float32Array.from(pos),
            mpos: Float32Array.from(pos),
            bone: Uint16Array.from(skin),
            weight: Float32Array.from(weight),
            color: Float32Array.from(color),
            tris: Uint32Array.from(tris),
            parts,
            morphs,
            bones: sk.bones,
            inverses: sk.boneInverses,
            mats: sk.bones.map(() => new THREE.Matrix4()),
            out: new Float32Array(base * 3),
        };
    }

    /** Skin every vertex into the rig's own space, the face's shape keys first. */
    skinVertices() {
        const S = this.skin;
        const mp = S.mpos;
        const n3 = S.skinnedCount * 3;
        mp.set(S.pos.subarray(0, n3));
        const inf = this.rig.mesh.morphTargetInfluences;
        S.morphs.forEach((m, k) => {
            const w = inf[k];
            if (!w) return;
            for (let i = 0; i < m.idx.length; i++) {
                const o = m.idx[i] * 3;
                mp[o] += w * m.d[i * 3];
                mp[o + 1] += w * m.d[i * 3 + 1];
                mp[o + 2] += w * m.d[i * 3 + 2];
            }
        });
        const inv = new THREE.Matrix4().copy(this.scene.matrixWorld).invert();
        for (let i = 0; i < S.bones.length; i++) S.mats[i].multiplyMatrices(inv, S.bones[i].matrixWorld).multiply(S.inverses[i]);
        const { bone, weight, out } = S;
        for (let v = 0; v < S.count; v++) {
            const o = v * 3;
            const x = mp[o]; const y = mp[o + 1]; const z = mp[o + 2];
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
        const m = this.rig.mesh;
        const d = new THREE.SkinnedMesh(m.geometry, this.depthMaterial);
        d.bind(m.skeleton, m.bindMatrix);
        d.frustumCulled = false;
        d.renderOrder = -0.5;
        m.parent.add(d);
        this.depthMeshes = [d];
        this.accessories.forEach((a) => {
            const c = new THREE.Mesh(a.geometry, this.depthMaterial);
            c.renderOrder = -0.5;
            c.userData.accessoryDepth = true;
            a.parent.add(c);
            this.depthMeshes.push(c);
        });
    }

    // ---- Parameters ----

    sync(item) {
        this.item = item;
        this.op = { ...CAT_DEFAULTS, ...item.op };
        this.pose = { ...zero(), ...item.pose };
        const op = this.op;
        this.object.position.set(op.posX, op.posY, op.posZ);
        this.object.rotation.set(op.rotX * D2R, op.rotY * D2R, op.rotZ * D2R);
        this.object.scale.setScalar(op.scale);
        if (!this.ready) return;
        applyCatLook(this.M, op);
        if (shapeKey(op) !== this.shapeKey) this.build(op);
        if (this.derivedKeyOf(op) !== this.derivedKey) {
            this.depthMeshes.forEach((d) => d.removeFromParent());
            this.depthMaterial.dispose();
            this.buildDerived();
        }
        this.k = op.height / Math.max(1e-6, this.rig.height);
        this.norm.scale.setScalar(this.k);
        if (`${op.wireMode}|${op.wireAngle}` !== this.wireKey) this.buildWire();
        if (op.pointCount !== this.pointKey) this.buildPoints();
        this.rig.headphones.visible = !!op.headphones;
        this.rig.glasses.visible = !!op.glasses;
        this.applyNoise();
        this.applyFaceMode();
        this.applyView();
    }

    /** Layers or paint: which draws the face. */
    applyFaceMode() {
        const paint = this.op.faceMode === 'paint';
        ['ink', 'blush', 'tongue'].forEach((k) => { this.M[k].visible = !paint; });
        this.facePaint.on.value = paint ? 1 : 0;
        if (!paint) this.paintKey = null;
    }

    /** Repaint the face for shape-key weights `w` when they, the shape or the size changed. */
    paintFace(w) {
        const rig = this.rig;
        const px = Math.max(256, Math.min(4096, Number(this.op.facePixels) || 2048));
        const box = rig.face.box;
        const width = px; const height = Math.max(64, Math.round((px * box.h) / box.w));
        const key = `${width}x${height}|${Array.from(w, (v) => v.toFixed(4)).join(',')}`;
        if (key === this.paintKey && this.paintRig === rig) return;
        this.paintKey = key;
        this.paintRig = rig;
        if (!this.faceCanvas || this.faceCanvas.width !== width || this.faceCanvas.height !== height) {
            this.faceTex?.dispose();
            this.faceCanvas = document.createElement('canvas');
            this.faceCanvas.width = width;
            this.faceCanvas.height = height;
            const t = new THREE.CanvasTexture(this.faceCanvas);
            // Weights, not colours: no colour space, and premultiplied so their edges filter clean.
            t.premultiplyAlpha = true;
            t.anisotropy = 8;
            t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
            this.faceTex = t;
            this.facePaint.map.value = t;
        }
        paintCatFace(this.faceCanvas, rig.face, w);
        this.facePaint.box.value.set(box.x0, box.y0, box.w, box.h);
        this.faceTex.needsUpdate = true;
    }

    applyNoise() {
        const op = this.op;
        const on = !!op.texOn && op.texStrength > 0;
        this.noise.fur.value = on ? 1 : 0;
        this.noise.rest.value = on && op.texParts === 'all' ? 1 : 0;
        if (!on) return;
        this.noise.map.value = hullTexture(texSpec(op));
        // Tiles per unit of his own (bind) space: metres over the tile size.
        this.noise.scale.value = (this.k * (op.scale || 1)) / Math.max(1e-3, op.texRepeat);
    }

    applyView() {
        super.applyView();
        const op = this.op;
        const hull = !!op.viewTextured;
        const overlay = !!op.viewWire || !!op.viewPoints;
        this.accessories.forEach((m) => {
            m.visible = hull;
            m.castShadow = !!op.castShadow;
            m.receiveShadow = true;
        });
        this.depthMeshes.forEach((d) => {
            d.visible = !hull && overlay && op.selfOcclude;
            d.castShadow = !hull && !!op.castShadow;
        });
    }

    // ---- Per frame ----

    /** The blink now: 0 open, 1 shut. Every `blinkEvery` seconds, give or take, a quick blink and now and then a double. */
    blinkAt(t) {
        const every = Math.max(0.4, this.op.blinkEvery);
        const n = Math.floor(t / every);
        const r = mulberry32((this.blinkSeed ^ (n * 2654435761)) >>> 0);
        const at = n * every + r() * every * 0.6;
        const one = (s) => { const u = (t - s) / 0.16; return u < 0 || u > 1 ? 0 : 1 - Math.abs(2 * u - 1); };
        return Math.max(one(at), r() < 0.2 ? one(at + 0.24) : 0);
    }

    /** The face's shape-key weights for parameters `op`. */
    faceTargets(op) {
        const w = new Float32Array(CAT_MORPHS.length);
        const eyes = CAT_EYES[op.eyes]?.keys || {};
        const mouth = CAT_MOUTHS[op.mouth]?.keys || {};
        CAT_MORPHS.forEach((n, i) => {
            let v = (eyes[n] || 0) + (mouth[n] || 0) + (op[`sk_${n}`] || 0);
            if (n === 'blush') v = (op.blush ?? 0) + (op.sk_blush || 0);
            w[i] = Math.max(0, Math.min(1.5, v));
        });
        if (op.blinkOn) {
            const b = this.blinkAt(this.clock);
            if (b > 0) CAT_MORPHS.forEach((n, i) => { if (n.startsWith('eye')) w[i] *= 1 - b; });
        }
        return w;
    }

    /**
     * The two poses being blended, as whole poses (a preset of his top half
     * takes the rest from his edited pose), how far between them, and the
     * motion now of whichever moves, scaled by how much of it is mixed in.
     * Null when he isn't blending.
     */
    blendedPoses(op) {
        if (!op.poseBlend) return null;
        const own = this.pose;
        this.presetPoses = this.presetPoses || {};
        const whole = (id) => {
            const preset = CAT_POSES[id];
            if (!preset) return own;
            if (!this.presetPoses[id]) this.presetPoses[id] = preset.make().pose;
            const made = this.presetPoses[id];
            const out = preset.only ? { ...own } : { ...made };
            (preset.only || []).forEach((j) => { out[j] = made[j]; });
            return out;
        };
        const mix = Math.max(0, Math.min(1, Number.isFinite(op.poseMix) ? op.poseMix : 0));
        const move = {};
        [[op.poseFrom, 1 - mix], [op.poseTo, mix]].forEach(([id, w]) => {
            const m = w > 0 ? CAT_POSES[id]?.move : null;
            if (!m) return;
            Object.entries(m(this.clock, Math.max(0, op.typeRate ?? 4), (op.typeDepth ?? 25) * w)).forEach(([j, a]) => {
                const cur = move[j] || [0, 0, 0];
                move[j] = [cur[0] + a[0], cur[1] + a[1], cur[2] + a[2]];
            });
        });
        const full = (p) => Object.fromEntries(JOINT_IDS.map((j) => [j, p[j] || [0, 0, 0]]));
        return { from: full(whole(op.poseFrom)), to: full(whole(op.poseTo)), mix, move };
    }

    /** Sample clip `name` at `t` into `out` (bone -> { q, p }). */
    sampleClip(name, t, out) {
        const c = this.clips[name];
        if (!c) return;
        const time = ((t % c.clip.duration) + c.clip.duration) % c.clip.duration;
        c.tracks.forEach(({ bone, prop, interp }) => {
            if (!bone) return;
            const v = interp.evaluate(time);
            const e = out.get(bone) || {};
            if (prop === 'quaternion') e.q = new THREE.Quaternion(v[0], v[1], v[2], v[3]);
            else if (prop === 'position') e.p = new THREE.Vector3(v[0], v[1], v[2]);
            out.set(bone, e);
        });
    }

    update(dt, ctx = {}) {
        if (!this.ready) return;
        const op = this.op;
        this.time += dt;
        this.clock += dt;
        const rig = this.rig;

        // The clip, cross-faded from the last one.
        const anim = this.clips[op.anim] ? op.anim : 'none';
        if (anim !== this.animNow) {
            // The first clip starts as is; a change fades over animFade.
            const first = this.animNow === undefined;
            this.animFrom = this.animNow ?? 'none';
            this.animFromT = this.animT ?? 0;
            this.animNow = anim;
            this.animMix = !first && op.animFade > 0 ? 0 : 1;
            this.animT = 0;
        }
        this.animT = (this.animT ?? 0) + dt * op.animSpeed;
        this.animFromT = (this.animFromT ?? 0) + dt * op.animSpeed;
        this.animMix = Math.min(1, (this.animMix ?? 1) + (op.animFade > 0 ? dt / op.animFade : 1));
        const from = new Map();
        const to = new Map();
        if (this.animMix < 1) this.sampleClip(this.animFrom, this.animFromT, from);
        this.sampleClip(anim, this.animT, to);
        const mix = this.animMix;

        // Procedural layers, in the body frame, on top of the pose.
        const offs = {};
        const addOff = (j, axis, angle) => {
            if (!angle) return;
            const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            offs[j] = offs[j] ? offs[j].multiply(q) : q;
        };
        addOff('chest', X, 0.03 * Math.sin(this.time * 1.7) * op.breathe);
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
        addOff('head', Y, op.headYaw * D2R);
        addOff('head', X, op.headPitch * D2R);
        addOff('head', Z, op.headRoll * D2R);
        // Ear flicks: positive folds the ear outward.
        addOff('earL', Z, -op.earL * D2R);
        addOff('earR', Z, op.earR * D2R);
        this.offsets = offs;

        // Bones: rest, then clip, pose and layers.
        rig.bones.forEach((b) => { b.position.copy(b.userData.restP); b.quaternion.identity(); });
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();
        const blendInto = (bone) => {
            const a = from.get(bone);
            const b = to.get(bone);
            if (!a && !b) return;
            qa.copy(a?.q || bone.quaternion);
            qb.copy(b?.q || bone.quaternion);
            bone.quaternion.copy(mix < 1 ? qa.slerp(qb, mix) : qb);
            if (a?.p || b?.p) {
                const pa = a?.p || bone.userData.restP;
                const pb = b?.p || bone.userData.restP;
                bone.position.copy(pa).lerp(pb, mix);
            }
        };
        rig.bones.forEach(blendInto);
        const R = new THREE.Quaternion();
        const Rb = new THREE.Quaternion();
        const e = new THREE.Euler();
        const fromDeg = (q, a) => q.setFromEuler(e.set(a[0] * D2R, a[1] * D2R, a[2] * D2R, 'XYZ'));
        const blend = this.blendedPoses(op);
        CAT_JOINTS.forEach(([j]) => {
            const list = this.jointBones[j];
            if (blend) {
                // Turned from one pose's angle to the other's the short way round.
                fromDeg(R, blend.from[j]).slerp(fromDeg(Rb, blend.to[j]), blend.mix);
                const m = blend.move[j];
                if (m) R.multiply(fromDeg(Rb, m));
            } else {
                fromDeg(R, this.pose[j] || [0, 0, 0]);
            }
            if (offs[j]) R.multiply(offs[j]);
            list.forEach((bone) => bone.quaternion.multiply(R));
        });
        // Ear spacing and height, without rebuilding him (so his size stays):
        // apart or together they slide over his head, staying on its
        // surface; raised, they stretch from their roots, which stay sunk in
        // his head; lowered, they sink into it.
        const E = rig.ears;
        if (E) {
            const x1 = E.halfW * Math.max(0.05, Math.min(0.95, E.x / E.halfW + (op.earSpacing || 0)));
            const lift = op.earHeight || 0;
            const len = E.root + E.tip;
            const sy = lift > 0 ? 1 + lift : 1;
            const sink = lift < 0 ? lift * len : 0;
            [['L', 1], ['R', -1]].forEach(([sd, s]) => {
                const bone = this.bonesByName[`ear_${sd}`];
                if (!bone) return;
                bone.position.x += s * (x1 - E.x);
                bone.position.y += E.top(x1) - E.top(E.x) + sink;
                bone.scale.set(1, sy, 1);
                // Stretched about its bone, the root would sink further: up the ear's own axis by as much.
                if (sy !== 1) bone.position.add(new THREE.Vector3(0, E.root * (sy - 1), 0).applyQuaternion(bone.quaternion));
            });
        }
        // The tail wags along its length, each joint a little later.
        if (op.tailWag) {
            ['tail_1', 'tail_2', 'tail_3'].forEach((n, i) => {
                const a = op.tailWag * D2R * Math.sin(TAU * op.tailRate * this.clock - i * 0.8) * (0.8 + i * 0.15);
                this.bonesByName[n].quaternion.multiply(qa.setFromAxisAngle(Y, a));
            });
        }
        // Sitting: the hips sink by a share of his legs.
        if (op.hipDrop) rig.bone.hips.position.y -= op.hipDrop * rig.bone.hips.userData.restP.y;

        // The face.
        const want = this.faceTargets(op);
        const inf = rig.mesh.morphTargetInfluences;
        const ease = op.faceEase > 0 ? Math.min(1, dt / op.faceEase) : 1;
        for (let i = 0; i < inf.length; i++) inf[i] += (want[i] - inf[i]) * (this.faceSet ? ease : 1);
        this.faceSet = true;
        if (op.faceMode === 'paint' && op.viewTextured) this.paintFace(inf);

        this.scene.updateMatrixWorld(true);
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

    dispose() {
        this.disposed = true;
        if (this.ready) {
            this.teardown();
            this.materials.forEach((m) => m.dispose());
            this.faceTex?.dispose();
        }
        this.object.removeFromParent();
    }
}

/** The pose a preset makes, for the host's preset buttons. */
export function catPreset(id) {
    return CAT_POSES[id]?.make();
}
