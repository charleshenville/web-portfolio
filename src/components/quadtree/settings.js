// Every Quad Trees setting with its default, and the looks presets start
// from. Sizes (gap, outline, min size) are in output pixels.

export const DEFAULTS = {
    // ---- Output & time
    aspect: 'auto',          // 'auto' (the seed's) | '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | '3:4' | '21:9'
    outLong: 1920,           // long side of the output frame
    loop: 8,                 // seconds; generated seeds and stills loop at this

    // ---- Seed
    seed: 'gradient',        // 'gradient' | 'shapes' | 'procedural' | 'image' | 'video'
    fit: 'cover',
    seedZoom: 1,

    gradType: 'waves',       // 'linear' | 'radial' | 'conic' | 'corners' | 'waves'
    gradStops: ['#0c0c0c', '#0000ff', '#6b8cff', '#ecebe6'],
    gradAngle: 30,
    gradSpin: 0,             // turns per loop
    gradCycles: 1,           // colour cycles per loop
    gradScale: 1.4,

    shapeCount: 14,
    shapeSize: 0.34,         // of the frame height
    shapeSizeVar: 0.6,
    shapeKind: 'circle',     // 'circle' | 'square' | 'triangle' | 'ring' | 'mixed'
    shapeSpeed: 2,           // bounces per loop
    shapeSpin: 0,
    shapeRate: 1,            // speed multiplier on the motion
    shapePalette: 'stops',   // 'rainbow' | 'stops'
    shapeSat: 0.85,
    shapeStops: ['#0000ff', '#6b8cff', '#ecebe6', '#2a3dd6'],
    shapeBg: '#0c0c0c',
    shapeSoft: 0,
    shapeBlend: 'over',      // 'over' | 'add' | 'screen'
    shapeBlur: 0.04,         // of the frame height
    shapeSeed: 7,

    proc: {                  // the Procedural Art tool's settings (pixels style)
        mode: 'perlin',
        scale: 30,
        octaves: 4,
        fractal: 'fbm',
        warp: 1.2,
        evolve: 0.3,
        levels: 48,
        colorMode: 'gradient',
        stops: ['#0c0c0c', '#0000ff', '#6b8cff', '#ecebe6'],
    },
    procRes: 160,            // noise columns

    // ---- Grade (on the seed)
    exposure: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    tint: 0,
    hue: 0,
    gamma: 1,
    lift: 0,
    gain: 1,
    invert: false,
    posterize: 0,
    blur: 0,                 // of the frame height

    // ---- Subdivision
    metric: 'color',         // 'color' | 'luma' | 'r' | 'g' | 'b' | 'noise'
    threshold: 0.06,         // standard deviation (0-1 units) a quad splits above
    maxDepth: 7,
    minDepth: 1,
    minSize: 3,
    rootCols: 4,
    falloff: 1,              // threshold x falloff^depth
    analysisRes: 512,

    noiseScale: 3,
    noiseOctaves: 4,
    noiseEvolve: 1,          // noise cycles per loop
    noiseContrast: 1,
    noiseWarp: 0,
    noiseSeed: 1,


    // ---- Style
    shape: 'square',         // 'square' | 'circle' | 'mixed' | 'ascii'
    radius: 0,
    gap: 0,
    size: 1,
    halftone: 0,
    halftoneInvert: false,
    mixRatio: 0.5,
    styleSeed: 0,
    fill: true,
    outline: 1,
    outlineMode: 'solid',    // 'solid' | 'cell' | 'shade'
    outlineColor: '#0c0c0c',
    quadOpacity: 1,
    ramp: ' .:-=+*#%@',
    rampInvert: false,
    glyphFont: 'mono',       // fonts.js
    glyphFontCustom: '',     // any installed font, by name, with 'custom'
    glyphWeight: 400,
    glyphItalic: false,
    rampBy: 'brightness',    // ascii glyph from 'brightness' | 'size' (bigger cells, denser glyphs) | 'depth' (one character per level)
    glyphBg: 0,

    // ---- Colour
    colorSource: 'seed',     // 'seed' | 'gradient' | 'depth'
    stops: ['#0c0c0c', '#0000ff', '#ecebe6'],
    levels: 0,
    background: '#0c0c0c',
    underlay: 0,

    // ---- Post
    glow: 0,
    glowRadius: 0.5,
    glowThreshold: 0.55,
    glowTint: '#ffffff',
    glowNormalize: true,     // off: every pyramid level adds in full (blown out)
    vignette: 0,
    grain: 0,
    aberration: 0,
};

