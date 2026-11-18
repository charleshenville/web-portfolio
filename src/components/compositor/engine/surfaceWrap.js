// Laying a text or image patch onto the scan's mesh.
//
// Shrink to the mesh: each point of the patch (a fine grid of them) moves to
// the nearest point on the scan's surface, lifted off it a hair so the two
// don't fight, so the patch follows the wall, the kerb, the bonnet it is on.
//
// Painted into the scan: each point also learns where on the scan's texture
// that nearest point is (its atlas and texture position), so the patch can
// be shaded by the scan's own picture of the surface there, its light and
// shade and grain, rather than drawn at full brightness over it.
//
// Nearest points come from a grid over the scan's triangles, made once per
// version of the mesh (kept while its arrays are the same ones).

import * as THREE from 'three';

const MAX_CELLS = 1 << 21;
const indexes = new WeakMap(); // position array -> SurfaceIndex

/** The closest point on triangle abc to p: writes it to out (xyz) and its barycentrics to bary (u, v, w). */
function closestOnTri(px, py, pz, P, ia, ib, ic, out, bary) {
    const ax = P[ia]; const ay = P[ia + 1]; const az = P[ia + 2];
    const abx = P[ib] - ax; const aby = P[ib + 1] - ay; const abz = P[ib + 2] - az;
    const acx = P[ic] - ax; const acy = P[ic + 1] - ay; const acz = P[ic + 2] - az;
    const apx = px - ax; const apy = py - ay; const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let u; let v; let w;
    if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; } else {
        const bpx = px - P[ib]; const bpy = py - P[ib + 1]; const bpz = pz - P[ib + 2];
        const d3 = abx * bpx + aby * bpy + abz * bpz;
        const d4 = acx * bpx + acy * bpy + acz * bpz;
        if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; } else {
            const vc = d1 * d4 - d3 * d2;
            if (vc <= 0 && d1 >= 0 && d3 <= 0) {
                const t = d1 / (d1 - d3);
                u = 1 - t; v = t; w = 0;
            } else {
                const cpx = px - P[ic]; const cpy = py - P[ic + 1]; const cpz = pz - P[ic + 2];
                const d5 = abx * cpx + aby * cpy + abz * cpz;
                const d6 = acx * cpx + acy * cpy + acz * cpz;
                if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; } else {
                    const vb = d5 * d2 - d1 * d6;
                    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                        const t = d2 / (d2 - d6);
                        u = 1 - t; v = 0; w = t;
                    } else {
                        const va = d3 * d6 - d5 * d4;
                        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                            const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                            u = 0; v = 1 - t; w = t;
                        } else {
                            const den = 1 / (va + vb + vc);
                            v = vb * den;
                            w = vc * den;
                            u = 1 - v - w;
                        }
                    }
                }
            }
        }
    }
    out[0] = ax + abx * v + acx * w;
    out[1] = ay + aby * v + acy * w;
    out[2] = az + abz * v + acz * w;
    bary[0] = u; bary[1] = v; bary[2] = w;
}

