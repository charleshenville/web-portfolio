// The Blob Tracker effect: the Blob Tracker tool's engine (lib/blobTracker)
// run on a picture in the Compositor (the program, or one video track's),
// drawing its boxes, labels and connections over it, and optionally a
// window in every box.
//
// It is one of the picture effects, run in effect order: it sees the
// picture the effects before it left, and nothing of its own (its windows,
// boxes and labels go on after it has looked) or of the effects after it.
// So on a still frame it settles and stays put.
//
// Those windows are the Compositor's own windows (lib/scanAssets/windows):
// each is a WindowModel laid over its box as seen by the camera and drawn
// with the window passes, so a cut, the hue shift, pixel sort, quad tree,
// feather, matte hold and hiding behind the scan all work (and keep working
// the same way as windows change). They sit far back, behind anything in the
// scene, the way the picture they are found in does.
//
// The picture is read back small (ANALYSIS_WIDTH across). In the preview
// that read is asynchronous, so the boxes can trail the picture by a frame
// or two rather than stall it; exports read every frame in place.

import * as THREE from 'three';
import {
    ANALYSIS_WIDTH, newTrackerState, trackFrame, drawOverlay, trackShown,
} from '../../../lib/blobTracker';
import { WindowModel } from '../../../lib/scanAssets/windows';
import Readback from './readback';

/** One blob's window. */
class BlobWindow {
    constructor(id, parent) {
        this.id = id;
        this.model = new WindowModel({ id, kind: 'window', op: { outline: false } });
        this.model.object.visible = false;
        this.active = false;
        this.screen = null;
        parent.add(this.model.object);
    }

    get open() { return this.active && this.model.open; }

    hide() {
        this.active = false;
        this.model.object.visible = false;
        this.model.dropSort();
    }

    dispose() {
        this.model.dispose();
    }
}

const NDC = new THREE.Vector3();
const FWD = new THREE.Vector3();
const POS = new THREE.Vector3();

/** The point on screen at (x, y) in NDC, `dist` in front of `cam` (world space), as [x, y, z]. */
function screenPoint(cam, x, y, dist) {
    if (cam.isPerspectiveCamera) {
        NDC.set(x, y, 0.5).unproject(cam);
        cam.getWorldPosition(POS);
        cam.getWorldDirection(FWD);
        const dir = NDC.sub(POS).normalize();
        return POS.addScaledVector(dir, dist / Math.max(1e-6, dir.dot(FWD))).toArray();
    }
    return NDC.set(x, y, 0.9).unproject(cam).toArray();
}

