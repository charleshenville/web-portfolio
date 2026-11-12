// Parameter controls. Every one can be right-clicked for its link menu:
// link it to a controller (or make a new one and link it), choose how the
// signal maps onto it, set the range it swings over, or unlink it.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAPS, applyMap, newLink } from '../model/maps';
import { CONTROLLER_TYPES, isSwitch } from '../model/controllers';
import { linkValue } from '../model/resolve';
import { useComp, useTick } from './context';
import ColorPicker, { isPickerEvent } from '../../ui/ColorPicker';
import styles from '../compositor.module.css';

const fmt = (v, step) => {
    if (!Number.isFinite(v)) return '';
    const d = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
    return v.toFixed(d);
};

function NumberBox({ value, step, onCommit, className = styles.num }) {
    const [text, setText] = useState(fmt(value, step));
    const [focused, setFocused] = useState(false);
    useEffect(() => { if (!focused) setText(fmt(value, step)); }, [value, step, focused]);
    return (
        <input
            className={className}
            type="number"
            step={step}
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); setText(fmt(value, step)); }}
            onChange={(e) => {
                setText(e.target.value);
                const n = parseFloat(e.target.value);
                if (!Number.isNaN(n)) onCommit(n);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
    );
}

/** A small plot of a map, for the menu. */
function MapGlyph({ id, color = 'currentColor' }) {
    const pts = [];
    for (let i = 0; i <= 16; i++) {
        const x = i / 16;
        pts.push(`${(x * 22 + 1).toFixed(1)},${(15 - applyMap(id, x) * 14).toFixed(1)}`);
    }
    return (
        <svg className={styles.mapCurve} width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
            <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.3" />
        </svg>
    );
}

