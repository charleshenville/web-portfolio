// Expressions: the little maths language the Equation's x(t), y(t), z(t),
// a Spline's points and dynamic text are written in. Pure: no three.js, no
// React, so the engine, the inspector's checks and an export all agree.
//
//   numbers      2, 0.5, .5, 1e-3
//   operators    + - * / ^ (or **), · × − ÷, and implied multiplication:
//                2t, 3 sin(t), (t+1)(t-1), 2π
//   functions    sin cos tan sec csc cot asin acos atan (arcsin…), atan2(y, x),
//                sinh cosh tanh, exp ln log log2 sqrt cbrt, abs floor ceil
//                round sign frac, min max (any number), mod(a, b),
//                pow(a, b), clamp(x, lo, hi), lerp(a, b, u), hypot(…),
//                step(edge, x), smoothstep(a, b, x); a function of a single
//                term needs no brackets: sin t, cos 2t.
//                LaTeX spellings work too: \sin, \frac{a}{b}, \sqrt{x}, \cdot.
//   constants    pi (π), e
//   t            the curve's parameter
//   k            which copy of a series this is (0, 1, 2…; 0 when not a series)
//   time         the timeline, in seconds
//   variables    lowercase greek letters with an optional subscript, defined
//                under Variables: θ, theta, \theta, θ_1, θ_{12}, θ₁, ω_k
//   splines      a spline's symbol (a capital letter or a greek one) is its
//                defining points and its curve: P_0 or P[i] is a point,
//                P(u) is the curve at u (0 at the start, 1 at the end);
//                pick a coordinate with .x .y .z, as in P_2.x or P(t).y.
//                On a spline, the subscript is an index, so P_k and P_{k+1}
//                walk its points.

export const GREEK = [
    ['alpha', 'α', 'Α'], ['beta', 'β', 'Β'], ['gamma', 'γ', 'Γ'], ['delta', 'δ', 'Δ'],
    ['epsilon', 'ε', 'Ε'], ['zeta', 'ζ', 'Ζ'], ['eta', 'η', 'Η'], ['theta', 'θ', 'Θ'],
    ['iota', 'ι', 'Ι'], ['kappa', 'κ', 'Κ'], ['lambda', 'λ', 'Λ'], ['mu', 'μ', 'Μ'],
    ['nu', 'ν', 'Ν'], ['xi', 'ξ', 'Ξ'], ['omicron', 'ο', 'Ο'], ['pi', 'π', 'Π'],
    ['rho', 'ρ', 'Ρ'], ['sigma', 'σ', 'Σ'], ['tau', 'τ', 'Τ'], ['upsilon', 'υ', 'Υ'],
    ['phi', 'φ', 'Φ'], ['chi', 'χ', 'Χ'], ['psi', 'ψ', 'Ψ'], ['omega', 'ω', 'Ω'],
];
const VARIANTS = { varepsilon: 'ε', vartheta: 'θ', varphi: 'φ', varrho: 'ρ', varsigma: 'σ', varpi: 'π' };
const UNI_VARIANTS = { 'ϵ': 'ε', 'ϑ': 'θ', 'ϕ': 'φ', 'ϱ': 'ρ', 'ς': 'σ', 'ϖ': 'π' };

const LOWER_BY_NAME = Object.fromEntries(GREEK.map(([n, l]) => [n, l]));
const UPPER_BY_NAME = Object.fromEntries(GREEK.map(([n, , u]) => [n[0].toUpperCase() + n.slice(1), u]));
const NAME_BY_CHAR = Object.fromEntries(GREEK.flatMap(([n, l, u]) => [[l, n], [u, n[0].toUpperCase() + n.slice(1)]]));
const LOWER_CHARS = new Set(GREEK.map(([, l]) => l));
const UPPER_CHARS = new Set(GREEK.map(([, , u]) => u));

/** The lowercase greek letters a variable can be named after (π is the constant). */
export const VARIABLE_LETTERS = GREEK.filter(([n]) => n !== 'pi' && n !== 'omicron').map(([n, l]) => [l, n]);

