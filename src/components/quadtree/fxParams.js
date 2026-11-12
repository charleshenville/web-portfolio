// The Quad Trees look as compositor parameters: the same settings the
// standalone tool has (minus its own seeds and output), each one a plain
// parameter `qt_<setting>` so controllers can drive it. The compositor's
// Quad Tree effect and a window's quad tree group are built from these, and
// a saved preset maps onto them (presetToParams) and back (qtSettings).
//
// Plain data: no React, no three, no WebGL.

import { DEFAULTS } from './settings';
import { GLYPH_FONTS, GLYPH_WEIGHTS } from './fonts';

const P = 'qt_';
const num = (key, label, min, max, step, extra = {}) => ({
    key: P + key, skey: key, label, type: 'number', min, max, step, def: DEFAULTS[key], ...extra,
});
const bool = (key, label, extra = {}) => ({ key: P + key, skey: key, label, type: 'bool', def: DEFAULTS[key], ...extra });
const color = (key, label, extra = {}) => ({ key: P + key, skey: key, label, type: 'color', def: DEFAULTS[key], ...extra });
const select = (key, label, options, extra = {}) => ({
    key: P + key, skey: key, label, type: 'select', options, def: DEFAULTS[key], link: false, ...extra,
});
const q = (k) => (p) => p[P + k];

// Gradient colours are an array in the tool; here each is its own
// parameter so it can be linked.
const MAX_STOPS = 4;
const stopDefs = Array.from({ length: MAX_STOPS }, (_, i) => ({
    key: `${P}stop${i + 1}`,
    label: `Colour ${i + 1}`,
    type: 'color',
    def: DEFAULTS.stops[i] || DEFAULTS.stops[DEFAULTS.stops.length - 1],
    when: (p) => p[`${P}colorSource`] !== 'seed' && i < (p[`${P}stopCount`] || 2),
}));
const notAscii = (p) => q('shape')(p) !== 'ascii';