export function LinkMenu({ at, def, value, link, onLink, onReset, onClose }) {
    const comp = useComp();
    const ref = useRef(null);
    const [pos, setPos] = useState({ left: at.x, top: at.y });
    const controllers = comp.project.controllers;
    const ctrl = link ? controllers.find((c) => c.id === link.controller) : null;
    // The controller list folds into a dropdown; open from the start when
    // nothing is linked yet, since picking one is what the menu is for.
    const [listOpen, setListOpen] = useState(!link);
    const [filter, setFilter] = useState('');
    const shown = filter.trim()
        ? controllers.filter((c) => `${c.name} ${CONTROLLER_TYPES[c.type]?.label || ''}`.toLowerCase().includes(filter.trim().toLowerCase()))
        : controllers;

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setPos({
            left: Math.min(at.x, window.innerWidth - r.width - 8),
            top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)),
        });
    }, [at, link, listOpen]);

    useEffect(() => {
        const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !isPickerEvent(e)) onClose(); };
        const esc = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('pointerdown', away, true);
        window.addEventListener('keydown', esc);
        return () => {
            window.removeEventListener('pointerdown', away, true);
            window.removeEventListener('keydown', esc);
        };
    }, [onClose]);

    const pick = (c) => {
        const next = newLink(def, value, c.id);
        if (isSwitch(c)) {
            next.state = Math.min(1, (c.states?.length || 1) - 1);
            if (def.type === 'number') { next.from = def.min ?? 0; next.to = value; }
        }
        setListOpen(false);
        setFilter('');
        // Keep the shape and range when moving a link to another controller.
        onLink(link ? { ...next, map: link.map, from: link.from ?? next.from, to: link.to ?? next.to } : next);
    };
    const linkable = def.link !== false && def.type !== 'select';

    return createPortal(
        <div ref={ref} className={styles.menu} style={pos} data-menu="" onContextMenu={(e) => e.preventDefault()}>
            <div className={styles.menuTitle}>{def.label}</div>
            {!linkable && <div className={styles.empty}>This one rebuilds geometry when it changes, so it can&apos;t follow a controller.</div>}
            {linkable && (
                <>
                    <div className={styles.menuTitle}>Link to controller</div>
                    <button type="button" className={`${styles.menuItem} ${styles.menuDrop}`} aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
                        {ctrl ? <span className={styles.swatch} style={{ background: ctrl.color }} /> : null}
                        <span className={styles.olName}>{ctrl ? ctrl.name : `Choose (${controllers.length})`}</span>
                        <span className={styles.olTag}>{listOpen ? '▴' : '▾'}</span>
                    </button>
                    {listOpen && (
                        <div className={styles.menuList}>
                            {controllers.length > 8 && (
                                <input
                                    className={styles.menuFilter}
                                    placeholder="Filter…"
                                    value={filter}
                                    autoFocus
                                    onChange={(e) => setFilter(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) pick(shown[0]); }}
                                />
                            )}
                            {shown.map((c) => (
                                <button key={c.id} type="button" className={`${styles.menuItem} ${ctrl?.id === c.id ? styles.menuItemOn : ''}`} onClick={() => pick(c)}>
                                    <span className={styles.swatch} style={{ background: c.color }} />
                                    <span className={styles.olName}>{c.name}</span>
                                    <span className={styles.olTag}>{CONTROLLER_TYPES[c.type]?.label}</span>
                                </button>
                            ))}
                            {!shown.length && <div className={styles.empty}>None match.</div>}
                        </div>
                    )}
                    <div className={styles.menuTitle}>New controller</div>
                    <div className={styles.menuGrid}>
                        {['keys', 'switch', 'logic', 'lfo', 'kick', 'band'].map((type) => (
                            <button
                                key={type}
                                type="button"
                                className={styles.menuItem}
                                onClick={() => { const c = comp.addController(type); pick(c); }}
                            >
                                {CONTROLLER_TYPES[type].label}
                            </button>
                        ))}
                    </div>
                </>
            )}
            {link && ctrl && (
                <>
                    <div className={styles.menuSep} />
                    {isSwitch(ctrl) ? (
                        <>
                            <div className={styles.menuTitle}>On when the switch is</div>
                            <div className={styles.menuGrid}>
                                {ctrl.states.map((s, i) => (
                                    <button key={s + i} type="button" className={`${styles.menuItem} ${link.state === i ? styles.menuItemOn : ''}`} onClick={() => onLink({ ...link, state: i })}>
                                        {s}
                                    </button>
                                ))}
                            </div>
                            <button type="button" className={`${styles.menuItem} ${link.map === 'inverted' ? styles.menuItemOn : ''}`} onClick={() => onLink({ ...link, map: link.map === 'inverted' ? 'normal' : 'inverted' })}>
                                Invert (on when it is not)
                            </button>
                        </>
                    ) : (
                        <>
                            <div className={styles.menuTitle}>Map</div>
                            <div className={styles.menuGrid}>
                                {MAPS.map((m) => (
                                    <button key={m.id} type="button" title={m.label} className={`${styles.menuItem} ${link.map === m.id ? styles.menuItemOn : ''}`} onClick={() => onLink({ ...link, map: m.id })}>
                                        <MapGlyph id={m.id} />
                                    </button>
                                ))}
                            </div>
                            <div className={styles.menuTitle} style={{ paddingTop: 0 }}>{MAPS.find((m) => m.id === link.map)?.label}</div>
                        </>
                    )}
                    {def.type === 'number' && (
                        <>
                            <div className={styles.menuRange}>
                                <span className={styles.olTag}>{isSwitch(ctrl) ? 'Off' : 'From'}</span>
                                <NumberBox value={link.from} step={def.step || 0.01} onCommit={(v) => onLink({ ...link, from: v })} />
                            </div>
                            <div className={styles.menuRange}>
                                <span className={styles.olTag}>{isSwitch(ctrl) ? 'On' : 'To'}</span>
                                <NumberBox value={link.to} step={def.step || 0.01} onCommit={(v) => onLink({ ...link, to: v })} />
                            </div>
                        </>
                    )}
                    {def.type === 'color' && (
                        <>
                            <div className={styles.menuRange}>
                                <span className={styles.olTag}>From</span>
                                <ColorPicker value={link.from} onChange={(v) => onLink({ ...link, from: v })} title="From" />
                            </div>
                            <div className={styles.menuRange}>
                                <span className={styles.olTag}>To</span>
                                <ColorPicker value={link.to} onChange={(v) => onLink({ ...link, to: v })} title="To" />
                            </div>
                        </>
                    )}
                    <button type="button" className={styles.menuItem} onClick={() => { comp.selectController(ctrl.id); onClose(); }}>
                        Open {ctrl.name}
                    </button>
                    <button type="button" className={styles.menuItem} onClick={() => { onLink(null); onClose(); }}>Unlink</button>
                </>
            )}
            <div className={styles.menuSep} />
            <button type="button" className={styles.menuItem} onClick={() => { onReset(); onClose(); }}>Reset to default</button>
        </div>,
        document.body,
    );
}

/**
 * One parameter. `owner` is whatever holds it (an object or a track), so
 * a linked control can show where its controller has it right now.
 */
