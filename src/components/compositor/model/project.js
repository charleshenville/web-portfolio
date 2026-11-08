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
//
// Files that point at media this machine does not have still open; the
// missing media is flagged and can be relocated.

import { defaultParams, OBJECT_TYPES } from './schema';
import { stockControllers, makeController, CONTROLLER_TYPES, defaultsFor } from './controllers';

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

/** A project read back from a file, with anything missing filled in. Throws on a file that is not one. */
export function parseProject(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (!data || data.format !== PROJECT_FORMAT) throw new Error('not a compositor project');
    if (data.version > PROJECT_VERSION) throw new Error(`made by a newer version (v${data.version})`);
    const base = createProject(data.name || 'Untitled');
    const objects = (data.objects || []).filter((o) => o && OBJECT_TYPES[o.type]).map((o) => ({
        ...o,
        params: { ...defaultParams(o.type), ...(o.params || {}) },
        links: o.links || {},
        gizmo: o.gizmo !== false,
    }));
    const controllers = (data.controllers || []).filter((c) => c && CONTROLLER_TYPES[c.type]).map((c) => makeController(c.id, c.type, {
        ...c, params: { ...defaultsFor(c.type), ...(c.params || {}) },
    }));
    return pruneScenes({
        ...base,
        ...data,
        output: { ...base.output, ...(data.output || {}) },
        media: (data.media || []).map((m) => ({ ...m, duration: m.kind === 'stage' ? Infinity : finite(m.duration, 0) })),
        tracks: (data.tracks || base.tracks).map((t) => ({ params: {}, links: {}, ...t })),
        clips: (data.clips || []).map((c) => ({ rate: 1, loop: 'off', in: 0, ...c })),
        scenes: data.scenes || [],
        objects,
        controllers,
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
    return out;
}
