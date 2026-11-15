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
import { LAYER, cutByWindows } from '../../../lib/scanAssets/windows';
import { takeBase } from './media';
import { fingerprint, applyEdits, weld } from '../model/meshEdits';
import {
    makeLookUniforms, setLookUniforms, hookLook, normaliseLook,
} from '../../../lib/scanAssets/takeLooks';

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

/**
 * The wireframe's halo: the same lines drawn wider and added on top, each
 * fading from its centre line to nothing at its edge, so the wire looks lit
 * from within rather than bloomed afterwards. Round caps are left off: where
 * many edges meet at a vertex they would pile up into bright dots.
 */
function wireHaloMaterial(color) {
    const m = new LineMaterial({
        color: new THREE.Color(color), transparent: true, depthWrite: false, linewidth: 1, blending: THREE.AdditiveBlending,
    });
    m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
            'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
            `if ( abs( vUv.y ) > 1.0 ) discard;
            float gd = clamp( abs( vUv.x ), 0.0, 1.0 );
            // Bright near the line with a long soft tail, nothing at the edge.
            float glow = ( exp( -5.0 * gd ) - exp( -5.0 ) ) / ( 1.0 - exp( -5.0 ) );
            gl_FragColor = vec4( diffuseColor.rgb, alpha * glow );`,
        );
    };
    m.customProgramCacheKey = () => 'wireHalo';
    return m;
}

/**
 * Every mesh in a scan's GLB, in the scan's frame, as one indexed geometry
 * (position and uv only) with a group per mesh, their materials, and the
 * arrays mesh edits are made against (model/meshEdits: `base`).
 */
function mergeScan(gltf) {
    gltf.scene.updateMatrixWorld(true);
    const srcs = [];
    gltf.scene.traverse((o) => { if (o.isMesh && o.geometry.getAttribute('position')) srcs.push(o); });
    if (!srcs.length) throw new Error('no mesh in GLB');
    const parts = srcs.map((o) => {
        const g = o.geometry.clone();
        g.applyMatrix4(o.matrixWorld);
        const n = g.getAttribute('position').count;
        const index = g.index ? g.index.array : Uint32Array.from({ length: n }, (_, i) => i);
        return { g, n, index, material: Array.isArray(o.material) ? o.material[0] : o.material };
    });
    const withUv = parts.every((p) => p.g.getAttribute('uv'));
    const nv = parts.reduce((s, p) => s + p.n, 0);
    const nf = parts.reduce((s, p) => s + p.index.length / 3, 0);
    const pos = new Float32Array(nv * 3);
    const uv = withUv ? new Float32Array(nv * 2) : null;
    const index = new Uint32Array(nf * 3);
    const ranges = [];
    let v0 = 0;
    let f0 = 0;
    parts.forEach((p) => {
        const P = p.g.getAttribute('position');
        for (let i = 0; i < p.n; i++) pos.set([P.getX(i), P.getY(i), P.getZ(i)], (v0 + i) * 3);
        if (uv) {
            const U = p.g.getAttribute('uv');
            for (let i = 0; i < p.n; i++) uv.set([U.getX(i), U.getY(i)], (v0 + i) * 2);
        }
        for (let i = 0; i < p.index.length; i++) index[f0 * 3 + i] = p.index[i] + v0;
        ranges.push({ vStart: v0, vCount: p.n, fStart: f0, fCount: p.index.length / 3 });
        v0 += p.n;
        f0 += p.index.length / 3;
        p.g.dispose();
    });
    const base = { pos, uv, index, parts: ranges };
    const geo = new THREE.BufferGeometry();
    setScanGeometry(geo, applyEdits(base, null));
    return { geo, materials: parts.map((p) => p.material), base };
}