/** The symbols a spline can be named: capital latin letters, then the capital and lowercase greek. */
export const SPLINE_LETTERS = [
    ...'ABCDFGHJKLMNPQRSUVWXYZ'.split('').map((c) => [c, c]),
    ...GREEK.filter(([n, , u]) => n !== 'pi' && !/[A-Z]/.test(u)).map(([n, , u]) => [u, n[0].toUpperCase() + n.slice(1)]),
    ...VARIABLE_LETTERS,
];

const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const posMod = (a, b) => (b === 0 ? NaN : ((a % b) + b) % b);

// name -> [arity (or -1 for any), fn]
const FUNCS = {
    sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
    sec: [1, (x) => 1 / Math.cos(x)], csc: [1, (x) => 1 / Math.sin(x)], cot: [1, (x) => 1 / Math.tan(x)],
    asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
    arcsin: [1, Math.asin], arccos: [1, Math.acos], arctan: [1, Math.atan],
    atan2: [2, Math.atan2],
    sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
    asinh: [1, Math.asinh], acosh: [1, Math.acosh], atanh: [1, Math.atanh],
    exp: [1, Math.exp], ln: [1, Math.log], log: [1, Math.log10], log2: [1, Math.log2],
    sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs],
    floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], sign: [1, Math.sign],
    frac: [1, (x) => x - Math.floor(x)],
    min: [-1, Math.min], max: [-1, Math.max], hypot: [-1, Math.hypot],
    mod: [2, posMod], pow: [2, Math.pow],
    clamp: [3, (x, a, b) => Math.min(Math.max(x, a), b)],
    lerp: [3, (a, b, u) => a + (b - a) * u],
    step: [2, (e, x) => (x < e ? 0 : 1)],
    smoothstep: [3, (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1e-12))); return u * u * (3 - 2 * u); }],
    fact: [1, (x) => fact(Math.round(x))],
};
const CONSTS = { pi: Math.PI, e: Math.E };
/** Plain (latin) names an expression may use without defining them. */
export const RESERVED = ['t', 'k', 'time'];

const LATEX_OPS = { cdot: '*', times: '*', div: '/', ast: '*' };
const LATEX_SKIP = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', ',', ';', 'quad', 'qquad', '!', 'displaystyle']);

// Every lowercase word the lexer knows, longest first, for splitting runs like "tsin" or "2pit".
const WORDS = [...Object.keys(FUNCS), ...Object.keys(CONSTS), ...RESERVED, ...Object.keys(LOWER_BY_NAME), ...Object.keys(VARIANTS)]
    .filter((w, i, a) => a.indexOf(w) === i)
    .sort((a, b) => b.length - a.length);

const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

class ExprError extends Error {
    constructor(msg, pos) {
        super(msg);
        this.pos = pos;
    }
}

// ---- Lexing --------------------------------------------------------------------

// A letter's token; `len` is how much of the source spells it (Γ, Gamma, \\Gamma).
function symToken(base, pos, len = 1) { return { k: 'sym', base, sub: null, pos, len }; }

/** A word: a function, a constant, a reserved name, or a greek letter spelled out. */
function wordToken(w, pos) {
    if (FUNCS[w] || w === 'frac') return { k: 'fn', v: w, pos };
    if (w in CONSTS) return { k: 'const', v: w, pos };
    if (RESERVED.includes(w)) return { k: 'id', v: w, pos };
    if (VARIANTS[w]) return symToken(VARIANTS[w], pos);
    if (LOWER_BY_NAME[w]) return w === 'pi' ? { k: 'const', v: 'pi', pos } : symToken(LOWER_BY_NAME[w], pos);
    if (UPPER_BY_NAME[w]) return symToken(UPPER_BY_NAME[w], pos);
    return null;
}

