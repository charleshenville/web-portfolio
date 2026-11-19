// Shapes: a cube, sphere, cylinder… placed in a scene, as one of two things.
//
//   solid     a real object: lit (or flat, or normals), casting and taking
//             shadows, in front of the footage or behind it
//   occluder  an invisible stand-in for the scan where its mesh is wrong or
//             missing: depth only, so whatever is behind it is hidden, as
//             the scan's own depth-only copy hides it (takeRig.js). It can
//             catch shadows the way the scan does, is cut by windows that
//             cut the scan mesh, and counts as the scan for things that hide
//             behind it (Engine.renderScanDepth). While editing, an outline
//             on the overlay shows where it is.
//
// Every size is a plain parameter, so a controller can drive it: the
// geometry is rebuilt whenever what it is built from changes, which for
// these few hundred triangles costs next to nothing.

import * as THREE from 'three';
import { cutByWindows, LAYER } from '../../../lib/scanAssets/windows';
import { makeGlowCatcher, catchOnce, CATCH_BIT } from './emission';

const D2R = Math.PI / 180;

// What a shape's geometry is built from: when none of these change, it is kept.
const GEOM_KEYS = [
    'shape', 'width', 'height', 'depth', 'radius', 'radiusTop', 'radiusBottom', 'tube',
    'arc', 'arcV', 'openEnded', 'segments', 'rings', 'divisions', 'detail',
];

const size = (v, d) => Math.max(0, Number.isFinite(v) ? v : d);
const count = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : d)));
const angle = (v, max, d) => Math.max(1e-3, Math.min(max, Number.isFinite(v) ? v : d)) * D2R;

/** A shape's geometry, from its (resolved) parameters. */
export function shapeGeometry(p) {
    const seg = count(p.segments, 3, 128, 32);
    const rings = count(p.rings, 1, 64, 16);
    const div = count(p.divisions, 1, 64, 1);
    const r = size(p.radius, 0.25);
    const h = size(p.height, 0.5);
    const arc = angle(p.arc, 360, 360);
    switch (p.shape) {
        case 'sphere': return new THREE.SphereGeometry(r, seg, Math.max(2, rings), 0, arc, 0, angle(p.arcV, 180, 180));
        case 'cylinder': return new THREE.CylinderGeometry(size(p.radiusTop, 0.25), size(p.radiusBottom, 0.25), h, seg, 1, !!p.openEnded, 0, arc);
        case 'cone': return new THREE.ConeGeometry(r, h, seg, 1, !!p.openEnded, 0, arc);
        // Its height is end to end, the round caps included. (Three's lathe
        // can't take a radius of nothing, so a capsule shrinks to a speck.)
        case 'capsule': {
            const rc = Math.max(1e-4, r);
            return new THREE.CapsuleGeometry(rc, Math.max(0, h - 2 * rc), rings, seg);
        }
        case 'torus': return new THREE.TorusGeometry(r, size(p.tube, 0.08), Math.max(2, rings), seg, arc);
        case 'plane': return new THREE.PlaneGeometry(size(p.width, 0.5), h, div, div);
        case 'tetra': return new THREE.TetrahedronGeometry(r, count(p.detail, 0, 5, 0));
        case 'octa': return new THREE.OctahedronGeometry(r, count(p.detail, 0, 5, 0));
        case 'dodeca': return new THREE.DodecahedronGeometry(r, count(p.detail, 0, 5, 0));
        case 'icosa': return new THREE.IcosahedronGeometry(r, count(p.detail, 0, 5, 0));
        case 'box':
        default: return new THREE.BoxGeometry(size(p.width, 0.5), h, size(p.depth, 0.5), div, div, div);
    }
}

/** The key a geometry is cached under: its build parameters, to a tenth of a millimetre. */
function geomKey(p) {
    return GEOM_KEYS.map((k) => {
        const v = p[k];
        return typeof v === 'number' ? Math.round(v * 1e4) : String(v);
    }).join('|');
}

const GUIDE_COLOR = '#7fe3ff';

