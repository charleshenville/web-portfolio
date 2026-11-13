// The inspector: whatever is selected, edited. Objects get their parameter
// groups (each control right-clickable for its link menu) and any custom
// editors their type needs; controllers, clips, tracks and media get theirs.

import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
    ChevronDown, ChevronRight, Copy, Trash2, ArrowUp, ArrowDown, Circle, Square, Scissors,
} from 'lucide-react';
import {
    OBJECT_TYPES, paramDefs, TRACK_PARAMS, AUDIO_TRACK_PARAMS,
} from '../model/schema';
import {
    CONTROLLER_TYPES, CONTROLLER_COLORS, controllerValue, switchAt, isSwitch, isCut, dependsOn,
} from '../model/controllers';
import { LOOP_MODES, clipEnd } from '../model/timeline';
import { linksTo } from '../model/project';
import { assignStates, kickCutTimes, gridCutTimes, mergeCuts } from '../model/cuts';
import { POSES, JOINTS } from '../../../lib/protagonist/poser';
import { SACKBOY_POSES, SACKBOY_JOINT_MENU } from '../../../lib/scanAssets/sackboy';
import { bodyDims } from '../../../lib/protagonist/model';
import { specOf, MODEL_DEFAULTS } from '../../../lib/protagonist/poser';
import { mattesFor } from '../../../lib/scanAssets/roto';
import { CATEGORIES, DEFAULT_SCREEN } from '../../../lib/scanAssets/library';
import { fitCornersToMesh } from '../../../lib/scanAssets/props';
import RotoEditor from './Roto';
import {
    LOOK_FIELDS, LOOK_DEFAULTS, LOOK_PARTS, isNeutralLook, normaliseLook,
} from '../../../lib/scanAssets/takeLooks';
import { PUBLIC_VIDEOS } from '../../../lib/scanAssets/screenVideo';
import { listPresets, loadPreset, readPresetFile } from '../../quadtree/presets';
import { presetToParams } from '../../quadtree/fxParams';
import { ParamRow, NumberBox } from './Params';
import {
    EquationEditor, SplineEditor, TextDynamic, CurveConvert, UsedVariables, VariableInspector, SplinePointList, PointOf,
} from './Maths';
import ManifoldEditor from './Manifold';
import { variableLabel } from '../model/globals';
import { useComp, useTick } from './context';
import { ICONS } from './Sidebar';
import styles from '../compositor.module.css';

/**
 * A collapsible group of controls. Every group starts collapsed; one opened
 * stays open for that object (`owner`) until it is closed, kept with the
 * project (see Compositor's groupOpen). `id` names it when its title changes.
 */
function Group({
    title, id, owner, children, hint,
}) {
    const comp = useComp();
    const key = `${owner || 'any'}:${id || title}`;
    const [open, setOpenState] = useState(() => comp.groupOpen(key));
    const setOpen = (v) => { setOpenState(v); comp.setGroupOpen(key, v); };
    return (
        <div className={styles.group}>
            <button type="button" className={styles.groupHead} onClick={() => setOpen(!open)}>
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {title}
            </button>
            {open && (
                <div className={styles.groupBody}>
                    {hint && <p className={styles.hint}>{hint}</p>}
                    {children}
                </div>
            )}
        </div>
    );
}

function Field({ label, children }) {
    return (
        <div className={styles.row}>
            <span className={styles.rowLabel}>{label}</span>
            <span style={{ gridColumn: '2 / 4', display: 'flex', gap: 6, alignItems: 'center' }}>{children}</span>
        </div>
    );
}

// ---- Custom editors -----------------------------------------------------------

function CameraPath({ obj }) {
    const comp = useComp();
    const path = obj.extra?.path || [];
    const recording = comp.recordingId === obj.id;
    const span = path.length ? `${path[0].t.toFixed(2)}s – ${path[path.length - 1].t.toFixed(2)}s` : 'none';
    return (
        <>
            <p className={styles.hint}>Fly the orbit camera while playing to record its path (WASD, Q/E, shift).</p>
            <Field label="Recorded">{`${path.length} samples · ${span}`}</Field>
            <div className={styles.wideRow}>
                <button type="button" className={`${styles.btn} ${recording ? styles.btnRecOn : styles.btnRec}`} onClick={() => comp.toggleRecord(obj.id)}>
                    {recording ? <Square size={11} /> : <Circle size={11} />}
                    {recording ? 'Stop' : 'Record path'}
                </button>
                <button type="button" className={styles.btn} disabled={!path.length} onClick={() => comp.updateObject(obj.id, (o) => ({ ...o, extra: { ...o.extra, path: [] } }), true)}>
                    Clear
                </button>
            </div>
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} onClick={() => comp.cameraFromView(obj.id)}>Place at view</button>
                <button type="button" className={styles.btn} onClick={() => comp.viewFromCamera(obj.id)}>Look through</button>
            </div>
        </>
    );
}

