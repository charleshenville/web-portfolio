// Pixel-sorting engine for the Pixel Sorter. Lives apart from the component
// so the video export can run it in workers (pixelSortPool.js) - frames
// are independent, so sorting them on every core at once is most of what
// makes a full-resolution export fast.

// Fills `out` (Float32Array, one value per pixel, normalized 0..1) with the
// chosen metric. Used both as the sort key and as the threshold measure.
function computeMetric(data, n, mode, out) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        let v;
        if (mode === 'brightness') {
            v = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        } else if (mode === 'red') {
            v = r / 255;
        } else if (mode === 'green') {
            v = g / 255;
        } else if (mode === 'blue') {
            v = b / 255;
        } else {
            const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
            if (mode === 'lightness') {
                v = (max + min) / 510;
            } else if (mode === 'saturation') {
                const d = max - min;
                const l2 = max + min; // 2 * lightness * 255
                v = d === 0 ? 0 : d / (255 - Math.abs(l2 - 255));
            } else { // hue
                const d = max - min;
                if (d === 0) {
                    v = 0;
                } else if (max === r) {
                    v = (((g - b) / d + 6) % 6) / 6;
                } else if (max === g) {
                    v = ((b - r) / d + 2) / 6;
                } else {
                    v = ((r - g) / d + 4) / 6;
                }
            }
        }
        out[i] = v;
    }
}

// The order that sorts one run by its keys - the same order a stable sort
// with a comparator would give, without calling a comparator per comparison,
// which made sorting the bulk of an export's time. Non-negative floats order
// the same as their bit patterns, so each pixel's key bits and its index in
// the run pack exactly into one float64 (key bits < 2^31, index < 2^16) and
// the typed array's native numeric sort does the rest; the index both breaks
// ties stably and comes back out as the result.
const PACK = 65536;
let packed = new Float64Array(0);
function sortedOrder(keys, bits, offset, stride, len) {
    const order = new Int32Array(len);
    if (len >= PACK) {
        for (let i = 0; i < len; i++) order[i] = i;
        order.sort((a, b) => keys[offset + a * stride] - keys[offset + b * stride]);
        return order;
    }
    if (packed.length < len) packed = new Float64Array(Math.max(len, packed.length * 2));
    const pk = packed.subarray(0, len);
    for (let i = 0; i < len; i++) pk[i] = bits[offset + i * stride] * PACK + i;
    pk.sort();
    for (let i = 0; i < len; i++) order[i] = pk[i] % PACK;
    return order;
}

// Scans every row (or column) of the frame, finds runs of pixels whose
// threshold metric falls inside [low, high], chops runs to the max segment
// length, and computes each run's sorted order. Returns a "plan": a list of
// { offset, stride, order } runs addressed into the flat pixel array, which
// can then be applied fully (photos / video frames) or partially (the
// animated photo export).
export function buildPlan(data, w, h, s) {
    const n = w * h;
    const keys = new Float32Array(n);
    computeMetric(data, n, s.sortBy, keys);
    const bits = new Uint32Array(keys.buffer);

    let met = null;
    if (s.thresholdMode !== 'none') {
        if (s.thresholdMode === s.sortBy) {
            met = keys;
        } else {
            met = new Float32Array(n);
            computeMetric(data, n, s.thresholdMode, met);
        }
    }

    const lo = Math.min(s.low, s.high) / 100;
    const hi = Math.max(s.low, s.high) / 100;
    const horizontal = s.direction === 'horizontal';
    const lineCount = horizontal ? h : w;
    const lineLen = horizontal ? w : h;
    const stride = horizontal ? 1 : w;
    const maxLen = Math.max(0, Math.round(s.segmentMaxLength));
    const runs = [];

    const flushRun = (lineBase, start, totalLen) => {
        let s0 = start;
        let left = totalLen;
        while (left > 0) {
            const len = maxLen > 0 ? Math.min(maxLen, left) : left;
            if (len >= 2) {
                const offset = lineBase + s0 * stride;
                const order = sortedOrder(keys, bits, offset, stride, len);
                if (s.reverse) order.reverse();
                runs.push({ offset, stride, order });
            }
            s0 += len;
            left -= len;
        }
    };

    for (let li = 0; li < lineCount; li++) {
        const lineBase = horizontal ? li * w : li;
        let runStart = -1;
        for (let i = 0; i < lineLen; i++) {
            let ok = true;
            if (met !== null) {
                const m = met[lineBase + i * stride];
                ok = m >= lo && m <= hi;
            }
            if (ok) {
                if (runStart < 0) runStart = i;
            } else if (runStart >= 0) {
                flushRun(lineBase, runStart, i - runStart);
                runStart = -1;
            }
        }
        if (runStart >= 0) flushRun(lineBase, runStart, lineLen - runStart);
    }

    return runs;
}

