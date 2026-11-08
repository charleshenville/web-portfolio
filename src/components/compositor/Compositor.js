// The Compositor: tracked takes, plain video and sound on a timeline; scenes
// of objects over each take; controllers driving any parameter; effects over
// the lot. It replaces the Scan Compositor, the Audio Visualizer and the
// Track Editor.
//
// The project lives in a ref and every change goes through `apply`, which
// keeps an undo history (edits made while dragging fold into one step) and
// bumps a revision to re-render. The engine (engine/Engine.js) draws it; the
// transport (engine/transport.js) keeps time.

import React, {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
    Play, Pause, SkipBack, Eye, Orbit, Pencil, PanelRight, Undo2, Redo2, Save, FolderOpen,
    Download, Upload, FilePlus, Move3d, Rotate3d, Scale3d, Volume2, VolumeX, Repeat,
} from 'lucide-react';
import { Film } from './ui/icons';
import Engine, { cameraPoseAt } from './engine/Engine';
import Logo from '../Logo';
import Transport from './engine/transport';
import {
    mixProject, analyse, importFile, probe, mediaUrl, decodeUrl,
} from './engine/media';
import {
    createProject, ensureTakeScene, addStageScene, takeMedia, makeObject, newId, pruneScenes,
} from './model/project';
import { makeController } from './model/controllers';
import {
    projectDuration, firstFit, clipEnd, is3D, clipSourceTime,
} from './model/timeline';
import { OBJECT_TYPES } from './model/schema';
import {
    listProjects, openProject, saveProject, downloadProject, readProjectFile,
} from './model/storage';
import {
    loadLibrary, saveLibrary, downloadLibrary, patchAsset, DEFAULT_SCREEN,
} from '../../lib/scanAssets/library';
import { MUSIC_ASSETS } from '../../lib/audioScene';
import { loadLooks, saveLooks } from '../../lib/scanAssets/takeLooks';
import { listUploads, storeUpload, PUBLIC_VIDEOS } from '../../lib/scanAssets/screenVideo';
import { makeModelItem } from '../../lib/protagonist/poser';
import { makeSackboyItem } from '../../lib/scanAssets/sackboy';
import { Ctx, makeTicker } from './ui/context';
import Sidebar from './ui/Sidebar';
import Timeline from './ui/Timeline';
import ExportDialog from './ui/ExportDialog';
import styles from './compositor.module.css';

const MANIFEST_URL = `${process.env.PUBLIC_URL}/mv/manifest.json`;
const HISTORY = 120;
const MODES = [
    ['preview', 'Preview', Eye, 'As rendered: the program camera, with effects'],
    ['orbit', 'Orbit', Orbit, 'Free camera with effects: drag to orbit, WASD to fly'],
    ['edit', 'Edit', Pencil, 'Free camera, no post: place and edit objects'],
];

const fmtTime = (t, fps) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const f = Math.floor((t % 1) * fps);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};