function PoseEditor({ obj }) {
    const comp = useComp();
    const sack = obj.type === 'sackboy';
    const joints = sack ? SACKBOY_JOINT_MENU : JOINTS;
    const [joint, setJoint] = useState(joints[0][0]);
    const pose = obj.extra?.pose || {};
    const angles = pose[joint] || [0, 0, 0];
    const presets = sack ? SACKBOY_POSES : POSES;
    const applyPreset = (id) => comp.updateObject(obj.id, (o) => {
        if (sack) {
            const made = SACKBOY_POSES[id].make();
            return { ...o, params: { ...o.params, ...made.op }, extra: { ...o.extra, pose: made.pose } };
        }
        const made = POSES[id].make(bodyDims(specOf({ ...MODEL_DEFAULTS, ...o.params }).body));
        return { ...o, params: { ...o.params, ...made.op }, extra: { ...o.extra, pose: made.pose } };
    }, true);
    const setAngle = (i) => (v) => comp.updateObject(obj.id, (o) => {
        const cur = [...((o.extra?.pose || {})[joint] || [0, 0, 0])];
        cur[i] = v;
        return { ...o, extra: { ...o.extra, pose: { ...(o.extra?.pose || {}), [joint]: cur } } };
    }, false, `pose:${obj.id}:${joint}:${i}`);
    return (
        <>
            <div className={styles.wideRow}>
                {Object.entries(presets).map(([id, p]) => (
                    <button key={id} type="button" className={styles.btn} onClick={() => applyPreset(id)}>{p.name}</button>
                ))}
            </div>
            <div className={styles.row} style={{ marginTop: 8 }}>
                <span className={styles.rowLabel}>Joint</span>
                <select className={styles.select} value={joint} onChange={(e) => setJoint(e.target.value)}>
                    {joints.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
            </div>
            {['Pitch (X)', 'Yaw (Y)', 'Roll (Z)'].map((label, i) => (
                <ParamRow
                    key={label}
                    def={{ key: `j${i}`, label, type: 'number', min: -180, max: 180, step: 0.5, def: 0, link: false }}
                    value={angles[i]}
                    onChange={setAngle(i)}
                    onCommit={comp.commit}
                />
            ))}
        </>
    );
}

function ScreenSource({ obj }) {
    const comp = useComp();
    const fileRef = useRef(null);
    return (
        <>
            <Field label="Video">
                <select className={styles.select} value={obj.params.video || ''} onChange={(e) => comp.setParam(obj.id, 'video', e.target.value || null, true)}>
                    <option value="">None</option>
                    {comp.takes.map((t) => <option key={t.id} value={`take:${t.id}`}>Take · {t.label}</option>)}
                    {PUBLIC_VIDEOS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    {comp.uploads.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
            </Field>
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} onClick={() => fileRef.current.click()}>Upload video…</button>
            </div>
            <input
                ref={fileRef}
                type="file"
                accept="video/*"
                style={{ display: 'none' }}
                onChange={async (e) => {
                    const f = e.target.files[0];
                    e.target.value = '';
                    if (f) comp.setParam(obj.id, 'video', await comp.uploadScreenVideo(f), true);
                }}
            />
        </>
    );
}

function WindowMatte({ obj }) {
    const comp = useComp();
    // A placed window holds to its own take's mattes; an effect's windows
    // (a Blob Tracker's) to whichever take is showing, so every take's are offered.
    const scenes = obj.sceneId ? comp.project.scenes.filter((s) => s.id === obj.sceneId) : comp.project.scenes;
    const takes = Array.from(new Set(scenes.map((s) => s.take).filter(Boolean)));
    const list = takes.flatMap((take) => mattesFor(take).map((m) => ({ ...m, label: takes.length > 1 ? `${take} · ${m.label || m.id}` : m.label })));
    if (!list.length) return <p className={styles.hint}>{obj.sceneId ? 'No mattes yet.' : 'No take has mattes yet.'} Make them under Roto in the Take.</p>;
    return (
        <>
            <Field label="Matte">
                <select className={styles.select} value={obj.params.matte || ''} onChange={(e) => comp.setParam(obj.id, 'matte', e.target.value, true)}>
                    <option value="">None</option>
                    {list.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
                </select>
            </Field>
            {obj.params.matte && (
                <Field label="Keep">
                    <select className={styles.select} value={obj.params.matteMode} onChange={(e) => comp.setParam(obj.id, 'matteMode', e.target.value, true)}>
                        <option value="inside">Inside the object</option>
                        <option value="outside">Outside it</option>
                    </select>
                </Field>
            )}
        </>
    );
}

/**
 * Which picture a picture effect (a quad tree, a pixel sort) runs on: the
 * whole program, or one video track while it shows.
 */
function EffectTarget({ obj, paramKey = 'target' }) {
    const comp = useComp();
    const tracks = comp.project.tracks.filter((t) => t.kind === 'video');
    const target = obj.params[paramKey] || 'program';
    return (
        <Field label="Apply to">
            <select className={styles.select} value={target} onChange={(e) => comp.setParam(obj.id, paramKey, e.target.value, true)}>
                <option value="program">Whole program</option>
                {tracks.map((t) => <option key={t.id} value={t.id}>{`Track ${t.name}`}</option>)}
                {target !== 'program' && !tracks.some((t) => t.id === target) && <option value={target}>Missing track</option>}
            </select>
        </Field>
    );
}

/**
 * A quad tree's source and look: for the effect, which picture it runs on
 * (the whole program, or one video track while it shows); for both it and a
 * window, a Quad Trees preset to load. A preset's own seed is never used: the
 * picture here is the seed.
 */
function QuadTreePanel({ obj }) {
    const comp = useComp();
    const fileRef = useRef(null);
    const [presets, setPresets] = useState(null);
    const [msg, setMsg] = useState('');
    React.useEffect(() => { listPresets().then(setPresets); }, []);
    const apply = (pr, name) => {
        comp.updateObject(obj.id, (o) => ({
            ...o,
            params: { ...o.params, ...presetToParams(pr.settings), ...(o.type !== 'quadtree' ? { qt_on: true } : {}) },
        }), true);
        setMsg(`Loaded ${name}. Links on its parameters are kept.`);
    };
    return (
        <>
            {obj.type === 'quadtree' && <EffectTarget obj={obj} paramKey="qt_target" />}
            <Field label="Preset">
                {presets ? (
                    <select
                        className={styles.select}
                        value=""
                        onChange={async (e) => {
                            const name = e.target.value;
                            if (!name) return;
                            try { apply(await loadPreset(name), name); } catch (err) { setMsg(err.message); }
                        }}
                    >
                        <option value="">{presets.length ? 'Load…' : 'None saved yet'}</option>
                        {presets.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                    </select>
                ) : (
                    <button type="button" className={styles.btn} onClick={() => fileRef.current.click()}>Open preset…</button>
                )}
            </Field>
            <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try { const pr = await readPresetFile(f); apply(pr, pr.name); } catch (err) { setMsg(err.message); }
                }}
            />
            {msg && <p className={styles.hint}>{msg}</p>}
        </>
    );
}

/** A row of handle picks for corner editing. */
function HandlePick({ labels }) {
    const comp = useComp();
    return (
        <div className={styles.seg5} style={{ gridTemplateColumns: `repeat(${labels.length}, 1fr)` }}>
            {labels.map(([i, label]) => (
                <button key={i} type="button" className={`${styles.btn} ${comp.cornerHandle === i ? styles.btnOn : ''}`} onClick={() => comp.setCornerHandle(i)}>
                    {label}
                </button>
            ))}
        </div>
    );
}

const QUAD_HANDLES = [[0, 'TL'], [1, 'TR'], [2, 'BR'], [3, 'BL'], [4, 'All']];

function WindowCorners() {
    return (
        <>
            <p className={styles.hint}>Click a marker to pick it; blue moves them all.</p>
            <HandlePick labels={QUAD_HANDLES} />
        </>
    );
}

function PulseShape({ obj }) {
    const comp = useComp();
    const mode = obj.params.pulseMode;
    const key = mode === 'plane' ? 'pulsePlane' : 'pulseLine';
    const editing = comp.cornerOn === obj.id;
    const place = (which) => {
        const pts = comp.pulsePreset(obj.sceneId, mode, which);
        if (pts) comp.setParam(obj.id, key, pts, true);
    };
    // A plane or line has to exist before it can pulse from it.
    const missing = !obj.params[key];
    React.useEffect(() => {
        if (!missing) return undefined;
        const id = setTimeout(() => place(mode === 'plane' ? 'flat' : 'upright'), 50);
        return () => clearTimeout(id);
    });
    const presets = mode === 'plane'
        ? [['flat', 'Flat'], ['facing', 'Facing camera'], ['upright', 'Upright']]
        : [['upright', 'Upright'], ['across', 'Across frame'], ['into', 'Into frame']];
    return (
        <>
            <p className={styles.hint}>Set from the current camera.</p>
            <div className={styles.wideRow}>
                {presets.map(([id, label]) => <button key={id} type="button" className={styles.btn} onClick={() => place(id)}>{label}</button>)}
            </div>
            <ParamRow
                def={{ key: 'edit', label: 'Edit in viewport', type: 'bool', link: false }}
                value={editing}
                onChange={(v) => comp.setCornerOn(v ? obj.id : null)}
            />
            {editing && <HandlePick labels={mode === 'plane' ? [[0, 'A'], [1, 'B'], [2, 'C'], [4, 'All']] : [[0, 'A'], [1, 'B'], [4, 'All']]} />}
        </>
    );
}

function LibraryPanel({ obj }) {
    const comp = useComp();
    const entry = comp.library.assets.find((a) => a.id === obj.params.assetId);
    const rec = comp.propModel(obj.id);
    const screen = entry ? { ...DEFAULT_SCREEN, ...(entry.screen || {}) } : null;
    const setEntry = (k, save = true) => (v) => comp.editAsset(entry.id, (a) => ({ ...a, [k]: v }), save);
    const setScreen = (k, save = true) => (v) => comp.editAsset(entry.id, (a) => ({ ...a, screen: { ...DEFAULT_SCREEN, ...a.screen, [k]: v } }), save);
    const editing = comp.cornerOn === obj.id;
    const note = {
        saving: 'Saving…',
        repo: 'Saved to src/data/scanAssetLibrary.json.',
        browser: 'Saved in this browser only (no dev server). Download the JSON and drop it over src/data/scanAssetLibrary.json to keep it.',
    }[comp.librarySaved];
    return (
        <>
            <Field label="Asset">
                <select className={styles.select} value={obj.params.assetId} onChange={(e) => comp.setParam(obj.id, 'assetId', e.target.value, true)}>
                    {!entry && <option value={obj.params.assetId}>{obj.params.assetId || 'None'}</option>}
                    {CATEGORIES.map((cat) => (
                        <optgroup key={cat.id} label={cat.name}>
                            {comp.library.assets.filter((a) => a.category === cat.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </optgroup>
                    ))}
                </select>
            </Field>
            {screen && obj.params.assetId && (
                <>
                    <p className={styles.hint} style={{ marginTop: 8 }}>
                        {`Changes apply to every ${entry.name}.`}
                        {entry.credit ? ` ${entry.credit}.` : ''}
                    </p>
                    <Field label="Category">
                        <select className={styles.select} value={entry.category} onChange={(e) => setEntry('category')(e.target.value)}>
                            {CATEGORIES.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                        </select>
                    </Field>
                    <ParamRow
                        def={{ key: 'size', label: 'Size (m)', type: 'number', min: 0.02, max: 3, step: 0.005, link: false }}
                        value={entry.size}
                        onChange={setEntry('size', false)}
                        onCommit={comp.saveLibraryNow}
                    />
                    {entry.category === 'screen' && (
                        <>
                            <ParamRow
                                def={{ key: 'edit', label: 'Edit screen corners', type: 'bool', link: false }}
                                value={editing}
                                onChange={(v) => comp.setCornerOn(v ? obj.id : null)}
                            />
                            {editing && <HandlePick labels={QUAD_HANDLES} />}
                            {rec?.parts?.length > 0 && (
                                <Field label="Fit to part">
                                    <select
                                        className={styles.select}
                                        value=""
                                        onChange={(e) => {
                                            const part = rec.parts[parseInt(e.target.value, 10)];
                                            const corners = part && fitCornersToMesh(part.mesh, rec.norm);
                                            if (corners) setScreen('corners')(corners);
                                        }}
                                    >
                                        <option value="">Pick a part…</option>
                                        {rec.parts.map((pt, i) => (
                                            // eslint-disable-next-line react/no-array-index-key
                                            <option key={i} value={i}>{pt.name}{pt.material ? ` (${pt.material})` : ''}</option>
                                        ))}
                                    </select>
                                </Field>
                            )}
                            <ParamRow
                                def={{ key: 'lift', label: 'Lift off surface', type: 'number', min: 0, max: 0.05, step: 0.0001, link: false }}
                                value={screen.lift}
                                onChange={setScreen('lift', false)}
                                onCommit={comp.saveLibraryNow}
                            />
                            <Field label="Default fit">
                                <select className={styles.select} value={screen.fit} onChange={(e) => setScreen('fit')(e.target.value)}>
                                    <option value="cover">Cover</option>
                                    <option value="contain">Contain</option>
                                    <option value="stretch">Stretch</option>
                                </select>
                            </Field>
                        </>
                    )}
                    <div className={styles.wideRow}>
                        <button type="button" className={styles.btn} onClick={comp.saveLibraryNow}>Save library</button>
                        <button type="button" className={styles.btn} onClick={comp.downloadLibrary}>Download .json</button>
                    </div>
                    {note && <p className={styles.hint} style={{ marginTop: 6 }}>{note}</p>}
                </>
            )}
        </>
    );
}

function ScanLook({ obj }) {
    const comp = useComp();
    const scene = comp.project.scenes.find((s) => s.id === obj.sceneId);
    const take = scene?.take;
    if (!take) return null;
    const look = normaliseLook(comp.looks[take]);
    const same = Object.keys(LOOK_DEFAULTS).every((k) => look.mesh[k] === look.points[k]);
    const note = {
        saving: 'Saving\u2026',
        repo: 'Saved to src/data/takeLooks.json.',
        browser: 'Saved in this browser only (no dev server to write the file).',
    }[comp.looksSaved];
    return (
        <>
            {LOOK_PARTS.map(([part, title]) => (
                <div key={part}>
                    <p className={styles.subTitle}>{title}</p>
                    {LOOK_FIELDS.map(([key, label, min, max, step]) => (
                        <ParamRow
                            key={key}
                            def={{ key, label, type: 'number', min, max, step, def: LOOK_DEFAULTS[key], link: false }}
                            value={look[part][key]}
                            onChange={(v) => comp.setLook(take, { [part]: { [key]: v } })}
                            onCommit={comp.saveLooksNow}
                        />
                    ))}
                    <div className={styles.wideRow}>
                        <button type="button" className={styles.btn} disabled={isNeutralLook(look[part])} onClick={() => comp.setLook(take, { [part]: null }, true)}>Reset</button>
                        {part === 'points' && (
                            <button type="button" className={styles.btn} disabled={same} onClick={() => comp.setLook(take, { points: { ...look.mesh } }, true)}>Match the mesh</button>
                        )}
                    </div>
                </div>
            ))}
            {note && <p className={styles.hint} style={{ marginTop: 6 }}>{note}</p>}
        </>
    );
}

function RotoSection({ obj }) {
    const comp = useComp();
    const scene = comp.project.scenes.find((s) => s.id === obj.sceneId);
    const take = scene?.take;
    const rig = comp.rig(scene?.id);
    const track = rig?.track && !rig.track.unsolved ? rig.track : null;
    const [frame, setFrame] = useState(0);
    const frameRef = useRef(0);
    useTick((t) => {
        const f = comp.takeFrameAt(take, t);
        if (f != null && f !== frameRef.current) {
            frameRef.current = f;
            setFrame(f);
        }
    });
    const on = comp.roto.on && comp.roto.take === take;
    // Leaving the panel leaves Roto mode.
    const { setRoto } = comp;
    React.useEffect(() => () => setRoto((r) => (r.take === take ? { ...r, on: false } : r)), [take, setRoto]);
    if (!take) return null;
    const mattesOff = obj.params.mattesOn === false && !obj.links?.mattesOn && mattesFor(take).length > 0;
    return (
        <>
            {mattesOff && (
                <div className={styles.warnBox}>
                    <p className={styles.hint} style={{ margin: 0 }}>
                        Mattes are off for this take.
                    </p>
                    <button type="button" className={styles.btn} onClick={() => comp.setParam(obj.id, 'mattesOn', true, true)}>Turn on</button>
                </div>
            )}
        <RotoEditor
            take={take}
            info={track ? { fps: track.fps, frames: track.frame_count } : null}
            frame={frame}
            seekFrame={(f) => comp.seekTakeFrame(take, f)}
            active={on}
            setActive={(v) => setRoto((r) => ({ ...r, on: v, take }))}
            plain={comp.roto.plain}
            setPlain={(v) => setRoto((r) => ({ ...r, plain: v }))}
            mountEl={comp.stageEl}
            holdout={obj.extra?.matteHoldout || {}}
            // Asking for a holdout means wanting mattes at all.
            setHoldout={(id, v) => comp.updateObject(obj.id, (o) => ({
                ...o,
                params: v ? { ...o.params, mattesOn: true } : o.params,
                extra: { ...o.extra, matteHoldout: { ...(o.extra?.matteHoldout || {}), [id]: v } },
            }), true)}
            onWritten={() => comp.setStatus('Mattes written')}
        />
        </>
    );
}

const CUSTOM = {
    cameraPath: CameraPath,
    pose: PoseEditor,
    screenSource: ScreenSource,
    windowMatte: WindowMatte,
    roto: RotoSection,
    scanLook: ScanLook,
    library: LibraryPanel,
    windowCorners: WindowCorners,
    pulseShape: PulseShape,
    quadTree: QuadTreePanel,
    effectTarget: EffectTarget,
    equation: EquationEditor,
    splinePoints: SplineEditor,
    splinePointList: SplinePointList,
    pointOf: PointOf,
    textDynamic: TextDynamic,
    curveConvert: CurveConvert,
    usedVariables: UsedVariables,
    manifold: ManifoldEditor,
};

// ---- Objects ---------------------------------------------------------------------

function ObjectInspector({ obj }) {
    const comp = useComp();
    const type = OBJECT_TYPES[obj.type];
    const Icon = ICONS[obj.type] || Circle;
    const p = obj.params;
    const isScreen = obj.type === 'prop' && comp.library.assets.find((a) => a.id === p.assetId)?.category === 'screen';
    const effectIndex = !obj.sceneId ? comp.project.objects.filter((o) => !o.sceneId).findIndex((o) => o.id === obj.id) : -1;
    return (
        <>
            <div className={styles.insHead}>
                <span className={styles.olIcon}><Icon size={13} /></span>
                <input className={styles.insName} value={obj.name} onChange={(e) => comp.updateObject(obj.id, (o) => ({ ...o, name: e.target.value }), false, `name:${obj.id}`)} onBlur={comp.commit} />
                <span className={styles.insKind}>{type.label}</span>
                {effectIndex >= 0 && (
                    <>
                        <button type="button" className={styles.olToggle} title="Earlier in the chain" onClick={() => comp.moveEffect(obj.id, -1)}><ArrowUp size={12} /></button>
                        <button type="button" className={styles.olToggle} title="Later in the chain" onClick={() => comp.moveEffect(obj.id, 1)}><ArrowDown size={12} /></button>
                    </>
                )}
                {!type.unique && (
                    <>
                        {!type.child && <button type="button" className={styles.olToggle} title="Duplicate" onClick={() => comp.duplicateObject(obj.id)}><Copy size={12} /></button>}
                        <button type="button" className={styles.olToggle} title={type.child ? 'Delete (and the point with it)' : 'Delete'} onClick={() => comp.removeObject(obj.id)}><Trash2 size={12} /></button>
                    </>
                )}
            </div>
            {type.groups.map((g) => {
                if (g.screenOnly && !isScreen) return null;
                if (g.when && !g.when(p)) return null;
                const params = (g.params || []).filter((d) => !d.when || d.when(p));
                const Custom = g.custom ? CUSTOM[g.custom] : null;
                if (!params.length && !Custom) return null;
                return (
                    <Group key={`${obj.id}:${g.title}`} owner={obj.id} title={g.title} hint={g.hint}>
                        {Custom && <Custom obj={obj} />}
                        {params.map((d) => (
                            <ParamRow
                                key={d.key}
                                def={d}
                                value={p[d.key]}
                                link={obj.links?.[d.key]}
                                onChange={(v) => comp.setParam(obj.id, d.key, v)}
                                onLink={(l) => comp.setLink(obj.id, d.key, l)}
                                onCommit={comp.commit}
                            />
                        ))}
                    </Group>
                );
            })}
        </>
    );
}

// ---- Controllers -------------------------------------------------------------------

function Meter({ ctrl }) {
    const ref = useRef(null);
    useTick((t, frame) => {
        if (!ref.current || !frame) return;
        ref.current.style.width = `${Math.round(frame.value(ctrl.id) * 100)}%`;
    });
    return (
        <div className={styles.progress} style={{ height: 6 }}>
            <div ref={ref} className={styles.progressBar} style={{ background: ctrl.color, width: 0 }} />
        </div>
    );
}

function SwitchTools({ ctrl }) {
    const comp = useComp();
    const { project } = comp;
    const kicks = project.controllers.filter((c) => c.type === 'kick');
    const [src, setSrc] = useState(kicks[0]?.id || 'grid');
    const [every, setEvery] = useState(1);
    const [bpm, setBpm] = useState(120);
    const [beats, setBeats] = useState(1);
    const [offset, setOffset] = useState(0);
    const [order, setOrder] = useState('cycle');
    const [use, setUse] = useState(() => ctrl.states.map((_, i) => i));
    const [range, setRange] = useState('all');
    const setStates = (states) => comp.updateController(ctrl.id, (c) => ({
        ...c, states, cuts: c.cuts.map((x) => ({ ...x, s: Math.min(x.s, states.length - 1) })),
    }), true);
    const fill = () => {
        const end = comp.duration;
        const [t0, t1] = range === 'all' ? [0, end] : [comp.now(), end];
        const music = comp.analysis?.music;
        let times;
        if (src === 'grid') times = gridCutTimes({ bpm, offset, beats, t0, t1 });
        else {
            const kick = project.controllers.find((c) => c.id === src);
            if (!kick || !music) { comp.setStatus('Fill from kicks needs a kick controller and audio on the timeline'); return; }
            times = kickCutTimes(kick, music, { every, t0, t1 });
        }
        const states = use.filter((i) => i < ctrl.states.length);
        const cuts = assignStates(times, states.length ? states : [0], order, ctrl.id.length * 7919);
        comp.updateController(ctrl.id, (c) => ({ ...c, cuts: mergeCuts(c, cuts, t0, t1, comp.newCutId) }), true);
        comp.setStatus(`${cuts.length} cuts`);
    };
    const now = switchAt(ctrl, comp.now());
    return (
        <>
            <Group owner={ctrl.id} id="states" title={ctrl.type === 'text' ? 'Texts' : 'States'}>
                {ctrl.type === 'text' && (
                    <p className={styles.hint}>Cut between texts in its lane. Show the current one with a text variable, as {'{{τ}}'}.</p>
                )}
                <Field label="Starts at">
                    <select
                        className={styles.select}
                        value={ctrl.cuts.find((c) => c.t <= 0)?.s ?? 0}
                        onChange={(e) => {
                            const st = Number(e.target.value);
                            comp.updateController(ctrl.id, (c) => {
                                // Shift every state after it by the same step, so the
                                // cuts downstream keep their pattern.
                                const n = c.states.length;
                                const old = c.cuts.find((k) => k.t <= 0)?.s ?? 0;
                                const d = st - old;
                                const cuts = c.cuts.some((k) => k.t <= 0) ? c.cuts : [{ id: comp.newCutId(), t: 0, s: 0 }, ...c.cuts];
                                return { ...c, cuts: cuts.map((k) => ({ ...k, s: (((k.s + d) % n) + n) % n })) };
                            }, true);
                        }}
                    >
                        {ctrl.states.map((nm, i) => <option key={i} value={i}>{nm}</option>)}
                    </select>
                </Field>
                {ctrl.states.map((s, i) => (
                    <div key={i} className={styles.row}>
                        <span className={styles.rowLabel}>{i === now ? '▶ ' : ''}{ctrl.type === 'text' ? 'Text' : 'State'} {i + 1}</span>
                        <input
                            className={styles.num}
                            style={{ textAlign: 'left' }}
                            value={s}
                            onChange={(e) => setStates(ctrl.states.map((x, k) => (k === i ? e.target.value : x)))}
                        />
                        <button type="button" className={styles.olToggle} disabled={ctrl.states.length <= 2} onClick={() => setStates(ctrl.states.filter((_, k) => k !== i))} title="Remove state">
                            <Trash2 size={11} />
                        </button>
                    </div>
                ))}
                <div className={styles.wideRow}>
                    <button type="button" className={styles.btn} onClick={() => setStates([...ctrl.states, ctrl.type === 'text' ? `Text ${ctrl.states.length + 1}` : String.fromCharCode(65 + ctrl.states.length)])}>{ctrl.type === 'text' ? 'Add text' : 'Add state'}</button>
                </div>
                <p className={styles.hint} style={{ marginTop: 8 }}>At the playhead: S for the next state, 1-9 for one.</p>
                <div className={styles.wideRow}>
                    {ctrl.states.map((s, i) => (
                        <button key={i} type="button" className={styles.btn} onClick={() => comp.cutSwitch(ctrl.id, i)}>
                            <Scissors size={11} /> {s}
                        </button>
                    ))}
                </div>
            </Group>
            <Group owner={ctrl.id} title="Auto-cut">
                <Field label="From">
                    <select className={styles.select} value={src} onChange={(e) => setSrc(e.target.value)}>
                        {kicks.map((k) => <option key={k.id} value={k.id}>Kicks · {k.name}</option>)}
                        <option value="grid">Tempo grid</option>
                    </select>
                </Field>
                {src === 'grid' ? (
                    <>
                        <Field label="BPM"><NumberBox value={bpm} step={0.001} onCommit={setBpm} /></Field>
                        <Field label="Every (beats)"><NumberBox value={beats} step={0.25} onCommit={setBeats} /></Field>
                        <Field label="Offset (s)"><NumberBox value={offset} step={0.001} onCommit={setOffset} /></Field>
                    </>
                ) : (
                    <Field label="Every Nth"><NumberBox value={every} step={1} onCommit={(v) => setEvery(Math.max(1, Math.round(v)))} /></Field>
                )}
                <Field label="Order">
                    <select className={styles.select} value={order} onChange={(e) => setOrder(e.target.value)}>
                        <option value="cycle">In turn</option>
                        <option value="shuffle">Shuffle</option>
                    </select>
                </Field>
                <Field label="States">
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {ctrl.states.map((s, i) => (
                            <button key={i} type="button" className={`${styles.btn} ${use.includes(i) ? styles.btnOn : ''}`} style={{ height: 22 }} onClick={() => setUse(use.includes(i) ? use.filter((x) => x !== i) : [...use, i].sort())}>
                                {s}
                            </button>
                        ))}
                    </span>
                </Field>
                <Field label="Range">
                    <select className={styles.select} value={range} onChange={(e) => setRange(e.target.value)}>
                        <option value="all">Whole timeline</option>
                        <option value="after">From the playhead on</option>
                    </select>
                </Field>
                <div className={styles.wideRow}>
                    <button type="button" className={styles.btn} onClick={fill}>Fill</button>
                    <button type="button" className={styles.btn} onClick={() => comp.updateController(ctrl.id, (c) => ({ ...c, cuts: [{ id: comp.newCutId(), t: 0, s: 0 }] }), true)}>Clear cuts</button>
                </div>
            </Group>
        </>
    );
}

function KeyTools({ ctrl }) {
    const comp = useComp();
    const [v, setV] = useState(1);
    return (
        <Group owner={ctrl.id} title="Keys">
            <p className={styles.hint}>Click the lane to add, drag to move, double-click to delete.</p>
            <ParamRow
                def={{ key: 'v', label: 'Value', type: 'number', min: 0, max: 1, step: 0.01, link: false }}
                value={v}
                onChange={setV}
            />
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} onClick={() => comp.addKey(ctrl.id, comp.now(), v)}>Key at playhead</button>
                <button type="button" className={styles.btn} onClick={() => comp.updateController(ctrl.id, (c) => ({ ...c, keys: [] }), true)}>Clear</button>
            </div>
            <Field label="Keys">{ctrl.keys.length}</Field>
        </Group>
    );
}

const OP_WORD = { and: 'AND', or: 'OR', xor: 'XOR' };

/** A Logic's inputs: each a Switch (or another Logic) in a state, optionally NOT-ed. */
function LogicTools({ ctrl }) {
    const comp = useComp();
    const all = comp.project.controllers;
    const lookup = (id) => all.find((c) => c.id === id);
    // Not itself, nor anything that already reads it: that would be a loop.
    const choices = all.filter((c) => isSwitch(c) && !dependsOn(c, ctrl.id, lookup));
    const inputs = ctrl.inputs || [];
    const setInputs = (fn) => comp.updateController(ctrl.id, (c) => ({ ...c, inputs: fn(c.inputs || []) }), true);
    const setInput = (i, patch) => setInputs((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    const onState = (c) => Math.min(1, (c?.states?.length || 1) - 1);
    const add = () => {
        const c = choices.find((o) => !inputs.some((x) => x.controller === o.id)) || choices[0];
        if (c) setInputs((list) => [...list, { controller: c.id, state: onState(c), not: false }]);
    };
    const word = OP_WORD[ctrl.params.op] || 'AND';
    return (
        <Group owner={ctrl.id} title="Inputs">
            <p className={styles.hint}>Each input is a Switch in a state; NOT flips it.</p>
            {inputs.map((inp, i) => {
                const c = lookup(inp.controller);
                return (
                    // eslint-disable-next-line react/no-array-index-key
                    <React.Fragment key={i}>
                        {i > 0 && <div className={styles.logicOp}>{word}</div>}
                        <div className={styles.logicRow}>
                            <button
                                type="button"
                                className={`${styles.btn} ${inp.not ? styles.btnOn : ''}`}
                                aria-pressed={!!inp.not}
                                title="NOT: true when it is not in this state"
                                onClick={() => setInput(i, { not: !inp.not })}
                            >
                                NOT
                            </button>
                            <select
                                className={styles.select}
                                value={inp.controller}
                                onChange={(e) => { const n = lookup(e.target.value); setInput(i, { controller: n.id, state: onState(n) }); }}
                            >
                                {!c && <option value={inp.controller}>(missing)</option>}
                                {c && !choices.includes(c) && <option value={c.id}>{c.name}</option>}
                                {choices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                            </select>
                            <select
                                className={styles.select}
                                value={inp.state ?? onState(c)}
                                onChange={(e) => setInput(i, { state: parseInt(e.target.value, 10) })}
                                title="The state it has to be in"
                            >
                                {(c?.states || []).map((s, k) => <option key={s + k} value={k}>is {s}</option>)}
                            </select>
                            <button type="button" className={styles.olToggle} title="Remove input" onClick={() => setInputs((list) => list.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
                        </div>
                    </React.Fragment>
                );
            })}
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} disabled={!choices.length} onClick={add}>Add input</button>
            </div>
            {!choices.length && <p className={styles.hint}>Make a Switch first.</p>}
            {choices.length > 0 && inputs.length < 2 && <p className={styles.hint}>Needs two or more inputs.</p>}
        </Group>
    );
}

function ControllerInspector({ ctrl }) {
    const comp = useComp();
    const type = CONTROLLER_TYPES[ctrl.type];
    const uses = linksTo(comp.project, ctrl.id);
    const params = type.params.filter((d) => !d.when || d.when(ctrl.params));
    return (
        <>
            <div className={styles.insHead}>
                <span className={styles.swatch} style={{ background: ctrl.color, width: 10, height: 10 }} />
                <input className={styles.insName} value={ctrl.name} onChange={(e) => comp.updateController(ctrl.id, (c) => ({ ...c, name: e.target.value }), false, `cname:${ctrl.id}`)} onBlur={comp.commit} />
                <span className={styles.insKind}>{type.label}</span>
                <button type="button" className={styles.olToggle} title="Delete" onClick={() => comp.removeController(ctrl.id)}><Trash2 size={12} /></button>
            </div>
            <div className={styles.groupBody} style={{ paddingTop: 8 }}>
                <Meter ctrl={ctrl} />
                <div style={{ display: 'flex', gap: 4 }}>
                    {CONTROLLER_COLORS.map((c) => (
                        <button
                            key={c}
                            type="button"
                            aria-label={`Colour ${c}`}
                            onClick={() => comp.updateController(ctrl.id, (x) => ({ ...x, color: c }), true)}
                            style={{ width: 16, height: 16, background: c, border: ctrl.color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', padding: 0 }}
                        />
                    ))}
                </div>
            </div>
            {params.length > 0 && (
                <Group owner={ctrl.id} title="Signal">
                    {(ctrl.type === 'kick' || ctrl.type === 'band') && !comp.analysis?.music && (
                        <p className={styles.hint}>Put music on an audio track.</p>
                    )}
                    {params.map((d) => (
                        <ParamRow
                            key={d.key}
                            def={{ ...d, link: false }}
                            value={ctrl.params[d.key]}
                            onChange={(v) => comp.updateController(ctrl.id, (c) => ({ ...c, params: { ...c.params, [d.key]: v } }), false, `cp:${ctrl.id}:${d.key}`)}
                            onCommit={comp.commit}
                        />
                    ))}
                </Group>
            )}
            {isCut(ctrl) && <SwitchTools ctrl={ctrl} />}
            {ctrl.type === 'logic' && <LogicTools ctrl={ctrl} />}
            {ctrl.type === 'keys' && <KeyTools ctrl={ctrl} />}
            <Group owner={ctrl.id} id="linked" title={`Linked (${uses.length})`}>
                {!uses.length && <p className={styles.hint}>Nothing linked. Right-click a control to link it.</p>}
                {uses.map(({ owner, key, variable }) => {
                    const isTrack = !!owner.kind;
                    let label;
                    if (variable) label = 'Value';
                    else if (isTrack) label = (owner.kind === 'audio' ? AUDIO_TRACK_PARAMS : TRACK_PARAMS).find((d) => d.key === key)?.label;
                    else label = paramDefs(owner.type).get(key)?.label;
                    return (
                        <div
                            key={`${owner.id}:${key}`}
                            className={styles.olRow}
                            style={{ '--depth': 0 }}
                            onClick={() => comp.select({ kind: variable ? 'variable' : isTrack ? 'track' : 'object', id: owner.id })}
                        >
                            <span className={styles.olName}>{variable ? `Variable ${variableLabel(owner)}` : owner.name}</span>
                            <span className={styles.olTag}>{label || key}</span>
                        </div>
                    );
                })}
            </Group>
        </>
    );
}

// ---- Clips, tracks, media -----------------------------------------------------------

/**
 * Which camera a 3D clip films through: one, fixed, or whichever a Switch
 * picks state by state, so the Switch's cuts on the timeline cut the view.
 */
function CameraPick({
    clip, media, cams, set,
}) {
    const comp = useComp();
    const switches = comp.project.controllers.filter(isSwitch);
    const sw = clip.cameraSwitch;
    const ctrl = sw && switches.find((c) => c.id === sw.controller);
    const fixed = clip.camera || (media.kind === 'take' ? 'solve' : (cams[0]?.id || ''));
    const options = (
        <>
            {media.kind === 'take' && <option value="solve">The take&apos;s solve</option>}
            {cams.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </>
    );
    const setSwitch = (v) => { set('cameraSwitch')(v); comp.commit(); };
    const pool = [...(media.kind === 'take' ? ['solve'] : []), ...cams.map((x) => x.id)];
    const follow = (c, keep = true) => setSwitch({
        controller: c.id,
        map: Object.fromEntries(c.states.map((_, i) => [i, (keep && sw?.map?.[i]) || pool[i % Math.max(1, pool.length)]])),
    });
    // A Switch made for this: one state per camera, named after it.
    const newCameraSwitch = () => {
        const c = comp.addController('switch');
        const states = pool.map((id) => (id === 'solve' ? 'Solve' : cams.find((x) => x.id === id)?.name || 'Camera'));
        const next = { ...c, name: 'Cameras', states: states.length >= 2 ? states : [...states, 'B'] };
        comp.updateController(c.id, () => next, true);
        follow(next, false);
    };
    const [menu, setMenu] = useState(null);
    return (
        <>
            {menu && (
                <CameraMenu
                    at={menu}
                    switches={switches}
                    current={ctrl?.id}
                    onFollow={(c) => follow(c)}
                    onNew={newCameraSwitch}
                    onFixed={() => setSwitch(undefined)}
                    onClose={() => setMenu(null)}
                />
            )}
            <div onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} title="Right-click to cut between cameras with a Switch">
            <Field label="Camera">
                <select
                    className={styles.select}
                    value={ctrl ? `switch:${ctrl.id}` : fixed}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith('switch:')) {
                            const id = v.slice(7);
                            const c = switches.find((x) => x.id === id);
                            // Start each state on a camera of its own, in turn.
                            const pool = [...(media.kind === 'take' ? ['solve'] : []), ...cams.map((x) => x.id)];
                            const map = Object.fromEntries(c.states.map((_, i) => [i, sw?.map?.[i] ?? pool[i % Math.max(1, pool.length)]]));
                            setSwitch({ controller: id, map });
                        } else {
                            if (sw) set('cameraSwitch')(undefined);
                            set('camera')(v);
                            comp.commit();
                        }
                    }}
                >
                    {options}
                    {switches.length > 0 && (
                        <optgroup label="Follow a Switch">
                            {switches.map((c) => <option key={c.id} value={`switch:${c.id}`}>{c.name}</option>)}
                        </optgroup>
                    )}
                </select>
            </Field>
            {ctrl && ctrl.states.map((st, i) => (
                <Field key={i} label={`When ${st}`}>
                    <select
                        className={styles.select}
                        value={sw.map?.[i] ?? fixed}
                        onChange={(e) => setSwitch({ ...sw, map: { ...sw.map, [i]: e.target.value } })}
                    >
                        {options}
                    </select>
                </Field>
            ))}
            </div>
            {!ctrl && (
                <p className={styles.hint}>Right-click Camera to cut between cameras with a Switch.</p>
            )}
        </>
    );
}

/** The Camera row's right-click menu: follow a Switch, make one, or go fixed. */
function CameraMenu({
    at, switches, current, onFollow, onNew, onFixed, onClose,
}) {
    const ref = useRef(null);
    React.useEffect(() => {
        const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
        const esc = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('pointerdown', away, true);
        window.addEventListener('keydown', esc);
        return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
    }, [onClose]);
    const pick = (fn) => () => { fn(); onClose(); };
    return createPortal(
        <div ref={ref} className={styles.menu} style={{ left: Math.min(at.x, window.innerWidth - 240), top: Math.min(at.y, window.innerHeight - 220) }}>
            <div className={styles.menuTitle}>Camera</div>
            <div className={styles.menuTitle}>Cut between cameras with</div>
            {switches.map((c) => (
                <button key={c.id} type="button" className={`${styles.menuItem} ${current === c.id ? styles.menuItemOn : ''}`} onClick={pick(() => onFollow(c))}>
                    <span className={styles.swatch} style={{ background: c.color }} />
                    <span className={styles.olName}>{c.name}</span>
                    <span className={styles.olTag}>{c.states.length} states</span>
                </button>
            ))}
            <button type="button" className={styles.menuItem} onClick={pick(onNew)}>New Switch, one state per camera</button>
            {current && (
                <>
                    <div className={styles.menuSep} />
                    <button type="button" className={styles.menuItem} onClick={pick(onFixed)}>Unlink (fixed camera)</button>
                </>
            )}
        </div>,
        document.body,
    );
}

function ClipInspector({ clip }) {
    const comp = useComp();
    const media = comp.project.media.find((m) => m.id === clip.mediaId);
    const scene = media?.kind === 'take'
        ? comp.project.scenes.find((s) => s.take === media.src.take)
        : comp.project.scenes.find((s) => s.id === media?.sceneId);
    const cams = scene ? comp.project.objects.filter((o) => o.sceneId === scene.id && o.type === 'camera') : [];
    const set = (key) => (v) => comp.updateClip(clip.id, (c) => ({ ...c, [key]: v }), false, `clip:${clip.id}:${key}`);
    return (
        <>
            <div className={styles.insHead}>
                <span className={styles.insName} style={{ border: 'none' }}>{media?.name || 'Clip'}</span>
                <span className={styles.insKind}>Clip</span>
                <button type="button" className={styles.olToggle} title="Split at playhead (S)" onClick={() => comp.splitClip(clip.id)}><Scissors size={12} /></button>
                <button type="button" className={styles.olToggle} title={media?.kind === 'stage' ? 'Duplicate, with a new stage of its own (⌘D)' : 'Duplicate (⌘D)'} onClick={() => comp.duplicateClip(clip.id)}><Copy size={12} /></button>
                <button type="button" className={styles.olToggle} title="Delete" onClick={() => comp.removeClip(clip.id)}><Trash2 size={12} /></button>
            </div>
            <div className={styles.groupBody} style={{ paddingTop: 8 }}>
                <Field label="Start (s)"><NumberBox value={clip.start} step={0.001} onCommit={(v) => { set('start')(Math.max(0, v)); comp.commit(); }} /></Field>
                <Field label="Length (s)"><NumberBox value={clip.dur} step={0.001} onCommit={(v) => { set('dur')(Math.max(0.05, v)); comp.commit(); }} /></Field>
                {media?.kind !== 'stage' && (
                    <>
                        <Field label="In (s)"><NumberBox value={clip.in} step={0.001} onCommit={(v) => { set('in')(Math.max(0, v)); comp.commit(); }} /></Field>
                        <Field label="Rate"><NumberBox value={clip.rate} step={0.01} onCommit={(v) => { set('rate')(Math.max(0.05, v)); comp.commit(); }} /></Field>
                        <Field label="At the end">
                            <select className={styles.select} value={clip.loop} onChange={(e) => { set('loop')(e.target.value); comp.commit(); }}>
                                {LOOP_MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                            </select>
                        </Field>
                        <div className={styles.wideRow}>
                            <button type="button" className={styles.btn} disabled={!Number.isFinite(media?.duration)} onClick={() => { set('dur')(Math.max(0.05, (media.duration - clip.in) / (clip.rate || 1))); comp.commit(); }}>
                                Fit to source
                            </button>
                        </div>
                    </>
                )}
                {media?.kind !== 'audio' && media?.kind !== 'stage' && (
                    <ParamRow def={{ key: 'withAudio', label: 'Its own sound', type: 'bool', link: false }} value={clip.withAudio !== false} onChange={(v) => { set('withAudio')(v); comp.commit(); }} />
                )}
                {(media?.kind === 'take' || media?.kind === 'stage') && (
                    <CameraPick clip={clip} media={media} cams={cams} set={set} />
                )}
                {(media?.kind === 'take' || media?.kind === 'stage') && (
                    <div className={styles.wideRow}>
                        <button type="button" className={styles.btn} onClick={() => comp.addObject('camera', scene.id)}>New camera in {scene?.name}</button>
                    </div>
                )}
            </div>
        </>
    );
}

function TrackInspector({ track }) {
    const comp = useComp();
    const defs = track.kind === 'audio' ? AUDIO_TRACK_PARAMS : TRACK_PARAMS;
    return (
        <>
            <div className={styles.insHead}>
                <input className={styles.insName} value={track.name} onChange={(e) => comp.updateTrack(track.id, (t) => ({ ...t, name: e.target.value }), false, `tname:${track.id}`)} onBlur={comp.commit} />
                <span className={styles.insKind}>{track.kind} track</span>
                <button type="button" className={styles.olToggle} title="Delete track and its clips" onClick={() => comp.removeTrack(track.id)}><Trash2 size={12} /></button>
            </div>
            <div className={styles.groupBody} style={{ paddingTop: 8 }}>
                {track.kind === 'video' && (
                    <p className={styles.hint}>Link Visible to a Switch to cut between tracks.</p>
                )}
                {defs.map((d) => (
                    <ParamRow
                        key={d.key}
                        def={d}
                        value={track.params[d.key] ?? d.def}
                        link={track.links?.[d.key]}
                        onChange={(v) => comp.updateTrack(track.id, (t) => ({ ...t, params: { ...t.params, [d.key]: v } }), false, `tp:${track.id}:${d.key}`)}
                        onLink={d.link === false ? undefined : (l) => comp.setTrackLink(track.id, d.key, l)}
                        onCommit={comp.commit}
                    />
                ))}
            </div>
        </>
    );
}

function MediaInspector({ media }) {
    const comp = useComp();
    const fileRef = useRef(null);
    const missing = comp.missingMedia.has(media.id);
    const where = media.src?.type === 'take' ? `public/mv/${media.src.take}`
        : media.src?.type === 'public' ? `public/${media.src.path}`
            : media.src?.type === 'upload' ? `${media.src.name} (kept in this browser)`
                : media.src?.type === 'url' ? media.src.url : 'generated';
    return (
        <>
            <div className={styles.insHead}>
                <input className={styles.insName} value={media.name} onChange={(e) => comp.updateMedia(media.id, (m) => ({ ...m, name: e.target.value }), false, `mname:${media.id}`)} onBlur={comp.commit} />
                <span className={styles.insKind}>{media.kind}</span>
                <button type="button" className={styles.olToggle} title="Remove from project" onClick={() => comp.removeMedia(media.id)}><Trash2 size={12} /></button>
            </div>
            <div className={styles.groupBody} style={{ paddingTop: 8 }}>
                {missing && (
                    <p className={`${styles.hint} ${styles.warn}`}>
                        File not found. Relocate it.
                    </p>
                )}
                <Field label="Source"><span style={{ overflowWrap: 'anywhere', color: 'var(--dim)' }}>{where}</span></Field>
                {Number.isFinite(media.duration) && <Field label="Length">{`${media.duration.toFixed(2)}s`}</Field>}
                <div className={styles.wideRow}>
                    <button type="button" className={styles.btn} onClick={() => comp.placeMedia(media.id)}>Add at playhead</button>
                    {(media.src?.type === 'upload' || media.src?.type === 'url' || missing) && (
                        <button type="button" className={styles.btn} onClick={() => fileRef.current.click()}>Relocate…</button>
                    )}
                </div>
                <input
                    ref={fileRef}
                    type="file"
                    accept={media.kind === 'audio' ? 'audio/*' : 'video/*'}
                    style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) comp.relocateMedia(media.id, f); }}
                />
            </div>
        </>
    );
}

const OUTPUT_PRESETS = [
    ['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4K', 3840, 2160],
    ['Square', 1080, 1080], ['Vertical', 1080, 1920], ['4:3', 1440, 1080],
];

function OutputInspector() {
    const comp = useComp();
    const o = comp.project.output;
    const take = comp.project.media.find((m) => m.kind === 'take' && m.width);
    const set = (patch) => comp.setOutput({ ...patch, auto: false });
    return (
        <>
            <div className={styles.insHead}>
                <span className={styles.insName} style={{ border: 'none' }}>Output</span>
                <span className={styles.insKind}>Project</span>
            </div>
            <div className={styles.groupBody} style={{ paddingTop: 8 }}>
                <Field label="Width"><NumberBox value={o.width} step={2} onCommit={(v) => set({ width: Math.max(16, Math.round(v / 2) * 2) })} /></Field>
                <Field label="Height"><NumberBox value={o.height} step={2} onCommit={(v) => set({ height: Math.max(16, Math.round(v / 2) * 2) })} /></Field>
                <Field label="Frame rate"><NumberBox value={o.fps} step={0.001} onCommit={(v) => set({ fps: Math.max(1, Math.min(240, v)) })} /></Field>
                <div className={styles.wideRow}>
                    {OUTPUT_PRESETS.map(([label, w, h]) => (
                        <button key={label} type="button" className={`${styles.btn} ${o.width === w && o.height === h ? styles.btnOn : ''}`} onClick={() => set({ width: w, height: h })}>{label}</button>
                    ))}
                    {take && <button type="button" className={styles.btn} onClick={() => set({ width: take.width, height: take.height })}>Take ({take.width}×{take.height})</button>}
                </div>
            </div>
        </>
    );
}

export default function Inspector() {
    const comp = useComp();
    const sel = comp.selection;
    const P = comp.project;
    if (sel?.kind === 'output') return <OutputInspector />;
    if (sel?.kind === 'object') {
        const obj = P.objects.find((o) => o.id === sel.id);
        if (obj) return <ObjectInspector key={obj.id} obj={obj} />;
    }
    if (sel?.kind === 'variable') {
        const v = (P.variables || []).find((x) => x.id === sel.id);
        if (v) return <VariableInspector key={v.id} v={v} />;
    }
    if (sel?.kind === 'controller') {
        const c = P.controllers.find((x) => x.id === sel.id);
        if (c) return <ControllerInspector key={c.id} ctrl={c} />;
    }
    if (sel?.kind === 'clip') {
        const c = P.clips.find((x) => x.id === sel.id);
        if (c) return <ClipInspector key={c.id} clip={c} />;
    }
    if (sel?.kind === 'track') {
        const t = P.tracks.find((x) => x.id === sel.id);
        if (t) return <TrackInspector key={t.id} track={t} />;
    }
    if (sel?.kind === 'media') {
        const m = P.media.find((x) => x.id === sel.id);
        if (m) return <MediaInspector key={m.id} media={m} />;
    }
    return (
        <div className={styles.empty}>
            Select something to edit it, here or in the viewport. Every control can be right-clicked to link it to a controller.
        </div>
    );
}

export { clipEnd, controllerValue };
