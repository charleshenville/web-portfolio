// Mesh edit mode: fill the holes in a take's scan and cut junk out of it,
// in the viewport. The edits themselves are data (model/meshEdits.js), kept
// per scan by the host and put on the scan by its rig; this draws what there
// is to edit over the picture and turns clicks into new edit documents.
//
// Tools (keys 1-4):
//   Connect  click vertices in order round a gap; Enter (or F) fills the
//            polygon they make, Shift+Enter fills it round a new centre
//            point. Clicking the first vertex again closes and fills it.
//   Hole     click an open edge to take the whole hole it is on; Enter fills.
//   Move     drag a vertex, across the screen at its depth.
//   Erase    drag to cut away the triangles under the brush ([ and ] size it).
// Alt-drag orbits with any tool; Backspace drops the chain's last point, Esc
// clears it (and leaves the mode when there is nothing to clear).
//
// Picking reads an id buffer: every triangle drawn in its own colour from the
// view being edited, so what is under the cursor is what you see, holes and
// all, and a brush takes only the faces in front.

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LAYER } from '../../../lib/scanAssets/windows';
import {
    topology, traceLoop, chainWinding, withFaces, withVertex, withoutFaces, withMoved, partOfVertex, EMPTY_EDITS,
} from '../model/meshEdits';

export const PICK_LAYER = 20;
export const MESH_TOOLS = [
    ['connect', 'Connect', '1', 'Click vertices round a gap, then Enter to fill them'],
    ['hole', 'Hole', '2', 'Click a hole’s open edge to take all of it, then Enter to fill'],
    ['move', 'Move', '3', 'Drag a vertex'],
    ['erase', 'Erase', '4', 'Drag to cut away the triangles under the brush'],
];

const SNAP_PX = 14; // how near (CSS px) a vertex or edge has to be to take it
const COLORS = {
    open: 0xff5a36, chain: 0xffd34d, first: 0x6dffa8, hover: 0xffffff, loop: 0x4dd8ff, added: 0x5dff9a, erase: 0xff3355,
};

const CLAY_VERT = /* glsl */`
varying vec3 vView;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
}`;
// Flat, lit from the eye, so every triangle reads; a triangle seen from
// behind is tinted, so one filled the wrong way round shows.
const CLAY_FRAG = /* glsl */`
uniform vec3 color;
uniform vec3 backColor;
uniform float opacity;
varying vec3 vView;
void main() {
    vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
    float l = abs(dot(n, normalize(-vView)));
    vec3 c = gl_FrontFacing ? color : backColor;
    gl_FragColor = vec4(c * (0.3 + 0.7 * l), opacity);
}`;

const PICK_VERT = /* glsl */`
attribute vec3 fid;
varying vec3 vId;
void main() {
    vId = fid;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const PICK_FRAG = /* glsl */`
