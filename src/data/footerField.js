// Settings for the footer's live field. Keys are the ProceduralAscii tool's
// settings (/vfx/procedural): tune it there, press "Copy Settings" and paste
// the result over this object. Anything left out uses the tool's defaults.
// `rate` is the tool's playback "Speed x". Only the pixel style is drawn.
//
// Fractal noise rather than the fluid sim: no solver, no warm-up and no
// particle advection, and the noise is evaluated on the footer strip itself
// instead of a tall virtual view, which is ~150x less work per frame. The
// noise values below are tuned to match the viscous vorticity look this
// replaced (blob size, brightness spread and drift rate). Setting
// `mode: 'fluid'` and the sim keys back still works.

const footerField = {
    mode: 'perlin',
    style: 'pixels',
    pixelSize: 20,
    seed: 4,

    // noise
    fractal: 'fbm',
    scale: 34,                 // feature size; smaller = more, tighter blobs
    octaves: 2,                // more = more fine detail on top of the blobs
    persistence: 0.5,
    lacunarity: 2,
    warp: 0,
    evolve: 0.12,              // how fast the shapes morph
    driftX: 0.02,              // slow sideways slide
    driftY: 0,
    loopDuration: 35,          // seconds before the morph repeats

    // tone & dither
    contrast: 0.9,
    brightness: 0,
    gamma: 1.9,
    dither: 'none',
    levels: 32,

    // colour
    background: '#0c0c0c',
    colorMode: 'gradient',
    stops: ['#0c0c0c', '#0000ff', '#ecebe6'],
    reverseGradient: false,

    rate: 1,
};

export default footerField;
