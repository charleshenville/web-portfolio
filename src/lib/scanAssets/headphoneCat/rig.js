// The headphone cat's rig, built from its shape parameters: one skinned mesh
// (fur, plus the face drawn as thin decals on the head whose expressions are
// shape keys), a 19-bone skeleton, headphones and glasses riding the head
// bone, and four animation clips. Ported from the Cat Rig page it was
// designed in (headphone-cat-rig/Cat Rig.html); keep the two in
// step. The one change is that materials come from the caller, so every
// placed cat has its own colours.
//
// The cat stands on y = 0 facing +Z, his left at +X, about 0.94 units tall
// at the defaults. Every bone rests with no rotation, so an angle on a bone
// is in his body's frame until a parent turns it.

import * as THREE from 'three';

const V3 = THREE.Vector3;
const sp = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const ss = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/**
 * The shape parameters, at the cat as exported to headphone_cat_rig.glb
 * (fitted to its vertices, which these rebuild exactly; the Cat Rig page's
 * own defaults differ).
 */
export const CAT_SHAPE_DEFAULTS = {
    detail: 1,
    flat: false,
    headW: 0.7, headH: 0.85, headD: 0.88, headRound: 2.73,
    bodyW: 0.77, bodyH: 0.82, armLen: 0.94, armThick: 0.7, armAngle: 58, legLen: 0.81, legThick: 0.83, legSpread: 0.96,
    earSize: 0.94, earSpread: 0.41, earTilt: 16, tailLen: 0.41, tailThick: 0.59,
    eyeX: 0.39, eyeY: -0.21, eyeSize: 0.8, eyeWeight: 1.02,
    mouthY: -0.41, mouthSize: 1.71, mouthWeight: 1, tongueSize: 1, tongueY: 0, tongueOutline: false, outlineWeight: 1,
    blushX: 0.5, blushY: -0.34, blushSize: 1,
    glassesStyle: 'round', glassesW: 1.5, glassesH: 1.45, glassesX: 0, glassesY: 0.06, frameThick: 1.27,
    hpSize: 1.11, bandThick: 1.63,
};

/** Colours, as exported. */
export const CAT_COLOUR_DEFAULTS = {
    furColor: '#f1efea',
    inkColor: '#1d1b21',
    blushColor: '#ffb8c2',
    tongueColor: '#f07a8c',
    shellColor: '#272d52',
    padColor: '#16192a',
    frameColor: '#787878',
};

/** The shape fields as the inspector edits them: [key, label, min, max, step] or [key, label, 'bool' | ['choice', options]]. */
export const CAT_SHAPE_GROUPS = [
    ['Head', [['headW', 'Width', 0.7, 1.4, 0.01], ['headH', 'Height', 0.7, 1.4, 0.01], ['headD', 'Depth', 0.7, 1.4, 0.01], ['headRound', 'Boxiness', 2, 4.5, 0.01]]],
    ['Body & limbs', [
        ['bodyW', 'Body width', 0.7, 1.5, 0.01], ['bodyH', 'Body height', 0.6, 1.8, 0.01],
        ['armLen', 'Arm length', 0.5, 2, 0.01], ['armThick', 'Arm thickness', 0.6, 1.6, 0.01], ['armAngle', 'Arm angle °', 0, 80, 1],
        ['legLen', 'Leg length', 0.4, 2.5, 0.01], ['legThick', 'Leg thickness', 0.6, 1.6, 0.01], ['legSpread', 'Leg spread', 0.7, 1.4, 0.01],
        ['earSize', 'Ear size', 0.4, 1.8, 0.01], ['earSpread', 'Ear spread', 0.3, 0.8, 0.01], ['earTilt', 'Ear tilt °', 0, 40, 1],
        ['tailLen', 'Tail length', 0.3, 2, 0.01], ['tailThick', 'Tail thickness', 0.5, 2, 0.01]]],
    ['Eyes', [['eyeX', 'Spacing', 0.12, 0.65, 0.01], ['eyeY', 'Height', -0.75, 0.35, 0.01], ['eyeSize', 'Size', 0.5, 2, 0.01], ['eyeWeight', 'Thickness', 0.4, 3, 0.01]]],
    ['Mouth & tongue', [['mouthY', 'Mouth height', -0.85, -0.15, 0.01], ['mouthSize', 'Mouth size', 0.5, 2.5, 0.01], ['mouthWeight', 'Mouth thickness', 0.4, 3, 0.01],
        ['tongueSize', 'Tongue size', 0.5, 1.6, 0.01], ['tongueY', 'Tongue offset', -1, 1, 0.01], ['tongueOutline', 'Tongue outline', 'bool'], ['outlineWeight', 'Outline thickness', 0.4, 3, 0.01]]],
    ['Blush', [['blushX', 'Spacing', 0.2, 0.78, 0.01], ['blushY', 'Height', -0.85, -0.1, 0.01], ['blushSize', 'Size', 0.4, 2, 0.01]]],
    ['Glasses', [['glassesStyle', 'Style', ['choice', [['rect', 'Rectangular'], ['round', 'Round']]]],
        ['glassesW', 'Lens width', 0.6, 1.5, 0.01], ['glassesH', 'Lens height', 0.6, 1.6, 0.01], ['glassesX', 'Spread', -0.12, 0.12, 0.005], ['glassesY', 'Height', -0.25, 0.25, 0.005],
        ['frameThick', 'Frame thickness', 0.5, 2.5, 0.01]]],
    ['Headphones', [['hpSize', 'Cup size', 0.7, 1.4, 0.01], ['bandThick', 'Band thickness', 0.6, 2, 0.01]]],
];

