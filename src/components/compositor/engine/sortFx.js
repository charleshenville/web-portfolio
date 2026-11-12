// The Pixel Sort effect: the Pixel Sorter's engine run on a whole picture
// (the program, or one video track's), the way the Quad Tree effect runs the
// Quad Trees tool. The picture is read back at a fraction of its size, sorted
// on the CPU, and drawn back over it at the effect's mix.
//
// In the preview the sort runs on workers and the effect shows the last one
// that finished, so the preview keeps moving; exports sort every frame in
// place, so each frame shows its own sort.

import * as THREE from 'three';
import { sortPixels } from '../../../lib/pixelSort';
import { createSortPool } from '../../../lib/pixelSortPool';

let sharedPool = null; // null: not tried yet; false: no workers here

function pool() {
    if (sharedPool === null) sharedPool = (typeof Worker !== 'undefined' && createSortPool(2)) || false;
    return sharedPool || null;
}

/** The Pixel Sorter's settings from the effect's resolved parameters; `k` is sort pixels per output pixel. */
export function sortSettings(p, k) {
    return {
        sortBy: p.sortBy || 'brightness',
        thresholdMode: p.thresholdMode || 'brightness',
        low: p.low ?? 30,
        high: p.high ?? 100,
        direction: p.direction || 'vertical',
        segmentMaxLength: Math.max(0, (p.segmentMaxLength || 0) * k),
        // Rows come back from the GPU bottom-up, so a vertical sort runs the
        // other way unless it is flipped here.
        reverse: (p.direction || 'vertical') === 'vertical' ? !p.reverse : !!p.reverse,
        rgbShift: Math.max(0, (p.rgbShift || 0) * k),
    };
}

export default class SortFx {
    /** `blitter` draws a texture over the bound target, optionally sRGB-encoded (the WindowCompositor). */
    constructor(renderer, blitter) {
        this.r = renderer;
        this.blitter = blitter;
        this.readRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
        this.out = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.overMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.overMat);
        quad.frustumCulled = false;
        this.scene = new THREE.Scene();
        this.scene.add(quad);
        this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.tex = null;
        this.pending = false;
        this.gen = 0;
        this.lastDraw = -2;
    }

    /** Forget the last sort (and any on its way), so it cannot show again stale. */
    drop() {
        this.gen++;
        this.tex?.dispose();
        this.tex = null;
    }

    /**
     * Sort `src` (a render target) and return a target holding it with the
     * sort drawn over at `params.sortMix`. `outW` is the picture's width in
     * output pixels (lengths are in those); `now` sorts this frame in place;
     * `drawNo` counts the engine's draws, so a gap (the track was off
     * screen) drops a sort that would now be stale.
     */
    run({
        src, params: p, outW, now, drawNo,
    }) {
        const r = this.r;
        const W = src.width;
        const H = src.height;
        if (drawNo !== this.lastDraw + 1) this.drop();
        this.lastDraw = drawNo;
        if (this.out.width !== W || this.out.height !== H) this.out.setSize(W, H);

        if (now || !this.pending) {
            const scale = Math.max(0.1, Math.min(1, p.sortScale ?? 0.5));
            const w = Math.max(2, Math.round(W * scale));
            const h = Math.max(2, Math.round(H * scale));
            if (this.readRT.width !== w || this.readRT.height !== h) this.readRT.setSize(w, h);
            r.setRenderTarget(this.readRT);
            this.blitter.blit(src.texture, null, true);
            const buf = new Uint8Array(w * h * 4);
            r.readRenderTargetPixels(this.readRT, 0, 0, w, h, buf);
            const settings = sortSettings(p, w / Math.max(1, outW || W));
            const gen = this.gen;
            const land = (bytes) => {
                if (this.disposed || gen !== this.gen) return;
                const data = new Uint8Array(bytes);
                let tex = this.tex;
                if (!tex || tex.image.width !== w || tex.image.height !== h) {
                    tex?.dispose();
                    tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.minFilter = THREE.LinearFilter;
                    tex.magFilter = THREE.LinearFilter;
                    this.tex = tex;
                } else {
                    tex.image.data = data;
                }
                tex.needsUpdate = true;
            };
            const workers = now ? null : pool();
            if (!workers) {
                sortPixels(buf, w, h, settings);
                land(buf.buffer);
            } else {
                this.pending = true;
                workers.run(buf.buffer, w, h, settings)
                    .then(land)
                    .catch(() => {})
                    .finally(() => { this.pending = false; });
            }
        }

        r.setRenderTarget(this.out);
        this.blitter.blit(src.texture);
        const mix = Math.max(0, Math.min(1, p.sortMix ?? 1));
        if (this.tex && mix > 0) {
            if (this.overMat.map !== this.tex) { this.overMat.map = this.tex; this.overMat.needsUpdate = true; }
            this.overMat.opacity = mix;
            r.render(this.scene, this.cam);
        }
        return this.out;
    }

    dispose() {
        this.disposed = true;
        this.drop();
        this.readRT.dispose();
        this.out.dispose();
        this.overMat.dispose();
    }
}
