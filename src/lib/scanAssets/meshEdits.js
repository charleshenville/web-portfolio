// Where the scans' mesh edits are kept (holes filled, junk cut away: see
// components/compositor/model/meshEdits.js). They belong to the scan, not to
// a project, so like the scan colour corrections they are saved apart:
//   1. Under `npm start`, into src/data/meshEdits.json through the dev
//      server (src/setupProxy.js), so they are in the repo and ship.
//   2. Always, into this browser's storage, as a fallback.
// On load, per scan, whichever is newer wins.
//
// Keyed by the scan's fingerprint, so takes that share a scan share its
// edits: { [fingerprint]: { takes, updatedAt, add, remove, verts, moved } }.

import bundled from '../../data/meshEdits.json';
import {
    normaliseEdits, serialiseEdits, isEmptyEdits,
} from '../../components/compositor/model/meshEdits';

// Saving rewrites the JSON this module imports; accepting the update here
// keeps webpack from reloading the compositor on every edit.
if (module.hot) module.hot.accept('../../data/meshEdits.json');

const STORAGE_KEY = 'compositor:mesh-edits';
const ENDPOINT = '/__compositor/mesh-edits';

const entry = (raw) => ({
    takes: Array.isArray(raw?.takes) ? raw.takes.filter((t) => typeof t === 'string') : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    doc: normaliseEdits(raw),
});

function readLocal() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : null;
        return data && typeof data === 'object' ? data : null;
    } catch (e) {
        return null;
    }
}

/** Every scan's edits, { [fingerprint]: { takes, updatedAt, doc } }: the repo's, with newer ones from this browser on top. */
export function loadMeshEdits() {
    const out = {};
    Object.entries(bundled || {}).forEach(([fp, raw]) => { out[fp] = entry(raw); });
    Object.entries(readLocal() || {}).forEach(([fp, raw]) => {
        const e = entry(raw);
        if (!out[fp] || e.updatedAt > out[fp].updatedAt) out[fp] = e;
    });
    return out;
}

const tidy = (all) => {
    const keep = {};
    Object.keys(all).sort().forEach((fp) => {
        const e = all[fp];
        if (!e || isEmptyEdits(e.doc)) return;
        keep[fp] = { takes: [...e.takes].sort(), updatedAt: e.updatedAt, ...serialiseEdits(e.doc) };
    });
    return keep;
};

/** Persist every scan's edits. Resolves to 'repo' or 'browser'. */
export async function saveMeshEdits(all) {
    const data = tidy(all);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage blocked or full */ }
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (res.ok) return 'repo';
    } catch (e) { /* no dev server here */ }
    return 'browser';
}
