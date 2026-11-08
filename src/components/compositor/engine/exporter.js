// Export: the timeline rendered frame by frame to an MP4, independent of
// how fast it runs. Pictures come from WebCodecs decoders walking each
// clip's file (lib/mp4Frames) rather than from seeking <video> elements;
// every controller and the spectrum are read for the exact frame time, so
// the export is what the preview showed. The program's sound is the same
// offline mix the transport plays.

import * as THREE from 'three';
import {
    Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget,
} from 'mp4-muxer';
import { Mp4FrameReader, drainEncoders } from '../../../lib/mp4Frames';
import { mattesFor } from '../../../lib/scanAssets/roto';
import { programAt, clipSourceTime, clipEnd } from '../model/timeline';
import { makeFrame, resolveTrack } from '../model/resolve';
import { mixProject, mediaUrl, takeBase } from './media';

const SS = 2;

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

/**
 * Render [t0, t1) of `project` through `engine`. `opts`: { scale, quality,
 * fps, t0, t1 }. `onProgress(fraction, label)`; `cancelled()` stops it.
 * Resolves to { blob } (or { savedToDisk: true }), or null if cancelled.
 */
export async function exportProject({
    engine, project, opts, onProgress, cancelled,
}) {
    if (typeof window.VideoEncoder === 'undefined' || typeof window.VideoFrame === 'undefined') {
        throw new Error('MP4 export needs WebCodecs (Chrome, Edge or a recent Safari).');
    }
    const fps = opts.fps || project.output.fps || 30;
    const w = Math.max(2, Math.round((project.output.width * opts.scale) / 2) * 2);
    const h = Math.max(2, Math.round((project.output.height * opts.scale) / 2) * 2);
    const t0 = Math.max(0, opts.t0 || 0);
    const t1 = Math.max(t0 + 1 / fps, opts.t1);
    const total = Math.max(1, Math.round((t1 - t0) * fps));
    const bitrate = Math.min(120_000_000, Math.round(w * h * fps * opts.quality));

    // Long renders stream to disk; the picker must open while the click is fresh.
    let fileStream = null;
    const est = (bitrate / 8) * (total / fps);
    if (est > 500_000_000 && window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: `${project.name || 'compositor'}.mp4`,
                types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
            });
            fileStream = await handle.createWritable();
        } catch (e) { fileStream = null; }
    }

    const codec = await pickCodec(w, h, bitrate, fps);
    if (!codec) throw new Error('No H.264 encoder for this size.');

    onProgress(0, 'Mixing sound…');
    const mix = await mixProject(project);
    let pcm = null;
    if (mix) {
        const rate = mix.sampleRate;
        const from = Math.round(t0 * rate);
        const length = Math.round((t1 - t0) * rate);
        const data = [0, 1].map((c) => {
            const src = mix.getChannelData(Math.min(c, mix.numberOfChannels - 1));
            const out = new Float32Array(length);
            out.set(src.subarray(Math.min(src.length, from), Math.min(src.length, from + length)));
            return out;
        });
        pcm = { data, sampleRate: rate, channels: 2, length };
    }
    const audioCodec = pcm ? await pickAudioCodec(pcm.sampleRate, pcm.channels) : null;

    // Decoders for every picture the range needs.
    onProgress(0, 'Opening footage…');
    const media = new Map(project.media.map((m) => [m.id, m]));
    const used = new Map();
    project.clips.forEach((c) => {
        const m = media.get(c.mediaId);
        const tr = project.tracks.find((t) => t.id === c.trackId);
        if (!m || tr?.kind !== 'video' || m.kind === 'stage') return;
        if (clipEnd(c) <= t0 || c.start >= t1) return;
        const u = used.get(m.id) || { media: m, back: false };
        if (c.loop === 'bounce') u.back = true;
        used.set(m.id, u);
    });
    const readers = new Map();
    await Promise.all(Array.from(used.values()).map(async (u) => {
        const url = await mediaUrl(u.media);
        const fwd = url ? await Mp4FrameReader.open(url) : null;
        const rev = fwd && u.back && u.media.kind === 'take' ? await Mp4FrameReader.open(`${takeBase(u.media.src.take)}_rev.mp4`) : null;
        // Made on the first decoded picture: three uploads a VideoFrame only
        // through a VideoTexture.
        readers.set(u.media.id, { fwd, rev, tex: null, el: null });
    }));

    // Screens decode their own pictures.
    const adapters = [];
    engine.scenes.forEach((s) => s.adapters.forEach((a) => { if (a.openExport) adapters.push(a); }));
    await Promise.all(adapters.map((a) => a.openExport()));

    const ntsc = Math.abs(fps * 1.001 - Math.round(fps * 1.001)) < 1e-3;
    const timescale = Number.isInteger(fps) ? fps : ntsc ? Math.round(fps * 1001) : 90000;
    const target = fileStream ? new FileSystemWritableFileStreamTarget(fileStream) : new ArrayBufferTarget();
    const muxer = new Muxer({
        target,
        video: { codec: 'avc', width: w, height: h, frameRate: timescale },
        ...(audioCodec ? { audio: { codec: audioCodec[1], numberOfChannels: pcm.channels, sampleRate: pcm.sampleRate } } : {}),
        fastStart: fileStream ? false : 'in-memory',
    });
    let failed = null;
    const encoder = new window.VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { failed = e; },
    });
    encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' });
    let audioEncoder = null;
    if (audioCodec) {
        audioEncoder = new window.AudioEncoder({
            output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
            error: (e) => { failed = e; },
        });
        audioEncoder.configure({ codec: audioCodec[0], sampleRate: pcm.sampleRate, numberOfChannels: pcm.channels, bitrate: 192000 });
    }
    let audioCursor = 0;
    const pumpAudio = (until) => {
        if (!audioEncoder) return;
        while (audioCursor < Math.min(until, pcm.length)) {
            const n = Math.min(1024, pcm.length - audioCursor);
            const planar = new Float32Array(n * pcm.channels);
            for (let c = 0; c < pcm.channels; c++) planar.set(pcm.data[c].subarray(audioCursor, audioCursor + n), c * n);
            const data = new window.AudioData({
                format: 'f32-planar', sampleRate: pcm.sampleRate, numberOfFrames: n, numberOfChannels: pcm.channels,
                timestamp: Math.round((audioCursor / pcm.sampleRate) * 1e6), data: planar,
            });
            audioEncoder.encode(data);
            data.close();
            audioCursor += n;
        }
    };

    const ss = w * h <= 3_600_000 ? SS : 1;
    const down = document.createElement('canvas');
    down.width = w;
    down.height = h;
    const downCtx = down.getContext('2d', { alpha: false });
    downCtx.imageSmoothingEnabled = true;
    downCtx.imageSmoothingQuality = 'high';

    engine.beginExport(w * ss, h * ss, ss);
    const stamp = (i) => Math.round((i * 1_000_000) / fps);
    const gop = Math.max(1, Math.round(fps * 2));
    let started = 0;
    let lastReport = 0;
    let done = false;
    const isFailed = () => !!failed;
    try {
        for (let i = 0; i < total; i++) {
            if (cancelled() || failed) break;
            const t = t0 + i / fps;
            const frame = makeFrame(project, t, engine.analysis);
            const prog = programAt(project, t, (tr) => resolveTrack(tr, frame).visible !== false);
            const shown = [prog.base, ...prog.overlays].filter((x) => x && x.media.kind !== 'stage');
            const ready = new Map();
            for (const x of shown) {
                const r = readers.get(x.media.id);
                const st = clipSourceTime(x.clip, x.media, t);
                if (!r || !st) continue;
                let vf = null;
                if (r.fwd) {
                    if (st.dir < 0 && r.rev) {
                        const nF = r.fwd.frameCount;
                        const nR = r.rev.frameCount;
                        const k = r.fwd.indexAt(st.time);
                        const xr = nF > 1 ? (k * (nR - 1)) / (nF - 1) : 0;
                        // eslint-disable-next-line no-await-in-loop
                        vf = await r.rev.frame(Math.max(0, Math.min(nR - 1, nR - 1 - Math.round(xr))));
                    } else {
                        // eslint-disable-next-line no-await-in-loop
                        vf = await r.fwd.frameAt(st.time);
                    }
                }
                if (vf) {
                    if (!r.tex) {
                        r.tex = new THREE.VideoTexture(vf);
                        r.tex.colorSpace = THREE.SRGBColorSpace;
                        r.tex.minFilter = THREE.LinearFilter;
                        r.tex.magFilter = THREE.LinearFilter;
                    }
                    r.tex.image = vf;
                    r.tex.needsUpdate = true;
                    ready.set(x.media.id, r.tex);
                } else {
                    // No decoder for this file: seek the preview's element.
                    const it = engine.pool.get(x.media);
                    if (it) {
                        // eslint-disable-next-line no-await-in-loop
                        await new Promise((res) => {
                            if (Math.abs(it.el.currentTime - st.time) < 1 / 240 && it.el.readyState >= 2) { res(); return; }
                            const tm = setTimeout(res, 2000);
                            it.el.addEventListener('seeked', () => { clearTimeout(tm); res(); }, { once: true });
                            it.el.currentTime = st.time;
                        });
                        it.tex.needsUpdate = true;
                        ready.set(x.media.id, it.tex);
                    }
                }
            }
            // Mattes on their exact frame.
            const base = prog.base;
            if (base?.media.kind === 'take') {
                const scene = project.scenes.find((s) => s.take === base.media.src.take);
                const rig = engine.rig(scene?.id);
                const takeObj = project.objects.find((o) => o.sceneId === scene?.id && o.type === 'take');
                if (rig?.track && !rig.track.unsolved && takeObj?.params.mattesOn !== false) {
                    const st = clipSourceTime(base.clip, base.media, t);
                    const hold = takeObj.extra?.matteHoldout || {};
                    const ids = mattesFor(scene.take).map((m) => m.id).filter((id) => hold[id] !== false);
                    project.objects.forEach((o) => { if (o.sceneId === scene.id && o.type === 'window' && o.params.matte) ids.push(o.params.matte); });
                    if (ids.length && st) {
                        engine.mattes.set(scene.take, mattesFor(scene.take));
                        const idx = Math.max(0, Math.min(rig.track.frame_count - 1, Math.floor(st.time * rig.track.fps + 1e-3)));
                        // eslint-disable-next-line no-await-in-loop
                        await engine.mattes.exact(Array.from(new Set(ids)), idx, st.dir < 0);
                    }
                }
            }
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(adapters.map((a) => a.exportFrame(t)));

            engine.renderAt(t, { dt: i ? 1 / fps : 0, playing: true, exporting: true, exportFrame: (id) => ready.get(id) || null });

            downCtx.drawImage(engine.renderer.domElement, 0, 0, w, h);
            const vfOut = new window.VideoFrame(down, { timestamp: stamp(i), duration: stamp(i + 1) - stamp(i) });
            encoder.encode(vfOut, { keyFrame: i % gop === 0 });
            vfOut.close();
            if (pcm) pumpAudio(Math.round(((i + 1) / fps) * pcm.sampleRate));
            // eslint-disable-next-line no-await-in-loop
            await drainEncoders([encoder, audioEncoder], [8, 40], isFailed);

            const now = performance.now();
            if (i === 0) started = now;
            if (i > 0 && now - lastReport > 250) {
                lastReport = now;
                const rate = i / Math.max(0.001, (now - started) / 1000);
                onProgress((i + 1) / total, `Rendering ${i + 1}/${total} · ${rate.toFixed(0)} fps · ${Math.ceil((total - i - 1) / rate)}s left`);
            }
        }
        done = !cancelled() && !failed;
        if (done) {
            onProgress(1, 'Finishing…');
            await encoder.flush();
            if (audioEncoder) { pumpAudio(Infinity); await audioEncoder.flush(); }
            muxer.finalize();
        }
    } finally {
        engine.endExport();
        try { encoder.close(); } catch (e) { /* closed */ }
        try { audioEncoder?.close(); } catch (e) { /* closed */ }
        readers.forEach((r) => { r.fwd?.close(); r.rev?.close(); r.tex?.dispose(); });
        adapters.forEach((a) => a.closeExport());
    }
    if (failed) throw failed;
    if (!done) { if (fileStream) await fileStream.close(); return null; }
    if (fileStream) { await fileStream.close(); return { savedToDisk: true }; }
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }) };
}
