// Windows: a patch of the take, framed by four corners placed in the scan's
// space, that changes what the footage does there.
//
//   Cut     - the footage is taken out, so whatever is set "behind the
//             video" shows through (or the backdrop, with nothing there).
//   Effects - a layer over the window: a hue shift and a pixel sort (the
//             Pixel Sorter's engine), each pushed about by the music.
//
// The compositor draws a frame in this order:
//   1. everything set behind the video, into its own target;
//   2. that, then the footage over it, then each window's cut, which lays
//      the behind target back over the footage inside the window;
//   3. each window's effects, reading the result of 2;
//   4. everything in front of the video, then the editing furniture.
// Windows themselves live in the scan's frame, so they stay locked to the
// place in the footage as the camera moves.

import * as THREE from 'three';
import { MOD_DEFAULTS, modulate } from './modulate';
import { bilinear, patchGeometry } from './props';
import { sortPixels } from '../pixelSort';
import { createSortPool } from '../pixelSortPool';

/** Camera layers. 1 is the models' reflection capture. */
export const LAYER = { FRONT: 0, BEHIND: 2, OVERLAY: 3, WIN_CUT: 4, WIN_FX: 5 };

export const WINDOW_DEFAULTS = {
    corners: [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, -0.5, 0], [-0.5, -0.5, 0]],
    cut: true,
    cutOpacity: 1,
    feather: 0.02, // of the window's width, at each edge
    outline: true,

    hueOn: false,
    hueBase: 0, // degrees
    hueAmount: 120, // degrees at full modulation
    hueSat: 1,
    hueMod: { ...MOD_DEFAULTS, source: 'kick' },

    sortOn: false,
    sortBy: 'brightness',
    thresholdMode: 'brightness',
    low: 30,
    high: 100,
    direction: 'vertical',
    segmentMaxLength: 0,
    reverse: false,
    rgbShift: 0,
    sortScale: 0.5, // resolution the sort runs at
    sortMix: 1,
    sortModTarget: 'mix', // 'mix' | 'low' | 'length'
    sortModAmount: 1,
    sortMod: { ...MOD_DEFAULTS },

    // Size over time: the window as drawn is 1 x 1, and it eases from the
    // start size to the end size between two times on its clock. Before the
    // start it holds the start size, after the end the end size.
    sizeOn: false,
    sizeClock: 'take', // 'take' (the footage's time) | 'music'
    sizeFrom: 0, // seconds
    sizeTo: 2,
    startW: 0,
    startH: 0,
    endW: 1,
    endH: 1,
    sizeEase: 'inOut', // 'linear' | 'in' | 'out' | 'inOut'
    sizeAnchor: 'centre', // 'centre' | 'top' | 'bottom' | 'left' | 'right'
};

const EASES = {
    linear: (x) => x,
    in: (x) => x * x * x,
    out: (x) => 1 - (1 - x) ** 3,
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2),
};

/** The window's width and height multipliers at `time` on its size clock. */
export function windowSizeAt(op, time) {
    if (!op.sizeOn || time == null || !Number.isFinite(time)) return [1, 1];
    const a = Math.min(op.sizeFrom, op.sizeTo);
    const b = Math.max(op.sizeFrom, op.sizeTo);
    let x = b - a < 1e-6 ? (time >= b ? 1 : 0) : Math.max(0, Math.min(1, (time - a) / (b - a)));
    // Times entered the wrong way round play the animation backwards.
    if (op.sizeFrom > op.sizeTo) x = 1 - x;
    const k = (EASES[op.sizeEase] || EASES.linear)(x);
    return [op.startW + (op.endW - op.startW) * k, op.startH + (op.endH - op.startH) * k];
}

export function makeWindowItem(id, corners) {
    return {
        id,
        kind: 'window',
        reactive: false,
        op: {
            ...WINDOW_DEFAULTS,
            corners,
            hueMod: { ...WINDOW_DEFAULTS.hueMod },
            sortMod: { ...WINDOW_DEFAULTS.sortMod },
        },
    };
}