/** Put a scan's arrays (from applyEdits) into its geometry, in place: the companions share it. */
function setScanGeometry(geo, g) {
    // Throw away what the GPU holds for the old arrays; the next draw uploads these.
    geo.dispose();
    geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    if (g.uv) geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    geo.clearGroups();
    g.groups.forEach((gr) => geo.addGroup(gr.start, gr.count, gr.materialIndex));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.userData.faceIds = g.faceIds;
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
        // The take's colour corrections, one for its textured mesh and one for
        // its scan-coloured points (lib/scanAssets/takeLooks).
        this.meshLook = makeLookUniforms();
        this.pointLook = makeLookUniforms();
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
            // A big scan comes as several meshes, one per texture atlas, that
            // together make the whole: all of them, as one geometry with a
            // group (and a material) per part.
            const { geo, materials, base: scan } = mergeScan(gltf);
            this.base = scan;
            this.fingerprint = fingerprint(scan.pos, scan.index);
            this.editsApplied = null;
            this.geoVersion = 0;
            this.textured = materials.length > 1 ? materials : materials[0];
            this.texturedList = materials;
            materials.forEach((m) => hookLook(m, this.meshLook, 'map_fragment'));
            // Windows that cut the scan mesh clip it (and its companions) on screen.
            cutByWindows(materials);
            this.mesh = new THREE.Mesh(geo, this.textured);
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
            hookLook(cloudMat, this.pointLook, 'color_fragment');
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

    /**
     * Put the scan's mesh edits (an edit document, or null for none) on its
     * mesh. Cheap when they have not changed: the document is compared by
     * identity, so edits are always made by making a new one.
     */
    applyEdits(doc) {
        if (!this.mesh || !this.base || doc === this.editsApplied || (!doc && !this.editsApplied)) return;
        const welded = doc && Object.keys(doc.moved).length ? this.welded() : null;
        setScanGeometry(this.mesh.geometry, applyEdits(this.base, doc, welded));
        this.editsApplied = doc;
        this.geoVersion++;
    }

    /** The scan's vertices welded where they meet (made once, when first wanted). */
    welded() {
        if (!this.weldCache && this.base) this.weldCache = weld(this.base.pos);
        return this.weldCache;
    }

    /** Push a take's look (or null for none) onto the mesh and the points. */
    applyLook(look) {
        const n = normaliseLook(look);
        setLookUniforms(this.meshLook, n.mesh);
        setLookUniforms(this.pointLook, n.points);
    }

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
        cutByWindows(this.occluder.material);

        this.catcher = new THREE.Mesh(g, new THREE.ShadowMaterial({
            transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
        }));
        this.catcher.receiveShadow = true;
        this.catcher.frustumCulled = false;
        this.catcher.visible = false;
        this.root.add(this.catcher);
        cutByWindows(this.catcher.material);

        const env = this.texturedList.map((src) => new THREE.MeshBasicMaterial({
            map: src?.map || null, color: src?.map ? 0xffffff : 0x808080, side: THREE.DoubleSide,
        }));
        this.envMesh = new THREE.Mesh(g, env.length > 1 ? env : env[0]);
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
            // Its glow shares the lines (so it pulses with them) and is drawn
            // with the wire, on whatever layer the wire is on.
            this.wireHalo = new LineSegments2(lineGeo, wireHaloMaterial(color));
            this.wireHalo.frustumCulled = false;
            this.wireHalo.visible = false;
            this.wire.add(this.wireHalo);
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
        this.wireHalo?.material.dispose();
        this.wireHalo = null;
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
                    cutByWindows(mat);
                    this.mesh.material = mat;
                }
                mat = this.mesh.material;
                const tr = M.opacity < 1;
                // The scan's own texture is a material per part.
                [].concat(this.mesh.material).forEach((m) => {
                    if (m.color && kind !== 'textured' && kind !== 'normal') m.color.set(M.color);
                    if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
                    m.opacity = M.opacity;
                    m.depthWrite = !tr;
                });
            }
        }
        if (this.occluder) this.occluder.visible = !!T.occlude;

        const W = p.wire;
        if (W && W.visible) this.loadWire(W.level, W.color);
        if (this.wire) {
            this.wire.visible = !!W && W.visible;
            if (W) {
                const m = this.wire.material;
                const glow = Math.max(0, W.glow || 0);
                // An emissive line runs hot: its core brightens towards white
                // as the glow goes up.
                m.color.set(W.color).multiplyScalar(1 + glow * 0.5);
                m.opacity = Math.max(0, Math.min(1, W.opacity));
                m.resolution.set(drawSize.x, drawSize.y);
                m.linewidth = Math.max(0.5, W.thickness * drawSize.y);
                const halo = this.wireHalo;
                if (halo) {
                    halo.visible = glow > 0.001 && W.opacity > 0.002;
                    const hm = halo.material;
                    hm.color.set(W.color).multiplyScalar(glow * 0.4);
                    hm.opacity = Math.max(0, Math.min(1, 0.25 + W.opacity));
                    hm.resolution.set(drawSize.x, drawSize.y);
                    hm.linewidth = m.linewidth * Math.max(1, W.glowSpread || 6);
                }
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
        [[this.mesh, behind.mesh], [this.cloud, behind.points], [this.wire, behind.wire], [this.wireHalo, behind.wire]].forEach(([o, back]) => {
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
            if (o.material && o.material !== this.textured) [].concat(o.material).forEach((m) => m.dispose?.());
        });
        this.mesh?.geometry.dispose();
        (this.texturedList || []).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
        this.overlay.removeFromParent();
    }
}
