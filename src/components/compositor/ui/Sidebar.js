// The sidebar: an outliner of everything in the project (media, each
// scene's objects, the effects, the controllers) over an inspector for the
// selection. It sits beside the viewport and pushes it, never over it.

import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    Eye, EyeOff, Move3d, Box, Camera, Sun, Sparkles, Activity, Plus, Trash2, Copy,
    ChevronDown, ChevronRight, Spline, PersonStanding, Square, Monitor, AlertTriangle, Clapperboard,
    Circle, Layers, ArrowUp, ArrowDown, Shapes, Frame, Type, LayoutGrid, ArrowDownWideNarrow, ScanSearch,
    SquareFunction, Waypoints, Variable, CircleDot,
} from 'lucide-react';
import { Film, Music } from './icons';
import { OBJECT_TYPES, ADDABLE, paramDefs } from '../model/schema';
import { CONTROLLER_TYPES } from '../model/controllers';
import { useComp, useTick } from './context';
import {
    globalsOf, scopeOf, variableKey, variableLabel, VARIABLE_KINDS,
} from '../model/globals';
import { formatValue } from '../model/expr';
import { unusedScenes } from '../model/project';
import Inspector from './Inspector';
import styles from '../compositor.module.css';

const ICONS = {
    take: Layers,
    footage: Film,
    scanPoints: Circle,
    scanMesh: Box,
    scanWire: Frame,
    sun: Sun,
    camera: Camera,
    cloud: Circle,
    curve: Spline,
    equation: SquareFunction,
    spline: Waypoints,
    splinePoint: CircleDot,
    stage: Box,
    variable: Variable,
    protagonist: PersonStanding,
    sackboy: PersonStanding,
    prop: Shapes,
    window: Square,
    text: Type,
    glow: Sparkles,
    haze: Sparkles,
    grade: Sparkles,
    quadtree: LayoutGrid,
    pixelsort: ArrowDownWideNarrow,
    blobs: ScanSearch,
};

const MEDIA_ICONS = { take: Clapperboard, video: Film, audio: Music, stage: Box };

function Section({ title, children, actions, open: initial = true }) {
    const [open, setOpen] = useState(initial);
    return (
        <>
            <div className={styles.olHead}>
                <button type="button" className={styles.olToggle} onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <span className={styles.olName}>{title}</span>
                {actions}
            </div>
            {open && children}
        </>
    );
}

/** A small pop-up list of choices, anchored to the button that opened it. */
function AddButton({ label, items, onPick }) {
    const [at, setAt] = useState(null);
    return (
        <span>
            <button
                type="button"
                className={styles.btn}
                title={label}
                aria-label={label}
                onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setAt(at ? null : { right: window.innerWidth - r.right, top: r.bottom + 2 });
                }}
            >
                <Plus size={13} />
            </button>
            {at && createPortal(
                <>
                    <span style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setAt(null)} aria-hidden="true" />
                    <div className={styles.menu} style={{ right: at.right, top: at.top, maxHeight: `calc(100vh - ${at.top + 12}px)`, overflowY: 'auto' }}>
                        <div className={styles.menuTitle}>{label}</div>
                        {items.map((it) => (
                            <button key={it.id} type="button" className={styles.menuItem} disabled={it.disabled} onClick={() => { setAt(null); onPick(it.id); }}>
                                {it.label}
                            </button>
                        ))}
                    </div>
                </>,
                document.body,
            )}
        </span>
    );
}