export function ParamRow({ def, value, link, onChange, onLink, onCommit }) {
    const comp = useComp();
    const [menu, setMenu] = useState(null);
    const tickRef = useRef(null);
    const ctrl = link ? comp.project.controllers.find((c) => c.id === link.controller) : null;
    const linked = !!ctrl;

    useTick((t, frame) => {
        const el = tickRef.current;
        if (!el || !linked || !frame) return;
        const v = linkValue(def, link, frame);
        if (def.type === 'number') {
            const k = (v - def.min) / Math.max(1e-9, def.max - def.min);
            el.style.left = `${Math.max(0, Math.min(1, k)) * 100}%`;
        } else if (def.type === 'bool') {
            el.style.opacity = v ? 1 : 0.2;
        } else if (def.type === 'color') {
            el.style.background = v;
        }
    });

    const onContext = (e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
    };
    const reset = () => onChange(def.def ?? value);

    let control;
    if (def.type === 'bool') {
        control = (
            <span style={{ gridColumn: '2 / 4', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button type="button" aria-pressed={!!value} className={`${styles.check} ${value ? styles.checkOn : ''}`} style={{ gridColumn: 'auto' }} onClick={() => { onChange(!value); onCommit?.(); }} />
                {linked && <span ref={tickRef} className={styles.linkDot} style={{ background: ctrl.color }} />}
            </span>
        );
    } else if (def.type === 'color' && linked) {
        // While linked, the controller picks between the link's two colours
        // and the parameter's own value is unused, so edit those two here
        // (Off / On for a Switch), with the colour it is right now beside them.
        const sw = isSwitch(ctrl);
        control = (
            <span style={{ gridColumn: '2 / 4', display: 'flex', alignItems: 'center', gap: 6 }}>
                <ColorPicker compact value={link.from || '#000000'} onChange={(v) => onLink({ ...link, from: v })} onCommit={() => onCommit?.()} title={sw ? 'Off' : 'From'} />
                <span className={styles.olTag}>→</span>
                <ColorPicker compact value={link.to || '#ffffff'} onChange={(v) => onLink({ ...link, to: v })} onCommit={() => onCommit?.()} title={sw ? 'On' : 'To'} />
                <span ref={tickRef} title="Now" className={styles.linkDot} style={{ width: 14, height: 14, flex: 'none', border: `1px solid ${ctrl.color}` }} />
            </span>
        );
    } else if (def.type === 'color') {
        control = (
            <span style={{ gridColumn: '2 / 4', display: 'flex', alignItems: 'center', gap: 6 }}>
                <ColorPicker value={value || '#000000'} onChange={onChange} onCommit={() => onCommit?.()} title={def.label} />
            </span>
        );
    } else if (def.type === 'text') {
        control = (
            <textarea
                className={styles.textArea}
                rows={Math.min(8, Math.max(2, String(value || '').split('\n').length))}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => onCommit?.()}
            />
        );
    } else if (def.type === 'string') {
        control = (
            <input
                className={styles.num}
                style={{ gridColumn: '2 / 4', textAlign: 'left' }}
                value={value ?? ''}
                placeholder={def.placeholder || ''}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => onCommit?.()}
            />
        );
    } else if (def.type === 'select') {
        control = (
            <select
                className={styles.select}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(e) => {
                    const opt = def.options.find(([v]) => String(v ?? '') === e.target.value);
                    onChange(opt ? opt[0] : e.target.value);
                    onCommit?.();
                }}
            >
                {def.options.map(([v, label]) => <option key={String(v)} value={v === null ? '' : String(v)}>{label}</option>)}
            </select>
        );
    } else {
        const span = Math.max(1e-9, def.max - def.min);
        const pct = (v) => `${Math.max(0, Math.min(1, (v - def.min) / span)) * 100}%`;
        const lo = linked && !isSwitch(ctrl) ? Math.min(link.from, link.to) : null;
        const hi = linked && !isSwitch(ctrl) ? Math.max(link.from, link.to) : null;
        control = (
            <>
                <span className={styles.sliderWrap}>
                    {linked && lo !== null && (
                        <span className={styles.linkBand} style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, background: ctrl.color }} />
                    )}
                    <input
                        className={styles.slider}
                        type="range"
                        min={def.min}
                        max={def.max}
                        step={def.step}
                        value={Number.isFinite(value) ? Math.max(def.min, Math.min(def.max, value)) : def.min}
                        onChange={(e) => onChange(parseFloat(e.target.value))}
                        onPointerUp={() => onCommit?.()}
                        onKeyUp={() => onCommit?.()}
                    />
                    {linked && <span ref={tickRef} className={styles.liveTick} style={{ background: ctrl.color }} />}
                </span>
                <NumberBox value={value} step={def.step} onCommit={(v) => { onChange(v); onCommit?.(); }} />
            </>
        );
    }

    return (
        <div className={`${styles.row} ${linked ? styles.rowLinked : ''}`} onContextMenu={onContext} title={linked ? `Linked to ${ctrl.name} · right-click to change` : 'Right-click to link to a controller'}>
            <span className={styles.rowLabel}>
                {linked && <span className={styles.linkDot} style={{ background: ctrl.color }} />}
                {def.label}
            </span>
            {control}
            {menu && (
                <LinkMenu
                    at={menu}
                    def={def}
                    value={value}
                    link={linked ? link : null}
                    onLink={(l) => { onLink(l); onCommit?.(); }}
                    onReset={() => { reset(); onCommit?.(); }}
                    onClose={() => setMenu(null)}
                />
            )}
        </div>
    );
}

export { NumberBox };
