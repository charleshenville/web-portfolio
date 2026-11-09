// Quad Trees presets. Under `npm start` they are files in the repo's
// quadtree-presets/ (src/setupProxy.js writes them; gitignored); a preset can
// always be downloaded or opened as a file too, which is all a deployed build
// can do. A preset is the tool's settings and nothing else: no seed image,
// video or scene, so in the compositor the picture being processed is the seed.

import { DEFAULTS } from './settings';

const ROUTE = '/__quadtree/presets';
export const PRESET_FORMAT = 'quadtree-preset';

/** Saved presets ({ name, updated }), or null where there is no dev server. */
export async function listPresets() {
    try {
        const r = await fetch(ROUTE, { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
        const list = await r.json();
        return Array.isArray(list) ? list : null;
    } catch (e) {
        return null;
    }
}

/** Only the keys the tool knows, so an old or foreign file can't add junk. */
export function cleanSettings(settings) {
    const out = {};
    Object.keys(DEFAULTS).forEach((k) => {
        if (settings && settings[k] !== undefined) out[k] = settings[k];
    });
    return out;
}

export function parsePreset(text) {
    const data = JSON.parse(text);
    if (!data || data.format !== PRESET_FORMAT || !data.settings) throw new Error('Not a Quad Trees preset.');
    return { name: data.name || 'preset', settings: { ...DEFAULTS, ...cleanSettings(data.settings) } };
}

export async function loadPreset(name) {
    const r = await fetch(`${ROUTE}/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Could not open ${name} (${r.status})`);
    return parsePreset(await r.text());
}

const serialize = (name, settings) => JSON.stringify({
    format: PRESET_FORMAT, version: 1, name, settings: cleanSettings(settings),
}, null, 2);

/** Write to the repo. Resolves to the path written, or throws. */
export async function savePreset(name, settings) {
    const r = await fetch(`${ROUTE}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: serialize(name, settings),
    });
    if (!r.ok) throw new Error(`Save failed (${r.status})`);
    return (await r.json()).path;
}

export async function deletePreset(name) {
    const r = await fetch(`${ROUTE}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`Delete failed (${r.status})`);
}

export function downloadPreset(name, settings) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([serialize(name, settings)], { type: 'application/json' }));
    a.download = `${(name || 'preset').replace(/[^a-zA-Z0-9 _.-]+/g, '-')}.quadtree.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function readPresetFile(file) {
    return parsePreset(await file.text());
}
