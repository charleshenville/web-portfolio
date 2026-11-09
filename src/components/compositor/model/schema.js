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
import { FONTS } from '../engine/textObject';
import { WINDOW_DEFAULTS } from '../../../lib/scanAssets/windows';

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
        },
        groups: [
            {
                title: 'Camera',
                params: [
                    num('fov', 'Field of view', 5, 140, 0.5, 50),
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
        },
        groups: [
            { title: 'Corners', custom: 'windowCorners' },
            {
                title: 'Text',
                params: [
                    text('text', 'Text', 'Text'),
                    select('fontFamily', 'Font', FONTS.map(([id, label]) => [id, label]), 'grotesk'),
                    string('fontCustom', 'Font name', '', { when: (p) => p.fontFamily === 'custom' }),
                    num('fontSize', 'Size', 0.02, 1.5, 0.005, 0.5),
                    select('weight', 'Weight', [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => [w, String(w)]), 600),
                    bool('italic', 'Italic', false, { link: false }),
                    color('color', 'Colour', '#ffffff'),
                    OPACITY,
                    select('align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], 'center'),
                    select('valign', 'Vertical', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], 'middle'),
                    num('letterSpacing', 'Letter spacing', -0.2, 1, 0.005, 0),
                    num('lineHeight', 'Line height', 0.6, 3, 0.01, 1.1),
                    VISIBLE,
                ],
            },
            {
                title: 'Box',
                collapsed: true,
                params: [
                    color('bgColor', 'Fill', '#000000'),
                    num('bgOpacity', 'Fill opacity', 0, 1, 0.01, 0),
                    num('padding', 'Padding', 0, 0.4, 0.005, 0.05),
                    num('resolution', 'Sharpness (px)', 128, 2048, 32, 512, { link: false }),
                ],
            },
            {
                title: 'Light & shadow',
                params: [
                    bool('lit', 'Lit by the sun', false),
                    bool('castShadow', 'Casts a shadow', false),
                    bool('hideBehindScan', 'Hide behind the scan', false),
                    LAYER,
                ],
            },
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

/** What the Add menu offers, by section. */
export const ADDABLE = {
    placed: ['cloud', 'curve', 'protagonist', 'sackboy', 'prop', 'window', 'text'],
    camera: ['camera'],
    effect: ['glow', 'haze', 'grade'],
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
