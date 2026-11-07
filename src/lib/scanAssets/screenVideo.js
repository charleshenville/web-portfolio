// What plays on a placed screen, and keeping it in step.
//
// A screen's picture runs on the music's clock (or a free clock with no
// track): screen time = offset + rate * music time, wrapped round the video's
// length. The preview plays a <video> per screen and nudges it back whenever
// it drifts; an export decodes the exact frame for each output frame instead
// (lib/mp4Frames), so the render never depends on how fast it ran.
//
// Videos you upload are kept in IndexedDB, so a screen still has its picture
// after a reload, a relaunch, or reopening a project on this machine.

import * as THREE from 'three';
import { Mp4FrameReader } from '../mp4Frames';

const DB = 'scan-compositor';
const STORE = 'screen-videos';

function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function tx(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const out = fn(t.objectStore(STORE));
        t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
        t.onerror = () => { db.close(); reject(t.error); };
    }));
}

/** Keep an uploaded video. Resolves to its source id. */
export async function storeUpload(file) {
    const key = `${file.name}|${file.size}`;
    await tx('readwrite', (s) => s.put({ name: file.name, type: file.type, blob: file, at: Date.now() }, key));
    return `upload:${key}`;
}

/** Every kept upload: `[{ id, name }]`. */
export async function listUploads() {
    try {
        const keys = await tx('readonly', (s) => s.getAllKeys());
        return (keys || []).map((k) => ({ id: `upload:${k}`, name: String(k).split('|')[0] }));
    } catch (e) {
        return [];
    }
}

export async function deleteUpload(id) {
    if (!id.startsWith('upload:')) return;
    await tx('readwrite', (s) => s.delete(id.slice(7)));
}

const blobUrls = new Map(); // source id -> object URL

/** A URL the browser can load a source from, or null when it is gone. */
export async function sourceUrl(id) {
    if (!id) return null;
    if (id.startsWith('take:')) {
        const take = id.slice(5);
        return `${process.env.PUBLIC_URL}/mv/${take}/${take}.mp4`;
    }
    if (id.startsWith('public:')) return `${process.env.PUBLIC_URL}/${id.slice(7)}`;
    if (id.startsWith('upload:')) {
        if (blobUrls.has(id)) return blobUrls.get(id);
        try {
            const rec = await tx('readonly', (s) => s.get(id.slice(7)));
            if (!rec || !rec.blob) return null;
            const url = URL.createObjectURL(rec.blob);
            blobUrls.set(id, url);
            return url;
        } catch (e) {
            return null;
        }
    }
    return null;
}

/** Bundled clips worth putting on a screen. */
export const PUBLIC_VIDEOS = [
    ['VfxVids/pixel-sorter.mp4', 'Pixel Sorter demo'],
    ['VfxVids/blob-tracker.mp4', 'Blob Tracker demo'],
    ['VfxVids/procedural.mp4', 'Procedural demo'],
    ['ProjectVids/SunSetVidDemo.mp4', 'Sunset'],
    ['ProjectVids/dtrndr-vid-demo.mp4', 'dtrndr'],
    ['ProjectVids/veri-renderer.mp4', 'Veri renderer'],
    ['ProjectVids/tss-vid-demo.mp4', 'TSS'],
    ['ProjectVids/kim-ca-mov.mp4', 'Kim CA'],
].map(([path, name]) => ({ id: `public:${path}`, name }));

const wrap = (t, d) => (d > 0 ? ((t % d) + d) % d : 0);

/**
 * One screen's video: a hidden <video> and its texture. `sync` keeps it on
 * the clock in the preview; `exportFrame` swaps in decoded frames instead.
 */
