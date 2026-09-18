// Site map shared by the menu, the VFX index and the router.

export const VFX_TOOLS = [
    {
        slug: 'blob-tracker',
        label: 'Blob Tracker',
        blurb: 'Detects and links moving regions in video, then exports the overlay.',
    },
    {
        slug: 'pixel-sorter',
        label: 'Pixel Sorter',
        blurb: 'Threshold-masked pixel sorting for stills and video.',
    },
    {
        slug: 'procedural',
        label: 'Procedural Art',
        blurb: 'Fractal Perlin noise and fluid flow as ascii or pixels.',
    },
    {
        slug: 'ascii',
        label: 'ASCII Renderer',
        blurb: 'Lit 3D models (glTF / SVG) rasterised to live ascii.',
    },
    {
        slug: 'visualizer',
        label: 'Audio Visualizer',
        blurb: 'Audio-reactive point clouds, curves and post effects.',
    },
];

export const NAV = [
    { label: 'Index', to: '/' },
    { label: 'Projects', to: '/projects' },
    { label: 'Music', to: '/music' },
    {
        label: 'VFX',
        to: '/vfx',
        children: VFX_TOOLS.map((t) => ({ label: t.label, to: `/vfx/${t.slug}` })),
    },
    { label: 'Resume', to: '/resume' },
    { label: 'Contact', to: '/contact' },
    { label: 'Source', href: 'https://github.com/charleshenville/web-portfolio' },
];

export const SITE_VERSION = 'v2.0.0';