/** A run of latin letters: one known word, a capital (a spline), or known words run together. */
function lexWord(run, pos) {
    const whole = wordToken(run, pos);
    if (whole) { whole.len = run.length; return [whole]; }
    if (/^[A-Z]$/.test(run)) return [symToken(run, pos)];
    // Split greedily into known words ("tsin" -> t, sin), capitals standing alone.
    const out = [];
    let i = 0;
    while (i < run.length) {
        const at = i;
        if (/[A-Z]/.test(run[i])) {
            const cap = Object.keys(UPPER_BY_NAME).find((n) => run.startsWith(n, at));
            if (cap) { out.push(symToken(UPPER_BY_NAME[cap], pos + i, cap.length)); i += cap.length; continue; }
            out.push(symToken(run[i], pos + i));
            i++;
            continue;
        }
        const w = WORDS.find((x) => run.startsWith(x, at));
        if (!w) throw new ExprError(`I don't know "${run}"`, pos);
        const tok = wordToken(w, pos + i);
        tok.len = w.length;
        out.push(tok);
        i += w.length;
    }
    return out;
}

function lex(src) {
    const s = String(src ?? '');
    const out = [];
    let i = 0;
    const push = (tok) => out.push(tok);
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
        if (num) {
            // "2e" (no digits after) is 2 times e, so the exponent needs its digits.
            push({ k: 'num', v: parseFloat(num[0]), pos: i });
            i += num[0].length;
            continue;
        }
        if (c === '\\') {
            const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
            const name = m ? m[1] : '';
            const start = i;
            i += m ? m[0].length : 1;
            if (LATEX_SKIP.has(name)) continue;
            if (LATEX_OPS[name]) { push({ k: 'op', v: LATEX_OPS[name], pos: i }); continue; }
            const tok = wordToken(name, start);
            if (!tok) throw new ExprError(`I don't know \\${name}`, start);
            tok.len = i - start;
            push(tok);
            continue;
        }
        if (/[a-zA-Z]/.test(c)) {
            // Names that end in digits: atan2, log2.
            const withDigits = /^[a-zA-Z]+\d+/.exec(s.slice(i));
            if (withDigits && FUNCS[withDigits[0]]) {
                push({ k: 'fn', v: withDigits[0], pos: i });
                i += withDigits[0].length;
                continue;
            }
            const m = /^[a-zA-Z]+/.exec(s.slice(i));
            // A coordinate after a dot: P_1.x
            if (out[out.length - 1]?.k === '.' && /^[xyz]$/.test(m[0])) {
                push({ k: 'prop', v: m[0], pos: i });
                i++;
                continue;
            }
            lexWord(m[0], i).forEach(push);
            i += m[0].length;
            continue;
        }
        if (LOWER_CHARS.has(c) || UPPER_CHARS.has(c) || UNI_VARIANTS[c]) {
            const ch = UNI_VARIANTS[c] || c;
            push(ch === 'π' ? { k: 'const', v: 'pi', pos: i } : symToken(ch, i));
            i++;
            continue;
        }
        if (c === '_') {
            const prev = out[out.length - 1];
            if (!prev || prev.k !== 'sym' || prev.sub !== null) throw new ExprError('A subscript goes straight after a letter, as in θ_1', i);
            i++;
            if (s[i] === '{') {
                let depth = 1;
                let j = i + 1;
                while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
                if (depth) throw new ExprError('A subscript is missing its }', i);
                prev.sub = s.slice(i + 1, j - 1).trim();
                i = j;
            } else {
                const m = /^(\d+|[a-zA-Z]|[^\s\d])/.exec(s.slice(i));
                if (!m) throw new ExprError('A subscript needs something after the _', i);
                prev.sub = m[0];
                i += m[0].length;
            }
            if (!prev.sub) throw new ExprError('An empty subscript', i);
            continue;
        }
        if (SUB_DIGITS.includes(c)) {
            const prev = out[out.length - 1];
            if (!prev || prev.k !== 'sym' || prev.sub !== null) throw new ExprError('A subscript goes straight after a letter', i);
            let j = i;
            let sub = '';
            while (j < s.length && SUB_DIGITS.includes(s[j])) { sub += SUB_DIGITS.indexOf(s[j]); j++; }
            prev.sub = sub;
            i = j;
            continue;
        }
        if (c === '*' && s[i + 1] === '*') { push({ k: 'op', v: '^', pos: i }); i += 2; continue; }
        const ops = {
            '+': '+', '-': '-', '−': '-', '*': '*', '·': '*', '×': '*', '/': '/', '÷': '/', '^': '^',
        };
        if (ops[c]) { push({ k: 'op', v: ops[c], pos: i }); i++; continue; }
        if ('([{'.includes(c)) { push({ k: c === '[' ? '[' : '(', v: c, pos: i }); i++; continue; }
        if (')]}'.includes(c)) { push({ k: c === ']' ? ']' : ')', v: c, pos: i }); i++; continue; }
        if (c === ',') { push({ k: ',', pos: i }); i++; continue; }
        if (c === '.') { push({ k: '.', pos: i }); i++; continue; }
        throw new ExprError(`I don't know "${c}"`, i);
    }
    return out;
}

