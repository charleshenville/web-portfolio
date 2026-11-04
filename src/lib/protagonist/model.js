import * as THREE from 'three';
import { RigBuilder, shapes, taper } from './rig.js';
import { SLOTS, lookOf } from './parts.js';

// Ported from tetra (frontend/src/protagonist/model.js); keep the two in step.
// Compositor-only differences: no mouth grille, a `torso` length factor, and
// the feature edges scaled with the rest in scaleBaked.
//
// The protagonist's body: a light grey robot built from simple shapes on a
// skeleton, after the reference model (frontend/assets/protagonist.stl):
// a boxy head with a visor across its face and two swept-back ears, a deep
// chest, long arms ending in three fingers and a thumb, and pistons up the
// back of the neck. That model was rough and lopsided; this one is symmetric,
// adds feet, and puts a cylinder at every revolute joint (along its hinge
// axis), with blue lights in the visor and on the circular faces of the
// shoulder joints.
//
// Every shape is skinned rigidly to one bone, and the whole body is two
// meshes (hull and lights), like the enemies (see ../enemies/rig.js). The five
// swappable parts (see parts.js) each change their own pieces: ears, the
// visor's lenses, armour plates, hydraulic pistons and the processor on the
// back. Pistons get two bones each, one per end, which the animator aims at
// each other every frame so rods slide in and out of their barrels.
//
// Faces -Z, right hand on +X, feet at the origin, in the bind pose standing
// straight with the arms hanging and the palms facing in. Built at the
// default height (1.85 m) and scaled to the body's `height`.

const BASE_HEIGHT = 1.85;
const X = [0, 0, Math.PI / 2];
const Z = [Math.PI / 2, 0, 0];
const SIDES = [
  ['L', -1],
  ['R', 1],
];

/** Hull shades from the spec's `look`, as #rrggbb. */
function palette(look) {
  const c = (v, fallback) => `#${new THREE.Color(v ?? fallback).getHexString()}`;
  const hull = c(look?.hull, '#c4c8ce');
  return {
    hull,
    trim: c(look?.trim, '#e9ebee'),
    joint: c(look?.joint, '#5b616b'),
    dark: c(look?.dark, '#23272e'),
    shade: `#${new THREE.Color(hull).multiplyScalar(0.78).getHexString()}`,
    light: c(look?.light, '#3fa9ff'),
  };
}

/** Proportions in metres at the default height; `scale` takes them to the body's height. */
export function bodyDims(body = {}) {
  const f = (k) => (Number.isFinite(body[k]) ? body[k] : 1);
  const build = f('build');
  const head = { w: 0.27 * f('head'), h: 0.245 * f('head'), d: 0.26 * f('head') };
  const ankle = 0.085;
  const thigh = 0.38 * f('legs');
  const shin = 0.4 * f('legs');
  const hip = ankle + shin + thigh;
  const neck = 0.07;
  const pelvis = hip + 0.03;
  // The chest fills what's left up to the neck (but never gets squashed flat).
  // `torso` (the compositor's addition) then stretches it, and the body grows
  // taller with it rather than taking it from the legs.
  const chestBase = pelvis + 0.2;
  const chest = Math.max(0.28, BASE_HEIGHT - head.h - neck - chestBase) * f('torso');
  const shoulders = f('shoulders');
  const chestW = 0.42 * build * (0.55 + 0.45 * shoulders);
  return {
    scale: (Number.isFinite(body.height) ? body.height : BASE_HEIGHT) / BASE_HEIGHT,
    build,
    head,
    neck,
    ankle,
    thigh,
    shin,
    hip,
    hipX: 0.115 * build,
    pelvis,
    chest,
    chestW,
    chestD: 0.27 * build,
    shoulderX: chestW / 2 + 0.045 * build + 0.02 * (shoulders - 1),
    shoulderY: chest - 0.09,
    upper: 0.31 * f('arms'),
    fore: 0.29 * f('arms'),
    palm: 0.085,
    finger: 0.04,
    tip: 0.034,
    heel: 0.07,
    toe: 0.11,
  };
}

