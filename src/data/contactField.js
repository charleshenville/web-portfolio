// Settings for the contact page's masthead field. Keys are the
// ProceduralAscii tool's settings (/vfx/procedural): tune it there, press
// "Copy Settings" and paste the result over this object. Anything left out
// uses the tool's defaults. `rate` is the tool's playback "Speed x". Only the
// pixel style is drawn.
//
// The fluid solver rather than the footer's fractal noise: this is the one
// place on the site that runs it, and the eddies rolling under the title are
// the point. Two things keep it affordable: `render: 'vorticity'` (the curl
// of the flow, absolute value) skips the particles, the trail buffer and the
// supersampling that 'trails' pays for, and the solver runs on a 64 cell
// grid, which measured ~2.7 ms a frame against ~14 ms at the tool's 128 —
// and looks better here anyway, with larger, calmer eddies and the dither
// texture left visible on top of them.
//
// `grid` is a spectral grid and must be a power of two, like the tool's
// 64 / 128 / 256 buttons: anything else hands the FFT a size it cannot
// factor and the whole field comes back NaN, which draws as a flat band.
//
// The flow is only worth anything once it has been stirred, so nothing shows
// for the first second or so after the page loads, while `warmup` sim
// seconds are run off in 14 ms slices.
//
// ProceduralField gives the solver a virtual view at least `viewAspect` tall
// and shows a slice through its middle, so the flow forms proper eddies
// instead of being squashed into the band.

const contactField = {
    mode: 'fluid',
    style: 'pixels',
    pixelSize: 16,             // device px per cell; smaller = finer, costlier
    seed: 6,

    // flow
    grid: 64,                  // solver resolution; powers of two only
    simSpeed: 0.5,             // sim time per second of playback
    viscosity: 0.0006,         // higher = thicker, smoother, fewer small eddies
    drag: 0.12,
    force: 2.6,                // strength of the stirring
    forceK: 4,                 // size of the stirring, in domain waves
    forceTau: 2.5,             // seconds before the stirring rearranges itself
    warmup: 3,                 // sim seconds run before the first frame

    render: 'vorticity',       // 'trails' | 'vorticity' | 'speed'
    exposure: 1,
    flowScale: 1,

    // tone & dither
    contrast: 1.15,
    brightness: -0.05,         // holds the quiet water down at paper black
    gamma: 2.3,                // high: blue only where the flow really turns
    dither: 'bayer',
    levels: 20,

    // colour: paper, through the accent, to ink
    background: '#0c0c0c',
    colorMode: 'gradient',
    stops: ['#0c0c0c', '#0000ff', '#ecebe6'],
    reverseGradient: false,

    rate: 1,
};

export default contactField;
