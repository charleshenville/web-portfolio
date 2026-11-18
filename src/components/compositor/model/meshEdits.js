// Mesh edits: holes filled and junk cut away in a take's scan, kept as a
// patch on the scan's own triangles, so the GLB itself is never rewritten and
// every edit can be taken back. Plain data and typed arrays, no three.js.
//
// A scan is known by its fingerprint (its counts and a hash of its geometry),
// so takes filmed in the same scan (the Myhal Atrium's) share one set of edits.
//
// The scan as loaded (`base`):
//   pos    Float32Array, xyz per vertex
//   uv     Float32Array, uv per vertex (or null)
//   index  Uint32Array, three per triangle
//   parts  [{ vStart, vCount, fStart, fCount }]: the GLB's meshes, one per
//          texture atlas, each drawn with its own material
//
// An edit document:
//   add     [[a, b, c], ...]   triangles made, by vertex: the scan's vertices,
//                              then `verts` after them
//   remove  [f, ...]           the scan's triangles cut away, sorted
//   verts   [[x, y, z, u, v, part], ...]  vertices the edits made
//   moved   { v: [x, y, z] }   the scan's vertices moved (with every copy of
//                              them, see weld)
//
// Saved, `remove` is runs of [first, count], so cutting a patch away is a
// short list.

export const EMPTY_EDITS = Object.freeze({ add: [], remove: [], verts: [], moved: {} });

export const isEmptyEdits = (d) => !d || (!d.add?.length && !d.remove?.length && !d.verts?.length && !Object.keys(d.moved || {}).length);