class SurfaceIndex {
    constructor(geometry) {
        const P = geometry.getAttribute('position').array;
        const I = geometry.index ? geometry.index.array : Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
        const nf = Math.floor(I.length / 3);
        this.P = P;
        this.I = I;
        this.uv = geometry.getAttribute('uv')?.array || null;
        // Which part (atlas) each face is drawn with.
        this.part = new Uint8Array(nf);
        geometry.groups.forEach((g) => {
            const a = Math.floor(g.start / 3);
            const b = Math.min(nf, Math.floor((g.start + g.count) / 3));
            this.part.fill(Math.min(255, g.materialIndex || 0), a, b);
        });
        // The grid: cells about twice a typical triangle's size, as many as fit.
        const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
        let edge = 0;
        const step = Math.max(1, Math.floor(nf / 2000));
        let k = 0;
        for (let f = 0; f < nf; f += step, k++) {
            const a = I[f * 3] * 3; const b = I[f * 3 + 1] * 3;
            edge += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
        }
        const size = box.getSize(new THREE.Vector3());
        let h = Math.max(1e-4, (edge / Math.max(1, k)) * 2);
        const dims = () => [size.x, size.y, size.z].map((s) => Math.max(1, Math.ceil(s / h) + 1));
        let d = dims();
        while (d[0] * d[1] * d[2] > MAX_CELLS) { h *= 1.26; d = dims(); }
        this.h = h;
        this.min = box.min.clone();
        this.d = d;
        const cellOf = (x, y, z) => [
            Math.min(d[0] - 1, Math.max(0, Math.floor((x - box.min.x) / h))),
            Math.min(d[1] - 1, Math.max(0, Math.floor((y - box.min.y) / h))),
            Math.min(d[2] - 1, Math.max(0, Math.floor((z - box.min.z) / h))),
        ];
        // Each face in every cell its bounds touch: counted, then laid out.
        const ncell = d[0] * d[1] * d[2];
        const count = new Uint32Array(ncell + 1);
        const span = (f, visit) => {
            const a = I[f * 3] * 3; const b = I[f * 3 + 1] * 3; const c = I[f * 3 + 2] * 3;
            const lo = cellOf(Math.min(P[a], P[b], P[c]), Math.min(P[a + 1], P[b + 1], P[c + 1]), Math.min(P[a + 2], P[b + 2], P[c + 2]));
            const hi = cellOf(Math.max(P[a], P[b], P[c]), Math.max(P[a + 1], P[b + 1], P[c + 1]), Math.max(P[a + 2], P[b + 2], P[c + 2]));
            for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) visit((z * d[1] + y) * d[0] + x);
        };
        for (let f = 0; f < nf; f++) span(f, (c) => { count[c + 1]++; });
        for (let c = 0; c < ncell; c++) count[c + 1] += count[c];
        this.start = count;
        this.faces = new Uint32Array(count[ncell]);
        const fill = count.slice(0, ncell);
        for (let f = 0; f < nf; f++) span(f, (c) => { this.faces[fill[c]++] = f; });
        this.out = [0, 0, 0];
        this.bary = [0, 0, 0];
    }

    /**
     * The nearest point on the surface to (x, y, z) within `reach`, of part
     * `onlyPart` if given: { at: [x, y, z], d, face, bary: [u, v, w] } or null.
     */
    nearest(x, y, z, reach, onlyPart = -1) {
        const { d, h, min, P, I } = this;
        const cx = Math.floor((x - min.x) / h);
        const cy = Math.floor((y - min.y) / h);
        const cz = Math.floor((z - min.z) / h);
        const maxR = Math.max(1, Math.ceil(reach / h));
        let best = reach * reach;
        let bestFace = -1;
        const at = [0, 0, 0];
        const bb = [0, 0, 0];
        for (let r = 0; r <= maxR; r++) {
            for (let dz = -r; dz <= r; dz++) {
                const z0 = cz + dz;
                if (z0 < 0 || z0 >= d[2]) continue;
                for (let dy = -r; dy <= r; dy++) {
                    const y0 = cy + dy;
                    if (y0 < 0 || y0 >= d[1]) continue;
                    const shell = Math.abs(dz) === r || Math.abs(dy) === r;
                    for (let dx = -r; dx <= r; dx += shell ? 1 : 2 * r || 1) {
                        const x0 = cx + dx;
                        if (x0 < 0 || x0 >= d[0]) continue;
                        const c = (z0 * d[1] + y0) * d[0] + x0;
                        for (let q = this.start[c]; q < this.start[c + 1]; q++) {
                            const f = this.faces[q];
                            if (onlyPart >= 0 && this.part[f] !== onlyPart) continue;
                            closestOnTri(x, y, z, P, I[f * 3] * 3, I[f * 3 + 1] * 3, I[f * 3 + 2] * 3, this.out, this.bary);
                            const ex = this.out[0] - x; const ey = this.out[1] - y; const ez = this.out[2] - z;
                            const dd = ex * ex + ey * ey + ez * ez;
                            if (dd < best) {
                                best = dd;
                                bestFace = f;
                                at[0] = this.out[0]; at[1] = this.out[1]; at[2] = this.out[2];
                                bb[0] = this.bary[0]; bb[1] = this.bary[1]; bb[2] = this.bary[2];
                            }
                        }
                    }
                }
            }
            // Nothing past this shell can be nearer than what we have.
            if (bestFace >= 0 && Math.sqrt(best) <= r * h) break;
        }
        if (bestFace < 0) return null;
        return { at, d: Math.sqrt(best), face: bestFace, bary: bb };
    }

    /** The texture position at a face's barycentrics. */
    uvAt(face, bary) {
        const U = this.uv;
        if (!U) return [0, 0];
        const a = this.I[face * 3] * 2; const b = this.I[face * 3 + 1] * 2; const c = this.I[face * 3 + 2] * 2;
        return [U[a] * bary[0] + U[b] * bary[1] + U[c] * bary[2], U[a + 1] * bary[0] + U[b + 1] * bary[1] + U[c + 1] * bary[2]];
    }
}

