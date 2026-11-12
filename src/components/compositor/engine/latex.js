// LaTeX for text objects: MathJax, loaded the first time some text asks
// for it (it is big, and most projects never do), then each line laid out
// once and drawn onto the text's canvas as paths.

let mod = null;
let pending = null;
let failed = false;

/** Load MathJax; resolves once LaTeX can be laid out. */
export function loadTex() {
    if (mod) return Promise.resolve();
    if (!pending) {
        pending = import('./mathjax').then((m) => { mod = m; }).catch((e) => {
            failed = true;
            pending = null;
            throw e;
        });
    }
    return pending;
}

export const texFailed = () => failed;

const cache = new Map();

/**
 * One line of TeX laid out: `{ width, ascent, descent, ops }` in em (see
 * mathjax.js), or null while MathJax is still loading.
 */
export function texLayout(tex) {
    if (!mod) {
        loadTex().catch(() => {});
        return null;
    }
    const key = String(tex);
    let box = cache.get(key);
    if (!box) {
        try {
            box = mod.texToOps(key, true);
        } catch (e) {
            box = null;
        }
        if (!box) box = { width: 0, ascent: 0.75, descent: 0.25, ops: [], x0: 0 };
        box.ops.forEach((op) => { if (op.path) op.p2d = new Path2D(op.path); });
        if (cache.size > 400) cache.delete(cache.keys().next().value);
        cache.set(key, box);
    }
    return box;
}

/** Draw `box` with its baseline's left end at (x, y), `em` pixels to the em, in `color`. */
export function drawTex(g, box, x, y, em, color) {
    const paint = (v) => (!v || v === 'currentColor' ? color : v);
    g.save();
    g.translate(x, y);
    const s = em / 1000;
    g.scale(s, s);
    g.translate(-(box.x0 || 0), 0);
    box.ops.forEach((op) => {
        g.save();
        g.transform(...op.m);
        if (op.path) {
            if (op.fill !== 'none') {
                g.fillStyle = paint(op.fill);
                g.fill(op.p2d);
            }
            if (op.sw > 0 && op.stroke && op.stroke !== 'none') {
                g.lineWidth = op.sw;
                g.strokeStyle = paint(op.stroke);
                g.stroke(op.p2d);
            }
        } else if (op.rect) {
            if (op.fill === 'none') { g.restore(); return; }
            g.fillStyle = paint(op.fill);
            g.fillRect(op.rect[0], op.rect[1], op.rect[2], op.rect[3]);
        } else if (op.frame || op.line) {
            if (op.stroke === 'none') { g.restore(); return; }
            g.lineWidth = op.sw;
            g.strokeStyle = paint(op.stroke);
            g.setLineDash(op.dash || []);
            if (op.dash && op.dash[0] === 0) g.lineCap = 'round';
            if (op.frame) g.strokeRect(op.frame[0], op.frame[1], op.frame[2], op.frame[3]);
            else {
                g.beginPath();
                g.moveTo(op.line[0], op.line[1]);
                g.lineTo(op.line[2], op.line[3]);
                g.stroke();
            }
        } else if (op.text) {
            g.fillStyle = paint(op.fill);
            g.font = op.font;
            g.fillText(op.text, 0, 0);
        }
        g.restore();
    });
    g.restore();
}