// ---- Parsing --------------------------------------------------------------------

function parseTokens(tokens) {
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    const expect = (k, what) => {
        const t = next();
        if (!t || t.k !== k) throw new ExprError(`Expected ${what}`, t?.pos ?? Infinity);
        return t;
    };
    // Something that can begin a term, so two side by side multiply.
    const startsTerm = (t) => t && (t.k === 'num' || t.k === 'id' || t.k === 'sym' || t.k === 'const' || t.k === 'fn' || t.k === '(');

    function args() {
        expect('(', '(');
        const list = [];
        if (peek()?.k === ')') { next(); return list; }
        for (;;) {
            list.push(expr());
            const t = next();
            if (t?.k === ')') return list;
            if (t?.k !== ',') throw new ExprError('Expected , or )', t?.pos ?? Infinity);
        }
    }

    function postfix(node) {
        for (;;) {
            const t = peek();
            if (t?.k === '.') {
                next();
                const m = next();
                const prop = m?.k === 'prop' ? m.v : null;
                if (!prop) throw new ExprError('After a dot comes x, y or z', m?.pos ?? Infinity);
                node = { t: 'member', a: node, prop };
            } else if (t?.k === '[') {
                next();
                const index = expr();
                expect(']', ']');
                node = { t: 'index', a: node, index };
            } else {
                return node;
            }
        }
    }

    function primary() {
        const t = next();
        if (!t) throw new ExprError('Something is missing at the end', Infinity);
        if (t.k === 'num') return postfix({ t: 'num', v: t.v });
        if (t.k === 'const') return postfix({ t: 'num', v: CONSTS[t.v], name: t.v });
        if (t.k === 'id') return postfix({ t: 'id', name: t.v });
        if (t.k === '(') {
            const e = expr();
            expect(')', 'a closing bracket');
            return postfix(e);
        }
        if (t.k === 'sym') {
            const node = { t: 'sym', base: t.base, sub: t.sub, pos: t.pos };
            if (peek()?.k === '(') return postfix({ t: 'call', sym: node, args: args() });
            return postfix(node);
        }
        if (t.k === 'fn') {
            if (t.v === 'frac') {
                const a = args();
                const b = args();
                if (a.length !== 1 || b.length !== 1) throw new ExprError('\\frac takes {top}{bottom}', t.pos);
                return postfix({ t: 'bin', op: '/', a: a[0], b: b[0] });
            }
            const [arity] = FUNCS[t.v];
            let list;
            if (peek()?.k === '(') {
                list = args();
            } else {
                // sin t, cos 2t: the term that follows (multiplied out), up
                // to an operator or another function.
                if (!startsTerm(peek())) throw new ExprError(`${t.v} needs something to work on`, t.pos);
                let a = power();
                while (startsTerm(peek()) && peek().k !== 'fn') a = { t: 'bin', op: '*', a, b: power() };
                list = [a];
            }
            if (arity >= 0 && list.length !== arity) throw new ExprError(`${t.v} takes ${arity} value${arity === 1 ? '' : 's'}`, t.pos);
            if (arity < 0 && !list.length) throw new ExprError(`${t.v} needs at least one value`, t.pos);
            return postfix({ t: 'fn', name: t.v, args: list });
        }
        throw new ExprError(t.k === 'op' ? `Unexpected ${t.v}` : 'Unexpected symbol', t.pos);
    }

    function power() {
        const base = primary();
        if (peek()?.k === 'op' && peek().v === '^') {
            next();
            return { t: 'bin', op: '^', a: base, b: unary() };
        }
        return base;
    }

    function unary() {
        const t = peek();
        if (t?.k === 'op' && (t.v === '-' || t.v === '+')) {
            next();
            const a = unary();
            return t.v === '-' ? { t: 'neg', a } : a;
        }
        return power();
    }

    function term() {
        let a = unary();
        for (;;) {
            const t = peek();
            if (t?.k === 'op' && (t.v === '*' || t.v === '/')) {
                next();
                a = { t: 'bin', op: t.v, a, b: unary() };
            } else if (startsTerm(t)) {
                a = { t: 'bin', op: '*', a, b: power() };
            } else {
                return a;
            }
        }
    }

    function expr() {
        let a = term();
        for (;;) {
            const t = peek();
            if (t?.k === 'op' && (t.v === '+' || t.v === '-')) {
                next();
                a = { t: 'bin', op: t.v, a, b: term() };
            } else {
                return a;
            }
        }
    }

    if (!tokens.length) throw new ExprError('Empty', 0);
    const e = expr();
    if (i < tokens.length) throw new ExprError('Something extra is left over', tokens[i].pos);
    return e;
}