/** The nearest-point index for a scan geometry, made the first time (and again once its arrays change). */
export function surfaceIndex(geometry) {
    const pos = geometry?.getAttribute('position');
    if (!pos || !pos.count) return null;
    let ix = indexes.get(pos.array);
    if (!ix || ix.I !== (geometry.index ? geometry.index.array : ix.I)) {
        ix = new SurfaceIndex(geometry);
        indexes.set(pos.array, ix);
    }
    return ix;
}

/**
 * `geo` (a patch, in its own frame) laid onto the scan: a new, unindexed
 * geometry whose points have moved `amount` of the way to the surface (each
 * lifted `lift` off it, toward where it was), carrying `scanUv` and
 * `scanPart` (where on the scan's texture each lands) for painting it in.
 * `toSurf` takes the patch's frame to the scan mesh's, `fromSurf` back.
 * Points with no surface within `reach` stay where they are.
 */
export function wrapPatch(geo, ix, toSurf, fromSurf, { amount = 1, lift = 0.002, reach = 0.5 } = {}) {
    const src = geo.index ? geo.toNonIndexed() : geo.clone();
    const pos = src.getAttribute('position');
    const n = pos.count;
    const scanUv = new Float32Array(n * 2);
    const scanPart = new Float32Array(n);
    const hit = new Array(n);
    const v = new THREE.Vector3();
    const local = new Array(n);
    // Scale the reach and lift into the scan's frame.
    const k = new THREE.Vector3().setFromMatrixScale(toSurf).x || 1;
    for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toSurf);
        local[i] = [v.x, v.y, v.z];
        hit[i] = ix.nearest(v.x, v.y, v.z, reach * k);
    }
    // A triangle is painted from one atlas: the one most of its corners land
    // on; corners that landed on another are found again on that one.
    for (let t = 0; t < n; t += 3) {
        const parts = [0, 1, 2].map((j) => (hit[t + j] ? ix.part[hit[t + j].face] : -1));
        const counts = new Map();
        parts.forEach((p) => { if (p >= 0) counts.set(p, (counts.get(p) || 0) + 1); });
        let part = -1;
        let most = 0;
        counts.forEach((c, p) => { if (c > most) { most = c; part = p; } });
        for (let j = 0; j < 3; j++) {
            const i = t + j;
            if (part >= 0 && parts[j] !== part) {
                const again = ix.nearest(local[i][0], local[i][1], local[i][2], reach * k * 2, part);
                if (again) hit[i] = { ...again, keepPos: hit[i] };
            }
            const h = hit[i];
            scanPart[i] = Math.max(0, part);
            if (h) {
                const uv = ix.uvAt(h.face, h.bary);
                scanUv[i * 2] = uv[0];
                scanUv[i * 2 + 1] = uv[1];
            }
        }
    }
    // Moved: to the surface (its own nearest point, not the re-found one), lifted toward where it was.
    if (amount > 0) {
        for (let i = 0; i < n; i++) {
            const h = hit[i]?.keepPos || hit[i];
            if (!h) continue;
            const [x, y, z] = local[i];
            const dx = x - h.at[0]; const dy = y - h.at[1]; const dz = z - h.at[2];
            const dl = Math.hypot(dx, dy, dz);
            let nx; let ny; let nz;
            if (dl > 1e-6) { nx = dx / dl; ny = dy / dl; nz = dz / dl; } else {
                // On the surface already: lift along its face.
                const P = ix.P; const I = ix.I; const f = h.face;
                const a = I[f * 3] * 3; const b = I[f * 3 + 1] * 3; const c = I[f * 3 + 2] * 3;
                const ux = P[b] - P[a]; const uy = P[b + 1] - P[a + 1]; const uz = P[b + 2] - P[a + 2];
                const wx = P[c] - P[a]; const wy = P[c + 1] - P[a + 1]; const wz = P[c + 2] - P[a + 2];
                nx = uy * wz - uz * wy; ny = uz * wx - ux * wz; nz = ux * wy - uy * wx;
                const l = Math.hypot(nx, ny, nz) || 1;
                nx /= l; ny /= l; nz /= l;
            }
            const L = lift * k;
            const tx = h.at[0] + nx * L; const ty = h.at[1] + ny * L; const tz = h.at[2] + nz * L;
            v.set(x + (tx - x) * amount, y + (ty - y) * amount, z + (tz - z) * amount).applyMatrix4(fromSurf);
            pos.setXYZ(i, v.x, v.y, v.z);
        }
    }
    src.setAttribute('scanUv', new THREE.BufferAttribute(scanUv, 2));
    src.setAttribute('scanPart', new THREE.BufferAttribute(scanPart, 1));
    src.computeVertexNormals();
    src.computeBoundingSphere();
    return src;
}
