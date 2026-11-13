// A spline's defining points as objects: one `splinePoint` child per point
// (`parentId` the spline, `pointLabel.index` the point), holding its marker
// and its label. The engine hangs each on its point, so it goes wherever
// the point goes; the label's corners are measured from the point, in the
// spline's own frame.
//
// The children follow the points list: one for each point (made while the
// spline shows markers or labels), gone with its point, renumbered when
// points move. Deleting one deletes its point.
//
// A label is made saying its point in LaTeX (P_0 = (x, y, z), as the point's
// expressions are written). While its text is still what was last written
// for it (`pointLabel.text`), it keeps up with the point; once someone
// rewrites it, it is theirs and stays as they wrote it. Its name keeps up
// the same way (`pointLabel.name`).

import { makeObject } from './project';
import { defaultParams } from './schema';
import { splineSymbol } from './globals';
import { symbolTex, symbolLabel, toTex } from './expr';

export const isPointOf = (o, splineId) => o.type === 'splinePoint' && o.parentId === splineId && !!o.pointLabel;

/** What point `i` of `spline` says, in LaTeX. */
export function labelTex(spline, i) {
    const p = spline.params || {};
    const sym = splineSymbol(spline);
    const name = symbolTex(sym, String(i));
    if (p.labelShow === 'name') return name;
    if (p.labelShow === 'value') {
        // Its coordinates worked out now, as numbers: templates the label fills in every frame.
        // In the spline's own frame (as its points are written), or the scene's
        // ({{world.x}}: where the point is once the spline is placed, turned,
        // scaled and spun; the engine fills those in, see engine/adapters.js).
        const d = Math.max(0, Math.min(10, Math.round(p.labelDigits ?? 2)));
        const c = ['x', 'y', 'z'].map((k) => (p.labelFrame === 'world' ? `{{world.${k}:${d}}}` : `{{${sym}_${i}.${k}:${d}}}`));
        return `${name} = \\left(${c.join(',\\ ')}\\right)`;
    }
    const pt = p.points?.[i] || [];
    const c = [0, 1, 2].map((d) => toTex(String(pt[d] ?? '').trim() || '0') ?? '?');
    return `${name} = \\left(${c.join(',\\ ')}\\right)`;
}

/** Point `i`'s name in the outliner: P₀. */
export const pointName = (spline, i) => symbolLabel(splineSymbol(spline), String(i));

// Roughly how many letters wide some LaTeX reads, for a first box to fit it.
function texWidth(tex) {
    const s = String(tex)
        .replace(/\\(left|right)\b/g, '')
        .replace(/\\(sin|cos|tan|sec|csc|cot|ln|log|exp|min|max|arcsin|arccos|arctan|sinh|cosh|tanh)\b/g, 'aaa')
        .replace(/\\frac/g, '')
        .replace(/\\[a-zA-Z]+/g, 'a')
        .replace(/_\{[^{}]*\}|_./g, 'a')
        .replace(/[{}\\^ ]/g, '');
    return s.length;
}

/** A label's first box and words for point `i`: up and to the right of it. */
function freshLabel(spline, i) {
    const p = spline.params || {};
    const tex = labelTex(spline, i);
    const h = Math.max(1e-3, p.labelSize ?? 0.1);
    const w = h * Math.max(1.4, 0.36 * texWidth(tex) + 0.5);
    const d = h * 0.35;
    const r = (v) => Math.round(v * 1e5) / 1e5;
    return {
        tex,
        params: {
            text: tex,
            corners: [[d, d + h, 0], [d + w, d + h, 0], [d + w, d, 0], [d, d, 0]].map((c) => c.map(r)),
            color: p.labelColor || '#ffffff',
        },
    };
}

/** A new child for point `i`. */
export function makePoint(spline, i) {
    const { tex, params } = freshLabel(spline, i);
    const name = pointName(spline, i);
    return makeObject('splinePoint', spline.sceneId, {
        name,
        parentId: spline.id,
        pointLabel: { index: i, text: tex, name },
        params: { ...params, depthLayer: spline.params?.depthLayer || 'front' },
    });
}