// Writes one sorted run (tmp holds the run's pixel values in final order)
// into dst, offsetting the red channel backward and blue channel forward
// along the run by `shift` px for a chromatic glitch.
function writeRun(dst32, tmp, offset, stride, len, shift) {
    if (shift <= 0) {
        for (let j = 0; j < len; j++) dst32[offset + j * stride] = tmp[j];
        return;
    }
    for (let j = 0; j < len; j++) {
        let ri = j - shift;
        if (ri < 0) ri = 0;
        let bi = j + shift;
        if (bi >= len) bi = len - 1;
        dst32[offset + j * stride] = (tmp[j] & 0xff00ff00)
            | (tmp[ri] & 0x000000ff)
            | (tmp[bi] & 0x00ff0000);
    }
}

// Fully sorted result: dst becomes src with every planned run reordered.
export function applyPlan(src32, dst32, runs, rgbShift) {
    dst32.set(src32);
    const shift = Math.max(0, Math.round(rgbShift));
    let tmp = null;
    for (const run of runs) {
        const { offset, stride, order } = run;
        const len = order.length;
        if (!tmp || tmp.length < len) tmp = new Uint32Array(len);
        for (let j = 0; j < len; j++) tmp[j] = src32[offset + order[j] * stride];
        writeRun(dst32, tmp, offset, stride, len, shift);
    }
}

// Partially sorted result for the animated photo export: every pixel travels
// from its original position toward its sorted position, `progress` (0..1,
// smoothstepped) of the way there. RGB shift ramps in with the same curve.
export function applyPlanProgress(src32, dst32, runs, progress, rgbShift) {
    dst32.set(src32);
    const p = progress < 0 ? 0 : (progress > 1 ? 1 : progress);
    const e = p * p * (3 - 2 * p);
    const shift = Math.round(Math.max(0, rgbShift) * e);
    let inv = null;
    let scratch = null;
    for (const run of runs) {
        const { offset, stride, order } = run;
        const len = order.length;
        if (!inv || inv.length < len) {
            inv = new Int32Array(len);
            scratch = new Uint32Array(len);
        }
        for (let j = 0; j < len; j++) {
            inv[order[j]] = j;
            scratch[j] = src32[offset + j * stride];
        }
        for (let i = 0; i < len; i++) {
            const pos = i + Math.round((inv[i] - i) * e);
            scratch[pos] = src32[offset + i * stride];
        }
        writeRun(dst32, scratch, offset, stride, len, shift);
    }
}

// Sorts an RGBA buffer in place. `progress` < 1 leaves every pixel part-way
// to its sorted position (photo animation).
export function sortPixels(data, w, h, s, progress) {
    const runs = buildPlan(data, w, h, s);
    const src32 = new Uint32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const dst32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
    if (progress === undefined || progress >= 1) {
        applyPlan(src32, dst32, runs, s.rgbShift);
    } else {
        applyPlanProgress(src32, dst32, runs, progress, s.rgbShift);
    }
}