const astCache = new Map();

/** The syntax tree of `src`, or throws an ExprError. */
export function parse(src) {
    const key = String(src ?? '');
    if (astCache.has(key)) {
        const hit = astCache.get(key);
        if (hit instanceof Error) throw hit;
        return hit;
    }
    let out;
    try { out = parseTokens(lex(key)); } catch (e) { out = e; }
    if (astCache.size > 2000) astCache.clear();
    astCache.set(key, out);
    if (out instanceof Error) throw out;
    return out;
}

// ---- Names -------------------------------------------------------------------------

/** The key a variable is stored under: its letter and subscript, as in θ_1. */
export const symbolKey = (base, sub) => (sub ? `${base}_${sub}` : base);

const UNI_SUB = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', '+': '₊', '-': '₋',
};

/** A symbol as it reads: θ₁ (or θ_{ab} where there are no small letters for it). */
export function symbolLabel(base, sub) {
    if (!sub) return base;
    const small = String(sub).split('').map((c) => UNI_SUB[c]);
    return small.every(Boolean) ? base + small.join('') : `${base}_{${sub}}`;
}

/** A symbol in LaTeX: \theta_{1}. */
export function symbolTex(base, sub) {
    const name = NAME_BY_CHAR[base];
    const head = name ? `\\${name}` : base;
    return sub ? `${head}_{${sub}}` : head;
}

/** The greek letter's name, for menus: "theta". */
export const letterName = (ch) => NAME_BY_CHAR[ch] || ch;

// ---- Compiling -------------------------------------------------------------------
//
// A scope says what an expression may refer to:
//   vars     Map(key -> index into the values array), as θ_1 -> 3
//   splines  Map(symbol -> index into the splines array)
// Compiled, an expression is a function of a context
//   { t, k, time, V: number[], S: [{ point(i), at(u), count }] }
// returning a number (or a point, [x, y, z], for a bare spline point).

const NUM = 'num';
const VEC = 'vec';

