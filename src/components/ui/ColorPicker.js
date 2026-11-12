import React, {
    useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './colorPicker.module.css';

// The site's colour picker, in place of the browser's: a swatch that opens
// a panel with a hue / saturation wheel and sliders for R G B or H S V
// (the choice is remembered), each track showing the colours it would give,
// plus a hex field. Values in and out are '#rrggbb'.
//
// The panel is portalled to the body and carries data-color-picker, so a
// menu that closes on outside clicks can tell it apart (see isPickerEvent).

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = ([r, g, b]) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;

/** [h 0-360, s 0-1, v 0-1] */
export function rgbToHsv([r, g, b]) {
    const R = r / 255;
    const G = g / 255;
    const B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === R) h = ((G - B) / d) % 6;
        else if (max === G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, max > 0 ? d / max : 0, max];
}

export function hsvToRgb([h, s, v]) {
    const f = (n) => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
}

const hsvHex = (hsv) => rgbToHex(hsvToRgb(hsv));

/** Whether a DOM event happened inside a colour picker's panel. */
export const isPickerEvent = (e) => !!e.target?.closest?.('[data-color-picker]');

const MODE_KEY = 'colorPickerMode';
const readMode = () => {
    try { return localStorage.getItem(MODE_KEY) === 'rgb' ? 'rgb' : 'hsv'; } catch (e) { return 'hsv'; }
};

// ---- The wheel -----------------------------------------------------------------------

const WHEEL_PX = 196;

function Wheel({ hsv, onPick }) {
    const canvasRef = useRef(null);
    const drawn = useRef(-1);
    // Drawn at the current brightness (never quite black, so it stays readable).
    const shade = Math.round(Math.max(0.18, hsv[2]) * 40) / 40;

    useEffect(() => {
        const c = canvasRef.current;
        if (!c || drawn.current === shade) return;
        drawn.current = shade;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const n = Math.round(WHEEL_PX * dpr);
        c.width = n;
        c.height = n;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(n, n);
        const R = n / 2;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const dx = x + 0.5 - R;
                const dy = R - (y + 0.5);
                const d = Math.hypot(dx, dy) / R;
                const o = (y * n + x) * 4;
                if (d > 1) continue;
                let h = (Math.atan2(dy, dx) * 180) / Math.PI;
                if (h < 0) h += 360;
                const [r, g, b] = hsvToRgb([h, d, shade]);
                img.data[o] = r;
                img.data[o + 1] = g;
                img.data[o + 2] = b;
                // A pixel of soft edge.
                img.data[o + 3] = Math.round(clamp((1 - d) * R, 0, 1) * 255);
            }
        }
        ctx.putImageData(img, 0, 0);
    }, [shade]);

    const at = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = (r.top + r.height / 2) - e.clientY;
        let h = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (h < 0) h += 360;
        onPick(h, clamp(Math.hypot(dx, dy) / (r.width / 2), 0, 1));
    };

    const a = (hsv[0] * Math.PI) / 180;
    const cx = 50 + Math.cos(a) * hsv[1] * 50;
    const cy = 50 - Math.sin(a) * hsv[1] * 50;
    return (
        <div
            className={styles.wheelWrap}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); at(e); }}
            onPointerMove={(e) => { if (e.buttons & 1) at(e); }}
            role="slider"
            aria-label="Hue and saturation"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv[0])}
            aria-valuetext={`hue ${Math.round(hsv[0])}, saturation ${Math.round(hsv[1] * 100)}%`}
        >
            <canvas ref={canvasRef} className={styles.wheel} />
            <span className={styles.cursor} style={{ left: `${cx}%`, top: `${cy}%`, background: hsvHex(hsv) }} />
        </div>
    );
}

// ---- A slider with its own colour track ------------------------------------------------

