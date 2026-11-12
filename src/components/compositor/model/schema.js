// Object types: what each kind of thing in a compositor project is, the
// parameters it has, and how the inspector lays them out.
//
// A parameter definition:
//   { key, label, type: 'number' | 'bool' | 'color' | 'select',
//     min, max, step, def, options: [[value, label]],
//     link: false  - cannot be linked to a controller (changing it rebuilds
//                    geometry, so driving it every frame would stall),
//     when: (params) => bool - only shown when this holds }
//
// Every object has `visible`, which is a parameter like any other, so it can
// be linked to a controller (a Switch flicking it, a kick gating it).
//
// The engine's adapters (engine/adapters.js) read the same keys; the libs
// they wrap (protagonist, sackboy, props, windows, audioScene) keep their own
// parameter names, so a resolved parameter set is handed straight to them.

import { OBJECT_DEFAULTS, CURVE_DEFAULTS, ASSETS, CURVES } from '../../../lib/audioScene';
import {
    MODEL_DEFAULTS, BODY_FIELDS, COLOUR_FIELDS, FINISH_FIELDS, TEXTURE_FIELDS,
} from '../../../lib/protagonist/poser';
import { SACKBOY_DEFAULTS } from '../../../lib/scanAssets/sackboy';
import { PROP_DEFAULTS } from '../../../lib/scanAssets/props';
import { FONTS, TEXT_BLENDS } from '../engine/textObject';
import { WINDOW_DEFAULTS } from '../../../lib/scanAssets/windows';
import { QT_GROUPS, QT_DEFAULTS } from '../../quadtree/fxParams';
import {
    BLOB_DEFAULTS, LABEL_TEXTS, LABEL_PLACES, LABEL_TOKENS,
} from '../../../lib/blobTracker';
import { GLYPH_FONTS, GLYPH_WEIGHTS } from '../../quadtree/fonts';
import { SPLINE_DEGREES, SPLINE_ENDS, SPLINE_SPACING } from './spline';

// The colour grade's parameters (the track editor's, which this replaces).
const GRADE_PARAMS = [
    { key: 'exposure', label: 'Exposure', min: -3, max: 3, def: 0, step: 0.01 },
    { key: 'contrast', label: 'Contrast', min: 0, max: 2, def: 1, step: 0.01 },
    { key: 'gamma', label: 'Gamma', min: 0.2, max: 3, def: 1, step: 0.01 },
    { key: 'saturation', label: 'Saturation', min: 0, max: 3, def: 1, step: 0.01 },
    { key: 'temperature', label: 'Temperature', min: -1, max: 1, def: 0, step: 0.01 },
    { key: 'tint', label: 'Tint', min: -1, max: 1, def: 0, step: 0.01 },
    { key: 'hue', label: 'Hue', min: -180, max: 180, def: 0, step: 1 },
    { key: 'lift', label: 'Lift', min: -0.5, max: 0.5, def: 0, step: 0.005 },
    { key: 'vignette', label: 'Vignette', min: 0, max: 1, def: 0, step: 0.01 },
];


const num = (key, label, min, max, step, def, extra = {}) => ({ key, label, type: 'number', min, max, step, def, ...extra });
const bool = (key, label, def, extra = {}) => ({ key, label, type: 'bool', def, ...extra });
const color = (key, label, def, extra = {}) => ({ key, label, type: 'color', def, ...extra });
const select = (key, label, options, def, extra = {}) => ({ key, label, type: 'select', options, def, link: false, ...extra });
const text = (key, label, def, extra = {}) => ({ key, label, type: 'text', def, link: false, ...extra });
const string = (key, label, def, extra = {}) => ({ key, label, type: 'string', def, link: false, ...extra });

// A video across a patch, as prop screens show one.
const SCREEN_GROUP = (hint) => ({
    title: 'Screen',
    collapsed: true,
    hint,
    custom: 'screenSource',
    params: [
        bool('screenOn', 'Show the video', false),
        num('videoOffset', 'Start (s)', 0, 120, 0.01, 0, { when: (p) => p.screenOn }),
        num('videoRate', 'Rate', 0, 4, 0.01, 1, { when: (p) => p.screenOn }),
        num('brightness', 'Brightness', 0, 4, 0.01, 1.4, { when: (p) => p.screenOn }),
        num('videoSaturation', 'Saturation', 0, 3, 0.01, 1, { when: (p) => p.screenOn }),
        select('fit', 'Fit', [['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch']], 'cover', { when: (p) => p.screenOn }),
        select('rotate', 'Rotate', [[0, '0\u00b0'], [90, '90\u00b0'], [180, '180\u00b0'], [270, '270\u00b0']], 0, { when: (p) => p.screenOn }),
        bool('flipX', 'Mirror', false, { when: (p) => p.screenOn, link: false }),
    ],
});

const VISIBLE = bool('visible', 'Visible', true);
const LAYER = select('depthLayer', 'Layer', [['front', 'In front of footage'], ['behind', 'Behind footage']], 'front');
const OPACITY = num('opacity', 'Opacity', 0, 1, 0.01, 1);

const transform = (range = 10, step = 0.005) => ({
    title: 'Transform',
    params: [
        num('posX', 'Pos X', -range, range, step, 0),
        num('posY', 'Pos Y', -range, range, step, 0),
        num('posZ', 'Pos Z', -range, range, step, 0),
        num('rotX', 'Rot X', -180, 180, 0.5, 0),
        num('rotY', 'Rot Y', -180, 180, 0.5, 0),
        num('rotZ', 'Rot Z', -180, 180, 0.5, 0),
        num('scale', 'Scale', 0.01, 8, 0.01, 1, { swing: 0.3 }),
    ],
});

const fromFields = (fields, extra = {}) => fields.map(([key, label, min, max, step]) => num(key, label, min, max, step, undefined, extra));

// Nod, as the protagonist and Sackboy share it.
const NOD = {
    title: 'Head nod',
    collapsed: true,
    params: [
        bool('nodOn', 'Nod', false),
        select('nodMode', 'Timing', [['bpm', 'Tempo'], ['kick', 'Kicks']], 'bpm', { when: (p) => p.nodOn }),
        num('bpm', 'BPM', 30, 240, 0.1, 96, { when: (p) => p.nodOn && p.nodMode === 'bpm', link: false }),
        num('nodEvery', 'Every N', 1, 8, 1, 1, { when: (p) => p.nodOn, link: false }),
        num('nodDepth', 'Depth', 0, 40, 0.5, 12, { when: (p) => p.nodOn }),
        num('nodSharpness', 'Snap', 0.5, 6, 0.05, 1.6, { when: (p) => p.nodOn && p.nodMode === 'bpm' }),
        num('nodPhase', 'Beat offset', 0, 1, 0.01, 0, { when: (p) => p.nodOn && p.nodMode === 'bpm' }),
        num('nodGroove', 'Groove', 0, 1.5, 0.01, 0.35, { when: (p) => p.nodOn }),
        num('kickThreshold', 'Threshold', 0, 1, 0.005, 0.85, { when: (p) => p.nodOn && p.nodMode === 'kick', link: false }),
        num('kickLow', 'Low (Hz)', 20, 300, 1, 40, { when: (p) => p.nodOn && p.nodMode === 'kick', link: false }),
        num('kickHigh', 'High (Hz)', 40, 500, 1, 130, { when: (p) => p.nodOn && p.nodMode === 'kick', link: false }),
        num('kickGap', 'Min gap (s)', 0.05, 1, 0.01, 0.18, { when: (p) => p.nodOn && p.nodMode === 'kick', link: false }),
        num('nodRelease', 'Release (s)', 0.05, 1.2, 0.01, 0.3, { when: (p) => p.nodOn && p.nodMode === 'kick' }),
    ],
};

const VIEWS = (pointMax, sizeMax) => ({
    title: 'Draw as',
    params: [
        bool('viewTextured', 'Textured', true),
        bool('viewWire', 'Wireframe', false),
        bool('viewPoints', 'Points', false),
        bool('selfOcclude', 'Hide far side', true, { when: (p) => !p.viewTextured && (p.viewWire || p.viewPoints) }),
        select('wireColorMode', 'Wire colour', [['model', 'Model'], ['solid', 'Solid']], 'model', { when: (p) => p.viewWire }),
        color('wireColor', 'Wire', '#9fd8ff', { when: (p) => p.viewWire && p.wireColorMode === 'solid' }),
        num('wireThickness', 'Wire width', 0.0002, 0.008, 0.0001, 0.0016, { when: (p) => p.viewWire }),
        select('pointColorMode', 'Point colour', [['model', 'Model'], ['solid', 'Solid']], 'model', { when: (p) => p.viewPoints }),
        color('pointColor', 'Points', '#f2f0e6', { when: (p) => p.viewPoints }),
        num('pointCount', 'Points', 2000, pointMax, 1000, 24000, { when: (p) => p.viewPoints, link: false }),
        num('pointSize', 'Point size', 0.001, sizeMax, 0.0005, 0.014, { when: (p) => p.viewPoints }),
        OPACITY,
        bool('castShadow', 'Casts a shadow', true),
        LAYER,
    ],
});