/** A short id for a scan's geometry: its counts and an FNV-1a hash of its bytes. */
export function fingerprint(pos, index) {
    let h = 0x811c9dc5;
    const mix = (u32) => {
        for (let i = 0; i < u32.length; i++) h = Math.imul(h ^ u32[i], 0x01000193);
    };
    mix(new Uint32Array(pos.buffer, pos.byteOffset, pos.length));
    mix(index instanceof Uint32Array ? index : Uint32Array.from(index));
    return `${pos.length / 3}v${index.length / 3}f-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

// ---- Saving ---------------------------------------------------------------------------

const toRuns = (sorted) => {
    const runs = [];
    sorted.forEach((f) => {
        const last = runs[runs.length - 1];
        if (last && f === last[0] + last[1]) last[1]++;
        else runs.push([f, 1]);
    });
    return runs;
};

/** An edit document as it is saved. */
export function serialiseEdits(doc) {
    const r = (v) => Math.round(v * 1e6) / 1e6;
    return {
        add: doc.add.map((t) => [...t]),
        remove: toRuns(doc.remove),
        verts: doc.verts.map((v) => v.map((x, i) => (i === 5 ? x : r(x)))),
        moved: Object.fromEntries(Object.entries(doc.moved).map(([k, p]) => [k, p.map(r)])),
    };
}

/** A saved edit document (or anything) as one to work with. */
export function normaliseEdits(raw) {
    if (!raw || typeof raw !== 'object') return EMPTY_EDITS;
    const ints = (a) => Array.isArray(a) && a.every((x) => Number.isInteger(x) && x >= 0);
    const remove = [];
    (Array.isArray(raw.remove) ? raw.remove : []).forEach((x) => {
        if (Number.isInteger(x) && x >= 0) remove.push(x);
        else if (ints(x) && x.length === 2) for (let k = 0; k < x[1]; k++) remove.push(x[0] + k);
    });
    return {
        add: (Array.isArray(raw.add) ? raw.add : []).filter((t) => ints(t) && t.length === 3),
        remove: Array.from(new Set(remove)).sort((a, b) => a - b),
        verts: (Array.isArray(raw.verts) ? raw.verts : []).filter((v) => Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite))
            .map(([x, y, z, u = 0, w = 0, part = 0]) => [x, y, z, u, w, part]),
        moved: Object.fromEntries(Object.entries(raw.moved && typeof raw.moved === 'object' ? raw.moved : {})
            .filter(([k, p]) => /^\d+$/.test(k) && Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))),
    };
}

// ---- Welding ----------------------------------------------------------------------------

/**
 * Vertices at the same place, as one. A textured scan splits a vertex
 * wherever its texture's charts meet (and where its meshes meet), so by
 * index those seams look like holes; welded, they are not.
 * Returns { id: welded id per vertex, count, start, members } (members of
 * welded id w are members[start[w]] .. members[start[w + 1] - 1]).
 */
export function weld(pos, eps = 1e-5) {
    const n = pos.length / 3;
    const id = new Int32Array(n);
    const seen = new Map();
    const q = 1 / eps;
    for (let i = 0; i < n; i++) {
        const k = `${Math.round(pos[3 * i] * q)},${Math.round(pos[3 * i + 1] * q)},${Math.round(pos[3 * i + 2] * q)}`;
        let w = seen.get(k);
        if (w === undefined) { w = seen.size; seen.set(k, w); }
        id[i] = w;
    }
    const count = seen.size;
    const start = new Int32Array(count + 1);
    for (let i = 0; i < n; i++) start[id[i] + 1]++;
    for (let w = 0; w < count; w++) start[w + 1] += start[w];
    const fill = start.slice(0, count);
    const members = new Int32Array(n);
    for (let i = 0; i < n; i++) members[fill[id[i]]++] = i;
    return { id, count, start, members };
}

// ---- Applying ----------------------------------------------------------------------------

/** Which of the base's parts vertex `v` is in. */
export function partOfVertex(base, v, doc = null) {
    const nb = base.pos.length / 3;
    if (v >= nb) return doc?.verts[v - nb]?.[5] ?? 0;
    for (let p = 0; p < base.parts.length; p++) {
        const P = base.parts[p];
        if (v >= P.vStart && v < P.vStart + P.vCount) return p;
    }
    return 0;
}

/**
 * The scan with its edits: { pos, uv, index, groups, faceIds }. A triangle's
 * id is its index in the scan, or the scan's count plus its place in `add`.
 * Made triangles are drawn with the part most of their corners are in.
 * `welded` (from weld) is needed only when vertices were moved.
 */
export function applyEdits(base, doc, welded = null) {
    const d = doc || EMPTY_EDITS;
    const nb = base.pos.length / 3;
    const fb = base.index.length / 3;
    const nv = nb + d.verts.length;
    const pos = new Float32Array(nv * 3);
    pos.set(base.pos);
    const uv = base.uv ? new Float32Array(nv * 2) : null;
    if (uv) uv.set(base.uv);
    d.verts.forEach((v, k) => {
        pos.set(v.slice(0, 3), (nb + k) * 3);
        if (uv) uv.set([v[3], v[4]], (nb + k) * 2);
    });
    Object.entries(d.moved).forEach(([k, p]) => {
        const v = Number(k);
        if (v >= nb) return;
        if (welded) {
            const w = welded.id[v];
            for (let m = welded.start[w]; m < welded.start[w + 1]; m++) pos.set(p, welded.members[m] * 3);
        } else {
            pos.set(p, v * 3);
        }
    });

    const gone = new Uint8Array(fb);
    d.remove.forEach((f) => { if (f < fb) gone[f] = 1; });
    const valid = (t) => t.every((v) => v < nv) && t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2];
    const madeBy = base.parts.map(() => []);
    d.add.forEach((t, k) => {
        if (!valid(t)) return;
        const votes = new Map();
        t.forEach((v) => { const p = partOfVertex(base, v, d); votes.set(p, (votes.get(p) || 0) + 1); });
        let part = 0;
        let best = -1;
        votes.forEach((c, p) => { if (c > best) { best = c; part = p; } });
        madeBy[Math.min(part, madeBy.length - 1)].push(k);
    });
    const total = fb - d.remove.filter((f) => f < fb).length + madeBy.reduce((s, l) => s + l.length, 0);
    const index = new Uint32Array(total * 3);
    const faceIds = new Int32Array(total);
    const groups = [];
    let at = 0;
    base.parts.forEach((P, p) => {
        const start = at;
        for (let f = P.fStart; f < P.fStart + P.fCount; f++) {
            if (gone[f]) continue;
            index[at * 3] = base.index[f * 3];
            index[at * 3 + 1] = base.index[f * 3 + 1];
            index[at * 3 + 2] = base.index[f * 3 + 2];
            faceIds[at++] = f;
        }
        madeBy[p].forEach((k) => {
            index.set(d.add[k], at * 3);
            faceIds[at++] = fb + k;
        });
        groups.push({ start: start * 3, count: (at - start) * 3, materialIndex: p });
    });
    return { pos, uv, index, groups, faceIds };
}

// ---- Topology ------------------------------------------------------------------------------

/**
 * The open edges of a (welded) mesh. Returns
 *   wid(v)      vertex v's welded id
 *   rep         a vertex for each welded id
 *   next        welded id -> welded ids after it going round a hole (the
 *               reverse of the triangle's own winding along that edge)
 *   open        [a, b, ...] those edges as vertex pairs, for drawing
 *   isOpen(a, b) whether welded a-b is an open edge
 */
export function topology(index, welded, vertexCount) {
    const nb = welded.id.length;
    const W = welded.count + Math.max(0, vertexCount - nb);
    const wid = (v) => (v < nb ? welded.id[v] : welded.count + (v - nb));
    const rep = new Int32Array(W).fill(-1);
    // Every triangle's edges as (undirected edge, which way it went), sorted,
    // so the triangles sharing an edge sit together: an edge only one
    // triangle has is open. (A sort of numbers is several times quicker than
    // a map of them at this size.)
    const nf = index.length / 3;
    const keys = new Float64Array(nf * 3);
    let n = 0;
    for (let f = 0; f < nf; f++) {
        for (let e = 0; e < 3; e++) {
            const va = index[f * 3 + e];
            const a = wid(va);
            const b = wid(index[f * 3 + ((e + 1) % 3)]);
            if (rep[a] < 0) rep[a] = va;
            if (a === b) continue;
            keys[n++] = (a < b ? a * W + b : b * W + a) * 2 + (a < b ? 1 : 0);
        }
    }
    const sorted = keys.subarray(0, n).sort();
    const next = new Map();
    const open = [];
    const openSet = new Set();
    for (let i = 0; i < n;) {
        const key = Math.floor(sorted[i] / 2);
        let j = i + 1;
        while (j < n && Math.floor(sorted[j] / 2) === key) j++;
        if (j - i === 1) {
            const lo = Math.floor(key / W);
            const hi = key - lo * W;
            // The triangle went lo -> hi, so round the hole it is hi -> lo.
            const [a, b] = sorted[i] % 2 ? [hi, lo] : [lo, hi];
            if (!next.has(a)) next.set(a, []);
            next.get(a).push(b);
            open.push(rep[a], rep[b]);
            openSet.add(key);
        }
        i = j;
    }
    const isOpen = (a, b) => openSet.has(a < b ? a * W + b : b * W + a);
    return { wid, rep, next, open, isOpen, openCount: openSet.size, W };
}

/**
 * The hole an open edge is on: welded ids going round it, starting a -> b
 * (either way round the edge is fine). Where holes touch at a vertex, it
 * keeps to the turn that closes the loop soonest. Null if it never closes.
 */
export function traceLoop(topo, a, b, limit = 20000) {
    const { next } = topo;
    let from = a;
    let to = b;
    if (!(next.get(a) || []).includes(b)) {
        if (!(next.get(b) || []).includes(a)) return null;
        from = b;
        to = a;
    }
    const loop = [from];
    const used = new Set([`${from}>${to}`]);
    let cur = to;
    while (loop.length < limit) {
        if (cur === from) return loop;
        loop.push(cur);
        const at = cur;
        const outs = (next.get(at) || []).filter((n) => !used.has(`${at}>${n}`));
        if (!outs.length) return null;
        // Back to the start if that is one of the ways on.
        const n = outs.includes(from) ? from : outs[0];
        used.add(`${cur}>${n}`);
        cur = n;
    }
    return null;
}

/**
 * Which way round a chain of welded ids should be filled: +1 to make
 * triangles in the chain's own order, -1 reversed, 0 if no open edge in it
 * says (it touches no hole). A hole is filled against the winding of the
 * triangles around it, so the new faces face the same way they do.
 */
export function chainWinding(topo, chain, closed = true) {
    let vote = 0;
    const n = chain.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = chain[i];
        const b = chain[(i + 1) % n];
        if ((topo.next.get(a) || []).includes(b)) vote++;
        else if ((topo.next.get(b) || []).includes(a)) vote--;
    }
    return Math.sign(vote);
}

// ---- Edits -----------------------------------------------------------------------------------

/** `doc` with triangles `tris` ([[a, b, c], ...], by vertex) made. */
export function withFaces(doc, tris) {
    return { ...doc, add: [...doc.add, ...tris.map((t) => [...t])] };
}

/** `doc` with a vertex made; returns { doc, v } (v its index). */
export function withVertex(doc, base, p, uv = [0, 0], part = 0) {
    const v = base.pos.length / 3 + doc.verts.length;
    return { doc: { ...doc, verts: [...doc.verts, [p[0], p[1], p[2], uv[0], uv[1], part]] }, v };
}

/** `doc` with triangles cut away, by id (see applyEdits). */
export function withoutFaces(doc, base, ids) {
    const fb = base.index.length / 3;
    const cut = new Set();
    const drop = new Set();
    ids.forEach((f) => { if (f < fb) cut.add(f); else drop.add(f - fb); });
    let remove = doc.remove;
    if (cut.size) {
        const s = new Set(doc.remove);
        cut.forEach((f) => s.add(f));
        remove = Array.from(s).sort((a, b) => a - b);
    }
    const add = drop.size ? doc.add.filter((t, k) => !drop.has(k)) : doc.add;
    return { ...doc, remove, add };
}

/** `doc` with vertex v moved to p (a made vertex, or a scan vertex with its copies). */
export function withMoved(doc, base, v, p) {
    const nb = base.pos.length / 3;
    if (v >= nb) {
        const verts = doc.verts.slice();
        const old = verts[v - nb];
        verts[v - nb] = [p[0], p[1], p[2], old[3], old[4], old[5]];
        return { ...doc, verts };
    }
    return { ...doc, moved: { ...doc.moved, [v]: [p[0], p[1], p[2]] } };
}

/** How much an edit document does, for the panel. */
export function editSummary(doc, base) {
    const d = doc || EMPTY_EDITS;
    return {
        added: d.add.length,
        removed: d.remove.length,
        made: d.verts.length,
        moved: Object.keys(d.moved).length,
        baseFaces: base ? base.index.length / 3 : 0,
    };
}

// Which edits a take's mesh is drawn with (its Scan mesh's `meshSource`):
//   shared    the scan's own, shared by every take filmed in it (keyed by its fingerprint)
//   own       this take's alone (keyed by fingerprint#take)
//   original  none: the scan as it was published
export const MESH_SOURCES = [
    ['shared', 'The scan\u2019s edits (shared)'],
    ['own', 'This take\u2019s own edits'],
    ['original', 'The original scan'],
];

// What hides things behind it, catches shadows and catches glow can each use
// a version of its own: one with holes filled for hiding, say, while what is
// drawn is the scan as it was.
export const MESH_PART_SOURCES = [['drawn', 'As drawn'], ...MESH_SOURCES];

/** The key a take's edits are kept under (null: the original scan, no edits). */
export function editKeyFor(fp, take, source) {
    if (!fp || source === 'original') return null;
    return source === 'own' ? `${fp}#${take}` : fp;
}
