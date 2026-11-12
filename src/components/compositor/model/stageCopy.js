// Copying clips. A clip of an empty 3D stage copies its whole stage: the
// pasted clip plays a new stage of its own, with a new scene holding new
// objects made the same as the old ones, so changing one leaves the other
// alone. Any other clip pastes as another clip of the same media (a take's
// scene is the take's, wherever it plays).
//
// Splines in the copy get symbols nothing else has, and the copy's own
// expressions are rewritten to read them, so its equations follow its own
// splines. Variables are global: the copy reads the same ones, and a paste
// into another project brings along any it lacks.

import { newId } from './project';
import { firstFit } from './timeline';
import { splineSymbol, variableKey } from './globals';
import { SPLINE_LETTERS, renameSymbols, renameInTemplate } from './expr';

export const CLIP_COPY_FORMAT = 'compositor-clip';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** What goes on the clipboard for clip `clipId`, or null. */
export function copyClip(project, clipId) {
    const clip = project.clips.find((c) => c.id === clipId);
    const media = clip && project.media.find((m) => m.id === clip.mediaId);
    if (!clip || !media) return null;
    const out = { format: CLIP_COPY_FORMAT, version: 1, clip: clone(clip), media: { ...clone(media), duration: null } };
    if (media.kind === 'stage') {
        const scene = project.scenes.find((s) => s.id === media.sceneId);
        if (!scene) return null;
        out.stage = {
            scene: clone(scene),
            objects: clone(project.objects.filter((o) => o.sceneId === scene.id)),
            variables: clone(project.variables || []),
        };
    }
    return out;
}

/** `obj` with the spline letters in `map` renamed wherever its expressions say them. */
function renameIn(obj, map) {
    const p = obj.params || {};
    const r = (v) => (typeof v === 'string' ? renameSymbols(v, map) : v);
    const params = { ...p };
    if (obj.type === 'equation') ['fx', 'fy', 'fz', 'rangeFrom', 'rangeTo'].forEach((k) => { params[k] = r(p[k]); });
    if (obj.type === 'spline') {
        if (Array.isArray(p.points)) params.points = p.points.map((pt) => (Array.isArray(pt) ? pt.map(r) : pt));
        if (p.clamp) {
            params.clamp = Object.fromEntries(Object.entries(p.clamp).map(([side, orders]) => [side, Object.fromEntries(
                Object.entries(orders || {}).map(([n, v]) => [n, Array.isArray(v) ? v.map(r) : v]),
            )]));
        }
    }
    if ((obj.type === 'text' || obj.type === 'splinePoint') && typeof p.text === 'string') params.text = renameInTemplate(p.text, map);
    return { ...obj, params };
}

/**
 * `project` with the clipboard's clip pasted at time `at` (on its own track
 * if that track is here, else the lowest video track it fits). Returns
 * `{ project, clip, scene }`, or null for a payload that can't go here.
 */
export function pasteClip(project, payload, at) {
    if (!payload || payload.format !== CLIP_COPY_FORMAT || !payload.clip) return null;
    const src = payload.clip;
    let { media } = payload;
    let next = project;
    let scene = null;
    let camera = src.camera;
    if (payload.stage) {
        // A new stage, scene and objects.
        const { stage } = payload;
        scene = { ...stage.scene, id: newId('scn'), name: `${stage.scene.name} copy` };
        media = { ...media, id: newId('med'), name: `${media.name} copy`, sceneId: scene.id, duration: Infinity };
        const ids = new Map(stage.objects.map((o) => [o.id, newId(o.type)]));
        const ctrlIds = new Set(project.controllers.map((c) => c.id));
        // Fresh spline letters: none a spline or variable here already has.
        const taken = new Set([
            ...project.objects.filter((o) => o.type === 'spline').map(splineSymbol),
            ...(project.variables || []).map((v) => v.symbol),
        ]);
        const letters = {};
        stage.objects.filter((o) => o.type === 'spline').forEach((o) => {
            const s = splineSymbol(o);
            if (letters[s]) return;
            const free = SPLINE_LETTERS.find(([c]) => !taken.has(c));
            letters[s] = free ? free[0] : s;
            taken.add(letters[s]);
        });
        const objects = stage.objects.map((o) => {
            let obj = {
                ...o,
                id: ids.get(o.id),
                sceneId: scene.id,
                ...(o.parentId ? { parentId: ids.get(o.parentId) } : {}),
                links: Object.fromEntries(Object.entries(o.links || {}).filter(([, l]) => ctrlIds.has(l.controller))),
            };
            if (obj.type === 'spline') obj.params = { ...obj.params, symbol: letters[splineSymbol(o)] };
            obj = renameIn(obj, letters);
            return obj;
        });
        if (camera && camera !== 'solve') camera = ids.get(camera);
        // Variables the copy reads that this project lacks.
        const have = new Set((project.variables || []).map(variableKey));
        const variables = (stage.variables || []).filter((v) => !have.has(variableKey(v))).map((v) => ({
            ...v,
            id: newId('var'),
            links: Object.fromEntries(Object.entries(v.links || {}).filter(([, l]) => ctrlIds.has(l.controller))),
        }));
        next = {
            ...project,
            scenes: [...project.scenes, scene],
            objects: [...project.objects, ...objects],
            media: [...project.media, media],
            variables: [...(project.variables || []), ...variables],
        };
    } else {
        // Another clip of media this project has.
        media = project.media.find((m) => m.id === src.mediaId);
        if (!media) return null;
        if (camera && camera !== 'solve' && !project.objects.some((o) => o.id === camera)) camera = undefined;
    }
    const kind = media.kind === 'audio' ? 'audio' : 'video';
    const dur = src.dur;
    let track = next.tracks.find((t) => t.id === src.trackId && t.kind === kind);
    if (!track) {
        const cands = next.tracks.filter((t) => t.kind === kind);
        const order = kind === 'video' ? [...cands].reverse() : cands;
        track = order.find((t) => firstFit(next, t.id, at, dur) === at) || order[0];
    }
    if (!track) return null;
    const clip = {
        ...clone(src),
        id: newId('clp'),
        trackId: track.id,
        mediaId: media.id,
        start: firstFit(next, track.id, at, dur),
        camera,
    };
    if (clip.camera === undefined) delete clip.camera;
    return { project: { ...next, clips: [...next.clips, clip] }, clip, scene };
}
