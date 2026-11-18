// The Scan mesh's "Edit mesh" panel: mesh edit mode's switch, its tools and
// what it has done. The work is engine/meshEditor.js's; the edits are kept
// per scan (lib/scanAssets/meshEdits.js), so takes in one scan share them.

import React, { useEffect, useReducer } from 'react';
import {
    Wrench, Undo2, Redo2, RotateCcw, Triangle, CircleDot, X,
} from 'lucide-react';
import { useComp } from './context';
import { MESH_TOOLS } from '../engine/meshEditor';
import { editSummary, isEmptyEdits, editKeyFor } from '../model/meshEdits';
import styles from '../compositor.module.css';

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function MeshEditPanel({ obj }) {
    const comp = useComp();
    const ed = comp.meshEditor;
    const [, bump] = useReducer((x) => x + 1, 0);
    useEffect(() => (ed ? ed.subscribe(bump) : undefined), [ed]);

    const sceneId = obj.sceneId;
    const scene = comp.project.scenes.find((s) => s.id === sceneId);
    const rig = comp.rig(sceneId);
    const on = comp.meshEdit.on && comp.meshEdit.sceneId === sceneId;
    const { setMeshEdit } = comp;
    // Leaving the panel leaves the mode (as Roto does).
    useEffect(() => () => setMeshEdit((m) => (m.sceneId === sceneId ? { ...m, on: false } : m)), [sceneId, setMeshEdit]);

    // Which edits this take's mesh uses (the Geometry choice above): the scan's, its own, or none.
    const source = obj.params.meshSource || 'shared';
    const original = source === 'original';
    useEffect(() => {
        if (original) setMeshEdit((m) => (m.sceneId === sceneId && m.on ? { ...m, on: false } : m));
    }, [original, sceneId, setMeshEdit]);

    if (!scene?.take) return null;
    const scanFp = rig?.fingerprint;
    const fp = editKeyFor(scanFp, scene.take, source);
    const entry = fp ? comp.meshEdits[fp] : null;
    const doc = entry?.doc;
    const sharedDoc = scanFp ? comp.meshEdits[scanFp]?.doc : null;
    const sum = editSummary(doc, rig?.base);
    // Other takes filmed in this scan get the same edits.
    const sharing = source === 'shared' && fp ? comp.project.scenes.filter((s) => s.id !== sceneId && s.take && comp.rig(s.id)?.fingerprint === fp).map((s) => s.take) : [];
    const live = on && ed?.active && ed.rig === rig;
    const hist = live ? ed.hist : { past: [], future: [] };
    const saved = comp.meshEditsSaved;

    const toggle = () => setMeshEdit({ on: !on, sceneId });
    const seg = (
        <div className={styles.wideRow} style={{ marginBottom: 6 }}>
            {MESH_TOOLS.map(([id, label, key, tip]) => (
                <button key={id} type="button" title={`${tip} (${key})`} className={`${styles.btn} ${ed?.tool === id ? styles.btnOn : ''}`} onClick={() => ed?.setTool(id)}>
                    {label}
                </button>
            ))}
        </div>
    );
    const range = (label, value, min, max, step, set, shown) => (
        <div className={styles.row}>
            <span className={styles.rowLabel}>{label}</span>
            <input type="range" className={styles.slider} min={min} max={max} step={step} value={value} onChange={(e) => set(parseFloat(e.target.value))} />
            <span className={styles.olTag}>{shown}</span>
        </div>
    );

    return (
        <>
            {original ? (
                <p className={styles.hint}>
                    Drawn as the scan was published, without edits. Pick the scan’s edits or this take’s own under Geometry to edit it.
                </p>
            ) : (
                <button type="button" className={`${styles.rotoBtn} ${on ? styles.btnOn : ''}`} disabled={!rig?.base} onClick={toggle} title={source === 'own' ? 'Fill holes and cut junk out of this take’s own copy of the scan (Esc leaves)' : 'Fill holes and cut junk out of this scan, for every take filmed in it (Esc leaves)'}>
                    <Wrench size={13} />
                    {on ? 'Leave mesh edit' : rig?.base ? (source === 'own' ? 'Edit this take’s mesh' : 'Edit mesh') : 'Loading the scan…'}
                </button>
            )}

            {source === 'own' && rig?.base && isEmptyEdits(doc) && !isEmptyEdits(sharedDoc) && (
                <div className={styles.wideRow} style={{ marginBottom: 6 }}>
                    <button type="button" className={styles.btn} title="Start this take’s own mesh from the edits the scan has (it stays separate after)" onClick={() => comp.putMeshEdits(fp, scene.take, sharedDoc)}>
                        Start from the scan’s edits
                    </button>
                </div>
            )}

            {on && !live && (
                <div className={styles.warnBox}>
                    <p className={styles.hint} style={{ margin: 0 }}>
                        This take isn’t in view: move the playhead onto it, or look at it with a free camera.
                    </p>
                    <button type="button" className={styles.btn} onClick={() => comp.setMode('orbit')}>Orbit</button>
                </div>
            )}

            {live && (
                <>
                    {seg}
                    {ed.tool === 'erase' && range('Brush', ed.brush, 3, 200, 1, (v) => { ed.set({ brush: v }); }, `${ed.brush}px`)}

                    {ed.chain.length > 0 && (
                        <div className={styles.wideRow} style={{ marginBottom: 6, alignItems: 'center' }}>
                            <span className={styles.hint} style={{ flex: '1 1 100%', margin: 0 }}>
                                {ed.chainClosed ? `A hole of ${plural(ed.chain.length, 'edge')}.` : `${plural(ed.chain.length, 'point')} picked.`}
                                {ed.chain.length < 3 && ' Pick at least three.'}
                            </span>
                            <button type="button" className={styles.btn} disabled={ed.chain.length < 3} title="Fill the polygon (Enter)" onClick={() => ed.fill(false)}>
                                <Triangle size={12} />
                                Fill
                            </button>
                            <button type="button" className={styles.btn} disabled={ed.chain.length < 3} title="Fill round a new point in the middle, to pull into place with Move (Shift+Enter)" onClick={() => ed.fill(true)}>
                                <CircleDot size={12} />
                                Fill round centre
                            </button>
                            <button type="button" className={styles.btn} title="Clear the points (Esc)" onClick={() => ed.clearChain()}>
                                <X size={12} />
                            </button>
                        </div>
                    )}
                    {ed.tool === 'hole' && ed.hover?.kind === 'edge' && (
                        <p className={styles.hint} style={{ marginTop: 0 }}>
                            {ed.hover.loop ? `This hole: ${plural(ed.hover.loop.length, 'edge')}. Click to take it.` : 'This hole runs into another and doesn’t close.'}
                        </p>
                    )}
                    {ed.status && <p className={styles.hint} style={{ marginTop: 0 }}>{ed.status}</p>}

                    {range('Shell', ed.opacity, 0, 1, 0.01, (v) => ed.set({ opacity: v }), ed.opacity.toFixed(2))}
                    <div
                        className={styles.rotoCheck}
                        role="button"
                        tabIndex={0}
                        title="Show open edges through the scan, faintly"
                        onClick={() => ed.set({ xray: !ed.xray })}
                        onKeyDown={(e) => { if (e.key === 'Enter') ed.set({ xray: !ed.xray }); }}
                    >
                        <span>Open edges through the scan</span>
                        <span className={`${styles.check} ${ed.xray ? styles.checkOn : ''}`} />
                    </div>

                    <div className={styles.wideRow}>
                        <button type="button" className={styles.btn} disabled={!hist.past.length} title="Undo (⌘Z)" onClick={() => ed.undo()}>
                            <Undo2 size={12} />
                            Undo
                        </button>
                        <button type="button" className={styles.btn} disabled={!hist.future.length} title="Redo (⇧⌘Z)" onClick={() => ed.redo()}>
                            <Redo2 size={12} />
                            Redo
                        </button>
                        <button
                            type="button"
                            className={styles.btn}
                            disabled={isEmptyEdits(doc)}
                            title={source === 'own' ? 'Take every edit off this take’s mesh (undoable)' : 'Take every edit off this scan (undoable)'}
                            onClick={() => { if (window.confirm(source === 'own' ? 'Take every edit off this take’s mesh? (Undo brings them back.)' : 'Take every edit off this scan? (Undo brings them back.)')) ed.reset(); }}
                        >
                            <RotateCcw size={12} />
                            Reset
                        </button>
                    </div>
                </>
            )}

            {rig?.base && !original && (
                <p className={styles.hint} style={{ marginBottom: 0 }}>
                    {live && ed.topo && (
                        <>
                            {plural(ed.topo.openCount, 'open edge')}
                            {' (drawn in red). '}
                        </>
                    )}
                    {isEmptyEdits(doc) ? 'No edits yet.' : [
                        sum.added && `${plural(sum.added, 'triangle')} added`,
                        sum.removed && `${plural(sum.removed, 'triangle')} cut`,
                        sum.moved && `${plural(sum.moved, 'vertex', 'vertices')} moved`,
                    ].filter(Boolean).join(', ').concat('.')}
                    {saved === 'repo' && ' Saved to src/data/meshEdits.json.'}
                    {saved === 'browser' && ' Saved in this browser only (restart npm start to save to the repo).'}
                    {saved === 'saving' && ' Saving…'}
                    {sharing.length > 0 && ` Shared with ${sharing.join(', ')}: the same scan.`}
                </p>
            )}
        </>
    );
}
