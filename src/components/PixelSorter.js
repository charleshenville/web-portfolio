import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SlidersHorizontal, X, ImagePlus, Upload, Download, Film } from 'lucide-react';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import VfxNumberField from './VfxNumberField';
import styles from './vfx.module.css';

// Live preview is processed at a capped width so sorting stays interactive;
// exports always run at the full output resolution.
const PREVIEW_MAX_W_IMAGE = 1280;
const PREVIEW_MAX_W_VIDEO = 720;

const DEFAULTS = {
    direction: 'horizontal',   // 'horizontal' | 'vertical'
    sortBy: 'brightness',      // 'brightness' | 'hue' | 'saturation' | 'lightness' | 'red' | 'green' | 'blue'
    reverse: false,
    thresholdMode: 'brightness', // 'brightness' | 'saturation' | 'hue' | 'none'
    low: 34,                   // % — only pixels whose metric falls between
    high: 100,                 // low & high get sorted
    segmentMaxLength: 0,       // px, 0 = no limit (long streaks)
    rgbShift: 0,               // px of channel offset inside sorted segments
};

const SORT_MODES = [
    { id: 'brightness', name: 'Brightness (classic)' },
    { id: 'hue', name: 'Hue' },
    { id: 'saturation', name: 'Saturation' },
    { id: 'lightness', name: 'Lightness' },
    { id: 'red', name: 'Red' },
    { id: 'green', name: 'Green' },
    { id: 'blue', name: 'Blue' },
];

const THRESHOLD_MODES = [
    { id: 'brightness', name: 'By brightness' },
    { id: 'saturation', name: 'By saturation' },
    { id: 'hue', name: 'By hue' },
    { id: 'none', name: 'None (sort everything)' },
];

const EXPORT_SCALES = [
    { id: 1, name: '1x' },
    { id: 2, name: '2x' },
    { id: 3, name: '3x' },
    { id: 4, name: '4x' },
];

// ---- Sorting engine --------------------------------------------------------

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