export class ScreenVideo {
    constructor() {
        this.source = null;
        this.el = null;
        this.texture = null;
        this.duration = 0;
        this.ready = false;
        this.token = null;
        this.listeners = new Set();
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit() { this.listeners.forEach((fn) => fn(this)); }

    /** Point the screen at a source id (null for none). */
    async setSource(id) {
        if (id === this.source) return;
        this.source = id;
        this.release();
        if (!id) { this.emit(); return; }
        const token = {};
        this.token = token;
        const url = await sourceUrl(id);
        if (this.token !== token) return;
        if (!url) { this.missing = true; this.emit(); return; }
        this.missing = false;
        this.url = url;
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.muted = true;
        el.playsInline = true;
        el.loop = true;
        el.preload = 'auto';
        el.src = url;
        this.el = el;
        const tex = new THREE.VideoTexture(el);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        this.texture = tex;
        el.addEventListener('loadedmetadata', () => {
            if (this.el !== el) return;
            this.duration = el.duration || 0;
            this.aspect = el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 16 / 9;
            this.emit();
        });
        el.addEventListener('loadeddata', () => {
            if (this.el !== el) return;
            this.ready = true;
            this.dirty = 3;
            this.emit();
        });
        el.addEventListener('seeked', () => { this.dirty = 3; });
        el.load();
        this.emit();
    }

    /** Where the picture should be for a clock reading, in seconds of the video. */
    timeFor(clock, op) {
        return wrap((op.videoOffset || 0) + clock * (op.videoRate ?? 1), this.duration);
    }

    /** Preview: keep the element at the clock, playing or held. */
    sync(clock, playing, op) {
        const el = this.el;
        if (!el || !this.duration) return;
        const want = this.timeFor(clock, op);
        const rate = Math.max(0.0625, Math.min(16, Math.abs(op.videoRate ?? 1)));
        if (el.playbackRate !== rate) el.playbackRate = rate;
        // Distance round the loop, so a wrap is not mistaken for drift.
        let off = Math.abs(el.currentTime - want);
        off = Math.min(off, this.duration - off);
        if (playing && (op.videoRate ?? 1) > 0) {
            if (el.paused) el.play().catch(() => {});
            if (off > 0.25) el.currentTime = want;
        } else {
            if (!el.paused) el.pause();
            if (off > 1 / 60) el.currentTime = want;
        }
        if (this.texture && el.readyState >= 2 && (!el.paused || this.dirty > 0)) {
            this.texture.needsUpdate = true;
            if (this.dirty > 0) this.dirty--;
        }
    }

    // ---- Export ----

    async openExport() {
        this.closeExport();
        if (!this.url) return;
        this.reader = await Mp4FrameReader.open(this.url);
        this.el?.pause();
    }

    /**
     * Put the frame for this clock reading up. Returns the texture to show:
     * a decoded frame, or the element seeked there when the decoder cannot
     * take this file.
     */
    async exportFrame(clock, op) {
        if (!this.el || !this.duration) return this.texture;
        const at = this.timeFor(clock, op);
        const r = this.reader;
        if (r) {
            const times = r.times;
            let lo = 0;
            let hi = times.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (times[mid] <= at + 1e-4) lo = mid;
                else hi = mid - 1;
            }
            const vf = await r.frame(lo);
            if (vf) {
                if (!this.frameTex) {
                    // WebGL takes a VideoFrame directly, as the take's own
                    // decoded frames do in the exporter.
                    this.frameTex = new THREE.VideoTexture(vf);
                    this.frameTex.colorSpace = THREE.SRGBColorSpace;
                    this.frameTex.minFilter = THREE.LinearFilter;
                    this.frameTex.magFilter = THREE.LinearFilter;
                    this.frameTex.generateMipmaps = false;
                }
                this.frameTex.image = vf;
                this.frameTex.needsUpdate = true;
                return this.frameTex;
            }
        }
        const el = this.el;
        if (Math.abs(el.currentTime - at) > 1 / 240) {
            await new Promise((resolve) => {
                const done = () => { clearTimeout(timer); el.removeEventListener('seeked', done); resolve(); };
                const timer = setTimeout(done, 2000);
                el.addEventListener('seeked', done);
                el.currentTime = at;
            });
        }
        this.texture.needsUpdate = true;
        return this.texture;
    }

    closeExport() {
        this.reader?.close();
        this.reader = null;
        this.frameTex?.dispose();
        this.frameTex = null;
    }

    release() {
        this.closeExport();
        if (this.el) {
            this.el.pause();
            this.el.removeAttribute('src');
            this.el.load();
        }
        this.texture?.dispose();
        this.el = null;
        this.texture = null;
        this.duration = 0;
        this.ready = false;
        this.url = null;
    }

    dispose() {
        this.token = null;
        this.release();
        this.listeners.clear();
    }
}
