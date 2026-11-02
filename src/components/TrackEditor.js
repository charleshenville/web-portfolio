import React, {
    useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import {
    Play, Pause, Upload, Download, Trash2, Music, Plus, Film, X,
} from 'lucide-react';
import {
    Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget,
} from 'mp4-muxer';
import { Mp4FrameReader } from '../lib/mp4Frames';
import styles from './TrackEditor.module.css';

const PEAKS = 1200;
const ENV_HOP = 0.01; // seconds per envelope sample used for auto-cutting

let nextId = 1;
const uid = () => `n${nextId++}`;
const trackColor = (i) => `hsl(${(i * 67 + 20) % 360}, 55%, 58%)`;
const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

let sharedCtx = null;
async function decodeFile(file) {
    try {
        if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
        const data = await file.arrayBuffer();
        return await sharedCtx.decodeAudioData(data);
    } catch (e) {
        return null; // no audio track, or a codec the browser will not decode
    }
}

function peaksOf(buffer) {
    const ch = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / PEAKS));
    const out = new Float32Array(PEAKS);
    for (let p = 0; p < PEAKS; p++) {
        let m = 0;
        const end = Math.min(ch.length, (p + 1) * step);
        for (let i = p * step; i < end; i++) {
            const v = Math.abs(ch[i]);
            if (v > m) m = v;
        }
        out[p] = m;
    }
    return out;
}

// RMS level every ENV_HOP seconds, for the auto cutter.
function envelopeOf(buffer) {
    const ch = buffer.getChannelData(0);
    const hop = Math.max(1, Math.round(buffer.sampleRate * ENV_HOP));
    const n = Math.floor(ch.length / hop);
    const env = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        let s = 0;
        for (let i = k * hop; i < (k + 1) * hop; i++) s += ch[i] * ch[i];
        env[k] = Math.sqrt(s / hop);
    }
    return env;
}

// Cuts from the soundtrack. 'beats' steps to the next track on every onset
// (a level jump over its own surroundings); 'level' picks the track by how
// loud each stretch is, quietest first.
function autoCuts(env, trackIds, { style, sensitivity, minGap, limit }) {
    const cuts = [];
    if (!env || !trackIds.length) return cuts;
    const end = Math.min(env.length, Math.floor(limit / ENV_HOP));
    if (style === 'level') {
        const win = Math.max(1, Math.round(minGap / ENV_HOP));
        const levels = [];
        for (let s = 0; s < end; s += win) {
            let sum = 0;
            const e = Math.min(end, s + win);
            for (let i = s; i < e; i++) sum += env[i];
            levels.push(sum / (e - s));
        }
        const sorted = levels.slice().sort((a, b) => a - b);
        let prev = -1;
        levels.forEach((lv, w) => {
            const rank = sorted.indexOf(lv) / Math.max(1, sorted.length - 1);
            const idx = Math.min(trackIds.length - 1, Math.floor(rank * trackIds.length));
            if (idx !== prev) {
                cuts.push({ id: uid(), at: w * win * ENV_HOP, track: trackIds[idx] });
                prev = idx;
            }
        });
        return cuts;
    }
    const pre = new Float64Array(end + 1);
    for (let i = 0; i < end; i++) pre[i + 1] = pre[i] + env[i];
    const R = 25;
    const k = 1.6 / Math.max(0.1, sensitivity);
    let last = -Infinity;
    let idx = 0;
    cuts.push({ id: uid(), at: 0, track: trackIds[0] });
    for (let i = 1; i < end - 1; i++) {
        const lo = Math.max(0, i - R);
        const hi = Math.min(end, i + R + 1);
        const mean = (pre[hi] - pre[lo]) / (hi - lo);
        const t = i * ENV_HOP;
        if (env[i] > mean * (1 + k) && env[i] >= env[i - 1] && env[i] > env[i + 1]
            && env[i] > 0.01 && t - last >= minGap) {
            idx = (idx + 1) % trackIds.length;
            cuts.push({ id: uid(), at: t, track: trackIds[idx] });
            last = t;
        }
    }
    return cuts;
}