/** The shape keys, in the mesh's order (as the GLB names them). */
export const CAT_MORPHS = [
    'eyeL_open', 'eyeL_happy', 'eyeL_wide', 'eyeL_angry', 'eyeL_sad', 'eyeL_squint',
    'eyeR_open', 'eyeR_happy', 'eyeR_wide', 'eyeR_angry', 'eyeR_sad', 'eyeR_squint',
    'mouth_smile', 'mouth_frown', 'mouth_open', 'mouth_o', 'mouth_blep', 'blush',
];

/** Expressions, as sets of shape-key weights (the page's chips). Neutral eyes are closed lines, the neutral mouth a cat's ω. */
export const CAT_EYES = {
    neutral: { name: 'Neutral –', keys: {} },
    open: { name: 'Open', keys: { eyeL_open: 1, eyeR_open: 1 } },
    happy: { name: 'Happy ^^', keys: { eyeL_happy: 1, eyeR_happy: 1 } },
    surprised: { name: 'Surprised', keys: { eyeL_wide: 1, eyeR_wide: 1 } },
    angry: { name: 'Angry', keys: { eyeL_angry: 1, eyeR_angry: 1 } },
    sad: { name: 'Sad', keys: { eyeL_sad: 1, eyeR_sad: 1 } },
    squint: { name: 'Squint ><', keys: { eyeL_squint: 1, eyeR_squint: 1 } },
    wink: { name: 'Wink', keys: { eyeL_open: 1, eyeR_happy: 1 } },
};
export const CAT_MOUTHS = {
    cat: { name: 'Cat ω', keys: {} },
    smile: { name: 'Smile', keys: { mouth_smile: 1 } },
    open: { name: 'Open', keys: { mouth_open: 1 } },
    o: { name: 'O', keys: { mouth_o: 1 } },
    frown: { name: 'Frown', keys: { mouth_frown: 1 } },
    blep: { name: 'Blep', keys: { mouth_blep: 1 } },
};

/** Bones, parent first: [name, parent]. */
export const CAT_BONES = [
    ['root', null], ['hips', 'root'], ['spine', 'hips'], ['chest', 'spine'], ['neck', 'chest'], ['head', 'neck'],
    ['ear_L', 'head'], ['ear_R', 'head'], ['arm_L', 'chest'], ['hand_L', 'arm_L'], ['arm_R', 'chest'], ['hand_R', 'arm_R'],
    ['leg_L', 'hips'], ['foot_L', 'leg_L'], ['leg_R', 'hips'], ['foot_R', 'leg_R'], ['tail_1', 'hips'], ['tail_2', 'tail_1'], ['tail_3', 'tail_2'],
];

/** The materials a rig is drawn with, made fresh for each cat. */
export function makeCatMaterials() {
    const mat = (name, o = {}) => new THREE.MeshStandardMaterial({ name, roughness: 0.5, metalness: 0, ...o });
    return {
        fur: mat('fur', { roughness: 0.42 }),
        ink: mat('ink', { roughness: 0.85, side: THREE.DoubleSide }),
        blush: mat('blush', { roughness: 0.9, side: THREE.DoubleSide }),
        tongue: mat('tongue', { roughness: 0.6, side: THREE.DoubleSide }),
        shell: mat('headphone_shell', { roughness: 0.32, metalness: 0.15 }),
        pad: mat('headphone_pad', { roughness: 0.75 }),
        frame: mat('glasses_frame', { roughness: 0.28, metalness: 0.35 }),
    };
}

/** Set the materials' colours and shading from parameters. */
export function applyCatLook(M, P) {
    M.fur.color.set(P.furColor); M.ink.color.set(P.inkColor); M.blush.color.set(P.blushColor); M.tongue.color.set(P.tongueColor);
    M.frame.color.set(P.frameColor); M.shell.color.set(P.shellColor); M.pad.color.set(P.padColor);
    for (const k of ['fur', 'shell', 'pad', 'frame']) {
        if (M[k].flatShading !== !!P.flat) { M[k].flatShading = !!P.flat; M[k].needsUpdate = true; }
    }
}

// ---- Geometry helpers ------------------------------------------------------

// Segment counts per poly-detail level (1..5).
const DT = {
    head: [[10, 6], [14, 9], [22, 14], [40, 26], [72, 48]], cap: [[6, 2], [8, 3], [12, 4], [18, 6], [24, 8]], cone: [6, 8, 14, 24, 40],
    lathe: [6, 10, 16, 28, 48], cyl: [8, 12, 20, 32, 48], tor: [[4, 10], [6, 14], [8, 20], [12, 32], [16, 48]], tube: [[10, 5], [16, 6], [24, 8], [36, 12], [48, 16]],
    sw: [4, 6, 8, 12, 16], band: [12, 18, 28, 44, 64], tip: [[6, 4], [8, 5], [10, 7], [14, 10], [16, 12]], lens: [12, 16, 24, 36, 48], corner: [2, 3, 4, 5, 6], off: [0.006, 0.004, 0.002, 0, 0],
};

