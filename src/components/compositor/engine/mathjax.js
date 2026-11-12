// MathJax, TeX in and SVG out, loaded only when some text is LaTeX (see
// latex.js, which imports this lazily). Its SVG is walked straight into
// drawing operations for a 2D canvas: glyphs are paths, so nothing waits on
// a font or an image decode and every frame of an export draws exactly.

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', {
    InputJax: new TeX({ packages: AllPackages.filter((p) => p !== 'bussproofs') }),
    OutputJax: new SVG({ fontCache: 'none' }),
});

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

/** An SVG transform attribute as a 2D matrix [a, b, c, d, e, f]. */
function parseTransform(str) {
    let m = [1, 0, 0, 1, 0, 0];
    const mul = (n) => {
        const [a, b, c, d, e, f] = m;
        m = [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f];
    };
    const re = /(\w+)\(([^)]*)\)/g;
    let hit;
    while ((hit = re.exec(str || ''))) {
        const v = hit[2].split(/[\s,]+/).filter(Boolean).map(Number);
        if (hit[1] === 'translate') mul([1, 0, 0, 1, v[0] || 0, v[1] || 0]);
        else if (hit[1] === 'scale') mul([v[0], 0, 0, v[1] ?? v[0], 0, 0]);
        else if (hit[1] === 'matrix' && v.length === 6) mul(v);
        else if (hit[1] === 'rotate') {
            const r = ((v[0] || 0) * Math.PI) / 180;
            mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        }
    }
    return m;
}

const attr = (n, k) => adaptor.getAttribute(n, k);
const dashOf = (n) => {
    const cls = attr(n, 'class') || '';
    if (cls.includes('mjx-dashed')) return [140, 140];
    if (cls.includes('mjx-dotted')) return [0, 140];
    return null;
};

/** The drawing operations under node `n`: { m, fill, stroke, path | rect | line | text } in a flat list. */
function walk(n, m, fill, stroke, out) {
    const kind = adaptor.kind(n);
    if (kind === '#text' || kind === '#comment') return;
    const t = attr(n, 'transform');
    let here = m;
    if (t) {
        const k = parseTransform(t);
        const [a, b, c, d, e, f] = m;
        here = [a * k[0] + c * k[1], b * k[0] + d * k[1], a * k[2] + c * k[3], b * k[2] + d * k[3], a * k[4] + c * k[5] + e, b * k[4] + d * k[5] + f];
    }
    if (kind === 'svg') {
        // A nested svg: placed at its x, y.
        const [a, b, c, d, e, f] = here;
        const x = num(attr(n, 'x'));
        const y = num(attr(n, 'y'));
        here = [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
    }
    const fl = attr(n, 'fill') ?? fill;
    const st = attr(n, 'stroke') ?? stroke;
    if (kind === 'path') {
        const d = attr(n, 'd');
        if (d) out.push({ m: here, fill: fl, stroke: st, sw: num(attr(n, 'stroke-width')), path: d });
    } else if (kind === 'rect') {
        const rect = [num(attr(n, 'x')), num(attr(n, 'y')), num(attr(n, 'width')), num(attr(n, 'height'))];
        // A table's frame is an outline (MathJax's own CSS strokes it 70 wide).
        if (attr(n, 'data-frame') != null) out.push({ m: here, stroke: st || fl, sw: 70, dash: dashOf(n), frame: rect });
        else out.push({ m: here, fill: fl, rect });
    } else if (kind === 'line') {
        out.push({
            m: here, stroke: st || fl, sw: num(attr(n, 'stroke-width'), 70), dash: dashOf(n), line: [num(attr(n, 'x1')), num(attr(n, 'y1')), num(attr(n, 'x2')), num(attr(n, 'y2'))],
        });
    } else if (kind === 'text') {
        const txt = adaptor.textContent(n);
        if (txt) {
            out.push({
                m: here,
                fill: fl,
                text: txt,
                font: `${attr(n, 'font-style') || ''} ${attr(n, 'font-weight') || ''} ${num(attr(n, 'font-size'), 1000)}px ${attr(n, 'font-family') || 'serif'}`.trim(),
            });
        }
    }
    adaptor.childNodes(n).forEach((c) => walk(c, here, fl, st, out));
}

/**
 * `tex` as drawing operations in em-thousandths, baseline at y = 0 (y down):
 * `{ width, ascent, descent, ops }`, the sizes in em.
 */
export function texToOps(tex, display = true) {
    const node = doc.convert(String(tex || ''), { display });
    const svg = adaptor.childNodes(node).find((c) => adaptor.kind(c) === 'svg');
    if (!svg) return null;
    const vb = (attr(svg, 'viewBox') || '0 0 0 0').split(/[\s,]+/).map(Number);
    const ops = [];
    adaptor.childNodes(svg).forEach((c) => walk(c, [1, 0, 0, 1, 0, 0], 'currentColor', 'currentColor', ops));
    return {
        width: vb[2] / 1000,
        ascent: -vb[1] / 1000,
        descent: (vb[3] + vb[1]) / 1000,
        x0: vb[0],
        ops,
    };
}
