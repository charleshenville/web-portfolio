// The inspector's maths: expression fields (checked as you type), an
// Equation's x(t) y(t) z(t), a Spline's points and ends, dynamic text, the
// variables an object uses (and making new ones), and a variable's own panel.
//
// Everything here edits the project; the engine works the values out every
// frame from it, so a change shows everywhere that reads it at once.

import React, { useEffect, useRef, useState } from 'react';
import {
    Trash2, ArrowUp, ArrowDown, Plus,
} from 'lucide-react';
import {
    scopeOf, compileIn, variableDef, variableKey, variableLabel, globalsOf, splineSymbol, solveLoose, VARIABLE_KINDS,
} from '../model/globals';
import { isSwitch } from '../model/controllers';
import { makeFrame } from '../model/resolve';
import {
    symbolLabel, symbolTex, VARIABLE_LETTERS, SPLINE_LETTERS, formatValue, letterName, TEMPLATE_SRC,
} from '../model/expr';
import { endOrders, orderName, ALL_POINTS } from '../model/spline';
import { EQUATION_PRESETS } from '../model/curvePresets';
import { OBJECT_TYPES } from '../model/schema';
import { ParamRow, NumberBox } from './Params';
import { useComp, useTick } from './context';
import styles from '../compositor.module.css';

// The expression field last typed in, so a variable picked from a list can
// be put where the cursor was.
let lastField = null;

/** An expression, checked against the project's names as it's typed. */
export function ExprField({
    value, onChange, onCommit, placeholder, scope, allowPoint = false, title, owner = null,
}) {
    const ref = useRef(null);
    const src = value === undefined || value === null ? '' : String(value);
    // What insert reads when it runs, which may be well after focus.
    const live = useRef({});
    live.current = { src, onChange, onCommit };
    const me = useRef(null);
    useEffect(() => () => { if (lastField && lastField === me.current) lastField = null; }, []);
    const c = src.trim() ? compileIn(scope, src) : null;
    let err = c?.error || null;
    if (c && !err && c.type !== 'num' && !allowPoint) err = 'That’s a point: pick a coordinate, as in P_1.x';
    const insert = (text) => {
        const el = ref.current;
        const { src: cur, onChange: change, onCommit: commit } = live.current;
        const s = el ? el.selectionStart ?? cur.length : cur.length;
        const e = el ? el.selectionEnd ?? cur.length : cur.length;
        const next = cur.slice(0, s) + text + cur.slice(e);
        change(next);
        commit?.();
        requestAnimationFrame(() => {
            if (!el) return;
            el.focus();
            el.setSelectionRange(s + text.length, s + text.length);
        });
    };
    return (
        <span style={{ display: 'block', minWidth: 0 }}>
            <input
                ref={ref}
                className={`${styles.exprInput} ${err ? styles.exprBad : ''}`}
                value={src}
                placeholder={placeholder}
                spellCheck={false}
                title={title || err || ''}
                onFocus={() => { me.current = { insert, owner }; lastField = me.current; }}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => onCommit?.()}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
            {err && <span className={styles.exprErr} style={{ display: 'block' }}>{err}</span>}
        </span>
    );
}

/** Put `text` into the expression field of `owner` last typed in; false when there is none. */
function insertIntoLast(text, owner) {
    if (!lastField || lastField.owner !== owner) return false;
    lastField.insert(text);
    return true;
}

// ---- What an object reads ---------------------------------------------------------

const TEMPLATE = new RegExp(TEMPLATE_SRC, 'g');

/** Every expression an object has, as source strings. */
export function sourcesOf(obj) {
    const p = obj.params || {};
    if (obj.type === 'equation') return [p.fx, p.fy, p.fz];
    if (obj.type === 'spline') {
        const out = [];
        (p.points || []).forEach((pt) => (pt || []).forEach((x) => out.push(x)));
        if (p.ends === 'clamped') ['start', 'end'].forEach((side) => Object.values(p.clamp?.[side] || {}).forEach((v) => (v || []).forEach((x) => out.push(x))));
        return out;
    }
    if (obj.type === 'text' || obj.type === 'splinePoint') return Array.from(String(p.text || '').matchAll(TEMPLATE), (m) => m[1]);
    return [];
}

/** The variables, missing names and splines `obj`'s expressions read. */
function readsOf(obj, scope) {
    const vars = new Set();
    const missing = new Set();
    const splines = new Set();
    const texts = new Set();
    sourcesOf(obj).forEach((src) => {
        if (src === undefined || src === null || !String(src).trim()) return;
        const c = compileIn(scope, String(src));
        c.vars.forEach((k) => vars.add(k));
        c.missing.forEach((k) => missing.add(k));
        c.splines.forEach((k) => splines.add(k));
        (c.texts || []).forEach((k) => texts.add(k));
    });
    return {
        vars, missing, splines, texts,
    };
}

