// The protagonist spec and the loot rarities, as tetra ships them
// (backend/protagonist.toml and backend/loot.toml). The game serves these from
// its API; the compositor has no server, so it carries a copy. Only what the
// model reads is kept: body proportions, frame colours, the hull's finish and
// each part's look ranges.

export const PROTAGONIST_SPEC = {
  body: { height: 1.85, build: 1.0, shoulders: 1.0, head: 1.0, arms: 1.0, legs: 1.0 },
  look: { hull: '#c4c8ce', trim: '#e9ebee', joint: '#5b616b', dark: '#23272e', light: '#3fa9ff' },
  texture: {
    period: [4, 2],
    octaves: 3,
    persistence: 0.5,
    contrast: 1.1,
    resolution: 64,
    levels: 6,
    dither: true,
    repeat: 3.0,
    strength: 0.2,
    shininess: 40.0,
    specular: 0.15,
    reflectivity: 0.0,
  },
  parts: {
    ears: { bonus: [0.01, 0.08], curve: 1.3, look: { length: [0.26, 0.4], width: [0.07, 0.1], sweep: [30, 46], notches: [0, 5] } },
    visor: { bonus: [0.04, 0.4], curve: 1.2, look: { lenses: [1, 4], height: [0.022, 0.034], brow: [0.012, 0.04], glow: [1.0, 1.9] } },
    armor: { bonus: [0.1, 1.5], curve: 1.4, look: { plates: [1, 4], pauldrons: [0, 1.15], thickness: [0.012, 0.03], trim: [0.15, 1.0] } },
    hydraulics: { bonus: [0.02, 0.22], curve: 1.2, look: { pistons: [1, 4], radius: [0.011, 0.019], rings: [0, 3], guards: [0, 1] } },
    processor: { bonus: [0.05, 1.0], curve: 1.4, look: { size: [0.85, 1.3], fins: [3, 8], cores: [1, 5], mast: [0, 0.2] } },
  },
};

/** The loot spec's rarities, commonest first. */
export const RARITIES = [
  { name: 'Standard', color: '#efefef' },
  { name: 'Common', color: '#a3e5ac' },
  { name: 'Uncommon', color: '#81e5d9' },
  { name: 'Rare', color: '#6ec9f6' },
  { name: 'Prime', color: '#6788ff' },
  { name: 'Specular', color: '#6e58ff' },
  { name: 'Iridescent', color: '#ab70ce' },
  { name: 'Luminescent', color: '#da77af' },
  { name: 'Exotic', color: '#f56669' },
  { name: 'Anomaly', color: '#f5c566' },
];

export const RARITY_COLOURS = RARITIES.map((r) => r.color);