function compileNode(n, scope, info) {
    switch (n.t) {
        case 'num': {
            const v = n.v;
            return [NUM, () => v];
        }
        case 'id': {
            const name = n.name;
            return [NUM, (c) => c[name] ?? 0];
        }
        case 'neg': {
            const [ty, a] = compileNode(n.a, scope, info);
            if (ty !== NUM) throw new ExprError('A point can\'t be negated: pick a coordinate (.x, .y, .z)');
            return [NUM, (c) => -a(c)];
        }
        case 'bin': {
            const [ta, a] = compileNode(n.a, scope, info);
            const [tb, b] = compileNode(n.b, scope, info);
            if (ta !== NUM || tb !== NUM) throw new ExprError('Pick a coordinate of the point (.x, .y or .z) to do sums with it');
            switch (n.op) {
                case '+': return [NUM, (c) => a(c) + b(c)];
                case '-': return [NUM, (c) => a(c) - b(c)];
                case '*': return [NUM, (c) => a(c) * b(c)];
                case '/': return [NUM, (c) => a(c) / b(c)];
                default: return [NUM, (c) => a(c) ** b(c)];
            }
        }
        case 'fn': {
            const [, f] = FUNCS[n.name];
            const parts = n.args.map((x) => {
                const [ty, fn] = compileNode(x, scope, info);
                if (ty !== NUM) throw new ExprError(`${n.name} works on numbers: pick a coordinate (.x, .y, .z)`);
                return fn;
            });
            if (parts.length === 1) { const [a] = parts; return [NUM, (c) => f(a(c))]; }
            if (parts.length === 2) { const [a, b] = parts; return [NUM, (c) => f(a(c), b(c))]; }
            return [NUM, (c) => f(...parts.map((p) => p(c)))];
        }
        case 'sym': {
            if (scope.splines?.has(n.base)) {
                const si = scope.splines.get(n.base);
                info.splines.add(n.base);
                if (n.sub == null) return [VEC, null, si];
                let idx;
                try { [, idx] = compileNode(parse(n.sub), scope, info); } catch (e) { throw new ExprError(`In ${n.base}'s subscript: ${e.message}`); }
                return [VEC, (c) => c.S[si]?.point(Math.round(idx(c))) || NAN3];
            }
            const key = symbolKey(n.base, n.sub);
            if (scope.texts?.has(key)) {
                // Words, not a number: shown as {{τ}} in a text, on its own.
                info.texts.add(key);
                throw new ExprError(`${symbolLabel(n.base, n.sub)} is text: show it in a text, as {{${symbolKey(n.base, n.sub)}}} on its own`, n.pos);
            }
            if (!scope.vars?.has(key)) {
                info.missing.add(key);
                return [NUM, () => NaN];
            }
            const vi = scope.vars.get(key);
            info.vars.add(key);
            return [NUM, (c) => c.V[vi]];
        }
        case 'index': {
            const [ty, , si] = compileNode(n.a, scope, info);
            if (ty !== VEC || si === undefined) throw new ExprError('Only a spline can be indexed, as in P[2]');
            const [ti, idx] = compileNode(n.index, scope, info);
            if (ti !== NUM) throw new ExprError('An index is a number');
            return [VEC, (c) => c.S[si]?.point(Math.round(idx(c))) || NAN3];
        }
        case 'call': {
            if (!scope.splines?.has(n.sym.base)) {
                if (scope.vars?.has(symbolKey(n.sym.base, n.sym.sub))) {
                    // θ(t+1) reads as θ times (t+1).
                    return compileNode({ t: 'bin', op: '*', a: n.sym, b: n.args[0] }, scope, info);
                }
                info.missing.add(symbolKey(n.sym.base, n.sym.sub));
                return [NUM, () => NaN];
            }
            if (n.sym.sub != null) throw new ExprError(`${n.sym.base}(u) takes no subscript`);
            if (n.args.length !== 1) throw new ExprError(`${n.sym.base}(u) takes one value, from 0 to 1`);
            const si = scope.splines.get(n.sym.base);
            info.splines.add(n.sym.base);
            const [tu, u] = compileNode(n.args[0], scope, info);
            if (tu !== NUM) throw new ExprError('The spline\'s u is a number');
            return [VEC, (c) => c.S[si]?.at(u(c)) || NAN3];
        }
        case 'member': {
            const [ty, a, si] = compileNode(n.a, scope, info);
            if (ty !== VEC) throw new ExprError('.x, .y and .z go after a spline\'s point, as in P_1.x');
            const k = n.prop === 'x' ? 0 : n.prop === 'y' ? 1 : 2;
            if (!a) {
                // P.x with no index: the first point.
                return [NUM, (c) => c.S[si]?.point(0)?.[k] ?? NaN];
            }
            return [NUM, (c) => a(c)[k]];
        }
        default: throw new ExprError('Unexpected');
    }
}

const NAN3 = [NaN, NaN, NaN];

