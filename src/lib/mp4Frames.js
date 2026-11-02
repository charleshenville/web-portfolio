// Frame-accurate, sequential access to an MP4's pictures through WebCodecs.
//
// The exporters used to seek a <video> element to every frame they wrote.
// Each seek makes the browser go back to the previous keyframe and decode
// forward to the target, then hand the picture over through the compositor -
// so a 15-frame GOP costs up to fifteen decodes and a round trip through the
// media pipeline per output frame, which is why export ran at a few frames a
// second while playback of the same file is effortless. Decoding is cheap when
// it is done in order, which is all an export needs: this reads the file's
// sample tables, feeds the encoded samples to a VideoDecoder in decode order,
// and hands back pictures by presentation index or by time. Asking for the
// next frame costs one decode; only going backwards or jumping a gap restarts
// from a keyframe.
//
// Works on a URL or a File/Blob. Only the moov box is read up front, and
// samples are read in runs of a few MB as the decoder reaches them, so a
// multi-gigabyte phone clip is never pulled into memory whole.
//
// The demuxer understands progressive (non-fragmented) MP4 / QuickTime with an
// H.264 or HEVC video track - what the vidtrack pipeline writes and what
// phones record. Anything else makes open() return null so the caller can fall
// back to seeking.

// ---- Box parsing -------------------------------------------------------------

function fourcc(view, at) {
    return String.fromCharCode(
        view.getUint8(at), view.getUint8(at + 1),
        view.getUint8(at + 2), view.getUint8(at + 3),
    );
}

function readBoxes(view, start, end) {
    const out = [];
    let at = start;
    while (at + 8 <= end) {
        let size = view.getUint32(at);
        const type = fourcc(view, at + 4);
        let header = 8;
        if (size === 1) {
            size = Number(view.getBigUint64(at + 8));
            header = 16;
        } else if (size === 0) {
            size = end - at;
        }
        if (size < header || at + size > end) break;
        out.push({ type, start: at, body: at + header, end: at + size });
        at += size;
    }
    return out;
}

const child = (view, box, type) => (
    readBoxes(view, box.body, box.end).find((b) => b.type === type) || null
);

