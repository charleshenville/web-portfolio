// Ported from tetra (frontend/src/protagonist/parts.js); keep the two in step.
//
// The parts that swap onto the protagonist, as the protagonist spec
// (`backend/protagonist.toml`, served at /api/v1/protagonist) defines them.
//
// Five slots, each with a stat it boosts and a look. A part comes in every
// rarity of the loot spec: its bonus and each of its look values run from the
// first value of a `[low, high]` pair at the commonest rarity to the second at
// the rarest (shaped by `curve`), and its accents take the rarity's colour.
// With nothing equipped a slot wears its stock part: the low end of every
// look, no accent, no bonus.
//
// A loadout is one entry per slot: -1 for stock, else a rarity index. On the
// wire (and in the database) it packs into a u32, five bits per slot: 0 is
// stock, r + 1 is rarity r (`pack_loadout` in backend/src/protagonist.rs).

export const SLOTS = ['ears', 'visor', 'armor', 'hydraulics', 'processor'];
export const STOCK = -1;

/** What each slot does: its label, the stat it boosts and how that reads. */
export const SLOT_INFO = {
  ears: { label: 'Ears', stat: 'luck', hint: 'antennae that pick up rarer signals: loot rolls favour rarer drops' },
  visor: { label: 'Visor', stat: 'accuracy', hint: 'tighter rifle spread' },
  armor: { label: 'Armor', stat: 'health', hint: 'more hit points' },
  hydraulics: { label: 'Hydraulics', stat: 'speed', hint: 'faster on foot (and half as much higher jumps)' },
  processor: { label: 'Processor', stat: 'damage', hint: 'more rifle damage per hit' },
};

/**
 * Each slot's look, for the tool: `[key, label, min, max, step, hint]`. In the
 * spec every one is a `[low, high]` pair (commonest rarity to rarest);
 * whole-number steps are rounded.
 */
export const PART_LOOKS = {
  ears: [
    ['length', 'length (m)', 0.12, 0.6, 0.005, 'root to tip'],
    ['width', 'width (m)', 0.02, 0.14, 0.002, 'chord of the fin'],
    ['sweep', 'sweep (°)', 0, 80, 1, 'how far the ears rise from pointing straight back'],
    ['notches', 'lit notches', 0, 8, 1, 'blue lights along the trailing edge'],
  ],
  visor: [
    ['lenses', 'lenses', 1, 4, 1, '1: a slit across the face, 2: twin eyes, 3: three, 4: two pairs'],
    ['height', 'lens height (m)', 0.01, 0.07, 0.001, 'how tall each lens is'],
    ['brow', 'brow (m)', 0, 0.06, 0.001, 'how far the brow plate overhangs the visor'],
    ['glow', 'glow', 0.5, 2.5, 0.05, 'brightness of the lenses'],
  ],
  armor: [
    ['plates', 'plates', 1, 4, 1, '1: a breastplate; then belly plates, thigh plates, shin and forearm guards'],
    ['pauldrons', 'pauldrons', 0, 1.5, 0.01, 'size of the shoulder guards (0 = none)'],
    ['thickness', 'thickness (m)', 0.006, 0.05, 0.001, 'how far plates stand off the frame'],
    ['trim', 'trim', 0, 1, 0.01, 'how much of the armour wears the rarity colour'],
  ],
  hydraulics: [
    ['pistons', 'pistons', 1, 4, 1, '1: neck and knees; then ankles, elbows, hips'],
    ['radius', 'radius (m)', 0.006, 0.03, 0.0005, 'barrel radius'],
    ['rings', 'lit rings', 0, 3, 1, 'blue rings round each barrel'],
    ['guards', 'guards', 0, 1, 0.01, 'size of the plates shielding the knee pistons (0 = none)'],
  ],
  processor: [
    ['size', 'size', 0.6, 1.6, 0.01, 'size of the module on the back'],
    ['fins', 'fins', 0, 10, 1, 'heat-sink fins'],
    ['cores', 'cores', 1, 6, 1, 'lit cores in its window'],
    ['mast', 'mast (m)', 0, 0.3, 0.005, 'height of the uplink mast (0 = none)'],
  ],
};

/** Body proportions for the tool: `[key, label, min, max, step, hint]` (all but height are factors of the default). */
export const BODY = [
  ['height', 'height (m)', 1.2, 2.6, 0.01, 'feet to the top of the head'],
  ['build', 'build', 0.7, 1.5, 0.01, 'thickness of torso and limbs'],
  ['shoulders', 'shoulders', 0.8, 1.4, 0.01, 'shoulder width'],
  ['head', 'head', 0.7, 1.4, 0.01, 'head size'],
  ['arms', 'arms', 0.85, 1.2, 0.01, 'arm length'],
  ['legs', 'legs', 0.8, 1.25, 0.01, 'leg length (the torso takes up the difference)'],
];

/** Colours of the frame (`look`): [key, label]. */
export const COLOURS = [
  ['hull', 'hull'],
  ['trim', 'trim'],
  ['joint', 'joints'],
  ['dark', 'dark'],
  ['light', 'lights'],
];

/** How far rarity `r` of `count` sits between the commonest (0) and the rarest (1). */
export function rarityT(r, count) {
  return count > 1 ? Math.min(1, Math.max(0, r / (count - 1))) : 1;
}

/** A `[low, high]` pair at `t` (0..1), shaped by `curve`. */
export function lerpRange([lo, hi], t, curve = 1) {
  return lo + (hi - lo) * Math.pow(t, curve);
}

/** The bonus a part of rarity `r` gives (0 for stock). */
export function bonusOf(part, r, count) {
  if (r < 0 || !part) return 0;
  return lerpRange(part.bonus, rarityT(r, count), part.curve ?? 1);
}

/**
 * A slot's look at rarity `r` (stock: -1): every look value, rounded where
 * its step is whole, plus `accent` (the rarity's colour, or null) and `t`.
 */
export function lookOf(slot, part, r, rarities) {
  const t = r < 0 ? 0 : rarityT(r, rarities.length);
  const out = { t, accent: r < 0 ? null : rarities[Math.min(rarities.length - 1, r)], rarity: r };
  for (const [key, , min, max, step] of PART_LOOKS[slot]) {
    const range = part?.look?.[key] ?? [min, min];
    let v = lerpRange(range, t);
    if (step >= 1) v = Math.round(v);
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

/** A stat's bonus as people read it: "+12% luck". */
export function describeBonus(slot, bonus) {
  const stat = SLOT_INFO[slot].stat;
  const pct = Math.round(bonus * 1000) / 10;
  return stat === 'accuracy' ? `−${pct}% spread` : `+${pct}% ${stat}`;
}

export const stockLoadout = () => SLOTS.map(() => STOCK);

/** Five bits per slot: 0 stock, r + 1 rarity r. */
export function packLoadout(loadout) {
  let v = 0;
  SLOTS.forEach((_, i) => (v |= ((loadout[i] ?? STOCK) + 1 & 31) << (5 * i)));
  return v >>> 0;
}

export function unpackLoadout(v) {
  return SLOTS.map((_, i) => ((v >>> (5 * i)) & 31) - 1);
}

/** A cache key for a built model. */
export const loadoutKey = (loadout) => loadout.join(',');