const LOWER = new Set(VARIABLE_LETTERS.map(([c]) => c));
const splitKey = (key) => [key[0], key.length > 2 ? key.slice(2) : ''];

/** A variable's value, linkable, as one row. */
export function VariableValue({ v, label }) {
    const comp = useComp();
    const def = variableDef(v);
    return (
        <ParamRow
            def={{ ...def, label: label ?? variableLabel(v) }}
            value={v.params?.value ?? 0}
            link={v.links?.value}
            onChange={(x) => comp.updateVariable(v.id, (o) => ({ ...o, params: { ...o.params, value: x } }), false, `vv:${v.id}`)}
            onLink={(l) => comp.setVariableLink(v.id, l)}
            onCommit={comp.commit}
        />
    );
}

/**
 * A text variable's words: its own, or whichever text a Text controller (or
 * the state a Switch) is on, cut in that controller's lane.
 */
export function TextVariableValue({ v, label = 'Text' }) {
    const comp = useComp();
    const ctrls = comp.project.controllers.filter(isSwitch);
    const texts = ctrls.filter((c) => c.type === 'text');
    const switches = ctrls.filter((c) => c.type !== 'text');
    const id = v.links?.text?.controller;
    const ctrl = id && ctrls.find((c) => c.id === id);
    const follow = (cid) => comp.updateVariable(v.id, (o) => {
        const links = { ...(o.links || {}) };
        if (cid) links.text = { controller: cid }; else delete links.text;
        return { ...o, links };
    }, true);
    const newController = () => {
        const c = comp.addController('text');
        const first = String(v.params?.text ?? '').trim();
        comp.updateController(c.id, (x) => ({ ...x, name: `${variableLabel(v)} text`, states: [first || 'Hello', first ? `${first} 2` : 'World'] }), true);
        follow(c.id);
    };
    return (
        <>
            <div className={styles.row}>
                <span className={styles.rowLabel}>{label}</span>
                {ctrl ? (
                    <span className={styles.varValue} style={{ gridColumn: '2 / 4' }}>
                        <VariableWords v={v} />
                    </span>
                ) : (
                    <input
                        className={styles.num}
                        style={{ gridColumn: '2 / 4', textAlign: 'left' }}
                        value={String(v.params?.text ?? '')}
                        onChange={(e) => comp.updateVariable(v.id, (o) => ({ ...o, params: { ...o.params, text: e.target.value } }), false, `vt:${v.id}`)}
                        onBlur={comp.commit}
                    />
                )}
            </div>
            <div className={styles.row}>
                <span className={styles.rowLabel}>Follows</span>
                <select className={styles.select} style={{ gridColumn: '2 / 4' }} value={ctrl ? ctrl.id : ''} onChange={(e) => (e.target.value === '+' ? newController() : follow(e.target.value))}>
                    <option value="">Nothing: its own text</option>
                    {texts.length > 0 && <optgroup label="Text controllers">{texts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
                    {switches.length > 0 && <optgroup label="Switches (the state's name)">{switches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
                    <option value="+">New Text controller…</option>
                </select>
            </div>
            {ctrl && (
                <div className={styles.wideRow}>
                    <button type="button" className={styles.btn} onClick={() => comp.select({ kind: 'controller', id: ctrl.id })}>{`Edit ${ctrl.name}'s texts and cuts`}</button>
                </div>
            )}
        </>
    );
}

/** A text variable's words now, kept up with the playhead. */
function VariableWords({ v }) {
    const ref = useRef(null);
    const key = variableKey(v);
    useTick((t, frame) => {
        const g = frame && globalsOf(frame);
        if (ref.current && g) ref.current.textContent = String(g.text(key) ?? '');
    });
    return <span ref={ref} />;
}

/**
 * The variables an object uses, each with its value right here (and
 * linkable), buttons to define any it uses that don't exist yet, and a way
 * to make a new one and put it in the field being edited.
 */
export function UsedVariables({ obj }) {
    const comp = useComp();
    const scope = scopeOf(comp.project);
    const {
        vars, missing, splines, texts,
    } = readsOf(obj, scope);
    const asText = obj.type === 'text' || obj.type === 'splinePoint';
    const used = scope.varList.filter((v) => vars.has(variableKey(v)));
    const usedTexts = scope.textList.filter((v) => texts.has(variableKey(v)));
    // Text variables can only be shown, so only a text offers them.
    const others = [...scope.varList, ...(asText ? scope.textList : [])].filter((v) => !vars.has(variableKey(v)) && !texts.has(variableKey(v)));
    const otherSplines = scope.splineList.filter((o) => o.id !== obj.id && !splines.has(splineSymbol(o)));
    const [sym, setSym] = useState(() => (VARIABLE_LETTERS.find(([c]) => !scope.vars.has(c)) || VARIABLE_LETTERS[0])[0]);
    const [sub, setSub] = useState('');
    const [set, setSet] = useState('real');
    const key = sub.trim() ? `${sym}_${sub.trim()}` : sym;
    const taken = scope.vars.has(key) || scope.texts.has(key) || scope.splines.has(sym);
    const make = () => {
        comp.addVariable(sym, sub.trim(), false, VARIABLE_KINDS[set] || {});
        const name = sub.trim() ? `${sym}_{${sub.trim()}}` : sym;
        if (set === 'text') comp.setParam(obj.id, 'text', `${obj.params.text || ''}{{${name}}}`, true);
        else insertIntoLast(name, obj.id);
        const nextFree = VARIABLE_LETTERS.find(([c]) => c !== sym && !scope.vars.has(c) && !scope.texts.has(c));
        if (nextFree && !sub.trim()) setSym(nextFree[0]);
    };
    const put = (name) => {
        if (asText) {
            comp.setParam(obj.id, 'text', `${obj.params.text || ''}{{${name}}}`, true);
        } else if (!insertIntoLast(name, obj.id)) {
            comp.setStatus('Click in a field first, then pick what to put there');
        }
    };
    return (
        <>
            {!used.length && !usedTexts.length && !missing.size && !splines.size && (
                <p className={styles.hint}>{asText ? 'This text shows no values yet.' : 'This uses no variables yet.'}</p>
            )}
            {used.map((v) => <VariableValue key={v.id} v={v} />)}
            {usedTexts.map((v) => <TextVariableValue key={v.id} v={v} label={variableLabel(v)} />)}
            {used.length > 0 && <p className={styles.hint} style={{ margin: '2px 0 6px' }}>Right-click a value to drive it with a controller. These are global: the same everywhere they are used.</p>}
            {missing.size > 0 && (
                <>
                    <p className={styles.subTitle}>Not defined yet</p>
                    <div className={styles.chips}>
                        {Array.from(missing).map((k) => {
                            const [base, s] = splitKey(k);
                            const can = LOWER.has(base) && !scope.splines.has(base);
                            return (
                                <button
                                    key={k}
                                    type="button"
                                    className={`${styles.chip} ${styles.chipMissing}`}
                                    disabled={!can}
                                    title={can ? 'Make this variable' : 'Only lowercase greek letters can be variables; a capital is a spline’s symbol'}
                                    onClick={() => comp.addVariable(base, s, false)}
                                >
                                    {can ? `Define ${symbolLabel(base, s)}` : `${symbolLabel(base, s)} ?`}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
            {splines.size > 0 && (
                <>
                    <p className={styles.subTitle}>Splines read</p>
                    <div className={styles.chips}>
                        {Array.from(splines).map((s) => {
                            const o = scope.splineList.find((x) => splineSymbol(x) === s);
                            return <button key={s} type="button" className={styles.chip} onClick={() => o && comp.select({ kind: 'object', id: o.id })}>{s} · {o?.name}</button>;
                        })}
                    </div>
                </>
            )}
            {(others.length > 0 || otherSplines.length > 0) && (
                <>
                    <p className={styles.subTitle}>{asText ? 'Show a value' : 'Put in the field being edited'}</p>
                    <div className={styles.chips}>
                        {others.map((v) => (
                            <button key={v.id} type="button" className={styles.chip} onMouseDown={(e) => e.preventDefault()} onClick={() => put(v.sub ? `${v.symbol}_{${v.sub}}` : v.symbol)}>
                                {variableLabel(v)}
                            </button>
                        ))}
                        {otherSplines.map((o) => {
                            const s = splineSymbol(o);
                            return (
                                <button key={o.id} type="button" className={styles.chip} onMouseDown={(e) => e.preventDefault()} onClick={() => put(asText ? `${s}_0` : `${s}(t).x`)} title={asText ? `${s}_0: its first point` : `${s}(t).x: the spline at t, across`}>
                                    {s}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
            <p className={styles.subTitle}>New variable</p>
            <div className={styles.row}>
                <span className={styles.rowLabel}>Symbol</span>
                <span style={{ gridColumn: '2 / 4', display: 'flex', gap: 4 }}>
                    <select className={styles.select} value={sym} onChange={(e) => setSym(e.target.value)} title="Letter">
                        {VARIABLE_LETTERS.map(([c, n]) => <option key={c} value={c}>{`${c}  ${n}`}</option>)}
                    </select>
                    <input className={styles.num} style={{ width: 54, flex: 'none', textAlign: 'left' }} placeholder="sub" value={sub} onChange={(e) => setSub(e.target.value.replace(/[\s{}_]/g, ''))} title="Subscript (optional): 1, 12, k" />
                    <select className={styles.select} style={{ width: 52, flex: 'none' }} value={set} onChange={(e) => setSet(e.target.value)} title={asText ? 'Real, integer or text' : 'Real or integer'}>
                        <option value="real">ℝ</option>
                        <option value="int">ℤ</option>
                        {asText && <option value="text">T</option>}
                    </select>
                </span>
            </div>
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} disabled={taken} onMouseDown={(e) => e.preventDefault()} onClick={make}>
                    <Plus size={11} /> {taken ? `${symbolLabel(sym, sub.trim())} exists` : `Make ${symbolLabel(sym, sub.trim())}${asText ? '' : ' and use it'}`}
                </button>
            </div>
        </>
    );
}

// ---- Equations -----------------------------------------------------------------------

export function EquationEditor({ obj }) {
    const comp = useComp();
    const scope = scopeOf(comp.project);
    const p = obj.params;
    const preset = (id) => {
        const f = EQUATION_PRESETS.find(([k]) => k === id)?.[2];
        if (!f) return;
        comp.updateObject(obj.id, (o) => ({
            ...o, params: { ...o.params, fx: f.x, fy: f.y, fz: f.z, rangeFrom: f.from, rangeTo: f.to },
        }), true);
    };
    return (
        <>
            <div className={styles.row}>
                <span className={styles.rowLabel}>Preset</span>
                <select className={styles.select} style={{ gridColumn: '2 / 4' }} value="" onChange={(e) => preset(e.target.value)}>
                    <option value="">Load a shape…</option>
                    {EQUATION_PRESETS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
            </div>
            {[['fx', 'x(t)'], ['fy', 'y(t)'], ['fz', 'z(t)']].map(([key, label]) => (
                <div key={key} className={styles.exprRow}>
                    <span className={styles.exprLabel}>{label} =</span>
                    <ExprField
                        scope={scope}
                        owner={obj.id}
                        value={p[key]}
                        placeholder="0"
                        onChange={(v) => comp.setParam(obj.id, key, v)}
                        onCommit={comp.commit}
                    />
                </div>
            ))}
        </>
    );
}

// ---- Splines ----------------------------------------------------------------------------

const isNum = (s) => s !== '' && s !== null && Number.isFinite(Number(s));
const r4 = (v) => String(Math.round(v * 1e4) / 1e4);

export function SplineEditor({ obj }) {
    const comp = useComp();
    const scope = scopeOf(comp.project);
    const p = obj.params;
    const sym = splineSymbol(obj);
    const pts = p.points || [];
    const setPoints = (fn, done = true, coalesce = null) => comp.updateObject(obj.id, (o) => ({
        ...o, params: { ...o.params, points: fn((o.params.points || []).map((pt) => [...pt])) },
    }), done, coalesce);
    const setCell = (i, d) => (v) => setPoints((list) => { list[i][d] = v; return list; }, false, `pt:${obj.id}:${i}:${d}`);
    // A new point: half way to the next, or on past the last as far as the last step.
    const between = (a, b, k) => [0, 1, 2].map((d) => (isNum(a?.[d]) && isNum(b?.[d]) ? r4(Number(a[d]) + (Number(b[d]) - Number(a[d])) * k) : (a?.[d] ?? '0')));
    // Inserting, reordering and removing points take their labels along.
    const addAfter = (i) => comp.editPoints(obj.id, (list) => {
        const a = list[i];
        const b = list[i + 1];
        list.splice(i + 1, 0, b ? between(a, b, 0.5) : (list[i - 1] ? between(list[i - 1], a, 2) : between(a, a, 0).map((x, d) => (isNum(x) ? r4(Number(x) + (d === 0 ? 0.5 : 0)) : x))));
        return list;
    }, (k) => (k > i ? k + 1 : k));
    const move = (i, by) => {
        const j = i + by;
        if (j < 0 || j >= pts.length) return;
        comp.editPoints(obj.id, (list) => {
            [list[i], list[j]] = [list[j], list[i]];
            return list;
        }, (k) => (k === i ? j : k === j ? i : k));
    };
    const remove = (i) => {
        if (pts.length <= 1) return;
        comp.editPoints(obj.id, (list) => list.filter((_, k) => k !== i), (k) => (k === i ? -1 : k > i ? k - 1 : k));
    };
    const takenSyms = new Set([
        ...scope.splineList.filter((o) => o.id !== obj.id).map(splineSymbol),
        ...scope.varList.map((v) => v.symbol),
    ]);
    const dupe = scope.dupes.has(obj.id);
    const editing = comp.cornerOn === obj.id;
    const picked = editing && comp.cornerHandle < pts.length ? comp.cornerHandle : null;
    const written = pts.some((pt) => (pt || []).some((x) => !isNum(x)));

    // Solved as of the playhead, for its status.
    let st = null;
    try {
        const g = globalsOf(makeFrame(comp.project, comp.now(), comp.analysis), comp.project);
        st = g.spline(obj.id) || solveLoose(obj, g);
    } catch (e) {
        st = null;
    }
    const orders = endOrders(p.degree, 'clamped');
    const setClamp = (side, r, d) => (v) => comp.updateObject(obj.id, (o) => {
        const clamp = JSON.parse(JSON.stringify(o.params.clamp || { start: {}, end: {} }));
        clamp[side] = clamp[side] || {};
        const vec = clamp[side][r] || ['', '', ''];
        vec[d] = v;
        clamp[side][r] = vec;
        return { ...o, params: { ...o.params, clamp } };
    }, false, `cl:${obj.id}:${side}:${r}:${d}`);

    return (
        <>
            <div className={styles.row}>
                <span className={styles.rowLabel}>Symbol</span>
                <select
                    className={styles.select}
                    style={{ gridColumn: '2 / 4' }}
                    value={sym}
                    onChange={(e) => comp.setParam(obj.id, 'symbol', e.target.value, true)}
                >
                    {SPLINE_LETTERS.map(([c, n]) => (
                        <option key={c} value={c} disabled={takenSyms.has(c)}>{`${c}  ${n}${takenSyms.has(c) ? ' (taken)' : ''}`}</option>
                    ))}
                </select>
            </div>
            {dupe && <p className={`${styles.hint} ${styles.warn}`}>Another spline is already {sym}, so expressions read that one. Pick another symbol.</p>}
            <p className={styles.hint} style={{ margin: '4px 0' }}>
                {`${sym}_0 … ${sym}_${Math.max(0, pts.length - 1)} are its points, ${sym}(u) its curve (u from 0 to 1). Each coordinate can be a number or an expression.`}
            </p>
            <ParamRow
                def={{ key: 'edit', label: 'Edit in viewport', type: 'bool', link: false }}
                value={editing}
                onChange={(v) => { comp.setCornerOn(v ? obj.id : null); comp.setCornerHandle(ALL_POINTS); }}
            />
            {editing && (
                <>
                    <p className={styles.hint} style={{ margin: '2px 0 4px' }}>
                        Click a marker in the viewport (or a point&apos;s name below) and drag the gizmo; blue in the middle moves them all.
                        {written ? ' A point written as an expression becomes plain numbers once dragged.' : ''}
                    </p>
                    <div className={styles.chips}>
                        <button type="button" className={`${styles.chip} ${picked === null ? styles.btnOn : ''}`} onClick={() => comp.setCornerHandle(ALL_POINTS)}>All</button>
                        {pts.map((_, i) => (
                            // eslint-disable-next-line react/no-array-index-key
                            <button key={i} type="button" className={`${styles.chip} ${picked === i ? styles.btnOn : ''}`} onClick={() => comp.setCornerHandle(i)}>
                                {symbolLabel(sym, String(i))}
                            </button>
                        ))}
                    </div>
                </>
            )}
            {obj.gizmo === false && editing && <p className={`${styles.hint} ${styles.warn}`}>Turn the gizmo on for this spline (in the outliner) to drag its points.</p>}
            <div className={styles.pointRow} style={{ color: 'var(--dim)', fontSize: 10 }}>
                <span />
                <span>x</span>
                <span>y</span>
                <span>z</span>
                <span />
            </div>
            {pts.map((pt, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={i} className={styles.pointRow}>
                    <span
                        className={styles.exprLabel}
                        title={`${sym}_${i}: click to pick it in the viewport`}
                        style={{ cursor: 'pointer', color: picked === i ? 'var(--acc)' : undefined }}
                        onClick={() => { comp.setCornerOn(obj.id); comp.setCornerHandle(i); }}
                    >
                        {symbolLabel(sym, String(i))}
                    </span>
                    {[0, 1, 2].map((d) => (
                        <ExprField key={d} scope={scope} owner={obj.id} value={pt?.[d] ?? ''} placeholder="0" onChange={setCell(i, d)} onCommit={comp.commit} />
                    ))}
                    <span className={styles.pointTools}>
                        <button type="button" className={styles.olToggle} title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={11} /></button>
                        <button type="button" className={styles.olToggle} title="Later" disabled={i === pts.length - 1} onClick={() => move(i, 1)}><ArrowDown size={11} /></button>
                        <button type="button" className={styles.olToggle} title="Add a point after this one" onClick={() => addAfter(i)}><Plus size={11} /></button>
                        <button type="button" className={styles.olToggle} title="Remove" disabled={pts.length <= 1} onClick={() => remove(i)}><Trash2 size={11} /></button>
                    </span>
                </div>
            ))}
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} onClick={() => addAfter(pts.length - 1)}><Plus size={11} /> Add point</button>
            </div>
            {p.ends === 'clamped' && (
                <>
                    <p className={styles.subTitle}>Ends</p>
                    <p className={styles.hint} style={{ margin: '2px 0 4px' }}>
                        {`A ${['', 'linear', 'quadratic', 'cubic', 'quartic', 'quintic'][p.degree] || ''} spline needs these. Measured along the end stretch (0 to 1 across it). Left blank, a velocity follows the end stretch's chord and the rest are 0.`}
                    </p>
                    {[['start', 'Start'], ['end', 'End']].map(([side, label]) => orders[side].map((r) => (
                        <div key={`${side}${r}`} className={styles.pointRow} style={{ gridTemplateColumns: '64px repeat(3, minmax(0, 1fr))' }}>
                            <span className={styles.rowLabel} style={{ fontSize: 10 }}>{`${label} ${orderName(r)}`}</span>
                            {[0, 1, 2].map((d) => (
                                <ExprField key={d} scope={scope} owner={obj.id} value={p.clamp?.[side]?.[r]?.[d] ?? ''} placeholder={r === 1 ? 'auto' : '0'} onChange={setClamp(side, r, d)} onCommit={comp.commit} />
                            ))}
                        </div>
                    )))}
                    {!orders.start.length && !orders.end.length && <p className={styles.hint}>A linear spline needs nothing more.</p>}
                </>
            )}
            {st?.sol?.error && <p className={`${styles.hint} ${styles.warn}`}>{st.sol.error}</p>}
            {st?.sol?.note && <p className={`${styles.hint} ${styles.warn}`}>{st.sol.note}</p>}
        </>
    );
}

// ---- Text ---------------------------------------------------------------------------------

export function TextDynamic({ obj }) {
    const comp = useComp();
    const scope = scopeOf(comp.project);
    const latex = obj.params.textMode === 'latex';
    const append = (s) => comp.setParam(obj.id, 'text', `${obj.params.text || ''}${s}`, true);
    return (
        <>
            <p className={styles.hint}>
                {latex
                    ? 'Each line is typeset as maths, as LaTeX: x(t) = \\cos\\theta_1 t. Use \\text{…} for words. '
                    : ''}
                {'Put {{θ}} (or any expression: {{2ω_1:3}} to 3 decimals) in the text to show a value as it changes.'}
            </p>
            {(scope.varList.length > 0 || scope.splineList.length > 0 || scope.textList.length > 0) && (
                <div className={styles.row}>
                    <span className={styles.rowLabel}>Show</span>
                    <select
                        className={styles.select}
                        style={{ gridColumn: '2 / 4' }}
                        value=""
                        onChange={(e) => { if (e.target.value) append(e.target.value); }}
                    >
                        <option value="">Add a value…</option>
                        {scope.textList.length > 0 && (
                            <optgroup label="Text">
                                {scope.textList.map((v) => {
                                    const name = v.sub ? `${v.symbol}_{${v.sub}}` : v.symbol;
                                    return <option key={v.id} value={latex ? `\\text{{{${name}}}}` : `{{${name}}}`}>{`${variableLabel(v)} (text)`}</option>;
                                })}
                            </optgroup>
                        )}
                        <optgroup label="Value">
                            {scope.varList.map((v) => {
                                const name = v.sub ? `${v.symbol}_{${v.sub}}` : v.symbol;
                                return <option key={v.id} value={`{{${name}}}`}>{variableLabel(v)}</option>;
                            })}
                        </optgroup>
                        <optgroup label="Name = value">
                            {scope.varList.map((v) => {
                                const name = v.sub ? `${v.symbol}_{${v.sub}}` : v.symbol;
                                const head = latex ? symbolTex(v.symbol, v.sub) : variableLabel(v);
                                return <option key={v.id} value={`${head} = {{${name}}}`}>{`${variableLabel(v)} = …`}</option>;
                            })}
                        </optgroup>
                        {scope.splineList.length > 0 && (
                            <optgroup label="Spline points">
                                {scope.splineList.flatMap((o) => (o.params.points || []).map((_, i) => {
                                    const s = splineSymbol(o);
                                    // eslint-disable-next-line react/no-array-index-key
                                    return <option key={`${o.id}${i}`} value={`{{${s}_${i}}}`}>{symbolLabel(s, String(i))}</option>;
                                }))}
                            </optgroup>
                        )}
                    </select>
                </div>
            )}
        </>
    );
}

// ---- The Curve's way to an Equation -------------------------------------------------------

export function CurveConvert({ obj }) {
    const comp = useComp();
    return (
        <>
            <p className={styles.hint}>An Equation can draw this exactly (as points, flowing and pulsing the same), and more. This Curve stays where it is.</p>
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} onClick={() => comp.curveToEquation(obj.id)}>Make an Equation from this</button>
            </div>
        </>
    );
}

// ---- A variable's own panel --------------------------------------------------------------------

export function VariableInspector({ v }) {
    const comp = useComp();
    const scope = scopeOf(comp.project);
    const key = variableKey(v);
    const dupe = scope.dupes.has(v.id);
    const readout = useRef(null);
    useTick((t, frame) => {
        const g = frame && globalsOf(frame);
        if (readout.current && g) readout.current.textContent = dupe ? '—' : formatValue(g.value(key), v.set === 'int' ? 0 : 4);
    });
    const set = (patch) => comp.updateVariable(v.id, (o) => ({ ...o, ...patch }), true);
    const isText = v.set === 'text';
    const users = comp.project.objects.filter((o) => sourcesOf(o).some((src) => {
        if (!src) return false;
        const c = compileIn(scope, String(src));
        return c.vars.has(key) || (c.texts || new Set()).has(key);
    }));
    const kind = isText ? 'Text variable' : v.set === 'int' ? 'Integer variable' : 'Real variable';
    return (
        <>
            <div className={styles.insHead}>
                <span className={styles.insName} style={{ border: 'none', fontFamily: "'CMU Serif', Georgia, serif", fontStyle: 'italic', fontSize: 15 }}>{variableLabel(v)}</span>
                <span className={styles.insKind}>{kind}</span>
                <button type="button" className={styles.olToggle} title="Delete" onClick={() => comp.removeVariable(v.id)}><Trash2 size={12} /></button>
            </div>
            <div className={styles.groupBody} style={{ paddingTop: 8 }}>
                {dupe && <p className={`${styles.hint} ${styles.warn}`}>Another variable (or a spline) already has this name, so expressions read that one. Change the letter or subscript.</p>}
                <div className={styles.row}>
                    <span className={styles.rowLabel}>Letter</span>
                    <span style={{ gridColumn: '2 / 4', display: 'flex', gap: 4 }}>
                        <select className={styles.select} value={v.symbol} onChange={(e) => set({ symbol: e.target.value })}>
                            {VARIABLE_LETTERS.map(([c, n]) => <option key={c} value={c}>{`${c}  ${n}`}</option>)}
                        </select>
                        <input
                            className={styles.num}
                            style={{ width: 64, flex: 'none', textAlign: 'left' }}
                            placeholder="subscript"
                            value={v.sub || ''}
                            onChange={(e) => comp.updateVariable(v.id, (o) => ({ ...o, sub: e.target.value.replace(/[\s{}_]/g, '') }), false, `vs:${v.id}`)}
                            onBlur={comp.commit}
                        />
                    </span>
                </div>
                <div className={styles.row}>
                    <span className={styles.rowLabel}>Set</span>
                    <select
                        className={styles.select}
                        style={{ gridColumn: '2 / 4' }}
                        value={v.set}
                        onChange={(e) => {
                            const to = e.target.value;
                            if (to === 'text') set({ set: 'text', params: { ...v.params, text: v.params?.text ?? 'Text' } });
                            else if (to === 'int') set({ set: 'int', step: 1, min: Math.round(v.min ?? 0), max: Math.round(v.max ?? 10) });
                            else set({ set: 'real', step: v.step === 1 || !(v.step > 0) ? 0.01 : v.step });
                        }}
                    >
                        <option value="real">ℝ Real numbers</option>
                        <option value="int">ℤ Integers (rounded)</option>
                        <option value="text">T Text (shown, not worked with)</option>
                    </select>
                </div>
                {isText && (
                    <>
                        <TextVariableValue v={v} />
                        <p className={styles.hint}>
                            {`Show it in any text as {{${v.sub ? `${v.symbol}_{${v.sub}}` : v.symbol}}}, on its own between the braces. Have it follow a Text controller to cut between texts in that controller's lane, like a Switch (S at the playhead, or 1–9 for one). In LaTeX, words want \\text{…} round them: \\text{{{${v.sub ? `${v.symbol}_{${v.sub}}` : v.symbol}}}}.`}
                        </p>
                    </>
                )}
                {!isText && <VariableValue v={v} label="Value" />}
                {!isText && (
                    <>
                        <div className={styles.row}>
                            <span className={styles.rowLabel}>Now</span>
                            <span ref={readout} className={styles.varValue} style={{ gridColumn: '2 / 4' }} />
                        </div>
                        <p className={styles.subTitle}>Slider range</p>
                        <div className={styles.row}>
                            <span className={styles.rowLabel}>From</span>
                            <span style={{ gridColumn: '2 / 4' }}><NumberBox value={v.min} step={v.set === 'int' ? 1 : 0.01} onCommit={(x) => set({ min: x })} /></span>
                        </div>
                        <div className={styles.row}>
                            <span className={styles.rowLabel}>To</span>
                            <span style={{ gridColumn: '2 / 4' }}><NumberBox value={v.max} step={v.set === 'int' ? 1 : 0.01} onCommit={(x) => set({ max: x })} /></span>
                        </div>
                        {v.set !== 'int' && (
                            <div className={styles.row}>
                                <span className={styles.rowLabel}>Step</span>
                                <span style={{ gridColumn: '2 / 4' }}><NumberBox value={v.step} step={0.0001} onCommit={(x) => set({ step: Math.max(1e-6, x) })} /></span>
                            </div>
                        )}
                        <p className={styles.hint}>
                            {`Write it as ${v.sub ? `${v.symbol}_${v.sub}, ${v.symbol}_{${v.sub}} or \\${letterName(v.symbol)}_{${v.sub}}` : `${v.symbol}, ${letterName(v.symbol)} or \\${letterName(v.symbol)}`}. Right-click Value to drive it with a controller (a Keyframes one to animate it by hand).`}
                        </p>
                    </>
                )}
                <p className={styles.subTitle}>{`Used by (${users.length})`}</p>
                {!users.length && <p className={styles.hint}>Nothing reads it yet.</p>}
                {users.map((o) => (
                    <div key={o.id} className={styles.olRow} style={{ '--depth': 0 }} onClick={() => comp.select({ kind: 'object', id: o.id })}>
                        <span className={styles.olName}>{o.name}</span>
                        <span className={styles.olTag}>{OBJECT_TYPES[o.type]?.label}</span>
                    </div>
                ))}
            </div>
        </>
    );
}

// ---- Spline points --------------------------------------------------------------------

/** A spline's points as objects: its labels shown or hidden, put back, and a way to each. */
export function SplinePointList({ obj }) {
    const comp = useComp();
    const on = !!obj.params.labels;
    const kids = comp.project.objects.filter((o) => o.type === 'splinePoint' && o.parentId === obj.id && o.pointLabel)
        .sort((a, b) => a.pointLabel.index - b.pointLabel.index);
    const sym = splineSymbol(obj);
    return (
        <>
            <div className={styles.wideRow}>
                <button type="button" className={`${styles.btn} ${on ? styles.btnOn : ''}`} onClick={() => comp.setSplineLabels(obj.id, !on)}>
                    {on ? 'Hide labels' : 'Show labels'}
                </button>
                {on && kids.length > 0 && (
                    <button type="button" className={styles.btn} title="Every label back where and as it was first made (markers and the rest kept)" onClick={() => comp.setSplineLabels(obj.id, true, true)}>
                        Reset labels
                    </button>
                )}
            </div>
            {kids.length > 0 && (
                <div className={styles.chips}>
                    {kids.map((o) => {
                        const auto = o.params.text === o.pointLabel.text;
                        return (
                            <button
                                key={o.id}
                                type="button"
                                className={styles.chip}
                                title={`${o.name}${on ? (auto ? ': its label follows the point' : ': its label is rewritten, and keeps your words') : ''}. Click to select it.`}
                                onClick={() => comp.select({ kind: 'object', id: o.id })}
                            >
                                {`${symbolLabel(sym, String(o.pointLabel.index))}${on && !auto ? ' ✎' : ''}`}
                            </button>
                        );
                    })}
                </div>
            )}
            {!kids.length && obj.params.showKnots === false && !on && (
                <p className={styles.hint}>Show markers or labels and each point becomes an object of its own, under this spline.</p>
            )}
        </>
    );
}

/** On a spline's point: whose it is, and ways back. */
export function PointOf({ obj }) {
    const comp = useComp();
    const parent = comp.project.objects.find((o) => o.id === obj.parentId);
    if (!parent || !obj.pointLabel) return null;
    const auto = obj.params.text === obj.pointLabel.text;
    const name = symbolLabel(splineSymbol(parent), String(obj.pointLabel.index));
    return (
        <>
            <p className={styles.hint} style={{ margin: '2px 0 6px' }}>
                {`${name}, a point of ${parent.name}: its marker and its label, which go wherever the point does. Deleting it deletes the point. ${auto ? 'The label says what the point is, and keeps up as that changes; rewrite it and it keeps your words.' : 'You have rewritten its label, so it keeps your words.'}${parent.params.labels ? '' : ' Labels are off for the spline (Show labels, under its Defining points).'}`}
            </p>
            <div className={styles.wideRow}>
                <button type="button" className={styles.btn} onClick={() => comp.select({ kind: 'object', id: parent.id })}>{`Select ${parent.name}`}</button>
                <button
                    type="button"
                    className={styles.btn}
                    title="Drag the point in the viewport"
                    onClick={() => comp.pickSplinePoint(parent.id, obj.pointLabel.index)}
                >
                    Move the point
                </button>
                {!auto && (
                    <button
                        type="button"
                        className={styles.btn}
                        onClick={() => comp.updateObject(obj.id, (o) => ({ ...o, params: { ...o.params, text: o.pointLabel.text } }), true)}
                    >
                        Follow the point again
                    </button>
                )}
            </div>
        </>
    );
}