function path(view, box, ...types) {
    let cur = box;
    for (const t of types) {
        cur = cur && child(view, cur, t);
    }
    return cur;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

// RFC 6381 codec string for an HEVC configuration record.
function hevcCodec(prefix, d) {
    const space = ['', 'A', 'B', 'C'][d[1] >> 6];
    const tier = (d[1] >> 5) & 1 ? 'H' : 'L';
    const profile = d[1] & 0x1f;
    // Compatibility flags are written bit-reversed.
    let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
    let rev = 0;
    for (let b = 0; b < 32; b++) {
        rev = ((rev << 1) | (compat & 1)) >>> 0;
        compat >>>= 1;
    }
    const constraints = Array.from(d.subarray(6, 12));
    while (constraints.length && constraints[constraints.length - 1] === 0) {
        constraints.pop();
    }
    return [`${prefix}.${space}${profile}`, rev.toString(16), `${tier}${d[12]}`,
        ...constraints.map((c) => c.toString(16).toUpperCase())].join('.');
}

// The sample tables of the first video track, expanded to one entry per
// sample: where it lives in the file, how big it is, its composition time and
// whether it is a keyframe. `buf` holds the moov box alone; sample offsets
// are absolute positions in the file.
function parseVideoTrack(buf) {
    const view = new DataView(buf);
    const moov = readBoxes(view, 0, buf.byteLength).find((b) => b.type === 'moov');
    if (!moov) return null;

    const trak = readBoxes(view, moov.body, moov.end)
        .filter((b) => b.type === 'trak')
        .find((tk) => {
            const hdlr = path(view, tk, 'mdia', 'hdlr');
            return !!hdlr && fourcc(view, hdlr.body + 8) === 'vide';
        });
    if (!trak) return null;

    const mdhd = path(view, trak, 'mdia', 'mdhd');
    const stbl = path(view, trak, 'mdia', 'minf', 'stbl');
    if (!mdhd || !stbl) return null;
    const timescale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));
    if (!timescale) return null;

    // Display rotation, from the track's transform. A phone held upright
    // records landscape pixels and asks for them to be turned; the <video>
    // element obeys, so decoded pictures have to be turned the same way.
    let rotation = 0;
    const tkhd = child(view, trak, 'tkhd');
    if (tkhd) {
        const m = tkhd.body + (view.getUint8(tkhd.body) === 1 ? 52 : 40);
        const a = view.getInt32(m) / 65536;
        const b = view.getInt32(m + 4) / 65536;
        rotation = ((Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90) + 360) % 360;
    }

    // Sample description: an avc/hevc entry whose configuration box is the
    // decoder's description verbatim.
    const stsd = child(view, stbl, 'stsd');
    if (!stsd) return null;
    const entry = readBoxes(view, stsd.body + 8, stsd.end)[0];
    if (!entry) return null;
    const kind = { avc1: 'avcC', avc3: 'avcC', hvc1: 'hvcC', hev1: 'hvcC' }[entry.type];
    if (!kind) return null;
    const width = view.getUint16(entry.body + 24);
    const height = view.getUint16(entry.body + 26);
    const cfg = readBoxes(view, entry.body + 78, entry.end).find((b) => b.type === kind);
    if (!cfg) return null;
    const description = new Uint8Array(buf, cfg.body, cfg.end - cfg.body).slice();
    const codec = kind === 'avcC'
        ? `avc1.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`
        : hevcCodec(entry.type, description);

    // Sizes.
    const stsz = child(view, stbl, 'stsz');
    if (!stsz) return null;
    const fixed = view.getUint32(stsz.body + 4);
    const count = view.getUint32(stsz.body + 8);
    if (!count) return null;
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
        sizes[i] = fixed || view.getUint32(stsz.body + 12 + i * 4);
    }

    // Chunk offsets, then samples laid out chunk by chunk.
    const stco = child(view, stbl, 'stco');
    const co64 = child(view, stbl, 'co64');
    const chunkBox = stco || co64;
    if (!chunkBox) return null;
    const chunkCount = view.getUint32(chunkBox.body + 4);
    const chunkOffset = (k) => (stco
        ? view.getUint32(chunkBox.body + 8 + k * 4)
        : Number(view.getBigUint64(chunkBox.body + 8 + k * 8)));

    const stsc = child(view, stbl, 'stsc');
    if (!stsc) return null;
    const runs = view.getUint32(stsc.body + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let r = 0; r < runs && s < count; r++) {
        const e = stsc.body + 8 + r * 12;
        const first = view.getUint32(e) - 1;
        const per = view.getUint32(e + 4);
        const last = r + 1 < runs ? view.getUint32(e + 12) - 1 : chunkCount;
        for (let c = first; c < last && s < count; c++) {
            let at = chunkOffset(c);
            for (let j = 0; j < per && s < count; j++) {
                offsets[s] = at;
                at += sizes[s];
                s++;
            }
        }
    }
    if (s < count) return null;

    // Decode times, then composition offsets on top for B-frames.
    const cts = new Float64Array(count);
    const stts = child(view, stbl, 'stts');
    if (!stts) return null;
    let t = 0;
    s = 0;
    for (let r = 0, n = view.getUint32(stts.body + 4); r < n; r++) {
        const e = stts.body + 8 + r * 8;
        const k = view.getUint32(e);
        const delta = view.getUint32(e + 4);
        for (let j = 0; j < k && s < count; j++) { cts[s++] = t; t += delta; }
    }
    const ctts = child(view, stbl, 'ctts');
    if (ctts) {
        const signed = view.getUint8(ctts.body) === 1;
        s = 0;
        for (let r = 0, n = view.getUint32(ctts.body + 4); r < n; r++) {
            const e = ctts.body + 8 + r * 8;
            const k = view.getUint32(e);
            const off = signed ? view.getInt32(e + 4) : view.getUint32(e + 4);
            for (let j = 0; j < k && s < count; j++) cts[s++] += off;
        }
    }

    // Keyframes. No table means every sample is one.
    const key = new Uint8Array(count);
    const stss = child(view, stbl, 'stss');
    if (stss) {
        for (let r = 0, n = view.getUint32(stss.body + 4); r < n; r++) {
            const k = view.getUint32(stss.body + 8 + r * 4) - 1;
            if (k >= 0 && k < count) key[k] = 1;
        }
    } else {
        key.fill(1);
    }

    return {
        codec, description, width, height, rotation, timescale,
        count, sizes, offsets, cts, key,
    };
}