// Scans every row (or column) of the frame, finds runs of pixels whose
// threshold metric falls inside [low, high], chops runs to the max segment
// length, and computes each run's sorted order. Returns a "plan": a list of
// { offset, stride, order } runs addressed into the flat pixel array, which
// can then be applied fully (photos / video frames) or partially (the
// animated photo export).
function buildPlan(data, w, h, s) {
    const n = w * h;
    const keys = new Float32Array(n);
    computeMetric(data, n, s.sortBy, keys);

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
                const order = new Int32Array(len);
                for (let i = 0; i < len; i++) order[i] = i;
                order.sort((a, b) => keys[offset + a * stride] - keys[offset + b * stride]);
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
            const ok = met === null || (() => {
                const m = met[lineBase + i * stride];
                return m >= lo && m <= hi;
            })();
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
function applyPlan(src32, dst32, runs, rgbShift) {
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
function applyPlanProgress(src32, dst32, runs, progress, rgbShift) {
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

// Draws `source` (image or video) into ctx at w x h and pixel-sorts it in
// place. `progress` < 1 renders a partially-sorted frame (photo animation).
function renderSortedInto(ctx, source, w, h, s, progress) {
    ctx.drawImage(source, 0, 0, w, h);
    let img;
    try {
        img = ctx.getImageData(0, 0, w, h);
    } catch (e) {
        return; // tainted / not yet decodable frame
    }
    const runs = buildPlan(img.data, w, h, s);
    const src32 = new Uint32Array(img.data.buffer.slice(0));
    const dst32 = new Uint32Array(img.data.buffer);
    if (progress === undefined || progress >= 1) {
        applyPlan(src32, dst32, runs, s.rgbShift);
    } else {
        applyPlanProgress(src32, dst32, runs, progress, s.rgbShift);
    }
    ctx.putImageData(img, 0, 0);
}

// ---- Export helpers ---------------------------------------------------------

// Picks the strongest supported AVC profile/level for the resolution and
// returns a configured WebCodecs encoder muxing into an in-memory mp4.
async function createMp4Encoder(w, h, fps) {
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
    if (!codec) return null;

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: w, height: h, frameRate: fps },
        fastStart: 'in-memory',
    });
    const state = { error: null };
    const encoder = new window.VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { state.error = e; },
    });
    encoder.configure({
        codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality',
    });
    return { muxer, encoder, state };
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function formatTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function PixelSorter() {
    const [mediaUrl, setMediaUrl] = useState(null);
    const [mediaType, setMediaType] = useState(null); // 'image' | 'video'
    const [fileName, setFileName] = useState('');
    const [imageReady, setImageReady] = useState(0);
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
    const [animDuration, setAnimDuration] = useState(4);
    const [animFps, setAnimFps] = useState(30);
    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);
    const [exportKind, setExportKind] = useState(null); // 'anim' | 'video'

    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const imageRef = useRef(null);
    const fileInputRef = useRef(null);
    const mediaUrlRef = useRef(null);
    const settingsRef = useRef(settings);
    const settingsVersionRef = useRef(0);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    useEffect(() => {
        settingsRef.current = settings;
        settingsVersionRef.current += 1;
    }, [settings]);

    const set = (key) => (value) => setSettings((prev) => ({ ...prev, [key]: value }));

    const loadFile = useCallback((file) => {
        if (!file) return;
        const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
        const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
        if (!isImage && !isVideo) return;

        // Revoke the previous object URL here (not in a mediaUrl-effect cleanup):
        // React Strict Mode remounts effects and would otherwise revoke the live
        // blob URL before the Image / <video> finishes decoding.
        if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current);
        const url = URL.createObjectURL(file);
        mediaUrlRef.current = url;
        setMediaUrl(url);
        setMediaType(isImage ? 'image' : 'video');
        setFileName(file.name);
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        imageRef.current = null;
    }, []);

    useEffect(() => () => {
        if (mediaUrlRef.current) URL.revokeObjectURL(mediaUrlRef.current);
    }, []);

    // Stop any in-flight export if the component unmounts.
    useEffect(() => () => {
        exportCanceledRef.current = true;
    }, []);

    // Decode uploaded images off-DOM.
    useEffect(() => {
        if (mediaType !== 'image' || !mediaUrl) return undefined;
        let canceled = false;
        const img = new Image();
        img.onload = () => {
            if (canceled) return;
            imageRef.current = img;
            setImageReady((v) => v + 1);
        };
        img.onerror = () => {
            if (!canceled) imageRef.current = null;
        };
        img.src = mediaUrl;
        return () => {
            canceled = true;
            img.onload = null;
            img.onerror = null;
        };
    }, [mediaType, mediaUrl]);

    // Photo preview: re-sort at capped resolution whenever settings change.
    useEffect(() => {
        if (mediaType !== 'image') return undefined;
        const raf = requestAnimationFrame(() => {
            const img = imageRef.current;
            const canvas = canvasRef.current;
            if (!img || !img.naturalWidth || !canvas || exportingRef.current) return;
            const pw = Math.min(PREVIEW_MAX_W_IMAGE, img.naturalWidth);
            const ph = Math.max(1, Math.round((pw * img.naturalHeight) / img.naturalWidth));
            if (canvas.width !== pw || canvas.height !== ph) {
                canvas.width = pw;
                canvas.height = ph;
            }
            renderSortedInto(canvas.getContext('2d', { willReadFrequently: true }), img, pw, ph, settingsRef.current);
        });
        return () => cancelAnimationFrame(raf);
    }, [mediaType, imageReady, settings]);

    // Video preview loop: sorts the current frame at capped resolution.
    // Skips work when nothing changed (paused + same settings) and while an
    // export owns the preview canvas.
    useEffect(() => {
        if (mediaType !== 'video' || !mediaUrl) return undefined;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let raf;
        let lastTime = -1;
        let lastVersion = -1;

        const tick = () => {
            raf = requestAnimationFrame(tick);
            if (exportingRef.current) return;
            if (!video || video.readyState < 2 || !video.videoWidth) return;

            const sv = settingsVersionRef.current;
            if (video.currentTime === lastTime && sv === lastVersion) return;
            lastTime = video.currentTime;
            lastVersion = sv;

            const pw = Math.min(PREVIEW_MAX_W_VIDEO, video.videoWidth);
            const ph = Math.max(2, Math.round((pw * video.videoHeight) / video.videoWidth));
            if (canvas.width !== pw || canvas.height !== ph) {
                canvas.width = pw;
                canvas.height = ph;
            }
            renderSortedInto(ctx, video, pw, ph, settingsRef.current);
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [mediaType, mediaUrl]);

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video || mediaType !== 'video' || isExporting) return;
        if (video.paused) video.play(); else video.pause();
    };

    const seek = (t) => {
        const video = videoRef.current;
        if (!video || isExporting) return;
        video.currentTime = t;
        setCurrentTime(t);
    };

    // ---- Photo exports ------------------------------------------------------

    const exportPng = useCallback(() => {
        const img = imageRef.current;
        if (!img || !img.naturalWidth || exportingRef.current) return;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        renderSortedInto(canvas.getContext('2d', { willReadFrequently: true }), img, w, h, settingsRef.current);
        const base = (fileName || 'image').replace(/\.[^.]+$/, '');
        canvas.toBlob((blob) => {
            if (blob) downloadBlob(blob, `${base}_sorted_${w}x${h}.png`);
        }, 'image/png');
    }, [fileName]);

    // Animated photo export: the sort plan is computed once at full
    // resolution, then each frame renders the pixels part-way along their
    // journey to the sorted result and encodes it with WebCodecs.
    const exportAnimation = useCallback(async () => {
        const img = imageRef.current;
        if (!img || !img.naturalWidth || exportingRef.current) return;
        if (typeof window.VideoEncoder === 'undefined' || typeof window.VideoFrame === 'undefined') {
            // eslint-disable-next-line no-alert
            window.alert('MP4 export needs WebCodecs support (Chrome / Edge / recent Safari).');
            return;
        }

        const w = Math.max(2, Math.round(img.naturalWidth / 2) * 2);
        const h = Math.max(2, Math.round(img.naturalHeight / 2) * 2);
        const fps = Math.max(1, Math.min(120, Math.round(animFps)));
        const enc = await createMp4Encoder(w, h, fps);
        if (!enc) {
            // eslint-disable-next-line no-alert
            window.alert('No supported H.264 encoder found for this resolution.');
            return;
        }
        const { muxer, encoder, state } = enc;

        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportKind('anim');
        setExportProgress(0);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h);

        const s = { ...settingsRef.current };
        const runs = buildPlan(frame.data, w, h, s);
        const src32 = new Uint32Array(frame.data.buffer.slice(0));
        const work = ctx.createImageData(w, h);
        const dst32 = new Uint32Array(work.data.buffer);

        const preview = canvasRef.current;
        const pctx = preview ? preview.getContext('2d', { willReadFrequently: true }) : null;

        const animFrames = Math.max(2, Math.round(animDuration * fps));
        const holdFrames = Math.round(fps * 0.5); // rest on the final result
        const totalFrames = animFrames + holdFrames;
        const frameUs = Math.round(1_000_000 / fps);
        let completed = false;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || state.error) break;

                const p = Math.min(1, i / (animFrames - 1));
                applyPlanProgress(src32, dst32, runs, p, s.rgbShift);
                ctx.putImageData(work, 0, 0);

                if (pctx && preview.width && preview.height && i % 3 === 0) {
                    pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
                }

                const vf = new window.VideoFrame(canvas, {
                    timestamp: i * frameUs,
                    duration: frameUs,
                });
                encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
                vf.close();

                while (encoder.encodeQueueSize > 8 && !state.error) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 5));
                }

                if (i % 3 === 0) {
                    setExportProgress((i + 1) / totalFrames);
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
                }
            }

            if (!exportCanceledRef.current && !state.error) {
                setExportProgress(1);
                await encoder.flush();
                muxer.finalize();
                completed = true;
            }
        } catch (e) {
            state.error = e;
        } finally {
            try { encoder.close(); } catch (e) { /* already closed */ }
            exportingRef.current = false;
            setIsExporting(false);
            setExportKind(null);
            setExportProgress(0);
        }

        // Restore the live still preview (export drew intermediate frames onto it).
        const imgAgain = imageRef.current;
        const previewAgain = canvasRef.current;
        if (imgAgain && previewAgain && imgAgain.naturalWidth) {
            const pw = Math.min(PREVIEW_MAX_W_IMAGE, imgAgain.naturalWidth);
            const ph = Math.max(1, Math.round((pw * imgAgain.naturalHeight) / imgAgain.naturalWidth));
            if (previewAgain.width !== pw || previewAgain.height !== ph) {
                previewAgain.width = pw;
                previewAgain.height = ph;
            }
            renderSortedInto(
                previewAgain.getContext('2d', { willReadFrequently: true }),
                imgAgain, pw, ph, settingsRef.current,
            );
        }

        if (completed) {
            const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            const base = (fileName || 'image').replace(/\.[^.]+$/, '');
            downloadBlob(blob, `${base}_sorted_${w}x${h}.mp4`);
        } else if (state.error && !exportCanceledRef.current) {
            console.error('Export failed:', state.error);
            // eslint-disable-next-line no-alert
            window.alert('Animation export failed. See the console for details.');
        }
    }, [animDuration, animFps, fileName]);

    // ---- Video export -------------------------------------------------------
    // Frame-accurate MP4 export: seeks the video one frame at a time, sorts
    // every frame fully at the export resolution (no preview cap, nothing
    // dropped) and encodes with WebCodecs into an mp4 — same pipeline as the
    // Blob Tracker.
    const exportVideo = useCallback(async () => {
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
        const dur = video.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;

        const enc = await createMp4Encoder(w, h, fps);
        if (!enc) {
            // eslint-disable-next-line no-alert
            window.alert('No supported H.264 encoder found for this resolution.');
            return;
        }
        const { muxer, encoder, state } = enc;

        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportKind('video');
        setExportProgress(0);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const preview = canvasRef.current;
        const pctx = preview ? preview.getContext('2d', { willReadFrequently: true }) : null;

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

        const totalFrames = Math.max(1, Math.round(dur * fps));
        const frameUs = Math.round(1_000_000 / fps);
        let completed = false;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || state.error) break;

                const t = Math.min(i / fps, Math.max(0, dur - 0.001));
                // eslint-disable-next-line no-await-in-loop
                await seekTo(t);

                renderSortedInto(ctx, video, w, h, settingsRef.current);

                if (pctx && preview.width && preview.height && i % 2 === 0) {
                    pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
                }

                const vf = new window.VideoFrame(canvas, {
                    timestamp: i * frameUs,
                    duration: frameUs,
                });
                encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
                vf.close();

                // Backpressure: don't let the encode queue run away.
                while (encoder.encodeQueueSize > 8 && !state.error) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((r) => setTimeout(r, 5));
                }

                if (i % 3 === 0) setExportProgress((i + 1) / totalFrames);
            }

            if (!exportCanceledRef.current && !state.error) {
                setExportProgress(1);
                await encoder.flush();
                muxer.finalize();
                completed = true;
            }
        } catch (e) {
            state.error = e;
        } finally {
            try { encoder.close(); } catch (e) { /* already closed */ }
            video.loop = prevLoop;
            try { video.currentTime = prevTime; } catch (e) { /* ignore */ }
            exportingRef.current = false;
            setIsExporting(false);
            setExportKind(null);
            setExportProgress(0);
        }

        if (completed) {
            const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            const base = (fileName || 'video').replace(/\.[^.]+$/, '');
            downloadBlob(blob, `${base}_sorted_${w}x${h}.mp4`);
        } else if (state.error && !exportCanceledRef.current) {
            console.error('Export failed:', state.error);
            // eslint-disable-next-line no-alert
            window.alert('Video export failed. See the console for details.');
        }
    }, [exportScale, exportFps, fileName]);

    const cancelExport = useCallback(() => {
        exportCanceledRef.current = true;
    }, []);

    // ---- UI helpers ----------------------------------------------------------

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

    const exportBusy = isExporting;

    return (
        <div className={styles.vfx}>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.webp,.gif,.bmp,.mp4,.mov,.m4v,.webm"
                style={{ display: 'none' }}
                onChange={(e) => { loadFile(e.target.files[0]); e.target.value = ''; }}
            />

            <div className={styles.vfx_stage}>
                {mediaUrl ? (
                    <div className={styles.vfx_videoWrap}>
                        {mediaType === 'video' && (
                            <video
                                ref={videoRef}
                                src={mediaUrl}
                                muted
                                playsInline
                                autoPlay
                                loop={loop}
                                style={{ display: 'none' }}
                                onPlay={() => setIsPlaying(true)}
                                onPause={() => setIsPlaying(false)}
                                onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                                onLoadedMetadata={(e) => setDuration(e.target.duration)}
                            />
                        )}
                        <canvas
                            ref={canvasRef}
                            className={styles.vfx_canvas}
                            style={{ cursor: mediaType === 'video' ? 'pointer' : 'default' }}
                            onClick={togglePlay}
                        />
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
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 14 }}>
                            <ImagePlus size={26} strokeWidth={1.25} style={{ opacity: 0.7 }} />
                            <Film size={26} strokeWidth={1.25} style={{ opacity: 0.7 }} />
                        </div>
                        <div className={styles.vfx_dropTitle}>Drop Photo or Video</div>
                        <div className={styles.vfx_dropSub}>.png / .jpg / .mp4 / .mov — or click to browse</div>
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
                        <span className={styles.vfx_title}>Pixel Sorter</span>
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
                                disabled={exportBusy}
                                onClick={() => fileInputRef.current.click()}
                            >
                                <Upload size={13} />
                                {mediaUrl ? 'Change Media' : 'Upload Photo / Video'}
                            </button>
                        </div>
                        {fileName && <div className={styles.vfx_fileName} title={fileName}>{fileName}</div>}
                    </div>

                    {/* Playback (video only) */}
                    {mediaType === 'video' && (
                        <div className={styles.vfx_section}>
                            <div className={styles.vfx_sectionTitle}>Playback</div>
                            <div className={styles.vfx_playRow} style={{ marginBottom: 10 }}>
                                <button
                                    type="button"
                                    aria-label={isPlaying ? 'Pause' : 'Play'}
                                    className={styles.vfx_iconBtn}
                                    onClick={togglePlay}
                                    disabled={exportBusy}
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
                                    disabled={exportBusy}
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
                                onClick={() => { if (!exportBusy) setLoop(!loop); }}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !exportBusy) setLoop(!loop); }}
                            >
                                <span>Loop</span>
                                <span className={`${styles.vfx_switch} ${loop ? styles.vfx_switchOn : ''}`}>
                                    <span className={styles.vfx_knob} />
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Direction */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Direction</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 0 }}>
                            {[['horizontal', 'Horizontal'], ['vertical', 'Vertical']].map(([id, name]) => (
                                <button
                                    type="button"
                                    key={id}
                                    className={`${styles.vfx_segBtn} ${settings.direction === id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => set('direction')(id)}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Sort by */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Sort By</div>
                        <select
                            className={styles.vfx_select}
                            value={settings.sortBy}
                            onChange={(e) => set('sortBy')(e.target.value)}
                        >
                            {SORT_MODES.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                        <div style={{ marginTop: 10 }}>
                            {switchRow('Reverse', 'reverse')}
                        </div>
                    </div>

                    {/* Threshold */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Threshold</div>
                        <div className={styles.vfx_row} style={{ marginBottom: 10 }}>
                            <span className={styles.vfx_label}>Mode</span>
                            <select
                                className={styles.vfx_select}
                                style={{ gridColumn: '2 / -1' }}
                                value={settings.thresholdMode}
                                onChange={(e) => set('thresholdMode')(e.target.value)}
                            >
                                {THRESHOLD_MODES.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </div>
                        {settings.thresholdMode !== 'none' && (
                            <>
                                {sliderRow('Low %', 'low', 0, 100, 1)}
                                {sliderRow('High %', 'high', 0, 100, 1)}
                                <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                    Only pixels between low &amp; high get sorted.
                                </div>
                            </>
                        )}
                    </div>

                    {/* Glitch */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Glitch</div>
                        {sliderRow('Seg Max px', 'segmentMaxLength', 0, 2000, 10)}
                        <div className={styles.vfx_hint} style={{ marginBottom: 9 }}>
                            0 = no limit (long streaks). Lower = chunkier glitch.
                        </div>
                        {sliderRow('RGB Shift', 'rgbShift', 0, 64, 1)}
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export</div>

                        {mediaType !== 'video' && (
                            <>
                                <button
                                    type="button"
                                    className={styles.vfx_select}
                                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                    disabled={!mediaUrl || exportBusy}
                                    onClick={exportPng}
                                >
                                    <Download size={13} />
                                    Export Photo (png)
                                </button>
                                <div className={styles.vfx_hint} style={{ margin: '6px 0 12px' }}>
                                    Full resolution, fully sorted still.
                                </div>
                                <div className={styles.vfx_row}>
                                    <span className={styles.vfx_label} title="Animation length in seconds">Duration s</span>
                                    <input
                                        type="range"
                                        className={styles.vfx_slider}
                                        min={1}
                                        max={15}
                                        step={0.5}
                                        value={animDuration}
                                        disabled={exportBusy}
                                        onChange={(e) => setAnimDuration(parseFloat(e.target.value))}
                                    />
                                    <VfxNumberField
                                        value={animDuration}
                                        min={0.5}
                                        max={60}
                                        step={0.5}
                                        disabled={exportBusy}
                                        onCommit={(n) => setAnimDuration(n)}
                                    />
                                </div>
                                <div className={styles.vfx_row} style={{ marginBottom: 8 }}>
                                    <span className={styles.vfx_label} title="Output frames per second">FPS</span>
                                    <input
                                        type="range"
                                        className={styles.vfx_slider}
                                        min={12}
                                        max={60}
                                        step={1}
                                        value={animFps}
                                        disabled={exportBusy}
                                        onChange={(e) => setAnimFps(parseFloat(e.target.value))}
                                    />
                                    <VfxNumberField
                                        value={animFps}
                                        min={1}
                                        max={120}
                                        step={1}
                                        disabled={exportBusy}
                                        onCommit={(n) => setAnimFps(Math.round(n))}
                                    />
                                </div>
                                {!isExporting && (
                                    <button
                                        type="button"
                                        className={styles.vfx_select}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                        disabled={!mediaUrl}
                                        onClick={exportAnimation}
                                    >
                                        <Download size={13} />
                                        Export Sort Animation (mp4)
                                    </button>
                                )}
                                {!isExporting && (
                                    <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                        Renders every pixel travelling to its sorted position at
                                        full resolution, then holds the final frame.
                                    </div>
                                )}
                            </>
                        )}

                        {mediaType === 'video' && (
                            <>
                                <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                                    {EXPORT_SCALES.map((sc) => (
                                        <button
                                            type="button"
                                            key={sc.id}
                                            className={`${styles.vfx_segBtn} ${exportScale === sc.id ? styles.vfx_segBtnOn : ''}`}
                                            disabled={exportBusy}
                                            onClick={() => setExportScale(sc.id)}
                                        >
                                            {sc.name}
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
                                        disabled={exportBusy}
                                        onChange={(e) => setExportFps(parseFloat(e.target.value))}
                                    />
                                    <VfxNumberField
                                        value={exportFps}
                                        min={1}
                                        max={120}
                                        step={1}
                                        disabled={exportBusy}
                                        onCommit={(n) => setExportFps(Math.round(n))}
                                    />
                                </div>
                                {videoRef.current?.videoWidth ? (
                                    <div className={styles.vfx_hint} style={{ marginBottom: 8 }}>
                                        Output: {Math.round((videoRef.current.videoWidth * exportScale) / 2) * 2}
                                        {' x '}
                                        {Math.round((videoRef.current.videoHeight * exportScale) / 2) * 2}
                                        {' mp4'}
                                    </div>
                                ) : null}
                                {!isExporting && (
                                    <button
                                        type="button"
                                        className={styles.vfx_select}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                        disabled={!mediaUrl}
                                        onClick={exportVideo}
                                    >
                                        <Download size={13} />
                                        Export Video (mp4)
                                    </button>
                                )}
                                {!isExporting && (
                                    <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                        Exports frame by frame — every frame is fully sorted at the
                                        output resolution, nothing is dropped, so it can run slower
                                        than realtime. The preview is downscaled; the export is not.
                                    </div>
                                )}
                            </>
                        )}

                        {isExporting && (
                            <>
                                <div className={styles.vfx_progress} style={{ marginTop: 8 }}>
                                    <div
                                        className={styles.vfx_progressFill}
                                        style={{ width: `${Math.round(exportProgress * 100)}%` }}
                                    />
                                </div>
                                <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                                    Exporting {exportKind === 'anim' ? 'animation' : 'video'}
                                    {' · '}
                                    {Math.round(exportProgress * 100)}%
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
                            Runs of pixels whose threshold metric falls between low &amp; high
                            are sorted along the chosen direction. Click the preview to
                            play / pause videos.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default PixelSorter;
