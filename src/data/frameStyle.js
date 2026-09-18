// ---- Procedural surfaces ------------------------------------------------------
// Every framed image / video / specimen on the site reads its look from
// FRAME_STYLE (+ FRAME_VARIANTS). The home page hero field is HERO_FIELD below.
//
// Motion is controlled by `speed` (a multiplier on time for everything:
// 1 = normal, 0.5 = half speed, 0 = frozen), then `evolve` (how fast the
// pattern morphs) and `driftX` / `driftY` (how fast it scrolls).
// `persistent: true` keeps a surface visible and animating without hover.
//
// Edit FRAME_STYLE to change all frames, or add a variant below and use it
// with <Frame variant="name">. One-off tweaks can also be passed straight to a
// frame: <Frame palette={[...]} cell={4}>.

export const FRAME_STYLE = {
    // Colours, from low noise values to high. `null` is transparent (the
    // media shows through). Any CSS colour works, including var(--token).
    // The number of entries is the number of levels.
    palette: [null, 'var(--accent)'],

    // How values are snapped to the palette:
    //   'bayer'  8x8 ordered dither (regular, print-like crosshatch)
    //   'noise'  white-noise dither (grainy, stable per pixel)
    //   'none'   hard bands, no dithering
    dither: 'bayer',

    // Pixel grid
    cell: 4,               // css px per noise pixel
    bleed: 0,              // px the effect extends outside the media

    // Hover behaviour
    persistent: true,     // true: always shown and animating; false: on hover
    fadeIn: 100,           // ms
    fadeOut: 100,          // ms
    fps: 20,               // animation frame cap while hovered
    speed: 0.15,           // time multiplier for all motion (1 = normal)

    // Noise simulation (fractal Perlin, same as the Procedural VFX tool)
    fractal: 'fbm',        // 'fbm' | 'turbulence' | 'ridged'
    scale: 100,              // feature size, in pixels (cells)
    octaves: 4,
    evolve: 0.1,           // how fast the pattern morphs
    loop: 10,              // seconds before the morph loops
    driftX: 0,           // scroll speed, noise units / second
    driftY: 0,
    contrast: 2,         // > 1 pushes values towards the ends of the palette
    density: -0.5,            // + fills more, - fills less (everywhere)
    seed: 21,

    // Spill shape: strong at the edges, fading towards the middle
    spread: 0.5,           // edge band, as a fraction of the short side
    centre: 0,          // noise strength left in the middle (0..1)
    bias: 5,            // how hard the middle is pulled to the first colour

};

// Named presets layered on top of FRAME_STYLE.
export const FRAME_VARIANTS = {
    // large featured project tiles
    project: { cell: 2, persistent: false },
    // small thumbnails in the home page gallery
    gallery: { cell: 3, persistent: false },
};

// Home page hero: the large interactive ascii field under the header.
export const HERO_FIELD = {
    persistent: true,      // true: always animating; false: only while hovered
    speed: 0.75,            // time multiplier for all motion (1 = normal)
    fps: 20,

    // look
    cell: 9,               // css px per character column
    ramp: ' .·:-=+*#%@',   // glyphs from empty to dense
    accentAt: 0.9,         // values above this are drawn in the accent colour

    // noise simulation
    fractal: 'ridged',     // 'fbm' | 'turbulence' | 'ridged'
    scale: 25,
    octaves: 4,
    evolve: 0.25,
    loop: 30,
    driftX: 0.1,
    driftY: -0.05,
    contrast: 1.1,
    density: -0.3,
    seed: 3,

    // pointer glow
    glow: 0.55,            // brightening under the cursor (0 = off)
    glowRadius: 80,       // px

    // Click ripple: a ring travelling out from wherever the field is clicked.
    // `ripple` is added straight to the noise, so it is read against `density`
    // and `accentAt` above: at 0.7 the crest rides the top of the glyph ramp
    // and only tips into the accent where the noise was already bright. Push it
    // past ~0.85 and the whole crest goes accent, which reads as a blue splash
    // rather than a wave.
    ripple: 0.7,           // height of the ring (0 = off)
    rippleSpeed: 200,      // px/s it travels outwards
    rippleWidth: 100,       // px from the crest to the trough behind it
    rippleDecay: 1.3,      // seconds for it to fade to about a third
};