// Find the moov box among the file's top-level boxes and read just that.
async function readMoov(blob) {
    let at = 0;
    while (at + 8 <= blob.size) {
        // eslint-disable-next-line no-await-in-loop
        const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
        let size = head.getUint32(0);
        const type = fourcc(head, 4);
        if (size === 1) size = Number(head.getBigUint64(8));
        else if (size === 0) size = blob.size - at;
        if (size < 8) return null;
        if (type === 'moov') return blob.slice(at, at + size).arrayBuffer();
        at += size;
    }
    return null;
}

// ---- Reader ------------------------------------------------------------------

// How far the decoder may run ahead of what has been asked for. Decoders hand
// out pictures from a small pool and stall once the caller holds too many, so
// this stays well under any pool size while still keeping the decoder busy
// while the previous frame is being used.
const MAX_HELD = 6;
const MAX_IN_FLIGHT = 4;
// Encoded samples are read from the file in runs rather than one slice each.
const RUN_BYTES = 8 * 1024 * 1024;
const RUN_SAMPLES = 64;

export class Mp4FrameReader {
    // Open a URL or a File/Blob. Resolves to null when the file or the
    // browser cannot go this way, so the caller can fall back to seeking.
    static async open(src) {
        if (typeof window === 'undefined' || typeof window.VideoDecoder === 'undefined'
            || typeof window.EncodedVideoChunk === 'undefined') {
            return null;
        }
        try {
            let blob = src;
            if (typeof src === 'string') {
                const res = await fetch(src);
                if (!res.ok) return null;
                blob = await res.blob();
            }
            const moov = await readMoov(blob);
            const info = moov && parseVideoTrack(moov);
            if (!info) return null;
            const config = {
                codec: info.codec,
                description: info.description,
                codedWidth: info.width,
                codedHeight: info.height,
                optimizeForLatency: false,
            };
            const support = await window.VideoDecoder.isConfigSupported(config);
            if (!support.supported) return null;
            return new Mp4FrameReader(blob, info, config);
        } catch (e) {
            return null;
        }
    }

    constructor(blob, info, config) {
        this.blob = blob;
        this.info = info;
        this.config = config;
        this.frameCount = info.count;
        this.rotation = info.rotation;
        const turned = info.rotation % 180 !== 0;
        // Size as displayed, after rotation - what <video> reports.
        this.width = turned ? info.height : info.width;
        this.height = turned ? info.width : info.height;

        // Presentation index of every sample, and the reverse: which sample
        // in decode order is shown as frame p. Chunks carry their
        // presentation index as their timestamp, so a decoded picture says
        // which frame it is without any clock arithmetic.
        const order = Array.from({ length: info.count }, (_, i) => i)
            .sort((a, b) => info.cts[a] - info.cts[b]);
        this.rank = new Int32Array(info.count);
        this.decodeIndex = new Int32Array(info.count);
        order.forEach((sample, p) => {
            this.rank[sample] = p;
            this.decodeIndex[p] = sample;
        });
        // When each frame goes up, in seconds from the first.
        const t0 = info.cts[order[0]];
        this.times = Float64Array.from(order, (i) => (info.cts[i] - t0) / info.timescale);
        // The keyframe a decode has to start from to reach each sample.
        this.keyBefore = new Int32Array(info.count);
        let k = 0;
        for (let i = 0; i < info.count; i++) {
            if (info.key[i]) k = i;
            this.keyBefore[i] = k;
        }

        this.held = [];
        this.error = null;
        this.wake = null;
        this.run = null;
        this.ahead = null;
        this.decoder = new window.VideoDecoder({
            output: (frame) => {
                this.held.push(frame);
                const p = Math.round(frame.timestamp / 1000);
                if (p > this.lastOut) this.lastOut = p;
                this.poke();
            },
            error: (e) => { this.error = e; this.poke(); },
        });
        this.restart(0);
    }