/** Parameter groups, as the compositor's schema lays them out. */
export const QT_GROUPS = [
    {
        title: 'Subdivision',
        params: [
            select('metric', 'Split on', [['color', 'Colour'], ['luma', 'Brightness'], ['noise', 'Noise map'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]),
            num('threshold', 'Threshold', 0, 0.4, 0.001),
            num('maxDepth', 'Max depth', 0, 12, 1),
            num('minDepth', 'Min depth', 0, 8, 1),
            num('minSize', 'Min size (px)', 0.5, 64, 0.5),
            num('rootCols', 'Root cells', 1, 32, 1),
            num('falloff', 'Falloff', 0.5, 1.5, 0.01),
            select('analysisRes', 'Analysis', [[256, '256'], [512, '512'], [1024, '1024']]),
            num('loop', 'Loop (s)', 0.5, 60, 0.5, { link: false }),
        ],
    },
    {
        title: 'Noise map',
        when: (p) => q('metric')(p) === 'noise',
        params: [
            num('noiseScale', 'Scale', 0.2, 20, 0.05),
            num('noiseOctaves', 'Octaves', 1, 8, 1),
            num('noiseEvolve', 'Evolve', 1, 8, 1, { link: false }),
            num('noiseContrast', 'Contrast', 0.1, 4, 0.01),
            num('noiseWarp', 'Warp', 0, 3, 0.01),
            num('noiseSeed', 'Seed', 0, 999, 1),
        ],
    },
    {
        title: 'Style',
        params: [
            select('shape', 'Shape', [['square', 'Square'], ['circle', 'Circle'], ['mixed', 'Mixed'], ['ascii', 'Ascii']]),
            num('radius', 'Rounding', 0, 1, 0.01, { when: (p) => q('shape')(p) === 'square' || q('shape')(p) === 'mixed' }),
            num('mixRatio', 'Circles', 0, 1, 0.01, { when: (p) => q('shape')(p) === 'mixed' }),
            num('styleSeed', 'Mix seed', 0, 999, 1, { when: (p) => q('shape')(p) === 'mixed' }),
            num('gap', 'Gap (px)', 0, 24, 0.25, { when: notAscii }),
            num('size', 'Size', 0.1, 1.5, 0.01),
            num('halftone', 'Halftone', 0, 1, 0.01, { when: notAscii }),
            bool('halftoneInvert', 'Dark is big', { when: (p) => notAscii(p) && q('halftone')(p) > 0 }),
            bool('fill', 'Fill', { when: notAscii }),
            num('outline', 'Outline (px)', 0, 16, 0.25, { when: notAscii }),
            select('outlineMode', 'Outline from', [['solid', 'Colour'], ['cell', 'Cell'], ['shade', 'Shade']], { when: (p) => notAscii(p) && q('outline')(p) > 0 }),
            color('outlineColor', 'Outline', { when: (p) => notAscii(p) && q('outline')(p) > 0 && q('outlineMode')(p) === 'solid' }),
            { key: `${P}ramp`, skey: 'ramp', label: 'Characters', type: 'string', def: DEFAULTS.ramp, link: false, when: (p) => !notAscii(p) },
            select('rampBy', 'Ramp by', [['brightness', 'Brightness'], ['size', 'Cell size'], ['depth', 'Cell depth']], { when: (p) => !notAscii(p) }),
            bool('rampInvert', 'Invert ramp', { when: (p) => !notAscii(p) }),
            select('glyphFont', 'Font', GLYPH_FONTS.map(([id, label]) => [id, label]), { when: (p) => !notAscii(p) }),
            {
                key: `${P}glyphFontCustom`, skey: 'glyphFontCustom', label: 'Font name', type: 'string', def: DEFAULTS.glyphFontCustom, link: false,
                when: (p) => !notAscii(p) && q('glyphFont')(p) === 'custom',
            },
            select('glyphWeight', 'Weight', GLYPH_WEIGHTS.map((w) => [w, String(w)]), { when: (p) => !notAscii(p) }),
            bool('glyphItalic', 'Italic', { when: (p) => !notAscii(p), link: false }),
            num('glyphBg', 'Cell fill', 0, 1, 0.01, { when: (p) => !notAscii(p) }),
            num('quadOpacity', 'Opacity', 0, 1, 0.01),
        ],
    },
    {
        title: 'Colour',
        params: [
            select('colorSource', 'Colour from', [['seed', 'Picture'], ['gradient', 'Map'], ['depth', 'Depth']]),
            { key: `${P}stopCount`, label: 'Colours', type: 'select', options: [[2, '2'], [3, '3'], [4, '4']], def: Math.min(MAX_STOPS, DEFAULTS.stops.length), link: false, when: (p) => q('colorSource')(p) !== 'seed' },
            ...stopDefs,
            num('levels', 'Levels', 0, 16, 1),
            color('background', 'Background'),
            num('underlay', 'Underlay', 0, 1, 0.01),
        ],
    },
    {
        title: 'Input grade',
        collapsed: true,
        params: [
            num('exposure', 'Exposure', -3, 3, 0.01),
            num('contrast', 'Contrast', 0, 3, 0.01),
            num('saturation', 'Saturation', 0, 3, 0.01),
            num('temperature', 'Temperature', -1, 1, 0.01),
            num('tint', 'Tint', -1, 1, 0.01),
            num('hue', 'Hue', -180, 180, 1),
            num('gamma', 'Gamma', 0.2, 3, 0.01),
            num('lift', 'Lift', -0.5, 0.5, 0.01),
            num('gain', 'Gain', 0, 2, 0.01),
            num('posterize', 'Posterize', 0, 16, 1),
            num('blur', 'Blur', 0, 0.2, 0.001),
            bool('invert', 'Invert'),
        ],
    },
    {
        title: 'Glow & post',
        collapsed: true,
        params: [
            num('glow', 'Glow', 0, 4, 0.01),
            num('glowRadius', 'Radius', 0, 1, 0.01),
            num('glowThreshold', 'Threshold', 0, 1, 0.01),
            color('glowTint', 'Tint'),
            bool('glowNormalize', 'Normalise glow'),
            num('aberration', 'Aberration', 0, 2, 0.01),
            num('vignette', 'Vignette', 0, 1, 0.01),
            num('grain', 'Grain', 0, 1, 0.01),
        ],
    },
];

/** Every quad tree parameter's default, by key. */
export const QT_DEFAULTS = Object.fromEntries(QT_GROUPS.flatMap((g) => g.params.map((d) => [d.key, d.def])));
QT_DEFAULTS.qt_mix = 1;

const ALL = QT_GROUPS.flatMap((g) => g.params);

/** Settings the renderer reads, from resolved compositor parameters. */
export function qtSettings(p) {
    const s = { ...DEFAULTS };
    ALL.forEach((d) => {
        if (!d.skey) return;
        const v = p[d.key];
        if (v !== undefined && v !== null) s[d.skey] = v;
    });
    const n = Math.max(2, Math.min(MAX_STOPS, Number(p[`${P}stopCount`]) || 2));
    s.stops = Array.from({ length: n }, (_, i) => p[`${P}stop${i + 1}`] || DEFAULTS.stops[0]);
    s.mix = p[`${P}mix`] ?? 1;
    // Integers the sliders may hand over as fractions while linked.
    ['maxDepth', 'minDepth', 'rootCols', 'noiseOctaves', 'noiseEvolve', 'levels', 'posterize'].forEach((k) => { s[k] = Math.round(s[k]); });
    s.analysisRes = Number(s.analysisRes) || 512;
    return s;
}

/** A saved preset's settings as compositor parameters (its seed left out). */
export function presetToParams(settings) {
    const s = { ...DEFAULTS, ...settings };
    const out = {};
    ALL.forEach((d) => {
        if (d.skey && s[d.skey] !== undefined) out[d.key] = s[d.skey];
    });
    const stops = (s.stops && s.stops.length ? s.stops : DEFAULTS.stops).slice(0, MAX_STOPS);
    out[`${P}stopCount`] = Math.max(2, stops.length);
    stops.forEach((c, i) => { out[`${P}stop${i + 1}`] = c; });
    return out;
}

export const QT_PREFIX = P;