export default class BlobFx {
    /** `blitter` draws a texture over the bound target (the WindowCompositor). */
    constructor(renderer, blitter, id) {
        this.r = renderer;
        this.blitter = blitter;
        this.id = id;
        this.readRT = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
        this.readback = new Readback(renderer);
        this.flipped = null;
        // The windows, in a scene of their own: the engine draws them at this
        // effect's place, not with the placed windows.
        this.scene = new THREE.Scene();
        this.scene.name = `blobs:${id}`;
        this.lastDraw = -2;
        this.slots = [];
        this.slotOf = new Map(); // track id -> slot
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.tex = new THREE.CanvasTexture(this.canvas);
        this.tex.colorSpace = THREE.SRGBColorSpace;
        this.overMat = new THREE.MeshBasicMaterial({
            map: this.tex, transparent: true, depthTest: false, depthWrite: false,
        });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.overMat);
        quad.frustumCulled = false;
        this.overScene = new THREE.Scene();
        this.overScene.add(quad);
        this.overCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.reset();
    }

    /** Start tracking afresh (an export, a jump): no tracks, nothing on its way. */
    reset() {
        this.state = newTrackerState();
        this.readback.cancel();
        this.fresh = null;
        this.aw = ANALYSIS_WIDTH;
        this.ah = ANALYSIS_WIDTH;
        this.slotOf.clear();
        this.slots.forEach((w) => w.hide());
        this.drawnKey = null;
        this.drawnSig = null;
    }

    /** The windows, for the engine's window passes. */
    get windows() { return this.slots; }

    // ---- Seeing the picture -----------------------------------------------------------

    sizeFor(bufW, bufH) {
        const aw = ANALYSIS_WIDTH;
        const ah = Math.max(2, Math.round((aw * bufH) / Math.max(1, bufW)));
        if (this.readRT.width !== aw || this.readRT.height !== ah) this.readRT.setSize(aw, ah);
    }

    finishCapture(sync) {
        const px = this.readback.read(this.readRT, sync);
        if (px) this.fresh = { data: px, w: this.readRT.width, h: this.readRT.height };
    }

    /** Whether a capture now would be used (one read at a time in the preview). */
    wants(sync) { return sync || !this.readback.pending; }

    /**
     * This frame's run, `drawNo` counting the engine's draws: a gap (its
     * track went off screen, or it was off) starts the tracking afresh,
     * rather than bringing back boxes from where the picture was.
     */
    begin(drawNo) {
        if (drawNo !== this.lastDraw + 1) this.reset();
        this.lastDraw = drawNo;
    }

    /** Look at a picture in a texture (linear), framed as the output. */
    captureTexture(tex, bufW, bufH, sync) {
        if (!this.wants(sync)) return;
        this.sizeFor(bufW, bufH);
        this.r.setRenderTarget(this.readRT);
        this.blitter.blit(tex, null, true);
        this.finishCapture(sync);
    }

    /** Run the tracker on a frame that has come in; returns whether the tracks moved. */
    step(p, now) {
        const landed = this.readback.poll();
        if (landed) this.fresh = landed;
        if (!this.fresh) return false;
        const { data, w, h } = this.fresh;
        this.fresh = null;
        // Rows come back bottom-up; the tracker reads them top-down.
        if (!this.flipped || this.flipped.length !== data.length) this.flipped = new Uint8Array(data.length);
        const row = w * 4;
        for (let y = 0; y < h; y++) this.flipped.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        trackFrame(this.state, this.flipped, w, h, p, now);
        this.aw = w;
        this.ah = h;
        return true;
    }

    // ---- Windows in the boxes ---------------------------------------------------------

    /**
     * Put a window over every box seen by `cam`, with the effect's window
     * parameters `p`. `outW` is the output's width (Window padding is in its
     * pixels); `music`, `time`, `take` drive the windows as the engine's own.
     */
    placeWindows(cam, p, outW, { music, time, take }) {
        const shown = p.spawnWindows ? this.state.tracks.filter(trackShown) : [];
        const ids = new Set(shown.map((t) => t.id));
        this.slotOf.forEach((slot, id) => {
            if (ids.has(id)) return;
            this.slotOf.delete(id);
            this.slots[slot]?.hide();
        });
        const used = new Set(this.slotOf.values());
        shown.forEach((t) => {
            if (this.slotOf.has(t.id)) return;
            let slot = 0;
            while (used.has(slot)) slot++;
            used.add(slot);
            this.slotOf.set(t.id, slot);
            if (!this.slots[slot]) this.slots[slot] = new BlobWindow(`${this.id}#${slot}`, this.scene);
            // A slot taken over by another blob starts without the last one's sort.
            this.slots[slot].model.dropSort();
        });
        // Slots are kept for coming blobs, up to as many boxes as can show.
        const keep = Math.max(1, Math.round(p.maxBoxes || 12));
        while (this.slots.length > keep && !used.has(this.slots.length - 1)) this.slots.pop().dispose();

        cam.updateMatrixWorld();
        const dist = cam.far * 0.5;
        const pad = ((p.winPad || 0) * this.aw) / Math.max(1, outW);
        const { aw, ah } = this;
        shown.forEach((t) => {
            const win = this.slots[this.slotOf.get(t.id)];
            const x0 = ((t.x - pad) / aw) * 2 - 1;
            const x1 = ((t.x + t.w + pad) / aw) * 2 - 1;
            const y0 = 1 - ((t.y - pad) / ah) * 2;
            const y1 = 1 - ((t.y + t.h + pad) / ah) * 2;
            if (x1 <= x0 || y0 <= y1) { win.hide(); return; }
            const corners = [
                screenPoint(cam, x0, y0, dist), screenPoint(cam, x1, y0, dist),
                screenPoint(cam, x1, y1, dist), screenPoint(cam, x0, y1, dist),
            ];
            win.model.sync({
                id: win.id,
                kind: 'window',
                // The window's own parameters, from the effect; laid over the
                // box on screen, at full size, without its editing outline.
                op: {
                    ...p, corners, outline: false, sizeOn: false, qt_space: 'screen', screenOn: false,
                },
            });
            win.model.update(music, time, { take });
            win.active = true;
            win.model.object.visible = true;
        });
    }

    // ---- The overlay ------------------------------------------------------------------

    /**
     * Draw the boxes, labels and connections over the bound target `rt`, at
     * its size; `outW` x `outH` is the output's (labels count in its pixels).
     * The canvas is redrawn (and sent to the GPU, the costly part) only when
     * what it shows changes: the tracks as drawn, or the look.
     */
    drawOver(rt, p, outW, outH) {
        const w = rt.width;
        const h = rt.height;
        const c = this.canvas;
        const resized = c.width !== w || c.height !== h;
        if (resized) {
            c.width = w;
            c.height = h;
            // WebGL2 textures get fixed storage at their first upload, so a
            // canvas at a new size (an export, a resized window) needs the
            // texture made again; updating it in place fails, and the overlay
            // would stay stuck at the old frame.
            this.tex.dispose();
        }
        const q = (v) => Math.round((v || 0) * 20);
        let sig = '';
        this.state.tracks.forEach((t) => {
            if (trackShown(t)) sig += `${t.id},${q(t.x)},${q(t.y)},${q(t.w)},${q(t.h)},${q(t.conf)},${Math.round(t.var || 0)},${Math.round(t.area)};`;
        });
        sig += this.state.conn.pairs.map((x) => `${x.a}-${x.b}`).join(',');
        if (resized || sig !== this.drawnSig || p !== this.drawnKey) {
            this.drawnKey = p;
            this.drawnSig = sig;
            this.ctx.clearRect(0, 0, w, h);
            drawOverlay(this.ctx, w, h, this.aw, this.ah, this.state.tracks, this.state.conn.pairs, p, { labelW: outW, labelH: outH });
            this.tex.needsUpdate = true;
        }
        if (!this.state.tracks.some(trackShown)) return;
        this.r.setRenderTarget(rt);
        this.r.render(this.overScene, this.overCam);
    }

    dispose() {
        this.readback.dispose();
        this.slots.forEach((w) => w.dispose());
        this.slots = [];
        this.readRT.dispose();
        this.tex.dispose();
        this.overMat.dispose();
    }
}