function ObjectRow({ obj, depth = 1, kids = 0, folded = false, onFold = null }) {
    const comp = useComp();
    const Icon = ICONS[obj.type] || Box;
    const on = comp.selection?.kind === 'object' && comp.selection.id === obj.id;
    const visible = obj.params.visible !== false;
    const visLinked = !!obj.links?.visible;
    const hasGizmo = !!OBJECT_TYPES[obj.type]?.gizmo && obj.type !== 'scanPoints' && obj.type !== 'sun' && obj.type !== 'window';
    const hasVisible = paramDefs(obj.type).has('visible');
    return (
        <div
            className={`${styles.olRow} ${on ? styles.olRowOn : ''}`}
            style={{ '--depth': depth }}
            onClick={() => comp.select({ kind: 'object', id: obj.id })}
        >
            {kids > 0 && (
                <button
                    type="button"
                    className={styles.olToggle}
                    title={folded ? `Show its ${kids} part${kids === 1 ? '' : 's'}` : 'Fold its parts away'}
                    onClick={(e) => { e.stopPropagation(); onFold?.(); }}
                >
                    {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
            )}
            <span className={styles.olIcon}><Icon size={12} /></span>
            <span className={styles.olName}>{obj.name}</span>
            {kids > 0 && folded && <span className={styles.olTag}>{`+${kids}`}</span>}
            {Object.keys(obj.links || {}).length > 0 && <span className={styles.olTag} title="Has controller links">⌁</span>}
            {hasGizmo && (
                <button
                    type="button"
                    title={obj.gizmo !== false ? 'Gizmo on' : 'Gizmo off'}
                    className={`${styles.olToggle} ${obj.gizmo !== false ? styles.olToggleOn : ''}`}
                    onClick={(e) => { e.stopPropagation(); comp.updateObject(obj.id, (o) => ({ ...o, gizmo: o.gizmo === false })); }}
                >
                    <Move3d size={12} />
                </button>
            )}
            {hasVisible && (
                <button
                    type="button"
                    title={visLinked ? 'Visibility follows a controller' : (visible ? 'Hide' : 'Show')}
                    className={`${styles.olToggle} ${visible ? styles.olToggleOn : ''} ${visLinked ? styles.olLinked : ''}`}
                    onClick={(e) => { e.stopPropagation(); comp.setParam(obj.id, 'visible', !visible, true); }}
                >
                    {visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
            )}
        </div>
    );
}

/** A variable in the outliner, with its value as it is now. */
function VariableRow({ v }) {
    const comp = useComp();
    const ref = useRef(null);
    const on = comp.selection?.kind === 'variable' && comp.selection.id === v.id;
    const key = variableKey(v);
    const dupe = scopeOf(comp.project).dupes.has(v.id);
    useTick((t, frame) => {
        const g = frame && globalsOf(frame);
        if (!ref.current || !g) return;
        if (dupe) ref.current.textContent = 'taken';
        else if (v.set === 'text') {
            const words = String(g.text(key) ?? '');
            ref.current.textContent = words.length > 14 ? `${words.slice(0, 13)}…` : words;
        } else ref.current.textContent = formatValue(g.value(key), v.set === 'int' ? 0 : 3);
    });
    const link = v.set === 'text' ? v.links?.text : v.links?.value;
    const ctrl = link && comp.project.controllers.find((c) => c.id === link.controller);
    return (
        <div className={`${styles.olRow} ${on ? styles.olRowOn : ''}`} style={{ '--depth': 1 }} onClick={() => comp.select({ kind: 'variable', id: v.id })}>
            <span className={styles.olIcon}><Variable size={12} /></span>
            <span className={styles.olName}>{variableLabel(v)}</span>
            {ctrl && <span className={styles.swatch} style={{ background: ctrl.color }} title={`Follows ${ctrl.name}`} />}
            <span ref={ref} className={`${styles.olTag} ${dupe ? styles.warn : ''}`} />
            <span className={styles.olTag}>{v.set === 'text' ? 'T' : v.set === 'int' ? 'ℤ' : 'ℝ'}</span>
        </div>
    );
}

function Outliner() {
    const comp = useComp();
    const { project } = comp;
    const [closed, setClosed] = useState({});
    const effects = project.objects.filter((o) => !o.sceneId);
    const missing = comp.missingMedia;
    // Scenes no clip plays, which can be deleted.
    const unused = unusedScenes(project);
    const unusedIds = new Set(unused.map((sc) => sc.id));

    const addItems = useMemo(() => [
        ...ADDABLE.placed.map((t) => ({ id: t, label: OBJECT_TYPES[t].label })),
        { id: 'camera', label: 'Camera' },
    ], []);

    return (
        <div className={styles.outliner}>
            <div
                className={`${styles.olRow} ${comp.selection?.kind === 'output' ? styles.olRowOn : ''}`}
                style={{ '--depth': 0 }}
                onClick={() => comp.select({ kind: 'output' })}
            >
                <span className={styles.olIcon}><Monitor size={12} /></span>
                <span className={styles.olName}>Output</span>
                <span className={styles.olTag}>{`${project.output.width}×${project.output.height} · ${project.output.fps}fps`}</span>
            </div>
            <Section
                title="Media"
                actions={(
                    <AddButton
                        label="Add media"
                        items={[
                            { id: 'file', label: 'Import video or audio…' },
                            { id: 'stage', label: 'Empty 3D stage' },
                            ...comp.takes.map((t) => ({ id: `take:${t.id}`, label: `Take · ${t.label}` })),
                            { id: 'bundled', label: 'Bundled music…' },
                            { id: 'bundledVideo', label: 'Bundled video…' },
                        ]}
                        onPick={comp.addMedia}
                    />
                )}
            >
                {project.media.length === 0 && <div className={styles.empty}>Nothing imported yet.</div>}
                {project.media.map((m) => {
                    const Icon = MEDIA_ICONS[m.kind] || Film;
                    const on = comp.selection?.kind === 'media' && comp.selection.id === m.id;
                    return (
                        <div
                            key={m.id}
                            className={`${styles.olRow} ${on ? styles.olRowOn : ''}`}
                            style={{ '--depth': 1 }}
                            draggable
                            onDragStart={(e) => { e.dataTransfer.setData('application/x-compositor-media', m.id); e.dataTransfer.effectAllowed = 'copy'; }}
                            onClick={() => comp.select({ kind: 'media', id: m.id })}
                            onDoubleClick={() => comp.placeMedia(m.id)}
                            title="Drag onto the timeline, or double-click to drop it at the playhead"
                        >
                            <span className={styles.olIcon}><Icon size={12} /></span>
                            <span className={styles.olName}>{m.name}</span>
                            {missing.has(m.id) && <span className={styles.warn} title="File not found — relocate it"><AlertTriangle size={12} /></span>}
                            <span className={styles.olTag}>{m.kind === 'stage' ? '3D' : Number.isFinite(m.duration) ? `${m.duration.toFixed(1)}s` : ''}</span>
                        </div>
                    );
                })}
            </Section>

            {unused.length > 1 && (
                <div className={styles.olRow} style={{ '--depth': 0 }}>
                    <span className={styles.olName} style={{ color: 'var(--faint)' }}>{`${unused.length} scenes aren't on the timeline`}</span>
                    <button
                        type="button"
                        className={styles.olToggle}
                        title={`Delete them all: ${unused.map((sc) => sc.name).join(', ')}`}
                        onClick={() => comp.removeScenes(unused.map((sc) => sc.id))}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            )}
            {project.scenes.map((sc) => {
                const objs = project.objects.filter((o) => o.sceneId === sc.id);
                const isClosed = closed[sc.id];
                const isUnused = unusedIds.has(sc.id);
                return (
                    <React.Fragment key={sc.id}>
                        <div className={styles.olHead}>
                            <button type="button" className={styles.olToggle} onClick={() => setClosed({ ...closed, [sc.id]: !isClosed })}>
                                {isClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            </button>
                            <span className={styles.olName}>{sc.name}</span>
                            <span className={styles.olTag}>{isUnused ? `${sc.take ? 'take' : 'stage'} · unused` : sc.take ? 'take' : 'stage'}</span>
                            {isUnused && (
                                <button
                                    type="button"
                                    className={styles.olToggle}
                                    title={`Delete ${sc.name}: no clip plays it. Its ${sc.take ? 'take' : 'stage'} leaves the media too, with everything in the scene (undo brings it back).`}
                                    onClick={() => comp.removeScenes([sc.id])}
                                >
                                    <Trash2 size={12} />
                                </button>
                            )}
                            <AddButton label={`Add to ${sc.name}`} items={addItems} onPick={(type) => comp.addObject(type, sc.id)} />
                        </div>
                        {!isClosed && (() => {
                            // Children (a spline's labels) under their parent.
                            const ids = new Set(objs.map((o) => o.id));
                            const kidsOf = (id) => objs.filter((o) => o.parentId === id);
                            return objs.filter((o) => !o.parentId || !ids.has(o.parentId)).flatMap((o) => {
                                const kids = kidsOf(o.id);
                                const folded = !!closed[o.id];
                                return [
                                    <ObjectRow key={o.id} obj={o} kids={kids.length} folded={folded} onFold={() => setClosed({ ...closed, [o.id]: !folded })} />,
                                    ...(folded ? [] : kids.map((k) => <ObjectRow key={k.id} obj={k} depth={2} />)),
                                ];
                            });
                        })()}
                    </React.Fragment>
                );
            })}

            <Section
                title="Effects"
                open={effects.length > 0}
                actions={(
                    <AddButton
                        label="Add effect"
                        items={ADDABLE.effect.map((t) => ({ id: t, label: OBJECT_TYPES[t].label }))}
                        onPick={(type) => comp.addObject(type, null)}
                    />
                )}
            >
                {effects.length === 0 && <div className={styles.empty}>Glow, haze, grade and quad trees go here, applied in order.</div>}
                {effects.map((o) => <ObjectRow key={o.id} obj={o} />)}
            </Section>

            <Section
                title="Variables"
                open
                actions={(
                    <AddButton
                        label="Add variable"
                        items={[{ id: 'real', label: 'Real number (ℝ)' }, { id: 'int', label: 'Integer (ℤ)' }, { id: 'text', label: 'Text (shown in text, cut like a Switch)' }]}
                        onPick={(set) => comp.addVariable(null, '', true, VARIABLE_KINDS[set] || {})}
                    />
                )}
            >
                {!(project.variables || []).length && <div className={styles.empty}>Greek letters equations, splines and text can read (θ, ω_1), each a value a controller can drive; or text a Text controller cuts between, shown in any text.</div>}
                {(project.variables || []).map((v) => <VariableRow key={v.id} v={v} />)}
            </Section>

            <Section
                title="Controllers"
                actions={(
                    <AddButton
                        label="Add controller"
                        items={Object.entries(CONTROLLER_TYPES).map(([id, t]) => ({ id, label: t.label }))}
                        onPick={(type) => { const c = comp.addController(type); comp.select({ kind: 'controller', id: c.id }); }}
                    />
                )}
            >
                {project.controllers.map((c) => {
                    const on = comp.selection?.kind === 'controller' && comp.selection.id === c.id;
                    return (
                        <div key={c.id} className={`${styles.olRow} ${on ? styles.olRowOn : ''}`} style={{ '--depth': 1 }} onClick={() => comp.select({ kind: 'controller', id: c.id })}>
                            <span className={styles.swatch} style={{ background: c.color }} />
                            <span className={styles.olName}>{c.name}</span>
                            <span className={styles.olTag}>{CONTROLLER_TYPES[c.type]?.label}</span>
                            <span className={styles.olIcon}><Activity size={11} /></span>
                        </div>
                    );
                })}
            </Section>
        </div>
    );
}

export default function Sidebar({ open }) {
    return (
        <aside className={`${styles.side} ${open ? '' : styles.sideClosed}`}>
            {open && (
                <>
                    <Outliner />
                    <div className={styles.inspector}>
                        <Inspector />
                    </div>
                </>
            )}
        </aside>
    );
}

export { ICONS, Monitor, Copy, Trash2, ArrowUp, ArrowDown };