varying vec3 vId;
void main() { gl_FragColor = vec4(vId, 1.0); }`;

// Round points of a fixed size in pixels, on top of everything.
const DOT_VERT = /* glsl */`
uniform float size;
attribute vec3 dotColor;
varying vec3 vColor;
void main() {
    vColor = dotColor;
    gl_PointSize = size;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const DOT_FRAG = /* glsl */`
varying vec3 vColor;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    // A dark rim, so a dot reads on a light wall as well as a dark one.
    gl_FragColor = vec4(r > 0.72 ? vColor * 0.25 : vColor, 1.0);
}`;

const lineMat = (color, width, opts = {}) => new LineMaterial({
    color, linewidth: width, transparent: true, depthWrite: false,
    // Lines lie on the surface they edge: pulled forward a little so the shell doesn't hide them.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    ...opts,
});

export class MeshEditor {
    constructor(engine) {
        this.engine = engine;
        this.rig = null;
        this.tool = 'connect';
        this.chain = []; // vertex indices, in order
        this.hover = null; // { kind: 'vertex', v } | { kind: 'edge', a, b, loop } | { kind: 'faces', faces }
        this.opacity = 0.55;
        this.xray = true;
        this.brush = 22; // CSS px
        this.history = new Map(); // fingerprint -> { past, future }
        this.listeners = new Set();
        this.active = false;
        this.topo = null;
        this.topoKey = null;
        this.posVersion = -1;
        this.stroke = null;
        this.pointer = null;
        this.status = '';

        const g = new THREE.Group();
        g.name = 'meshEditor';
        this.group = g;
        this.clay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
            vertexShader: CLAY_VERT,
            fragmentShader: CLAY_FRAG,
            uniforms: {
                color: { value: new THREE.Color(0xc9ccd6) }, backColor: { value: new THREE.Color(0xd2557a) }, opacity: { value: this.opacity },
            },
            transparent: true,
            side: THREE.DoubleSide,
        }));
        this.clay.renderOrder = -10;
        this.added = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
            color: COLORS.added, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
        }));
        this.added.renderOrder = -9;
        this.doomed = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
            color: COLORS.erase, transparent: true, opacity: 0.6, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        }));
        this.doomed.renderOrder = -8;
        const openGeo = new LineSegmentsGeometry();
        this.openLines = new LineSegments2(openGeo, lineMat(COLORS.open, 2.5));
        this.openXray = new LineSegments2(openGeo, lineMat(COLORS.open, 1.5, { depthTest: false, opacity: 0.28 }));
        this.openLines.renderOrder = 2;
        this.openXray.renderOrder = 1;
        this.loopLines = new LineSegments2(new LineSegmentsGeometry(), lineMat(COLORS.loop, 3, { depthTest: false }));
        this.loopLines.renderOrder = 3;
        this.chainLines = new LineSegments2(new LineSegmentsGeometry(), lineMat(COLORS.chain, 2.5, { depthTest: false }));
        this.chainLines.renderOrder = 4;
        this.dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
            vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, uniforms: { size: { value: 9 } }, depthTest: false, depthWrite: false, transparent: true,
        }));
        this.dots.renderOrder = 5;
        [this.clay, this.added, this.doomed, this.openLines, this.openXray, this.loopLines, this.chainLines, this.dots].forEach((o) => {
            o.frustumCulled = false;
            o.layers.set(LAYER.OVERLAY);
            g.add(o);
        });
        this.pick = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
            vertexShader: PICK_VERT, fragmentShader: PICK_FRAG, side: THREE.DoubleSide,
        }));
        this.pick.frustumCulled = false;
        this.pick.layers.set(PICK_LAYER);
        g.add(this.pick);
        g.visible = false;

        this.onMove = (e) => this.pointerMove(e);
        this.onDown = (e) => this.pointerDown(e);
        this.onLeave = () => { this.pointer = null; this.setHover(null); this.placeBrush(); };
    }

    /** Listen for changes the panel shows. Returns the unsubscribe. */
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    changed() { this.listeners.forEach((fn) => fn()); }

    mount(stage) {
        this.stage = stage;
        // Captured on the stage, ahead of the canvas, so a drag the tool takes never orbits.
        stage.addEventListener('pointerdown', this.onDown, true);
        stage.addEventListener('pointermove', this.onMove);
        stage.addEventListener('pointerleave', this.onLeave);
        this.brushEl = document.createElement('div');
        Object.assign(this.brushEl.style, {
            position: 'absolute', pointerEvents: 'none', border: '1px solid #ff5577', borderRadius: '50%', display: 'none', boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
        });
        stage.appendChild(this.brushEl);
    }

    dispose() {
        this.stage?.removeEventListener('pointerdown', this.onDown, true);
        this.stage?.removeEventListener('pointermove', this.onMove);
        this.stage?.removeEventListener('pointerleave', this.onLeave);
        this.brushEl?.remove();
        this.group.removeFromParent();
        // (The shell draws the scan's own geometry: that is the rig's to dispose.)
        this.group.traverse((o) => { if (o !== this.clay) o.geometry?.dispose(); o.material?.dispose?.(); });
        this.pickRT?.dispose();
    }

    // ---- What is being edited ------------------------------------------------------------

    get fp() { return this.rig?.fingerprint || null; }

    get doc() { return (this.fp && this.engine.meshEdits?.()[this.fp]?.doc) || EMPTY_EDITS; }

    get hist() {
        if (!this.fp) return { past: [], future: [] };
        if (!this.history.has(this.fp)) this.history.set(this.fp, { past: [], future: [] });
        return this.history.get(this.fp);
    }

    /**
     * Each frame: `rig` is the take being edited when it is in view (null
     * when it isn't, or the mode is off), `cam` what it is seen through.
     */
    frame(rig, cam, drawSize) {
        const on = !!rig?.mesh && !!rig.base;
        const target = on ? rig : null;
        if (target !== this.rig) {
            this.chain = [];
            this.chainClosed = false;
            this.hover = null;
            this.topo = null;
            this.topoKey = null;
            this.posVersion = -1;
            this.pickDirty = true;
            this.chainKey = null;
            this.stroke = null;
            if (target) target.root.add(this.group); else this.group.removeFromParent();
            this.rig = target;
            this.active = on;
            this.placeBrush();
            this.changed();
        }
        this.group.visible = on;
        if (!on) return;
        this.cam = cam;
        this.sync();
        const res = drawSize;
        [this.openLines, this.openXray, this.loopLines, this.chainLines].forEach((l) => l.material.resolution.set(res.x, res.y));
        this.openXray.visible = this.xray;
        const pr = this.engine.renderer.getPixelRatio();
        this.dots.material.uniforms.size.value = 9 * pr;
        [this.openLines, this.openXray, this.loopLines, this.chainLines].forEach((l) => {
            l.material.linewidth = (l === this.openXray ? 1.5 : l === this.openLines ? 2.5 : 3) * pr;
        });
        this.clay.material.uniforms.opacity.value = this.opacity;
        this.clay.visible = this.opacity > 0.001;
        // Fully see-through, it still hides the open edges behind the scan.
        this.clay.material.colorWrite = this.opacity > 0.001;
    }

    /** Bring what is drawn in step with the scan's geometry. */
    sync() {
        const geo = this.rig.mesh.geometry;
        const doc = this.rig.editsApplied || EMPTY_EDITS;
        // The topology changes with the triangles, not with a vertex moved.
        const key = `${this.rig.fingerprint}|${doc.add.length}|${doc.remove.length}|${doc.verts.length}|${this.rig.editsApplied ? 1 : 0}`;
        // (Not while a brush is being dragged: that waits for it to end.)
        const fresh = !this.stroke && (key !== this.topoKey || !this.topo || this.topoDoc?.add !== doc.add || this.topoDoc?.remove !== doc.remove);
        if (fresh) {
            this.topo = topology(geo.index.array, this.rig.welded(), geo.getAttribute('position').count);
            this.topoKey = key;
            this.topoDoc = doc;
            this.hover = null;
            // A chain survives edits that leave its vertices be.
            const n = geo.getAttribute('position').count;
            this.chain = this.chain.filter((v) => v < n);
            this.changed();
        }
        if (fresh || this.posVersion !== this.rig.geoVersion) {
            this.posVersion = this.rig.geoVersion;
            this.clay.geometry = geo;
            const pos = geo.getAttribute('position');
            // Made triangles, tinted. (Copied out: a geometry sharing the
            // scan's buffers would take them off the GPU when disposed.)
            const ids = geo.userData.faceIds;
            const fb = this.rig.base.index.length / 3;
            const made = [];
            for (let f = 0; f < ids.length; f++) if (ids[f] >= fb) made.push(f);
            this.added.geometry.dispose();
            this.added.geometry = this.facesGeometry(made);
            // Open edges.
            const open = this.topo.open;
            const flat = new Float32Array(open.length * 3);
            for (let i = 0; i < open.length; i++) flat.set([pos.getX(open[i]), pos.getY(open[i]), pos.getZ(open[i])], i * 3);
            this.setLines(this.openLines, flat);
            this.pickDirty = true;
            this.chainKey = null;
        }
        this.drawChain();
    }

    /** Triangles of the scan (by index now) as a geometry of their own. */
    facesGeometry(faces, index = this.rig.mesh.geometry.index.array) {
        const pos = this.rig.mesh.geometry.getAttribute('position').array;
        const out = new Float32Array(faces.length * 9);
        faces.forEach((f, i) => {
            for (let k = 0; k < 3; k++) {
                const v = index[f * 3 + k];
                out.set([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], i * 9 + k * 3);
            }
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(out, 3));
        return g;
    }

    setLines(line, flat) {
        line.visible = flat.length >= 6;
        if (!line.visible) return;
        line.geometry.dispose();
        const g = new LineSegmentsGeometry();
        g.setPositions(flat);
        line.geometry = g;
        if (line === this.openLines) this.openXray.geometry = g;
    }

    vpos(v, out = new THREE.Vector3()) {
        const p = this.rig.mesh.geometry.getAttribute('position');
        return out.set(p.getX(v), p.getY(v), p.getZ(v));
    }

    /** The chain, the hovered thing and the brush's faces, as they are now. */
    drawChain() {
        const h0 = this.hover;
        const key = [this.chain.join(','), this.chainClosed, this.tool, this.posVersion, h0?.kind, h0?.v, h0?.a, h0?.b, h0?.loop?.length, h0?.faces?.join(',')].join('|');
        if (key === this.chainKey) return;
        this.chainKey = key;
        const segs = [];
        const push = (a, b) => { const A = this.vpos(a); const B = this.vpos(b); segs.push(A.x, A.y, A.z, B.x, B.y, B.z); };
        for (let i = 0; i + 1 < this.chain.length; i++) push(this.chain[i], this.chain[i + 1]);
        const h = this.hover;
        const closing = this.chainClosed;
        if (closing && this.chain.length > 2) push(this.chain[this.chain.length - 1], this.chain[0]);
        if (this.tool === 'connect' && h?.kind === 'vertex' && this.chain.length && !closing) push(this.chain[this.chain.length - 1], h.v);
        this.setLines(this.chainLines, new Float32Array(segs));

        // The hole under the cursor (Hole tool).
        const loop = [];
        if (h?.kind === 'edge' && h.loop) {
            const L = h.loop;
            for (let i = 0; i < L.length; i++) {
                const A = this.vpos(this.topo.rep[L[i]]);
                const B = this.vpos(this.topo.rep[L[(i + 1) % L.length]]);
                loop.push(A.x, A.y, A.z, B.x, B.y, B.z);
            }
        } else if (h?.kind === 'edge') {
            const A = this.vpos(h.a);
            const B = this.vpos(h.b);
            loop.push(A.x, A.y, A.z, B.x, B.y, B.z);
        }
        this.setLines(this.loopLines, new Float32Array(loop));

        const pts = [];
        const cols = [];
        const c = new THREE.Color();
        const dot = (v, color) => { const P = this.vpos(v); pts.push(P.x, P.y, P.z); c.set(color); cols.push(c.r, c.g, c.b); };
        this.chain.forEach((v, i) => dot(v, i === 0 ? COLORS.first : COLORS.chain));
        if (h?.kind === 'vertex') dot(h.v, COLORS.hover);
        const dg = this.dots.geometry;
        dg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        dg.setAttribute('dotColor', new THREE.Float32BufferAttribute(cols, 3));
        this.dots.visible = pts.length > 0;

        const doomed = h?.kind === 'faces' ? h.faces : [];
        this.doomed.geometry.dispose();
        this.doomed.geometry = this.facesGeometry(doomed, this.pickIndex || undefined);
        this.doomed.visible = doomed.length > 0;
    }

    // ---- Picking -------------------------------------------------------------------------------

    /** The id buffer, drawn again only when the view or the scan has changed. */
    ensurePick() {
        const r = this.engine.renderer;
        const size = r.getDrawingBufferSize(new THREE.Vector2());
        if (!this.pickRT || this.pickRT.width !== size.x || this.pickRT.height !== size.y) {
            this.pickRT?.dispose();
            this.pickRT = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: true });
            this.pickKey = null;
        }
        const geo = this.rig.mesh.geometry;
        // Mid-stroke it stays as the stroke began, so a brush doesn't eat
        // through to what was behind what it just cut.
        if (!this.stroke && (this.pickDirty || this.pickGeo !== geo || this.pickVersion !== this.rig.geoVersion)) {
            // Every triangle on its own, its colour its index (+1, 0 being nothing).
            const pos = geo.getAttribute('position').array;
            const index = geo.index.array;
            const nf = index.length / 3;
            const P = new Float32Array(nf * 9);
            const C = new Uint8Array(nf * 9);
            for (let f = 0; f < nf; f++) {
                const id = f + 1;
                for (let k = 0; k < 3; k++) {
                    const v = index[f * 3 + k];
                    P[f * 9 + k * 3] = pos[v * 3];
                    P[f * 9 + k * 3 + 1] = pos[v * 3 + 1];
                    P[f * 9 + k * 3 + 2] = pos[v * 3 + 2];
                    C[f * 9 + k * 3] = id & 255;
                    C[f * 9 + k * 3 + 1] = (id >> 8) & 255;
                    C[f * 9 + k * 3 + 2] = (id >> 16) & 255;
                }
            }
            const pg = new THREE.BufferGeometry();
            pg.setAttribute('position', new THREE.BufferAttribute(P, 3));
            pg.setAttribute('fid', new THREE.BufferAttribute(C, 3, true));
            this.pick.geometry.dispose();
            this.pick.geometry = pg;
            this.pickGeo = geo;
            this.pickIndex = index;
            this.pickFaceIds = geo.userData.faceIds;
            this.pickVersion = this.rig.geoVersion;
            this.pickDirty = false;
            this.pickKey = null;
        }
        const cam = this.cam;
        this.rig.root.updateMatrixWorld(true);
        const key = [...cam.matrixWorld.elements, ...cam.projectionMatrix.elements, ...this.rig.root.matrixWorld.elements].join(',');
        if (key === this.pickKey) return;
        this.pickKey = key;
        const mask = cam.layers.mask;
        const was = r.getRenderTarget();
        const clear = r.getClearColor(new THREE.Color());
        const alpha = r.getClearAlpha();
        cam.layers.set(PICK_LAYER);
        r.setRenderTarget(this.pickRT);
        r.setClearColor(0x000000, 0);
        r.clear();
        r.render(this.engine.scene, cam);
        r.setRenderTarget(was);
        r.setClearColor(clear, alpha);
        cam.layers.mask = mask;
    }

    /**
     * The triangles (by index in the geometry the id buffer was drawn from,
     * this.pickIndex) seen within `rad` CSS px of client point (x, y): in the
     * square round it, or with `round` the circle.
     */
    facesAround(x, y, rad, round = false) {
        this.ensurePick();
        const box = this.engine.renderer.domElement.getBoundingClientRect();
        const k = this.pickRT.width / box.width;
        const cx = Math.round((x - box.left) * k);
        const cy = Math.round(this.pickRT.height - (y - box.top) * k);
        const R = Math.max(1, Math.round(rad * k));
        const x0 = Math.max(0, cx - R);
        const y0 = Math.max(0, cy - R);
        const x1 = Math.min(this.pickRT.width - 1, cx + R);
        const y1 = Math.min(this.pickRT.height - 1, cy + R);
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        if (w <= 0 || h <= 0) return new Set();
        const buf = new Uint8Array(w * h * 4);
        this.engine.renderer.readRenderTargetPixels(this.pickRT, x0, y0, w, h, buf);
        const out = new Set();
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                if (round && (x0 + i - cx) ** 2 + (y0 + j - cy) ** 2 > R * R) continue;
                const o = (j * w + i) * 4;
                const id = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
                if (id) out.add(id - 1);
            }
        }
        return out;
    }

    /** Where vertex v is on screen, in client px. */
    screenOf(v, box = this.engine.renderer.domElement.getBoundingClientRect()) {
        const p = this.vpos(v).applyMatrix4(this.rig.root.matrixWorld).project(this.cam);
        return { x: box.left + ((p.x + 1) / 2) * box.width, y: box.top + ((1 - p.y) / 2) * box.height, behind: p.z > 1 || p.z < -1 };
    }

    /** The vertex nearest the cursor among those of the triangles seen near it; open edges' first. */
    vertexNear(x, y) {
        const faces = this.facesAround(x, y, SNAP_PX * 1.6);
        const index = this.pickIndex;
        const box = this.engine.renderer.domElement.getBoundingClientRect();
        const seen = new Set();
        let best = null;
        const chainW = new Set(this.chain.map((v) => this.topo.wid(v)));
        faces.forEach((f) => {
            for (let k = 0; k < 3; k++) {
                const v = index[f * 3 + k];
                const w = this.topo.wid(v);
                if (seen.has(w)) continue;
                seen.add(w);
                const s = this.screenOf(v, box);
                if (s.behind) continue;
                let d = Math.hypot(s.x - x, s.y - y);
                if (d > SNAP_PX) continue;
                // A vertex on a hole, or one in the chain, wins over a nearer one in the middle of the surface.
                if (this.topo.next.has(w) || chainW.has(w)) d *= 0.55;
                if (!best || d < best.d) best = { d, v: chainW.has(w) ? this.chain.find((c) => this.topo.wid(c) === w) : v };
            }
        });
        return best ? best.v : null;
    }

    /** The open edge nearest the cursor among those of the triangles seen near it. */
    edgeNear(x, y) {
        const faces = this.facesAround(x, y, SNAP_PX * 1.6);
        const index = this.pickIndex;
        const box = this.engine.renderer.domElement.getBoundingClientRect();
        const { wid, isOpen } = this.topo;
        let best = null;
        faces.forEach((f) => {
            for (let k = 0; k < 3; k++) {
                const a = index[f * 3 + k];
                const b = index[f * 3 + ((k + 1) % 3)];
                if (!isOpen(wid(a), wid(b))) continue;
                const A = this.screenOf(a, box);
                const B = this.screenOf(b, box);
                if (A.behind || B.behind) continue;
                const dx = B.x - A.x;
                const dy = B.y - A.y;
                const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
                const d = Math.hypot(A.x + t * dx - x, A.y + t * dy - y);
                if (d <= SNAP_PX && (!best || d < best.d)) best = { d, a, b };
            }
        });
        return best;
    }

    // ---- Pointer ----------------------------------------------------------------------------------

    setHover(h) {
        const was = this.hover;
        this.hover = h;
        if ((was?.kind || null) !== (h?.kind || null) || was?.loop?.length !== h?.loop?.length) this.changed();
        this.engine.dirty = true;
    }

    placeBrush() {
        const el = this.brushEl;
        if (!el) return;
        const show = this.active && this.tool === 'erase' && !!this.pointer;
        el.style.display = show ? 'block' : 'none';
        if (!show) return;
        const box = this.stage.getBoundingClientRect();
        Object.assign(el.style, {
            left: `${this.pointer.x - box.left - this.brush}px`,
            top: `${this.pointer.y - box.top - this.brush}px`,
            width: `${this.brush * 2}px`,
            height: `${this.brush * 2}px`,
        });
    }

    pointerMove(e) {
        if (!this.active) return;
        this.pointer = { x: e.clientX, y: e.clientY, alt: e.altKey };
        this.placeBrush();
        if (this.stroke || e.buttons) return; // a drag: the stroke (or the orbit) has it
        if (this.hoverQueued) return;
        this.hoverQueued = true;
        requestAnimationFrame(() => {
            this.hoverQueued = false;
            this.updateHover();
        });
    }

    updateHover() {
        if (!this.active || !this.pointer || !this.topo || !this.cam) return;
        const { x, y } = this.pointer;
        if (this.tool === 'connect' || this.tool === 'move') {
            const v = this.vertexNear(x, y);
            this.setHover(v == null ? null : { kind: 'vertex', v });
        } else if (this.tool === 'hole') {
            const e = this.edgeNear(x, y);
            if (!e) { this.setHover(null); return; }
            const { wid } = this.topo;
            const same = this.hover?.kind === 'edge' && this.hover.loop && this.hover.loopSet?.has(wid(e.a)) && this.hover.loopSet.has(wid(e.b));
            const loop = same ? this.hover.loop : traceLoop(this.topo, wid(e.a), wid(e.b));
            this.setHover({ kind: 'edge', a: e.a, b: e.b, loop, loopSet: same ? this.hover.loopSet : new Set(loop || []) });
        } else if (this.tool === 'erase') {
            const faces = Array.from(this.facesAround(x, y, this.brush, true));
            this.setHover(faces.length ? { kind: 'faces', faces } : null);
        }
    }

    pointerDown(e) {
        if (!this.active || e.button !== 0 || e.altKey) return;
        this.pointer = { x: e.clientX, y: e.clientY };
        this.updateHover();
        const h = this.hover;
        if (this.tool === 'erase' || (this.tool === 'move' && h?.kind === 'vertex')) {
            // The tool's drag, not the camera's.
            e.stopPropagation();
            e.preventDefault();
            this.beginStroke(e);
            return;
        }
        // Clicks: a drag still orbits.
        const x0 = e.clientX;
        const y0 = e.clientY;
        const up = (ev) => {
            window.removeEventListener('pointerup', up);
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) return;
            this.click();
        };
        window.addEventListener('pointerup', up);
    }

    click() {
        const h = this.hover;
        if (this.tool === 'connect') {
            if (h?.kind !== 'vertex') return;
            const w = this.topo.wid(h.v);
            const at = this.chain.findIndex((v) => this.topo.wid(v) === w);
            if (at === 0 && this.chain.length >= 3) { this.fill(false); return; }
            if (at >= 0) return;
            this.chain = [...this.chain, h.v];
            this.chainClosed = false;
        } else if (this.tool === 'hole') {
            if (h?.kind !== 'edge') return;
            if (!h.loop) { this.status = 'That hole runs into another and doesn’t close: connect it by hand.'; this.changed(); return; }
            this.chain = h.loop.map((w) => this.topo.rep[w]);
            this.chainClosed = true;
        }
        this.status = '';
        this.engine.dirty = true;
        this.changed();
    }

    beginStroke(e) {
        const before = this.doc;
        const id = e.pointerId;
        this.stroke = { before, doc: before, v: this.hover?.kind === 'vertex' ? this.hover.v : null };
        if (this.tool === 'move') {
            // Across the screen, at the vertex's depth.
            const p = this.vpos(this.stroke.v).applyMatrix4(this.rig.root.matrixWorld);
            const n = this.cam.getWorldDirection(new THREE.Vector3());
            this.stroke.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
        } else {
            this.eraseAt(e.clientX, e.clientY);
        }
        let queued = false;
        let last = null;
        const move = (ev) => {
            if (ev.pointerId !== id) return;
            last = ev;
            this.pointer = { x: ev.clientX, y: ev.clientY };
            this.placeBrush();
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                if (!this.stroke || !last) return;
                if (this.tool === 'move') this.moveTo(last.clientX, last.clientY);
                else this.eraseAt(last.clientX, last.clientY);
            });
        };
        const up = (ev) => {
            if (ev.pointerId !== id) return;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            const s = this.stroke;
            this.stroke = null;
            if (s && s.doc !== s.before) this.commit(s.doc, { before: s.before });
            this.updateHover();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    eraseAt(x, y) {
        const faces = this.facesAround(x, y, this.brush, true);
        if (!faces.size) return;
        const ids = this.pickFaceIds;
        const doc = withoutFaces(this.stroke.doc, this.rig.base, Array.from(faces, (f) => ids[f]));
        this.stroke.doc = doc;
        this.hover = null;
        this.commit(doc, { live: true });
    }

    moveTo(x, y) {
        const box = this.engine.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((x - box.left) / box.width) * 2 - 1, -((y - box.top) / box.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.cam);
        const hit = ray.ray.intersectPlane(this.stroke.plane, new THREE.Vector3());
        if (!hit) return;
        const local = this.rig.root.worldToLocal(hit);
        const doc = withMoved(this.stroke.doc, this.rig.base, this.stroke.v, local.toArray());
        this.stroke.doc = doc;
        this.hover = { kind: 'vertex', v: this.stroke.v };
        this.commit(doc, { live: true });
    }

    // ---- Edits -------------------------------------------------------------------------------------

    /**
     * Hand a new edit document to the host. `live` while a drag goes on (no
     * undo step, not saved yet); `before` the document an undo step returns to
     * (the current one if not given).
     */
    commit(doc, { live = false, before = null, history = true } = {}) {
        if (!this.fp) return;
        if (!live && history) {
            const h = this.hist;
            h.past.push(before || this.doc);
            if (h.past.length > 200) h.past.shift();
            h.future = [];
        }
        this.engine.emit('meshEdit', { fp: this.fp, take: this.rig.take, doc, save: !live });
        this.engine.dirty = true;
        this.changed();
    }

    undo() {
        const h = this.hist;
        if (!h.past.length) return false;
        h.future.push(this.doc);
        this.commit(h.past.pop(), { history: false });
        return true;
    }

    redo() {
        const h = this.hist;
        if (!h.future.length) return false;
        h.past.push(this.doc);
        this.commit(h.future.pop(), { history: false });
        return true;
    }

    reset() {
        if (this.doc === EMPTY_EDITS) return;
        this.commit(EMPTY_EDITS);
        this.chain = [];
    }

    /**
     * Fill the chain: as a polygon (ear-clipped in the plane that fits it
     * best), or round a new vertex at its middle (better for a hole that
     * isn't flat: pull the middle into place with Move after).
     */
    fill(centre) {
        const chain = this.chain;
        if (!this.rig || chain.length < 3) return false;
        const { topo } = this;
        const P = chain.map((v) => this.vpos(v));
        // Its plane: the Newell normal, which follows the chain's own order.
        const nrm = new THREE.Vector3();
        for (let i = 0; i < P.length; i++) {
            const a = P[i];
            const b = P[(i + 1) % P.length];
            nrm.x += (a.y - b.y) * (a.z + b.z);
            nrm.y += (a.z - b.z) * (a.x + b.x);
            nrm.z += (a.x - b.x) * (a.y + b.y);
        }
        const mid = P.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / P.length);
        if (nrm.lengthSq() < 1e-20) nrm.copy(this.cam.position).sub(this.rig.root.localToWorld(mid.clone()));
        nrm.normalize();
        // Which way the new faces face: as the triangles round the hole do,
        // or, touching no hole, towards the camera. Decided once for the
        // whole fill (a triangle at a time, a hole that isn't flat would come
        // out patchy): `keep` makes triangles in the chain's own order, whose
        // normal is the Newell normal's way.
        const vote = chainWinding(topo, chain.map((v) => topo.wid(v)), true);
        let keep = vote > 0;
        if (vote === 0) {
            const eye = this.rig.root.worldToLocal(this.cam.getWorldPosition(new THREE.Vector3())).sub(mid);
            keep = nrm.dot(eye) >= 0;
        }
        const orient = (t) => (keep ? t : [t[0], t[2], t[1]]);

        let doc = this.doc;
        const tris = [];
        if (centre) {
            const base = this.rig.base;
            const uv = [0, 0];
            const votes = new Map();
            chain.forEach((v) => {
                if (base.uv && v < base.pos.length / 3) { uv[0] += base.uv[v * 2] / chain.length; uv[1] += base.uv[v * 2 + 1] / chain.length; }
                const p = partOfVertex(base, v, doc);
                votes.set(p, (votes.get(p) || 0) + 1);
            });
            const part = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
            const made = withVertex(doc, base, mid.toArray(), uv, part);
            doc = made.doc;
            for (let i = 0; i < chain.length; i++) tris.push(orient([made.v, chain[i], chain[(i + 1) % chain.length]]));
        } else {
            // Into the plane, and ear-clipped there. (u, w, nrm) is
            // right-handed, so the chain's order runs anticlockwise in (u, w).
            const u = new THREE.Vector3();
            if (Math.abs(nrm.x) < 0.9) u.set(1, 0, 0); else u.set(0, 1, 0);
            u.cross(nrm).normalize();
            const w = nrm.clone().cross(u);
            const flat = P.map((p) => new THREE.Vector2(p.clone().sub(mid).dot(u), p.clone().sub(mid).dot(w)));
            const area = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            const out = THREE.ShapeUtils.triangulateShape(flat.map((q) => q.clone()), []);
            const n = chain.length;
            const next = (i) => (i + 1) % n;
            out.forEach(([a, b, c]) => {
                // Each in the chain's order: a triangle on the rim by the
                // chain's edge it has (exact, where the plane folds the
                // outline over itself), any other by its turn in the plane.
                let t = area(flat[a], flat[b], flat[c]) >= 0 ? [a, b, c] : [a, c, b];
                for (let k = 0; k < 3; k++) {
                    const x = t[k];
                    const y = t[(k + 1) % 3];
                    if (next(x) === y) break; // has a chain edge forwards: right
                    if (next(y) === x) { t = [t[0], t[2], t[1]]; break; } // backwards: turn it
                }
                tris.push(orient(t.map((k) => chain[k])));
            });
            if (!tris.length) { this.status = 'Couldn’t fill that shape: try it in smaller pieces.'; this.changed(); return false; }
        }
        this.commit(withFaces(doc, tris));
        this.chain = [];
        this.chainClosed = false;
        this.status = `Filled ${tris.length} triangle${tris.length === 1 ? '' : 's'}.`;
        this.changed();
        return true;
    }

    setTool(t) {
        this.tool = t;
        this.hover = null;
        this.placeBrush();
        this.updateHover();
        this.engine.dirty = true;
        this.changed();
    }

    set(patch) {
        Object.assign(this, patch);
        this.placeBrush();
        this.engine.dirty = true;
        this.changed();
    }

    clearChain() {
        if (!this.chain.length) return false;
        this.chain = [];
        this.chainClosed = false;
        this.engine.dirty = true;
        this.changed();
        return true;
    }

    /** A key while the mode is on; true when it was the editor's. */
    key(e) {
        if (!this.active) return false;
        const k = e.key;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && k.toLowerCase() === 'z') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
        if (mod) return false;
        const tool = MESH_TOOLS.find(([, , key]) => key === k);
        if (tool) { this.setTool(tool[0]); return true; }
        if (k === 'Enter' || ((k === 'f' || k === 'F') && this.chain.length >= 3)) { this.fill(e.shiftKey); return true; }
        if ((k === 'Backspace' || k === 'Delete') && this.chain.length) {
            this.chain = this.chain.slice(0, -1);
            this.chainClosed = false;
            this.engine.dirty = true;
            this.changed();
            return true;
        }
        if (k === 'Escape') {
            if (this.clearChain()) return true;
            this.engine.emit('meshEditExit');
            return true;
        }
        if (k === '[' || k === ']') {
            this.set({ brush: Math.max(3, Math.min(200, Math.round(this.brush * (k === '[' ? 0.8 : 1.25)))) });
            this.updateHover();
            return true;
        }
        return false;
    }
}