/** Point `obj`'s label back where and as it was first made (its marker and the rest kept). */
export function resetLabel(obj, spline) {
    const { tex, params } = freshLabel(spline, obj.pointLabel.index);
    return { ...obj, params: { ...obj.params, ...params }, pointLabel: { ...obj.pointLabel, text: tex } };
}

const wantsPoints = (sp) => sp.params?.showKnots !== false || !!sp.params?.labels;

/**
 * `project` with its spline points in order: children whose parent has
 * gone go too, as do points past their spline's last; labels and names
 * still as they were written follow their points; a spline showing markers
 * or labels gets a child for every point that lacks one. Labels made before
 * points were objects (Text children) become points. The same project if
 * nothing needed doing.
 */
export function syncSplineLabels(project) {
    const objects = project.objects || [];
    if (!objects.some((o) => o.parentId || (o.type === 'spline' && wantsPoints(o)))) return project;
    const byId = new Map(objects.map((o) => [o.id, o]));
    let changed = false;
    const out = [];
    const seen = new Set();
    objects.forEach((o) => {
        let obj = o;
        if (obj.parentId) {
            const parent = byId.get(obj.parentId);
            if (!parent) { changed = true; return; }
            if (obj.pointLabel && parent.type === 'spline') {
                if (obj.type === 'text') {
                    obj = { ...obj, type: 'splinePoint', params: { ...defaultParams('splinePoint'), ...obj.params } };
                    changed = true;
                }
                const i = obj.pointLabel.index;
                const key = `${parent.id}:${i}`;
                if (!(i < (parent.params.points?.length || 0)) || seen.has(key)) { changed = true; return; }
                seen.add(key);
                if (obj.params.text === obj.pointLabel.text) {
                    const tex = labelTex(parent, i);
                    if (tex !== obj.params.text) {
                        obj = { ...obj, params: { ...obj.params, text: tex }, pointLabel: { ...obj.pointLabel, text: tex } };
                        changed = true;
                    }
                }
                const name = pointName(parent, i);
                if (obj.name === (obj.pointLabel.name ?? obj.name) && obj.name !== name) {
                    obj = { ...obj, name, pointLabel: { ...obj.pointLabel, name } };
                    changed = true;
                }
            }
        }
        out.push(obj);
    });
    // A child for each point that lacks one, after the spline's last child.
    objects.filter((o) => o.type === 'spline' && wantsPoints(o)).forEach((sp) => {
        const n = sp.params.points?.length || 0;
        const made = [];
        for (let i = 0; i < n; i++) if (!seen.has(`${sp.id}:${i}`)) made.push(makePoint(sp, i));
        if (!made.length) return;
        changed = true;
        let at = out.findIndex((o) => o.id === sp.id);
        while (at + 1 < out.length && out[at + 1].parentId === sp.id) at++;
        out.splice(at + 1, 0, ...made);
    });
    return changed ? { ...project, objects: out } : project;
}

/**
 * `project` with spline `id`'s points changed by `fn`, its point children
 * following them: `remap(i)` is where point i went (-1 if it went).
 */
export function editSplinePoints(project, id, fn, remap) {
    return {
        ...project,
        objects: project.objects.flatMap((o) => {
            if (o.id === id) return [{ ...o, params: { ...o.params, points: fn((o.params.points || []).map((pt) => [...pt])) } }];
            if (remap && o.parentId === id && o.pointLabel) {
                const j = remap(o.pointLabel.index);
                if (j < 0) return [];
                return [j === o.pointLabel.index ? o : { ...o, pointLabel: { ...o.pointLabel, index: j } }];
            }
            return [o];
        }),
    };
}

/** `project` without point child `childId`'s point (the last point stays). */
export function removePoint(project, childId) {
    const c = project.objects.find((o) => o.id === childId);
    const sp = c && project.objects.find((o) => o.id === c.parentId);
    if (!sp || !c.pointLabel || (sp.params.points?.length || 0) <= 1) return project;
    const i = c.pointLabel.index;
    return editSplinePoints(project, sp.id, (l) => l.filter((_, k) => k !== i), (k) => (k === i ? -1 : k > i ? k - 1 : k));
}
