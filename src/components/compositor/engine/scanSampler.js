// More scan points than the take's PLY holds, sampled from the scan mesh
// itself: every part of it, with its mesh edits, coloured from each part's
// own texture the way the pipeline's sampler (backend/glb_to_ply) colours
// the PLY. So Scan points can be made as dense as a look wants without a
// bigger file, and a filled hole gets points too.
//
// Point i depends only on i (a hash of it picks its triangle and where on
// it), never on how many were asked for before, so growing the cloud in
// steps gives the same points as making them at once, and a preview and an
// export agree.

/** lowbias32: a well-mixed 32-bit hash, as a number in [0, 1). */
function hash01(x) {
    let h = x >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// sRGB byte -> linear, as PLYLoader converts the PLY's colours.
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/**
 * A texture's pixels, read back once, at most `maxSize` on its long side
 * (a point's colour does not need the full 4096 page, and four bytes a
 * texel of it is 64 MB). Rows run top-down, as glTF's v does.
 */
export function readTexels(map, maxSize = 2048) {
    const img = map?.image;
    const w0 = img?.width || img?.videoWidth;
    const h0 = img?.height || img?.videoHeight;
    if (!w0 || !h0) return null;
    const k = Math.min(1, maxSize / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        // A texture GLTFLoader made with flipY reads bottom-up; undo it so
        // row 0 is v = 0 either way.
        if (map.flipY) { ctx.translate(0, h); ctx.scale(1, -1); }
        ctx.drawImage(img, 0, 0, w, h);
        return { data: ctx.getImageData(0, 0, w, h).data, w, h };
    } catch (e) {
        return null;
    }
}

/**
 * What sampling needs from a scan geometry, made once per version of it:
 * the triangles' cumulative areas and each triangle's material.
 */
export function surfaceOf(geometry) {
    const pos = geometry.getAttribute('position').array;
    const uvAttr = geometry.getAttribute('uv');
    const index = geometry.index ? geometry.index.array : null;
    const nt = (index ? index.length : pos.length / 3) / 3;
    const cdf = new Float64Array(nt);
    const at = index ? (k) => index[k] : (k) => k;
    let total = 0;
    for (let t = 0; t < nt; t++) {
        const a = at(t * 3) * 3;
        const b = at(t * 3 + 1) * 3;
        const c = at(t * 3 + 2) * 3;
        const ux = pos[b] - pos[a]; const uy = pos[b + 1] - pos[a + 1]; const uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a]; const vy = pos[c + 1] - pos[a + 1]; const vz = pos[c + 2] - pos[a + 2];
        const cx = uy * vz - uz * vy; const cy = uz * vx - ux * vz; const cz = ux * vy - uy * vx;
        total += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
        cdf[t] = total;
    }
    const mat = new Uint16Array(nt);
    (geometry.groups || []).forEach((g) => {
        const end = Math.min(nt, (g.start + g.count) / 3);
        for (let t = g.start / 3; t < end; t++) mat[t] = g.materialIndex || 0;
    });
    return { pos, uv: uvAttr ? uvAttr.array : null, at, cdf, total, mat, triangles: nt };
}

/**
 * Fill points [from, to) of `outPos` (xyz) and `outColor` (linear rgb, or
 * null) with samples of `surface`, uniform over its area. `texels[m]` is
 * material m's (readTexels) or null; `flat[m]` its linear colour when it has
 * no texture.
 */
export function sampleSurface(surface, texels, flat, from, to, outPos, outColor, seed = 0x5ca9) {
    const { pos, uv, at, cdf, total, mat, triangles } = surface;
    if (!triangles || !(total > 0)) return;
    for (let i = from; i < to; i++) {
        const key = Math.imul(i, 3) ^ seed;
        const r0 = hash01(key);
        const r1 = hash01(key + 1);
        const r2 = hash01(key + 2);
        // The triangle: the first whose cumulative area passes r0.
        const target = r0 * total;
        let lo = 0;
        let hi = triangles - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (cdf[mid] < target) lo = mid + 1; else hi = mid;
        }
        const ia = at(lo * 3); const ib = at(lo * 3 + 1); const ic = at(lo * 3 + 2);
        const s = Math.sqrt(r1);
        const wa = 1 - s; const wb = s * (1 - r2); const wc = s * r2;
        const o = i * 3;
        for (let d = 0; d < 3; d++) outPos[o + d] = wa * pos[ia * 3 + d] + wb * pos[ib * 3 + d] + wc * pos[ic * 3 + d];
        if (!outColor) continue;
        const m = mat[lo];
        const tx = texels[m];
        if (tx && uv) {
            let u = wa * uv[ia * 2] + wb * uv[ib * 2] + wc * uv[ic * 2];
            let v = wa * uv[ia * 2 + 1] + wb * uv[ib * 2 + 1] + wc * uv[ic * 2 + 1];
            u -= Math.floor(u);
            v -= Math.floor(v);
            const px = Math.min(tx.w - 1, Math.floor(u * (tx.w - 1)));
            const py = Math.min(tx.h - 1, Math.floor(v * (tx.h - 1)));
            const p = (py * tx.w + px) * 4;
            outColor[o] = SRGB_TO_LINEAR[tx.data[p]];
            outColor[o + 1] = SRGB_TO_LINEAR[tx.data[p + 1]];
            outColor[o + 2] = SRGB_TO_LINEAR[tx.data[p + 2]];
        } else {
            const c = flat[m] || [0.216, 0.216, 0.216]; // the PLY's grey 128, linear
            outColor[o] = c[0];
            outColor[o + 1] = c[1];
            outColor[o + 2] = c[2];
        }
    }
}
