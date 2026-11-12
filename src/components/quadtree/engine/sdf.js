// Signed distance fields for glyphs, so ascii quads keep sharp edges however
// large they are drawn: the atlas stores, per texel, how far it is from the
// glyph's outline, and the shader works out coverage per screen pixel from
// that. Built from an anti-aliased raster with the exact Euclidean distance
// transform (Felzenszwalb & Huttenlocher), using the raster's coverage for
// sub-texel edge positions (the approach of Mapbox's tiny-sdf).

const INF = 1e20;

// Squared distance transform of one row or column, in place.
function edt1d(grid, offset, stride, length, f, v, z) {
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let i = 0; i < length; i++) f[i] = grid[offset + i * stride];
    for (let q = 1, k = 0, s = 0; q < length; q++) {
        do {
            const r = v[k];
            s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
        } while (s <= z[k] && --k > -1);
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }
    for (let q = 0, k = 0; q < length; q++) {
        while (z[k + 1] < q) k++;
        const r = v[k];
        const qr = q - r;
        grid[offset + q * stride] = f[r] + qr * qr;
    }
}

function edt(grid, size, f, v, z) {
    for (let x = 0; x < size; x++) edt1d(grid, x, size, size, f, v, z);
    for (let y = 0; y < size; y++) edt1d(grid, y * size, 1, size, f, v, z);
}

/** The settings the shader decodes with: distance = (1 - CUTOFF - value) * RADIUS. */
export const SDF_RADIUS = 8;
export const SDF_CUTOFF = 0.25;

/**
 * Distance field of one square cell of coverage values (0-255, `size` x
 * `size`), as bytes: 255 deep inside, 255 * (1 - CUTOFF) on the outline,
 * falling to 0 RADIUS texels outside.
 */
export function makeSdfTools(size) {
    const n = size * size;
    const outer = new Float64Array(n);
    const inner = new Float64Array(n);
    const f = new Float64Array(size);
    const v = new Uint16Array(size);
    const z = new Float64Array(size + 1);
    return function sdf(coverage, out) {
        for (let i = 0; i < n; i++) {
            const a = coverage[i] / 255;
            if (a >= 1) { outer[i] = 0; inner[i] = INF; } else if (a <= 0) { outer[i] = INF; inner[i] = 0; } else {
                const d = 0.5 - a;
                outer[i] = d > 0 ? d * d : 0;
                inner[i] = d < 0 ? d * d : 0;
            }
        }
        edt(outer, size, f, v, z);
        edt(inner, size, f, v, z);
        for (let i = 0; i < n; i++) {
            const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
            const val = Math.round(255 - 255 * (d / SDF_RADIUS + SDF_CUTOFF));
            out[i] = val < 0 ? 0 : (val > 255 ? 255 : val);
        }
        return out;
    };
}
