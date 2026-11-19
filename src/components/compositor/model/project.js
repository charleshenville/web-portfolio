// A compositor project: everything a session knows, as one JSON document.
//
//   media        what clips play: takes (footage + solve + scan, by take id),
//                plain videos and audio (by link: a public path, an upload
//                kept in this browser, or a URL), and empty 3D stages
//   tracks       video tracks (top first) and audio tracks, each with its
//                own linkable visibility / opacity / gain
//   clips        media placed on a track: start, in point, length, rate, loop
//   scenes       one per take used (in that take's scan frame), plus stages
//   objects      everything in a scene (and effects, which have no scene),
//                each with its parameters and its controller links
//   controllers  kick / band / LFO / keyframes / switch
//   variables    named numbers expressions read (θ, ω_1), each with its own
//                linkable value (model/globals.js)
//   tempo        the project's BPM, which every tempo field follows until it
//                is given its own (model/tempo.js)
//
// Files that point at media this machine does not have still open; the
// missing media is flagged and can be relocated.

import { defaultParams, OBJECT_TYPES, PULSE_KEYS } from './schema';
import { stockControllers, makeController, CONTROLLER_TYPES, defaultsFor } from './controllers';
import { DEFAULT_TEMPO, projectTempo } from './tempo';

export const PROJECT_FORMAT = 'compositor-project';
export const PROJECT_VERSION = 1;

let counter = 0;
export const newId = (prefix = 'o') => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// The objects a take's scene always has, in outliner order.
export const TAKE_OBJECTS = [
    ['take', 'Take'],
    ['footage', 'Footage'],
    ['scanPoints', 'Points'],
    ['scanMesh', 'Mesh'],
    ['scanWire', 'Wireframe'],
    ['sun', 'Sun'],
];

export function makeObject(type, sceneId, over = {}) {
    return {
        id: newId(type),
        type,
        name: OBJECT_TYPES[type]?.label || type,
        sceneId,
        params: { ...defaultParams(type), ...(over.params || {}) },
        links: {},
        gizmo: true,
        ...(over.extra ? { extra: over.extra } : {}),
        ...Object.fromEntries(Object.entries(over).filter(([k]) => !['params', 'extra'].includes(k))),
    };
}

export function createProject(name = 'Untitled') {
    return {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        name,
        output: { width: 1440, height: 1080, fps: 30, auto: true },
        tempo: DEFAULT_TEMPO,
        media: [],
        tracks: [
            { id: newId('trk'), kind: 'video', name: 'V2', params: { visible: true, opacity: 1 }, links: {} },
            { id: newId('trk'), kind: 'video', name: 'V1', params: { visible: true, opacity: 1 }, links: {} },
            { id: newId('trk'), kind: 'audio', name: 'A1', params: { visible: true, gain: 1 }, links: {} },
        ],
        clips: [],
        scenes: [],
        objects: [],
        controllers: stockControllers(() => newId('ctl')),
        variables: [],
    };
}

/** The scene for a take, with its standing objects; made if it is missing. */
export function ensureTakeScene(project, takeId, label) {
    const found = project.scenes.find((s) => s.take === takeId);
    if (found) return { project, scene: found };
    const scene = { id: newId('scn'), name: label || takeId, take: takeId };
    const objects = TAKE_OBJECTS.map(([type, name]) => makeObject(type, scene.id, { name }));
    // A fresh take reads as the plain solve: footage on, scan layers off.
    return {
        project: { ...project, scenes: [...project.scenes, scene], objects: [...project.objects, ...objects] },
        scene,
    };
}

export function addStageScene(project, name = 'Stage') {
    const scene = { id: newId('scn'), name, take: null };
    const objects = [
        makeObject('stage', scene.id, { name: 'Stage' }),
        makeObject('sun', scene.id, { name: 'Sun' }),
        makeObject('camera', scene.id, { name: 'Camera' }),
    ];
    const media = { id: newId('med'), kind: 'stage', name, sceneId: scene.id, duration: Infinity };
    return {
        project: {
            ...project,
            scenes: [...project.scenes, scene],
            objects: [...project.objects, ...objects],
            media: [...project.media, media],
        },
        scene,
        media,
    };
}

