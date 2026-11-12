import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SlidersHorizontal, X, Film, Upload, Download } from 'lucide-react';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import VfxNumberField from './VfxNumberField';
import ColorPicker from './ui/ColorPicker';
import { Mp4FrameReader, drainEncoders, nextTask } from '../lib/mp4Frames';
import {
    ANALYSIS_WIDTH, BLOB_DEFAULTS, LABEL_TEXTS, LABEL_PLACES, LABEL_TOKENS,
    detectBlobs, updateTracks, updateConnections, drawOverlay,
} from '../lib/blobTracker';
import { GLYPH_FONTS, GLYPH_WEIGHTS } from './quadtree/fonts';
import styles from './vfx.module.css';

// Settings for the tool: the engine's (lib/blobTracker), shared with the
// Compositor's Blob Tracker effect.
const DEFAULTS = BLOB_DEFAULTS;

const EXPORT_SCALES = [
    { id: 1, name: '1x' },
    { id: 2, name: '2x' },
    { id: 3, name: '3x' },
    { id: 4, name: '4x' },
];

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
    // The uploaded file itself, which the export decodes directly.
    const fileRef = useRef(null);
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
        fileRef.current = file;
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
        // The frame and settings last drawn: the display refreshes faster
        // than the video (a 120 Hz screen, a paused video), and redoing the
        // same frame was most of the tool's work.
        // Where the browser says when a new frame is shown, count those;
        // otherwise go by the playhead.
        let lastKey = null;
        let lastSettings = null;
        let frameSeq = 0;
        let vfc = 0;
        const hasVfc = !!video?.requestVideoFrameCallback;
        const onFrame = () => { frameSeq++; vfc = video.requestVideoFrameCallback(onFrame); };
        if (hasVfc) vfc = video.requestVideoFrameCallback(onFrame);

        const tick = () => {
            raf = requestAnimationFrame(tick);
            if (exportingRef.current) { lastKey = null; return; }
            if (!video || video.readyState < 2 || !video.videoWidth) return;
            const key = hasVfc ? frameSeq : video.currentTime;
            if (key === lastKey && settingsRef.current === lastSettings) return;
            lastKey = key;
            lastSettings = settingsRef.current;

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
        return () => {
            cancelAnimationFrame(raf);
            if (hasVfc) video.cancelVideoFrameCallback?.(vfc);
        };
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
    // Frame-accurate MP4 export: walks the video one frame at a time, runs
    // the exact same detection + overlay pipeline as the live viewer, and
    // encodes each composited frame with WebCodecs (H.264, high bitrate) into
    // an mp4. No frames are dropped and nothing depends on realtime playback,
    // so the result is neither laggy nor lossy. At upscaled resolutions the
    // overlay is drawn after the upscale so boxes and labels stay sharp.
    //
    // Frames come from decoding the file in order (lib/mp4Frames) rather than
    // seeking the <video> to each one, which re-decodes from a keyframe every
    // time; seeking is the fallback for a file the decoder cannot read.
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

        // Only trusted if it agrees with the element about the picture's
        // shape, which also catches a rotation it read differently.
        let reader = fileRef.current ? await Mp4FrameReader.open(fileRef.current) : null;
        if (reader && Math.abs(reader.width / reader.height
            - video.videoWidth / video.videoHeight) > 0.01) {
            reader.close();
            reader = null;
        }

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
        let lastYield = 0;
        const failed = () => !!encodeFailed;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || encodeFailed) break;

                const t = Math.min(i / fps, Math.max(0, duration - 0.001));
                // eslint-disable-next-line no-await-in-loop
                const vf = reader ? await reader.frameAt(t) : null;
                if (!vf) {
                    // eslint-disable-next-line no-await-in-loop
                    await seekTo(t);
                }
                const paint = (c, cw, ch) => {
                    if (vf) reader.draw(c, vf, cw, ch);
                    else c.drawImage(video, 0, 0, cw, ch);
                };

                const aw = ANALYSIS_WIDTH;
                const ah = Math.max(2, Math.round((aw * video.videoHeight) / video.videoWidth));
                if (proc.width !== aw || proc.height !== ah) { proc.width = aw; proc.height = ah; }

                paint(pctx, aw, ah);
                const frame = pctx.getImageData(0, 0, aw, ah);

                const s = settingsRef.current;
                const blobs = detectBlobs(frame.data, aw, ah, s);
                tracks = updateTracks(tracks, blobs, nextId, s, aw * 0.18);
                updateConnections(connState, tracks, s, t);

                // Upscale the footage first, then render the overlay on top
                // at the export resolution so it stays sharp.
                paint(ctx, w, h);
                drawOverlay(ctx, w, h, aw, ah, tracks, connState.pairs, s);

                // Mirror onto the on-screen overlay so the export is visible,
                // a few times a second rather than every frame.
                const now = performance.now();
                const report = now - lastYield > 200;
                if (report && octx && overlay.width && overlay.height) {
                    octx.clearRect(0, 0, overlay.width, overlay.height);
                    drawOverlay(octx, overlay.width, overlay.height, aw, ah, tracks, connState.pairs, s);
                }

                const out = new window.VideoFrame(canvas, {
                    timestamp: i * frameUs,
                    duration: frameUs,
                });
                encoder.encode(out, { keyFrame: i % (fps * 2) === 0 });
                out.close();

                // Backpressure: don't let the encode queue run away.
                // eslint-disable-next-line no-await-in-loop
                await drainEncoders([encoder], 8, failed);

                // Every state update re-renders the tool, and the yield lets
                // the progress paint and Cancel work.
                if (report) {
                    lastYield = now;
                    setExportProgress((i + 1) / totalFrames);
                    // eslint-disable-next-line no-await-in-loop
                    await nextTask();
                }
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
            reader?.close();
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

    const selectRow = (options, key, cast = String) => (
        <select
            key={key}
            className={styles.vfx_select}
            style={{ marginBottom: 8 }}
            value={settings[key]}
            onChange={(e) => set(key)(cast(e.target.value))}
        >
            {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
    );

    const colorRow = (label, key) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <ColorPicker
                title={label}
                style={{ gridColumn: '2 / 4' }}
                value={settings[key]}
                onChange={set(key)}
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
                        {sliderRow('Max Size %', 'maxSize', 0.1, 100, 0.1)}
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
                        {switchRow('Show Boxes', 'showBoxes')}
                        {sliderRow('Line Width', 'lineWidth', 1, 6, 0.5)}
                        {sliderRow('Opacity', 'boxOpacity', 0.1, 1, 0.05)}
                        {sliderRow('Radius', 'borderRadius', 0, 24, 1)}
                        {sliderRow('Glow', 'glow', 0, 40, 1)}
                        {sliderRow('Blur', 'blur', 0, 10, 0.1)}
                        {colorRow('Box', 'boxColor')}
                    </div>

                    {/* Labels */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Labels</div>
                        {switchRow('Show Labels', 'showLabels')}
                        {selectRow(LABEL_TEXTS.map(([id, name]) => [id, name]), 'labelText')}
                        {settings.labelText === 'custom' && (
                            <>
                                <input
                                    type="text"
                                    className={styles.vfx_text}
                                    style={{ marginBottom: 6 }}
                                    value={settings.labelTemplate}
                                    onChange={(e) => set('labelTemplate')(e.target.value)}
                                    spellCheck={false}
                                />
                                <div className={styles.vfx_hint} style={{ marginBottom: 8 }}>{LABEL_TOKENS}</div>
                            </>
                        )}
                        {selectRow(GLYPH_FONTS.map(([id, name]) => [id, name]), 'labelFont')}
                        {settings.labelFont === 'custom' && (
                            <input
                                type="text"
                                className={styles.vfx_text}
                                style={{ marginBottom: 8 }}
                                value={settings.labelFontCustom}
                                placeholder="Font name"
                                onChange={(e) => set('labelFontCustom')(e.target.value)}
                                spellCheck={false}
                            />
                        )}
                        {selectRow(GLYPH_WEIGHTS.map((w) => [w, `Weight ${w}`]), 'labelWeight', Number)}
                        {selectRow(LABEL_PLACES, 'labelPlace')}
                        {sliderRow('Text Size', 'labelSize', 4, 48, 0.5)}
                        {sliderRow('Pad X', 'labelPadX', 0, 24, 0.5)}
                        {sliderRow('Pad Y', 'labelPadY', 0, 24, 0.5)}
                        {sliderRow('Gap', 'labelGap', -20, 40, 0.5)}
                        {sliderRow('Radius', 'labelRadius', -1, 24, 1)}
                        {sliderRow('Fill', 'labelOpacity', 0, 1, 0.05)}
                        {colorRow('Fill Color', 'labelColor')}
                        {colorRow('Text', 'labelTextColor')}
                        {switchRow('Outline', 'labelOutline')}
                        {settings.labelOutline && sliderRow('Outline Width', 'labelOutlineWidth', 0, 6, 0.25)}
                        {settings.labelOutline && sliderRow('Outline Opacity', 'labelOutlineOpacity', 0, 1, 0.05)}
                        {settings.labelOutline && colorRow('Outline', 'labelOutlineColor')}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Radius -1 follows the box&apos;s. Area and lengths are in the video&apos;s pixels.
                        </div>
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