/**
 * Bake a protagonist wearing `loadout` (one rarity per slot, -1 = stock).
 * `rarities`: the loot spec's rarity colours, commonest first. With `arms`
 * only the arms are built (the first-person view).
 *
 * Returns the baked rig (see RigBuilder.bake) plus `dims` (metres, before
 * `dims.scale`), `pistons` ([{ a, b }] bone pairs to aim at each other) and
 * `looks` (each slot's look).
 */
export function buildProtagonist(spec, loadout, rarities, { arms = false } = {}) {
  const D = bodyDims(spec.body);
  const c = palette(spec.look);
  const looks = Object.fromEntries(SLOTS.map((s, i) => [s, lookOf(s, spec.parts?.[s], loadout[i] ?? -1, rarities)]));
  const { ears, visor, armor, hydraulics, processor } = looks;
  const accent = (l, fallback) => l.accent ?? fallback;
  const b = new RigBuilder();
  const B = D.build;
  const H = D.head;

  // --- skeleton ---------------------------------------------------------------
  b.bone('pelvis', 'root', [0, D.pelvis, 0]);
  b.bone('spine', 'pelvis', [0, 0.11, 0]);
  b.bone('chest', 'spine', [0, 0.09, 0]);
  b.bone('neck', 'chest', [0, D.chest, 0.01]);
  b.bone('head', 'neck', [0, D.neck, 0]);
  for (const [n, x] of SIDES) {
    b.bone(`ear${n}`, 'head', [x * (H.w / 2 + 0.018), H.h * 0.62, 0.035]);
    b.bone(`shoulder${n}`, 'chest', [x * D.shoulderX, D.shoulderY, 0]);
    b.bone(`elbow${n}`, `shoulder${n}`, [0, -D.upper, 0]);
    b.bone(`hand${n}`, `elbow${n}`, [0, -D.fore, 0]);
    b.bone(`fingers${n}`, `hand${n}`, [0, -D.palm, 0]);
    b.bone(`tips${n}`, `fingers${n}`, [0, -D.finger, 0]);
    b.bone(`thumb${n}`, `hand${n}`, [-x * 0.006, -0.03, -0.04]);
    b.bone(`hip${n}`, 'pelvis', [x * D.hipX, -0.03, 0]);
    b.bone(`knee${n}`, `hip${n}`, [0, -D.thigh, 0]);
    b.bone(`ankle${n}`, `knee${n}`, [0, -D.shin, 0]);
    b.bone(`toe${n}`, `ankle${n}`, [0, -D.ankle + 0.022, -D.toe]);
  }

  // In first person only the arms are drawn (and the pistons on them).
  const armBones = new Set(SIDES.flatMap(([n]) => ['shoulder', 'elbow', 'hand', 'fingers', 'tips', 'thumb'].map((k) => k + n)));
  const add = (bone, g, o) => {
    if (!arms || armBones.has(bone)) b.add(bone, g, o);
  };
  /** A revolute joint: a hub along `axis` ('x', 'y' or 'z') with a lighter cap at each end; `led` lights the cap at `ledSide` (+1/-1). */
  const joint = (bone, at, r, len, { axis = 'x', color = c.joint, cap = c.trim, led = 0, ledSide = 1, sides = 12 } = {}) => {
    const rot = axis === 'x' ? X : axis === 'z' ? Z : [0, 0, 0];
    const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    add(bone, shapes.prism(r, r, len, sides), { at, rot, color });
    for (const s of [-1, 1]) {
      const p = [...at];
      p[k] += s * (len / 2 + 0.003);
      add(bone, shapes.prism(r * 0.74, r * 0.8, 0.006, sides), { at: p, rot: s > 0 ? rot : flip(rot, axis), color: cap });
      if (led && s === ledSide) {
        const q = [...at];
        q[k] += s * (len / 2 + 0.0065);
        add(bone, shapes.ring(r * 0.5, Math.max(0.0035, r * 0.08), sides, 3), { at: q, rot: ringRot(axis), light: led });
        add(bone, shapes.prism(r * 0.16, r * 0.16, 0.004, 8), { at: q, rot, light: led * 0.8 });
      }
    }
  };

  // --- head --------------------------------------------------------------------
  const visorY = H.h * 0.62;
  const vh = visor.height;
  // Skull over a jaw that narrows to the neck.
  add('head', taper(shapes.box(H.w, H.h * 0.68, H.d), 0.96, 0.95), { at: [0, H.h * 0.66, 0], color: c.hull });
  add('head', taper(shapes.box(H.w * 0.78, H.h * 0.34, H.d * 0.84), 1.2, 1.14), { at: [0, H.h * 0.16, 0.008], color: c.shade });
  // Visor: a dark band across the face, the lenses in it, a brow plate over it.
  const band = visor.lenses === 4 ? vh * 2.1 + 0.014 : vh + 0.016;
  add('head', shapes.box(H.w * 0.94, band, 0.03), { at: [0, visorY, -H.d / 2 + 0.008], color: c.dark });
  const z = -H.d / 2 - 0.009;
  const lens = (w, h, x, y) => add('head', shapes.box(w, h, 0.012), { at: [x, visorY + y, z], light: visor.glow });
  if (visor.lenses === 1) lens(H.w * 0.84, vh, 0, 0);
  else if (visor.lenses === 2) for (const s of [-1, 1]) lens(H.w * 0.3, vh, s * H.w * 0.22, 0);
  else if (visor.lenses === 3) {
    lens(H.w * 0.16, vh, 0, 0);
    for (const s of [-1, 1]) lens(H.w * 0.22, vh * 0.8, s * H.w * 0.3, 0);
  } else {
    for (const s of [-1, 1]) lens(H.w * 0.28, vh, s * H.w * 0.2, vh * 0.55);
    for (const s of [-1, 1]) lens(H.w * 0.15, vh * 0.7, s * H.w * 0.3, -vh * 0.62);
  }
  const brow = visor.brow;
  add('head', shapes.box(H.w * 1.02, 0.026, brow + 0.04), { at: [0, visorY + band / 2 + 0.013, -H.d / 2 - brow / 2 + 0.012], rot: [-0.12, 0, 0], color: c.trim });
  if (visor.accent) add('head', shapes.box(H.w * 0.5, 0.008, 0.012), { at: [0, visorY + band / 2 + 0.028, -H.d / 2 - brow + 0.004], color: visor.accent });
  // Cheek plates and a crest. (The compositor's copy drops tetra's
  // three-bar mouth grille.)
  for (const s of [-1, 1]) add('head', shapes.box(0.014, H.h * 0.3, H.d * 0.62), { at: [s * (H.w / 2 + 0.004), H.h * 0.33, -0.01], color: c.trim });
  add('head', shapes.box(0.034, 0.022, H.d * 0.82), { at: [0, H.h + 0.01, 0.01], color: c.trim });
  // Neck: a column with a turret ring at its base and the head's nodding hub on top.
  add('neck', shapes.prism(0.045 * B, 0.05 * B, D.neck + 0.03, 10), { at: [0, D.neck / 2, 0], color: c.joint });
  add('chest', shapes.prism(0.085 * B, 0.09 * B, 0.022, 14), { at: [0, D.chest + 0.006, 0.01], color: c.trim });
  joint('head', [0, 0.008, 0], 0.034 * B, 0.12 * B);

  // --- ears ----------------------------------------------------------------------
  for (const [n, x] of SIDES) {
    const bone = `ear${n}`;
    const s = (ears.sweep * Math.PI) / 180;
    const L = ears.length;
    // A fin rising from its hinge towards the back, narrowing to the tip.
    const fin = taper(shapes.box(0.016, L, ears.width), 1, 0.5).translate(0, L / 2, 0).rotateX(Math.PI / 2 - s);
    add(bone, fin, { at: [x * 0.004, 0, 0], color: c.trim });
    const edge = taper(shapes.box(0.019, L * 0.92, 0.009), 1, 0.6).translate(0, L * 0.46, -ears.width / 2 + 0.004).rotateX(Math.PI / 2 - s);
    add(bone, edge, { at: [x * 0.004, 0, 0], color: accent(ears, c.hull) });
    for (let i = 0; i < ears.notches; i++) {
      const u = 0.25 + (0.65 * (i + 0.5)) / ears.notches;
      const w = ears.width * (1 - 0.5 * u);
      add(bone, shapes.box(0.016, 0.012, 0.01), { at: [x * 0.004, Math.sin(s) * L * u - Math.cos(s) * w * 0.15, Math.cos(s) * L * u + Math.sin(s) * w * 0.15], rot: [Math.PI / 2 - s, 0, 0], light: 1 });
    }
    joint(bone, [x * 0.004, 0, 0], 0.024, 0.034, { led: 0.9, ledSide: x });
  }

  // --- torso -------------------------------------------------------------------------
  const CW = D.chestW;
  const CD = D.chestD;
  const CH = D.chest;
  add('chest', taper(shapes.box(CW * 0.84, CH, CD), 1.19, 1.02), { at: [0, CH / 2, 0], color: c.hull });
  // Collar, side panels and a lit status strip.
  add('chest', shapes.box(CW * 0.62, 0.04, CD * 0.74), { at: [0, CH - 0.01, 0.005], color: c.trim });
  for (const s of [-1, 1]) add('chest', taper(shapes.box(0.016, CH * 0.62, CD * 0.7), 1.18, 1), { at: [s * CW * 0.47, CH * 0.45, 0], rot: [0, 0, s * 0.08], color: c.shade });
  add('chest', shapes.box(0.012, 0.05, 0.01), { at: [CW * 0.28, CH * 0.62, -CD / 2 - 0.008], light: 0.8 });
  add('chest', shapes.box(0.012, 0.02, 0.01), { at: [CW * 0.28, CH * 0.53, -CD / 2 - 0.008], light: 0.5 });
  // Back: a spine plate.
  add('chest', shapes.box(CW * 0.22, CH * 0.85, 0.02), { at: [0, CH * 0.48, CD / 2 + 0.006], color: c.shade });
  // Shoulder sockets: the housing the arm's hub turns in, and behind it the
  // joint that swings the arm out, its round face lit on the back.
  for (const [, x] of SIDES) {
    add('chest', shapes.prism(0.062 * B, 0.062 * B, 0.05, 14), { at: [x * (D.shoulderX - 0.05 * B), D.shoulderY, 0], rot: X, color: c.joint });
    joint('chest', [x * (D.shoulderX - 0.07 * B), D.shoulderY, CD * 0.32], 0.05 * B, CD * 0.42, { axis: 'z', led: 1.1, ledSide: 1, cap: c.trim });
  }
  // Waist: a turret ring the chest turns on, and a segmented belly.
  joint('spine', [0, 0.03, 0], 0.095 * B, 0.12, { axis: 'y', sides: 16 });
  for (let i = 0; i < 2; i++) add('spine', taper(shapes.box(CW * 0.62, 0.045, CD * 0.7), 1.08, 1), { at: [0, 0.0 + i * 0.05, -0.02], color: i ? c.hull : c.shade });
  // Pelvis: a block wider at the top, a belt, the hip sockets.
  add('pelvis', taper(shapes.box(0.29 * B, 0.15, 0.2 * B), 1.14, 1.04), { at: [0, -0.005, 0], color: c.hull });
  add('pelvis', shapes.box(0.32 * B, 0.034, 0.22 * B), { at: [0, 0.07, 0], color: c.trim });
  add('pelvis', taper(shapes.box(0.11 * B, 0.1, 0.03), 1.4, 1), { at: [0, -0.04, -0.105 * B], rot: [0.1, 0, 0], color: c.shade });
  for (const [, x] of SIDES) add('pelvis', shapes.prism(0.05 * B, 0.05 * B, 0.03, 12), { at: [x * (D.hipX - 0.05 * B), -0.03, 0], rot: X, color: c.joint });

  // --- arms ------------------------------------------------------------------------------
  for (const [n, x] of SIDES) {
    const up = `shoulder${n}`;
    const el = `elbow${n}`;
    const hd = `hand${n}`;
    // Upper arm: the shoulder hub (lit on its outer face), a tapered arm, a bicep plate.
    joint(up, [x * 0.018 * B, 0, 0], 0.062 * B, 0.07 * B, { led: 1, ledSide: x });
    add(up, taper(shapes.box(0.092 * B, D.upper * 0.7, 0.1 * B), 1.12, 1.1), { at: [0, -D.upper * 0.52, 0], color: c.hull });
    add(up, shapes.box(0.07 * B, D.upper * 0.4, 0.012), { at: [0, -D.upper * 0.5, -0.053 * B], color: c.trim });
    // Forearm: elbow hub, a gauntlet widening to the wrist, the wrist joint.
    joint(el, [0, 0, 0], 0.046 * B, 0.09 * B);
    add(el, taper(shapes.box(0.08 * B, D.fore * 0.78, 0.09 * B), 0.8, 0.82), { at: [0, -D.fore * 0.5, 0], rot: [Math.PI, 0, 0], color: c.hull });
    add(el, shapes.box(0.012, D.fore * 0.5, 0.06 * B), { at: [x * 0.047 * B, -D.fore * 0.55, 0], color: c.shade });
    joint(el, [0, -D.fore + 0.006, 0], 0.028 * B, 0.07 * B, { cap: c.joint, color: c.dark });
    // Hand: a thin palm facing in, the back plate, knuckles, three two-part fingers and a thumb.
    add(hd, shapes.box(0.028, D.palm, 0.074), { at: [0, -D.palm / 2 - 0.004, 0], color: c.joint });
    add(hd, shapes.box(0.012, D.palm * 0.8, 0.07), { at: [x * 0.018, -D.palm / 2, 0], color: c.hull });
    joint(hd, [0, -D.palm, 0], 0.011, 0.074, { axis: 'z', cap: c.joint, color: c.dark });
    for (const zf of [-0.024, 0, 0.024]) {
      add(`fingers${n}`, shapes.box(0.017, D.finger, 0.017), { at: [0, -D.finger / 2, zf], color: c.hull });
      add(`tips${n}`, taper(shapes.box(0.016, D.tip, 0.016), 0.7, 0.8).rotateX(Math.PI), { at: [0, -D.tip / 2, zf], color: c.trim });
      add(`tips${n}`, shapes.prism(0.008, 0.008, 0.017, 6), { at: [0, 0, zf], rot: X, color: c.dark });
    }
    add(`thumb${n}`, shapes.box(0.017, 0.05, 0.018), { at: [0, -0.024, 0], color: c.hull });
    add(`thumb${n}`, shapes.prism(0.009, 0.009, 0.02, 6), { at: [0, 0, 0], rot: Z, color: c.dark });
  }

  // --- legs ------------------------------------------------------------------------------
  for (const [n, x] of SIDES) {
    const th = `hip${n}`;
    const kn = `knee${n}`;
    const an = `ankle${n}`;
    joint(th, [x * 0.012, 0, 0], 0.055 * B, 0.06 * B);
    add(th, taper(shapes.box(0.125 * B, D.thigh * 0.8, 0.15 * B), 0.8, 0.84), { at: [0, -D.thigh * 0.5, 0], rot: [Math.PI, 0, 0], color: c.hull });
    add(th, shapes.box(0.012, D.thigh * 0.5, 0.09 * B), { at: [x * 0.066 * B, -D.thigh * 0.5, 0], color: c.shade });
    // Knee: hub and a horn the knee piston pushes on.
    joint(kn, [0, 0, 0], 0.048 * B, 0.085 * B);
    add(kn, taper(shapes.box(0.07 * B, 0.07, 0.05), 0.8, 0.7), { at: [0, 0.012, -0.068 * B], rot: [-0.25, 0, 0], color: c.trim });
    add(kn, taper(shapes.box(0.105 * B, D.shin * 0.76, 0.125 * B), 0.72, 0.74), { at: [0, -D.shin * 0.5, 0.004], rot: [Math.PI, 0, 0], color: c.hull });
    add(kn, shapes.box(0.06 * B, D.shin * 0.42, 0.012), { at: [0, -D.shin * 0.42, 0.06 * B], color: c.shade });
    // Ankle hub, the foot with a heel spur and a light down its outer side; a toe plate that rolls.
    joint(an, [0, 0, 0], 0.036 * B, 0.08 * B);
    add(an, shapes.box(0.105 * B, 0.05, D.heel + D.toe - 0.01), { at: [0, -D.ankle + 0.028, (D.heel - D.toe) / 2], color: c.hull });
    add(an, taper(shapes.box(0.08 * B, 0.045, 0.06), 0.8, 0.9), { at: [0, -D.ankle + 0.07, -0.01], color: c.shade });
    add(an, shapes.box(0.07 * B, 0.03, 0.03), { at: [0, -D.ankle + 0.02, D.heel + 0.006], color: c.dark });
    add(an, shapes.box(0.006, 0.01, D.toe * 0.8), { at: [x * 0.054 * B, -D.ankle + 0.03, -D.toe * 0.35], light: 0.7 });
    add(`toe${n}`, taper(shapes.box(0.1 * B, 0.036, 0.085), 0.9, 0.7), { at: [0, -0.003, -0.04], color: c.trim });
    joint(`toe${n}`, [0, 0, 0], 0.012, 0.09 * B, { cap: c.joint, color: c.dark });
  }

  // --- armour --------------------------------------------------------------------------------
  const T = armor.thickness;
  const trimColour = accent(armor, c.trim);
  const stripe = (h) => Math.max(0.006, h * (0.15 + 0.5 * armor.trim));
  // Breastplate, always: a raised plate over the upper chest with a stripe of rarity colour.
  add('chest', taper(shapes.box(CW * 0.78, CH * 0.42, T), 1.12, 1), { at: [0, CH * 0.7, -CD / 2 - T / 2], color: c.trim });
  if (armor.accent) add('chest', shapes.box(CW * 0.6, stripe(CH * 0.42), 0.006), { at: [0, CH * 0.6, -CD / 2 - T - 0.002], color: trimColour });
  if (armor.plates >= 2) {
    for (let i = 0; i < 2; i++) add('spine', shapes.box(CW * 0.5, 0.04, T), { at: [0, i * 0.05, -CD * 0.36 - T / 2], color: c.trim });
    add('pelvis', shapes.box(0.16 * B, 0.07, T), { at: [0, -0.03, -0.11 * B - T], rot: [0.12, 0, 0], color: trimColour });
  }
  for (const [n, x] of SIDES) {
    if (armor.plates >= 3) {
      add(`hip${n}`, taper(shapes.box(0.1 * B, D.thigh * 0.5, T), 0.8, 1), { at: [0, -D.thigh * 0.45, -0.07 * B - T / 2], rot: [Math.PI, 0, 0], color: c.trim });
      if (armor.accent) add(`hip${n}`, shapes.box(0.08 * B, stripe(D.thigh * 0.12), 0.006), { at: [0, -D.thigh * 0.32, -0.07 * B - T - 0.002], color: trimColour });
    }
    if (armor.plates >= 4) {
      add(`knee${n}`, taper(shapes.box(0.085 * B, D.shin * 0.48, T), 0.75, 1), { at: [0, -D.shin * 0.42, -0.058 * B - T / 2], rot: [Math.PI, 0, 0], color: c.trim });
      add(`elbow${n}`, shapes.box(0.012 + T, D.fore * 0.5, 0.08 * B), { at: [x * (0.042 * B + T / 2), -D.fore * 0.5, 0], color: c.trim });
      if (armor.accent) add(`elbow${n}`, shapes.box(0.006, stripe(D.fore * 0.15), 0.082 * B), { at: [x * (0.043 * B + T + 0.002), -D.fore * 0.4, 0], color: trimColour });
    }
    if (armor.pauldrons > 0.01) {
      const p = armor.pauldrons;
      const g = taper(shapes.box(0.15 * p * B, 0.05 * p, 0.19 * p * B), 0.75, 0.85);
      add(`shoulder${n}`, g, { at: [x * 0.03 * B, 0.075 * B, 0], rot: [0, 0, -x * 0.32], color: c.trim });
      add(`shoulder${n}`, shapes.box(0.155 * p * B, 0.012, 0.012 + 0.03 * armor.trim), { at: [x * 0.03 * B, 0.06 * B, -0.096 * p * B], rot: [0, 0, -x * 0.32], color: trimColour });
    }
  }

  // --- processor ------------------------------------------------------------------------------
  const P = processor.size;
  const pw = 0.24 * P * B;
  const ph = 0.24 * P;
  const pd = 0.07 * P;
  const back = CD / 2 + pd / 2 + 0.012;
  const py = CH * 0.5;
  add('chest', shapes.box(pw, ph, pd), { at: [0, py, back], color: c.hull });
  add('chest', shapes.box(pw * 0.7, ph * 0.3, 0.01), { at: [0, py + ph * 0.18, back + pd / 2 + 0.002], color: c.dark });
  for (let i = 0; i < processor.cores; i++) {
    const w = (pw * 0.62) / processor.cores;
    add('chest', shapes.box(w * 0.6, ph * 0.16, 0.008), { at: [-pw * 0.31 + w * (i + 0.5), py + ph * 0.18, back + pd / 2 + 0.006], light: 1.1 });
  }
  for (let i = 0; i < processor.fins; i++) {
    const x = -pw * 0.4 + (pw * 0.8 * (i + 0.5)) / processor.fins;
    add('chest', shapes.box(0.006, ph * 0.36, 0.03), { at: [x, py - ph * 0.22, back + pd / 2 + 0.015], color: c.joint });
  }
  for (const s of [-1, 1]) add('chest', shapes.box(0.01, ph * 0.8, pd * 0.8), { at: [s * (pw / 2 + 0.004), py, back], color: accent(processor, c.shade) });
  if (processor.mast > 0.005) {
    add('chest', shapes.prism(0.006, 0.008, processor.mast, 5), { at: [pw * 0.32, py + ph / 2 + processor.mast / 2, back], color: c.joint });
    add('chest', shapes.box(0.014, 0.014, 0.014), { at: [pw * 0.32, py + ph / 2 + processor.mast, back], light: 1.2 });
  }

  // --- hydraulics -------------------------------------------------------------------------------
  // Each piston: [bone a, anchor on a, bone b, anchor on b, barrel length]. The
  // barrel hangs off a and the rod off b, each pointing at the other end.
  const defs = [];
  for (const [, x] of SIDES) defs.push(['chest', [x * 0.055, CH - 0.04, 0.085], 'head', [x * 0.055, 0.03, 0.1], 0.07, 0.7]);
  for (const [n] of SIDES) defs.push([`hip${n}`, [0, -D.thigh * 0.38, -0.075 * B], `knee${n}`, [0, 0.02, -0.082 * B], 0.15, 1]);
  if (hydraulics.pistons >= 2) for (const [n] of SIDES) defs.push([`knee${n}`, [0, -D.shin * 0.35, 0.07 * B], `ankle${n}`, [0, -0.025, 0.065], 0.16, 0.85]);
  if (hydraulics.pistons >= 3) for (const [n] of SIDES) defs.push([`shoulder${n}`, [0, -D.upper * 0.3, -0.06 * B], `elbow${n}`, [0, -0.08, -0.05 * B], 0.17, 0.8]);
  if (hydraulics.pistons >= 4) for (const [n, x] of SIDES) defs.push(['pelvis', [x * D.hipX, 0.02, 0.1 * B], `hip${n}`, [0, -0.17, 0.07 * B], 0.15, 0.8]);
  const pistons = [];
  defs.forEach(([boneA, atA, boneB, atB, len, thick], i) => {
    const a = `piston${i}a`;
    const bb = `piston${i}b`;
    b.bone(a, boneA, atA);
    b.bone(bb, boneB, atB);
    pistons.push({ a, b: bb });
    if (armBones.has(boneA) && armBones.has(boneB)) armBones.add(a).add(bb);
    const r = hydraulics.radius * thick;
    add(a, shapes.prism(r, r, len, 8), { at: [0, len / 2 + 0.006, 0], color: c.joint });
    add(a, shapes.prism(r * 1.25, r * 1.25, 0.012, 8), { at: [0, len + 0.002, 0], color: accent(hydraulics, c.dark) });
    for (let k = 0; k < hydraulics.rings; k++) add(a, shapes.prism(r * 1.12, r * 1.12, 0.006, 8), { at: [0, len * (0.3 + 0.2 * k), 0], light: 0.9 });
    add(bb, shapes.prism(r * 0.48, r * 0.48, len * 0.96, 6), { at: [0, len * 0.48, 0], color: c.trim });
    for (const bone of [a, bb]) add(bone, shapes.prism(r * 1.1, r * 1.1, r * 2.6, 8), { rot: X, color: c.dark });
  });
  // Plates over the knee pistons.
  if (hydraulics.guards > 0.01) {
    for (const [n] of SIDES) add(`hip${n}`, taper(shapes.box(0.07 * B, D.thigh * 0.34 * hydraulics.guards, 0.01), 0.8, 1), { at: [0, -D.thigh * 0.62, -0.1 * B], rot: [Math.PI - 0.1, 0, 0], color: accent(hydraulics, c.trim) });
  }

  const baked = b.bake();
  if (D.scale !== 1) scaleBaked(baked, D.scale);
  return Object.assign(baked, { dims: D, pistons, looks, palette: c });
}

/** A cylinder's rotation turned end for end (for the cap on its other face). */
function flip(rot, axis) {
  if (axis === 'x') return [0, 0, -Math.PI / 2];
  if (axis === 'z') return [-Math.PI / 2, 0, 0];
  return [Math.PI, 0, 0];
}

/** A torus (which lies in XY) turned to face along `axis`. */
function ringRot(axis) {
  if (axis === 'x') return [0, Math.PI / 2, 0];
  if (axis === 'y') return [Math.PI / 2, 0, 0];
  return [0, 0, 0];
}

/** Scale a baked rig about the feet: geometry, bind pose, sockets. */
function scaleBaked(baked, k) {
  for (const g of [baked.geometry, baked.lightGeometry]) {
    if (!g) continue;
    g.scale(k, k, k);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.boundingSphere.radius *= 1.6;
  }
  // (The compositor's addition: the feature edges scale with the rest.)
  if (baked.edges) for (let i = 0; i < baked.edges.position.length; i++) baked.edges.position[i] *= k;
  for (const bone of baked.bind) bone.position.multiplyScalar(k);
  for (const s of Object.values(baked.sockets)) s[1].multiplyScalar(k);
  baked.height *= k;
}