/** A rounded-rectangle tube swept along `path`. */
function sweep(path, closed, bin, center, hu, hv, seg) {
    const n = path.length; const prof = []; const P_ = [];
    for (let j = 0; j < seg; j++) { const a = (2 * Math.PI * j) / seg; prof.push([hu * sp(Math.cos(a), 0.45), hv * sp(Math.sin(a), 0.45)]); }
    for (let i = 0; i < n; i++) {
        const pr = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]; const nx = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
        const t = nx.clone().sub(pr).normalize(); const nr = bin.clone().cross(t).normalize();
        if (nr.dot(path[i].clone().sub(center)) < 0) nr.negate();
        for (const [u, v] of prof) { const q = path[i].clone().addScaledVector(nr, u).addScaledVector(bin, v); P_.push(q.x, q.y, q.z); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P_, 3));
    const build = (flip) => {
        const id = [];
        for (let i = 0; i < (closed ? n : n - 1); i++) {
            for (let j = 0; j < seg; j++) {
                const i1 = (i + 1) % n; const j1 = (j + 1) % seg; const a = i * seg + j; const b = i1 * seg + j; const c = i1 * seg + j1; const d = i * seg + j1;
                if (flip) id.push(a, c, b, a, d, c); else id.push(a, b, c, a, c, d);
            }
        }
        g.setIndex(id); g.computeVertexNormals();
    };
    build(false);
    const n0 = new V3().fromBufferAttribute(g.attributes.normal, 0); const p0 = new V3().fromBufferAttribute(g.attributes.position, 0);
    if (n0.dot(p0.sub(path[0])) < 0) build(true);
    return g;
}
const named = (name, g, m) => { const o = new THREE.Mesh(g, m); o.name = name; return o; };
function bar(p0, p1, t) {
    const d = p1.clone().sub(p0); const g = new THREE.BoxGeometry(d.length() + t, t, t);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(1, 0, 0), d.normalize()));
    const m = p0.clone().add(p1).multiplyScalar(0.5); g.translate(m.x, m.y, m.z); return g;
}
function norm4(list) {
    const l = list.filter((e) => e[1] > 1e-6).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const s = l.reduce((a, e) => a + e[1], 0);
    while (l.length < 4) l.push([0, 0]);
    return l.map(([i, w]) => [i, s ? w / s : 0]);
}

/**
 * A capsule along Y about the origin, laid out as three.js r184 builds one
 * (the Cat Rig page's): rings from the bottom pole up, `capSeg` rings per cap,
 * three along the middle, `radial` + 1 vertices a ring. three r152's own
 * CapsuleGeometry has no middle rings and so different facets.
 */
