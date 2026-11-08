// A window turned into a screen: the prop screens' picture (screenVideo) laid
// across the window as it is now drawn, under the window's own mask - its
// feather and, when it is held to one, its matte - and solid inside it, so the
// video replaces what the window would show (its cut, its effects) and hides
// the 3D behind it. A picture that is contained leaves black, not see-through,
// round it: the screen covers exactly the area the window's effect does.

import * as THREE from 'three';
import { ScreenVideo } from '../../../lib/scanAssets/screenVideo';
import { patchGeometry, fitPicture, quadAspect } from '../../../lib/scanAssets/props';
import { screenMaterial, screenDepthMaterial, LAYER } from '../../../lib/scanAssets/windows';

const SEGS = 6;

/** The window's patch with a second set of coordinates into the picture. */
function screenGeometry(corners, fit, aspect, rotate, flipX) {
    const g = patchGeometry(corners, { segs: SEGS });
    const layout = fitPicture(fit, quadAspect(corners), aspect, rotate, flipX);
    const uv = g.getAttribute('uv');
    const pic = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
        const lu = uv.getX(i);
        const lv = uv.getY(i);
        // Where in the picture's own part of the patch this point is; a
        // contained picture's part is smaller than the window.
        const pu = (lu - layout.u0) / Math.max(1e-6, layout.u1 - layout.u0);
        const pv = (lv - layout.v0) / Math.max(1e-6, layout.v1 - layout.v0);
        const [x, y] = layout.uvAt(pu, pv);
        const out = pu < -1e-4 || pu > 1 + 1e-4 || pv < -1e-4 || pv > 1 + 1e-4;
        pic[i * 2] = out ? -1 : x;
        pic[i * 2 + 1] = out ? -1 : y;
    }
    g.setAttribute('picUv', new THREE.BufferAttribute(pic, 2));
    return g;
}

export default class PatchScreen {
    /** `model`: the WindowModel whose mask the screen shares. */
    constructor(model) {
        this.model = model;
        this.video = new ScreenVideo();
        this.video.onChange(() => { this.key = null; });
        this.mat = screenMaterial();
        this.depthMat = screenDepthMaterial(this.mat);
        model.maskedMats.push(this.mat);
        this.mesh = null;
        this.depthMesh = null;
        this.key = null;
    }

    /** Show `op.video` (when `op.screenOn`) across `corners`, laid out by op's fit, rotate and flip. */
    sync(corners, op) {
        const on = !!op.screenOn && !!op.video;
        this.video.setSource(on ? op.video : null);
        // While exporting, the decoded frame exportFrame put up stands in for
        // the element, which is paused and off the export's clock.
        const tex = on ? this.video.shown : null;
        const fit = op.fit || 'cover';
        const aspect = this.video.aspect || 16 / 9;
        const key = JSON.stringify([corners, fit, aspect, op.rotate, op.flipX]);
        if (key !== this.key && corners) {
            this.key = key;
            this.mesh?.removeFromParent();
            this.mesh?.geometry.dispose();
            this.depthMesh?.removeFromParent();
            const geo = screenGeometry(corners, fit, aspect, op.rotate || 0, !!op.flipX);
            // Drawn with the window's composite (so a take's holdout, which
            // only lays footage back over the 3D, leaves it alone) ...
            this.mesh = new THREE.Mesh(geo, this.mat);
            this.mesh.frustumCulled = false;
            this.mesh.layers.set(LAYER.WIN_SCREEN);
            this.model.frame.add(this.mesh);
            // ... and as a depth-only shape in the scene, hiding 3D behind it.
            this.depthMesh = new THREE.Mesh(geo, this.depthMat);
            this.depthMesh.frustumCulled = false;
            this.depthMesh.renderOrder = -1;
            this.depthMesh.layers.set(LAYER.FRONT);
            this.model.frame.add(this.depthMesh);
        }
        if (!this.mesh) return;
        this.mesh.visible = !!tex;
        this.depthMesh.visible = !!tex;
        const u = this.mat.uniforms;
        u.tVideo.value = tex;
        u.brightness.value = op.brightness ?? 1.4;
        u.saturation.value = op.videoSaturation ?? 1;
        u.feather.value = op.feather ?? 0;
        this.op = op;
    }

    /** Whether a picture is up (the window then draws its screen pass). */
    get showing() { return !!this.mesh?.visible; }

    /** Preview: keep the picture on the clock. An export decodes its own frames. */
    update(clock, playing, exporting) {
        if (exporting) return;
        if (this.mesh?.visible && this.op) this.video.sync(clock || 0, playing, this.op);
    }

    async openExport() { await this.video.openExport(); }

    async exportFrame(clock) {
        // Decided by the op rather than the mesh: the mesh's visibility is from
        // the last frame drawn, and an export renders this frame after this.
        if (!this.op?.screenOn || !this.op.video) return;
        const tex = await this.video.exportFrame(clock, this.op);
        if (tex) this.mat.uniforms.tVideo.value = tex;
    }

    closeExport() {
        this.video.closeExport();
        this.mat.uniforms.tVideo.value = this.video.texture;
    }

    dispose() {
        const list = this.model.maskedMats;
        const i = list.indexOf(this.mat);
        if (i >= 0) list.splice(i, 1);
        this.video.dispose();
        this.mesh?.removeFromParent();
        this.depthMesh?.removeFromParent();
        this.mesh?.geometry.dispose();
        this.mat.dispose();
        this.depthMat.dispose();
    }
}
