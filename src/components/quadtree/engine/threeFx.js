// The Quad Trees renderer inside a three.js WebGLRenderer (the compositor's),
// so a quad tree can be a post effect there with no copies between contexts:
// it reads a three render target's texture and draws into another's
// framebuffer, in the same GL context, then hands the state back to three.
//
// Frames in the compositor are linear light (half float); the quad tree
// works on display colour like the tool, so the input is encoded to sRGB on
// the way in and decoded on the way out. Sizes are in the project's output
// pixels, so a preset looks the same in the tool, the preview and an export.

import * as THREE from 'three';
import Renderer from './Renderer';
import { Analysis } from './tree';
import { renderFrame } from './pipeline';
import { qtSettings } from '../fxParams';

// One summed-area table and leaf buffer per context: runs never overlap.
const SHARED = new WeakMap();

const handle = (three, rt) => {
    // Initialises the target's GL objects if three hasn't yet.
    if (!three.properties.get(rt).__webglFramebuffer) {
        const prev = three.getRenderTarget();
        three.setRenderTarget(rt);
        three.setRenderTarget(prev);
    }
    return {
        fb: three.properties.get(rt).__webglFramebuffer,
        tex: three.properties.get(rt.texture).__webglTexture,
    };
};

export default class QuadTreeFx {
    constructor(three) {
        this.three = three;
        const gl = three.getContext();
        this.r = new Renderer(gl);
        if (!SHARED.has(gl)) SHARED.set(gl, { an: new Analysis(), scratch: {} });
        this.shared = SHARED.get(gl);
        this.out = null;
    }

    /** A half-float target of w x h this effect draws into, kept between frames. */
    target(w, h) {
        w = Math.max(2, Math.round(w));
        h = Math.max(2, Math.round(h));
        if (!this.out) {
            this.out = new THREE.WebGLRenderTarget(w, h, {
                type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            });
        } else if (this.out.width !== w || this.out.height !== h) {
            this.out.setSize(w, h);
        }
        return this.out;
    }

    /**
     * Run on `src` (a three render target, its texture already resolved).
     * `rect` the part of it in pixels (bottom-left origin), or the whole;
     * `params` the resolved qt_ parameters; `outW` x `outH` the size of that
     * part in output pixels; `time` the timeline's. Returns the target drawn.
     */
    run({
        src, rect = null, params, outW, outH, time,
    }) {
        const three = this.three;
        const W = src.width;
        const H = src.height;
        const R = rect || {
            x: 0, y: 0, w: W, h: H,
        };
        const dst = this.target(R.w, R.h);
        const a = handle(three, src);
        const b = handle(three, dst);
        const s = qtSettings(params);
        const loop = Math.max(0.05, s.loop || 8);
        const phase = (((time % loop) + loop) % loop) / loop;
        three.setRenderTarget(null);
        const { r } = this;
        r.prepareState();
        r.setSize(R.w, R.h);
        const frame = {
            type: 'texture', tex: a.tex, linear: true, uv: [R.x / W, R.y / H, R.w / W, R.h / H],
        };
        renderFrame(r, this.shared.an, this.shared.scratch, frame, s, outW, outH, phase, Math.round(time * 30), {
            fb: b.fb, w: dst.width, h: dst.height, linear: true,
        });
        three.resetState();
        return dst;
    }

    dispose() {
        this.r.dispose();
        this.out?.dispose();
        this.three.resetState();
    }
}