function capsule(radius, length, capSeg, radial, heightSeg = 3) {
    const rows = [];
    const half = length / 2;
    for (let i = 0; i <= capSeg; i++) { const a = (Math.PI / 2) * (i / capSeg); rows.push([half + radius * Math.cos(a), radius * Math.sin(a), half]); }
    for (let i = 1; i < heightSeg; i++) rows.push([half - (length * i) / heightSeg, radius, null]);
    for (let i = 0; i <= capSeg; i++) { const a = (Math.PI / 2) * (i / capSeg); rows.push([-half - radius * Math.sin(a), radius * Math.cos(a), -half]); }
    rows.reverse();
    const pos = []; const nor = []; const idx = [];
    rows.forEach(([y, r, c]) => {
        for (let j = 0; j <= radial; j++) {
            const u = (j / radial) * Math.PI * 2;
            const x = -r * Math.cos(u); const z = r * Math.sin(u);
            pos.push(x, y, z);
            const n = c === null ? new V3(x, 0, z) : new V3(x, y - c, z);
            if (n.lengthSq() < 1e-12) n.set(0, Math.sign(y), 0);
            n.normalize(); nor.push(n.x, n.y, n.z);
        }
    });
    const w = radial + 1;
    for (let i = 0; i < rows.length - 1; i++) {
        for (let j = 0; j < radial; j++) {
            const a = i * w + j; const b = a + w; const c = b + 1; const d = a + 1;
            if (i > 0) idx.push(a, d, b);
            if (i < rows.length - 2) idx.push(b, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
}

// Face shapes: NP columns of (A, B) pairs across a stroke.
const NP = 24;
function ribbon(pts, w) {
    const Aa = []; const Bb = [];
    pts.forEach(([x, y], i) => {
        const pr = pts[Math.max(0, i - 1)]; const nx_ = pts[Math.min(NP - 1, i + 1)];
        const tx = nx_[0] - pr[0]; const ty = nx_[1] - pr[1]; const L = Math.hypot(tx, ty) || 1;
        const nx = -ty / L; const ny = tx / L; const t = i / (NP - 1); const h = (w * (0.45 + 0.55 * Math.pow(Math.sin(Math.PI * t), 0.35))) / 2;
        Aa.push([x - nx * h, y - ny * h]); Bb.push([x + nx * h, y + ny * h]);
    });
    return { A: Aa, B: Bb };
}
const lineS = (x0, y0, x1, y1, w, bend = 0) => ribbon([...Array(NP)].map((_, i) => { const t = i / (NP - 1); return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + bend * 4 * t * (1 - t)]; }), w);
function polyS(poly, w) {
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    const pts = [];
    const total = cum[cum.length - 1];
    for (let i = 0; i < NP; i++) {
        const d = (total * i) / (NP - 1); let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
        const t = (d - cum[k - 1]) / (cum[k] - cum[k - 1]); pts.push([poly[k - 1][0] + (poly[k][0] - poly[k - 1][0]) * t, poly[k - 1][1] + (poly[k][1] - poly[k - 1][1]) * t]);
    }
    return ribbon(pts, w);
}
function ellS(cx, cy, rx, up, dn = up) {
    const Aa = []; const Bb = [];
    for (let i = 0; i < NP; i++) { const t = i / (NP - 1); const x = cx - rx * Math.cos(Math.PI * t); const s = Math.sin(Math.PI * t); Aa.push([x, cy - dn * s]); Bb.push([x, cy + up * s]); }
    return { A: Aa, B: Bb };
}
const dotS = (cx, cy) => ({ A: Array(NP).fill([cx, cy]), B: Array(NP).fill([cx, cy]) });

/**
 * Build the cat for shape parameters `P` (CAT_SHAPE_DEFAULTS' keys) drawn with
 * materials `M` (makeCatMaterials). Returns `{ model, mesh, bones, bone,
 * headphones, glasses, height, hipsY }`, the model at rest; `model.animations`
 * holds the clips Idle, Wave, Walk and Hop.
 */
export function buildCatRig(P, M) {
    const L = Math.max(0, Math.min(4, Math.round(P.detail) - 1)); const NE = P.headRound;
    const A = 0.42 * P.headW; const HB = 0.30 * P.headH; const C = 0.34 * P.headD;
    const zA = (x, yr) => C * Math.pow(Math.max(0, 1 - Math.abs(x / A) ** NE - Math.abs(yr / HB) ** NE), 1 / NE);
    const hN = (x, y, z) => new V3(sp(x / A, NE - 1) / A, sp(y / HB, NE - 1) / HB, sp(z / C, NE - 1) / C).normalize();

    // Vertical layout.
    const legR = 0.058 * P.legThick; const legL = 0.07 * P.legLen; const Hl = legL + 2 * legR; const legX = 0.068 * P.legSpread * P.bodyW;
    const bb = Hl - Math.min(0.086, Hl * 0.5); const bh = P.bodyH; const bw = P.bodyW;
    const bodyTop = bb + 0.275 * bh; const CY = bodyTop + HB - 0.055;
    const hipsY = bb + 0.04 * bh;
    const ang = (P.armAngle * Math.PI) / 180; const AD = new V3(Math.cos(ang), -Math.sin(ang), 0);
    const shY = bb + 0.18 * bh; const shX = 0.10 * bw; const armR = 0.046 * P.armThick; const armL = 0.085 * P.armLen; const handD = 0.075 * P.armLen;
    // Ears.
    const earX = P.earSpread * A; const earZ = -0.08 * P.headD; const es = P.earSize;
    const kE = Math.max(0.03, 1 - Math.abs(earX / A) ** NE - Math.abs(earZ / C) ** NE); const earTopY = CY + HB * Math.pow(kE, 1 / NE);
    // Tail.
    const tRoot = new V3(0, hipsY + 0.03, -0.09 * bw);
    const tailCurve = new THREE.CatmullRomCurve3([[0, 0, 0], [0.02, -0.01, -0.10], [0.07, 0.03, -0.18], [0.11, 0.12, -0.21], [0.12, 0.21, -0.18]]
        .map(([x, y, z]) => new V3(x, y, z).multiplyScalar(P.tailLen).add(tRoot)));

    const at = {
        root: [0, 0, 0], hips: [0, hipsY, 0], spine: [0, bb + 0.12 * bh, 0], chest: [0, bb + 0.19 * bh, 0], neck: [0, bb + 0.24 * bh, 0], head: [0, bb + 0.27 * bh, 0],
        ear_L: [earX, earTopY - 0.02, earZ], ear_R: [-earX, earTopY - 0.02, earZ],
        arm_L: [shX, shY, 0], hand_L: [shX + AD.x * handD, shY + AD.y * handD, 0],
        arm_R: [-shX, shY, 0], hand_R: [-shX - AD.x * handD, shY + AD.y * handD, 0],
        leg_L: [legX, Hl * 0.645, 0], foot_L: [legX, Hl * 0.27, 0],
        leg_R: [-legX, Hl * 0.645, 0], foot_R: [-legX, Hl * 0.27, 0],
        tail_1: tailCurve.getPointAt(0).toArray(), tail_2: tailCurve.getPointAt(0.36).toArray(), tail_3: tailCurve.getPointAt(0.7).toArray(),
    };
    const bone = {}; const bones = []; const W = {};
    for (const [n, p] of CAT_BONES) {
        const b = new THREE.Bone(); b.name = n; W[n] = new V3(...at[n]);
        b.position.copy(p ? W[n].clone().sub(W[p]) : W[n]); if (p) bone[p].add(b);
        b.userData.restP = b.position.clone(); bone[n] = b; bones.push(b);
    }
    const BI = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    const rigid = (n) => () => [[BI[n], 1]];
    const chain = (list, s) => {
        if (s <= list[0][1]) return [[BI[list[0][0]], 1]];
        for (let k = 0; k < list.length - 1; k++) {
            const [b0, s0] = list[k]; const [b1, s1] = list[k + 1];
            if (s <= s1) { const t = ss((s - s0) / (s1 - s0)); return [[BI[b0], 1 - t], [BI[b1], t]]; }
        }
        return [[BI[list[list.length - 1][0]], 1]];
    };

    const parts = [];
    const add = (name, geo, m, wf, morphs) => { if (geo.attributes.uv) geo.deleteAttribute('uv'); parts.push({ name, geo, m, wf, morphs }); };

    // Head: a superellipsoid.
    const hg = new THREE.SphereGeometry(1, DT.head[L][0], DT.head[L][1]);
    {
        const p = hg.attributes.position; const n = hg.attributes.normal;
        for (let i = 0; i < p.count; i++) {
            const x = p.getX(i); const y = p.getY(i); const z = p.getZ(i);
            const s = Math.pow(Math.abs(x / A) ** NE + Math.abs(y / HB) ** NE + Math.abs(z / C) ** NE, -1 / NE);
            const nn = hN(x * s, y * s, z * s); p.setXYZ(i, x * s, y * s + CY, z * s); n.setXYZ(i, nn.x, nn.y, nn.z);
        }
    }
    add('head', hg, 'fur', rigid('head'));
    // Where the face decals sit: on the real (faceted) mesh when it is coarse.
    let surf = zA;
    if (L <= 2) {
        const hm = new THREE.Mesh(hg); const ray = new THREE.Raycaster(); const o = new V3(); const dir = new V3(0, 0, -1);
        surf = (x, yr) => { ray.set(o.set(x, CY + yr, C + 1), dir); const h = ray.intersectObject(hm, false)[0]; return h ? h.point.z : zA(x, yr); };
    }

    for (const [sd, s] of [['L', 1], ['R', -1]]) {
        const h = 0.26 * es; const th = (-s * P.earTilt * Math.PI) / 180;
        const e = new THREE.ConeGeometry(0.14 * es, h, DT.cone[L]); e.scale(1, 1, 0.5); e.rotateZ(th);
        const bx = (h / 2) * Math.sin(th); const by = -(h / 2) * Math.cos(th);
        e.translate(s * earX - bx, earTopY - 0.045 * es - by, earZ);
        add(`ear_${sd}`, e, 'fur', rigid(`ear_${sd}`));
        const dir = new V3(s * AD.x, AD.y, 0); const sh = W[`arm_${sd}`];
        const a = capsule(armR, armL, DT.cap[L][1], DT.cap[L][0]);
        a.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), dir));
        const c = sh.clone().addScaledVector(dir, armL / 2 + armR * 0.38); a.translate(c.x, c.y, c.z);
        add(`arm_${sd}`, a, 'fur', (p) => chain([[`arm_${sd}`, 0], [`hand_${sd}`, handD]], p.clone().sub(sh).dot(dir)));
        const l = capsule(legR, legL, DT.cap[L][1], DT.cap[L][0]); l.scale(1, 1, 1.08); l.translate(s * legX, Hl / 2, 0.006);
        add(`leg_${sd}`, l, 'fur', (p) => chain([[`foot_${sd}`, Hl * 0.27], [`leg_${sd}`, Hl * 0.645]], p.y));
    }
    const body = new THREE.LatheGeometry([[0, 0.1], [0.07, 0.106], [0.115, 0.135], [0.135, 0.19], [0.133, 0.24], [0.12, 0.29], [0.09, 0.33], [0.05, 0.36], [0, 0.375]]
        .map(([r, y]) => new THREE.Vector2(r * bw, bb + (y - 0.1) * bh)), DT.lathe[L]);
    add('body', body, 'fur', (p) => chain([['hips', bb + 0.05 * bh], ['spine', bb + 0.12 * bh], ['chest', bb + 0.19 * bh], ['neck', bb + 0.255 * bh]], p.y));

    const [TS, TR] = DT.tube[L]; const tr = 0.03 * P.tailThick;
    const tail = new THREE.TubeGeometry(tailCurve, TS, tr, TR, false);
    {
        const p = tail.attributes.position; const v = new V3();
        for (let i = 0; i <= TS; i++) {
            const Pt = tailCurve.getPointAt(i / TS); const k = 1 - (0.35 * i) / TS;
            for (let j = 0; j <= TR; j++) { const id = i * (TR + 1) + j; v.fromBufferAttribute(p, id).sub(Pt).multiplyScalar(k).add(Pt); p.setXYZ(id, v.x, v.y, v.z); }
        }
    }
    add('tail', tail, 'fur', (p, i) => chain([['tail_1', 0], ['tail_2', 0.36], ['tail_3', 0.7]], Math.floor(i / (TR + 1)) / TS));
    const tip = new THREE.SphereGeometry(tr * 0.65, DT.tip[L][0], DT.tip[L][1]); const te = tailCurve.getPointAt(1); tip.translate(te.x, te.y, te.z);
    add('tail_tip', tip, 'fur', rigid('tail_3'));

    // Face.
    const fsc = (P.headW + P.headH) / 2; const EY = P.eyeY * HB; const EX = P.eyeX * A; const MY = P.mouthY * HB;
    const e_ = fsc * P.eyeSize; const ew = 0.016 * P.eyeWeight * fsc;
    const features = [];
    for (const [sd, s] of [['L', 1], ['R', -1]]) {
        const cx = s * EX; const inner = cx - s * 0.065 * e_; const outer = cx + s * 0.065 * e_;
        const slant = (yi, yo, bend = 0) => (inner < outer ? lineS(inner, EY + yi, outer, EY + yo, ew * 0.94, bend) : lineS(outer, EY + yo, inner, EY + yi, ew * 0.94, bend));
        const k = `eye${sd}_`; const q = (a) => a * e_;
        features.push({
            m: 'ink',
            base: { shape: lineS(cx - q(0.075), EY, cx + q(0.075), EY, ew, q(0.002)), off: 0.005 },
            targets: {
                [`${k}open`]: ellS(cx, EY + q(0.004), q(0.03), q(0.04)),
                [`${k}happy`]: lineS(cx - q(0.068), EY - q(0.012), cx + q(0.068), EY - q(0.012), ew * 0.94, q(0.034)),
                [`${k}wide`]: ellS(cx, EY + q(0.01), q(0.044), q(0.054)),
                [`${k}angry`]: slant(q(-0.022), q(0.018)),
                [`${k}sad`]: slant(q(0.022), q(-0.016), q(-0.004)),
                [`${k}squint`]: polyS(s > 0
                    ? [[cx + q(0.05), EY + q(0.032)], [cx - q(0.045), EY], [cx + q(0.05), EY - q(0.032)]]
                    : [[cx - q(0.05), EY + q(0.032)], [cx + q(0.045), EY], [cx - q(0.05), EY - q(0.032)]], ew * 0.94),
            },
        });
    }
    const ms = fsc * P.mouthSize; const mw = 0.009 * P.mouthWeight * fsc; const m_ = (a) => a * ms;
    const omega = ribbon([...Array(NP)].map((_, i) => { const t = i / (NP - 1); return [m_(-0.032 + 0.064 * t), MY - m_(0.012) * Math.abs(Math.sin(2 * Math.PI * t))]; }), mw);
    features.push({
        m: 'ink',
        base: { shape: omega, off: 0.005 },
        targets: {
            mouth_smile: lineS(m_(-0.042), MY + m_(0.01), m_(0.042), MY + m_(0.01), mw * 1.1, m_(-0.026)),
            mouth_frown: lineS(m_(-0.036), MY - m_(0.018), m_(0.036), MY - m_(0.018), mw * 1.1, m_(0.02)),
            mouth_open: ellS(0, MY + m_(0.002), m_(0.042), m_(0.01), m_(0.046)),
            mouth_o: ellS(0, MY - m_(0.01), m_(0.019), m_(0.024)),
        },
    });
    const ts = ms * P.tongueSize; const ty = P.tongueY * 0.02 * ms;
    features.push({
        m: 'tongue',
        base: { shape: dotS(0, MY - m_(0.02)), off: -0.03 },
        targets: {
            mouth_open: { shape: ellS(0, MY - m_(0.029) + ty, 0.03 * ts, 0.016 * ts, 0.012 * ts), off: 0.008 },
            mouth_blep: { shape: ellS(0, MY - m_(0.022) + ty, 0.015 * ts, 0.006 * ts, 0.016 * ts), off: 0.004 },
        },
    });
    if (P.tongueOutline) {
        const ow = 0.006 * P.outlineWeight * fsc;
        const arc = (cx, cy, rx, dn) => ribbon([...Array(NP)].map((_, i) => { const t = i / (NP - 1); return [cx - rx * Math.cos(Math.PI * t), cy - dn * Math.sin(Math.PI * t)]; }), ow);
        features.push({
            m: 'ink',
            base: { shape: dotS(0, MY - m_(0.02)), off: -0.03 },
            targets: {
                mouth_open: { shape: arc(0, MY - m_(0.029) + ty, 0.03 * ts, 0.012 * ts), off: 0.009 },
                mouth_blep: { shape: arc(0, MY - m_(0.022) + ty, 0.015 * ts, 0.016 * ts), off: 0.005 },
            },
        });
    }
    const bs = fsc * P.blushSize; const BX = P.blushX * A; const BY = P.blushY * HB;
    for (const s of [1, -1]) features.push({ m: 'blush', base: { shape: dotS(s * BX, BY), off: -0.03 }, targets: { blush: { shape: ellS(s * BX, BY, 0.042 * bs, 0.017 * bs), off: 0.003 } } });

    const offB = DT.off[L];
    const shapeVerts = ({ shape, off }) => {
        const out = [];
        for (let i = 0; i < NP; i++) {
            const a = shape.A[i]; const b = shape.B[i]; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            for (const [x, y] of [a, m, b]) out.push(x, CY + y, surf(x, y) + off + (off > 0 ? offB : 0));
        }
        return out;
    };
    features.forEach((f, fi) => {
        const base = shapeVerts(f.base); const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
        const nrm = [];
        for (let i = 0; i < base.length; i += 3) { const x = base[i]; const yr = base[i + 1] - CY; const n = hN(x, yr, zA(x, yr)); nrm.push(n.x, n.y, n.z); }
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        const idx = [];
        for (let i = 0; i < NP - 1; i++) { const a0 = 3 * i; const m0 = a0 + 1; const b0 = a0 + 2; const a1 = a0 + 3; const m1 = a0 + 4; const b1 = a0 + 5; idx.push(a0, a1, m1, a0, m1, m0, m0, m1, b1, m0, b1, b0); }
        g.setIndex(idx);
        const morphs = {};
        for (const [name, t] of Object.entries(f.targets)) {
            const spec = t.shape ? t : { shape: t, off: f.base.off };
            const v = shapeVerts(spec); morphs[name] = new Float32Array(v.map((x, i) => x - base[i]));
        }
        add(`face_${fi}`, g, f.m, rigid('head'), morphs);
    });

    // Merge into one skinned mesh, a group per material.
    const matOrder = ['fur', 'ink', 'blush', 'tongue'];
    const pos = []; const nor = []; const si = []; const sw = []; const ind = []; const groups = []; const morphPlace = [];
    let vc = 0; const tmp = new V3();
    matOrder.forEach((mk, mi) => {
        const start = ind.length;
        for (const pt of parts.filter((p) => p.m === mk)) {
            const g = pt.geo; const p = g.attributes.position; const n = g.attributes.normal; const base = vc;
            for (let i = 0; i < p.count; i++) {
                tmp.fromBufferAttribute(p, i); pos.push(tmp.x, tmp.y, tmp.z); nor.push(n.getX(i), n.getY(i), n.getZ(i));
                for (const [b, w] of norm4(pt.wf(tmp, i))) { si.push(b); sw.push(w); }
            }
            if (g.index) for (let i = 0; i < g.index.count; i++) ind.push(base + g.index.getX(i));
            else for (let i = 0; i < p.count; i++) ind.push(base + i);
            if (pt.morphs) morphPlace.push([base, pt.morphs]);
            vc += p.count; g.dispose();
        }
        groups.push([start, ind.length - start, mi]);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geo.setIndex(ind);
    groups.forEach(([s, c, m]) => geo.addGroup(s, c, m));
    geo.morphTargetsRelative = true;
    geo.morphAttributes.position = CAT_MORPHS.map((name) => {
        const arr = new Float32Array(vc * 3);
        for (const [base, mm] of morphPlace) if (mm[name]) arr.set(mm[name], base * 3);
        const a = new THREE.Float32BufferAttribute(arr, 3); a.name = name; return a;
    });
    const model = new THREE.Group(); model.name = 'headphone_cat';
    const mesh = new THREE.SkinnedMesh(geo, matOrder.map((k) => M[k]));
    mesh.name = 'cat_body'; mesh.frustumCulled = false;
    model.add(mesh); model.add(bone.root);
    model.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton); mesh.updateMorphTargets();

    // Headphones.
    const headphones = new THREE.Group(); headphones.name = 'headphones';
    {
        const HZ = 0.04 * P.headD; const hs = P.hpSize; const cupR = 0.125 * hs; const Ab = A + 0.055; const Bb = HB + 0.035;
        const t0 = Math.asin(Math.min(0.95, Math.pow(Math.min(1, (0.5 * cupR) / Bb), NE / 2))); const path = []; const nB = DT.band[L];
        for (let i = 0; i <= nB; i++) { const t = t0 + ((Math.PI - 2 * t0) * i) / nB; path.push(new V3(Ab * sp(Math.cos(t), 2 / NE), CY + Bb * sp(Math.sin(t), 2 / NE), HZ)); }
        headphones.add(named('headband', sweep(path, false, new V3(0, 0, 1), new V3(0, CY, HZ), 0.018 * P.bandThick, 0.036 * P.bandThick, DT.sw[L]), M.shell));
        for (const [sd, s] of [['L', 1], ['R', -1]]) {
            const cup = new THREE.CylinderGeometry(cupR, cupR, 0.075 * hs, DT.cyl[L]); cup.rotateZ(Math.PI / 2); cup.translate(s * (A + 0.02 + 0.0375 * hs), CY, HZ);
            const plate = new THREE.CylinderGeometry(0.1 * hs, 0.115 * hs, 0.03 * hs, DT.cyl[L]); plate.rotateZ(Math.PI / 2); plate.translate(s * (A + 0.02 + 0.09 * hs), CY, HZ);
            const cush = new THREE.TorusGeometry(0.095 * hs, 0.028 * hs, DT.tor[L][0], DT.tor[L][1]); cush.rotateY(Math.PI / 2); cush.translate(s * (A + 0.02), CY, HZ);
            headphones.add(named(`cup_${sd}`, cup, M.shell), named(`cup_plate_${sd}`, plate, M.shell), named(`cushion_${sd}`, cush, M.pad));
        }
    }
    // Glasses.
    const glasses = new THREE.Group(); glasses.name = 'glasses';
    {
        const round = P.glassesStyle === 'round'; const ft = P.frameThick;
        const lw = (round ? 0.06 : 0.085) * fsc * P.glassesW; const lh = (round ? 0.06 : 0.0475) * fsc * P.glassesH;
        const GX = EX + P.glassesX * A; const GY = EY + P.glassesY * HB; const tilt = 0.15;
        const loop = [];
        if (round) {
            const n = DT.lens[L];
            for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; loop.push(new V3(lw * Math.cos(a), lh * Math.sin(a), 0)); }
        } else {
            const r = Math.min(0.026 * fsc, lw * 0.6, lh * 0.6); const k = DT.corner[L];
            for (const [cx, cy, a0] of [[1, 1, 0], [-1, 1, 0.5], [-1, -1, 1], [1, -1, 1.5]]) {
                for (let i = 0; i <= k; i++) { const a = (a0 + i / (2 * k)) * Math.PI; loop.push(new V3(cx * (lw - r) + r * Math.cos(a), cy * (lh - r) + r * Math.sin(a), 0)); }
            }
        }
        const clear = 0.012 + 0.008 * ft;
        let zc = -1;
        for (const p of loop) { const x = p.x * Math.cos(tilt); const z = -p.x * Math.sin(tilt); zc = Math.max(zc, zA(GX + x, GY + p.y) + clear - z); }
        zc = Math.max(zc, zA(GX, GY) + clear);
        const cs = Math.cos(tilt); const sn = Math.sin(tilt);
        for (const [sd, s] of [['L', 1], ['R', -1]]) {
            const f = sweep(loop, true, new V3(0, 0, 1), new V3(), 0.0065 * ft, 0.008 * ft, DT.sw[L]); f.rotateY(s * tilt); f.translate(s * GX, CY + GY, zc);
            glasses.add(named(`lens_frame_${sd}`, f, M.frame));
            // The temple follows the head's contour back to the headphone cup.
            const ox = GX + lw * cs; const oy = CY + GY + lh * 0.25; const oz = zc - lw * sn; const yr = oy - CY;
            const k = Math.max(0.05, 1 - Math.abs(yr / HB) ** NE); const ax = A * Math.pow(k, 1 / NE) + 0.02; const cz = C * Math.pow(k, 1 / NE) + 0.02;
            const ts0 = (ox + 0.02) < ax ? Math.acos(Math.pow((ox + 0.02) / ax, NE / 2)) : 0.05;
            const tp = [new V3(s * ox, oy, oz)]; const nT = Math.max(6, DT.band[L] >> 2);
            for (let i = 0; i <= nT; i++) { const t = ts0 + ((-0.15 - ts0) * i) / nT; tp.push(new V3(s * ax * sp(Math.cos(t), 2 / NE), oy, cz * sp(Math.sin(t), 2 / NE))); }
            glasses.add(named(`temple_${sd}`, sweep(tp, false, new V3(0, 1, 0), new V3(0, oy, 0), 0.005 * ft, 0.005 * ft, DT.sw[L]), M.frame));
        }
        const ix = GX - lw * cs; const iz = zc + lw * sn;
        if (ix > 0.004) glasses.add(named('bridge', bar(new V3(-ix, CY + GY + lh * 0.2, iz), new V3(ix, CY + GY + lh * 0.2, iz), 0.011 * Math.sqrt(ft)), M.frame));
    }
    for (const g of [headphones, glasses]) { g.position.copy(W.head).negate(); bone.head.add(g); }

    // Animation clips.
    const E = new THREE.Euler(); const Q = new THREE.Quaternion(); const S = Math.sin; const TAU = Math.PI * 2;
    const pulse = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
    const clip = (name, T, defs) => {
        const n = Math.round(T * 30) + 1; const times = [...Array(n)].map((_, i) => (i * T) / (n - 1)); const tracks = [];
        for (const [k, f] of Object.entries(defs)) {
            const vals = [];
            if (k.endsWith('.position')) { times.forEach((t) => vals.push(...f(t))); tracks.push(new THREE.VectorKeyframeTrack(k, times, vals)); } else {
                times.forEach((t) => { Q.setFromEuler(E.set(...f(t))); vals.push(Q.x, Q.y, Q.z, Q.w); });
                tracks.push(new THREE.QuaternionKeyframeTrack(`${k}.quaternion`, times, vals));
            }
        }
        return new THREE.AnimationClip(name, T, tracks);
    };
    const tailSway = (w, a = 1) => ({ tail_1: (t) => [0, 0.3 * a * S(w * t), 0], tail_2: (t) => [0, 0.35 * a * S(w * t - 0.8), 0], tail_3: (t) => [0, 0.4 * a * S(w * t - 1.6), 0] });
    const w1 = TAU / 3; const w2 = TAU / 1.2; const w3 = TAU / 0.8; const w4 = TAU / 0.9; const hh = (t) => Math.max(0, S(w4 * t)); const lift = Hl / 0.186;
    const raise = ang + Math.PI / 2 - 0.1;
    model.animations = [
        clip('Idle', 3, {
            chest: (t) => [0.035 * S(w1 * t), 0, 0], head: (t) => [0.03 * S(w1 * t + 1), 0, 0.05 * S(w1 * t)],
            ear_L: (t) => [0, 0, -0.45 * pulse(t, 1.8, 0.09)], ear_R: (t) => [0, 0, 0.45 * pulse(t, 2.5, 0.08)],
            arm_L: (t) => [0, 0, 0.06 * S(w1 * t)], arm_R: (t) => [0, 0, -0.06 * S(w1 * t)], ...tailSway(w1),
        }),
        clip('Wave', 1.2, {
            arm_R: () => [0, 0, -raise], hand_R: (t) => [0, 0, 0.5 * S(w2 * t)], chest: () => [0, 0, 0.05],
            head: (t) => [0, 0, 0.12 + 0.04 * S(w2 * t)], arm_L: (t) => [0, 0, 0.05 * S(w2 * t)], ear_R: (t) => [0, 0, 0.2 * S(2 * w2 * t)], ...tailSway(w2, 0.8),
        }),
        clip('Walk', 0.8, {
            leg_L: (t) => [0.55 * S(w3 * t), 0, 0], leg_R: (t) => [-0.55 * S(w3 * t), 0, 0],
            arm_L: (t) => [-0.5 * S(w3 * t), 0, 0], arm_R: (t) => [0.5 * S(w3 * t), 0, 0],
            'hips.position': (t) => [0, hipsY + 0.012 * lift * (0.5 - 0.5 * Math.cos(2 * w3 * t)), 0], hips: (t) => [0, 0, 0.05 * S(w3 * t)],
            chest: (t) => [0, 0, -0.08 * S(w3 * t)], head: (t) => [0.03 * S(2 * w3 * t), 0, 0.03 * S(w3 * t)], ...tailSway(w3, 0.9),
        }),
        clip('Hop', 0.9, {
            'hips.position': (t) => [0, hipsY + 0.09 * hh(t), 0], leg_L: (t) => [-0.4 * hh(t), 0, 0], leg_R: (t) => [-0.4 * hh(t), 0, 0],
            arm_L: (t) => [0, 0, 0.2 + 1.3 * hh(t)], arm_R: (t) => [0, 0, -0.2 - 1.3 * hh(t)], head: (t) => [0.05 - 0.12 * hh(t), 0, 0],
            ear_L: (t) => [0, 0, -0.35 * hh(t)], ear_R: (t) => [0, 0, 0.35 * hh(t)], tail_1: (t) => [-0.5 * hh(t), 0, 0],
        }),
    ];

    // Height: the top of the ears, the head or the headband, whichever is highest.
    const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
    model.updateMatrixWorld(true);
    const hpBox = new THREE.Box3().setFromObject(headphones);
    const height = Math.max(box.max.y, hpBox.isEmpty() ? 0 : hpBox.max.y);

    return { model, mesh, geo, bones, bone, skeleton, headphones, glasses, height, hipsY };
}