export function takeMedia(project, takeId, label, duration) {
    const found = project.media.find((m) => m.kind === 'take' && m.src?.take === takeId);
    if (found) return { project, media: found };
    const media = { id: newId('med'), kind: 'take', name: label || takeId, src: { type: 'take', take: takeId }, duration };
    return { project: { ...project, media: [...project.media, media] }, media };
}

/**
 * Scenes live only as long as their media: a take's scene while the take is
 * in the media bin, a stage's while the stage is. Anything else is dropped
 * with its objects, and clips stop pointing at cameras that went with them.
 */
export function pruneScenes(project) {
    const takes = new Set(project.media.filter((m) => m.kind === 'take').map((m) => m.src?.take));
    const stages = new Set(project.media.filter((m) => m.kind === 'stage').map((m) => m.sceneId));
    const keep = project.scenes.filter((sc) => (sc.take ? takes.has(sc.take) : stages.has(sc.id)));
    if (keep.length === project.scenes.length) return project;
    const ids = new Set(keep.map((sc) => sc.id));
    const objects = project.objects.filter((o) => !o.sceneId || ids.has(o.sceneId));
    const alive = new Set(objects.map((o) => o.id));
    return {
        ...project,
        scenes: keep,
        objects,
        clips: project.clips.map((c) => (c.camera && c.camera !== 'solve' && !alive.has(c.camera) ? { ...c, camera: undefined } : c)),
    };
}

/** The media a scene lives by: its take's, or its stage's. */
export function sceneMedia(project, scene) {
    return project.media.filter((m) => (scene.take ? m.kind === 'take' && m.src?.take === scene.take : m.kind === 'stage' && m.sceneId === scene.id));
}

/** Scenes no clip on the timeline plays. */
export function unusedScenes(project) {
    const used = new Set(project.clips.map((c) => c.mediaId));
    return project.scenes.filter((sc) => !sceneMedia(project, sc).some((m) => used.has(m.id)));
}

/** `project` without scenes `ids`: their media, clips and objects go with them. */
export function removeScenes(project, ids) {
    const gone = new Set(project.scenes.filter((sc) => ids.includes(sc.id)).flatMap((sc) => sceneMedia(project, sc).map((m) => m.id)));
    if (!gone.size) return project;
    return pruneScenes({
        ...project,
        media: project.media.filter((m) => !gone.has(m.id)),
        clips: project.clips.filter((c) => !gone.has(c.mediaId)),
    });
}

// ---- Files -------------------------------------------------------------------

const finite = (v, d) => (Number.isFinite(v) ? v : d);

export function serializeProject(project) {
    const out = {
        ...project,
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        savedAt: new Date().toISOString(),
        // Infinity does not survive JSON; a stage's length is open-ended.
        media: project.media.map((m) => ({ ...m, duration: Number.isFinite(m.duration) ? m.duration : null })),
    };
    return JSON.stringify(out, null, 2);
}

/**
 * A Sun's softness was in shadow-map texels, so it changed with whatever
 * cast a shadow; it is now centimetres in the scene. Older files convert
 * once, at about 2.5 mm a texel (what a typical scene's texels were).
 */
export function migrateSun(o) {
    if (o.type !== 'sun' || !o.params || o.params.shadowSoftUnits) return o;
    const k = 0.25;
    const params = { ...o.params, shadowSoftUnits: 'cm' };
    if (Number.isFinite(params.shadowSoftness)) params.shadowSoftness = Math.round(params.shadowSoftness * k * 100) / 100;
    const links = { ...(o.links || {}) };
    const l = links.shadowSoftness;
    if (l) links.shadowSoftness = { ...l, from: (l.from ?? 0) * k, to: (l.to ?? 1) * k };
    return { ...o, params, links };
}