// Looks: only what they change; the seed is kept.
export const PRESETS = [
    {
        id: 'mosaic',
        name: 'Mosaic',
        set: {
            metric: 'color', threshold: 0.06, maxDepth: 7, minDepth: 1, rootCols: 4,
            shape: 'square', radius: 0, gap: 0, size: 1, halftone: 0, fill: true, outline: 1, outlineMode: 'solid', outlineColor: '#0c0c0c',
            colorSource: 'seed', levels: 0, background: '#0c0c0c', underlay: 0, glow: 0, glowNormalize: true, vignette: 0, grain: 0, aberration: 0,
        },
    },
    {
        id: 'halftone',
        name: 'Halftone',
        set: {
            metric: 'luma', threshold: 0.05, maxDepth: 6, minDepth: 2, rootCols: 6, minSize: 4,
            shape: 'mixed', mixRatio: 0.45, radius: 0.45, gap: 3, size: 1, halftone: 0.55, halftoneInvert: false, fill: true, outline: 0,
            colorSource: 'gradient', stops: ['#000000', '#ffffff'], levels: 2, background: '#000000', underlay: 0,
            glow: 0, vignette: 0, grain: 0, aberration: 0, saturation: 0, contrast: 1.4, glowNormalize: true,
        },
    },
    {
        id: 'lines',
        name: 'Glow Lines',
        set: {
            metric: 'luma', threshold: 0.03, maxDepth: 8, minDepth: 1, rootCols: 3, minSize: 2,
            shape: 'square', radius: 0, gap: 0, size: 1, halftone: 0, fill: false, outline: 1.5, outlineMode: 'solid', outlineColor: '#f3cfa8',
            colorSource: 'seed', levels: 0, background: '#0d0b0a', underlay: 0.06,
            glow: 2.2, glowRadius: 0.6, glowThreshold: 0.3, glowTint: '#ffcf9e', vignette: 0.55, grain: 0.12, aberration: 0, glowNormalize: true,
        },
    },
    {
        id: 'blowout',
        name: 'Glow Blowout',
        set: {
            metric: 'luma', threshold: 0.03, maxDepth: 8, minDepth: 1, rootCols: 3, minSize: 2,
            shape: 'square', radius: 0, gap: 0, size: 1, halftone: 0, fill: false, outline: 1.5, outlineMode: 'solid', outlineColor: '#f3cfa8',
            colorSource: 'seed', levels: 0, background: '#100d0b', underlay: 0.18,
            glow: 1.6, glowRadius: 0.65, glowThreshold: 0.2, glowTint: '#ffd9b0', glowNormalize: false, vignette: 0.5, grain: 0.15, aberration: 0,
        },
    },
    {
        id: 'ascii',
        name: 'Ascii',
        set: {
            metric: 'luma', threshold: 0.05, maxDepth: 6, minDepth: 2, rootCols: 6, minSize: 5,
            shape: 'ascii', size: 1, ramp: ' .:-=+*#%@', rampInvert: false, glyphBg: 0.25,
            colorSource: 'seed', levels: 0, background: '#000000', underlay: 0,
            glow: 0.6, glowRadius: 0.4, glowThreshold: 0.5, glowTint: '#ffffff', vignette: 0.3, grain: 0, aberration: 0, glowNormalize: true,
        },
    },
    {
        id: 'noise',
        name: 'Noise Split',
        set: {
            metric: 'noise', threshold: 0.07, maxDepth: 7, minDepth: 1, rootCols: 4, minSize: 3,
            noiseScale: 2.5, noiseOctaves: 4, noiseEvolve: 1, noiseContrast: 1.2, noiseWarp: 0.6,
            shape: 'square', radius: 0.25, gap: 2, size: 1, halftone: 0, fill: true, outline: 0,
            colorSource: 'seed', levels: 0, background: '#08080a', underlay: 0,
            glow: 0.5, glowRadius: 0.5, glowThreshold: 0.6, vignette: 0.2, grain: 0, aberration: 0, glowNormalize: true,
        },
    },
];

export const ASPECTS = [
    ['auto', 'Auto'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['4:3', '4:3'], ['3:4', '3:4'], ['21:9', '21:9'],
];

export const RAMPS = [
    ['Classic', ' .:-=+*#%@'],
    ['Default', ' .*:o&8#@'],
    ['Blocks', ' ░▒▓█'],
    ['Dots', ' ·•●'],
    ['Binary', ' 01'],
    ['Hex', ' 0123456789ABCDEF'],
];