// ---- Equations and splines: how a curve is drawn ---------------------------------------
//
// Shared by the Equation and Spline types (engine/curveObject.js draws both).

export const CURVE_MODES = [['points', 'Points'], ['solid', 'Solid'], ['seriesSolid', 'Series of solids'], ['seriesPoints', 'Series of points']];
export const POINT_SHAPES = [
    ['square', 'Flat square'], ['disc', 'Flat disc'], ['tetra', 'Tetrahedron'], ['cube', 'Cube'],
    ['octa', 'Octahedron'], ['dodeca', 'Dodecahedron'], ['icosa', 'Icosahedron'], ['sphere', 'Sphere'],
];
// Wireframe draws a shape's own edges (a cube's twelve), not its triangles'.
export const POINT_STYLES = [['solid', 'Solid'], ['wire', 'Wireframe (edges)']];
export const isSeries = (p) => p.mode === 'seriesSolid' || p.mode === 'seriesPoints';
export const isPointsMode = (p) => p.mode === 'points' || p.mode === 'seriesPoints';
const solidMode = (p) => !isPointsMode(p);
const growing = (p) => !!p.growOn;

const CURVE_LOOK_DEFAULTS = {
    visible: true,
    mode: 'solid',
    samples: 400,
    thickness: 0.02,
    thicknessUnits: 'world',
    widthStart: 1,
    widthEnd: 1,
    dotCount: 240,
    pointShape: 'tetra',
    pointStyle: 'solid',
    pointWire: 1.5,
    dotSize: 0.04,
    spin: 0,
    jitter: 0,
    flowSpeed: 0,
    reactivity: 0,
    lit: false,
    opacity: 1,
    fadeStart: 1,
    fadeEnd: 1,
    depthLayer: 'front',
    colorStart: '#ffffff',
    colorEnd: '#ffffff',
    reveal: 1,
    revealFrom: 'start',
    growOn: false,
    growStart: 0,
    growDur: 2,
    growEase: 'inOut',
    seriesCount: 6,
    seriesDX: 0,
    seriesDY: 0.15,
    seriesDZ: 0,
    seriesCentre: false,
    seriesLen: 0,
    seriesLenAt: 'end',
    seriesStagger: 0,
    seriesColors: true,
    seriesColorA: '#ff3b3b',
    seriesColorB: '#3bb0ff',
    posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1,
};

/** The groups that say how a curve is drawn; `v` is its parameter's name (t or u). */
function curveLookGroups(v) {
    return [
        {
            title: 'Draw as',
            hint: 'Sizes are in the curve\u2019s own units, so they scale with it. Start and end \u00d7 scale the width (or point size) and opacity along the curve.',
            params: [
                VISIBLE,
                select('mode', 'Mode', CURVE_MODES, 'solid'),
                num('samples', 'Resolution', 8, 4000, 1, 400, { link: false, when: solidMode }),
                num('thickness', 'Thickness', 0, 0.5, 0.0005, 0.02, { when: solidMode, swing: 0.02 }),
                select('thicknessUnits', 'Thickness in', [['world', 'Scene units'], ['pixels', 'Pixels (of 1080)']], 'world', { when: solidMode }),
                num('dotCount', 'Points', 1, 5000, 1, 240, { link: false, when: isPointsMode }),
                select('pointShape', 'Point shape', POINT_SHAPES, 'tetra', { when: isPointsMode }),
                select('pointStyle', 'Points drawn', POINT_STYLES, 'solid', { when: isPointsMode }),
                num('pointWire', 'Edge width (px)', 0.25, 12, 0.05, 1.5, { when: (p) => isPointsMode(p) && p.pointStyle === 'wire' }),
                num('dotSize', 'Point size', 0.001, 0.5, 0.001, 0.04, { when: isPointsMode }),
                num('spin', 'Spin (\u00b0/s)', -720, 720, 1, 0, { when: (p) => isPointsMode(p) && p.pointShape !== 'square' && p.pointShape !== 'disc' }),
                num('jitter', 'Jitter', 0, 1, 0.001, 0, { when: isPointsMode }),
                num('flowSpeed', 'Flow', -2, 2, 0.01, 0, { when: isPointsMode }),
                num('reactivity', 'Bass pulse', 0, 3, 0.01, 0, { when: isPointsMode }),
                bool('lit', 'Lit by the sun', false, { when: isPointsMode }),
                num('widthStart', 'Start size \u00d7', 0, 4, 0.01, 1),
                num('widthEnd', 'End size \u00d7', 0, 4, 0.01, 1),
                OPACITY,
                num('fadeStart', 'Start opacity \u00d7', 0, 1, 0.01, 1),
                num('fadeEnd', 'End opacity \u00d7', 0, 1, 0.01, 1),
                LAYER,
            ],
        },
        {
            title: 'Colour',
            params: [
                color('colorStart', 'Start', '#ffffff'),
                color('colorEnd', 'End', '#ffffff'),
                bool('seriesColors', 'Colour by copy', true, { when: isSeries }),
                color('seriesColorA', 'First copy', '#ff3b3b', { when: (p) => isSeries(p) && p.seriesColors }),
                color('seriesColorB', 'Last copy', '#3bb0ff', { when: (p) => isSeries(p) && p.seriesColors }),
            ],
        },
        {
            title: 'Series',
            when: isSeries,
            hint: `Copies of the curve, each a step on from the last. k in the equations is the copy (0 for the first). Length change grows (or shrinks) each copy's ${v} range by that much more than the one before.`,
            params: [
                num('seriesCount', 'Copies', 1, 64, 1, 6, { link: false }),
                num('seriesDX', 'Step X', -5, 5, 0.001, 0),
                num('seriesDY', 'Step Y', -5, 5, 0.001, 0.15),
                num('seriesDZ', 'Step Z', -5, 5, 0.001, 0),
                bool('seriesCentre', 'Centred on the original', false),
                num('seriesLen', 'Length change', -10, 10, 0.001, 0),
                select('seriesLenAt', 'At', [['end', 'The end'], ['start', 'The start'], ['both', 'Both ends']], 'end', { when: (p) => p.seriesLen !== 0 }),
                num('seriesStagger', 'Grow stagger (s)', 0, 5, 0.01, 0, { when: growing }),
            ],
        },
        {
            title: 'Growth',
            hint: 'How much of the curve is drawn. Link Drawn to a Keyframes controller to grow it by hand, or let it grow over time.',
            params: [
                num('reveal', 'Drawn', 0, 1, 0.001, 1),
                select('revealFrom', 'Grows from', [['start', 'The start'], ['end', 'The end'], ['centre', 'The middle']], 'start'),
                bool('growOn', 'Grow over time', false),
                num('growStart', 'Starts at (s)', 0, 600, 0.01, 0, { when: growing }),
                num('growDur', 'Takes (s)', 0.01, 60, 0.01, 2, { when: growing }),
                select('growEase', 'Ease', [['linear', 'Linear'], ['in', 'In'], ['out', 'Out'], ['inOut', 'In-out']], 'inOut', { when: growing }),
            ],
        },
    ];
}

