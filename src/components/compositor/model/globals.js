// Globals: the names expressions can read, worked out for a moment.
//
//   variables  the project's own (project.variables): a lowercase greek
//              letter with an optional subscript, real or integer, whose
//              value is a parameter like any other, so a controller can
//              drive it
//   splines    every Spline object, by its symbol: its defining points and
//              its curve (see model/expr.js)
//
// A variable:
//   { id, symbol: 'θ', sub: '1', set: 'real' | 'int', min, max, step,
//     params: { value }, links: { value: link } }
// or a text one, shown in text ({{τ}}) but not worked with:
//   { id, symbol: 'τ', sub: '', set: 'text', params: { text },
//     links: { text: { controller } } }  (a Text controller, or any switch:
//     the words, or the name, of the state it is on)

import { linkValue } from './resolve';
import { textAt } from './controllers';
import {
    compile, parse, symbolKey, symbolLabel,
} from './expr';
import { solveSpline, splineReader } from './spline';

let counter = 0;
const newVarId = () => `var_${Date.now().toString(36)}${(counter++).toString(36)}`;

export function makeVariable(symbol = 'θ', sub = '', over = {}) {
    return {
        id: newVarId(),
        symbol,
        sub,
        set: 'real',
        min: -10,
        max: 10,
        step: 0.01,
        params: { value: 0 },
        links: {},
        ...over,
    };
}

export const variableKey = (v) => symbolKey(v.symbol, v.sub || '');
export const variableLabel = (v) => symbolLabel(v.symbol, v.sub || '');

/** The definition its value is edited and linked through. */
export function variableDef(v) {
    const int = v.set === 'int';
    const min = Number.isFinite(v.min) ? v.min : -10;
    const max = Number.isFinite(v.max) && v.max > min ? v.max : min + 1;
    return {
        key: 'value', label: 'Value', type: 'number', min, max, step: int ? 1 : (v.step > 0 ? v.step : 0.01), def: 0,
    };
}

export const isTextVariable = (v) => v?.set === 'text';

/** What a new variable of each kind starts with (makeVariable's `over`). */
export const VARIABLE_KINDS = {
    real: {},
    int: { set: 'int', step: 1, min: 0, max: 10 },
    text: { set: 'text', params: { value: 0, text: 'Text' } },
};

/** A text variable's words at a frame: its own, or the state its switch is on. */
export function variableText(v, frame) {
    const id = v.links?.text?.controller;
    const ctrl = id && frame?.controller ? frame.controller(id) : null;
    if (ctrl) {
        const t = textAt(ctrl, frame.t, frame.controller);
        if (t !== null) return t;
    }
    return String(v.params?.text ?? '');
}

/** A variable's value at a frame: its own, or its link's; integers rounded. */
export function variableValue(v, frame) {
    let x = Number.isFinite(v.params?.value) ? v.params.value : 0;
    const link = v.links?.value;
    if (link && frame) {
        const lv = linkValue(variableDef(v), link, frame);
        if (Number.isFinite(lv)) x = lv;
    }
    return v.set === 'int' ? Math.round(x) : x;
}

/** The symbol of a Spline object, as its params have it. */
export const splineSymbol = (o) => o.params?.symbol || 'P';

/** Whether `o` is drawn through defining points and named by a symbol: a Spline, or a Manifold (whose points come from a sound). */
export const isSplineObject = (o) => o?.type === 'spline' || o?.type === 'manifold';

// ---- Scope: which names exist -------------------------------------------------------------

/**
 * What expressions in `project` can refer to. Cached on the project's
 * variables and objects, so it's only rebuilt when they change. `sig` names
 * the shape, for caching compiled expressions; a name defined twice keeps
 * the first and lists the rest in `dupes`.
 */
const scopeCache = new WeakMap();
export function scopeOf(project) {
    const vars = project.variables || [];
    const objects = project.objects || [];
    let byObjects = scopeCache.get(vars);
    if (!byObjects) { byObjects = new WeakMap(); scopeCache.set(vars, byObjects); }
    const hit = byObjects.get(objects);
    if (hit) return hit;
    const varMap = new Map();
    const splineMap = new Map();
    const textMap = new Map();
    const textList = [];
    const varList = [];
    const splineList = [];
    const dupes = new Set();
    objects.filter(isSplineObject).forEach((o) => {
        const s = splineSymbol(o);
        if (splineMap.has(s)) { dupes.add(o.id); return; }
        splineMap.set(s, splineList.length);
        splineList.push(o);
    });
    vars.forEach((v) => {
        const key = variableKey(v);
        if (varMap.has(key) || textMap.has(key) || splineMap.has(v.symbol)) { dupes.add(v.id); return; }
        if (isTextVariable(v)) {
            textMap.set(key, textList.length);
            textList.push(v);
            return;
        }
        varMap.set(key, varList.length);
        varList.push(v);
    });
    const sig = `${varList.map(variableKey).join(',')}|${splineList.map(splineSymbol).join(',')}|${textList.map(variableKey).join(',')}`;
    const out = {
        vars: varMap, splines: splineMap, texts: textMap, varList, splineList, textList, dupes, sig,
        ints: new Set(varList.filter((v) => v.set === 'int').map(variableKey)),
    };
    byObjects.set(objects, out);
    return out;
}

const compiled = new Map();

/** `src` compiled in `scope`, cached. */
export function compileIn(scope, src) {
    const key = `${scope.sig}\u0000${src}`;
    let c = compiled.get(key);
    if (!c) {
        c = compile(src, scope);
        if (compiled.size > 4000) compiled.clear();
        compiled.set(key, c);
    }
    return c;
}

// ---- A moment's values ---------------------------------------------------------------------

const splineSolves = new Map(); // spline object id -> { key, sol }