/** `project` with its Suns' softness in centimetres; the same project if they already are. */
export function migrateSuns(project) {
    let changed = false;
    const objects = project.objects.map((o) => {
        const m = migrateSun(o);
        if (m !== o) changed = true;
        return m;
    });
    return changed ? { ...project, objects } : project;
}

const OVERLAY_KEYS = ['overscale', 'overlayX', 'overlayY', 'overlayZ'];

/**
 * The points and the wireframe were swollen and slid together by their
 * Take's Overlays, and the wireframe pulsed from the points' pulse. Each has
 * its own of both now: older objects take what they had then (values and
 * links), so nothing moves. The same objects back when there is nothing to do.
 */
export function migrateOverlays(objects) {
    const linksOf = (o, keys) => Object.fromEntries(Object.entries(o?.links || {}).filter(([k]) => keys.includes(k)));
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.params && k in o.params).map((k) => [k, o.params[k]]));
    let changed = false;
    const bySceneType = (sceneId, type) => objects.find((x) => x?.sceneId === sceneId && x.type === type);
    const out = objects.map((o) => {
        if (!o?.params) return o;
        if (o.type === 'take' && OVERLAY_KEYS.some((k) => k in o.params || o.links?.[k])) {
            changed = true;
            const params = { ...o.params };
            OVERLAY_KEYS.forEach((k) => { delete params[k]; });
            const links = Object.fromEntries(Object.entries(o.links || {}).filter(([k]) => !OVERLAY_KEYS.includes(k)));
            return { ...o, params, links };
        }
        if (o.type !== 'scanPoints' && o.type !== 'scanWire') return o;
        let params = o.params;
        let links = o.links || {};
        const take = bySceneType(o.sceneId, 'take');
        if (!OVERLAY_KEYS.some((k) => k in params) && take) {
            params = { ...params, ...pick(take, OVERLAY_KEYS) };
            links = { ...links, ...linksOf(take, OVERLAY_KEYS) };
        }
        const points = o.type === 'scanWire' && !('pulseMode' in params) ? bySceneType(o.sceneId, 'scanPoints') : null;
        if (points) {
            params = { ...params, ...pick(points, PULSE_KEYS) };
            links = { ...links, ...linksOf(points, PULSE_KEYS) };
        }
        if (params === o.params && links === (o.links || {})) return o;
        changed = true;
        return { ...o, params, links };
    });
    return changed ? out : objects;
}

/** `project` with its points' and wireframes' own Placement and pulse (migrateOverlays). */
export function migrateProjectOverlays(project) {
    const objects = migrateOverlays(project.objects);
    return objects === project.objects ? project : { ...project, objects };
}

// A window's "Size over time" (eased from a start to an end size between two
// times) gave way to its transform, which controllers drive.
const OLD_SIZE_KEYS = ['sizeOn', 'sizeClock', 'sizeFrom', 'sizeTo', 'startW', 'startH', 'endW', 'endH', 'sizeEase'];

/** A window (or Blob Tracker) saved with the old size settings, without them: one that animated keeps its end size. */
export function migrateWindowSize(o) {
    if (!o.params || !OLD_SIZE_KEYS.some((k) => k in o.params)) return o;
    const params = { ...o.params };
    if (o.type === 'window' && params.sizeOn) {
        params.winW = Number.isFinite(params.endW) ? params.endW : 1;
        params.winH = Number.isFinite(params.endH) ? params.endH : 1;
    }
    OLD_SIZE_KEYS.forEach((k) => { delete params[k]; });
    const links = o.links && Object.fromEntries(Object.entries(o.links).filter(([k]) => !OLD_SIZE_KEYS.includes(k)));
    return { ...o, params, ...(links ? { links } : {}) };
}

