// Media for the compositor: where a clip's file is, its decoded sound, the
// mixed soundtrack, the audio analysis the controllers read, and the <video>
// elements the preview plays.
//
// Media is kept by link, never embedded in a project:
//   { type: 'take', take }       a take published under public/mv
//   { type: 'public', path }     a file under public/
//   { type: 'upload', id, name, size }  a file kept in this browser
//                                (IndexedDB, lib/scanAssets/screenVideo)
//   { type: 'url', url }         anywhere else
// An upload only exists in the browser it was added in; opened elsewhere the
// project flags it missing and asks for the file again.

import * as THREE from 'three';
import { sourceUrl, storeUpload } from '../../../lib/scanAssets/screenVideo';
import { computeSpectrogram } from '../../../lib/audioScene';
import { clipSourceTime, sourceSpan } from '../model/timeline';

const PUB = process.env.PUBLIC_URL || '';

export const takeBase = (take) => `${PUB}/mv/${take}/${take}`;

/** A URL for a media item's file, or null if it cannot be found here. */
export async function mediaUrl(media) {
    const s = media?.src;
    if (!s) return null;
    if (s.type === 'take') return `${takeBase(s.take)}.mp4`;
    if (s.type === 'public') return `${PUB}/${s.path.replace(/^\//, '')}`;
    if (s.type === 'url') return s.url;
    if (s.type === 'upload') return sourceUrl(s.id);
    return null;
}

/** Keep a file the user picked, and describe it as a media link. */
export async function importFile(file) {
    const id = await storeUpload(file);
    return { type: 'upload', id, name: file.name, size: file.size };
}

/** Duration (and size, for video) of a URL, read off a throwaway element. */
export function probe(url, kind) {
    return new Promise((resolve) => {
        const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
        el.preload = 'metadata';
        el.muted = true;
        const done = (v) => { el.removeAttribute('src'); el.load(); resolve(v); };
        el.onloadedmetadata = () => done({
            duration: el.duration,
            width: el.videoWidth || 0,
            height: el.videoHeight || 0,
        });
        el.onerror = () => done(null);
        el.src = url;
    });
}

// ---- Sound ---------------------------------------------------------------------

let ctx = null;
export const audioContext = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
};

const decoded = new Map(); // url -> Promise<AudioBuffer|null>
export function decodeUrl(url) {
    if (!url) return Promise.resolve(null);
    if (!decoded.has(url)) {
        decoded.set(url, fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .then((buf) => (buf ? audioContext().decodeAudioData(buf) : null))
            // No sound track, or one this browser cannot decode: silence.
            .catch(() => null));
    }
    return decoded.get(url);
}

const MIX_RATE = 44100;

/**
 * Mix the project's sound into one buffer starting at timeline 0. `music`
 * mixes only the audio tracks (what the controllers listen to); otherwise
 * the program's sound: audio tracks plus the sound of any video clip that
 * keeps its own.
 */
export async function mixProject(project, { music = false } = {}) {
    const tracks = new Map(project.tracks.map((t) => [t.id, t]));
    const media = new Map(project.media.map((m) => [m.id, m]));
    const wanted = project.clips.filter((c) => {
        const tr = tracks.get(c.trackId);
        if (!tr || tr.params?.visible === false) return false;
        const m = media.get(c.mediaId);
        if (!m || m.kind === 'stage') return false;
        if (tr.kind === 'audio') return true;
        return !music && c.withAudio !== false;
    });
    if (!wanted.length) return null;
    const bufs = await Promise.all(wanted.map(async (c) => decodeUrl(await mediaUrl(media.get(c.mediaId)))));
    let end = 0;
    wanted.forEach((c) => { end = Math.max(end, c.start + c.dur); });
    const length = Math.max(1, Math.ceil(end * MIX_RATE));
    const off = new OfflineAudioContext(2, length, MIX_RATE);
    let any = false;
    wanted.forEach((c, i) => {
        const buf = bufs[i];
        if (!buf) return;
        const tr = tracks.get(c.trackId);
        const m = media.get(c.mediaId);
        const span = Math.min(sourceSpan(c, m), buf.duration - (c.in || 0));
        if (!(span > 0)) return;
        const gain = off.createGain();
        gain.gain.value = tr.kind === 'audio' ? (tr.params?.gain ?? 1) : 1;
        gain.connect(off.destination);
        const src = off.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = c.rate || 1;
        if (c.loop === 'loop' || c.loop === 'bounce') {
            // The way back of a ping-pong plays forwards again; reversing
            // sound buys nothing worth its cost here.
            src.loop = true;
            src.loopStart = c.in || 0;
            src.loopEnd = (c.in || 0) + span;
        }
        src.connect(gain);
        const playFor = c.loop === 'off' ? Math.min(c.dur, span / (c.rate || 1)) : c.dur;
        src.start(c.start, c.in || 0, c.loop === 'off' ? playFor * (c.rate || 1) : undefined);
        src.stop(c.start + playFor);
        any = true;
    });
    if (!any) return null;
    return off.startRendering();
}

