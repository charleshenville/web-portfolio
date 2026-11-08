// Link maps: how a controller's 0..1 signal is shaped before it lands on a
// parameter. Picked from the right-click menu on any linked control.
//
// A link drives its parameter between two values, `from` (signal 0) and `to`
// (signal 1), through the map. Booleans are on wherever the mapped signal is
// at or over a half; a Switch controller's link instead names the state it is
// on in, and the map only decides whether that is inverted.

export const MAPS = [
    { id: 'normal', label: 'Normal', fn: (x) => x },
    { id: 'inverted', label: 'Inverted', fn: (x) => 1 - x },
    { id: 'easeIn', label: 'Ease in', fn: (x) => x * x },
    { id: 'easeOut', label: 'Ease out', fn: (x) => 1 - (1 - x) * (1 - x) },
    { id: 'smooth', label: 'S-curve', fn: (x) => x * x * (3 - 2 * x) },
    { id: 'punch', label: 'Punch', fn: (x) => x ** 3 },
    { id: 'soft', label: 'Soft', fn: (x) => Math.sqrt(Math.max(0, x)) },
    { id: 'gate', label: 'Gate', fn: (x) => (x >= 0.5 ? 1 : 0) },
    { id: 'bounce', label: 'Overshoot', fn: (x) => 1 - Math.cos(x * Math.PI * 1.5) * (1 - x) },
];

export const MAP = Object.fromEntries(MAPS.map((m) => [m.id, m]));

export const applyMap = (id, x) => {
    const v = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    return (MAP[id] || MAP.normal).fn(v);
};

// ---- Colours ----------------------------------------------------------------

const hexToRgb = (hex) => {
    const h = String(hex || '#000000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0'), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

export function mixColor(a, b, k) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return rgbToHex(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
}

/** A fresh link for `def` (a parameter definition) currently at `value`. */
export function newLink(def, value, controllerId) {
    if (def.type === 'bool') return { controller: controllerId, map: 'normal', state: null };
    if (def.type === 'color') return { controller: controllerId, map: 'normal', from: value, to: '#ffffff' };
    const lo = def.min ?? 0;
    const hi = def.max ?? 1;
    const v = Number.isFinite(value) ? value : (def.def ?? lo);
    const r = (x) => Math.round(x / (def.step || 0.001)) * (def.step || 0.001);
    // A parameter may say how far a fresh link should swing it; one centred
    // on zero (a position, an angle) swings a tenth of its range; anything
    // else swings to whichever end is further away (an opacity to 0).
    let to;
    if (Number.isFinite(def.swing)) to = v + def.swing;
    else if (lo < 0 && hi > 0) to = v + (hi - lo) * 0.1;
    else to = (v - lo) < (hi - v) ? hi : lo;
    return { controller: controllerId, map: 'normal', from: v, to: r(Math.max(lo, Math.min(hi, to))) };
}
