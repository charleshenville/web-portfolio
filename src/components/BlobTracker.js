import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SlidersHorizontal, X, Film, Upload, Download } from 'lucide-react';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import VfxNumberField from './VfxNumberField';
import styles from './vfx.module.css';

// Width (px) of the downscaled frame the detector runs on. Small enough to
// flood-fill every animation frame, large enough to resolve separate blobs.
const ANALYSIS_WIDTH = 220;

const DEFAULTS = {
    // Detection
    threshold: 70,      // luma cutoff (0-255)
    invert: false,      // track dark blobs on light footage instead
    minArea: 10,        // min blob size, in analysis-grid pixels
    maxBoxes: 12,
    smoothing: 0.65,    // 0 = raw boxes, ->1 = heavily damped
    // Appearance
    boxStyle: 'corners', // 'corners' | 'box' | 'cross'
    boxColor: '#f2f0e6',
    labelColor: '#2b4bdf',
    labelTextColor: '#ffffff',
    connectionColor: '#e8c56a',
    lineWidth: 2,
    boxOpacity: 0.9,
    borderRadius: 4,
    glow: 0,
    blur: 0,
    showLabels: true,
    showConnections: false,
    connectionCurve: 0.3,   // 0 = straight lines, 1 = strongly bowed
    connectionShuffle: 0,   // seconds of video time between re-pairings (0 = never)
};

const EXPORT_SCALES = [
    { id: 1, name: '1x' },
    { id: 2, name: '2x' },
    { id: 3, name: '3x' },
    { id: 4, name: '4x' },
];

// Threshold the frame on luminance, then group lit pixels into connected
// components (8-connectivity, iterative flood fill). Returns the largest
// components as {x, y, w, h, area, cx, cy} in analysis-grid coordinates.
function detectBlobs(data, w, h, s) {
    const n = w * h;
    const mask = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
        const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
        mask[i] = (s.invert ? lum < s.threshold : lum > s.threshold) ? 1 : 0;
    }

    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    const blobs = [];

    for (let i = 0; i < n; i++) {
        if (!mask[i] || visited[i]) continue;
        let top = 0;
        stack[top++] = i;
        visited[i] = 1;
        let minX = w, minY = h, maxX = 0, maxY = 0, area = 0, sumX = 0, sumY = 0;

        while (top > 0) {
            const idx = stack[--top];
            const x = idx % w;
            const y = (idx / w) | 0;
            area++;
            sumX += x;
            sumY += y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= w) continue;
                    const nIdx = ny * w + nx;
                    if (mask[nIdx] && !visited[nIdx]) {
                        visited[nIdx] = 1;
                        stack[top++] = nIdx;
                    }
                }
            }
        }

        if (area >= s.minArea) {
            blobs.push({
                x: minX, y: minY,
                w: maxX - minX + 1, h: maxY - minY + 1,
                area, cx: sumX / area, cy: sumY / area,
            });
        }
    }

    blobs.sort((a, b) => b.area - a.area);
    return blobs.slice(0, s.maxBoxes);
}

// Greedy nearest-centroid matching between last frame's tracks and this
// frame's detections. Matched tracks keep their id (stable labels) and get
// lerped toward the new box; unmatched tracks survive a few frames so
// momentary detection dropouts don't flicker.
function updateTracks(tracks, blobs, nextIdRef, s, maxDist) {
    const used = new Set();
    const alive = [];
    const k = 1 - Math.min(0.95, Math.max(0, s.smoothing));

    for (const t of tracks) {
        let best = -1;
        let bestD = maxDist;
        for (let j = 0; j < blobs.length; j++) {
            if (used.has(j)) continue;
            const d = Math.hypot(blobs[j].cx - t.cx, blobs[j].cy - t.cy);
            if (d < bestD) { bestD = d; best = j; }
        }
        if (best >= 0) {
            used.add(best);
            const b = blobs[best];
            t.x += (b.x - t.x) * k;
            t.y += (b.y - t.y) * k;
            t.w += (b.w - t.w) * k;
            t.h += (b.h - t.h) * k;
            t.cx += (b.cx - t.cx) * k;
            t.cy += (b.cy - t.cy) * k;
            t.missed = 0;
            alive.push(t);
        } else {
            t.missed++;
            if (t.missed < 8) alive.push(t);
        }
    }

    for (let j = 0; j < blobs.length; j++) {
        if (used.has(j)) continue;
        const b = blobs[j];
        alive.push({ id: nextIdRef.current++, ...b, missed: 0 });
    }

    return alive;
}