export default function Compositor() {
    const projRef = useRef(null);
    if (!projRef.current) projRef.current = createProject();
    const [rev, setRev] = useState(0);
    const history = useRef({ past: [], future: [], coalesce: null, at: 0 });
    const project = projRef.current;

    const [selection, setSelection] = useState(null);
    const [mode, setMode] = useState('preview');
    const [sideOpen, setSideOpen] = useState(true);
    const [takes, setTakes] = useState([]);
    const [status, setStatus] = useState('');
    const [playing, setPlaying] = useState(false);
    const [loop, setLoop] = useState(false);
    const [muted, setMuted] = useState(false);
    const [analysis, setAnalysis] = useState(null);
    // The prop library (sizes, screen corners) is the assets themselves, saved
    // apart from projects into src/data/scanAssetLibrary.json.
    const [library, setLibrary] = useState(loadLibrary);
    const libraryRef = useRef(library);
    const librarySave = useRef(0);
    const [librarySaved, setLibrarySaved] = useState(null);
    const [roto, setRoto] = useState({ on: false, plain: true, take: null });
    // Each take's scan colour correction, saved apart from projects (like the library).
    const [looks, setLooks] = useState(loadLooks);
    const looksRef = useRef(looks);
    const looksSave = useRef(0);
    const [looksSaved, setLooksSaved] = useState(null);
    const [cornerOn, setCornerOn] = useState(null); // object id with corner editing on
    const [cornerHandle, setCornerHandle] = useState(4);
    const [uploads, setUploads] = useState([]);
    const [recordingId, setRecordingId] = useState(null);
    const [gizmoMode, setGizmoMode] = useState('translate');
    const [tlHeight, setTlHeight] = useState(280);
    const [dialog, setDialog] = useState(null); // 'open' | 'export'
    const [repoProjects, setRepoProjects] = useState(null);
    const [, setTick] = useState(0);
    const [audioBuffers, setAudioBuffers] = useState(() => new Map());

    const mountRef = useRef(null);
    const engineRef = useRef(null);
    const transportRef = useRef(null);
    if (!transportRef.current) transportRef.current = new Transport();
    const ticker = useMemo(makeTicker, []);
    const timeReadout = useRef(null);
    const fileRef = useRef(null);
    const projectFileRef = useRef(null);
    const relocateRef = useRef(null);
    const selectionRef = useRef(selection);
    selectionRef.current = selection;

    // ---- Project changes ---------------------------------------------------------

    /**
     * Change the project. `commit` true makes this its own undo step; a
     * `coalesce` key folds a run of edits (a slider drag) into one step,
     * closed by the next `commit()`.
     */
    const apply = useCallback((fn, commit = false, coalesce = null) => {
        const prev = projRef.current;
        const next = fn(prev);
        if (!next || next === prev) return prev;
        const h = history.current;
        const now = performance.now();
        const folding = coalesce && h.coalesce === coalesce && now - h.at < 4000;
        if (!folding) {
            h.past.push(prev);
            if (h.past.length > HISTORY) h.past.shift();
            h.future = [];
        }
        h.coalesce = commit ? null : coalesce;
        h.at = now;
        projRef.current = next;
        setRev((r) => r + 1);
        return next;
    }, []);

    const commit = useCallback(() => { history.current.coalesce = null; }, []);

    const undo = useCallback(() => {
        const h = history.current;
        if (!h.past.length) return;
        h.future.push(projRef.current);
        projRef.current = h.past.pop();
        h.coalesce = null;
        setRev((r) => r + 1);
    }, []);

    const redo = useCallback(() => {
        const h = history.current;
        if (!h.future.length) return;
        h.past.push(projRef.current);
        projRef.current = h.future.pop();
        h.coalesce = null;
        setRev((r) => r + 1);
    }, []);

    // The project as last saved or opened: anything else is unsaved work.
    const savedRef = useRef(projRef.current);
    const isDirty = () => projRef.current !== savedRef.current;

    const replaceProject = useCallback((p) => {
        history.current = { past: [], future: [], coalesce: null, at: 0 };
        projRef.current = p;
        savedRef.current = p;
        transportRef.current.seek(0);
        setSelection(null);
        setRev((r) => r + 1);
    }, []);

    // ---- Engine ---------------------------------------------------------------------

    useEffect(() => {
        const engine = new Engine();
        engine.mount(mountRef.current);
        engine.setLibrary(() => libraryRef.current);
        engine.setLooks(() => looksRef.current);
        engineRef.current = engine;
        // A handle for poking at it from the console while developing.
        if (process.env.NODE_ENV !== 'production') {
            window.__compositor = { engine, project: () => projRef.current, seek: (t) => transportRef.current.seek(t) };
        }
        const offPick = engine.on('pick', (id) => setSelection(id ? { kind: 'object', id } : null));
        const offEdit = engine.on('edit', (id, patch, done) => {
            const isTake = projRef.current.objects.find((o) => o.id === id)?.type === 'take';
            apply((p) => ({
                ...p,
                objects: p.objects.map((o) => (o.id === id ? { ...o, params: { ...o.params, ...patch } } : o)),
            }), done, `gizmo:${id}`);
            if (isTake) engine.dirty = true;
        });
        const offChange = engine.on('change', () => setTick((n) => n + 1));
        const offPickCorner = engine.on('cornerPick', (i) => setCornerHandle(i));
        const offCorners = engine.on('corners', (ev) => {
            if (ev.kind === 'screen') {
                editAssetRef.current(ev.entryId, (a) => ({ ...a, screen: { ...DEFAULT_SCREEN, ...a.screen, corners: ev.corners } }), ev.done);
                return;
            }
            const key = ev.kind === 'window' ? 'corners' : ev.key;
            apply((p) => ({
                ...p,
                objects: p.objects.map((o) => (o.id === ev.objectId ? { ...o, params: { ...o.params, [key]: ev.corners } } : o)),
            }), ev.done, `corners:${ev.objectId}`);
        });
        return () => {
            offPick();
            offEdit();
            offChange();
            offPickCorner();
            offCorners();
            engine.dispose();
            engineRef.current = null;
            transportRef.current.dispose();
        };
    }, [apply]);

    useEffect(() => { engineRef.current?.setProject(projRef.current); }, [rev]);
    useEffect(() => { engineRef.current?.setMode(mode); }, [mode]);
    useEffect(() => { engineRef.current?.setSelection(selection?.kind === 'object' ? selection.id : null); }, [selection]);
    useEffect(() => { engineRef.current?.setGizmoMode(gizmoMode); }, [gizmoMode]);

    // ---- The library ------------------------------------------------------------

    const saveLibraryNow = useCallback(() => {
        const n = ++librarySave.current;
        setLibrarySaved('saving');
        saveLibrary(libraryRef.current).then((where) => { if (n === librarySave.current) setLibrarySaved(where); });
    }, []);

    /** Change one asset; `save` false while dragging (saved when the drag ends). */
    const editAsset = useCallback((id, fn, save = true) => {
        const next = patchAsset(libraryRef.current, id, fn);
        libraryRef.current = next;
        setLibrary(next);
        if (engineRef.current) engineRef.current.dirty = true;
        if (save) saveLibraryNow();
    }, [saveLibraryNow]);
    /** Change a take's scan correction; `save` false while a slider is dragged. */
    const setLook = useCallback((take, patch, save = false) => {
        const next = { ...looksRef.current, [take]: patch ? { ...(looksRef.current[take] || {}), ...patch, updatedAt: Date.now() } : undefined };
        if (!patch) delete next[take];
        looksRef.current = next;
        setLooks(next);
        if (engineRef.current) engineRef.current.dirty = true;
        if (!save) return;
        const n = ++looksSave.current;
        setLooksSaved('saving');
        saveLooks(next).then((where) => { if (n === looksSave.current) setLooksSaved(where); });
    }, []);
    const saveLooksNow = useCallback(() => {
        const n = ++looksSave.current;
        setLooksSaved('saving');
        saveLooks(looksRef.current).then((where) => { if (n === looksSave.current) setLooksSaved(where); });
    }, []);

    const editAssetRef = useRef(editAsset);
    editAssetRef.current = editAsset;

    // ---- Corner editing: a selected window always; a screen or the pulse shape when asked.
    const selectedObj = selection?.kind === 'object' ? project.objects.find((o) => o.id === selection.id) : null;
    const cornerEdit = selectedObj && selectedObj.gizmo !== false
        && (selectedObj.type === 'window' || selectedObj.type === 'text' || cornerOn === selectedObj.id)
        ? { objectId: selectedObj.id, handle: cornerHandle } : null;
    const cornerKey = cornerEdit ? `${cornerEdit.objectId}:${cornerEdit.handle}` : '';
    useEffect(() => {
        engineRef.current?.setCornerEdit(cornerKey ? { objectId: cornerKey.split(':')[0], handle: Number(cornerKey.split(':')[1]) } : null);
    }, [cornerKey]);
    useEffect(() => { setCornerHandle(4); }, [selection]);

    // ---- Roto -------------------------------------------------------------------

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const sc = projRef.current.scenes.find((x) => x.take === roto.take);
        const intr = engine.rig(sc?.id)?.track?.intrinsics;
        engine.setRoto({ on: roto.on, plain: roto.plain, aspect: intr ? intr.width / intr.height : null });
        if (roto.on) setMode('preview');
    }, [roto]);
    useEffect(() => { engineRef.current?.setAnalysis(analysis); }, [analysis]);
    useEffect(() => { transportRef.current.setMuted(muted); }, [muted]);

    const duration = projectDuration(project);
    const durationRef = useRef(duration);
    durationRef.current = duration;
    const loopRef = useRef(loop);
    loopRef.current = loop;

    // The render loop.
    useEffect(() => {
        let raf = 0;
        let last = performance.now();
        const frame = () => {
            raf = requestAnimationFrame(frame);
            const engine = engineRef.current;
            const tr = transportRef.current;
            if (!engine || engine.exporting) return;
            const now = performance.now();
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            let t = tr.now();
            if (tr.playing && t >= durationRef.current) {
                if (loopRef.current) { tr.seek(0); t = 0; } else { tr.pause(); tr.seek(durationRef.current); t = durationRef.current; setPlaying(false); }
            }
            engine.renderAt(t, { playing: tr.playing, dt: tr.playing ? dt : 0 });
            ticker.run(t, engine.lastFrame);
            if (timeReadout.current) timeReadout.current.textContent = fmtTime(t, projRef.current.output.fps);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [ticker]);

    // ---- Sound: the mix the transport plays, and what the controllers hear --------

    const audioKey = useMemo(() => JSON.stringify({
        c: project.clips.map((c) => [c.trackId, c.mediaId, c.start, c.in, c.dur, c.rate, c.loop, c.withAudio]),
        t: project.tracks.map((t) => [t.id, t.kind, t.params?.visible, t.params?.gain]),
        m: project.media.map((m) => [m.id, m.src && JSON.stringify(m.src)]),
    }), [project.clips, project.tracks, project.media]);

    useEffect(() => {
        let alive = true;
        const timer = setTimeout(async () => {
            try {
                const [program, music] = await Promise.all([
                    mixProject(projRef.current),
                    mixProject(projRef.current, { music: true }),
                ]);
                if (!alive) return;
                transportRef.current.setBuffer(program);
                setStatus(music ? 'Analysing audio…' : '');
                await new Promise((r) => setTimeout(r, 0));
                if (!alive) return;
                setAnalysis(music ? analyse(music) : null);
                setStatus('');
            } catch (e) {
                if (alive) setStatus(`Audio: ${e.message}`);
            }
        }, 350);
        return () => { alive = false; clearTimeout(timer); };
    }, [audioKey]);

    // Waveforms for audio clips.
    useEffect(() => {
        project.media.filter((m) => m.kind === 'audio' && !audioBuffers.has(m.id)).forEach(async (m) => {
            const buf = await decodeUrl(await mediaUrl(m));
            if (buf) setAudioBuffers((prev) => new Map(prev).set(m.id, buf));
        });
    }, [project.media, audioBuffers]);

    // ---- Takes, library, uploads ------------------------------------------------------

    useEffect(() => {
        fetch(MANIFEST_URL).then((r) => (r.ok ? r.json() : [])).then(setTakes).catch(() => setTakes([]));
        listUploads().then(setUploads);
        listProjects().then(setRepoProjects);
    }, []);

    // ---- Actions --------------------------------------------------------------------------

    const select = useCallback((s) => setSelection(s), []);
    const now = useCallback(() => transportRef.current.now(), []);
    const seek = useCallback((t) => { transportRef.current.seek(Math.max(0, t)); engineRef.current && (engineRef.current.dirty = true); }, []);

    const togglePlay = useCallback(() => {
        const tr = transportRef.current;
        if (tr.playing) { tr.pause(); setPlaying(false); return; }
        if (tr.now() >= durationRef.current - 1e-3) tr.seek(0);
        tr.play();
        setPlaying(true);
    }, []);

    const updateObject = useCallback((id, fn, done = false, coalesce = null) => apply((p) => ({
        ...p, objects: p.objects.map((o) => (o.id === id ? fn(o) : o)),
    }), done, coalesce), [apply]);

    const setParam = useCallback((id, key, v, done = false) => updateObject(
        id, (o) => ({ ...o, params: { ...o.params, [key]: v } }), done, `p:${id}:${key}`,
    ), [updateObject]);

    const setLink = useCallback((id, key, link) => updateObject(id, (o) => {
        const links = { ...(o.links || {}) };
        if (link) links[key] = link; else delete links[key];
        return { ...o, links };
    }, false, `l:${id}:${key}`), [updateObject]);

    const updateController = useCallback((id, fn, done = false, coalesce = null) => apply((p) => ({
        ...p, controllers: p.controllers.map((c) => (c.id === id ? fn(c) : c)),
    }), done, coalesce), [apply]);

    const addController = useCallback((type) => {
        const n = projRef.current.controllers.length;
        const colors = ['#ecebe6', '#e8553d', '#e8c547', '#6fd3ff', '#9b7bff', '#5fd39a', '#ff7bd0', '#ffb347'];
        const c = makeController(newId('ctl'), type, { color: colors[n % colors.length] });
        const same = projRef.current.controllers.filter((x) => x.type === type).length;
        if (same) c.name = `${c.name} ${same + 1}`;
        apply((p) => ({ ...p, controllers: [...p.controllers, c] }), true);
        return c;
    }, [apply]);

    const removeController = useCallback((id) => {
        apply((p) => ({
            ...p,
            controllers: p.controllers.filter((c) => c.id !== id),
            objects: p.objects.map((o) => {
                if (!Object.values(o.links || {}).some((l) => l.controller === id)) return o;
                return { ...o, links: Object.fromEntries(Object.entries(o.links).filter(([, l]) => l.controller !== id)) };
            }),
            tracks: p.tracks.map((t) => ({ ...t, links: Object.fromEntries(Object.entries(t.links || {}).filter(([, l]) => l.controller !== id)) })),
        }), true);
        setSelection(null);
    }, [apply]);

    const newCutId = useCallback(() => newId('cut'), []);

    const cutSwitch = useCallback((id, state) => {
        // Down, never up, so the cut is in force at the playhead it was made at.
        const t = Math.floor(transportRef.current.now() * 1000) / 1000;
        updateController(id, (c) => {
            const cuts = c.cuts.filter((k) => Math.abs(k.t - t) > 1e-3);
            const s = state ?? ((c.cuts.filter((k) => k.t <= t).pop()?.s ?? 0) + 1) % c.states.length;
            cuts.push({ id: newId('cut'), t, s });
            cuts.sort((a, b) => a.t - b.t);
            // A cut only ever adds (or replaces the one at the playhead):
            // the cuts after it stay exactly where and what they were, even
            // where one now repeats the state before it.
            return { ...c, cuts };
        }, true);
    }, [updateController]);

    const addKey = useCallback((id, t, v) => updateController(id, (c) => ({
        ...c,
        keys: [...c.keys.filter((k) => Math.abs(k.t - t) > 1e-3), { id: newId('key'), t: Math.round(t * 1000) / 1000, v }].sort((a, b) => a.t - b.t),
    }), true), [updateController]);

    // Where something new should stand: the middle of the scan.
    // `floor` stands it on the lowest of the scan's points instead.
    const scanCentre = (sceneId, floor = false) => {
        const rig = engineRef.current?.rig(sceneId);
        const c = rig?.sphere?.center;
        const r = (v) => Math.round(v * 1000) / 1000;
        if (!c) return { posX: 0, posY: 0, posZ: 0 };
        let y = c.y;
        if (floor && rig.cloud) {
            const g = rig.cloud.geometry;
            if (!g.boundingBox) g.computeBoundingBox();
            y = g.boundingBox.min.y;
        }
        return { posX: r(c.x), posY: r(y), posZ: r(c.z) };
    };
    const scanRadius = (sceneId) => engineRef.current?.rig(sceneId)?.sphere?.radius || 1;

    const addObject = useCallback((type, sceneId) => {
        let params = {};
        let extra;
        if (sceneId) {
            const grounded = ['protagonist', 'sackboy', 'prop'].includes(type);
            const at = scanCentre(sceneId, grounded);
            const r = scanRadius(sceneId);
            if (type === 'cloud') params = { ...at, radius: r * 1.4, pointSize: Math.max(0.0015, r * 0.004), maxPoints: 40000, samples: 20000 };
            if (type === 'curve') params = { ...at, curveScale: r * 1.2, dotSize: Math.max(0.01, r * 0.02) };
            if (type === 'protagonist') {
                const it = makeModelItem('x', at, 'stand');
                params = { ...it.op };
                extra = { pose: it.pose };
            }
            if (type === 'sackboy') {
                const it = makeSackboyItem('x', at, 'stand');
                params = { ...it.op };
                extra = { pose: it.pose };
            }
            if (type === 'prop') {
                const first = libraryRef.current.assets.find((a) => a.category !== 'screen') || libraryRef.current.assets[0];
                params = { ...at, assetId: first?.id || '' };
            }
            if (type === 'camera') {
                const cam = engineRef.current?.freeCamera;
                if (cam) {
                    const e = cam.rotation.clone().reorder('YXZ');
                    const d = (v) => Math.round((v * 180) / Math.PI * 100) / 100;
                    params = { posX: cam.position.x, posY: cam.position.y, posZ: cam.position.z, rotX: d(e.x), rotY: d(e.y), rotZ: d(e.z), fov: cam.fov };
                }
            }
            if (type === 'window' || type === 'text') {
                let corners = engineRef.current?.windowCorners(sceneId);
                if (corners && type === 'text') {
                    // A line of text: half again as wide, half as tall.
                    const [tl, tr, br, bl] = corners;
                    const mid = [0, 1, 2].map((k) => (tl[k] + tr[k] + br[k] + bl[k]) / 4);
                    const h = [0, 1, 2].map((k) => (tr[k] - tl[k]) / 2);
                    const v = [0, 1, 2].map((k) => (tl[k] - bl[k]) / 2);
                    const at = (a, b) => [0, 1, 2].map((k) => Math.round((mid[k] + h[k] * a + v[k] * b) * 1e4) / 1e4);
                    corners = [at(-1.5, 0.5), at(1.5, 0.5), at(1.5, -0.5), at(-1.5, -0.5)];
                }
                if (corners) params = { corners };
            }
        }
        const obj = makeObject(type, sceneId, { params, extra });
        const same = projRef.current.objects.filter((o) => o.type === type && o.sceneId === sceneId).length;
        if (same) obj.name = `${obj.name} ${same + 1}`;
        apply((p) => ({ ...p, objects: [...p.objects, obj] }), true);
        setSelection({ kind: 'object', id: obj.id });
        return obj;
    }, [apply]);

    const removeObject = useCallback((id) => {
        apply((p) => ({
            ...p,
            objects: p.objects.filter((o) => o.id !== id),
            clips: p.clips.map((c) => (c.camera === id ? { ...c, camera: undefined } : c)),
        }), true);
        setSelection(null);
    }, [apply]);

    const duplicateObject = useCallback((id) => {
        const src = projRef.current.objects.find((o) => o.id === id);
        if (!src) return;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId(src.type), name: `${src.name} copy` };
        apply((p) => {
            const i = p.objects.findIndex((o) => o.id === id);
            const objects = [...p.objects];
            objects.splice(i + 1, 0, copy);
            return { ...p, objects };
        }, true);
        setSelection({ kind: 'object', id: copy.id });
    }, [apply]);

    const moveEffect = useCallback((id, dir) => apply((p) => {
        const fx = p.objects.filter((o) => !o.sceneId);
        const i = fx.findIndex((o) => o.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= fx.length) return p;
        [fx[i], fx[j]] = [fx[j], fx[i]];
        return { ...p, objects: [...p.objects.filter((o) => o.sceneId), ...fx] };
    }, true), [apply]);

    // ---- Timeline edits ---------------------------------------------------------------------

    const updateClip = useCallback((id, fn, done = false, coalesce = null) => apply((p) => ({
        ...p, clips: p.clips.map((c) => (c.id === id ? fn(c) : c)),
    }), done, coalesce), [apply]);

    const removeClip = useCallback((id) => {
        apply((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== id) }), true);
        setSelection(null);
    }, [apply]);

    const splitClip = useCallback((id) => {
        const t = transportRef.current.now();
        const c = projRef.current.clips.find((x) => x.id === id);
        if (!c || t <= c.start + 0.02 || t >= clipEnd(c) - 0.02) return;
        const m = projRef.current.media.find((x) => x.id === c.mediaId);
        const head = t - c.start;
        const right = {
            ...c, id: newId('clp'), start: t, dur: c.dur - head, in: m?.kind === 'stage' ? 0 : c.in + head * (c.rate || 1),
        };
        // A looping clip's source time is not linear; a split keeps the
        // right half where it was by holding its own in point.
        apply((p) => ({ ...p, clips: [...p.clips.map((x) => (x.id === id ? { ...x, dur: head } : x)), right] }), true);
        setSelection({ kind: 'clip', id: right.id });
    }, [apply]);

    const updateTrack = useCallback((id, fn, done = false, coalesce = null) => apply((p) => ({
        ...p, tracks: p.tracks.map((t) => (t.id === id ? fn(t) : t)),
    }), done, coalesce), [apply]);

    const setTrackLink = useCallback((id, key, link) => updateTrack(id, (t) => {
        const links = { ...(t.links || {}) };
        if (link) links[key] = link; else delete links[key];
        return { ...t, links };
    }, true), [updateTrack]);

    const addTrack = useCallback((kind) => apply((p) => {
        const n = p.tracks.filter((t) => t.kind === kind).length + 1;
        const t = {
            id: newId('trk'), kind, name: `${kind === 'video' ? 'V' : 'A'}${n}`,
            params: kind === 'video' ? { visible: true, opacity: 1 } : { visible: true, gain: 1 }, links: {},
        };
        // New video tracks go on top; audio at the bottom.
        return { ...p, tracks: kind === 'video' ? [t, ...p.tracks] : [...p.tracks, t] };
    }, true), [apply]);

    const removeTrack = useCallback((id) => {
        apply((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== id), clips: p.clips.filter((c) => c.trackId !== id) }), true);
        setSelection(null);
    }, [apply]);

    const updateMedia = useCallback((id, fn, done = false, coalesce = null) => apply((p) => ({
        ...p, media: p.media.map((m) => (m.id === id ? fn(m) : m)),
    }), done, coalesce), [apply]);

    const removeMedia = useCallback((id) => {
        // Its scene (a take's or a stage's) and everything in it go with it.
        apply((p) => pruneScenes({
            ...p, media: p.media.filter((x) => x.id !== id), clips: p.clips.filter((c) => c.mediaId !== id),
        }), true);
        setSelection(null);
    }, [apply]);

    /** Put a media item on the timeline: a given track and time, or the playhead on the first track that suits. */
    const placeMedia = useCallback((mediaId, { trackId, at } = {}) => {
        const p0 = projRef.current;
        const m = p0.media.find((x) => x.id === mediaId);
        if (!m) return;
        const kind = m.kind === 'audio' ? 'audio' : 'video';
        const dur = Number.isFinite(m.duration) && m.duration > 0 ? m.duration : 8;
        const want = at ?? transportRef.current.now();
        let track = p0.tracks.find((t) => t.id === trackId && t.kind === kind);
        let start = want;
        if (!track) {
            const cands = p0.tracks.filter((t) => t.kind === kind);
            // Video goes on the lowest track it fits on at the playhead.
            const order = kind === 'video' ? [...cands].reverse() : cands;
            track = order.find((t) => firstFit(p0, t.id, want, dur) === want) || order[0];
            if (!track) return;
            start = firstFit(p0, track.id, want, dur);
        } else {
            start = firstFit(p0, track.id, want, dur);
        }
        const clip = {
            id: newId('clp'), trackId: track.id, mediaId, start, in: 0, dur, rate: 1, loop: 'off',
            ...(m.kind === 'take' ? { camera: 'solve' } : {}),
        };
        apply((p) => ({ ...p, clips: [...p.clips, clip] }), true);
        setSelection({ kind: 'clip', id: clip.id });
    }, [apply]);

    const addTake = useCallback(async (takeId) => {
        const take = takes.find((t) => t.id === takeId);
        const url = `${process.env.PUBLIC_URL}/mv/${takeId}/${takeId}.mp4`;
        const info = await probe(url, 'video');
        let created;
        apply((p) => {
            const a = ensureTakeScene(p, takeId, take?.label);
            const b = takeMedia(a.project, takeId, take?.label, info?.duration || 0);
            b.media.width = info?.width;
            b.media.height = info?.height;
            created = b.media;
            // The first take sets the output frame.
            let { output } = b.project;
            if (output.auto && !p.media.some((x) => x.kind === 'take') && info?.width) {
                output = { ...output, width: info.width, height: info.height };
            }
            return { ...b.project, output };
        }, true);
        return created;
    }, [apply, takes]);

    const addMedia = useCallback(async (what) => {
        if (what === 'file') { fileRef.current.click(); return; }
        if (what === 'stage') {
            let media;
            apply((p) => { const r = addStageScene(p, `Stage ${p.scenes.filter((s) => !s.take).length + 1}`); media = r.media; return r.project; }, true);
            placeMedia(media.id);
            return;
        }
        if (what === 'bundled') { setDialog('music'); return; }
        if (what === 'bundledVideo') { setDialog('video'); return; }
        if (what.startsWith('take:')) {
            const m = await addTake(what.slice(5));
            if (m) placeMedia(m.id);
        }
    }, [apply, addTake, placeMedia]);

    const addBundledMusic = useCallback(async (id) => {
        const a = MUSIC_ASSETS.find((x) => x.id === id);
        if (!a) return;
        const url = `${process.env.PUBLIC_URL}/${a.path}`;
        const info = await probe(url, 'audio');
        const media = { id: newId('med'), kind: 'audio', name: a.name, src: { type: 'public', path: a.path }, duration: info?.duration || 0 };
        apply((p) => ({ ...p, media: [...p.media, media] }), true);
        placeMedia(media.id);
        setDialog(null);
    }, [apply, placeMedia]);

    const addBundledVideo = useCallback(async (id) => {
        const v = PUBLIC_VIDEOS.find((x) => x.id === id);
        if (!v) return;
        const path = v.id.slice('public:'.length);
        const info = await probe(`${process.env.PUBLIC_URL}/${path}`, 'video');
        const media = {
            id: newId('med'), kind: 'video', name: v.name, src: { type: 'public', path }, duration: info?.duration || 0, width: info?.width, height: info?.height,
        };
        apply((p) => ({ ...p, media: [...p.media, media] }), true);
        placeMedia(media.id);
        setDialog(null);
    }, [apply, placeMedia]);

    const importFiles = useCallback(async (files) => {
        for (const file of files) {
            const kind = file.type.startsWith('audio') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name) ? 'audio' : 'video';
            setStatus(`Importing ${file.name}…`);
            // eslint-disable-next-line no-await-in-loop
            const src = await importFile(file);
            const url = URL.createObjectURL(file);
            // eslint-disable-next-line no-await-in-loop
            const info = await probe(url, kind);
            URL.revokeObjectURL(url);
            const media = {
                id: newId('med'), kind, name: file.name, src, duration: info?.duration || 0, width: info?.width, height: info?.height,
            };
            apply((p) => ({ ...p, media: [...p.media, media] }), true);
            placeMedia(media.id);
        }
        setStatus('');
        listUploads().then(setUploads);
    }, [apply, placeMedia]);

    const relocateMedia = useCallback(async (id, file) => {
        const src = await importFile(file);
        const url = URL.createObjectURL(file);
        const m = projRef.current.media.find((x) => x.id === id);
        const info = await probe(url, m?.kind === 'audio' ? 'audio' : 'video');
        URL.revokeObjectURL(url);
        engineRef.current?.pool.drop(id);
        apply((p) => ({ ...p, media: p.media.map((x) => (x.id === id ? { ...x, src, duration: info?.duration || x.duration } : x)) }), true);
        setAudioBuffers((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setStatus(`Relocated ${file.name}`);
    }, [apply]);

    const uploadScreenVideo = useCallback(async (file) => {
        const id = await storeUpload(file);
        setUploads(await listUploads());
        return id;
    }, []);

    // ---- Take frames (for Roto) ------------------------------------------------------------

    /** The clip of a take under `t`, else its first clip. */
    const takeClip = (take, t) => {
        const P = projRef.current;
        const m = P.media.find((x) => x.kind === 'take' && x.src?.take === take);
        if (!m) return null;
        const clips = P.clips.filter((c) => c.mediaId === m.id).sort((a, b) => a.start - b.start);
        const clip = clips.find((c) => t >= c.start && t < clipEnd(c)) || clips[0];
        return clip ? { clip, media: m } : null;
    };

    const takeFrameAt = useCallback((take, t) => {
        const rig = engineRef.current?.rig(projRef.current.scenes.find((x) => x.take === take)?.id);
        const hit = takeClip(take, t);
        if (!rig?.track || !hit) return null;
        const st = clipSourceTime(hit.clip, hit.media, t);
        if (!st) return null;
        return Math.max(0, Math.min(rig.track.frame_count - 1, Math.floor(st.time * rig.track.fps + 1e-3)));
    }, []);

    const seekTakeFrame = useCallback((take, f) => {
        const rig = engineRef.current?.rig(projRef.current.scenes.find((x) => x.take === take)?.id);
        const hit = takeClip(take, transportRef.current.now());
        if (!rig?.track || !hit) return;
        const { clip } = hit;
        // Mid-frame, so rounding cannot land on its neighbour.
        const src = (f + 0.5) / rig.track.fps;
        const t = clip.start + (src - (clip.in || 0)) / (clip.rate || 1);
        transportRef.current.pause();
        setPlaying(false);
        transportRef.current.seek(Math.max(clip.start, Math.min(clipEnd(clip) - 1e-3, t)));
    }, []);

    // ---- Cameras ------------------------------------------------------------------------

    const toggleRecord = useCallback((id) => {
        const engine = engineRef.current;
        if (!engine) return;
        if (recordingId) {
            const r = engine.stopRecording();
            setRecordingId(null);
            transportRef.current.pause();
            setPlaying(false);
            if (r) {
                const t0 = r.samples[0].t;
                const t1 = r.samples[r.samples.length - 1].t;
                updateObject(r.id, (o) => {
                    const old = (o.extra?.path || []).filter((s) => s.t < t0 || s.t > t1);
                    return { ...o, extra: { ...o.extra, path: [...old, ...r.samples].sort((a, b) => a.t - b.t) } };
                }, true);
                setStatus(`Recorded ${r.samples.length} samples, ${t0.toFixed(2)}–${t1.toFixed(2)}s`);
            }
            return;
        }
        if (mode === 'preview') setMode('orbit');
        engine.startRecording(id);
        setRecordingId(id);
        if (!transportRef.current.playing) { transportRef.current.play(); setPlaying(true); }
    }, [recordingId, mode, updateObject]);

    const cameraFromView = useCallback((id) => {
        const cam = engineRef.current?.freeCamera;
        if (!cam) return;
        const e = cam.rotation.clone().reorder('YXZ');
        const d = (v) => Math.round((v * 180) / Math.PI * 100) / 100;
        const r = (v) => Math.round(v * 1e4) / 1e4;
        updateObject(id, (o) => ({
            ...o,
            params: {
                ...o.params, posX: r(cam.position.x), posY: r(cam.position.y), posZ: r(cam.position.z), rotX: d(e.x), rotY: d(e.y), rotZ: d(e.z), fov: cam.fov, usePath: false,
            },
        }), true);
    }, [updateObject]);

    const viewFromCamera = useCallback((id) => {
        const engine = engineRef.current;
        const o = projRef.current.objects.find((x) => x.id === id);
        if (!engine || !o) return;
        const pose = cameraPoseAt(o, o.params, transportRef.current.now());
        engine.freeCamera.position.copy(pose.pos);
        engine.freeCamera.quaternion.copy(pose.quat);
        const fwd = engine.freeCamera.getWorldDirection(pose.pos.clone());
        engine.controls.target.copy(engine.freeCamera.position).addScaledVector(fwd, 1);
        if (mode === 'preview') setMode('orbit');
    }, [mode]);

    // ---- Files ----------------------------------------------------------------------------

    /** Save to the repo (or download, without a dev server). Resolves to whether it worked. */
    const save = useCallback(async () => {
        const p = projRef.current;
        if (repoProjects === null) {
            downloadProject(p);
            savedRef.current = p;
            setStatus('Downloaded (no dev server to save into)');
            setRev((r) => r + 1);
            return true;
        }
        try {
            const path = await saveProject(p.name || 'Untitled', p);
            savedRef.current = p;
            setStatus(`Saved to ${path}`);
            setRev((r) => r + 1);
            listProjects().then(setRepoProjects);
            return true;
        } catch (e) {
            setStatus(e.message);
            return false;
        }
    }, [repoProjects]);

    // Leaving (home, or a new project) with unsaved work asks first.
    const [leaving, setLeaving] = useState(null); // { label, go }
    const guard = useCallback((label, go) => {
        if (isDirty()) setLeaving({ label, go });
        else go();
    }, []);
    const navigate = useNavigate();
    useEffect(() => {
        const onUnload = (e) => {
            if (!isDirty()) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onUnload);
        return () => window.removeEventListener('beforeunload', onUnload);
    }, []);

    const open = useCallback(async (name) => {
        try {
            const p = await openProject(name);
            replaceProject(p);
            setDialog(null);
            setStatus(`Opened ${name}`);
        } catch (e) {
            setStatus(e.message);
        }
    }, [replaceProject]);

    const openFile = useCallback(async (file) => {
        try {
            replaceProject(await readProjectFile(file));
            setStatus(`Opened ${file.name}`);
        } catch (e) {
            setStatus(`Could not open ${file.name}: ${e.message}`);
        }
    }, [replaceProject]);

    const newProject = useCallback(() => {
        guard('start a new project', () => replaceProject(createProject()));
    }, [guard, replaceProject]);

    // A fresh session opens on the first take, like the scan compositor did.
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !takes.length || projRef.current.clips.length) return;
        seeded.current = true;
        addMedia(`take:${takes[0].id}`).then(() => {
            history.current.past = [];
            savedRef.current = projRef.current;
            setRev((r) => r + 1);
        });
    }, [takes, addMedia]);

    // ---- Keys --------------------------------------------------------------------------

    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            const mod = e.metaKey || e.ctrlKey;
            const sel = selectionRef.current;
            if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
            if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
            if (mod) return;
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
            if (e.key === 'Tab') {
                e.preventDefault();
                setMode((m) => MODES[(MODES.findIndex(([id]) => id === m) + (e.shiftKey ? 2 : 1)) % 3][0]);
                return;
            }
            if (e.key === 'Home') { seek(0); return; }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const step = (e.shiftKey ? 1 : 1 / projRef.current.output.fps) * (e.key === 'ArrowLeft' ? -1 : 1);
                seek(transportRef.current.now() + step);
                return;
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
                if (sel.kind === 'clip') removeClip(sel.id);
                else if (sel.kind === 'object' && !OBJECT_TYPES[projRef.current.objects.find((o) => o.id === sel.id)?.type]?.unique) removeObject(sel.id);
                return;
            }
            // S (or C) cuts what is selected at the playhead: a Switch on to
            // its next state, a clip in two. It is taken from the fly keys
            // (preventDefault: the engine leaves it alone), and holding it
            // makes one cut, not one per key repeat.
            const cutKey = e.code === 'KeyS' || e.code === 'KeyC';
            const switchSel = sel?.kind === 'controller'
                && projRef.current.controllers.find((x) => x.id === sel.id)?.type === 'switch';
            if (cutKey && (switchSel || (e.code === 'KeyS' && sel?.kind === 'clip'))) {
                e.preventDefault();
                if (e.repeat) return;
                if (switchSel) cutSwitch(sel.id); else splitClip(sel.id);
                return;
            }
            if (sel?.kind === 'controller') {
                const c = projRef.current.controllers.find((x) => x.id === sel.id);
                if (c?.type === 'switch') {
                    const n = parseInt(e.key, 10);
                    if (n >= 1 && n <= c.states.length) { cutSwitch(c.id, n - 1); return; }
                }
                if (c?.type === 'keys' && e.key.toLowerCase() === 'k') { addKey(c.id, transportRef.current.now(), 1); return; }
            }
            if (e.key.toLowerCase() === 'g') setGizmoMode('translate');
            if (e.key.toLowerCase() === 'r') setGizmoMode('rotate');
            if (e.key.toLowerCase() === 'y') setGizmoMode('scale');
            if (e.key.toLowerCase() === 'f') engineRef.current?.frameActive();
        };
        // Capture phase, ahead of the engine's fly keys.
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [undo, redo, save, togglePlay, seek, removeClip, removeObject, cutSwitch, addKey, splitClip, mode]);

    // ---- Timeline splitter ----------------------------------------------------------------------

    const dragSplit = (e) => {
        const y0 = e.clientY;
        const h0 = tlHeight;
        const move = (ev) => setTlHeight(Math.max(120, Math.min(window.innerHeight - 220, h0 - (ev.clientY - y0))));
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    useEffect(() => { engineRef.current?.fit(); }, [tlHeight, sideOpen]);

    const missingMedia = engineRef.current?.missingMedia || new Set();

    const comp = {
        project,
        rev,
        selection,
        select,
        takes,
        library,
        librarySaved,
        looks,
        looksSaved,
        setLook,
        saveLooksNow,
        editAsset,
        saveLibraryNow,
        downloadLibrary: () => downloadLibrary(libraryRef.current),
        propModel: (id) => engineRef.current?.adapterOf(id)?.adapter?.model || null,
        rig: (sceneId) => engineRef.current?.rig(sceneId) || null,
        stageEl: engineRef.current?.stage || null,
        pulsePreset: (sceneId, kind, which) => engineRef.current?.pulsePreset(sceneId, kind, which) || null,
        roto,
        setRoto,
        takeFrameAt,
        seekTakeFrame,
        cornerOn,
        setCornerOn,
        cornerHandle,
        setCornerHandle,
        uploads,
        analysis,
        duration,
        audioBuffers,
        missingMedia,
        recordingId,
        get playing() { return transportRef.current.playing; },
        ticker,
        now,
        seek,
        commit,
        setStatus,
        updateObject,
        setParam,
        setLink,
        addObject,
        removeObject,
        duplicateObject,
        moveEffect,
        addController,
        updateController,
        removeController,
        selectController: (id) => setSelection({ kind: 'controller', id }),
        cutSwitch,
        addKey,
        newCutId,
        updateClip,
        removeClip,
        splitClip,
        updateTrack,
        setTrackLink,
        addTrack,
        removeTrack,
        updateMedia,
        removeMedia,
        relocateMedia,
        placeMedia,
        addMedia,
        uploadScreenVideo,
        setOutput: (patch) => apply((p) => ({ ...p, output: { ...p.output, ...patch } }), true),
        toggleRecord,
        cameraFromView,
        viewFromCamera,
    };

    const anyMissing = missingMedia.size > 0;
    const hasBase = project.clips.some((c) => is3D(project.media.find((m) => m.id === c.mediaId)));

    return (
        <Ctx.Provider value={comp}>
            <div className={styles.root} style={{ '--tl-h': `${tlHeight}px` }}>
                <header className={styles.bar}>
                    <Link
                        to="/"
                        className={styles.home}
                        aria-label="Charles Miguel Henville, home"
                        onClick={(e) => {
                            e.preventDefault();
                            guard('leave the compositor', () => navigate('/'));
                        }}
                    >
                        <span className={styles.homeLogo}><Logo /></span>
                        <span className={styles.title}>Compositor</span>
                    </Link>
                    <input
                        className={styles.projName}
                        value={project.name}
                        aria-label="Project name"
                        onChange={(e) => apply((p) => ({ ...p, name: e.target.value }), false, 'name')}
                        onBlur={commit}
                    />
                    {isDirty() && <span className={styles.dirty} title="Unsaved changes">●</span>}
                    <div className={styles.barGroup}>
                        <button type="button" className={styles.btn} title="New project" onClick={newProject}><FilePlus size={14} /></button>
                        <button type="button" className={styles.btn} title="Open…" onClick={() => { listProjects().then(setRepoProjects); setDialog('open'); }}><FolderOpen size={14} /></button>
                        <button type="button" className={styles.btn} title={repoProjects === null ? 'Save (download)' : 'Save to compositor-projects/ (⌘S)'} onClick={save}><Save size={14} /></button>
                        <button type="button" className={styles.btn} title="Download project file" onClick={() => downloadProject(projRef.current)}><Download size={14} /></button>
                        <button type="button" className={styles.btn} title="Undo (⌘Z)" disabled={!history.current.past.length} onClick={undo}><Undo2 size={14} /></button>
                        <button type="button" className={styles.btn} title="Redo (⇧⌘Z)" disabled={!history.current.future.length} onClick={redo}><Redo2 size={14} /></button>
                    </div>
                    <span className={styles.barSep} />
                    <div className={styles.barGroup}>
                        <button type="button" className={styles.btn} title="To start (Home)" onClick={() => seek(0)}><SkipBack size={14} /></button>
                        <button type="button" className={styles.btn} title="Play / pause (space)" onClick={togglePlay}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
                        <button type="button" className={`${styles.btn} ${loop ? styles.btnOn : ''}`} title="Loop the timeline" onClick={() => setLoop(!loop)}><Repeat size={14} /></button>
                        <button type="button" className={styles.btn} title={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
                        <span ref={timeReadout} className={styles.time}>00:00:00</span>
                    </div>
                    <span className={styles.barSep} />
                    <div className={styles.seg} role="group" aria-label="View mode">
                        {MODES.map(([id, label, Icon, tip]) => (
                            <button key={id} type="button" title={`${tip} (Tab)`} className={`${styles.btn} ${mode === id ? styles.btnOn : ''}`} onClick={() => setMode(id)}>
                                <Icon size={13} />
                                <span className={styles.btnLabel}>{label}</span>
                            </button>
                        ))}
                    </div>
                    <div className={styles.seg} role="group" aria-label="Gizmo">
                        {[['translate', Move3d, 'Move (G)'], ['rotate', Rotate3d, 'Rotate (R)'], ['scale', Scale3d, 'Scale (Y)']].map(([id, Icon, tip]) => (
                            <button key={id} type="button" title={tip} className={`${styles.btn} ${gizmoMode === id ? styles.btnOn : ''}`} onClick={() => setGizmoMode(id)}>
                                <Icon size={13} />
                            </button>
                        ))}
                    </div>
                    <span className={styles.spacer} />
                    {(anyMissing || status) && (
                        <span className={`${styles.status} ${anyMissing ? styles.warn : ''}`} title={status}>
                            {anyMissing ? `${missingMedia.size} media file${missingMedia.size > 1 ? 's' : ''} need relocating` : status}
                        </span>
                    )}
                    <button type="button" className={styles.btn} title="Export MP4" disabled={!project.clips.length} onClick={() => setDialog('export')}>
                        <Film size={14} />
                        <span className={styles.btnLabel}>Export</span>
                    </button>
                    <button type="button" className={`${styles.btn} ${sideOpen ? styles.btnOn : ''}`} title="Sidebar" onClick={() => setSideOpen(!sideOpen)}><PanelRight size={14} /></button>
                </header>

                <div className={styles.view}>
                    <div ref={mountRef} className={styles.mount} />
                    <span className={styles.viewBadge}>{mode}</span>
                    {recordingId && <span className={styles.recBadge}>● REC PATH</span>}
                    {!hasBase && <span className={styles.viewHint}>Add a take or a 3D stage from Media to start.</span>}
                    {hasBase && mode !== 'preview' && <span className={styles.viewHint}>Drag to orbit · WASD / Q E to fly · F to frame · click to select · G R Y gizmo</span>}
                </div>

                <Sidebar open={sideOpen} />

                <div className={styles.split} onPointerDown={dragSplit} role="separator" aria-orientation="horizontal" />
                <Timeline />
            </div>

            <input ref={fileRef} type="file" multiple accept="video/*,audio/*,.mp4,.mov,.webm,.mp3,.wav,.m4a" style={{ display: 'none' }} onChange={(e) => { importFiles(Array.from(e.target.files)); e.target.value = ''; }} />
            <input ref={projectFileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); setDialog(null); }} />
            <input ref={relocateRef} type="file" style={{ display: 'none' }} />

            {leaving && (
                <div className={styles.modal} onClick={() => setLeaving(null)}>
                    <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
                        <h2 className={styles.dialogTitle}>Save your work?</h2>
                        <p className={styles.hint}>
                            {`"${project.name || 'Untitled'}" has changes that aren't saved. Save before you ${leaving.label}?`}
                        </p>
                        <div className={styles.wideRow}>
                            <button
                                type="button"
                                className={`${styles.btn} ${styles.btnOn}`}
                                onClick={async () => {
                                    const go = leaving.go;
                                    if (await save()) { setLeaving(null); go(); }
                                }}
                            >
                                {repoProjects === null ? 'Download and continue' : 'Save and continue'}
                            </button>
                            <button type="button" className={styles.btn} onClick={() => { const go = leaving.go; savedRef.current = projRef.current; setLeaving(null); go(); }}>
                                Don&apos;t save
                            </button>
                            <button type="button" className={styles.btn} onClick={() => setLeaving(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}
            {dialog === 'open' && (
                <div className={styles.modal} onClick={() => setDialog(null)}>
                    <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
                        <h2 className={styles.dialogTitle}>Open project</h2>
                        {repoProjects === null && <p className={styles.hint}>No dev server here, so only files can be opened.</p>}
                        {repoProjects?.length === 0 && <p className={styles.hint}>Nothing saved in compositor-projects/ yet.</p>}
                        {(repoProjects || []).map((p) => (
                            <button key={p.name} type="button" className={styles.listItem} onClick={() => { setDialog(null); guard(`open ${p.name}`, () => open(p.name)); }}>
                                <span className={styles.olName}>{p.name}</span>
                                <span className={styles.olTag}>{new Date(p.updated).toLocaleString()}</span>
                            </button>
                        ))}
                        <div className={styles.wideRow} style={{ marginTop: 10 }}>
                            <button type="button" className={styles.btn} onClick={() => projectFileRef.current.click()}><Upload size={13} /> Open a file…</button>
                            <button type="button" className={styles.btn} onClick={() => setDialog(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}
            {dialog === 'music' && (
                <div className={styles.modal} onClick={() => setDialog(null)}>
                    <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
                        <h2 className={styles.dialogTitle}>Bundled music</h2>
                        {MUSIC_ASSETS.map((m) => (
                            <button key={m.id} type="button" className={styles.listItem} onClick={() => addBundledMusic(m.id)}>{m.name}</button>
                        ))}
                    </div>
                </div>
            )}
            {dialog === 'video' && (
                <div className={styles.modal} onClick={() => setDialog(null)}>
                    <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
                        <h2 className={styles.dialogTitle}>Bundled video</h2>
                        {PUBLIC_VIDEOS.map((v) => (
                            <button key={v.id} type="button" className={styles.listItem} onClick={() => addBundledVideo(v.id)}>{v.name}</button>
                        ))}
                    </div>
                </div>
            )}
            {dialog === 'export' && (
                <ExportDialog
                    engine={engineRef.current}
                    transport={transportRef.current}
                    project={projRef.current}
                    analysis={analysis}
                    onClose={() => setDialog(null)}
                    onPause={() => setPlaying(false)}
                />
            )}
        </Ctx.Provider>
    );
}