function Channel({
    label, value, max, step, track, onChange,
}) {
    const [text, setText] = useState(String(Math.round(value)));
    const [focused, setFocused] = useState(false);
    useEffect(() => { if (!focused) setText(String(Math.round(value))); }, [value, focused]);
    return (
        <div className={styles.row}>
            <span className={styles.channel}>{label}</span>
            <input
                type="range"
                className={styles.slider}
                min={0}
                max={max}
                step={step}
                value={value}
                style={{ background: track }}
                aria-label={label}
                onChange={(e) => onChange(parseFloat(e.target.value))}
            />
            <input
                type="number"
                className={styles.num}
                min={0}
                max={max}
                value={text}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) => {
                    setText(e.target.value);
                    const n = parseFloat(e.target.value);
                    if (!Number.isNaN(n)) onChange(clamp(n, 0, max));
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
        </div>
    );
}

const grad = (stops) => `linear-gradient(to right, ${stops.join(', ')})`;

// ---- The picker ------------------------------------------------------------------------

/**
 * `value` '#rrggbb', `onChange(hex)` while it moves, `onCommit()` when the
 * panel closes (for undo history). `compact` shows the swatch alone.
 */
export default function ColorPicker({
    value, onChange, onCommit, className, style, compact = false, title, disabled = false,
}) {
    const [open, setOpen] = useState(false);
    const [mode, setModeState] = useState(readMode);
    const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value) || [0, 0, 0]));
    const [hexText, setHexText] = useState(value || '#000000');
    const [pos, setPos] = useState({ left: 0, top: 0 });
    const [reflow, setReflow] = useState(0);
    const [over, setOver] = useState(false);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);
    const lastOut = useRef(null);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;

    // Follow outside changes, keeping the hue when the colour is grey.
    useEffect(() => {
        const rgb = hexToRgb(value);
        if (!rgb) return;
        const hex = rgbToHex(rgb);
        setHexText(hex);
        if (hex === lastOut.current) return;
        const next = rgbToHsv(rgb);
        setHsv((prev) => [next[1] > 0 && next[2] > 0 ? next[0] : prev[0], next[2] > 0 ? next[1] : prev[1], next[2]]);
    }, [value]);

    const emit = (nextHsv) => {
        setHsv(nextHsv);
        const hex = hsvHex(nextHsv);
        lastOut.current = hex;
        setHexText(hex);
        onChange?.(hex);
    };
    const emitRgb = (rgb) => {
        const hex = rgbToHex(rgb);
        const next = rgbToHsv(hexToRgb(hex));
        emit([next[1] > 0 && next[2] > 0 ? next[0] : hsv[0], next[2] > 0 ? next[1] : hsv[1], next[2]]);
    };

    const setMode = (m) => {
        setModeState(m);
        try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* private window */ }
    };

    const close = () => {
        setOpen(false);
        commitRef.current?.();
    };

    // Under the swatch, or above it when there is no room; inside the window.
    useLayoutEffect(() => {
        if (!open) return;
        const t = triggerRef.current?.getBoundingClientRect();
        const p = panelRef.current?.getBoundingClientRect();
        if (!t || !p) return;
        let top = t.bottom + 4;
        if (top + p.height > window.innerHeight - 8) top = Math.max(8, t.top - p.height - 4);
        const left = clamp(t.left, 8, window.innerWidth - p.width - 8);
        setPos({ left, top });
    }, [open, reflow]);

    useEffect(() => {
        if (!open) return undefined;
        const away = (e) => {
            if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
            close();
        };
        const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        // The window or a panel scrolling moves the swatch: follow it.
        const off = () => setReflow((n) => n + 1);
        window.addEventListener('pointerdown', away, true);
        window.addEventListener('keydown', esc, true);
        window.addEventListener('resize', off);
        window.addEventListener('scroll', off, true);
        return () => {
            window.removeEventListener('scroll', off, true);
            window.removeEventListener('pointerdown', away, true);
            window.removeEventListener('keydown', esc, true);
            window.removeEventListener('resize', off);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const hex = hsvHex(hsv);
    const rgb = hsvToRgb(hsv).map((v) => Math.round(v));
    const [h, s, v] = hsv;

    const channels = mode === 'rgb'
        ? [
            ['R', rgb[0], 255, grad([rgbToHex([0, rgb[1], rgb[2]]), rgbToHex([255, rgb[1], rgb[2]])]), (x) => emitRgb([x, rgb[1], rgb[2]])],
            ['G', rgb[1], 255, grad([rgbToHex([rgb[0], 0, rgb[2]]), rgbToHex([rgb[0], 255, rgb[2]])]), (x) => emitRgb([rgb[0], x, rgb[2]])],
            ['B', rgb[2], 255, grad([rgbToHex([rgb[0], rgb[1], 0]), rgbToHex([rgb[0], rgb[1], 255])]), (x) => emitRgb([rgb[0], rgb[1], x])],
        ]
        : [
            ['H', h, 360, grad([0, 60, 120, 180, 240, 300, 360].map((x) => hsvHex([x, Math.max(s, 0.15), Math.max(v, 0.3)]))), (x) => emit([x, s, v])],
            ['S', s * 100, 100, grad([hsvHex([h, 0, v]), hsvHex([h, 1, v])]), (x) => emit([h, x / 100, v])],
            ['V', v * 100, 100, grad(['#000000', hsvHex([h, s, 1])]), (x) => emit([h, s, x / 100])],
        ];

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`${styles.swatch} ${open ? styles.swatchOpen : ''} ${className || ''}`}
                style={style}
                title={title || hex}
                disabled={disabled}
                aria-label={title ? `${title}: ${hex}` : `Colour ${hex}`}
                aria-expanded={open}
                onClick={(e) => {
                    if (open) { close(); return; }
                    // Opened from inside a menu: draw over that menu.
                    setOver(!!e.currentTarget.closest('[data-menu]'));
                    setOpen(true);
                }}
            >
                <span className={`${styles.chip} ${compact ? styles.chipWide : ''}`} style={{ background: value || hex }} />
                {!compact && <span className={styles.hexLabel}>{(value || hex).replace('#', '')}</span>}
            </button>
            {open && createPortal(
                <div
                    ref={panelRef}
                    className={`${styles.panel} ${over ? styles.panelOver : ''}`}
                    style={pos}
                    data-color-picker=""
                    role="dialog"
                    aria-label="Colour picker"
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <Wheel hsv={hsv} onPick={(nh, ns) => emit([nh, ns, v > 0 ? v : 1])} />
                    <div className={styles.modes}>
                        {[['hsv', 'HSV'], ['rgb', 'RGB']].map(([id, label]) => (
                            <button key={id} type="button" className={`${styles.mode} ${mode === id ? styles.modeOn : ''}`} onClick={() => setMode(id)}>
                                {label}
                            </button>
                        ))}
                    </div>
                    {channels.map(([label, val, max, track, set]) => (
                        <Channel key={label} label={label} value={val} max={max} step={max === 255 ? 1 : 0.1} track={track} onChange={set} />
                    ))}
                    <div className={styles.foot}>
                        <span className={styles.preview} style={{ background: hex }} />
                        <input
                            className={styles.hex}
                            value={hexText}
                            spellCheck={false}
                            aria-label="Hex"
                            onChange={(e) => {
                                setHexText(e.target.value);
                                // Only a full six digits while typing: three would
                                // match the #rgb shorthand halfway through '#123456'.
                                const c = /^#?[0-9a-f]{6}$/i.test(e.target.value.trim()) && hexToRgb(e.target.value);
                                if (c) emitRgb(c);
                            }}
                            onBlur={() => {
                                const c = hexToRgb(hexText);
                                if (c && rgbToHex(c) !== hex) emitRgb(c); else setHexText(hex);
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                const c = hexToRgb(hexText);
                                if (c && rgbToHex(c) !== hex) emitRgb(c);
                                close();
                            }}
                        />
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
