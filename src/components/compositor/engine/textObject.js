// Text in a scene: a patch between four corners (placed and shaped like a
// window) with the text drawn onto it. It can be lit by the sun and cast a
// shadow in the shape of its letters, not its box.
//
// Or laid flat over the frame (2D): a box placed in frame coordinates that
// follows whatever camera is drawing, in front of everything.
//
// The text is plain (any font, the Computer Modern ones included) or LaTeX,
// each line typeset by MathJax (engine/latex.js).

import * as THREE from 'three';
import { patchGeometry, quadAspect } from '../../../lib/scanAssets/props';
import { CMU_FONTS, registerCmuFonts } from '../../../lib/cmuFonts';
import { texLayout, drawTex, loadTex, texFailed } from './latex';

export const FONTS = [
    ['grotesk', 'Inter Tight (site)', "'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif"],
    ['mono', 'SF Mono (site)', "'SF Mono', ui-monospace, Menlo, Monaco, monospace"],
    ['helvetica', 'Helvetica', "'Helvetica Neue', Helvetica, Arial, sans-serif"],
    ['georgia', 'Georgia', 'Georgia, serif'],
    ['times', 'Times', "'Times New Roman', Times, serif"],
    ['courier', 'Courier', "'Courier New', Courier, monospace"],
    ...CMU_FONTS,
    ['impact', 'Impact', 'Impact, Haettenschweiler, sans-serif'],
    ['custom', 'Other (by name)…', null],
];
const FONT = Object.fromEntries(FONTS.map(([id, , stack]) => [id, stack]));

/** The CSS font-family for a text object's parameters. */
export const fontStack = (p) => (p.fontFamily === 'custom' && p.fontCustom
    ? `"${p.fontCustom.replace(/"/g, '')}", sans-serif`
    : FONT[p.fontFamily] || FONT.grotesk);

/**
 * How the letters meet what is behind them (the footage, mostly). Screen
 * only ever lightens, so the video's texture shows through the letters, as
 * if painted on; multiply darkens through them the same way; add glows.
 * Sources are premultiplied, so opacity and soft edges blend correctly.
 */
export const TEXT_BLENDS = [['normal', 'Normal'], ['screen', 'Screen'], ['multiply', 'Multiply'], ['add', 'Add']];

function applyBlend(m, mode) {
    if (mode === 'normal' || !mode) {
        m.blending = THREE.NormalBlending;
        m.premultipliedAlpha = false;
    } else {
        m.blending = THREE.CustomBlending;
        m.premultipliedAlpha = true;
        m.blendEquation = THREE.AddEquation;
        m.blendSrcAlpha = THREE.OneFactor;
        m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        if (mode === 'screen') {
            m.blendSrc = THREE.OneFactor;
            m.blendDst = THREE.OneMinusSrcColorFactor;
        } else if (mode === 'multiply') {
            m.blendSrc = THREE.DstColorFactor;
            m.blendDst = THREE.OneMinusSrcAlphaFactor;
        } else {
            m.blendSrc = THREE.OneFactor;
            m.blendDst = THREE.OneFactor;
        }
    }
    m.needsUpdate = true;
}

// Surface noise, so text sits in the footage rather than on top of it:
// softness blurs it to the shot's focus, grain is per-pixel like the
// video's own noise (moving each frame, or still), mottle varies its
// brightness in blotches and wear eats holes in it. Mottle and wear are in
// the text's own surface, so they stay put on the floor as the camera moves.
const NOISE_GLSL = /* glsl */`
uniform float textSoft;
uniform float textGrain;
uniform float textGrainMove;
uniform float textMottle;
uniform float textWear;
uniform float textDetail;
uniform float textAspect;
uniform float textTime;
float tHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float tValue(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tFbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) { s += a * tValue(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return s / 0.9375;
}`;

const MAP_GLSL = /* glsl */`
#ifdef USE_MAP
    diffuseColor *= texture2D(map, vMapUv, textSoft);
    vec2 np = vMapUv * vec2(textAspect, 1.0) * textDetail;
    if (textMottle > 0.0) diffuseColor.rgb *= clamp(1.0 + textMottle * (tFbm(np) - 0.5) * 2.0, 0.0, 2.0);
    if (textWear > 0.0) diffuseColor.a *= smoothstep(textWear - 0.1, textWear + 0.1, tFbm(np * 0.6 + 41.3));
    if (textGrain > 0.0) {
        float frame = textGrainMove > 0.5 ? floor(textTime * 30.0) : 0.0;
        diffuseColor.rgb *= clamp(1.0 + textGrain * (tHash(gl_FragCoord.xy + frame * vec2(37.1, 11.7)) - 0.5) * 1.6, 0.0, 2.0);
    }
#endif
`;