export const OBJECT_TYPES = {
    // ---- A take's own scene --------------------------------------------------

    take: {
        label: 'Take',
        category: 'scene',
        unique: true,
        gizmo: 'offset',
        defaults: {
            offsetX: 0, offsetY: 0, offsetZ: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1,
            overscale: 1, overlayX: 0, overlayY: 0, overlayZ: 0,
            bgColor: '#000000', mattesOn: true, mattesOverHidden: false, occlude: false,
        },
        groups: [
            {
                title: 'Alignment nudge',
                hint: 'Moves the whole scan against its own footage, for a solve that sits a little off.',
                params: [
                    num('offsetX', 'Offset X', -0.5, 0.5, 0.001, 0),
                    num('offsetY', 'Offset Y', -0.5, 0.5, 0.001, 0),
                    num('offsetZ', 'Offset Z', -0.5, 0.5, 0.001, 0),
                    num('rotX', 'Rotate X', -15, 15, 0.1, 0),
                    num('rotY', 'Rotate Y', -15, 15, 0.1, 0),
                    num('rotZ', 'Rotate Z', -15, 15, 0.1, 0),
                    num('scale', 'Scale', 0.8, 1.25, 0.001, 1),
                ],
            },
            {
                title: 'Overlays',
                hint: 'Lifts the scan points and wireframe off the mesh, or slides them bodily.',
                collapsed: true,
                params: [
                    num('overscale', 'Swell', 1, 1.08, 0.0005, 1),
                    num('overlayX', 'Overlay X', -0.3, 0.3, 0.001, 0),
                    num('overlayY', 'Overlay Y', -0.3, 0.3, 0.001, 0),
                    num('overlayZ', 'Overlay Z', -0.3, 0.3, 0.001, 0),
                ],
            },
            {
                title: 'Scene',
                params: [
                    color('bgColor', 'Backdrop', '#000000'),
                    bool('occlude', 'Hide behind scan', false),
                    bool('mattesOn', 'Use mattes (holdouts & windows)', true),
                    bool('mattesOverHidden', 'Mattes show over hidden footage', false, { when: (p) => p.mattesOn !== false }),
                ],
            },
            {
                title: 'Scan colour',
                custom: 'scanLook',
                collapsed: true,
                hint: 'Corrects the scan\u2019s own texture (textured mesh, scan-coloured points) to match the footage. Saved with the take, not the project.',
            },
            { title: 'Roto', custom: 'roto', collapsed: true },
        ],
    },

    // An empty 3D stage's own settings (a take's are on its Take).
    stage: {
        label: 'Stage',
        category: 'scene',
        unique: true,
        defaults: { bgColor: '#000000' },
        groups: [{
            title: 'Stage',
            hint: 'What shows behind everything in this stage. Link it to a controller to change it over time.',
            params: [color('bgColor', 'Backdrop', '#000000')],
        }],
    },

    footage: {
        label: 'Footage',
        category: 'scene',
        unique: true,
        defaults: { visible: true, opacity: 1 },
        groups: [{ title: 'Footage', params: [VISIBLE, OPACITY] }],
    },

    scanPoints: {
        label: 'Scan points',
        category: 'scene',
        unique: true,
        gizmo: 'pulse',
        defaults: {
            visible: false, depthLayer: 'front', colorMode: 'scan', color: '#f2f0e6', size: 1.6, opacity: 1,
            density: 0.6, attenuate: true, react: 0, scatter: 0.002, freqLow: 0, freqHigh: 1,
            pulseMode: 'radial', pulseX: 0, pulseY: 0, pulseZ: 0, pulseDir: 'up', pulsePlane: null, pulseLine: null,
        },
        groups: [
            {
                title: 'Points',
                params: [
                    VISIBLE,
                    select('colorMode', 'Colour', [['scan', 'Scan'], ['solid', 'Solid']], 'scan'),
                    color('color', 'Solid', '#f2f0e6', { when: (p) => p.colorMode === 'solid' }),
                    num('size', 'Size', 0.1, 8, 0.1, 1.6),
                    num('density', 'Density', 0.01, 1, 0.01, 0.6),
                    OPACITY,
                    bool('attenuate', 'Perspective size', true),
                    LAYER,
                ],
            },
            {
                title: 'Spectrum pulse',
                hint: 'Each point is pushed by its own slice of the spectrum, out from the pulse origin.',
                params: [
                    num('react', 'Amount', 0, 3, 0.01, 0),
                    num('scatter', 'Scatter', 0, 1, 0.001, 0.002),
                    num('freqLow', 'Freq low', 0, 1, 0.01, 0),
                    num('freqHigh', 'Freq high', 0, 1, 0.01, 1),
                    select('pulseMode', 'From', [['radial', 'Point'], ['directional', 'Direction'], ['plane', 'Plane'], ['line', 'Line']], 'radial'),
                    num('pulseX', 'Origin X', -4, 4, 0.01, 0, { when: (p) => p.pulseMode === 'radial' }),
                    num('pulseY', 'Origin Y', -4, 4, 0.01, 0, { when: (p) => p.pulseMode === 'radial' }),
                    num('pulseZ', 'Origin Z', -4, 4, 0.01, 0, { when: (p) => p.pulseMode === 'radial' }),
                    select('pulseDir', 'Direction', [['up', 'Up'], ['down', 'Down'], ['right', '+X'], ['left', '−X'], ['toward', '+Z'], ['away', '−Z']], 'up', { when: (p) => p.pulseMode === 'directional' }),
                ],
            },
            { title: 'Pulse shape', custom: 'pulseShape', when: (p) => p.pulseMode === 'plane' || p.pulseMode === 'line' },
        ],
    },

    scanMesh: {
        label: 'Scan mesh',
        category: 'scene',
        unique: true,
        defaults: { visible: false, depthLayer: 'front', shading: 'matte', color: '#2b4bdf', opacity: 1 },
        groups: [{
            title: 'Mesh',
            params: [
                VISIBLE,
                select('shading', 'Shading', [['textured', 'Scan'], ['matte', 'Matte'], ['shaded', 'Shaded'], ['normal', 'Normal']], 'matte'),
                color('color', 'Colour', '#2b4bdf', { when: (p) => p.shading === 'matte' || p.shading === 'shaded' }),
                OPACITY,
                LAYER,
            ],
        }],
    },

    scanWire: {
        label: 'Scan wireframe',
        category: 'scene',
        unique: true,
        defaults: {
            visible: false, depthLayer: 'front', level: 'medium', color: '#e8c56a', opacity: 0.5, thickness: 0.0015, react: 0,
            glow: 0, glowSpread: 6,
        },
        groups: [{
            title: 'Wireframe',
            params: [
                VISIBLE,
                select('level', 'Density', [['coarse', 'Coarse'], ['medium', 'Medium'], ['fine', 'Fine']], 'medium'),
                color('color', 'Colour', '#e8c56a'),
                num('thickness', 'Thickness', 0.0002, 0.012, 0.0002, 0.0015),
                num('opacity', 'Opacity', 0, 1, 0.01, 0.5),
                num('react', 'Spectrum pulse', 0, 3, 0.01, 0),
                LAYER,
            ],
        }, {
            title: 'Glow',
            hint: 'The lines give off light of their own: a hotter core and a soft halo round each line. Only the wireframe glows.',
            params: [
                num('glow', 'Glow', 0, 4, 0.01, 0),
                num('glowSpread', 'Glow spread', 1, 30, 0.1, 6, { when: (p) => p.glow > 0 }),
            ],
        }],
    },

    sun: {
        label: 'Sun',
        category: 'scene',
        unique: true,
        gizmo: 'sun',
        defaults: {
            azimuth: 45, elevation: 47, intensity: 1.1, color: '#ffffff', ambient: 0.55,
            shadows: true, shadowOpacity: 0.4, shadowSoftness: 2,
        },
        groups: [{
            title: 'Sun',
            hint: 'A directional light in the scan’s frame. Lights the placed models; their shadows land on the scan.',
            params: [
                num('azimuth', 'Azimuth', -180, 180, 1, 45),
                num('elevation', 'Elevation', 2, 90, 0.5, 47),
                num('intensity', 'Intensity', 0, 4, 0.01, 1.1),
                color('color', 'Colour', '#ffffff'),
                num('ambient', 'Sky fill', 0, 2, 0.01, 0.55),
                bool('shadows', 'Shadows on the scan', true),
                num('shadowOpacity', 'Darkness', 0, 1, 0.01, 0.4, { when: (p) => p.shadows }),
                num('shadowSoftness', 'Softness', 0, 8, 0.1, 2, { when: (p) => p.shadows }),
            ],
        }],
    },

    camera: {
        label: 'Camera',
        category: 'camera',
        gizmo: 'transform',
        defaults: {
            posX: 0, posY: 0, posZ: 3, rotX: 0, rotY: 0, rotZ: 0, fov: 50, usePath: true,
            projection: 'perspective', orthoHeight: 4,
        },
        groups: [
            {
                title: 'Camera',
                hint: 'Orthographic draws without perspective: parallel lines stay parallel and size doesn\u2019t change with distance. View height is how much of the scene fits top to bottom.',
                params: [
                    select('projection', 'Projection', [['perspective', 'Perspective'], ['orthographic', 'Orthographic']], 'perspective'),
                    num('fov', 'Field of view', 5, 140, 0.5, 50, { when: (p) => p.projection !== 'orthographic' }),
                    num('orthoHeight', 'View height', 0.01, 100, 0.01, 4, { when: (p) => p.projection === 'orthographic' }),
                    bool('usePath', 'Follow recorded path', true),
                ],
            },
            { title: 'Path', custom: 'cameraPath' },
            {
                title: 'Placement',
                hint: 'Used where there is no recorded path, or with the path off.',
                collapsed: true,
                params: transform(20, 0.01).params.filter((p) => p.key !== 'scale'),
            },
        ],
    },

    // ---- Placed objects -----------------------------------------------------

    cloud: {
        label: 'Point cloud',
        category: 'placed',
        gizmo: 'transform',
        defaults: { ...OBJECT_DEFAULTS, visible: true, opacity: 1, depthLayer: 'front', assetId: 'sphere' },
        groups: [
            {
                title: 'Source',
                params: [
                    select('assetId', 'Asset', ASSETS.filter((a) => a.type !== 'glb').map((a) => [a.id, a.name]), 'sphere'),
                    VISIBLE,
                    OPACITY,
                    LAYER,
                ],
            },
            {
                title: 'Geometry',
                params: [
                    num('samples', 'Points', 1000, 300000, 1000, undefined, { link: false, when: (p) => p.assetId === 'sphere' }),
                    num('radius', 'Radius', 0.05, 20, 0.01, undefined, { link: false, when: (p) => p.assetId === 'sphere' }),
                    num('jitter', 'Jitter', 0, 1, 0.001, undefined, { link: false, when: (p) => p.assetId === 'sphere' }),
                    num('pointSize', 'Dot size', 0.0005, 0.05, 0.0005, undefined, { link: false }),
                    num('maxPoints', 'Max dots', 1000, 150000, 1000, undefined, { link: false, when: (p) => p.assetId !== 'sphere' }),
                ],
            },
            {
                title: 'Sphere colour',
                collapsed: true,
                params: [
                    color('sphereColorA', 'Colour A', '#e87d7d', { when: (p) => p.assetId === 'sphere', link: false }),
                    color('sphereColorB', 'Colour B', '#e8c27d', { when: (p) => p.assetId === 'sphere', link: false }),
                    num('sphereGradient', 'Depth → height', 0, 1, 0.01, 0, { when: (p) => p.assetId === 'sphere', link: false }),
                    num('sphereHueShift', 'Hue shift', 0, 1, 0.01, 0, { when: (p) => p.assetId === 'sphere', link: false }),
                ],
            },
            {
                title: 'Spectrum pulse',
                params: [
                    num('reactivity', 'Amount', 0, 3, 0.01, 0.5),
                    num('scatter', 'Scatter', 0, 1, 0.001, 0.002),
                    num('freqRangeMin', 'Freq low', 0, 1, 0.01, 0),
                    num('freqRangeMax', 'Freq high', 0, 1, 0.01, 1),
                    num('originX', 'Origin X', -20, 20, 0.01, 0),
                    num('originY', 'Origin Y', -20, 20, 0.01, 0),
                    num('originZ', 'Origin Z', -20, 20, 0.01, 0),
                ],
            },
            transform(),
        ],
    },

    curve: {
        label: 'Curve',
        category: 'placed',
        gizmo: 'transform',
        defaults: { ...CURVE_DEFAULTS, visible: true, opacity: 1, depthLayer: 'front', funcId: CURVES[0].id },
        groups: [
            {
                title: 'Curve',
                custom: 'curveConvert',
                params: [
                    select('funcId', 'Shape', CURVES.map((c) => [c.id, c.name]), CURVES[0].id),
                    VISIBLE,
                    OPACITY,
                    LAYER,
                    num('curveScale', 'Size', 0.05, 24, 0.01, 8),
                    num('dotCount', 'Dots', 10, 3000, 10, 240, { link: false }),
                    num('dotSize', 'Dot size', 0.002, 0.2, 0.001, 0.045, { link: false }),
                    num('jitter', 'Jitter', 0, 1, 0.005, 0.05),
                    num('flowSpeed', 'Flow', 0, 2, 0.01, 0.15),
                    color('startColor', 'Start colour', '#ff3b3b'),
                    color('endColor', 'End colour', '#3bb0ff'),
                    num('reactivity', 'Bass pulse', 0, 3, 0.01, 0.6),
                ],
            },
            transform(),
        ],
    },

    protagonist: {
        label: 'Protagonist',
        category: 'placed',
        gizmo: 'transform',
        defaults: { ...MODEL_DEFAULTS, visible: true, depthLayer: 'front' },
        groups: [
            { ...transform(10, 0.005), params: [...transform(10, 0.005).params, VISIBLE] },
            VIEWS(150000, 0.05),
            { title: 'Pose', custom: 'pose' },
            {
                title: 'Body',
                collapsed: true,
                params: [
                    num('hipHeight', 'Hip height', 0.2, 1.3, 0.005, 0.59),
                    num('hipForward', 'Hips fwd', -0.4, 0.4, 0.005, 0),
                    bool('plantFeet', 'Plant feet', true),
                    num('footForward', 'Feet fwd', -0.3, 0.9, 0.005, 0.38, { when: (p) => p.plantFeet }),
                    num('footSpread', 'Feet apart', -0.1, 0.35, 0.005, 0.07, { when: (p) => p.plantFeet }),
                    num('breathe', 'Breathing', 0, 2, 0.01, 0.6),
                    ...fromFields(BODY_FIELDS, { link: false }),
                ],
            },
            NOD,
            {
                title: 'Ears',
                collapsed: true,
                params: [
                    bool('twitchOn', 'Twitch', true),
                    num('twitchEvery', 'Every (s)', 0.5, 15, 0.1, 3.5),
                    num('twitchStrength', 'Strength', 0, 3, 0.01, 1),
                    num('earBounce', 'Bounce', 0, 3, 0.01, 1),
                ],
            },
            {
                title: 'Colours & parts',
                collapsed: true,
                params: COLOUR_FIELDS.map(([key, label]) => color(key, label, MODEL_DEFAULTS[key], { link: false })),
                custom: 'parts',
            },
            {
                title: 'Finish',
                collapsed: true,
                params: [
                    ...fromFields(FINISH_FIELDS),
                    select('reflectSource', 'Reflects', [['scan', 'The scan'], ['sky', 'Sky']], 'scan'),
                    ...fromFields(TEXTURE_FIELDS, { link: false }),
                    bool('texDither', 'Dither', MODEL_DEFAULTS.texDither, { link: false }),
                ],
            },
        ],
    },

    sackboy: {
        label: 'Sackboy',
        category: 'placed',
        gizmo: 'transform',
        defaults: { ...SACKBOY_DEFAULTS, visible: true },
        groups: [
            {
                ...transform(10, 0.005),
                params: [...transform(10, 0.005).params, num('height', 'Height (m)', 0.1, 2.5, 0.01, 0.45), VISIBLE],
            },
            {
                ...VIEWS(150000, 0.02),
                params: [
                    ...VIEWS(150000, 0.02).params,
                    select('wireMode', 'Wire edges', [['all', 'All'], ['feature', 'Creases']], 'all', { when: (p) => p.viewWire }),
                    num('wireAngle', 'Crease angle', 1, 90, 1, 25, { when: (p) => p.viewWire && p.wireMode === 'feature', link: false }),
                ],
            },
            { title: 'Pose', custom: 'pose' },
            {
                title: 'Body',
                collapsed: true,
                params: [
                    num('hipHeight', 'Hip height', -0.1, 0.6, 0.002, 0.29),
                    num('hipForward', 'Hips fwd', -0.2, 0.2, 0.002, 0),
                    bool('plantFeet', 'Plant feet', true),
                    num('footForward', 'Feet fwd', -0.2, 0.4, 0.002, 0.01, { when: (p) => p.plantFeet }),
                    num('footSpread', 'Feet apart', -0.06, 0.2, 0.002, 0, { when: (p) => p.plantFeet }),
                    num('breathe', 'Breathing', 0, 2, 0.01, 0.6),
                ],
            },
            NOD,
            {
                title: 'Mouth',
                collapsed: true,
                hint: 'Link Opens to a band controller (Mids works) to have him sing along.',
                params: [num('mouthDepth', 'Opens (°)', 0, 45, 0.5, 18)],
            },
        ],
    },

    prop: {
        label: 'Prop',
        category: 'placed',
        gizmo: 'transform',
        defaults: { ...PROP_DEFAULTS, visible: true, assetId: '' },
        groups: [
            { title: 'Asset', custom: 'library' },
            {
                ...transform(10, 0.005),
                params: [...transform(10, 0.005).params, VISIBLE, OPACITY, bool('castShadow', 'Casts a shadow', true), LAYER],
            },
            {
                title: 'Screen',
                screenOnly: true,
                custom: 'screenSource',
                params: [
                    bool('screenOn', 'Screen on', true),
                    num('videoOffset', 'Start (s)', 0, 120, 0.01, 0),
                    num('videoRate', 'Rate', 0, 4, 0.01, 1),
                    num('brightness', 'Brightness', 0, 4, 0.01, 1.4),
                    select('fit', 'Fit', [[null, 'Default'], ['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch']], null),
                    select('rotate', 'Rotate', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], 0),
                    bool('flipX', 'Mirror', false, { link: false }),
                ],
            },
        ],
    },

    window: {
        label: 'Window',
        category: 'placed',
        gizmo: 'corners',
        defaults: {
            ...WINDOW_DEFAULTS,
            visible: true,
            hueMod: { ...WINDOW_DEFAULTS.hueMod, source: 'off' },
            sortMod: { ...WINDOW_DEFAULTS.sortMod, source: 'off' },
            screenOn: false, video: null, videoOffset: 0, videoRate: 1, brightness: 1.4, videoSaturation: 1, fit: 'cover', rotate: 0, flipX: false,
            hideBehindScan: false,
            ...QT_DEFAULTS,
            qt_on: false,
            qt_space: 'plane',
            qt_planeRes: 768,
            qt_preview: true,
        },
        groups: [
            { title: 'Corners', custom: 'windowCorners' },
            SCREEN_GROUP('Plays a video across the window, the way a prop screen does.'),
            {
                title: 'Window',
                params: [
                    VISIBLE,
                    bool('outline', 'Show outline', true),
                    bool('cut', 'Cut out the footage', true),
                    num('cutOpacity', 'Cut opacity', 0, 1, 0.01, 1, { when: (p) => p.cut }),
                    num('feather', 'Feather', 0, 0.5, 0.005, 0.02),
                    bool('hideBehindScan', 'Hide behind the scan', false),
                    select('fxStage', 'Applies to', [['footage', 'The footage'], ['all', 'Everything (3D too)']], 'footage'),
                ],
            },
            { title: 'Hold to a matte', custom: 'windowMatte', collapsed: true },
            {
                title: 'Hue shift',
                collapsed: true,
                params: [
                    bool('hueOn', 'On', false),
                    num('hueBase', 'Hue (°)', -180, 180, 1, 0, { when: (p) => p.hueOn }),
                    num('hueSat', 'Saturation', 0, 3, 0.01, 1, { when: (p) => p.hueOn }),
                ],
            },
            {
                title: 'Pixel sort',
                collapsed: true,
                params: [
                    bool('sortOn', 'On', false),
                    select('sortBy', 'Sort by', ['brightness', 'hue', 'saturation', 'lightness', 'red', 'green', 'blue'].map((v) => [v, v]), 'brightness', { when: (p) => p.sortOn }),
                    select('thresholdMode', 'Threshold', ['brightness', 'saturation', 'hue', 'none'].map((v) => [v, v]), 'brightness', { when: (p) => p.sortOn }),
                    num('low', 'Low %', 0, 100, 1, 30, { when: (p) => p.sortOn && p.thresholdMode !== 'none' }),
                    num('high', 'High %', 0, 100, 1, 100, { when: (p) => p.sortOn && p.thresholdMode !== 'none' }),
                    select('direction', 'Direction', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], 'vertical', { when: (p) => p.sortOn }),
                    num('segmentMaxLength', 'Seg max px', 0, 2000, 10, 0, { when: (p) => p.sortOn }),
                    bool('reverse', 'Reverse', false, { when: (p) => p.sortOn }),
                    num('rgbShift', 'RGB shift', 0, 64, 1, 0, { when: (p) => p.sortOn }),
                    num('sortScale', 'Resolution', 0.1, 1, 0.05, 0.5, { when: (p) => p.sortOn, link: false }),
                    num('sortMix', 'Mix', 0, 1, 0.01, 1, { when: (p) => p.sortOn }),
                ],
            },
            // A quad tree over the window: the Quad Trees tool's look, drawn
            // on what is under the window and held to its shape.
            {
                title: 'Quad tree',
                collapsed: true,
                custom: 'quadTree',
                hint: 'Load a Quad Trees preset, or set it up here. The picture under the window is the seed. On the window plane the quads lie on the window in perspective, re-subdivided every frame; Plane size is the plane\'s resolution in quad-tree pixels (gaps, outlines and min size are in these). Turn off Show in preview if it slows the preview: exports always include it.',
                params: [
                    bool('qt_on', 'On', false),
                    num('qt_mix', 'Mix', 0, 1, 0.01, 1, { when: (p) => p.qt_on }),
                    select('qt_space', 'Lay out on', [['plane', 'Window plane'], ['screen', 'Screen']], 'screen', { when: (p) => p.qt_on }),
                    num('qt_planeRes', 'Plane size (px)', 128, 2048, 32, 768, { link: false, when: (p) => p.qt_on && p.qt_space === 'plane' }),
                    bool('qt_preview', 'Show in preview', true, { when: (p) => p.qt_on, link: false }),
                ],
            },
            ...QT_GROUPS.map((g) => ({
                ...g,
                title: `Quad tree · ${g.title}`,
                collapsed: true,
                when: (p) => !!p.qt_on && (!g.when || g.when(p)),
            })),
            {
                title: 'Size over time',
                collapsed: true,
                params: [
                    bool('sizeOn', 'Animate', false),
                    select('sizeClock', 'Clock', [['take', 'Footage'], ['music', 'Timeline']], 'take', { when: (p) => p.sizeOn }),
                    num('sizeFrom', 'Start (s)', 0, 120, 0.01, 0, { when: (p) => p.sizeOn }),
                    num('sizeTo', 'End (s)', 0, 120, 0.01, 2, { when: (p) => p.sizeOn }),
                    num('startW', 'Start width', 0, 3, 0.01, 0, { when: (p) => p.sizeOn }),
                    num('startH', 'Start height', 0, 3, 0.01, 0, { when: (p) => p.sizeOn }),
                    num('endW', 'End width', 0, 3, 0.01, 1, { when: (p) => p.sizeOn }),
                    num('endH', 'End height', 0, 3, 0.01, 1, { when: (p) => p.sizeOn }),
                    select('sizeEase', 'Ease', [['linear', 'Linear'], ['in', 'In'], ['out', 'Out'], ['inOut', 'In-out']], 'inOut', { when: (p) => p.sizeOn }),
                    select('sizeAnchor', 'Anchor', [['centre', 'Centre'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']], 'centre', { when: (p) => p.sizeOn }),
                ],
            },
        ],
    },

    text: {
        label: 'Text',
        category: 'placed',
        gizmo: 'corners',
        defaults: {
            visible: true,
            corners: [[-0.5, 0.25, 0], [0.5, 0.25, 0], [0.5, -0.25, 0], [-0.5, -0.25, 0]],
            space: 'scene',
            faceCamera: false,
            frameX: 0.5,
            frameY: 0.85,
            frameW: 0.5,
            frameH: 0.12,
            frameRot: 0,
            textMode: 'plain',
            text: 'Text',
            fontFamily: 'grotesk',
            fontCustom: '',
            fontSize: 0.5,
            weight: 600,
            italic: false,
            color: '#ffffff',
            opacity: 1,
            align: 'center',
            valign: 'middle',
            letterSpacing: 0,
            lineHeight: 1.1,
            bgColor: '#000000',
            bgOpacity: 0,
            padding: 0.05,
            lit: false,
            castShadow: false,
            hideBehindScan: false,
            depthLayer: 'front',
            resolution: 512,
            blend: 'normal',
            softness: 0,
            grain: 0,
            grainMove: true,
            mottle: 0,
            wear: 0,
            noiseDetail: 24,
        },
        groups: [
            {
                title: 'Placement',
                hint: 'In the scene, the text is a patch between four corners, in 3D; facing the camera, it turns about its middle (a spline\u2019s label, about its point) to stay square to the view. In the frame, it is laid flat over the picture (2D), wherever the camera looks: X and Y place its middle (0 to 1 across and down the frame), width and height are fractions of the frame\u2019s.',
                params: [
                    select('space', 'Placed in', [['scene', 'The scene (3D)'], ['frame', 'The frame (2D)']], 'scene'),
                    num('frameX', 'X', -0.5, 1.5, 0.001, 0.5, { when: (p) => p.space === 'frame' }),
                    num('frameY', 'Y', -0.5, 1.5, 0.001, 0.85, { when: (p) => p.space === 'frame' }),
                    num('frameW', 'Width', 0.01, 2, 0.001, 0.5, { when: (p) => p.space === 'frame' }),
                    num('frameH', 'Height', 0.01, 2, 0.001, 0.12, { when: (p) => p.space === 'frame' }),
                    num('frameRot', 'Rotate', -180, 180, 0.5, 0, { when: (p) => p.space === 'frame' }),
                    bool('faceCamera', 'Face the camera', false, { link: false, when: (p) => p.space !== 'frame' }),
                ],
            },
            { title: 'Corners', custom: 'windowCorners', when: (p) => p.space !== 'frame' },
            {
                title: 'Text',
                custom: 'textDynamic',
                params: [
                    select('textMode', 'Kind', [['plain', 'Plain text'], ['latex', 'LaTeX (maths)']], 'plain'),
                    text('text', 'Text', 'Text'),
                    select('fontFamily', 'Font', FONTS.map(([id, label]) => [id, label]), 'grotesk', { when: (p) => p.textMode !== 'latex' }),
                    string('fontCustom', 'Font name', '', { when: (p) => p.textMode !== 'latex' && p.fontFamily === 'custom' }),
                    num('fontSize', 'Size', 0.02, 1.5, 0.005, 0.5),
                    select('weight', 'Weight', [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => [w, String(w)]), 600, { when: (p) => p.textMode !== 'latex' }),
                    bool('italic', 'Italic', false, { link: false, when: (p) => p.textMode !== 'latex' }),
                    color('color', 'Colour', '#ffffff'),
                    OPACITY,
                    select('blend', 'Blend', TEXT_BLENDS, 'normal'),
                    select('align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], 'center'),
                    select('valign', 'Vertical', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], 'middle'),
                    num('letterSpacing', 'Letter spacing', -0.2, 1, 0.005, 0, { when: (p) => p.textMode !== 'latex' }),
                    num('lineHeight', 'Line height', 0.6, 3, 0.01, 1.1),
                    VISIBLE,
                ],
            },
            { title: 'Variables', custom: 'usedVariables', collapsed: true },
            {
                title: 'Surface',
                hint: 'To sit text in the footage: soften it to the shot\'s focus, add grain like the video\'s, and mottle or wear it. Pairs well with Blend: Screen or Multiply.',
                params: [
                    num('softness', 'Softness', 0, 5, 0.05, 0),
                    num('grain', 'Grain', 0, 1, 0.01, 0),
                    bool('grainMove', 'Grain moves', true, { when: (p) => p.grain > 0 }),
                    num('mottle', 'Mottle', 0, 1, 0.01, 0),
                    num('wear', 'Wear', 0, 1, 0.01, 0),
                    num('noiseDetail', 'Noise detail', 1, 200, 0.5, 24, { when: (p) => p.mottle > 0 || p.wear > 0 }),
                ],
            },
            {
                title: 'Box',
                collapsed: true,
                hint: 'Letters are rasterised at the size they are drawn on screen, in the preview and in exports (up to 4096 px); Min sharpness is the least they get.',
                params: [
                    color('bgColor', 'Fill', '#000000'),
                    num('bgOpacity', 'Fill opacity', 0, 1, 0.01, 0),
                    num('padding', 'Padding', 0, 0.4, 0.005, 0.05),
                    num('resolution', 'Min sharpness (px)', 128, 2048, 32, 512, { link: false }),
                ],
            },
            {
                title: 'Light & shadow',
                params: [
                    bool('lit', 'Lit by the sun', false, { when: (p) => p.space !== 'frame' }),
                    bool('castShadow', 'Casts a shadow', false, { when: (p) => p.space !== 'frame' }),
                    bool('hideBehindScan', 'Hide behind the scan', false, { when: (p) => p.space !== 'frame' }),
                    LAYER,
                ],
            },
        ],
    },

    equation: {
        label: 'Equation',
        category: 'placed',
        gizmo: 'transform',
        defaults: {
            ...CURVE_LOOK_DEFAULTS,
            fx: 'cos(t)',
            fy: 'sin(t)',
            fz: '0',
            rangeFrom: 0,
            rangeTo: 6.2832,
        },
        groups: [
            {
                title: 'Equation',
                custom: 'equation',
                hint: 'x(t), y(t) and z(t) are worked out for every t from the start to the end. They can use variables (lowercase greek letters, with a subscript if you like: θ, θ_1, ω_k), defined under Variables, which a controller can drive; k is the copy in a series, time the timeline in seconds.',
                params: [
                    num('rangeFrom', 't from', -50, 50, 0.001, 0),
                    num('rangeTo', 't to', -50, 50, 0.001, 6.2832),
                ],
            },
            { title: 'Variables', custom: 'usedVariables' },
            ...curveLookGroups('t'),
            transform(),
        ],
    },

    spline: {
        label: 'Spline',
        category: 'placed',
        gizmo: 'transform',
        defaults: {
            ...CURVE_LOOK_DEFAULTS,
            symbol: 'P',
            points: [['-1', '0', '0'], ['-0.33', '0.6', '0'], ['0.33', '-0.6', '0'], ['1', '0', '0']],
            degree: 3,
            ends: 'natural',
            spacing: 'uniform',
            clamp: { start: {}, end: {} },
            rangeFrom: 0,
            rangeTo: 1,
            showKnots: true,
            knotSize: 0.035,
            knotColor: '#ffffff',
            knotShape: 'octa',
            knotStyle: 'solid',
            knotWire: 1.5,
            labels: false,
            labelShow: 'point',
            labelSize: 0.1,
            labelColor: '#ffffff',
            knotSpin: 0,
            knotSpinAxis: 'random',
            knotSpinTogether: false,
            pointsByU: false,
            pointsAppear: 0,
        },
        groups: [
            {
                title: 'Spline',
                custom: 'splinePoints',
                hint: 'Through its points in order. Every derivative below the degree matches on both sides of every point (a cubic\u2019s slope and curvature), and the ends settle the rest. Its symbol is a global: P_0 or P[i] is a point, P(u) the curve at u from 0 to 1, with .x .y .z for a coordinate.',
                params: [
                    select('degree', 'Degree', SPLINE_DEGREES, 3),
                    select('ends', 'Ends', SPLINE_ENDS, 'natural'),
                    select('spacing', 'Spacing', SPLINE_SPACING, 'uniform'),
                    num('rangeFrom', 'u from', 0, 1, 0.001, 0),
                    num('rangeTo', 'u to', 0, 1, 0.001, 1),
                ],
            },
            {
                title: 'Defining points',
                collapsed: true,
                custom: 'splinePointList',
                hint: 'Each point is a child of the spline (under it in the outliner) with a marker and a LaTeX label, placed where the point is and going with it. Select one to move, size or rewrite its label, hide its marker or label, or give it a look of its own; deleting one deletes the point. A label you rewrite keeps your words; the rest say what their point is. Edge widths are in pixels of a 1080-tall frame. Spin turns every marker (own look or not) at that rate, on the timeline\u2019s clock; flat ones turn in their plane, and In step starts them all at the same angle. Only visible once u reaches them: a point shows when the drawn part of the curve (its u range, as it grows) has got to it.',
                params: [
                    bool('showKnots', 'Show markers', true),
                    select('knotShape', 'Shape', POINT_SHAPES, 'octa', { when: (p) => p.showKnots }),
                    select('knotStyle', 'Drawn', POINT_STYLES, 'solid', { when: (p) => p.showKnots }),
                    num('knotWire', 'Edge width (px)', 0.25, 12, 0.05, 1.5, { when: (p) => p.showKnots && p.knotStyle === 'wire' }),
                    num('knotSize', 'Size', 0.001, 0.5, 0.001, 0.035, { when: (p) => p.showKnots }),
                    color('knotColor', 'Colour', '#ffffff', { when: (p) => p.showKnots }),
                    num('knotSpin', 'Spin (\u00b0/s)', -720, 720, 1, 0, { when: (p) => p.showKnots }),
                    select('knotSpinAxis', 'Spin about', [['random', 'An axis of each one\u2019s own'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'random', { when: (p) => p.showKnots && !!p.knotSpin }),
                    bool('knotSpinTogether', 'In step', false, { when: (p) => p.showKnots && !!p.knotSpin }),
                    bool('pointsByU', 'Only visible once u reaches them', false),
                    num('pointsAppear', 'Grow in over (u)', 0, 0.5, 0.001, 0, { when: (p) => p.pointsByU }),
                    select('labelShow', 'Labels say', [['point', 'Name and point: P\u2080 = (x, y, z)'], ['name', 'Name: P\u2080']], 'point', { when: (p) => p.labels }),
                    num('labelSize', 'New label size', 0.005, 2, 0.001, 0.1, { when: (p) => p.labels }),
                    color('labelColor', 'New label colour', '#ffffff', { when: (p) => p.labels }),
                ],
            },
            { title: 'Variables', custom: 'usedVariables' },
            ...curveLookGroups('u'),
            transform(),
        ],
    },

    // ---- Effects (program level, applied in order) ----------------------------

    glow: {
        label: 'Glow',
        category: 'effect',
        defaults: { visible: true, source: 'all', strength: 0.6, radius: 0.6, threshold: 0.8, bleed: 0, reach: 0.5 },
        groups: [{
            title: 'Glow',
            hint: 'Everything blooms over its floor, or only the points do (and can light what is round them).',
            params: [
                VISIBLE,
                select('source', 'Source', [['all', 'Whole frame'], ['points', 'Points only']], 'all'),
                num('strength', 'Strength', 0, 3, 0.01, 0.6),
                num('radius', 'Spread', 0, 2, 0.01, 0.6),
                num('threshold', 'Floor', 0, 1, 0.01, 0.8, { when: (p) => p.source !== 'points' }),
                num('bleed', 'Bleed', 0, 4, 0.01, 0, { when: (p) => p.source === 'points' }),
                num('reach', 'Bleed reach', 0, 1, 0.01, 0.5, { when: (p) => p.source === 'points' }),
            ],
        }],
    },

    haze: {
        label: 'Haze',
        category: 'effect',
        defaults: { visible: true, amount: 0.7 },
        groups: [{ title: 'Haze', params: [VISIBLE, num('amount', 'Amount', 0, 2, 0.01, 0.7)] }],
    },

    quadtree: {
        label: 'Quad Tree',
        category: 'effect',
        defaults: { visible: true, qt_target: 'program', qt_preview: true, ...QT_DEFAULTS },
        groups: [
            {
                title: 'Quad tree',
                custom: 'quadTree',
                hint: 'The Quad Trees tool as an effect: over the whole program, or over one video track (a take or a video) while it shows. The picture is the seed; a preset brings its look.',
                params: [VISIBLE, num('qt_mix', 'Mix', 0, 1, 0.01, 1), bool('qt_preview', 'Show in preview', true, { link: false })],
            },
            ...QT_GROUPS,
        ],
    },

    pixelsort: {
        label: 'Pixel Sort',
        category: 'effect',
        defaults: {
            visible: true,
            target: 'program',
            preview: true,
            sortBy: 'brightness',
            thresholdMode: 'brightness',
            low: 30,
            high: 100,
            direction: 'vertical',
            segmentMaxLength: 0,
            reverse: false,
            rgbShift: 0,
            sortScale: 0.5,
            sortMix: 1,
        },
        groups: [
            {
                title: 'Pixel sort',
                custom: 'effectTarget',
                hint: 'The Pixel Sorter as an effect: over the whole program, or over one video track (a take or a video) while it shows. In the preview it shows the last sort that finished, so it can trail the picture a little; exports sort every frame. Lengths are in output pixels.',
                params: [
                    VISIBLE,
                    num('sortMix', 'Mix', 0, 1, 0.01, 1),
                    select('sortBy', 'Sort by', ['brightness', 'hue', 'saturation', 'lightness', 'red', 'green', 'blue'].map((v) => [v, v]), 'brightness'),
                    select('thresholdMode', 'Threshold', ['brightness', 'saturation', 'hue', 'none'].map((v) => [v, v]), 'brightness'),
                    num('low', 'Low %', 0, 100, 1, 30, { when: (p) => p.thresholdMode !== 'none' }),
                    num('high', 'High %', 0, 100, 1, 100, { when: (p) => p.thresholdMode !== 'none' }),
                    select('direction', 'Direction', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], 'vertical'),
                    num('segmentMaxLength', 'Seg max px', 0, 2000, 10, 0),
                    bool('reverse', 'Reverse', false),
                    num('rgbShift', 'RGB shift', 0, 64, 1, 0),
                    num('sortScale', 'Resolution', 0.1, 1, 0.05, 0.5, { link: false }),
                    bool('preview', 'Show in preview', true, { link: false }),
                ],
            },
        ],
    },

    grade: {
        label: 'Grade',
        category: 'effect',
        defaults: { visible: true, ...Object.fromEntries(GRADE_PARAMS.map((p) => [p.key, p.def])) },
        groups: [{
            title: 'Grade',
            params: [VISIBLE, ...GRADE_PARAMS.map((p) => num(p.key, p.label, p.min, p.max, p.step, p.def))],
        }],
    },
};

// ---- The Blob Tracker effect ----------------------------------------------------
//
// The Blob Tracker tool's engine (lib/blobTracker) over a picture, with a
// window in every box. Its window settings are the Window type's own, taken
// from it here (all but where the corners are and how big it is, which the
// boxes decide), so a window feature added there shows here too.

const BLOB_WINDOW_SKIP_GROUPS = new Set(['Corners', 'Size over time']);
// Set by the boxes, or only for windows placed by hand.
// (A Blob Tracker's windows always work on what is behind the effect: the
// picture the effects before it left, 3D and all, so not `fxStage`.)
const BLOB_WINDOW_SKIP_KEYS = new Set(['visible', 'outline', 'qt_space', 'qt_planeRes', 'fxStage']);
const spawning = (p) => !!p.spawnWindows;
const blobWindowGroups = () => OBJECT_TYPES.window.groups
    // A screen is a video decoder per window: not for one in every box.
    .filter((g) => !BLOB_WINDOW_SKIP_GROUPS.has(g.title) && g.custom !== 'screenSource')
    .map((g) => ({
        ...g,
        title: `Windows · ${g.title}`,
        collapsed: true,
        when: (p) => spawning(p) && (!g.when || g.when(p)),
        params: (g.params || []).filter((d) => !BLOB_WINDOW_SKIP_KEYS.has(d.key)),
    }))
    .filter((g) => g.params.length || g.custom);

const { corners, ...BLOB_WINDOW_DEFAULTS } = OBJECT_TYPES.window.defaults; // eslint-disable-line no-unused-vars

const labelsOn = (p) => p.showLabels !== false;

OBJECT_TYPES.blobs = {
    label: 'Blob Tracker',
    category: 'effect',
    defaults: {
        ...BLOB_WINDOW_DEFAULTS,
        // A window in a box starts out doing nothing to the picture: pick
        // what it does (a cut, a hue shift, a sort, a quad tree).
        cut: false,
        ...BLOB_DEFAULTS,
        visible: true,
        target: 'program',
        preview: true,
        spawnWindows: false,
        winPad: 0,
    },
    groups: [
        {
            title: 'Blob tracker',
            custom: 'effectTarget',
            hint: 'The Blob Tracker tool as an effect: finds bright (or dark) blobs in the whole program, or in one video track while it shows, and boxes them. It only sees what is behind it: the picture the effects above it in the list left, never its own windows and boxes or the effects below it, so on a paused frame the boxes settle and stay put. In the preview the boxes can trail the picture by a frame or two; exports track every frame from the start.',
            params: [VISIBLE, bool('preview', 'Show in preview', true, { link: false })],
        },
        {
            title: 'Detection',
            params: [
                num('threshold', 'Threshold', 0, 255, 1, BLOB_DEFAULTS.threshold),
                bool('invert', 'Track dark', BLOB_DEFAULTS.invert),
                num('minArea', 'Min size', 1, 120, 1, BLOB_DEFAULTS.minArea),
                num('maxSize', 'Max size (% of frame)', 0.1, 100, 0.1, BLOB_DEFAULTS.maxSize),
                num('maxBoxes', 'Max boxes', 1, 30, 1, BLOB_DEFAULTS.maxBoxes, { link: false }),
                num('smoothing', 'Smoothing', 0, 0.95, 0.01, BLOB_DEFAULTS.smoothing),
            ],
        },
        {
            title: 'Boxes',
            params: [
                bool('showBoxes', 'Show boxes', true),
                select('boxStyle', 'Style', [['corners', 'Corners'], ['box', 'Box'], ['cross', 'Cross']], BLOB_DEFAULTS.boxStyle),
                color('boxColor', 'Colour', BLOB_DEFAULTS.boxColor),
                num('lineWidth', 'Line width', 0.5, 12, 0.5, BLOB_DEFAULTS.lineWidth),
                num('boxOpacity', 'Opacity', 0, 1, 0.01, BLOB_DEFAULTS.boxOpacity),
                num('borderRadius', 'Radius', 0, 48, 1, BLOB_DEFAULTS.borderRadius),
                num('glow', 'Glow', 0, 40, 1, BLOB_DEFAULTS.glow),
                num('blur', 'Blur', 0, 10, 0.1, BLOB_DEFAULTS.blur),
            ],
        },
        {
            title: 'Labels',
            hint: `Sizes are in pixels at 1280 wide, and scale with the frame. Numbers count in output pixels. A custom label can use ${LABEL_TOKENS}. Radius -1 follows the boxes'.`,
            params: [
                bool('showLabels', 'Show labels', true),
                select('labelText', 'Says', LABEL_TEXTS.map(([id, name]) => [id, name]), BLOB_DEFAULTS.labelText, { when: labelsOn }),
                string('labelTemplate', 'Template', BLOB_DEFAULTS.labelTemplate, { when: (p) => labelsOn(p) && p.labelText === 'custom', placeholder: '#{id}  {area}' }),
                select('labelFont', 'Font', GLYPH_FONTS.map(([id, name]) => [id, name]), BLOB_DEFAULTS.labelFont, { when: labelsOn }),
                string('labelFontCustom', 'Font name', '', { when: (p) => labelsOn(p) && p.labelFont === 'custom', placeholder: 'Installed font' }),
                select('labelWeight', 'Weight', GLYPH_WEIGHTS.map((w) => [w, String(w)]), BLOB_DEFAULTS.labelWeight, { when: labelsOn }),
                select('labelPlace', 'Place', LABEL_PLACES, BLOB_DEFAULTS.labelPlace, { when: labelsOn }),
                num('labelSize', 'Text size', 4, 64, 0.5, BLOB_DEFAULTS.labelSize, { when: labelsOn }),
                num('labelGap', 'Gap to box', -40, 80, 0.5, BLOB_DEFAULTS.labelGap, { when: labelsOn }),
                num('labelPadX', 'Padding across', 0, 40, 0.5, BLOB_DEFAULTS.labelPadX, { when: labelsOn }),
                num('labelPadY', 'Padding down', 0, 40, 0.5, BLOB_DEFAULTS.labelPadY, { when: labelsOn }),
                num('labelRadius', 'Radius', -1, 48, 1, BLOB_DEFAULTS.labelRadius, { when: labelsOn }),
                color('labelColor', 'Fill', BLOB_DEFAULTS.labelColor, { when: labelsOn }),
                num('labelOpacity', 'Fill opacity', 0, 1, 0.01, BLOB_DEFAULTS.labelOpacity, { when: labelsOn }),
                color('labelTextColor', 'Text', BLOB_DEFAULTS.labelTextColor, { when: labelsOn }),
                bool('labelOutline', 'Outline', BLOB_DEFAULTS.labelOutline, { when: labelsOn }),
                color('labelOutlineColor', 'Outline colour', BLOB_DEFAULTS.labelOutlineColor, { when: (p) => labelsOn(p) && p.labelOutline }),
                num('labelOutlineWidth', 'Outline width', 0, 8, 0.25, BLOB_DEFAULTS.labelOutlineWidth, { when: (p) => labelsOn(p) && p.labelOutline }),
                num('labelOutlineOpacity', 'Outline opacity', 0, 1, 0.01, BLOB_DEFAULTS.labelOutlineOpacity, { when: (p) => labelsOn(p) && p.labelOutline }),
            ],
        },
        {
            title: 'Connections',
            collapsed: true,
            params: [
                bool('showConnections', 'Show', BLOB_DEFAULTS.showConnections),
                color('connectionColor', 'Colour', BLOB_DEFAULTS.connectionColor, { when: (p) => p.showConnections }),
                num('connectionCurve', 'Curvature', 0, 1, 0.01, BLOB_DEFAULTS.connectionCurve, { when: (p) => p.showConnections }),
                num('connectionShuffle', 'Reshuffle (s)', 0, 10, 0.1, BLOB_DEFAULTS.connectionShuffle, { when: (p) => p.showConnections }),
            ],
        },
        {
            title: 'Windows',
            hint: 'A window in every box, like a placed one: give it a cut, a hue shift, a pixel sort or a quad tree, hold it to a matte. Padding grows (or shrinks) each window past its box, in output pixels.',
            params: [
                bool('spawnWindows', 'Window in each box', false),
                num('winPad', 'Padding', -200, 400, 1, 0, { when: spawning }),
            ],
        },
        ...blobWindowGroups(),
    ],
};

// A spline's defining point, as the spline's child (made and removed with
// its points, see model/splineLabels.js): a marker where the point is and a
// label beside it, both placed from the point. The label is a Text's.
{
    const T = OBJECT_TYPES.text;
    OBJECT_TYPES.splinePoint = {
        label: 'Point',
        category: 'placed',
        gizmo: 'corners',
        child: true,
        defaults: {
            ...T.defaults,
            textMode: 'latex',
            faceCamera: true,
            fontSize: 0.7,
            padding: 0,
            align: 'left',
            valign: 'middle',
            showMarker: true,
            showLabel: true,
            markerOwn: false,
            markerShape: 'octa',
            markerStyle: 'solid',
            markerWire: 1.5,
            markerSize: 0.035,
            markerColor: '#ffffff',
        },
        groups: [
            {
                title: 'Point',
                custom: 'pointOf',
                params: [
                    bool('showMarker', 'Marker', true),
                    bool('showLabel', 'Label', true),
                ],
            },
            {
                title: 'Marker',
                collapsed: true,
                hint: 'Drawn as the spline\u2019s markers are, unless it has a look of its own. The spline\u2019s Show markers still hides them all.',
                params: [
                    bool('markerOwn', 'A look of its own', false, { link: false }),
                    select('markerShape', 'Shape', POINT_SHAPES, 'octa', { when: (p) => p.markerOwn }),
                    select('markerStyle', 'Drawn', POINT_STYLES, 'solid', { when: (p) => p.markerOwn }),
                    num('markerWire', 'Edge width (px)', 0.25, 12, 0.05, 1.5, { when: (p) => p.markerOwn && p.markerStyle === 'wire' }),
                    num('markerSize', 'Size', 0.001, 0.5, 0.001, 0.035, { when: (p) => p.markerOwn }),
                    color('markerColor', 'Colour', '#ffffff', { when: (p) => p.markerOwn }),
                ],
            },
            {
                title: 'Label',
                hint: 'Its corners are measured from the point, in the spline\u2019s frame. Facing the camera, it turns about the point, so it stays to the same side of it on screen. The spline\u2019s Show labels still hides them all.',
                params: [bool('faceCamera', 'Face the camera', true, { link: false })],
            },
            ...T.groups.filter((g) => g.title !== 'Placement').map((g) => (g.title === 'Corners' ? { ...g, title: 'Label corners' } : g)),
        ],
    };
}

/** What the Add menu offers, by section. */
export const ADDABLE = {
    placed: ['cloud', 'curve', 'equation', 'spline', 'protagonist', 'sackboy', 'prop', 'window', 'text'],
    camera: ['camera'],
    effect: ['glow', 'haze', 'grade', 'quadtree', 'pixelsort', 'blobs'],
};

// Parameters of the timeline's tracks, linkable like any object's: cutting
// between parallel videos is each track's visibility linked to a Switch.
export const TRACK_PARAMS = [
    bool('visible', 'Visible', true),
    num('opacity', 'Opacity', 0, 1, 0.01, 1),
];
export const AUDIO_TRACK_PARAMS = [
    bool('visible', 'Audible', true),
    num('gain', 'Gain', 0, 2, 0.01, 1, { link: false }),
];

/** Every parameter definition of a type, flattened, by key. */
const defsCache = new Map();
export function paramDefs(type) {
    let m = defsCache.get(type);
    if (m) return m;
    m = new Map();
    const t = OBJECT_TYPES[type];
    (t?.groups || []).forEach((g) => (g.params || []).forEach((p) => { if (!m.has(p.key)) m.set(p.key, p); }));
    defsCache.set(type, m);
    return m;
}

export const trackDefs = (kind) => new Map((kind === 'audio' ? AUDIO_TRACK_PARAMS : TRACK_PARAMS).map((p) => [p.key, p]));

export function defaultParams(type) {
    const t = OBJECT_TYPES[type];
    const out = { visible: true, ...(t?.defaults || {}) };
    paramDefs(type).forEach((p, k) => { if (out[k] === undefined && p.def !== undefined) out[k] = p.def; });
    return out;
}