const Wave = React.memo(({ peaks, color }) => {
    const ref = useRef(null);
    useEffect(() => {
        const c = ref.current;
        if (!c || !peaks) return;
        const w = c.width;
        const h = c.height;
        const g = c.getContext('2d');
        g.clearRect(0, 0, w, h);
        g.fillStyle = color;
        let max = 0.0001;
        for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
        for (let x = 0; x < w; x++) {
            const v = (peaks[Math.floor((x / w) * peaks.length)] / max) * h;
            g.fillRect(x, (h - v) / 2, 1, Math.max(1, v));
        }
    }, [peaks, color]);
    return <canvas ref={ref} className={styles.wave} width={PEAKS} height={40} />;
});

function drawCover(g, src, sw, sh, w, h) {
    const s = Math.max(w / sw, h / sh);
    g.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
}

function TrackEditor() {
    const [tracks, setTracks] = useState([]);
    const [audio, setAudio] = useState(null); // { name, url, buffer, peaks, env }
    const [fps, setFps] = useState(30);
    const [mode, setMode] = useState('manual');
    const [manualCuts, setManualCuts] = useState([]);
    const [auto, setAuto] = useState({ style: 'beats', sensitivity: 1, minGap: 0.5 });
    const [playing, setPlaying] = useState(false);
    const [status, setStatus] = useState('');
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState(0);

    const media = useRef({}); // id -> { video, reader }
    const canvasRef = useRef(null);
    const areaRef = useRef(null);
    const headRef = useRef(null);
    const timeRef = useRef(null);
    const audioElRef = useRef(null);
    const clock = useRef({ t: 0, from: 0, playing: false });
    const cancelRef = useRef(false);
    const exportingRef = useRef(false);

    const total = useMemo(
        () => tracks.reduce((m, t) => Math.max(m, t.offset + t.duration), 0),
        [tracks],
    );
    const size = useMemo(() => {
        const t = tracks[0];
        const ev = (n) => Math.max(2, Math.round(n / 2) * 2);
        return t ? { w: ev(t.w), h: ev(t.h) } : { w: 1280, h: 720 };
    }, [tracks]);

    const autoList = useMemo(() => {
        if (mode !== 'auto' || !audio || !tracks.length) return null;
        return autoCuts(audio.env, tracks.map((t) => t.id), { ...auto, limit: total });
    }, [mode, audio, tracks, auto, total]);

    const cuts = useMemo(
        () => (autoList || manualCuts).slice().sort((a, b) => a.at - b.at),
        [autoList, manualCuts],
    );

    // Everything the render loop and export read, kept current without
    // restarting them.
    const live = useRef({});
    live.current = { tracks, cuts, total, size, audio, fps };

    const trackAt = useCallback((t) => {
        const { tracks: ts, cuts: cs } = live.current;
        if (!ts.length) return null;
        let id = cs.length ? cs[0].track : ts[0].id;
        for (const c of cs) {
            if (c.at <= t) id = c.track;
            else break;
        }
        return ts.find((x) => x.id === id) || ts[0];
    }, []);

    // ---- Importing ---------------------------------------------------------

    const addVideos = async (files) => {
        for (const file of Array.from(files)) {
            const url = URL.createObjectURL(file);
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.src = url;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((res) => {
                video.onloadedmetadata = res;
                video.onerror = res;
            });
            if (!video.videoWidth) {
                URL.revokeObjectURL(url);
                setStatus(`Could not read ${file.name}`);
                continue;
            }
            const id = uid();
            // eslint-disable-next-line no-await-in-loop
            const reader = await Mp4FrameReader.open(url);
            media.current[id] = { video, reader };
            const trackFps = reader ? reader.frameCount / video.duration : 0;
            if (trackFps > 1 && live.current.tracks.length === 0) {
                setFps(Math.round(trackFps * 100) / 100);
            }
            const entry = {
                id, name: file.name, url, duration: video.duration, offset: 0,
                w: video.videoWidth, h: video.videoHeight, fps: trackFps || 0,
                peaks: null,
            };
            setTracks((ts) => ts.concat(entry));
            // eslint-disable-next-line no-await-in-loop
            const buf = await decodeFile(file);
            if (buf) {
                const peaks = peaksOf(buf);
                setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, peaks } : t)));
            }
        }
    };

    const addAudio = async (file) => {
        const buffer = await decodeFile(file);
        if (!buffer) {
            setStatus(`Could not decode ${file.name}`);
            return;
        }
        if (audio) URL.revokeObjectURL(audio.url);
        setAudio({
            name: file.name, url: URL.createObjectURL(file), buffer,
            peaks: peaksOf(buffer), env: envelopeOf(buffer),
        });
        setStatus(buffer.duration > live.current.total && live.current.total
            ? 'Audio is longer than the video and will be cut at the end.' : '');
    };

    const removeTrack = (id) => {
        const m = media.current[id];
        if (m) {
            m.reader?.close();
            URL.revokeObjectURL(m.video.src);
            delete media.current[id];
        }
        const rest = tracks.filter((t) => t.id !== id);
        setTracks(rest);
        setManualCuts((cs) => cs
            .map((c) => (c.track === id ? { ...c, track: rest[0]?.id } : c))
            .filter((c) => c.track));
    };

    const patchTrack = (id, patch) => setTracks(
        (ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );

    const alignAll = (how) => {
        const longest = tracks.reduce((m, t) => Math.max(m, t.duration), 0);
        setTracks((ts) => ts.map((t) => ({
            ...t,
            offset: how === 'start' ? 0
                : how === 'end' ? longest - t.duration : (longest - t.duration) / 2,
        })));
    };

    // ---- Playlist ------------------------------------------------------------

    const cutHere = () => {
        if (!tracks.length) return;
        const now = clock.current.t;
        const cur = trackAt(now);
        const i = tracks.findIndex((t) => t.id === cur.id);
        setManualCuts((cs) => {
            const base = cs.length ? cs : [{ id: uid(), at: 0, track: tracks[0].id }];
            return base.concat({
                id: uid(), at: Math.round(now * 100) / 100,
                track: tracks[(i + 1) % tracks.length].id,
            });
        });
    };

    const patchCut = (id, patch) => setManualCuts(
        (cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );

    const bakeAuto = () => {
        setManualCuts(cuts.map((c) => ({ ...c })));
        setMode('manual');
    };

    // ---- Transport + preview ---------------------------------------------------

    const seek = useCallback((t) => {
        const c = clock.current;
        c.t = Math.max(0, Math.min(live.current.total, t));
        c.from = performance.now();
        c.base = c.t;
        const a = audioElRef.current;
        if (a) {
            const buf = live.current.audio?.buffer;
            try { a.currentTime = Math.min(c.t, buf ? buf.duration : 0); } catch (e) { /* not ready */ }
        }
    }, []);

    const setPlay = useCallback((on) => {
        const c = clock.current;
        c.playing = on;
        c.from = performance.now();
        c.base = c.t;
        setPlaying(on);
        const a = audioElRef.current;
        if (a) {
            if (on && live.current.audio && c.t < live.current.audio.buffer.duration) {
                a.currentTime = c.t;
                a.play().catch(() => {});
            } else a.pause();
        }
        if (!on) Object.values(media.current).forEach((m) => m.video.pause());
    }, []);

    useEffect(() => {
        let raf = 0;
        const loop = () => {
            raf = requestAnimationFrame(loop);
            if (exportingRef.current) return;
            const { total: tot, size: sz } = live.current;
            const c = clock.current;
            if (c.playing) {
                c.t = c.base + (performance.now() - c.from) / 1000;
                if (c.t >= tot) {
                    c.t = tot;
                    setPlay(false);
                }
                const a = audioElRef.current;
                const ab = live.current.audio;
                if (a && ab && c.t >= ab.buffer.duration && !a.paused) a.pause();
            }
            const cv = canvasRef.current;
            const tr = trackAt(c.t);
            if (cv && tr) {
                const m = media.current[tr.id];
                const local = Math.max(0, Math.min(tr.duration - 0.001, c.t - tr.offset));
                const inRange = c.t >= tr.offset && c.t < tr.offset + tr.duration;
                Object.entries(media.current).forEach(([id, mm]) => {
                    if (id !== tr.id && !mm.video.paused) mm.video.pause();
                });
                if (m) {
                    const v = m.video;
                    if (c.playing && inRange) {
                        if (Math.abs(v.currentTime - local) > 0.2) v.currentTime = local;
                        if (v.paused) v.play().catch(() => {});
                    } else {
                        if (!v.paused) v.pause();
                        if (Math.abs(v.currentTime - local) > 0.02) v.currentTime = local;
                    }
                    if (cv.width !== sz.w || cv.height !== sz.h) {
                        cv.width = sz.w;
                        cv.height = sz.h;
                    }
                    if (v.readyState >= 2) {
                        drawCover(cv.getContext('2d'), v, v.videoWidth, v.videoHeight, sz.w, sz.h);
                    }
                }
            }
            if (headRef.current) {
                headRef.current.style.left = `${tot ? (c.t / tot) * 100 : 0}%`;
            }
            if (timeRef.current) {
                timeRef.current.textContent = `${fmt(c.t)} / ${fmt(tot)}`;
            }
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [setPlay, trackAt]);

    useEffect(() => () => {
        Object.values(media.current).forEach((m) => {
            m.reader?.close();
            URL.revokeObjectURL(m.video.src);
        });
    }, []);

    const onScrub = (e) => {
        const r = areaRef.current.getBoundingClientRect();
        const move = (ev) => seek(((ev.clientX - r.left) / r.width) * live.current.total);
        move(e);
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // ---- Export ------------------------------------------------------------------

    const exportMp4 = async () => {
        const { tracks: ts, total: tot, size: sz, audio: au, fps: rate } = live.current;
        if (!ts.length || exportingRef.current) return;
        if (typeof window.VideoEncoder === 'undefined') {
            // eslint-disable-next-line no-alert
            window.alert('MP4 export needs WebCodecs support (Chrome / Edge / recent Safari).');
            return;
        }
        const { w, h } = { w: sz.w, h: sz.h };
        const totalFrames = Math.max(1, Math.floor(tot * rate));
        const bitrate = Math.min(120_000_000, Math.round(w * h * rate * 0.25));

        let fileStream = null;
        if ((bitrate / 8) * (totalFrames / rate) > 500_000_000 && window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: 'edit.mp4',
                    types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
                });
                fileStream = await handle.createWritable();
            } catch (e) { fileStream = null; }
        }

        let codec = null;
        for (const c of ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.64001f', 'avc1.4d0028', 'avc1.42e01e']) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const s = await window.VideoEncoder.isConfigSupported({
                    codec: c, width: w, height: h, bitrate, framerate: rate,
                });
                if (s.supported) { codec = c; break; }
            } catch (e) { /* next */ }
        }
        if (!codec) {
            // eslint-disable-next-line no-alert
            window.alert('No supported H.264 encoder found for this resolution.');
            if (fileStream) await fileStream.close();
            return;
        }

        // Soundtrack, cut to the video's length. Shorter just ends early.
        let pcm = null;
        let audioCodec = null;
        if (au && typeof window.AudioEncoder !== 'undefined') {
            const sr = au.buffer.sampleRate;
            const chans = Math.min(2, au.buffer.numberOfChannels);
            for (const [enc, box] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const s = await window.AudioEncoder.isConfigSupported({
                        codec: enc, sampleRate: sr, numberOfChannels: chans, bitrate: 192_000,
                    });
                    if (s.supported) { audioCodec = [enc, box]; break; }
                } catch (e) { /* next */ }
            }
            if (audioCodec) {
                const len = Math.min(au.buffer.length, Math.round(tot * sr));
                pcm = {
                    sr, chans, len,
                    data: Array.from({ length: chans }, (_, c) => au.buffer.getChannelData(c)),
                };
            }
        }

        exportingRef.current = true;
        cancelRef.current = false;
        setPlay(false);
        setExporting(true);
        setProgress(0);

        const ntsc = Math.abs(rate * 1.001 - Math.round(rate * 1.001)) < 1e-3;
        const timescale = Number.isInteger(rate) ? rate
            : ntsc ? Math.round(rate * 1001) : 90000;
        const target = fileStream
            ? new FileSystemWritableFileStreamTarget(fileStream)
            : new ArrayBufferTarget();
        const muxer = new Muxer({
            target,
            video: { codec: 'avc', width: w, height: h, frameRate: timescale },
            ...(pcm ? {
                audio: { codec: audioCodec[1], numberOfChannels: pcm.chans, sampleRate: pcm.sr },
            } : {}),
            fastStart: fileStream ? false : 'in-memory',
        });
        let failed = null;
        const encoder = new window.VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => { failed = e; },
        });
        encoder.configure({
            codec, width: w, height: h, bitrate, framerate: rate, latencyMode: 'quality',
        });
        let audioEncoder = null;
        if (pcm) {
            audioEncoder = new window.AudioEncoder({
                output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                error: (e) => { failed = e; },
            });
            audioEncoder.configure({
                codec: audioCodec[0], sampleRate: pcm.sr,
                numberOfChannels: pcm.chans, bitrate: 192_000,
            });
        }
        let cursor = 0;
        const pump = (until) => {
            while (pcm && cursor < Math.min(until, pcm.len)) {
                const n = Math.min(1024, pcm.len - cursor);
                const planar = new Float32Array(n * pcm.chans);
                for (let c = 0; c < pcm.chans; c++) {
                    planar.set(pcm.data[c].subarray(cursor, cursor + n), c * n);
                }
                const d = new window.AudioData({
                    format: 'f32-planar', sampleRate: pcm.sr, numberOfFrames: n,
                    numberOfChannels: pcm.chans,
                    timestamp: Math.round((cursor / pcm.sr) * 1e6), data: planar,
                });
                audioEncoder.encode(d);
                d.close();
                cursor += n;
            }
        };

        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const g = cv.getContext('2d', { alpha: false });
        g.imageSmoothingQuality = 'high';
        const seekTo = (v, time) => new Promise((resolve) => {
            if (Math.abs(v.currentTime - time) < 1 / 240 && v.readyState >= 2) { resolve(); return; }
            const done = () => { v.removeEventListener('seeked', done); resolve(); };
            setTimeout(done, 2000);
            v.addEventListener('seeked', done);
            v.currentTime = time;
        });
        const stamp = (i) => Math.round((i * 1_000_000) / rate);
        const gop = Math.max(1, Math.round(rate * 2));
        const seekOnly = new Set(); // tracks whose decoder path failed
        let done = false;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (cancelRef.current || failed) break;
                const t = i / rate;
                const tr = trackAt(t);
                const m = media.current[tr.id];
                const local = Math.max(0, Math.min(tr.duration - 0.001, t - tr.offset));

                let drawn = false;
                if (m.reader && !seekOnly.has(tr.id)) {
                    const idx = Math.round(local * (m.reader.frameCount / tr.duration));
                    // eslint-disable-next-line no-await-in-loop
                    const vf = await m.reader.frame(idx);
                    if (vf) {
                        drawCover(g, vf, vf.displayWidth, vf.displayHeight, w, h);
                        drawn = true;
                    } else seekOnly.add(tr.id);
                }
                if (!drawn) {
                    // eslint-disable-next-line no-await-in-loop
                    await seekTo(m.video, local);
                    drawCover(g, m.video, m.video.videoWidth, m.video.videoHeight, w, h);
                }

                const vf = new window.VideoFrame(cv, {
                    timestamp: stamp(i), duration: stamp(i + 1) - stamp(i),
                });
                encoder.encode(vf, { keyFrame: i % gop === 0 });
                vf.close();
                if (pcm) pump(Math.round(((i + 1) / rate) * pcm.sr));

                while ((encoder.encodeQueueSize > 8
                    || (audioEncoder && audioEncoder.encodeQueueSize > 40)) && !failed) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => {
                        const fin = () => { encoder.removeEventListener('dequeue', fin); r(); };
                        encoder.addEventListener('dequeue', fin);
                        setTimeout(fin, 20);
                    });
                }
                if (i % 5 === 0) setProgress((i + 1) / totalFrames);
            }
            if (!cancelRef.current && !failed) {
                if (pcm) pump(pcm.len);
                await encoder.flush();
                if (audioEncoder) await audioEncoder.flush();
                muxer.finalize();
                done = true;
            }
        } catch (e) {
            failed = e;
        } finally {
            try { encoder.close(); } catch (e) { /* closed */ }
            try { audioEncoder?.close(); } catch (e) { /* closed */ }
            if (fileStream) { try { await fileStream.close(); } catch (e) { /* gone */ } }
            exportingRef.current = false;
            setExporting(false);
            setProgress(0);
        }

        if (done && !fileStream) {
            const url = URL.createObjectURL(new Blob([muxer.target.buffer], { type: 'video/mp4' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'edit.mp4';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } else if (failed) {
            // eslint-disable-next-line no-alert
            window.alert(`Export failed: ${failed.message || failed}`);
        }
        if (done) {
            setStatus(`Exported ${totalFrames} frames (${(totalFrames / rate).toFixed(1)}s) at ${w}x${h}`
                + (pcm ? ' with sound' : ' (silent)'));
        }
    };

    // ---- UI --------------------------------------------------------------------------

    const idxOf = (id) => Math.max(0, tracks.findIndex((t) => t.id === id));
    const pct = (s) => (total ? (s / total) * 100 : 0);

    return (
        <div className={styles.root}>
            <div className={styles.main}>
                <div className={styles.stage}>
                    {tracks.length
                        ? <canvas ref={canvasRef} className={styles.canvas} width={size.w} height={size.h} />
                        : <div className={styles.empty}>Add video tracks to begin</div>}
                </div>

                <div className={styles.transport}>
                    <button
                        type="button"
                        className={styles.btn}
                        disabled={!tracks.length || exporting}
                        onClick={() => {
                            if (!playing && clock.current.t >= total) seek(0);
                            setPlay(!playing);
                        }}
                        aria-label={playing ? 'Pause' : 'Play'}
                    >
                        {playing ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <span ref={timeRef} className={styles.time}>0:00.00 / 0:00.00</span>
                    <span className={styles.hint}>{status}</span>
                </div>

                <div className={styles.timeline}>
                    {tracks.map((t, i) => (
                        <div className={styles.lane} key={t.id}>
                            <span className={styles.laneLabel} style={{ color: trackColor(i) }}>{t.name}</span>
                            <div className={styles.laneArea}>
                                <div
                                    className={styles.clip}
                                    style={{
                                        left: `${pct(t.offset)}%`,
                                        width: `${pct(t.duration)}%`,
                                        borderColor: trackColor(i),
                                    }}
                                >
                                    {t.peaks && <Wave peaks={t.peaks} color={trackColor(i)} />}
                                </div>
                            </div>
                        </div>
                    ))}
                    {audio && (
                        <div className={styles.lane}>
                            <span className={styles.laneLabel}>♪ {audio.name}</span>
                            <div className={styles.laneArea}>
                                <div
                                    className={styles.clip}
                                    style={{ width: `${Math.min(100, pct(audio.buffer.duration))}%` }}
                                >
                                    <Wave peaks={audio.peaks} color="var(--ink)" />
                                </div>
                            </div>
                        </div>
                    )}
                    <div className={styles.lane}>
                        <span className={styles.laneLabel}>Program</span>
                        <div className={styles.laneArea}>
                            {cuts.map((c, k) => {
                                const next = cuts[k + 1] ? cuts[k + 1].at : total;
                                const start = k === 0 ? 0 : c.at;
                                return (
                                    <div
                                        key={c.id}
                                        className={styles.seg}
                                        style={{
                                            left: `${pct(start)}%`,
                                            width: `${pct(Math.max(0, next - start))}%`,
                                            background: trackColor(idxOf(c.track)),
                                        }}
                                    />
                                );
                            })}
                            {!cuts.length && tracks.length > 0 && (
                                <div
                                    className={styles.seg}
                                    style={{ left: 0, width: '100%', background: trackColor(0) }}
                                />
                            )}
                        </div>
                    </div>
                    <div className={styles.scrub}>
                        <div
                            ref={areaRef}
                            className={styles.scrubArea}
                            onPointerDown={onScrub}
                            role="presentation"
                        >
                            <div ref={headRef} className={styles.head} />
                        </div>
                    </div>
                </div>
            </div>

            <aside className={styles.panel}>
                <section className={styles.section}>
                    <h2 className={styles.title}>Tracks</h2>
                    <label className={styles.btn}>
                        <Upload size={13} /> Add videos
                        <input
                            type="file"
                            accept="video/*"
                            multiple
                            hidden
                            onChange={(e) => { addVideos(e.target.files); e.target.value = ''; }}
                        />
                    </label>
                    {tracks.map((t, i) => (
                        <div className={styles.card} key={t.id}>
                            <div className={styles.cardHead}>
                                <Film size={12} style={{ color: trackColor(i) }} />
                                <span className={styles.name} title={t.name}>{t.name}</span>
                                <button type="button" className={styles.icon} onClick={() => removeTrack(t.id)} aria-label="Remove track">
                                    <Trash2 size={12} />
                                </button>
                            </div>
                            <div className={styles.row}>
                                <span>{t.duration.toFixed(2)}s · {t.w}x{t.h}</span>
                                <label className={styles.inline}>
                                    start
                                    <input
                                        type="number"
                                        className={styles.num}
                                        min={0}
                                        step={0.05}
                                        value={t.offset}
                                        onChange={(e) => patchTrack(t.id, { offset: Math.max(0, Number(e.target.value) || 0) })}
                                    />
                                </label>
                            </div>
                        </div>
                    ))}
                    {tracks.length > 1 && (
                        <div className={styles.seg3}>
                            <span>Align</span>
                            {['start', 'center', 'end'].map((a) => (
                                <button key={a} type="button" className={styles.chip} onClick={() => alignAll(a)}>{a}</button>
                            ))}
                        </div>
                    )}
                </section>

                <section className={styles.section}>
                    <h2 className={styles.title}>Audio</h2>
                    {audio ? (
                        <div className={styles.cardHead}>
                            <Music size={12} />
                            <span className={styles.name} title={audio.name}>{audio.name}</span>
                            <button type="button" className={styles.icon} onClick={() => { URL.revokeObjectURL(audio.url); setAudio(null); setMode('manual'); }} aria-label="Remove audio">
                                <X size={12} />
                            </button>
                        </div>
                    ) : (
                        <label className={styles.btn}>
                            <Music size={13} /> Add audio
                            <input
                                type="file"
                                accept="audio/*"
                                hidden
                                onChange={(e) => { if (e.target.files[0]) addAudio(e.target.files[0]); e.target.value = ''; }}
                            />
                        </label>
                    )}
                    {audio && <audio ref={audioElRef} src={audio.url} preload="auto" />}
                    <p className={styles.hint}>This is the sound that plays and exports. Track waveforms are for reference.</p>
                </section>

                <section className={styles.section}>
                    <h2 className={styles.title}>Playlist</h2>
                    <div className={styles.seg3}>
                        <button type="button" className={`${styles.chip} ${mode === 'manual' ? styles.on : ''}`} onClick={() => setMode('manual')}>Manual</button>
                        <button type="button" className={`${styles.chip} ${mode === 'auto' ? styles.on : ''}`} disabled={!audio} onClick={() => setMode('auto')}>Auto</button>
                    </div>
                    {mode === 'auto' && (
                        <>
                            <div className={styles.seg3}>
                                {[['beats', 'On beats'], ['level', 'By loudness']].map(([k, l]) => (
                                    <button key={k} type="button" className={`${styles.chip} ${auto.style === k ? styles.on : ''}`} onClick={() => setAuto({ ...auto, style: k })}>{l}</button>
                                ))}
                            </div>
                            {auto.style === 'beats' && (
                                <label className={styles.row}>
                                    <span>Sensitivity</span>
                                    <input type="range" min={0.3} max={3} step={0.1} value={auto.sensitivity} onChange={(e) => setAuto({ ...auto, sensitivity: Number(e.target.value) })} />
                                </label>
                            )}
                            <label className={styles.row}>
                                <span>{auto.style === 'beats' ? 'Min gap' : 'Window'} {auto.minGap.toFixed(2)}s</span>
                                <input type="range" min={0.1} max={4} step={0.05} value={auto.minGap} onChange={(e) => setAuto({ ...auto, minGap: Number(e.target.value) })} />
                            </label>
                            <button type="button" className={styles.btn} onClick={bakeAuto}>Edit these manually</button>
                        </>
                    )}
                    {mode === 'manual' && (
                        <button type="button" className={styles.btn} disabled={!tracks.length} onClick={cutHere}>
                            <Plus size={13} /> Cut at playhead
                        </button>
                    )}
                    <div className={styles.cuts}>
                        {cuts.map((c) => (
                            <div className={styles.cut} key={c.id}>
                                <input
                                    type="number"
                                    className={styles.num}
                                    min={0}
                                    step={0.05}
                                    value={Math.round(c.at * 100) / 100}
                                    disabled={mode === 'auto'}
                                    onChange={(e) => patchCut(c.id, { at: Math.max(0, Number(e.target.value) || 0) })}
                                />
                                <select
                                    className={styles.select}
                                    value={c.track}
                                    disabled={mode === 'auto'}
                                    style={{ borderColor: trackColor(idxOf(c.track)) }}
                                    onChange={(e) => patchCut(c.id, { track: e.target.value })}
                                >
                                    {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                                {mode === 'manual' && (
                                    <button type="button" className={styles.icon} onClick={() => setManualCuts((cs) => cs.filter((x) => x.id !== c.id))} aria-label="Delete cut">
                                        <X size={12} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                    <p className={styles.hint}>
                        Each cut holds until the next. Where a track does not cover the
                        moment, its first or last frame is held.
                    </p>
                </section>

                <section className={styles.section}>
                    <h2 className={styles.title}>Export</h2>
                    <label className={styles.row}>
                        <span>Frame rate</span>
                        <input type="number" className={styles.num} min={1} max={120} step={0.01} value={fps} onChange={(e) => setFps(Math.max(1, Number(e.target.value) || 30))} />
                    </label>
                    <p className={styles.hint}>{size.w}x{size.h} · {total.toFixed(2)}s</p>
                    {exporting ? (
                        <>
                            <div className={styles.progress}><div style={{ width: `${progress * 100}%` }} /></div>
                            <button type="button" className={styles.btn} onClick={() => { cancelRef.current = true; }}>Cancel</button>
                        </>
                    ) : (
                        <button type="button" className={styles.btn} disabled={!tracks.length} onClick={exportMp4}>
                            <Download size={13} /> Export MP4
                        </button>
                    )}
                </section>
            </aside>
        </div>
    );
}

export default TrackEditor;
