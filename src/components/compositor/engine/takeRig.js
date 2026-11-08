// A take's scan in the compositor: its mesh, its sampled point cloud and its
// wireframe, loaded into the scene's root in the scan's own frame, plus the
// camera solve that films them. Ported from the scan compositor; the layer
// stack it had is now three objects (Points / Mesh / Wireframe), each with
// its own parameters, and the alignment nudge is the Take object's.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
    applyCloudReactivity, applyWireReactivity, buildWireTopology,
} from '../../../lib/audioScene';
import { LAYER } from '../../../lib/scanAssets/windows';
import { takeBase } from './media';
import { makeLookUniforms, setLookUniforms, hookLook } from '../../../lib/scanAssets/takeLooks';

export const ENV_LAYER = 1;
const D2R = Math.PI / 180;

const PULSE_DIRS = {
    up: [0, 1, 0], down: [0, -1, 0], right: [1, 0, 0], left: [-1, 0, 0], toward: [0, 0, 1], away: [0, 0, -1],
};

/** Interpolated camera pose from a solve at `time` seconds into the take. */
export function poseAt(time, track) {
    const frames = track?.frames;
    if (!frames || !frames.length) return null;
    const x = Math.max(0, Math.min(frames.length - 1, time * track.fps));
    const i0 = Math.floor(x);
    const i1 = Math.min(frames.length - 1, i0 + 1);
    const f = x - i0;
    const a = frames[i0];
    const b = frames[i1];
    const pos = new THREE.Vector3(a.p[0], a.p[1], a.p[2]);
    const quat = new THREE.Quaternion(a.q[0], a.q[1], a.q[2], a.q[3]);
    if (i1 !== i0 && f > 0) {
        pos.lerp(new THREE.Vector3(b.p[0], b.p[1], b.p[2]), f);
        quat.slerp(new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), f);
    }
    return { pos, quat, solved: a.solved && b.solved };
}

/**
 * The frustum from fx/fy/cx/cy, cropped to cover an output of `aspect`
 * (width / height) the way the footage is: an off-centre principal point is
 * a real shear, which a plain fov would slide the overlay across.
 */
export function applyIntrinsics(cam, intr, aspect = null) {
    const { fx, fy, cx, cy, width, height } = intr;
    const near = 0.005;
    const far = 200;
    let left = (-cx / fx) * near;
    let right = ((width - cx) / fx) * near;
    let top = (cy / fy) * near;
    let bottom = (-(height - cy) / fy) * near;
    const src = width / height;
    if (aspect && Math.abs(aspect - src) > 1e-3) {
        // Cover: keep the middle of the frame, crop the long side.
        const mx = (left + right) / 2;
        const my = (top + bottom) / 2;
        if (aspect > src) {
            const k = src / aspect;
            top = my + (top - my) * k;
            bottom = my + (bottom - my) * k;
        } else {
            const k = aspect / src;
            left = mx + (left - mx) * k;
            right = mx + (right - mx) * k;
        }
    }
    cam.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.near = near;
    cam.far = far;
    cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * fy)));
}

export class TakeRig {
    constructor(take, root, onChange) {
        this.take = take;
        this.root = root; // the scene's root: the alignment nudge moves it
        this.onChange = onChange;
        this.track = null;
        this.mesh = null;
        this.cloud = null;
        this.wire = null;
        this.wireLevel = null;
        this.occluder = null;
        this.catcher = null;
        this.envMesh = null;
        this.textured = null;
        this.status = 'loading';
        this.disposed = false;
        // The take's colour correction, shared by its textured mesh and its
        // scan-coloured points (lib/scanAssets/takeLooks).
        this.look = makeLookUniforms();
        // Points and wireframe swell and slide together, in their own frame.
        this.overlay = new THREE.Group();
        root.add(this.overlay);
        this.load();
    }