export const SPECTRUM_FPS = 60;

/**
 * What the controllers and the spectrum-driven effects read: the music, and
 * its spectrum SPECTRUM_FPS times a second over its whole length. Computed
 * once per soundtrack, so the preview and an export see the same spectrum
 * for the same moment.
 */
export function analyse(music) {
    if (!music) return { music: null, spectrum: null };
    const frameCount = Math.max(1, Math.ceil(music.duration * SPECTRUM_FPS));
    const spectrum = computeSpectrogram(music, { fps: SPECTRUM_FPS, frameCount });
    return {
        music,
        spectrum,
        spectrumAt(t) {
            if (!(t >= 0)) return null;
            const i = Math.floor(t * SPECTRUM_FPS);
            return i < spectrum.length ? spectrum[i] : null;
        },
    };
}

// ---- Pictures ------------------------------------------------------------------

/**
 * One <video> per media item the preview is showing, with its texture. A
 * take's reversed copy is kept too, so a ping-pong plays backwards smoothly.
 */
export class VideoPool {
    constructor(onFrame) {
        this.items = new Map(); // media id -> { el, tex, rev, revTex, url }
        this.onFrame = onFrame;
        this.missing = new Set();
    }

    make(url) {
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.muted = true;
        el.playsInline = true;
        el.preload = 'auto';
        el.src = url;
        const tex = new THREE.VideoTexture(el);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        const bump = () => { this.onFrame?.(); };
        el.addEventListener('seeked', bump);
        el.addEventListener('loadeddata', bump);
        return { el, tex };
    }

    /** The pool entry for a media item, starting its load if need be. */
    get(media) {
        let it = this.items.get(media.id);
        if (it) return it.ready ? it : null;
        it = { ready: false };
        this.items.set(media.id, it);
        mediaUrl(media).then((url) => {
            if (!url) { this.missing.add(media.id); this.onFrame?.(true); return; }
            const fwd = this.make(url);
            Object.assign(it, fwd, { url, ready: true });
            fwd.el.addEventListener('error', () => { this.missing.add(media.id); this.onFrame?.(true); });
            if (media.kind === 'take') {
                const rev = this.make(`${takeBase(media.src.take)}_rev.mp4`);
                rev.el.addEventListener('error', () => { it.rev = null; });
                it.rev = rev;
            }
            this.onFrame?.();
        });
        return null;
    }

    /**
     * Put a clip's picture where it should be at timeline time `t`. Returns
     * the texture to draw, or null while it loads.
     */
    follow(clip, media, t, { playing }) {
        const it = this.get(media);
        if (!it) return null;
        const st = clipSourceTime(clip, media, t);
        if (!st) return null;
        const useRev = st.dir < 0 && it.rev && it.rev.el.readyState >= 1;
        const pick = useRev ? it.rev : it;
        const other = useRev ? it : it.rev;
        const d = it.el.duration || media.duration || 0;
        const want = useRev ? Math.max(0, (it.rev.el.duration || d) - (st.time * (it.rev.el.duration || d)) / Math.max(1e-6, d)) : st.time;
        const el = pick.el;
        if (other && !other.el.paused) other.el.pause();
        const rate = clip.rate || 1;
        if (playing && !(st.dir < 0 && !useRev)) {
            if (el.playbackRate !== rate) el.playbackRate = rate;
            if (Math.abs(el.currentTime - want) > 0.25 || el.readyState < 2) {
                if (!el.seeking) el.currentTime = want;
            }
            if (el.paused) el.play().catch(() => {});
        } else {
            if (!el.paused) el.pause();
            if (Math.abs(el.currentTime - want) > 1 / 240 && !el.seeking) el.currentTime = want;
        }
        if (el.readyState >= 2) pick.tex.needsUpdate = true;
        return pick.tex;
    }

    /** Pause everything not in `keep` (media ids). */
    park(keep) {
        this.items.forEach((it, id) => {
            if (keep.has(id) || !it.ready) return;
            if (!it.el.paused) it.el.pause();
            if (it.rev && !it.rev.el.paused) it.rev.el.pause();
        });
    }

    drop(id) {
        const it = this.items.get(id);
        if (!it) return;
        [it, it.rev].forEach((x) => {
            if (!x?.el) return;
            x.el.pause();
            x.el.removeAttribute('src');
            x.el.load();
            x.tex?.dispose();
        });
        this.items.delete(id);
        this.missing.delete(id);
    }

    dispose() {
        Array.from(this.items.keys()).forEach((id) => this.drop(id));
    }
}
