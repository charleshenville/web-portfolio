// Writing an MP4 frame by frame with WebCodecs and mp4-muxer: H.264 video
// from canvases, optional AAC/Opus sound from planar PCM. The compositor's
// exporter does the same inline; tools that only need "canvas in, file out"
// use this.

import {
    Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget,
} from 'mp4-muxer';
import { drainEncoders } from './mp4Frames';

export const canEncodeMp4 = () => typeof window !== 'undefined'
    && typeof window.VideoEncoder !== 'undefined' && typeof window.VideoFrame !== 'undefined';

async function pickCodec(w, h, bitrate, fps) {
    const list = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.64001f', 'avc1.4d0028', 'avc1.42e01e'];
    for (const codec of list) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const s = await window.VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps });
            if (s.supported) return codec;
        } catch (e) { /* next */ }
    }
    return null;
}

async function pickAudioCodec(rate, channels) {
    if (typeof window.AudioEncoder === 'undefined') return null;
    for (const [enc, box] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const s = await window.AudioEncoder.isConfigSupported({ codec: enc, sampleRate: rate, numberOfChannels: channels, bitrate: 192000 });
            if (s.supported) return [enc, box];
        } catch (e) { /* next */ }
    }
    return null;
}

/** Planar stereo PCM for [t0, t1) of an AudioBuffer, looped to fill the span. */
export function pcmSlice(buffer, t0, t1, { loop = false } = {}) {
    if (!buffer) return null;
    const rate = buffer.sampleRate;
    const length = Math.max(1, Math.round((t1 - t0) * rate));
    const from = Math.round(t0 * rate);
    const data = [0, 1].map((c) => {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        const out = new Float32Array(length);
        if (!loop) {
            out.set(src.subarray(Math.min(src.length, from), Math.min(src.length, from + length)));
        } else {
            for (let i = 0; i < length; i++) out[i] = src[(from + i) % src.length];
        }
        return out;
    });
    return { data, sampleRate: rate, channels: 2, length };
}

export class Mp4Writer {
    /**
     * { width, height, fps, bitrate, pcm, name }. Big files stream to disk
     * through the save picker, which must open while the click is fresh, so
     * call this straight from the click.
     */
    static async open({
        width, height, fps, bitrate, pcm = null, name = 'export', frames,
    }) {
        if (!canEncodeMp4()) throw new Error('MP4 export needs WebCodecs (Chrome, Edge or a recent Safari).');
        let fileStream = null;
        const est = (bitrate / 8) * (frames / fps);
        if (est > 500_000_000 && window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: `${name}.mp4`,
                    types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
                });
                fileStream = await handle.createWritable();
            } catch (e) { fileStream = null; }
        }
        const codec = await pickCodec(width, height, bitrate, fps);
        if (!codec) throw new Error('No H.264 encoder for this size.');
        const audioCodec = pcm ? await pickAudioCodec(pcm.sampleRate, pcm.channels) : null;
        return new Mp4Writer({
            width, height, fps, bitrate, pcm: audioCodec ? pcm : null, codec, audioCodec, fileStream,
        });
    }

    constructor({
        width, height, fps, bitrate, pcm, codec, audioCodec, fileStream,
    }) {
        Object.assign(this, {
            width, height, fps, pcm, fileStream,
        });
        const ntsc = Math.abs(fps * 1.001 - Math.round(fps * 1.001)) < 1e-3;
        const timescale = Number.isInteger(fps) ? fps : ntsc ? Math.round(fps * 1001) : 90000;
        this.target = fileStream ? new FileSystemWritableFileStreamTarget(fileStream) : new ArrayBufferTarget();
        this.muxer = new Muxer({
            target: this.target,
            video: { codec: 'avc', width, height, frameRate: timescale },
            ...(audioCodec ? { audio: { codec: audioCodec[1], numberOfChannels: pcm.channels, sampleRate: pcm.sampleRate } } : {}),
            fastStart: fileStream ? false : 'in-memory',
        });
        this.failed = null;
        this.encoder = new window.VideoEncoder({
            output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
            error: (e) => { this.failed = e; },
        });
        this.encoder.configure({
            codec, width, height, bitrate, framerate: fps, latencyMode: 'quality',
        });
        this.audioEncoder = null;
        if (audioCodec) {
            this.audioEncoder = new window.AudioEncoder({
                output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
                error: (e) => { this.failed = e; },
            });
            this.audioEncoder.configure({
                codec: audioCodec[0], sampleRate: pcm.sampleRate, numberOfChannels: pcm.channels, bitrate: 192000,
            });
        }
        this.audioCursor = 0;
        this.gop = Math.max(1, Math.round(fps * 2));
        this.index = 0;
    }

    pumpAudio(until) {
        const { pcm } = this;
        if (!this.audioEncoder) return;
        while (this.audioCursor < Math.min(until, pcm.length)) {
            const n = Math.min(1024, pcm.length - this.audioCursor);
            const planar = new Float32Array(n * pcm.channels);
            for (let c = 0; c < pcm.channels; c++) planar.set(pcm.data[c].subarray(this.audioCursor, this.audioCursor + n), c * n);
            const data = new window.AudioData({
                format: 'f32-planar',
                sampleRate: pcm.sampleRate,
                numberOfFrames: n,
                numberOfChannels: pcm.channels,
                timestamp: Math.round((this.audioCursor / pcm.sampleRate) * 1e6),
                data: planar,
            });
            this.audioEncoder.encode(data);
            data.close();
            this.audioCursor += n;
        }
    }

    /** Add the next frame from a canvas (width x height). */
    async add(canvas) {
        if (this.failed) throw this.failed;
        const i = this.index++;
        const stamp = (k) => Math.round((k * 1_000_000) / this.fps);
        const vf = new window.VideoFrame(canvas, { timestamp: stamp(i), duration: stamp(i + 1) - stamp(i) });
        this.encoder.encode(vf, { keyFrame: i % this.gop === 0 });
        vf.close();
        if (this.pcm) this.pumpAudio(Math.round(((i + 1) / this.fps) * this.pcm.sampleRate));
        await drainEncoders([this.encoder, this.audioEncoder], [8, 40], () => !!this.failed);
        if (this.failed) throw this.failed;
    }

    /** Resolves to { blob } or { savedToDisk: true }. */
    async finish() {
        await this.encoder.flush();
        if (this.audioEncoder) {
            this.pumpAudio(Infinity);
            await this.audioEncoder.flush();
        }
        this.muxer.finalize();
        this.close();
        if (this.fileStream) {
            await this.fileStream.close();
            return { savedToDisk: true };
        }
        return { blob: new Blob([this.target.buffer], { type: 'video/mp4' }) };
    }

    async abort() {
        this.close();
        if (this.fileStream) {
            try { await this.fileStream.close(); } catch (e) { /* gone */ }
        }
    }

    close() {
        try { this.encoder.close(); } catch (e) { /* closed */ }
        try { this.audioEncoder?.close(); } catch (e) { /* closed */ }
    }
}