/** A spline's options, as the solver takes them, with its clamped ends worked out. */
function splineOpts(p, evalVec) {
    const clamp = { start: {}, end: {} };
    if (p.ends === 'clamped') {
        ['start', 'end'].forEach((side) => {
            Object.entries(p.clamp?.[side] || {}).forEach(([r, vec]) => {
                const v = evalVec(vec);
                if (v) clamp[side][r] = v;
            });
        });
    }
    return { degree: p.degree, ends: p.ends, spacing: p.spacing, clamp };
}

/**
 * Everything expressions read at `frame` (from model/resolve's makeFrame):
 * variable values, and readers for the splines (each solved the first time
 * something reads it). Cached on the frame.
 */
export function globalsOf(frame, project = frame?.project) {
    if (!frame || !project) return null;
    if (frame.globals && frame.globals.project === project) return frame.globals;
    const scope = scopeOf(project);
    const V = new Float64Array(scope.varList.length);
    scope.varList.forEach((v, i) => { V[i] = variableValue(v, frame); });
    // Text variables' words now, read lazily (most frames show none).
    const T = new Map();
    const textOf = (key) => {
        if (!scope.texts.has(key)) return undefined;
        if (!T.has(key)) T.set(key, variableText(scope.textList[scope.texts.get(key)], frame));
        return T.get(key);
    };
    /** The words `src` names, if it is just a text variable (τ, τ_1). */
    const textSrc = (src) => {
        if (!scope.textList.length) return undefined;
        try {
            const ast = parse(String(src ?? '').trim());
            return ast.t === 'sym' ? textOf(symbolKey(ast.base, ast.sub)) : undefined;
        } catch (e) {
            return undefined;
        }
    };
    const S = [];
    const time = frame.t || 0;
    const base = { t: 0, k: 0, time, V, S };
    const solving = new Set();
    const solved = new Map();
    const evalNum = (src, ctx = base) => {
        if (src === '' || src === null || src === undefined) return NaN;
        if (typeof src === 'number') return src;
        const c = compileIn(scope, String(src));
        if (!c.fn || c.type !== 'num') return NaN;
        return c.fn(ctx);
    };
    const evalVec = (vec) => {
        if (!Array.isArray(vec) || vec.every((x) => x === '' || x == null)) return null;
        return vec.map((x) => evalNum(x));
    };
    /** A spline's points and solution at this moment. */
    const splineState = (i) => {
        if (solved.has(i)) return solved.get(i);
        const o = scope.splineList[i];
        // A spline whose points read itself (or a loop of splines) reads as nothing.
        if (solving.has(i)) return { points: [], sol: { N: 0 } };
        solving.add(i);
        const p = o.params || {};
        const points = (p.points || []).map((pt) => (pt || []).map((x) => evalNum(x)));
        const opts = splineOpts(p, evalVec);
        const key = JSON.stringify([points, opts]);
        let entry = splineSolves.get(o.id);
        if (!entry || entry.key !== key) {
            entry = { key, sol: solveSpline(points, opts) };
            splineSolves.set(o.id, entry);
            if (splineSolves.size > 256) splineSolves.delete(splineSolves.keys().next().value);
        }
        solving.delete(i);
        const st = { points, sol: entry.sol, reader: splineReader(points, entry.sol) };
        solved.set(i, st);
        return st;
    };
    scope.splineList.forEach((o, i) => {
        S[i] = {
            get count() { return splineState(i).points.length; },
            point: (j) => splineState(i).reader?.point(j) || [NaN, NaN, NaN],
            at: (u) => splineState(i).reader?.at(u) || [NaN, NaN, NaN],
        };
    });
    const g = {
        project,
        scope,
        V,
        S,
        time,
        /** The value of variable `key` (θ_1), or undefined; a text variable's words. */
        value: (key) => (scope.vars.has(key) ? V[scope.vars.get(key)] : textOf(key)),
        /** A text variable's words, by key. */
        text: textOf,
        /** `src` compiled here. */
        compile: (src) => compileIn(scope, String(src ?? '')),
        /** `src` worked out at this moment (a number, a point, a text variable's words, or null). */
        evaluate(src, extra = {}) {
            const words = textSrc(src);
            if (words !== undefined) return words;
            const c = compileIn(scope, String(src ?? ''));
            if (!c.fn) return null;
            return c.fn({ ...base, ...extra });
        },
        /** A context for evaluating many times: `ctx.t = …; fn(ctx)`. */
        context: (extra = {}) => ({ ...base, ...extra }),
        evalNum,
        /** A Spline object's state: `{ points, sol }`, solved for this moment. */
        spline(objId) {
            const i = scope.splineList.findIndex((o) => o.id === objId);
            if (i >= 0) return splineState(i);
            return null;
        },
        /** Decimals to show `src` to when a template doesn't say: none for an integer variable. */
        digitsFor: (src) => {
            try {
                const ast = parse(src);
                return ast.t === 'sym' && scope.ints.has(symbolKey(ast.base, ast.sub)) ? 0 : 2;
            } catch (e) {
                return 2;
            }
        },
    };
    frame.globals = g;
    return g;
}

/**
 * Solve a Spline object that isn't among the project's globals (one whose
 * symbol another took): its own points, evaluated with `g`.
 */
export function solveLoose(o, g) {
    const p = o.params || {};
    const points = (p.points || []).map((pt) => (pt || []).map((x) => g.evalNum(x)));
    const evalVec = (vec) => (Array.isArray(vec) && !vec.every((x) => x === '' || x == null) ? vec.map((x) => g.evalNum(x)) : null);
    const sol = solveSpline(points, splineOpts(p, evalVec));
    return { points, sol, reader: splineReader(points, sol) };
}