// Random pairing of visible tracks: each box connects to at most one random
// partner. Pairs persist while both tracks are alive so lines don't flicker;
// newly unpaired boxes get shuffled together each frame. `state` is
// { pairs: [{a, b, bend}], lastShuffle } and `now` is the video time (s):
// when connectionShuffle > 0, all pairs are re-drawn from scratch every
// `connectionShuffle` seconds of playback. `bend` (+1/-1) picks which side a
// curved connection bows toward and stays fixed for the pair's lifetime.
function updateConnections(state, tracks, s, now) {
    if (s.connectionShuffle > 0) {
        if (now < state.lastShuffle) state.lastShuffle = now; // looped / rewound
        if (now - state.lastShuffle >= s.connectionShuffle) {
            state.pairs = [];
            state.lastShuffle = now;
        }
    }

    const ids = tracks.filter((t) => t.missed < 3).map((t) => t.id);
    const idSet = new Set(ids);
    const kept = state.pairs.filter((p) => idSet.has(p.a) && idSet.has(p.b));

    const paired = new Set();
    for (const p of kept) { paired.add(p.a); paired.add(p.b); }
    const free = ids.filter((id) => !paired.has(id));

    for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = free[i];
        free[i] = free[j];
        free[j] = tmp;
    }
    for (let i = 0; i + 1 < free.length; i += 2) {
        kept.push({ a: free[i], b: free[i + 1], bend: Math.random() < 0.5 ? 1 : -1 });
    }

    state.pairs = kept;
}

function roundedRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

// Renders tracks + connections onto a canvas of vw x vh pixels. Does NOT
// clear first, so it can composite over an already-drawn video frame (export).
// sxy scales analysis-grid coords up to output pixels; `u` scales stroke
// widths, radii and label text with the output resolution, which keeps the
// overlay crisp when rendering at upscaled resolutions.
function drawOverlay(ctx, vw, vh, aw, ah, tracks, pairs, s) {
    const sx = vw / aw;
    const sy = vh / ah;
    const u = Math.max(0.75, vw / 1280);
    const lw = Math.max(1, s.lineWidth * u);
    const fontPx = Math.round(11 * u);
    const radius = Math.max(0, s.borderRadius) * u;
    const glow = Math.max(0, s.glow) * u;
    ctx.font = `${fontPx}px "SF Mono", ui-monospace, Menlo, Monaco, monospace`;
    ctx.filter = s.blur > 0 ? `blur(${s.blur * u}px)` : 'none';

    const setGlow = (color) => {
        if (glow > 0) {
            ctx.shadowBlur = glow;
            ctx.shadowColor = color;
        } else {
            ctx.shadowBlur = 0;
        }
    };

    if (s.showConnections && pairs.length > 0) {
        const byId = new Map();
        for (const t of tracks) byId.set(t.id, t);
        const curve = Math.max(0, s.connectionCurve || 0);
        ctx.globalAlpha = s.boxOpacity;
        ctx.strokeStyle = s.connectionColor;
        ctx.lineWidth = Math.max(1, lw * 0.8);
        setGlow(s.connectionColor);
        ctx.beginPath();
        for (const pair of pairs) {
            const a = byId.get(pair.a);
            const b = byId.get(pair.b);
            if (!a || !b || a.missed >= 3 || b.missed >= 3) continue;
            const x1 = a.cx * sx, y1 = a.cy * sy;
            const x2 = b.cx * sx, y2 = b.cy * sy;
            ctx.moveTo(x1, y1);
            if (curve > 0) {
                // Control point offset perpendicular to the segment midpoint;
                // bend keeps each pair bowing to a consistent side.
                const px = (x1 + x2) / 2 - (y2 - y1) * curve * 0.5 * pair.bend;
                const py = (y1 + y2) / 2 + (x2 - x1) * curve * 0.5 * pair.bend;
                ctx.quadraticCurveTo(px, py, x2, y2);
            } else {
                ctx.lineTo(x2, y2);
            }
        }
        ctx.stroke();
    }

    for (const t of tracks) {
        if (t.missed >= 3) continue;

        const pad = 3 * u;
        const x = t.x * sx - pad;
        const y = t.y * sy - pad;
        const w = t.w * sx + pad * 2;
        const h = t.h * sy + pad * 2;
        const cx = t.cx * sx;
        const cy = t.cy * sy;

        ctx.globalAlpha = s.boxOpacity;
        ctx.strokeStyle = s.boxColor;
        ctx.lineWidth = lw;
        setGlow(s.boxColor);

        if (s.boxStyle === 'box') {
            roundedRectPath(ctx, x, y, w, h, radius);
            ctx.stroke();
        } else if (s.boxStyle === 'corners') {
            const cl = Math.max(5 * u, Math.min(w, h) * 0.26);
            ctx.beginPath();
            ctx.moveTo(x, y + cl); ctx.lineTo(x, y); ctx.lineTo(x + cl, y);
            ctx.moveTo(x + w - cl, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cl);
            ctx.moveTo(x + w, y + h - cl); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - cl, y + h);
            ctx.moveTo(x + cl, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - cl);
            ctx.stroke();
        } else {
            const r = 6 * u;
            ctx.beginPath();
            ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
            ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
            ctx.stroke();
        }

        if (s.showLabels) {
            const text = `${Math.round(cx)}, ${Math.round(cy)}`;
            const tw = ctx.measureText(text).width;
            const pillW = tw + 10 * u;
            const pillH = fontPx + 7 * u;
            let px = Math.min(Math.max(2, x), vw - pillW - 2);
            let py = y - pillH - 4 * u;
            if (py < 2) py = y + 4 * u;

            ctx.fillStyle = s.labelColor;
            setGlow(s.labelColor);
            roundedRectPath(ctx, px, py, pillW, pillH, Math.min(radius, pillH / 2));
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = Math.max(1, u);
            ctx.stroke();
            ctx.fillStyle = s.labelTextColor;
            ctx.textBaseline = 'middle';
            ctx.fillText(text, px + 5 * u, py + pillH / 2 + u * 0.5);
        }
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.filter = 'none';
}

function formatTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function BlobTracker() {
    const [videoUrl, setVideoUrl] = useState(null);
    const [fileName, setFileName] = useState('');
    const [isPlaying, setIsPlaying] = useState(false);
    const [loop, setLoop] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [menuOpen, setMenuOpen] = useState(true);
    const [dragOver, setDragOver] = useState(false);
    const [settings, setSettings] = useState(DEFAULTS);

    // Export
    const [exportScale, setExportScale] = useState(1);
    const [exportFps, setExportFps] = useState(30);
    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);

    const videoRef = useRef(null);
    const overlayRef = useRef(null);
    const fileInputRef = useRef(null);
    const settingsRef = useRef(settings);
    const tracksRef = useRef([]);
    const connStateRef = useRef({ pairs: [], lastShuffle: 0 });
    const nextIdRef = useRef(1);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    useEffect(() => { settingsRef.current = settings; }, [settings]);

    const set = (key) => (value) => setSettings((prev) => ({ ...prev, [key]: value }));

    const loadFile = useCallback((file) => {
        if (!file) return;
        const ok = /\.(mp4|mov|m4v|webm)$/i.test(file.name) || file.type.startsWith('video/');
        if (!ok) return;
        setVideoUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(file);
        });
        tracksRef.current = [];
        connStateRef.current = { pairs: [], lastShuffle: 0 };
        nextIdRef.current = 1;
        setFileName(file.name);
        setCurrentTime(0);
        setDuration(0);
    }, []);

    useEffect(() => () => {
        if (videoUrl) URL.revokeObjectURL(videoUrl);
    }, [videoUrl]);

    // Stop any in-flight export if the component unmounts.
    useEffect(() => () => {
        exportCanceledRef.current = true;
    }, []);

    // Detection + draw loop. Runs while a video is loaded (even when paused,
    // so settings changes update the overlay live on a still frame). Paused
    // during export: the export loop takes over detection + screen drawing.
    useEffect(() => {
        if (!videoUrl) return undefined;
        const video = videoRef.current;
        const overlay = overlayRef.current;
        const proc = document.createElement('canvas');
        const pctx = proc.getContext('2d', { willReadFrequently: true });
        const octx = overlay.getContext('2d');
        let raf;

        const tick = () => {
            raf = requestAnimationFrame(tick);
            if (exportingRef.current) return;
            if (!video || video.readyState < 2 || !video.videoWidth) return;

            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const aw = ANALYSIS_WIDTH;
            const ah = Math.max(2, Math.round((aw * vh) / vw));
            if (proc.width !== aw || proc.height !== ah) { proc.width = aw; proc.height = ah; }
            if (overlay.width !== vw || overlay.height !== vh) { overlay.width = vw; overlay.height = vh; }

            pctx.drawImage(video, 0, 0, aw, ah);
            let frame;
            try {
                frame = pctx.getImageData(0, 0, aw, ah);
            } catch (e) {
                return; // tainted / not yet decodable frame
            }

            const s = settingsRef.current;
            const blobs = detectBlobs(frame.data, aw, ah, s);
            tracksRef.current = updateTracks(tracksRef.current, blobs, nextIdRef, s, aw * 0.18);
            updateConnections(connStateRef.current, tracksRef.current, s, video.currentTime);
            octx.clearRect(0, 0, vw, vh);
            drawOverlay(octx, vw, vh, aw, ah, tracksRef.current, connStateRef.current.pairs, s);
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [videoUrl]);

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video || isExporting) return;
        if (video.paused) video.play(); else video.pause();
    };

    const seek = (t) => {
        const video = videoRef.current;
        if (!video || isExporting) return;
        video.currentTime = t;
        setCurrentTime(t);
    };

    // ---- Export ----------------------------------------------------------
    // Frame-accurate MP4 export: seeks the video one frame at a time, runs
    // the exact same detection + overlay pipeline as the live viewer, and
    // encodes each composited frame with WebCodecs (H.264, high bitrate) into
    // an mp4. No frames are dropped and nothing depends on realtime playback,
    // so the result is neither laggy nor lossy. At upscaled resolutions the
    // overlay is drawn after the upscale so boxes and labels stay sharp.
    const startExport = useCallback(async () => {
        const video = videoRef.current;
        if (!video || !video.videoWidth || exportingRef.current) return;
        if (typeof window.VideoEncoder === 'undefined' || typeof window.VideoFrame === 'undefined') {
            // eslint-disable-next-line no-alert
            window.alert('MP4 export needs WebCodecs support (Chrome / Edge / recent Safari).');
            return;
        }

        const scale = exportScale;
        const fps = Math.max(1, Math.min(120, Math.round(exportFps)));
        const w = Math.max(2, Math.round((video.videoWidth * scale) / 2) * 2);
        const h = Math.max(2, Math.round((video.videoHeight * scale) / 2) * 2);
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;

        // Pick the strongest supported AVC profile/level for this resolution.
        const codecCandidates = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.64001f', 'avc1.4d0028', 'avc1.42e01e'];
        // ~0.25 bits/pixel keeps even busy footage visually transparent.
        const bitrate = Math.min(80_000_000, Math.round(w * h * fps * 0.25));
        let codec = null;
        for (const c of codecCandidates) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const support = await window.VideoEncoder.isConfigSupported({
                    codec: c, width: w, height: h, bitrate, framerate: fps,
                });
                if (support.supported) { codec = c; break; }
            } catch (e) { /* try next */ }
        }
        if (!codec) {
            // eslint-disable-next-line no-alert
            window.alert('No supported H.264 encoder found for this resolution.');
            return;
        }

        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportProgress(0);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const proc = document.createElement('canvas');
        const pctx = proc.getContext('2d', { willReadFrequently: true });

        const overlay = overlayRef.current;
        const octx = overlay ? overlay.getContext('2d') : null;

        const prevLoop = video.loop;
        const prevTime = video.currentTime;
        video.loop = false;
        video.pause();
        setIsPlaying(false);

        const seekTo = (t) => new Promise((resolve) => {
            if (Math.abs(video.currentTime - t) < 1 / 240 && video.readyState >= 2) {
                resolve();
                return;
            }
            let timer = null;
            const onSeeked = () => {
                clearTimeout(timer);
                video.removeEventListener('seeked', onSeeked);
                resolve();
            };
            timer = setTimeout(onSeeked, 2000); // fail-safe
            video.addEventListener('seeked', onSeeked);
            video.currentTime = t;
        });

        const muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: { codec: 'avc', width: w, height: h, frameRate: fps },
            fastStart: 'in-memory',
        });

        let encodeFailed = null;
        const encoder = new window.VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => { encodeFailed = e; },
        });
        encoder.configure({
            codec,
            width: w,
            height: h,
            bitrate,
            framerate: fps,
            latencyMode: 'quality',
        });

        // Fresh tracking state so ids / pairs are deterministic from frame 0.
        let tracks = [];
        const connState = { pairs: [], lastShuffle: 0 };
        const nextId = { current: 1 };
        const totalFrames = Math.max(1, Math.round(duration * fps));
        const frameUs = Math.round(1_000_000 / fps);
        let completed = false;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || encodeFailed) break;

                const t = Math.min(i / fps, Math.max(0, duration - 0.001));
                // eslint-disable-next-line no-await-in-loop
                await seekTo(t);

                const aw = ANALYSIS_WIDTH;
                const ah = Math.max(2, Math.round((aw * video.videoHeight) / video.videoWidth));
                if (proc.width !== aw || proc.height !== ah) { proc.width = aw; proc.height = ah; }

                pctx.drawImage(video, 0, 0, aw, ah);
                const frame = pctx.getImageData(0, 0, aw, ah);

                const s = settingsRef.current;
                const blobs = detectBlobs(frame.data, aw, ah, s);
                tracks = updateTracks(tracks, blobs, nextId, s, aw * 0.18);
                updateConnections(connState, tracks, s, t);

                // Upscale the footage first, then render the overlay on top
                // at the export resolution so it stays sharp.
                ctx.drawImage(video, 0, 0, w, h);
                drawOverlay(ctx, w, h, aw, ah, tracks, connState.pairs, s);

                // Mirror onto the on-screen overlay so the export is visible.
                if (octx && overlay.width && overlay.height) {
                    octx.clearRect(0, 0, overlay.width, overlay.height);
                    drawOverlay(octx, overlay.width, overlay.height, aw, ah, tracks, connState.pairs, s);
                }

                const vf = new window.VideoFrame(canvas, {
                    timestamp: i * frameUs,
                    duration: frameUs,
                });
                encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
                vf.close();

                // Backpressure: don't let the encode queue run away.
                while (encoder.encodeQueueSize > 8 && !encodeFailed) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 5));
                }

                if (i % 3 === 0) setExportProgress((i + 1) / totalFrames);
            }

            if (!exportCanceledRef.current && !encodeFailed) {
                setExportProgress(1);
                await encoder.flush();
                muxer.finalize();
                completed = true;
            }
        } catch (e) {
            encodeFailed = e;
        } finally {
            try { encoder.close(); } catch (e) { /* already closed */ }
            video.loop = prevLoop;
            try { video.currentTime = prevTime; } catch (e) { /* ignore */ }
            exportingRef.current = false;
            setIsExporting(false);
            setExportProgress(0);
        }

        if (completed) {
            const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const base = (fileName || 'video').replace(/\.[^.]+$/, '');
            const a = document.createElement('a');
            a.href = url;
            a.download = `${base}_tracked_${w}x${h}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        } else if (encodeFailed && !exportCanceledRef.current) {
            console.error('Export failed:', encodeFailed);
            // eslint-disable-next-line no-alert
            window.alert('Video export failed. See the console for details.');
        }
    }, [exportScale, exportFps, fileName]);

    const cancelExport = useCallback(() => {
        exportCanceledRef.current = true;
    }, []);

    // ---- UI helpers --------------------------------------------------------

    const sliderRow = (label, key, min, max, step) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={settings[key]}
                onChange={(e) => set(key)(parseFloat(e.target.value))}
            />
            <VfxNumberField
                value={settings[key]}
                min={min}
                max={max}
                step={step}
                onCommit={(n) => set(key)(n)}
            />
        </div>
    );

    const switchRow = (label, key) => (
        <div
            className={styles.vfx_checkRow}
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => set(key)(!settings[key])}
            onKeyDown={(e) => { if (e.key === 'Enter') set(key)(!settings[key]); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${settings[key] ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );

    const colorRow = (label, key) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="color"
                className={styles.vfx_color}
                style={{ gridColumn: '2 / 4' }}
                value={settings[key]}
                onChange={(e) => set(key)(e.target.value)}
            />
        </div>
    );

    return (
        <div className={styles.vfx}>
            <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"
                style={{ display: 'none' }}
                onChange={(e) => { loadFile(e.target.files[0]); e.target.value = ''; }}
            />

            <div className={styles.vfx_stage}>
                {videoUrl ? (
                    <div className={styles.vfx_videoWrap}>
                        <video
                            ref={videoRef}
                            className={styles.vfx_video}
                            src={videoUrl}
                            muted
                            playsInline
                            autoPlay
                            loop={loop}
                            onClick={togglePlay}
                            onPlay={() => setIsPlaying(true)}
                            onPause={() => setIsPlaying(false)}
                            onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                            onLoadedMetadata={(e) => setDuration(e.target.duration)}
                        />
                        <canvas ref={overlayRef} className={styles.vfx_overlay} />
                    </div>
                ) : (
                    <div
                        className={`${styles.vfx_drop} ${dragOver ? styles.vfx_dropActive : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => fileInputRef.current.click()}
                        onKeyDown={(e) => { if (e.key === 'Enter') fileInputRef.current.click(); }}
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                            loadFile(e.dataTransfer.files[0]);
                        }}
                    >
                        <Film size={28} strokeWidth={1.25} style={{ opacity: 0.7 }} />
                        <div className={styles.vfx_dropTitle}>Drop Video</div>
                        <div className={styles.vfx_dropSub}>.mp4 / .mov — or click to browse</div>
                    </div>
                )}
            </div>

            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    className={`${styles.vfx_toggle} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {menuOpen && (
                <div className={styles.vfx_panel}>
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Blob Tracker</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Source */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Source</div>
                        <div className={styles.vfx_playRow}>
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                disabled={isExporting}
                                onClick={() => fileInputRef.current.click()}
                            >
                                <Upload size={13} />
                                {videoUrl ? 'Change Video' : 'Upload Video'}
                            </button>
                        </div>
                        {fileName && <div className={styles.vfx_fileName} title={fileName}>{fileName}</div>}
                    </div>

                    {/* Playback */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Playback</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 10 }}>
                            <button
                                type="button"
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                className={styles.vfx_iconBtn}
                                onClick={togglePlay}
                                disabled={!videoUrl || isExporting}
                                style={{ width: 34, height: 34, flex: '0 0 auto' }}
                            >
                                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <input
                                type="range"
                                className={styles.vfx_slider}
                                min={0}
                                max={duration || 0}
                                step={0.01}
                                value={Math.min(currentTime, duration || 0)}
                                disabled={!videoUrl || isExporting}
                                onChange={(e) => seek(parseFloat(e.target.value))}
                            />
                            <span className={styles.vfx_value} style={{ flex: '0 0 auto' }}>
                                {formatTime(currentTime)} / {formatTime(duration)}
                            </span>
                        </div>
                        <div
                            className={styles.vfx_checkRow}
                            role="button"
                            tabIndex={0}
                            onClick={() => { if (!isExporting) setLoop(!loop); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !isExporting) setLoop(!loop); }}
                        >
                            <span>Loop</span>
                            <span className={`${styles.vfx_switch} ${loop ? styles.vfx_switchOn : ''}`}>
                                <span className={styles.vfx_knob} />
                            </span>
                        </div>
                    </div>

                    {/* Detection */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Detection</div>
                        {sliderRow('Threshold', 'threshold', 0, 255, 1)}
                        {sliderRow('Min Size', 'minArea', 1, 120, 1)}
                        {sliderRow('Max Boxes', 'maxBoxes', 1, 30, 1)}
                        {sliderRow('Smoothing', 'smoothing', 0, 0.95, 0.01)}
                        {switchRow('Track Dark', 'invert')}
                    </div>

                    {/* Appearance */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Appearance</div>
                        <div className={styles.vfx_segRow}>
                            {[['corners', 'Corners'], ['box', 'Box'], ['cross', 'Cross']].map(([id, name]) => (
                                <button
                                    type="button"
                                    key={id}
                                    className={`${styles.vfx_segBtn} ${settings.boxStyle === id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => set('boxStyle')(id)}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                        {sliderRow('Line Width', 'lineWidth', 1, 6, 0.5)}
                        {sliderRow('Opacity', 'boxOpacity', 0.1, 1, 0.05)}
                        {sliderRow('Radius', 'borderRadius', 0, 24, 1)}
                        {sliderRow('Glow', 'glow', 0, 40, 1)}
                        {sliderRow('Blur', 'blur', 0, 10, 0.1)}
                        {colorRow('Box', 'boxColor')}
                        {colorRow('Label', 'labelColor')}
                        {colorRow('Label Text', 'labelTextColor')}
                        {switchRow('Coord Labels', 'showLabels')}
                    </div>

                    {/* Connections */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Connections</div>
                        {switchRow('Enabled', 'showConnections')}
                        {sliderRow('Curvature', 'connectionCurve', 0, 1, 0.01)}
                        {sliderRow('Reshuffle', 'connectionShuffle', 0, 10, 0.1)}
                        {colorRow('Color', 'connectionColor')}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Reshuffle re-pairs the boxes every N seconds of playback
                            (0 = keep pairs until a box disappears).
                        </div>
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                            {EXPORT_SCALES.map((s) => (
                                <button
                                    type="button"
                                    key={s.id}
                                    className={`${styles.vfx_segBtn} ${exportScale === s.id ? styles.vfx_segBtnOn : ''}`}
                                    disabled={isExporting}
                                    onClick={() => setExportScale(s.id)}
                                >
                                    {s.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_row} style={{ marginBottom: 8 }}>
                            <span className={styles.vfx_label} title="Output frames per second">FPS</span>
                            <input
                                type="range"
                                className={styles.vfx_slider}
                                min={24}
                                max={60}
                                step={1}
                                value={exportFps}
                                disabled={isExporting}
                                onChange={(e) => setExportFps(parseFloat(e.target.value))}
                            />
                            <VfxNumberField
                                value={exportFps}
                                min={1}
                                max={120}
                                step={1}
                                disabled={isExporting}
                                onCommit={(n) => setExportFps(Math.round(n))}
                            />
                        </div>
                        {videoUrl && videoRef.current?.videoWidth ? (
                            <div className={styles.vfx_hint} style={{ marginBottom: 8 }}>
                                Output: {Math.round((videoRef.current.videoWidth * exportScale) / 2) * 2}
                                {' x '}
                                {Math.round((videoRef.current.videoHeight * exportScale) / 2) * 2}
                                {' mp4'}
                            </div>
                        ) : null}
                        {!isExporting ? (
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                disabled={!videoUrl}
                                onClick={startExport}
                            >
                                <Download size={13} />
                                Export Video
                            </button>
                        ) : (
                            <>
                                <div className={styles.vfx_progress}>
                                    <div
                                        className={styles.vfx_progressFill}
                                        style={{ width: `${Math.round(exportProgress * 100)}%` }}
                                    />
                                </div>
                                <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                                    Exporting · {Math.round(exportProgress * 100)}%
                                </div>
                                <button
                                    type="button"
                                    className={`${styles.vfx_select} ${styles.vfx_recActive}`}
                                    style={{ textAlign: 'center', marginTop: 8 }}
                                    onClick={cancelExport}
                                >
                                    Cancel
                                </button>
                            </>
                        )}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Exports a high-bitrate mp4 frame by frame — nothing is dropped,
                            so it can run slower than realtime. 1x keeps the original
                            resolution; higher scales upscale the footage while boxes,
                            labels and connections are re-rendered sharp on top.
                        </div>
                    </div>

                    <div className={styles.vfx_section}>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ textAlign: 'center' }}
                            onClick={() => setSettings(DEFAULTS)}
                        >
                            Reset Defaults
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            Click the video to play / pause. Bright regions above the threshold are
                            boxed; enable Track Dark for dark subjects on light footage.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default BlobTracker;