/**
 * Compile `src` in `scope`. Returns `{ fn, type, error, missing, vars, splines }`:
 * fn is null when it doesn't parse or type-check; `missing` lists variables
 * it uses that aren't defined (it still compiles, reading them as NaN).
 */
export function compile(src, scope = {}) {
    const info = {
        missing: new Set(), vars: new Set(), splines: new Set(), texts: new Set(),
    };
    try {
        const ast = parse(src);
        const [type, fn, si] = compileNode(ast, scope, info);
        if (type === VEC && !fn) {
            return { fn: (c) => c.S[si]?.point(0) || NAN3, type, error: null, ...info };
        }
        return { fn, type, error: null, ...info };
    } catch (e) {
        return { fn: null, type: null, error: e.message || String(e), pos: e.pos, ...info };
    }
}

/** A number or point as text, to `digits` decimals. */
export function formatValue(v, digits = 2) {
    const d = Math.max(0, Math.min(10, Math.round(digits)));
    const one = (x) => {
        if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : (x > 0 ? '∞' : '−∞');
        const s = x.toFixed(d);
        // No "-0.00".
        return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
    };
    if (Array.isArray(v)) return `(${v.map(one).join(', ')})`;
    return one(v);
}

// ---- As LaTeX ------------------------------------------------------------------------

const TEX_FN = {
    sin: '\\sin', cos: '\\cos', tan: '\\tan', sec: '\\sec', csc: '\\csc', cot: '\\cot',
    asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan', arcsin: '\\arcsin', arccos: '\\arccos', arctan: '\\arctan',
    sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', exp: '\\exp', ln: '\\ln', log: '\\log', log2: '\\log_2',
    min: '\\min', max: '\\max',
};
const paren = (s) => `\\left(${s}\\right)`;
const texNum = (v) => {
    if (!Number.isFinite(v)) return v > 0 ? '\\infty' : '-\\infty';
    const s = String(Number(v.toPrecision(6)));
    return s.includes('e') ? s.replace(/e\+?(-?\d+)/, (m, x) => `\\times 10^{${x}}`) : s;
};

// [tex, precedence]: 1 sums, 2 products, 3 powers and functions, 4 atoms.
function texNode(n) {
    const wrap = (x, below) => (x[1] < below ? paren(x[0]) : x[0]);
    switch (n.t) {
        case 'num':
            if (n.name === 'pi') return ['\\pi', 4];
            if (n.name === 'e') return ['e', 4];
            return [texNum(n.v), n.v < 0 ? 1 : 4];
        case 'id': return [n.name === 'time' ? '\\mathrm{time}' : n.name, 4];
        case 'sym': return [symbolTex(n.base, n.sub), 4];
        case 'call': return [`${symbolTex(n.sym.base, n.sym.sub)}${paren(n.args.map((a) => texNode(a)[0]).join(', '))}`, 4];
        case 'member': return [`${wrap(texNode(n.a), 4)}.${n.prop}`, 4];
        case 'index': {
            const i = texNode(n.index)[0];
            if (n.a.t === 'sym' && !n.a.sub) return [symbolTex(n.a.base, i), 4];
            return [`${wrap(texNode(n.a), 4)}\\left[${i}\\right]`, 4];
        }
        case 'neg': return [`-${wrap(texNode(n.a), 2)}`, 1.5];
        case 'fn': {
            const args = n.args.map(texNode);
            const one = args[0];
            if (n.name === 'sqrt') return [`\\sqrt{${one[0]}}`, 4];
            if (n.name === 'cbrt') return [`\\sqrt[3]{${one[0]}}`, 4];
            if (n.name === 'abs') return [`\\left|${one[0]}\\right|`, 4];
            if (n.name === 'floor') return [`\\left\\lfloor ${one[0]}\\right\\rfloor`, 4];
            if (n.name === 'ceil') return [`\\left\\lceil ${one[0]}\\right\\rceil`, 4];
            if (n.name === 'fact') return [`${wrap(one, 4)}!`, 4];
            const head = TEX_FN[n.name] || `\\operatorname{${n.name}}`;
            // sin t, sin θ: a lone letter or number goes without brackets.
            if (args.length === 1 && TEX_FN[n.name] && ['sym', 'id', 'num'].includes(n.args[0].t) && one[1] === 4) return [`${head} ${one[0]}`, 3];
            return [`${head}${paren(args.map((a) => a[0]).join(', '))}`, 3];
        }
        case 'bin': {
            const a = texNode(n.a);
            const b = texNode(n.b);
            if (n.op === '+') return [n.b.t === 'neg' ? `${a[0]} - ${wrap(texNode(n.b.a), 2)}` : `${a[0]} + ${b[0]}`, 1];
            if (n.op === '-') return [`${a[0]} - ${wrap(b, 2)}`, 1];
            if (n.op === '/') return [`\\frac{${a[0]}}{${b[0]}}`, 4];
            if (n.op === '^') return [`${n.a.t === 'fn' ? paren(a[0]) : wrap(a, 4)}^{${b[0]}}`, 3];
            // Products side by side (2t, 3θ), with a dot where that would misread.
            const left = wrap(a, 2);
            const right = wrap(b, 2);
            const dot = /^[\d.]/.test(right) || (n.a.t === 'fn' && a[1] === 3 && !left.endsWith('\\right)')) || n.b.t === 'neg';
            return [dot ? `${left} \\cdot ${right}` : `${left}${/[a-zA-Z]$/.test(left) && /^[a-zA-Z]/.test(right) ? ' ' : ''}${right}`, 2];
        }
        default: return ['?', 4];
    }
}

