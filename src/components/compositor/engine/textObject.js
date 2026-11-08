// Text in a scene: a patch between four corners (placed and shaped like a
// window) with the text drawn onto it. It can be lit by the sun and cast a
// shadow in the shape of its letters, not its box.

import * as THREE from 'three';
import { patchGeometry, quadAspect } from '../../../lib/scanAssets/props';

export const FONTS = [
    ['grotesk', 'Inter Tight (site)', "'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif"],
    ['mono', 'SF Mono (site)', "'SF Mono', ui-monospace, Menlo, Monaco, monospace"],
    ['helvetica', 'Helvetica', "'Helvetica Neue', Helvetica, Arial, sans-serif"],
    ['georgia', 'Georgia', 'Georgia, serif'],
    ['times', 'Times', "'Times New Roman', Times, serif"],
    ['courier', 'Courier', "'Courier New', Courier, monospace"],
    ['impact', 'Impact', 'Impact, Haettenschweiler, sans-serif'],
    ['custom', 'Other (by name)…', null],
];
const FONT = Object.fromEntries(FONTS.map(([id, , stack]) => [id, stack]));

/** The CSS font-family for a text object's parameters. */
export const fontStack = (p) => (p.fontFamily === 'custom' && p.fontCustom
    ? `"${p.fontCustom.replace(/"/g, '')}", sans-serif`
    : FONT[p.fontFamily] || FONT.grotesk);

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
        [this.basic, this.lit].forEach((m) => {
            m.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.occlusion);
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', '#include <common>\nuniform sampler2D tScanDepth;\nuniform float scanOcclude;\nuniform vec2 scanRes;')
                    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (scanOcclude > 0.5 && gl_FragCoord.z > texture2D(tScanDepth, gl_FragCoord.xy / scanRes).r + 1e-5) discard;');
            };
            m.customProgramCacheKey = () => 'text-scan-occlude';
        });
        this.mesh = null;
        this.geoKey = null;
        this.drawKey = null;
        this.op = {};
        this.fontsWaited = new Set();
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
        [this.lit, this.basic].forEach((m) => { m.opacity = Math.max(0, Math.min(1, p.opacity ?? 1)); });
        this.object.visible = p.visible !== false && (p.opacity ?? 1) > 0.002;
        this.draw(p, quadAspect(corners));
    }

    draw(p, aspect) {
        const h = Math.max(64, Math.round(p.resolution || 512));
        const w = Math.max(16, Math.round(h * aspect));
        const family = fontStack(p);
        const key = JSON.stringify([w, h, p.text, family, p.fontSize, p.weight, p.italic, p.color, p.align, p.valign,
            p.letterSpacing, p.lineHeight, p.bgColor, p.bgOpacity, p.padding, this.fontTick]);
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
        const px = Math.max(1, p.fontSize * h);
        const font = `${p.italic ? 'italic ' : ''}${p.weight || 400} ${px}px ${family}`;
        g.font = font;
        g.fillStyle = p.color || '#ffffff';
        g.textBaseline = 'alphabetic';
        const pad = (p.padding || 0) * h;
        const spacing = (p.letterSpacing || 0) * px;
        if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
        const lines = wrap(g, p.text, w - pad * 2, 'letterSpacing' in g ? spacing : 0);
        const lh = px * (p.lineHeight || 1.15);
        const block = lh * lines.length;
        let y = p.valign === 'top' ? pad : p.valign === 'bottom' ? h - pad - block : (h - block) / 2;
        y += lh * 0.5 + px * 0.35; // baseline within the first line
        g.textAlign = p.align || 'center';
        const x = p.align === 'left' ? pad : p.align === 'right' ? w - pad : w / 2;
        lines.forEach((line) => { g.fillText(line, x, y); y += lh; });
        this.tex.needsUpdate = true;
        // A web font that is still loading draws in a fallback; redraw once it lands.
        if (!this.fontsWaited.has(font) && document.fonts?.load) {
            this.fontsWaited.add(font);
            document.fonts.load(font, p.text || 'A').then(() => { this.fontTick = (this.fontTick || 0) + 1; this.drawKey = null; }).catch(() => {});
        }
    }

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