    async load() {
        const base = takeBase(this.take);
        const trackP = fetch(`${base.replace(/\/[^/]+$/, '')}/track.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        try {
            const [track, gltf, cloudGeo] = await Promise.all([
                trackP,
                new GLTFLoader().loadAsync(`${base}.glb`),
                new PLYLoader().loadAsync(`${base}.ply`),
            ]);
            if (this.disposed) return;
            let src = null;
            gltf.scene.updateMatrixWorld(true);
            gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
            if (!src) throw new Error('no mesh in GLB');
            const geo = src.geometry.clone();
            geo.applyMatrix4(src.matrixWorld);
            geo.computeVertexNormals();
            this.textured = src.material;
            hookLook(this.textured, this.look, 'map_fragment');
            this.mesh = new THREE.Mesh(geo, src.material);
            this.mesh.frustumCulled = false;
            this.root.add(this.mesh);

            // PLY colours are sRGB samples of the scan's texture; three takes
            // vertex colours as linear, so convert or the cloud reads bright.
            const colorAttr = cloudGeo.getAttribute('color');
            if (colorAttr) {
                const a = colorAttr.array;
                for (let i = 0; i < a.length; i++) a[i] = a[i] <= 0.04045 ? a[i] / 12.92 : ((a[i] + 0.055) / 1.055) ** 2.4;
                colorAttr.needsUpdate = true;
            }
            cloudGeo.computeBoundingSphere();
            this.cloudReact = {
                base: Float32Array.from(cloudGeo.getAttribute('position').array),
                dirs: null, dists: null, freqIndex: null, key: null, dirty: false,
            };
            const cloudMat = new THREE.PointsMaterial({ transparent: true });
            hookLook(cloudMat, this.look, 'color_fragment');
            this.cloud = new THREE.Points(cloudGeo, cloudMat);
            this.cloud.frustumCulled = false;
            this.overlay.add(this.cloud);

            this.buildCompanions();
            this.track = track || {
                fps: 30, frame_count: 1, solved_count: 0, frames: [],
                intrinsics: { aspect: 4 / 3, width: 1440, height: 1080, fx: 1200, fy: 1200, cx: 720, cy: 540 },
                unsolved: true,
            };
            this.status = this.track.unsolved ? 'unsolved' : 'ready';
        } catch (e) {
            this.status = `failed: ${e.message}`;
        }
        this.onChange?.();
    }

    /** Push a correction (or null for none) onto the scan's materials. */
    applyLook(look) { setLookUniforms(this.look, look); }

    get sphere() { return this.cloud?.geometry?.boundingSphere || null; }
    get duration() { return this.track ? this.track.frame_count / this.track.fps : 0; }

    // A depth-only copy (hides overlays behind the real object), a shadow
    // catcher, and an unlit copy only the models' reflections see.
    buildCompanions() {
        const g = this.mesh.geometry;
        this.occluder = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false }));
        this.occluder.frustumCulled = false;
        this.occluder.renderOrder = -1;
        this.occluder.visible = false;
        this.root.add(this.occluder);

        this.catcher = new THREE.Mesh(g, new THREE.ShadowMaterial({
            transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
        }));
        this.catcher.receiveShadow = true;
        this.catcher.frustumCulled = false;
        this.catcher.visible = false;
        this.root.add(this.catcher);

        const src = this.textured;
        this.envMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
            map: src?.map || null, color: src?.map ? 0xffffff : 0x808080, side: THREE.DoubleSide,
        }));
        this.envMesh.layers.set(ENV_LAYER);
        this.envMesh.frustumCulled = false;
        this.root.add(this.envMesh);
    }

    async loadWire(level, color) {
        if (this.wireLevel === level || this.wireLoading === level) return;
        this.wireLoading = level;
        try {
            const gltf = await new GLTFLoader().loadAsync(`${takeBase(this.take)}_wire_${level}.glb`);
            if (this.disposed || this.wireLoading !== level) return;
            let src = null;
            gltf.scene.updateMatrixWorld(true);
            gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
            if (!src) throw new Error('no mesh in wireframe GLB');
            const geo = src.geometry.clone();
            geo.applyMatrix4(src.matrixWorld);
            const topo = buildWireTopology(geo);
            geo.dispose();
            const flat = new Float32Array((topo.edges.length / 2) * 6);
            for (let i = 0; i < topo.edges.length / 2; i++) {
                const a = topo.edges[i * 2] * 3;
                const b = topo.edges[i * 2 + 1] * 3;
                flat.set([topo.positions[a], topo.positions[a + 1], topo.positions[a + 2],
                    topo.positions[b], topo.positions[b + 1], topo.positions[b + 2]], i * 6);
            }
            this.dropWire();
            const lineGeo = new LineSegmentsGeometry();
            lineGeo.setPositions(flat);
            const mat = new LineMaterial({ color: new THREE.Color(color), transparent: true, depthWrite: false, linewidth: 1 });
            this.wire = new LineSegments2(lineGeo, mat);
            this.wire.frustumCulled = false;
            this.wireEdges = topo.edges;
            this.wireBuffer = lineGeo.attributes.instanceStart.data;
            this.wireState = { base: topo.positions, dirs: null, dists: null, freqIndex: null, key: null, dirty: false, moved: null };
            this.overlay.add(this.wire);
            this.wireLevel = level;
        } catch (e) {
            this.wireLevel = null;
        }
        this.wireLoading = null;
        this.onChange?.();
    }

    dropWire() {
        if (!this.wire) return;
        this.wire.removeFromParent();
        this.wire.geometry.dispose();
        this.wire.material.dispose();
        this.wire = null;
        this.wireLevel = null;
    }

    /**
     * Push the resolved parameters of the take's objects onto the scan.
     * `p` holds { take, points, mesh, wire } (resolved params, or null where
     * the object is gone). `drawSize` is the drawing buffer (for line width
     * and screen-space point size), `ss` the export's supersample factor.
     */
    apply(p, drawSize, ss = 1) {
        const T = p.take || {};
        this.root.position.set(T.offsetX || 0, T.offsetY || 0, T.offsetZ || 0);
        this.root.rotation.set((T.rotX || 0) * D2R, (T.rotY || 0) * D2R, (T.rotZ || 0) * D2R);
        this.root.scale.setScalar(T.scale || 1);
        this.overlay.scale.setScalar(T.overscale || 1);
        this.overlay.position.set(T.overlayX || 0, T.overlayY || 0, T.overlayZ || 0);

        const M = p.mesh;
        if (this.mesh) {
            const on = !!M && M.visible && M.opacity > 0.002;
            this.mesh.visible = on;
            if (on) {
                let mat = this.mesh.material;
                const kind = M.shading;
                if (kind === 'textured') {
                    if (mat !== this.textured) this.mesh.material = this.textured;
                } else if (!mat || mat === this.textured || mat.userData.kind !== kind) {
                    if (mat && mat !== this.textured) mat.dispose();
                    mat = kind === 'normal' ? new THREE.MeshNormalMaterial()
                        : kind === 'shaded' ? new THREE.MeshLambertMaterial() : new THREE.MeshBasicMaterial();
                    mat.userData.kind = kind;
                    this.mesh.material = mat;
                }
                mat = this.mesh.material;
                if (mat.color && kind !== 'textured' && kind !== 'normal') mat.color.set(M.color);
                const tr = M.opacity < 1;
                if (mat.transparent !== tr) { mat.transparent = tr; mat.needsUpdate = true; }
                mat.opacity = M.opacity;
                mat.depthWrite = !tr;
            }
        }
        if (this.occluder) this.occluder.visible = !!T.occlude;

        const W = p.wire;
        if (W && W.visible) this.loadWire(W.level, W.color);
        if (this.wire) {
            this.wire.visible = !!W && W.visible;
            if (W) {
                const m = this.wire.material;
                m.color.set(W.color);
                m.opacity = Math.max(0, Math.min(1, W.opacity));
                m.resolution.set(drawSize.x, drawSize.y);
                m.linewidth = Math.max(0.5, W.thickness * drawSize.y);
            }
        }

        const P = p.points;
        if (this.cloud) {
            this.cloud.visible = !!P && P.visible && P.opacity > 0.002;
            if (P) {
                const m = this.cloud.material;
                const useScan = P.colorMode === 'scan' && !!this.cloud.geometry.getAttribute('color');
                if (m.vertexColors !== useScan) { m.vertexColors = useScan; m.needsUpdate = true; }
                m.color.set(useScan ? '#ffffff' : P.color);
                if (m.sizeAttenuation !== !!P.attenuate) { m.sizeAttenuation = !!P.attenuate; m.needsUpdate = true; }
                m.size = P.attenuate ? (P.size / 1000) * 4 : P.size * 1.5 * ss;
                m.opacity = Math.max(0, Math.min(1, P.opacity));
                const tr = m.opacity < 1;
                if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
                m.depthWrite = !tr;
                const total = this.cloud.geometry.getAttribute('position').count;
                this.cloud.geometry.setDrawRange(0, Math.max(1, Math.floor(total * Math.max(0, Math.min(1, P.density)))));
            }
        }
    }

    pulseOf(P) {
        const mode = P.pulseMode || 'radial';
        return {
            mode,
            ox: P.pulseX || 0, oy: P.pulseY || 0, oz: P.pulseZ || 0,
            dir: PULSE_DIRS[P.pulseDir] || PULSE_DIRS.up,
            plane: P.pulsePlane,
            line: P.pulseLine,
        };
    }

    /** Push the spectrum through the points and the wireframe. */
    react(P, W, freq, live) {
        if (!P) return;
        const pulse = this.pulseOf(P);
        if (this.wire && this.wireState && this.wireBuffer) {
            applyWireReactivity(this.wireState, this.wireBuffer, this.wireEdges, {
                reactivity: W && W.visible ? W.react : 0,
                scatter: P.scatter, freqLow: P.freqLow, freqHigh: P.freqHigh, ...pulse,
            }, freq, live);
        }
        if (!this.cloud || !this.cloudReact) return;
        const attr = this.cloud.geometry.getAttribute('position');
        const drawn = this.cloud.geometry.drawRange.count;
        applyCloudReactivity(this.cloudReact, attr, {
            reactivity: P.visible ? P.react : 0,
            scatter: P.scatter, freqLow: P.freqLow, freqHigh: P.freqHigh, ...pulse,
        }, freq, live, Number.isFinite(drawn) && drawn > 0 ? drawn : attr.count);
    }

    /** Put the scan's layers in front of the footage or behind it. Returns how many are behind. */
    assignLayers(behind) {
        let n = 0;
        [[this.mesh, behind.mesh], [this.cloud, behind.points], [this.wire, behind.wire]].forEach(([o, back]) => {
            if (!o) return;
            o.layers.set(back ? LAYER.BEHIND : LAYER.FRONT);
            if (back && o.visible) n++;
        });
        if (this.occluder) { this.occluder.layers.set(LAYER.FRONT); this.occluder.layers.enable(LAYER.BEHIND); }
        if (this.catcher) this.catcher.layers.set(LAYER.FRONT);
        return n;
    }

    dispose() {
        this.disposed = true;
        this.dropWire();
        [this.mesh, this.cloud, this.occluder, this.catcher, this.envMesh].forEach((o) => {
            if (!o) return;
            o.removeFromParent();
            if (o !== this.mesh && o !== this.occluder && o !== this.catcher && o !== this.envMesh) o.geometry?.dispose();
            if (o.material && o.material !== this.textured) o.material.dispose?.();
        });
        this.mesh?.geometry.dispose();
        this.textured?.map?.dispose?.();
        this.textured?.dispose?.();
        this.overlay.removeFromParent();
    }
}