/**
 * A file from before the project had a tempo: it gets 120, and the tempo
 * fields left at their old defaults follow it, where that changes nothing
 * that plays (a tempo LFO at 120; a nod at 96 that is off). A nod that is on
 * at 96, or any tempo set by hand, keeps its own.
 */
export function migrateTempo(data) {
    if (!data || data.tempo !== undefined) return data;
    const objects = (data.objects || []).map((o) => {
        if (!o?.params || !['protagonist', 'sackboy', 'cat'].includes(o.type)) return o;
        const p = o.params;
        if (p.bpm === undefined || (p.bpm === 96 && !p.nodOn)) return { ...o, params: { ...p, bpm: null } };
        return o;
    });
    const controllers = (data.controllers || []).map((c) => {
        if (c?.type !== 'lfo' || !c.params) return c;
        if (c.params.bpm === undefined || c.params.bpm === 120) return { ...c, params: { ...c.params, bpm: null } };
        return c;
    });
    return { ...data, tempo: DEFAULT_TEMPO, objects, controllers };
}

/** A project read back from a file, with anything missing filled in. Throws on a file that is not one. */
export function parseProject(text) {
    const raw = typeof text === 'string' ? JSON.parse(text) : text;
    if (!raw || raw.format !== PROJECT_FORMAT) throw new Error('not a compositor project');
    if (raw.version > PROJECT_VERSION) throw new Error(`made by a newer version (v${raw.version})`);
    const data = migrateTempo(raw);
    const base = createProject(data.name || 'Untitled');
    const objects = migrateOverlays((data.objects || []).filter((o) => o && OBJECT_TYPES[o.type])).map(migrateSun).map(migrateWindowSize).map((o) => ({
        ...o,
        params: { ...defaultParams(o.type), ...(o.params || {}) },
        links: o.links || {},
        gizmo: o.gizmo !== false,
    }));
    const controllers = (data.controllers || []).filter((c) => c && CONTROLLER_TYPES[c.type]).map((c) => makeController(c.id, c.type, {
        ...c, params: { ...defaultsFor(c.type), ...(c.params || {}) },
    }));
    // Stages made before they had settings of their own get them.
    (data.scenes || []).forEach((sc) => {
        if (!sc.take && !objects.some((o) => o.sceneId === sc.id && o.type === 'stage')) {
            const i = objects.findIndex((o) => o.sceneId === sc.id);
            objects.splice(Math.max(0, i), 0, makeObject('stage', sc.id, { name: 'Stage' }));
        }
    });
    return pruneScenes({
        ...base,
        ...data,
        output: { ...base.output, ...(data.output || {}) },
        tempo: projectTempo(data),
        media: (data.media || []).map((m) => ({ ...m, duration: m.kind === 'stage' ? Infinity : finite(m.duration, 0) })),
        tracks: (data.tracks || base.tracks).map((t) => ({ params: {}, links: {}, ...t })),
        clips: (data.clips || []).map((c) => ({ rate: 1, loop: 'off', in: 0, ...c })),
        scenes: data.scenes || [],
        objects,
        controllers,
        variables: (data.variables || []).filter((v) => v && v.symbol).map((v) => ({
            sub: '', set: 'real', min: -10, max: 10, step: 0.01, ...v, params: { value: 0, ...(v.params || {}) }, links: v.links || {},
        })),
    });
}

/** Every link in the project that points at a controller, for its usage list. */
export function linksTo(project, controllerId) {
    const out = [];
    project.objects.forEach((o) => Object.entries(o.links || {}).forEach(([key, l]) => {
        if (l.controller === controllerId) out.push({ owner: o, key });
    }));
    project.tracks.forEach((t) => Object.entries(t.links || {}).forEach(([key, l]) => {
        if (l.controller === controllerId) out.push({ owner: t, key });
    }));
    (project.variables || []).forEach((v) => Object.entries(v.links || {}).forEach(([key, l]) => {
        if (l.controller === controllerId) out.push({ owner: v, key, variable: true });
    }));
    return out;
}