/** Lines of `text` wrapped to `width` pixels in `ctx`'s font (with letter spacing). */
function wrap(ctx, text, width, spacing) {
    const measure = (s) => ctx.measureText(s).width + Math.max(0, s.length - 1) * spacing;
    const out = [];
    String(text || '').split('\n').forEach((para) => {
        const words = para.split(/(\s+)/);
        let line = '';
        words.forEach((w) => {
            const next = line + w;
            if (line && measure(next.trimEnd()) > width) {
                out.push(line.trimEnd());
                line = w.trimStart();
            } else {
                line = next;
            }
        });
        out.push(line.trimEnd());
    });
    return out;
}

export default class TextObject {
    constructor() {
        registerCmuFonts();
        this.object = new THREE.Group();
        this.canvas = document.createElement('canvas');
        this.tex = new THREE.CanvasTexture(this.canvas);
        this.tex.colorSpace = THREE.SRGBColorSpace;
        this.tex.anisotropy = 4;
        this.basic = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, side: THREE.DoubleSide, alphaTest: 0.01 });
        this.lit = new THREE.MeshLambertMaterial({ map: this.tex, transparent: true, side: THREE.DoubleSide, alphaTest: 0.01 });
        // The shadow follows the letters: the depth pass reads the same alpha.
        this.depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: this.tex, alphaTest: 0.5, side: THREE.DoubleSide });
        // Hidden wherever the scan stands in front, when asked (shared by both materials).
        this.occlusion = {
            tScanDepth: { value: null }, scanOcclude: { value: 0 }, scanRes: { value: new THREE.Vector2(1, 1) },
        };
        this.noise = {
            textSoft: { value: 0 },
            textGrain: { value: 0 },
            textGrainMove: { value: 1 },
            textMottle: { value: 0 },
            textWear: { value: 0 },
            textDetail: { value: 24 },
            textAspect: { value: 1 },
            textTime: { value: 0 },
        };
        [this.basic, this.lit].forEach((m) => {
            m.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.occlusion, this.noise);
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', `#include <common>\nuniform sampler2D tScanDepth;\nuniform float scanOcclude;\nuniform vec2 scanRes;\n${NOISE_GLSL}`)
                    .replace('#include <map_fragment>', MAP_GLSL)
                    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (scanOcclude > 0.5 && gl_FragCoord.z > texture2D(tScanDepth, gl_FragCoord.xy / scanRes).r + 1e-5) discard;');
            };
            m.customProgramCacheKey = () => 'text-scan-occlude-noise';
        });
        this.mesh = null;
        this.geoKey = null;
        this.drawKey = null;
        this.op = {};
        this.fontsWaited = new Set();
        // Height the text is rasterised at to match its size on screen.
        this.autoH = 0;
        this.maxTex = 4096;
        this.v = [0, 1, 2, 3].map(() => new THREE.Vector3());
    }

    /**
     * Re-rasterise when the patch is drawn larger than its texture (or far
     * smaller): its corners projected through `camera` into a `size` drawing
     * buffer give the pixels the letters cover, preview or export alike.
     * Sizes step in quarter octaves, so a moving camera redraws rarely.
     */
    fit(camera, size, renderer) {
        const c = this.op.corners;
        if (!this.mesh || !camera || !size || !c || !this.object.visible) return;
        if (renderer) this.maxTex = Math.min(4096, renderer.capabilities.maxTextureSize || 4096);
        this.mesh.updateMatrixWorld(true);
        const pts = this.v;
        for (let i = 0; i < 4; i++) {
            const p = pts[i].fromArray(c[i]).applyMatrix4(this.mesh.matrixWorld);
            // Behind the camera, the projection means nothing: keep what we have.
            if (p.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return;
            p.project(camera);
            p.set(((p.x + 1) / 2) * size.x, ((p.y + 1) / 2) * size.y, 0);
        }
        const len = (a, b) => pts[a].distanceTo(pts[b]);
        const aspect = quadAspect(c);
        const need = Math.max(len(0, 3), len(1, 2), Math.max(len(0, 1), len(3, 2)) / Math.max(1e-6, aspect));
        if (!Number.isFinite(need) || need <= 0) return;
        const step = 2 ** (Math.ceil(Math.log2(Math.max(64, need)) * 4) / 4);
        const target = Math.min(step, Math.floor(this.maxTex / Math.max(1, aspect)), this.maxTex);
        if (target > this.autoH || target < this.autoH / 2) {
            this.autoH = target;
            this.draw(this.op, aspect);
        }
    }

    sync(p) {
        this.op = p;
        const corners = p.corners;
        const geoKey = JSON.stringify(corners);
        if (geoKey !== this.geoKey) {
            this.geoKey = geoKey;
            this.mesh?.removeFromParent();
            this.mesh?.geometry.dispose();
            this.mesh = new THREE.Mesh(patchGeometry(corners, { segs: 4 }), p.lit ? this.lit : this.basic);
            this.mesh.customDepthMaterial = this.depth;
            this.mesh.frustumCulled = false;
            this.object.add(this.mesh);
        }
        this.mesh.material = p.lit ? this.lit : this.basic;
        this.mesh.castShadow = !!p.castShadow;
        this.mesh.receiveShadow = !!p.lit;
        // Over the frame, it is drawn over everything else in its pass.
        const flat = p.space === 'frame';
        if (flat !== this.flat) {
            this.flat = flat;
            [this.lit, this.basic].forEach((m) => { m.depthTest = !flat; m.depthWrite = !flat; });
            if (!flat) this.unplace2D();
        }
        // Turned square to the camera in update; otherwise placed by its corners.
        if (!flat && !p.faceCamera) this.unplace2D();
        this.mesh.renderOrder = flat ? 100000 : 0;
        [this.lit, this.basic].forEach((m) => { m.opacity = Math.max(0, Math.min(1, p.opacity ?? 1)); });
        const n = this.noise;
        n.textSoft.value = Math.max(0, p.softness || 0);
        n.textGrain.value = Math.max(0, p.grain || 0);
        n.textGrainMove.value = p.grainMove === false ? 0 : 1;
        n.textMottle.value = Math.max(0, p.mottle || 0);
        n.textWear.value = Math.max(0, p.wear || 0);
        n.textDetail.value = Math.max(0.1, p.noiseDetail ?? 24);
        n.textAspect.value = quadAspect(corners);
        const blend = p.blend || 'normal';
        if (blend !== this.blend) {
            this.blend = blend;
            [this.lit, this.basic].forEach((m) => applyBlend(m, blend));
        }
        this.object.visible = p.visible !== false && (p.opacity ?? 1) > 0.002;
        this.draw(p, quadAspect(corners));
    }

    draw(p, aspect) {
        // At least the chosen sharpness, more when it is drawn larger, never
        // past the texture limit on either side.
        let h = Math.max(64, Math.round(Math.max(p.resolution || 512, this.autoH || 0)));
        if (h * aspect > this.maxTex) h = Math.floor(this.maxTex / aspect);
        h = Math.min(h, this.maxTex);
        const w = Math.max(16, Math.round(h * aspect));
        const family = fontStack(p);
        const latex = p.textMode === 'latex' && !texFailed();
        const key = JSON.stringify([w, h, p.text, family, p.fontSize, p.weight, p.italic, p.color, p.align, p.valign,
            p.letterSpacing, p.lineHeight, p.bgColor, p.bgOpacity, p.padding, this.fontTick, latex]);
        if (key === this.drawKey) return;
        this.drawKey = key;
        const c = this.canvas;
        if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
            // A new size needs a new texture upload of that size.
            this.tex.dispose();
        }
        const g = c.getContext('2d');
        g.clearRect(0, 0, w, h);
        if ((p.bgOpacity ?? 0) > 0) {
            g.globalAlpha = p.bgOpacity;
            g.fillStyle = p.bgColor || '#000000';
            g.fillRect(0, 0, w, h);
            g.globalAlpha = 1;
        }
        // Laid out once at a fixed reference height and scaled up by the
        // canvas transform: line breaks, spacing and glyph shapes are then the
        // same at every resolution the text is redrawn at (outlines are
        // scaled as vectors, so it stays sharp).
        const REF = 1024;
        const k = h / REF;
        const W0 = w / k;
        g.setTransform(k, 0, 0, k, 0, 0);
        const px = Math.max(1, p.fontSize * REF);
        const font = `${p.italic ? 'italic ' : ''}${p.weight || 400} ${px}px ${family}`;
        g.font = font;
        g.fillStyle = p.color || '#ffffff';
        g.textBaseline = 'alphabetic';
        const pad = (p.padding || 0) * REF;
        if (latex) {
            this.drawLatex(g, p, px, pad, W0, REF);
            g.setTransform(1, 0, 0, 1, 0, 0);
            this.tex.needsUpdate = true;
            return;
        }
        const spacing = (p.letterSpacing || 0) * px;
        if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
        const lines = wrap(g, p.text, W0 - pad * 2, 'letterSpacing' in g ? spacing : 0);
        const lh = px * (p.lineHeight || 1.15);
        const block = lh * lines.length;
        let y = p.valign === 'top' ? pad : p.valign === 'bottom' ? REF - pad - block : (REF - block) / 2;
        y += lh * 0.5 + px * 0.35; // baseline within the first line
        g.textAlign = p.align || 'center';
        const x = p.align === 'left' ? pad : p.align === 'right' ? W0 - pad : W0 / 2;
        lines.forEach((line) => { g.fillText(line, x, y); y += lh; });
        g.setTransform(1, 0, 0, 1, 0, 0);
        this.tex.needsUpdate = true;
        // A web font that is still loading draws in a fallback; redraw once it lands.
        if (!this.fontsWaited.has(font) && document.fonts?.load) {
            this.fontsWaited.add(font);
            document.fonts.load(font, p.text || 'A').then(() => { this.fontTick = (this.fontTick || 0) + 1; this.drawKey = null; }).catch(() => {});
        }
    }

    /**
     * Over the frame: stand the patch square to `camera`, just past its near
     * plane, at the frame position `p` asks for (frameX / frameY its middle,
     * 0..1 across and down; frameH a fraction of the frame's height; the
     * patch's own aspect is already the box's). Works for any projection,
     * off-centre ones (a solved camera's) included.
     */
    place2D(camera, p) {
        if (!camera || !this.mesh) return;
        const inv = camera.projectionMatrixInverse;
        const d = camera.isOrthographicCamera
            ? Math.max(camera.near + 1e-3, Math.min(camera.far * 0.5, camera.near + 0.01))
            : Math.min(camera.near * 4, (camera.near + camera.far) / 2);
        // The point at frame (x, y) on the plane d in front of the camera.
        const at = (x, y, out) => {
            const a = this.tmpA || (this.tmpA = new THREE.Vector3());
            const b = this.tmpB || (this.tmpB = new THREE.Vector3());
            a.set(x, y, -1).applyMatrix4(inv);
            b.set(x, y, 1).applyMatrix4(inv);
            const k = (-d - a.z) / ((b.z - a.z) || 1e-9);
            return out.copy(a).lerp(b, k);
        };
        const cx = (p.frameX ?? 0.5) * 2 - 1;
        const cy = 1 - (p.frameY ?? 0.5) * 2;
        const c = at(cx, cy, this.tmpC || (this.tmpC = new THREE.Vector3()));
        const up = at(cx, cy + 1, this.tmpD || (this.tmpD = new THREE.Vector3())).sub(c);
        // A frame unit (half its height) on that plane; the box is frameH of 2 units.
        const h = up.length() * 2 * Math.max(1e-4, p.frameH ?? 0.1);
        const m = this.place || (this.place = new THREE.Matrix4());
        const r = this.placeRot || (this.placeRot = new THREE.Matrix4());
        m.makeTranslation(c.x, c.y, c.z);
        r.makeRotationZ(-(p.frameRot || 0) * (Math.PI / 180));
        m.multiply(r);
        r.makeScale(h, h, h);
        m.multiply(r);
        m.premultiply(camera.matrixWorld);
        const parent = this.object.parent;
        if (parent) {
            parent.updateMatrixWorld(true);
            m.premultiply(r.copy(parent.matrixWorld).invert());
        }
        this.object.matrixAutoUpdate = false;
        this.object.matrix.copy(m);
        this.object.updateMatrixWorld(true);
    }

    /**
     * In the scene but square to `camera`: the patch turned about its
     * middle (or, `aboutOrigin`, about its parent's origin, so a label
     * stays to the same side of its point on screen) until it faces the
     * view, its top towards the camera's up.
     */
    face(camera, aboutOrigin = false) {
        const c = this.op.corners;
        if (!camera || !this.mesh || !c || c.length < 4) return;
        const V = (i) => new THREE.Vector3().fromArray(c[i]);
        const x = V(1).sub(V(0));
        const y = V(0).sub(V(3));
        if (x.lengthSq() < 1e-12 || y.lengthSq() < 1e-12) return;
        x.normalize();
        const z = new THREE.Vector3().crossVectors(x, y).normalize();
        if (z.lengthSq() < 1e-12) return;
        y.crossVectors(z, x);
        const own = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
        const parent = this.object.parent;
        const pq = new THREE.Quaternion();
        if (parent) {
            parent.updateWorldMatrix(true, false);
            parent.getWorldQuaternion(pq);
        }
        camera.updateMatrixWorld();
        const cq = camera.getWorldQuaternion(new THREE.Quaternion());
        // In the parent's frame: undo the parent's turn and the patch's own, then take the camera's.
        const q = pq.invert().multiply(cq).multiply(own.invert());
        const mid = aboutOrigin ? new THREE.Vector3() : V(0).add(V(1)).add(V(2)).add(V(3)).multiplyScalar(0.25);
        const m = this.place || (this.place = new THREE.Matrix4());
        m.makeTranslation(mid.x, mid.y, mid.z)
            .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
            .multiply(new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z));
        this.object.matrixAutoUpdate = false;
        this.object.matrix.copy(m);
        this.object.updateMatrixWorld(true);
    }

    /** Back in the scene: the patch's corners place it again. */
    unplace2D() {
        if (this.object.matrixAutoUpdate) return;
        this.object.matrixAutoUpdate = true;
        this.object.position.set(0, 0, 0);
        this.object.quaternion.identity();
        this.object.scale.set(1, 1, 1);
        this.object.updateMatrixWorld(true);
    }

    /**
     * LaTeX, a line of TeX to each line of text, each typeset in display
     * style and stacked: line height spaces them as it would plain lines,
     * but a tall line (a fraction, a matrix) gets the room it needs.
     */
    drawLatex(g, p, em, pad, W, H) {
        const lines = String(p.text || '').split('\n');
        const boxes = lines.map((l) => (l.trim() ? texLayout(l) : { width: 0, ascent: 0.75, descent: 0.25, ops: [] }));
        if (boxes.some((b) => !b)) {
            // MathJax is loading: draw once it's here.
            loadTex().then(() => { this.drawKey = null; }).catch(() => { this.drawKey = null; });
            return;
        }
        const gap = Math.max(0, (p.lineHeight || 1.15) - 1) * em;
        const block = boxes.reduce((a, b) => a + (b.ascent + b.descent) * em, 0) + gap * Math.max(0, boxes.length - 1);
        let y = p.valign === 'top' ? pad : p.valign === 'bottom' ? H - pad - block : (H - block) / 2;
        boxes.forEach((b) => {
            y += b.ascent * em;
            const w = b.width * em;
            const x = p.align === 'left' ? pad : p.align === 'right' ? W - pad - w : (W - w) / 2;
            drawTex(g, b, x, y, em, p.color || '#ffffff');
            y += b.descent * em + gap;
        });
    }

    /** The timeline's time, for grain that moves. */
    setTime(t) { this.noise.textTime.value = t || 0; }

    /** The scan's depth from the camera (or null), and the drawing buffer's size. */
    setScanDepth(tex, size) {
        const on = !!tex && !!this.op.hideBehindScan;
        this.occlusion.tScanDepth.value = tex;
        this.occlusion.scanOcclude.value = on ? 1 : 0;
        this.occlusion.scanRes.value.copy(size);
    }

    dispose() {
        this.mesh?.removeFromParent();
        this.mesh?.geometry.dispose();
        [this.basic, this.lit, this.depth].forEach((m) => m.dispose());
        this.tex.dispose();
        this.object.removeFromParent();
    }
}
