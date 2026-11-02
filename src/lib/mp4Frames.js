// Frame-accurate, sequential access to an MP4's pictures through WebCodecs.
//
// The exporter used to seek a <video> element to every frame it wrote. Each
// seek makes the browser go back to the previous keyframe and decode forward
// to the target, then hand the picture over through the compositor - so a
// 15-frame GOP costs up to fifteen decodes and a round trip through the media
// pipeline per output frame, which is why export ran at a few frames a second
// while playback of the same file is effortless. Decoding is cheap when it is
// done in order, which is all an export needs: this reads the file's sample
// tables, feeds the encoded samples to a VideoDecoder in decode order, and
// hands back pictures by presentation index. Asking for the next frame costs
// one decode; only going backwards or jumping a gap restarts from a keyframe.
//
// The demuxer only understands what the vidtrack pipeline writes - a
// progressive (non-fragmented) MP4 with one H.264 video track - and anything
// else makes open() return null so the caller can fall back to seeking.

// ---- Box parsing -------------------------------------------------------------

function readBoxes(view, start, end) {
    const out = [];
    let at = start;
    while (at + 8 <= end) {
        let size = view.getUint32(at);
        const type = String.fromCharCode(
            view.getUint8(at + 4), view.getUint8(at + 5),
            view.getUint8(at + 6), view.getUint8(at + 7),
        );
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

// The sample tables of the first video track, expanded to one entry per
// sample: where it lives in the file, how big it is, its composition time and
// whether it is a keyframe.
function parseVideoTrack(buf) {
    const view = new DataView(buf);
    const top = readBoxes(view, 0, buf.byteLength);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) return null;

    const trak = readBoxes(view, moov.body, moov.end)
        .filter((b) => b.type === 'trak')
        .find((tk) => {
            const hdlr = path(view, tk, 'mdia', 'hdlr');
            if (!hdlr) return false;
            const h = hdlr.body + 8;
            return String.fromCharCode(
                view.getUint8(h), view.getUint8(h + 1),
                view.getUint8(h + 2), view.getUint8(h + 3),
            ) === 'vide';
        });
    if (!trak) return null;

    const stbl = path(view, trak, 'mdia', 'minf', 'stbl');
    if (!stbl) return null;

    // Sample description: an avc1/avc3 entry whose avcC is the decoder's
    // configuration record verbatim.
    const stsd = child(view, stbl, 'stsd');
    if (!stsd) return null;
    const entry = readBoxes(view, stsd.body + 8, stsd.end)[0];
    if (!entry || (entry.type !== 'avc1' && entry.type !== 'avc3')) return null;
    const width = view.getUint16(entry.body + 24);
    const height = view.getUint16(entry.body + 26);
    const avcC = readBoxes(view, entry.body + 78, entry.end)
        .find((b) => b.type === 'avcC');
    if (!avcC) return null;
    const description = new Uint8Array(buf, avcC.body, avcC.end - avcC.body).slice();
    const hex = (n) => n.toString(16).padStart(2, '0');
    const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;

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
        codec, description, width, height, count, sizes, offsets, cts, key,
    };
}

// ---- Reader ------------------------------------------------------------------

// How far the decoder may run ahead of what has been asked for. Decoders hand
// out pictures from a small pool and stall once the caller holds too many, so
// this stays well under any pool size while still keeping the decoder busy
// while the previous frame renders.
const MAX_HELD = 6;
const MAX_IN_FLIGHT = 4;

export class Mp4FrameReader {
    // Fetch and parse `url`. Resolves to null when the file or the browser
    // cannot go this way, so the caller can fall back to seeking.
    static async open(url) {
        if (typeof window === 'undefined' || typeof window.VideoDecoder === 'undefined'
            || typeof window.EncodedVideoChunk === 'undefined') {
            return null;
        }
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const buf = await res.arrayBuffer();
            const info = parseVideoTrack(buf);
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
            return new Mp4FrameReader(buf, info, config);
        } catch (e) {
            return null;
        }
    }

    constructor(buf, info, config) {
        this.buf = buf;
        this.info = info;
        this.config = config;
        this.frameCount = info.count;
        this.width = info.width;
        this.height = info.height;

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

    // Keep the decoder working on what comes next while the caller renders
    // the frame it was just handed.
    topUp() {
        while (this.next < this.frameCount && this.held.length < MAX_HELD
            && this.decoder.decodeQueueSize < MAX_IN_FLIGHT) {
            this.feed();
        }
    }

    feed() {
        const i = this.next++;
        const { offsets, sizes, key } = this.info;
        this.decoder.decode(new window.EncodedVideoChunk({
            type: key[i] ? 'key' : 'delta',
            timestamp: this.rank[i] * 1000,
            data: new Uint8Array(this.buf, offsets[i], sizes[i]),
        }));
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
                this.feed();
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
        this.buf = null;
    }
}