/** An expression written as LaTeX (as it reads, not worked out), or null if it doesn't parse. */
export function toTex(src) {
    try {
        return texNode(parse(src))[0];
    } catch (e) {
        return null;
    }
}

// ---- Templates -------------------------------------------------------------------------

// {{…}} holds an expression, braces one deep allowed (θ_{1}, \frac{a}{b});
// not opening on a brace, so LaTeX's own around it (\\frac{{{θ}}}{2}) stays.
export const TEMPLATE_SRC = '\\{\\{(?!\\{)((?:[^{}]|\\{[^{}]*\\})*?)(?::(\\d+))?\\}\\}';
const TEMPLATE = new RegExp(TEMPLATE_SRC, 'g');

/** Whether `text` has any {{…}} in it. */
export const isTemplate = (text) => new RegExp(TEMPLATE_SRC).test(String(text || ''));

/**
 * Text with each {{expression}} or {{expression:digits}} worked out by
 * `evaluate(src)` (which returns a number, a point, or null for an error).
 * `digitsFor(src)` gives the default decimals for an expression.
 */
export function fillTemplate(text, evaluate, digitsFor = () => 2) {
    return String(text || '').replace(TEMPLATE, (all, src, digits) => {
        const v = evaluate(src.trim());
        if (v === null || v === undefined) return '?';
        if (typeof v === 'string') return v;
        return formatValue(v, digits !== undefined ? parseInt(digits, 10) : digitsFor(src.trim()));
    });
}

// ---- Renaming -------------------------------------------------------------------------

/**
 * `src` with the letters in `map` (old letter -> new letter, subscripts
 * kept) spelled anew, everything else as written. Source that does not
 * lex is left alone.
 */
export function renameSymbols(src, map) {
    const s = String(src ?? '');
    let toks;
    try { toks = lex(s); } catch (e) { return s; }
    let out = '';
    let at = 0;
    toks.forEach((tk) => {
        if (tk.k !== 'sym' || !map[tk.base] || map[tk.base] === tk.base) return;
        const to = map[tk.base];
        const after = s[tk.pos + tk.len] || '';
        out += s.slice(at, tk.pos) + to + (/^[A-Za-z]$/.test(to) && /[A-Za-z]/.test(after) ? ' ' : '');
        at = tk.pos + tk.len;
    });
    return out + s.slice(at);
}

/** A text's {{…}} values with `renameSymbols` applied, the rest as written. */
export function renameInTemplate(text, map) {
    return String(text ?? '').replace(TEMPLATE, (all, src, digits) => `{{${renameSymbols(src, map)}${digits !== undefined ? `:${digits}` : ''}}}`);
}

export { ExprError };