export default class ShapeAdapter {
    constructor(obj, parent) {
        this.group = new THREE.Group();
        this.object = this.group;
        this.group.userData.objectId = obj.id;
        parent.add(this.group);
        // What the sun reads to decide whether this casts.
        this.model = { op: {} };
        this.key = null;
        this.geometry = new THREE.BufferGeometry();

        // The real object: one material per shading, swapped as it changes.
        this.mats = {};
        this.mesh = new THREE.Mesh(this.geometry, this.material('lit'));
        this.group.add(this.mesh);

        // The stand-in: depth and nothing else, drawn before everything it hides.
        this.occMats = {
            plain: new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }),
            cut: new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }),
        };
        cutByWindows(this.occMats.cut);
        this.occ = new THREE.Mesh(this.geometry, this.occMats.plain);
        this.occ.renderOrder = -1;
        this.group.add(this.occ);

        // Its shadow catcher, as the scan's: shadows on an invisible surface.
        // Either face, as its depth and glow: a plane laid face down still catches.
        const catcher = () => catchOnce(new THREE.ShadowMaterial({
            transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
            side: THREE.DoubleSide,
        }), CATCH_BIT.shadow);
        this.catchMats = { plain: catcher(), cut: catcher() };
        cutByWindows(this.catchMats.cut);
        this.catcher = new THREE.Mesh(this.geometry, this.catchMats.plain);
        this.catcher.receiveShadow = true;
        this.catcher.visible = false;
        this.group.add(this.catcher);
        this.casting = false;
        this.shadowOpacity = 0.4;
        // And the glow of emissive points on it (engine/emission.js).
        this.glow = makeGlowCatcher(this.geometry);
        this.group.add(this.glow);

        // Where the stand-in is, on the overlay (never in a render or an export).
        this.guide = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
            color: GUIDE_COLOR, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false,
        }));
        this.guide.renderOrder = 998;
        this.guide.userData.handle = true;
        this.guide.raycast = () => {}; // picked by its stand-in, not its lines
        this.guide.visible = false;
        this.guideKey = null;
        this.group.add(this.guide);

        this.op = {};
    }

    material(kind) {
        if (!this.mats[kind]) {
            const side = THREE.DoubleSide;
            this.mats[kind] = kind === 'normal' ? new THREE.MeshNormalMaterial({ side })
                : kind === 'flat' ? new THREE.MeshBasicMaterial({ side })
                    : new THREE.MeshStandardMaterial({ side, metalness: 0 });
        }
        return this.mats[kind];
    }

    /** An invisible stand-in, shown: its layers are its own (assignStandInLayers), and it counts as the scan. */
    get standIn() { return this.op.role === 'occluder' && this.group.visible; }

    /** Whether windows that cut the scan mesh cut this stand-in. */
    get windowCut() { return this.op.windowCut !== false; }

    sync(obj, p) {
        this.op = p;
        this.group.userData.objectId = obj.id;
        const key = geomKey(p);
        if (key !== this.key) {
            this.key = key;
            const old = this.geometry;
            this.geometry = shapeGeometry(p);
            this.mesh.geometry = this.geometry;
            this.occ.geometry = this.geometry;
            this.catcher.geometry = this.geometry;
            this.glow.geometry = this.geometry;
            old.dispose();
        }
        this.group.position.set(p.posX || 0, p.posY || 0, p.posZ || 0);
        this.group.rotation.set((p.rotX || 0) * D2R, (p.rotY || 0) * D2R, (p.rotZ || 0) * D2R);
        const k = Math.max(1e-4, p.scale ?? 1);
        const st = (v) => Math.max(1e-4, Number.isFinite(v) ? v : 1);
        this.group.scale.set(k * st(p.stretchX), k * st(p.stretchY), k * st(p.stretchZ));
        this.group.visible = p.visible !== false;

        const solid = p.role !== 'occluder';
        this.model.op = { castShadow: solid && p.castShadow !== false, hideBehindScan: false };
        this.mesh.visible = solid;
        this.occ.visible = !solid;
        if (solid) {
            const kind = p.shading === 'flat' || p.shading === 'normal' ? p.shading : 'lit';
            const m = this.material(kind);
            if (this.mesh.material !== m) this.mesh.material = m;
            if (m.color) m.color.set(p.color || '#d8d8d8');
            if (m.roughness !== undefined) m.roughness = Math.max(0, Math.min(1, p.roughness ?? 0.6));
            m.wireframe = !!p.wireframe;
            const op = Math.max(0, Math.min(1, p.opacity ?? 1));
            const tr = op < 1;
            if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
            m.opacity = op;
            m.depthWrite = !tr;
            this.mesh.castShadow = p.castShadow !== false;
            this.mesh.receiveShadow = kind === 'lit' && p.receiveShadow !== false;
        } else {
            this.mesh.castShadow = false;
            const cut = this.windowCut ? 'cut' : 'plain';
            this.occ.material = this.occMats[cut];
            this.catcher.material = this.catchMats[cut];
        }
        this.catcher.visible = !solid && !!p.catchShadows && this.casting;
        this.catcher.material.opacity = this.shadowOpacity;
    }

    /** From the sun each frame: whether anything casts now, and how dark shadows are. */
    setShadowCatch(casting, opacity) {
        this.casting = casting;
        this.shadowOpacity = opacity ?? 0.4;
        this.catcher.visible = this.op.role === 'occluder' && !!this.op.catchShadows && casting;
        this.catcher.material.opacity = this.shadowOpacity;
    }

    /** From the engine each frame: whether emissive points light hidden surfaces now. */
    setGlowCatch(on) {
        this.glow.visible = on && this.op.role === 'occluder';
    }

    /**
     * A stand-in's layers, as the scan's depth-only copy has them: it hides
     * things in front of the footage and behind it; its shadows land in
     * front; its outline is on the overlay.
     */
    assignStandInLayers() {
        this.occ.layers.set(LAYER.FRONT);
        this.occ.layers.enable(LAYER.BEHIND);
        this.catcher.layers.set(LAYER.FRONT);
        this.glow.layers.set(LAYER.FRONT);
        this.mesh.layers.set(LAYER.FRONT);
        this.guide.layers.set(LAYER.OVERLAY);
    }

    update(dt, f) {
        const show = this.op.role === 'occluder' && this.op.showGuide !== false && !f.exporting;
        this.guide.visible = show;
        if (!show) return;
        // Its edges (a sphere's lines of latitude and longitude, a cube's twelve), made when shown.
        if (this.guideKey !== this.key) {
            this.guideKey = this.key;
            this.guide.geometry.dispose();
            this.guide.geometry = new THREE.EdgesGeometry(this.geometry, 1);
        }
        this.guide.material.opacity = this.selected ? 0.9 : 0.4;
    }

    dispose() {
        this.geometry.dispose();
        this.guide.geometry.dispose();
        this.guide.material.dispose();
        Object.values(this.mats).forEach((m) => m.dispose());
        Object.values(this.occMats).forEach((m) => m.dispose());
        Object.values(this.catchMats).forEach((m) => m.dispose());
        this.glow.material.dispose();
        this.group.removeFromParent();
    }
}