export function reviveWindow(raw, id) {
    const op = raw.op || {};
    const ok = Array.isArray(op.corners) && op.corners.length === 4
        && op.corners.every((c) => Array.isArray(c) && c.length === 3 && c.every(Number.isFinite));
    return {
        id,
        kind: 'window',
        reactive: false,
        op: {
            ...WINDOW_DEFAULTS,
            ...op,
            corners: ok ? op.corners : WINDOW_DEFAULTS.corners,
            hueMod: { ...MOD_DEFAULTS, ...op.hueMod },
            sortMod: { ...MOD_DEFAULTS, ...op.sortMod },
        },
    };
}

/** Corners for a new window: a square facing the camera, `dist` in front of it, in `space`'s frame. */
export function cornersFacing(camera, space, dist, size) {
    camera.updateMatrixWorld(true);
    space.updateMatrixWorld(true);
    const c = new THREE.Vector3(0, 0, -dist).applyMatrix4(camera.matrixWorld);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(size / 2);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(size / 2);
    const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
    const at = (sx, sy) => c.clone().addScaledVector(right, sx).addScaledVector(up, sy).applyMatrix4(inv)
        .toArray().map((x) => Math.round(x * 1e4) / 1e4);
    return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

// ---- Shaders --------------------------------------------------------------

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EDGE = /* glsl */`
uniform float feather;
float edgeMask(vec2 uv) {
    float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    return feather > 0.0 ? smoothstep(0.0, feather, e) : 1.0;
}`;

const COLOUR = /* glsl */`
vec3 toSrgb(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}`;

function cutMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tBehind: { value: null },
            resolution: { value: new THREE.Vector2(1, 1) },
            opacity: { value: 1 },
            feather: { value: 0.02 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            uniform sampler2D tBehind;
            uniform vec2 resolution;
            uniform float opacity;
            varying vec2 vUv;
            ${EDGE}
            void main() {
                vec4 c = texture2D(tBehind, gl_FragCoord.xy / resolution);
                gl_FragColor = vec4(c.rgb, opacity * edgeMask(vUv));
                #include <encodings_fragment>
            }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}

function fxMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tComp: { value: null },
            tSort: { value: null },
            resolution: { value: new THREE.Vector2(1, 1) },
            sortRect: { value: new THREE.Vector4(0, 0, 1, 1) },
            useSort: { value: 0 },
            sortMix: { value: 1 },
            hueOn: { value: 0 },
            hue: { value: 0 },
            sat: { value: 1 },
            feather: { value: 0.02 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            uniform sampler2D tComp;
            uniform sampler2D tSort;
            uniform vec2 resolution;
            uniform vec4 sortRect;
            uniform float useSort;
            uniform float sortMix;
            uniform float hueOn;
            uniform float hue;
            uniform float sat;
            varying vec2 vUv;
            ${EDGE}
            ${COLOUR}
            vec3 hueRotate(vec3 c, float a) {
                // Rotation about the grey axis, then saturation about grey.
                const vec3 k = vec3(0.57735);
                float ca = cos(a);
                vec3 r = c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
                float g = dot(r, vec3(0.2126, 0.7152, 0.0722));
                return mix(vec3(g), r, sat);
            }
            void main() {
                vec3 c = texture2D(tComp, gl_FragCoord.xy / resolution).rgb;
                if (useSort > 0.5) {
                    vec2 su = (gl_FragCoord.xy - sortRect.xy) / sortRect.zw;
                    if (su.x >= 0.0 && su.y >= 0.0 && su.x <= 1.0 && su.y <= 1.0) {
                        c = mix(c, texture2D(tSort, su).rgb, sortMix);
                    }
                }
                if (hueOn > 0.5) c = toLinear(clamp(hueRotate(toSrgb(c), hue), 0.0, 1.0));
                gl_FragColor = vec4(c, edgeMask(vUv));
                #include <encodings_fragment>
            }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}

// ---- A placed window --------------------------------------------------------

export class WindowModel {
    constructor(item) {
        this.object = new THREE.Group();
        this.object.userData.itemId = item.id;
        this.cutMat = cutMaterial();
        this.fxMat = fxMaterial();
        this.lineMat = new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
        this.hue = { input: 0, value: 0, flash: 0 };
        this.sortLevel = { input: 0, value: 0, flash: 0 };
        this.sort = { pending: false, tex: null, rect: null };
        // Holds the meshes; hidden when the window is squashed to nothing.
        this.frame = new THREE.Group();
        this.object.add(this.frame);
        this.size = [1, 1];
        this.sizeKey = '';
        this.sync(item);
    }

    sync(item) {
        this.item = item;
        const op = { ...WINDOW_DEFAULTS, ...item.op };
        this.op = op;
        const key = JSON.stringify(op.corners);
        if (key !== this.cornerKey) {
            this.cornerKey = key;
            this.build(op.corners);
        }
        this.cutMat.uniforms.opacity.value = op.cutOpacity;
        this.cutMat.uniforms.feather.value = op.feather;
        this.fxMat.uniforms.feather.value = op.feather;
        this.outline.visible = !!op.outline;
        this.sizeKey = '';
    }

    build(corners) {
        [this.cutMesh, this.fxMesh, this.outline].forEach((m) => {
            if (!m) return;
            m.removeFromParent();
            m.geometry.dispose();
        });
        const g = patchGeometry(corners, { segs: 6 });
        this.cutMesh = new THREE.Mesh(g, this.cutMat);
        this.cutMesh.layers.set(LAYER.WIN_CUT);
        this.cutMesh.frustumCulled = false;
        this.fxMesh = new THREE.Mesh(g.clone(), this.fxMat);
        this.fxMesh.layers.set(LAYER.WIN_FX);
        this.fxMesh.frustumCulled = false;
        const loop = new THREE.BufferGeometry().setFromPoints(
            [...corners, corners[0]].map((c) => new THREE.Vector3().fromArray(c)),
        );
        this.outline = new THREE.Line(loop, this.lineMat);
        this.outline.layers.set(LAYER.OVERLAY);
        this.outline.frustumCulled = false;
        this.outline.renderOrder = 999;
        this.frame.add(this.cutMesh, this.fxMesh, this.outline);
        this.drawn = corners;
        this.sizeKey = '';
    }

    /**
     * Size the window to `w` x `h` of its drawn size, held at its anchor.
     *
     * The four corners need not lie in a plane, so the window is the curved
     * patch they span, and a smaller window is a piece of that same patch
     * (a larger one carries it on past the corners). Scaling the corners
     * about a point instead would leave any twist out of the plane at full
     * size, and the window could never close.
     */
    applySize(w, h) {
        const key = `${w}|${h}|${this.op.sizeAnchor}`;
        if (key === this.sizeKey) return;
        this.sizeKey = key;
        this.size = [w, h];
        const a = this.op.sizeAnchor;
        // Across (u, left to right) and up (v, bottom to top) the patch.
        const span = (len, from) => (from === 'start' ? [0, len] : from === 'end' ? [1 - len, 1] : [0.5 - len / 2, 0.5 + len / 2]);
        const [u0, u1] = span(w, a === 'left' ? 'start' : a === 'right' ? 'end' : 'mid');
        const [v0, v1] = span(h, a === 'bottom' ? 'start' : a === 'top' ? 'end' : 'mid');
        const g = patchGeometry(this.drawn, { segs: 6, u0, u1, v0, v1 });
        const pos = g.getAttribute('position').array;
        [this.cutMesh, this.fxMesh].forEach((m) => {
            const attr = m.geometry.getAttribute('position');
            attr.array.set(pos);
            attr.needsUpdate = true;
        });
        g.dispose();
        const at = (u, v) => bilinear(this.drawn, u, v);
        this.corners = [at(u0, v1), at(u1, v1), at(u1, v0), at(u0, v0)].map((p) => p.toArray());
        const line = this.outline.geometry.getAttribute('position');
        [...this.corners, this.corners[0]].forEach((c, i) => line.setXYZ(i, c[0], c[1], c[2]));
        line.needsUpdate = true;
        this.frame.visible = w > 1e-4 && h > 1e-4;
    }

    get hasFx() { return this.op.hueOn || this.op.sortOn; }

    /** Whether the window covers anything this frame. */
    get open() { return this.frame.visible; }

    /**
     * Read the music: `music` the decoded track, `time` where it is; `take`
     * where the footage is. `hold` shows the window as drawn, for editing
     * its corners.
     */
    update(music, time, { take = null, hold = false } = {}) {
        const op = this.op;
        const clock = op.sizeClock === 'music' ? time : take;
        const [w, h] = hold ? [1, 1] : windowSizeAt(op, clock);
        this.applySize(w, h);
        this.hue = op.hueOn ? modulate(op.hueMod, music, time) : { input: 0, value: 0, flash: 0 };
        this.sortLevel = op.sortOn ? modulate(op.sortMod, music, time) : { input: 0, value: 0, flash: 0 };
        const u = this.fxMat.uniforms;
        u.hueOn.value = op.hueOn ? 1 : 0;
        u.hue.value = ((op.hueBase + op.hueAmount * this.hue.value) * Math.PI) / 180;
        u.sat.value = op.hueSat;
        const modded = op.sortMod.source !== 'off';
        const m = modded && op.sortModTarget === 'mix'
            ? op.sortMix * (1 - op.sortModAmount + op.sortModAmount * this.sortLevel.value)
            : op.sortMix;
        u.sortMix.value = Math.max(0, Math.min(1, m));
    }

    /** The Pixel Sorter's settings for this frame, with the music applied. */
    sortSettings() {
        const op = this.op;
        const s = {
            sortBy: op.sortBy,
            thresholdMode: op.thresholdMode,
            low: op.low,
            high: op.high,
            direction: op.direction,
            segmentMaxLength: op.segmentMaxLength * op.sortScale,
            // Rows come back from the GPU bottom-up, so a vertical sort runs
            // the other way unless it is flipped here.
            reverse: op.direction === 'vertical' ? !op.reverse : op.reverse,
            rgbShift: op.rgbShift * op.sortScale,
        };
        if (op.sortMod.source !== 'off') {
            const v = this.sortLevel.value * op.sortModAmount;
            // Opening the band from the top lets more of the picture sort as
            // the music hits; growing the runs lengthens the streaks.
            if (op.sortModTarget === 'low') s.low = Math.max(0, Math.min(100, op.low + (100 - op.low) * (1 - v) * 0.999));
            if (op.sortModTarget === 'length') s.segmentMaxLength = Math.max(2, (op.segmentMaxLength || 400) * op.sortScale * v);
        }
        return s;
    }

    dispose() {
        this.disposed = true;
        [this.cutMesh, this.fxMesh, this.outline].forEach((m) => m?.geometry.dispose());
        this.cutMat.dispose();
        this.fxMat.dispose();
        this.lineMat.dispose();
        this.sort.tex?.dispose();
        this.object.removeFromParent();
    }
}

// ---- The compositing passes --------------------------------------------------

const BLIT_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec4 rect; // source sub-rectangle, 0..1
uniform float encode; // write sRGB bytes into a linear target
varying vec2 vUv;
${COLOUR}
void main() {
    vec4 c = texture2D(tSrc, rect.xy + vUv * rect.zw);
    if (encode > 0.5) c.rgb = toSrgb(c.rgb);
    gl_FragColor = c;
    #include <encodings_fragment>
}`;

/**
 * The targets and full-screen passes the window composite needs. Made once
 * per renderer; `ensure` keeps them at the drawing buffer's size.
 */
export class WindowCompositor {
    constructor(renderer) {
        this.renderer = renderer;
        const opts = { type: THREE.HalfFloatType, depthBuffer: true };
        this.behindRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, samples: 4 });
        this.compRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
        this.sortRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
        this.quadScene = new THREE.Scene();
        this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.blitMat = new THREE.ShaderMaterial({
            uniforms: { tSrc: { value: null }, rect: { value: new THREE.Vector4(0, 0, 1, 1) }, encode: { value: 0 } },
            vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: BLIT_FRAG,
            depthTest: false,
            depthWrite: false,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat);
        this.quad.frustumCulled = false;
        this.quadScene.add(this.quad);
        this.empty = new THREE.Scene();
        this.pool = null;
        this.size = new THREE.Vector2();
    }

    ensure() {
        this.renderer.getDrawingBufferSize(this.size);
        const { x, y } = this.size;
        if (this.behindRT.width !== x || this.behindRT.height !== y) {
            this.behindRT.setSize(x, y);
            this.compRT.setSize(x, y);
        }
        return this.size;
    }

    /** Draw `tex` (or a sub-rectangle of it) over whatever target is bound. */
    blit(tex, rect = null, encode = false) {
        const u = this.blitMat.uniforms;
        u.tSrc.value = tex;
        if (rect) u.rect.value.copy(rect); else u.rect.value.set(0, 0, 1, 1);
        u.encode.value = encode ? 1 : 0;
        this.renderer.render(this.quadScene, this.quadCam);
    }

    /** Finish whatever target is bound (resolving its multisampling) without drawing anything. */
    resolve() {
        this.renderer.render(this.empty, this.quadCam);
    }

    /** Where `win`'s corners land on screen, in drawing-buffer pixels (clamped), or null. */
    screenRect(win, camera) {
        const { x: W, y: H } = this.size;
        const p = new THREE.Vector3();
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        let behind = false;
        win.object.updateMatrixWorld(true);
        (win.corners || win.op.corners).forEach((c) => {
            p.fromArray(c).applyMatrix4(win.object.matrixWorld);
            const view = p.clone().applyMatrix4(camera.matrixWorldInverse);
            if (view.z > 0) behind = true;
            p.project(camera);
            x0 = Math.min(x0, (p.x + 1) / 2 * W); x1 = Math.max(x1, (p.x + 1) / 2 * W);
            y0 = Math.min(y0, (p.y + 1) / 2 * H); y1 = Math.max(y1, (p.y + 1) / 2 * H);
        });
        if (behind) { x0 = 0; y0 = 0; x1 = W; y1 = H; }
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
        x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
        if (x1 - x0 < 2 || y1 - y0 < 2) return null;
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /**
     * Sort the composite (compRT) under a window. With `now` (exports) it is
     * sorted right here, so this frame shows this frame's sort; otherwise the
     * sort runs on a worker and the window shows the last finished one
     * meanwhile, which keeps the preview moving.
     */
    sortWindow(win, camera, now) {
        const wait = now;
        const rect = this.screenRect(win, camera);
        if (!rect) return;
        if (win.sort.pending && !wait) return;
        const scale = Math.max(0.1, Math.min(1, win.op.sortScale));
        const w = Math.max(2, Math.round(rect.w * scale));
        const h = Math.max(2, Math.round(rect.h * scale));
        const r = this.renderer;
        const prev = r.getRenderTarget();
        if (this.sortRT.width !== w || this.sortRT.height !== h) this.sortRT.setSize(w, h);
        r.setRenderTarget(this.sortRT);
        const { x: W, y: H } = this.size;
        this.blit(this.compRT.texture, new THREE.Vector4(rect.x / W, rect.y / H, rect.w / W, rect.h / H), true);
        const buf = new Uint8Array(w * h * 4);
        r.readRenderTargetPixels(this.sortRT, 0, 0, w, h, buf);
        r.setRenderTarget(prev);
        const settings = win.sortSettings();
        const land = (bytes) => {
            if (win.disposed) return;
            const data = new Uint8Array(bytes);
            let tex = win.sort.tex;
            if (!tex || tex.image.width !== w || tex.image.height !== h) {
                tex?.dispose();
                tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                win.sort.tex = tex;
            } else {
                tex.image.data = data;
            }
            tex.needsUpdate = true;
            win.sort.rect = rect;
        };
        if (wait || typeof Worker === 'undefined') {
            sortPixels(buf, w, h, settings);
            land(buf.buffer);
            return;
        }
        if (this.pool === null) this.pool = createSortPool(2) || false;
        if (!this.pool) {
            sortPixels(buf, w, h, settings);
            land(buf.buffer);
            return;
        }
        win.sort.pending = true;
        this.pool.run(buf.buffer, w, h, settings)
            .then((b) => land(b))
            .catch(() => {})
            .finally(() => { win.sort.pending = false; });
    }

    /** Point a window's effect pass at the composite and its latest sort. */
    prepareFx(win) {
        const u = win.fxMat.uniforms;
        u.tComp.value = this.compRT.texture;
        u.resolution.value.copy(this.size);
        const rect = win.sort.rect;
        u.useSort.value = win.op.sortOn && win.sort.tex && rect ? 1 : 0;
        if (u.useSort.value) {
            u.tSort.value = win.sort.tex;
            u.sortRect.value.set(rect.x, rect.y, rect.w, rect.h);
        }
    }

    prepareCut(win) {
        const u = win.cutMat.uniforms;
        u.tBehind.value = this.behindRT.texture;
        u.resolution.value.copy(this.size);
    }

    dispose() {
        this.behindRT.dispose();
        this.compRT.dispose();
        this.sortRT.dispose();
        this.blitMat.dispose();
        this.quad.geometry.dispose();
        this.pool?.close?.();
    }
}