    // The frame on screen at `seconds`, as <video> would show it after a seek
    // there: the last one to go up at or before that time.
    indexAt(seconds) {
        const { times } = this;
        let lo = 0;
        let hi = times.length - 1;
        const t = seconds + 1e-4;
        if (t < times[0]) return 0;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (times[mid] <= t) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    frameAt(seconds) {
        return this.frame(this.indexAt(seconds));
    }

    // Draw a picture this reader returned into a w x h box, turned upright.
    draw(ctx, frame, w, h) {
        const r = this.rotation;
        if (!r) {
            ctx.drawImage(frame, 0, 0, w, h);
            return;
        }
        ctx.save();
        if (r === 90) {
            ctx.translate(w, 0);
            ctx.rotate(Math.PI / 2);
            ctx.drawImage(frame, 0, 0, h, w);
        } else if (r === 180) {
            ctx.translate(w, h);
            ctx.rotate(Math.PI);
            ctx.drawImage(frame, 0, 0, w, h);
        } else {
            ctx.translate(0, h);
            ctx.rotate(-Math.PI / 2);
            ctx.drawImage(frame, 0, 0, h, w);
        }
        ctx.restore();
    }

    poke() {
        const w = this.wake;
        this.wake = null;
        if (w) w();
    }

    // Wait for anything that could change what the loop below decides: a
    // picture coming out, the decoder taking more input, or an error. The
    // timer is only there in case a browser lacks the dequeue event.
    waitForDecoder() {
        return new Promise((resolve) => {
            let timer = null;
            const done = () => {
                clearTimeout(timer);
                this.decoder.removeEventListener?.('dequeue', done);
                if (this.wake === done) this.wake = null;
                resolve();
            };
            this.wake = done;
            this.decoder.addEventListener?.('dequeue', done);
            timer = setTimeout(done, 50);
        });
    }

    restart(fromSample) {
        try {
            if (this.decoder.state === 'configured') this.decoder.reset();
            this.decoder.configure(this.config);
        } catch (e) {
            this.error = e;
        }
        this.held.forEach((f) => f.close());
        this.held = [];
        this.next = fromSample;
        this.lastOut = -1;
        this.flushing = null;
    }

    // A run of consecutive samples (in decode order) read in one go.
    loadRun(i) {
        const { offsets, sizes } = this.info;
        const n = this.frameCount;
        let lo = offsets[i];
        let hi = offsets[i] + sizes[i];
        let j = i + 1;
        while (j < n && j - i < RUN_SAMPLES) {
            const a = Math.min(lo, offsets[j]);
            const b = Math.max(hi, offsets[j] + sizes[j]);
            if (b - a > RUN_BYTES) break;
            lo = a;
            hi = b;
            j++;
        }
        const run = { from: i, to: j, base: lo, bytes: null };
        run.ready = this.blob.slice(lo, hi).arrayBuffer()
            .then((b) => { run.bytes = b; })
            .catch((e) => { this.error = e; });
        return run;
    }

    // The run holding sample i, starting a read if none does, and keeping
    // the following run on its way so the decoder never waits on the disk.
    runFor(i) {
        const has = (r) => r && i >= r.from && i < r.to;
        if (!has(this.run)) {
            if (has(this.ahead)) {
                this.run = this.ahead;
            } else {
                this.run = this.loadRun(i);
            }
            this.ahead = null;
        }
        if (!this.ahead && this.run.to < this.frameCount) {
            this.ahead = this.loadRun(this.run.to);
        }
        return this.run;
    }

    // Sample i's bytes if they are already in memory.
    take(i) {
        const r = this.runFor(i);
        if (!r.bytes) return null;
        return new Uint8Array(r.bytes, this.info.offsets[i] - r.base, this.info.sizes[i]);
    }

    feed(data) {
        const i = this.next++;
        this.decoder.decode(new window.EncodedVideoChunk({
            type: this.info.key[i] ? 'key' : 'delta',
            timestamp: this.rank[i] * 1000,
            data,
        }));
    }

    // Keep the decoder working on what comes next while the caller uses the
    // frame it was just handed.
    topUp() {
        while (this.next < this.frameCount && this.held.length < MAX_HELD
            && this.decoder.decodeQueueSize < MAX_IN_FLIGHT) {
            const data = this.take(this.next);
            if (!data) break;
            this.feed(data);
        }
    }

    // The picture shown as frame `p`. It belongs to the reader and stays
    // valid until the next call; the caller must not close it. Resolves to
    // null only if the stream cannot produce that frame at all.
    async frame(p) {
        const n = this.frameCount;
        p = Math.max(0, Math.min(n - 1, Math.round(p)));
        if (this.error) return null;

        const drop = () => {
            while (this.held.length
                && Math.round(this.held[0].timestamp / 1000) < p) {
                this.held.shift().close();
            }
        };
        drop();
        const head = () => (this.held.length
            ? Math.round(this.held[0].timestamp / 1000) : -1);
        if (head() === p) {
            this.topUp();
            return this.held[0];
        }

        // Backwards, or already decoded past it: start again from its
        // keyframe. A gap wider than a GOP jumps straight there too, rather
        // than decoding pictures nobody will see.
        const key = this.keyBefore[this.decodeIndex[p]];
        if (p <= this.lastOut || key > this.next) this.restart(key);

        for (;;) {
            if (this.error) return null;
            drop();
            // Pictures come out in presentation order, so one past `p` means
            // `p` itself was never produced. Better a neighbour than nothing.
            if (head() >= p) {
                this.topUp();
                return this.held[0];
            }

            if (this.next < n && this.decoder.decodeQueueSize < MAX_IN_FLIGHT) {
                const data = this.take(this.next);
                if (data) {
                    this.feed(data);
                } else {
                    // eslint-disable-next-line no-await-in-loop
                    await this.run.ready;
                }
                continue;
            }
            if (this.next >= n && !this.flushing) {
                // The last few pictures only come out on a flush.
                this.flushing = this.decoder.flush().catch(() => {});
                // eslint-disable-next-line no-await-in-loop
                await this.flushing;
                continue;
            }
            if (this.flushing) {
                drop();
                return this.held.length ? this.held[0] : null;
            }
            // eslint-disable-next-line no-await-in-loop
            await this.waitForDecoder();
        }
    }

    close() {
        this.held.forEach((f) => f.close());
        this.held = [];
        try { this.decoder.close(); } catch (e) { /* already closed */ }
        this.blob = null;
        this.run = null;
        this.ahead = null;
    }
}

// ---- Encoder helpers -----------------------------------------------------------

// Wait until every encoder's queue is at or under `limit`, without a polling
// timer: the encoders' own dequeue events wake it, which also keeps an export
// in a background tab from being throttled to one timer tick a second. The
// short timer only covers browsers without the event. `limit` may be a
// number or one per encoder.
export async function drainEncoders(encoders, limit, failed = () => false) {
    const list = encoders.filter(Boolean);
    const caps = list.map((_, i) => (Array.isArray(limit) ? limit[i] : limit));
    const busy = () => list.some((e, i) => e.encodeQueueSize > caps[i]);
    while (busy() && !failed()) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
            let timer = null;
            const done = () => {
                clearTimeout(timer);
                list.forEach((e) => e.removeEventListener?.('dequeue', done));
                resolve();
            };
            list.forEach((e) => e.addEventListener?.('dequeue', done));
            timer = setTimeout(done, 20);
        });
    }
}

// Let the page paint and handle input without the clamping and background-tab
// throttling that setTimeout is subject to.
export function nextTask() {
    return new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        ch.port2.postMessage(null);
    });
}
