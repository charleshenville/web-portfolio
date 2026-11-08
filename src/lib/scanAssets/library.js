// The Compositor's asset library: the GLBs that can be placed in a take
// (props, screens and rigs), how big each arrives, and - for screens - where
// on the model the screen surface is.
//
// The canonical copy is src/data/scanAssetLibrary.json, bundled into the
// build. Editing in the tool saves three ways, best first:
//   1. Under `npm start`, straight back into that JSON through the dev server
//      (src/setupProxy.js), so the change is in the repo and ships.
//   2. Always, into this browser's storage, so it survives a reload or
//      relaunch even where nothing can write the file (the published site).
//   3. On request, as a download of the whole JSON, to drop over the file by
//      hand.
// On load, whichever of the bundled file and this browser's copy is newer
// wins, asset by asset.

import bundled from '../../data/scanAssetLibrary.json';

// Saving rewrites the JSON this module imports. Accepting the update here
// keeps webpack from hot-refreshing the whole compositor (which would tear
// down its renderer and reload the take) every time a screen is adjusted.
if (module.hot) module.hot.accept('../../data/scanAssetLibrary.json');

export const ASSET_BASE = `${process.env.PUBLIC_URL}/mv/assets`;
const STORAGE_KEY = 'scan-compositor:asset-library';
const ENDPOINT = '/__scan-compositor/library';

export const CATEGORIES = [
    { id: 'prop', name: 'Prop' },
    { id: 'screen', name: 'Screen' },
];

/** Rigged assets have their own model classes rather than a library entry. */
export const RIGS = [
    {
        id: 'sackboy',
        name: 'Sackboy',
        file: 'sackboy.glb',
        credit: '"Sackboy" by SidewalkNZ, CC BY 4.0 (sketchfab.com/3d-models/sackboy-6324ad7d51074fb1bb559dd63a16920b)',
    },
];

export const DEFAULT_SCREEN = {
    // Corners in the GLB's own space: top-left, top-right, bottom-right,
    // bottom-left as the picture should read.
    corners: [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, -0.5, 0], [-0.5, -0.5, 0]],
    // Pushed this far off the surface (GLB units) so it cannot z-fight.
    lift: 0.002,
    fit: 'cover',
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function readLocal() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : null;
        return data && data.version === 1 && Array.isArray(data.assets) ? data : null;
    } catch (e) {
        return null;
    }
}

/** The library this browser should use: the bundled file, with any newer local edits on top. */
export function loadLibrary() {
    const base = clone(bundled);
    const local = readLocal();
    if (!local) return base;
    const byId = new Map(base.assets.map((a) => [a.id, a]));
    local.assets.forEach((a) => {
        const b = byId.get(a.id);
        // Only assets the build actually ships a file for.
        if (!b) return;
        if ((a.updatedAt || 0) > (b.updatedAt || 0)) byId.set(a.id, { ...b, ...a });
    });
    return { ...base, assets: base.assets.map((a) => byId.get(a.id)) };
}

export function libraryJson(library) {
    // Short lists of numbers (a corner) stay on one line, so the file reads
    // like it was written by hand and a corner edit is a one-line diff.
    const text = JSON.stringify(library, null, 2)
        .replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+){1,3})\s+\]/g, (m, inner) => `[${inner.split(/,\s+/).join(', ')}]`);
    return `${text}\n`;
}

/**
 * Persist the library. Resolves to where it ended up: 'repo' when the dev
 * server wrote it into src/data, 'browser' when only this browser has it.
 */
export async function saveLibrary(library) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
    } catch (e) { /* storage full or blocked; the file write may still work */ }
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: libraryJson(library),
        });
        if (res.ok) return 'repo';
    } catch (e) { /* no dev server here */ }
    return 'browser';
}

export function downloadLibrary(library) {
    const blob = new Blob([libraryJson(library)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scanAssetLibrary.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A copy of `library` with one asset changed, stamped so it wins over older copies. */
export function patchAsset(library, id, fn) {
    return {
        ...library,
        assets: library.assets.map((a) => (a.id === id ? { ...fn(a), updatedAt: Date.now() } : a)),
    };
}
