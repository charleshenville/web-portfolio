import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { noiseTile } from './textures.js';

// Ported from tetra (frontend/src/enemies/rig.js); keep the two in step. The
// one addition is `bake` also keeping each part's feature edges and triangles
// (`edges`, `surface`), which the Scan Compositor's wireframe and point-cloud
// views of the protagonist are drawn from.
//
// Robots are built from simple shapes (boxes, prisms, low-poly balls), each
// attached rigidly to one bone of a small skeleton. Every shape of a robot is
// merged into one skinned mesh for the body (one draw call) and one for its
// indicator lights, so a crowd of them stays cheap; animation just moves the
// bones. The body is flat shaded and tinted per shape by vertex colour, under
// a large tiling detail texture made like the bark's and rocks' (periodic
// Perlin noise, posterized and Bayer-dithered; see ../terrain/textures.js),
// with a modest highlight. The spec's `[texture]` sets all of it (the
// enemies' and the protagonist's each have one), and can add a share of
// banded sky reflection, off by default.

const ENV_RES = 32;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Seed of the hull noise (one texture for every robot wearing a finish). */
const HULL_SEED = 0x7e7a;
/** Finishes kept built at once (each edit in the tools makes a new one). */
const HULL_CACHE = 8;

/** A finish's defaults (the bundled specs' `[texture]`), for anything a spec leaves out. */
export const HULL_TEXTURE = {
  period: [4, 2],
  octaves: 3,
  persistence: 0.5,
  contrast: 1.1,
  resolution: 64,
  levels: 6,
  dither: true,
  repeat: 3,
  strength: 0.25,
  shininess: 30,
  specular: 0.12,
  reflectivity: 0,
};

/**
 * A finish's fields for the tools: `[key, label, min, max, step, hint]`
 * (`period` is edited per axis as `period.0` / `period.1`).
 */
export const HULL_FIELDS = {
  texture: [
    ['repeat', 'tile size (m)', 0.25, 12, 0.05, 'metres of surface one tile covers'],
    ['strength', 'strength', 0, 1, 0.01, "how far the texture's darkest texels darken the colour (0 = plain)"],
    ['period.0', 'period across', 1, 16, 1, 'noise blobs across one tile (more = finer)'],
    ['period.1', 'period down', 1, 16, 1, 'noise blobs down one tile (unequal = streaks)'],
    ['octaves', 'octaves', 1, 8, 1, 'layers of finer detail'],
    ['persistence', 'persistence', 0, 1, 0.01, 'how strong each finer layer is'],
    ['contrast', 'contrast', 0, 4, 0.05, 'contrast around mid-grey'],
    ['levels', 'grey levels', 2, 16, 1, 'posterization: greys left (the terrain uses 6)'],
    ['resolution', 'resolution (px)', 8, 256, 8, 'pixels per tile edge (the terrain uses 64)'],
  ],
  finish: [
    ['shininess', 'shininess', 1, 200, 1, 'how tight the highlights are'],
    ['specular', 'specular', 0, 1, 0.01, 'how bright the highlights are (0 = matte)'],
    ['reflectivity', 'reflectivity', 0, 1, 0.01, 'share of a banded sky reflected over the colour (0 = none)'],
  ],
};

const hulls = new Map();

/**
 * The detail texture of finish `spec` (see HULL_TEXTURE): near-white, darker
 * where the noise is, repeating every `repeat` metres (robots' UVs are in
 * metres). Built once per distinct texture.
 */
export function hullTexture(spec) {
  const t = { ...HULL_TEXTURE, ...spec };
  const key = JSON.stringify([t.period, t.octaves, t.persistence, t.contrast, t.resolution, t.levels, t.dither, t.repeat, t.strength]);
  let tex = hulls.get(key);
  if (tex) {
    hulls.delete(key);
    hulls.set(key, tex);
    return tex;
  }
  const res = Math.round(t.resolution);
  const grey = noiseTile(t, res, t.levels, t.dither, HULL_SEED);
  const img = new Uint8ClampedArray(res * res * 4);
  for (let i = 0; i < grey.length; i++) {
    const c = Math.round(255 * (1 - t.strength * (1 - grey[i] / 255)));
    img.set([c, c, c, 255], i * 4);
  }
  tex = new THREE.DataTexture(img, res, res, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / t.repeat, 1 / t.repeat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  hulls.set(key, tex);
  // Let go of the least recently used (a material still holding one just uploads it again).
  while (hulls.size > HULL_CACHE) {
    const [old, oldTex] = hulls.entries().next().value;
    hulls.delete(old);
    oldTex.dispose();
  }
  return tex;
}

/** A finish's tile drawn `tiles` times across a canvas (for the tools' previews), tinted `tint`. */
export function hullPreview(spec, tiles = 2, tint = '#c4c8ce') {
  const tex = hullTexture(spec);
  const res = tex.image.width;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = res * tiles;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(res, res);
  const c = new THREE.Color(tint);
  const rgb = [c.r, c.g, c.b].map((v) => v * 255);
  for (let i = 0; i < res * res; i++) {
    const g = tex.image.data[i * 4] / 255;
    data.data.set([rgb[0] * g, rgb[1] * g, rgb[2] * g, 255], i * 4);
  }
  for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) ctx.putImageData(data, x * res, y * res);
  return canvas;
}

let environment = null;

/**
 * What a finish with `reflectivity` reflects: a coarse sky in stepped bands (bright overhead, a
 * hot horizon line, dark ground), a few pixels a face and unfiltered, so the
 * reflections on flat facets stay crisp and retro.
 */
export function metalEnvironment() {
  if (environment) return environment;
  const n = ENV_RES;
  const tone = (y) => {
    if (y > 0.55) return [0.93, 0.95, 1.0];
    if (y > 0.2) return [0.78, 0.81, 0.87];
    if (y > 0.05) return [0.6, 0.63, 0.7];
    if (y > -0.03) return [1.0, 1.0, 1.0];
    if (y > -0.3) return [0.3, 0.29, 0.28];
    return [0.16, 0.15, 0.15];
  };
  // Cube faces +X, -X, +Y, -Y, +Z, -Z: the direction of a texel (sc, tc in -1..1), as GL lays them out.
  const faces = [
    (sc, tc) => [1, -tc, -sc],
    (sc, tc) => [-1, -tc, sc],
    (sc, tc) => [sc, 1, tc],
    (sc, tc) => [sc, -1, -tc],
    (sc, tc) => [sc, -tc, 1],
    (sc, tc) => [-sc, -tc, -1],
  ];
  const images = faces.map((dir) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [x, y, z] = dir(((i + 0.5) / n) * 2 - 1, ((j + 0.5) / n) * 2 - 1);
        const c = tone(y / Math.hypot(x, y, z));
        data.data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], (j * n + i) * 4);
      }
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  });
  environment = new THREE.CubeTexture(images);
  environment.magFilter = environment.minFilter = THREE.NearestFilter;
  environment.generateMipmaps = false;
  environment.colorSpace = THREE.SRGBColorSpace;
  environment.needsUpdate = true;
  return environment;
}

/** A soft pixel blob for glows (additive sprites): dithered rings, no smooth gradient. */
let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const n = 16;
  const img = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const d = (BAYER4[(y % 4) * 4 + (x % 4)] + 0.5) / 16;
      const a = Math.max(0, 1 - r);
      const v = Math.floor((a * a * 4 + d) ) / 4;
      const c = Math.round(Math.min(1, v) * 255);
      img.set([255, 255, 255, c], (y * n + x) * 4);
    }
  }
  glowTex = new THREE.DataTexture(img, n, n, THREE.RGBAFormat);
  glowTex.magFilter = glowTex.minFilter = THREE.NearestFilter;
  glowTex.needsUpdate = true;
  return glowTex;
}

/**
 * Planar UVs for a non-indexed geometry, each triangle projected from the
 * axis its normal faces most, in metres (the texture's repeat sets the tile
 * size): texels stay the same size on every shape, like the rocks' textures.
 */
function planarUVs(g) {
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u;
      let v;
      if (ax >= ay && ax >= az) [u, v] = [p.z, p.y];
      else if (ay >= az) [u, v] = [p.x, p.z];
      else [u, v] = [p.x, p.y];
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Scale the top (+y) of a geometry centred on the origin by (sx, sz): wedges, trapezoids. */
export function taper(g, sx, sz = sx) {
  const pos = g.attributes.position;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min.y) / Math.max(1e-6, max.y - min.y);
    pos.setX(i, pos.getX(i) * (1 + (sx - 1) * t));
    pos.setZ(i, pos.getZ(i) * (1 + (sz - 1) * t));
  }
  return g;
}

export const shapes = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  /** An n-sided prism (low-poly cylinder) standing on y. */
  prism: (rTop, rBottom, h, sides = 8) => new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1),
  ball: (r, detail = 0) => new THREE.IcosahedronGeometry(r, detail),
  dome: (r, sides = 10, rings = 3) => new THREE.SphereGeometry(r, sides, rings, 0, Math.PI * 2, 0, Math.PI / 2),
  ring: (r, tube, sides = 12, tubeSides = 4) => new THREE.TorusGeometry(r, tube, tubeSides, sides),
  cone: (r, h, sides = 6) => new THREE.ConeGeometry(r, h, sides, 1),
};

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

/**
 * Assembles a robot. `bone(name, parent, [x, y, z])` adds a joint (positions
 * relative to the parent joint, in the bind pose); `add(bone, geometry, opts)`
 * attaches a shape to it at `opts.at` / `opts.rot` (Euler, radians) /
 * `opts.scale`, coloured `opts.color` (the body mesh) or, with `opts.light`,
 * part of the light mesh (tinted by the light colour times `opts.light`).
 */
export class RigBuilder {
  constructor() {
    this.root = new THREE.Bone();
    this.root.name = 'root';
    this.bones = [this.root];
    this.byName = { root: this.root };
    this.body = [];
    this.lights = [];
    /** Named points (muzzles, eyes) as [bone name, local position]. */
    this.sockets = {};
  }

  bone(name, parent = 'root', at = [0, 0, 0]) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.fromArray(at);
    this.byName[parent].add(b);
    this.bones.push(b);
    this.byName[name] = b;
    return b;
  }

  socket(name, bone, at) {
    this.sockets[name] = [bone, new THREE.Vector3(...at)];
  }

  add(bone, geometry, { at = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = '#ffffff', light = 0 } = {}) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.applyMatrix4(tmpM.compose(tmpP.fromArray(at), tmpQ.setFromEuler(tmpE.fromArray([...rot, 'XYZ'])), tmpS.fromArray(scale)));
    (light ? this.lights : this.body).push({ bone, g, color: new THREE.Color(color), light });
    return this;
  }

  /**
   * Bake to `{ geometry, lightGeometry, bones (bind-pose order), sockets, height }`:
   * geometries in rig space, skinned rigidly to their bone. Shared by every
   * instance of the type; `instantiate` gives each enemy its own skeleton.
   */
  bake() {
    this.root.updateMatrixWorld(true);
    const index = new Map(this.bones.map((b, i) => [b.name, i]));
    // Feature edges of every part, rig space, two vertices a segment, each
    // with its bone and its part's colour (lights: the light colour's share).
    const edgePos = [];
    const edgeBone = [];
    const edgeCol = [];
    const edgeLight = [];
    const merge = (parts, lights) => {
      if (!parts.length) return null;
      const geoms = parts.map(({ bone, g, color, light }) => {
        const b = this.byName[bone];
        g.applyMatrix4(b.matrixWorld);
        const eg = new THREE.EdgesGeometry(g, 25);
        const ep = eg.attributes.position.array;
        const bi = index.get(bone);
        for (let i = 0; i < ep.length; i += 3) {
          edgePos.push(ep[i], ep[i + 1], ep[i + 2]);
          edgeBone.push(bi);
          edgeCol.push(color.r, color.g, color.b);
          edgeLight.push(light);
        }
        eg.dispose();
        g.deleteAttribute('normal');
        g.deleteAttribute('uv');
        planarUVs(g);
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3);
        const c = lights ? new THREE.Color(light, light, light) : color;
        for (let i = 0; i < n; i++) c.toArray(col, i * 3);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const si = new Uint16Array(n * 4);
        const sw = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          si[i * 4] = bi;
          sw[i * 4] = 1;
        }
        g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
        g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
        return g;
      });
      const merged = mergeGeometries(geoms, false);
      merged.computeVertexNormals();
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      // Animation moves parts about; keep culling generous.
      merged.boundingSphere.radius *= 1.6;
      return merged;
    };
    const geometry = merge(this.body, false);
    const lightGeometry = merge(this.lights, true);
    const bind = this.bones.map((b) => ({ name: b.name, parent: b.parent?.isBone ? b.parent.name : null, position: b.position.clone(), quaternion: b.quaternion.clone() }));
    const edges = {
      position: Float32Array.from(edgePos),
      bone: Uint16Array.from(edgeBone),
      color: Float32Array.from(edgeCol),
      light: Float32Array.from(edgeLight),
    };
    return { geometry, lightGeometry, edges, bind, sockets: this.sockets, height: geometry.boundingBox.max.y };
  }
}

/**
 * One enemy's meshes from a baked rig: `{ object, bones (by name), body,
 * lights, lightMaterial, socket(name, out) }`. Body materials are shared per
 * type; each instance has its own light material, so its lights can turn red.
 */
export function instantiate(baked, bodyMaterial) {
  const bones = {};
  const list = baked.bind.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.copy(b.position);
    bone.quaternion.copy(b.quaternion);
    bones[b.name] = bone;
    return bone;
  });
  baked.bind.forEach((b, i) => b.parent && bones[b.parent].add(list[i]));
  const object = new THREE.Group();
  object.add(bones.root);
  object.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const body = new THREE.SkinnedMesh(baked.geometry, bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  body.bind(skeleton, object.matrixWorld.clone().identity());
  object.add(body);
  let lights = null;
  const lightMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  if (baked.lightGeometry) {
    lights = new THREE.SkinnedMesh(baked.lightGeometry, lightMaterial);
    lights.bind(skeleton, new THREE.Matrix4());
    object.add(lights);
  }
  const socket = (name, out) => {
    const [bone, at] = baked.sockets[name];
    return out.copy(at).applyMatrix4(bones[bone].matrixWorld);
  };
  // The bind pose, so an animation can always start from it.
  const rest = Object.fromEntries(list.map((b) => [b.name, { p: b.position.clone(), q: b.quaternion.clone() }]));
  return { object, bones, rest, body, lights, lightMaterial, skeleton, socket };
}

/** The flat-shaded material a robot's body wears, in finish `spec` (a spec's `[texture]`). */
export function bodyMaterial(spec) {
  const t = { ...HULL_TEXTURE, ...spec };
  return new THREE.MeshPhongMaterial({
    map: hullTexture(t),
    vertexColors: true,
    flatShading: true,
    shininess: t.shininess,
    specular: new THREE.Color().setScalar(t.specular),
    ...(t.reflectivity > 0 ? { envMap: metalEnvironment(), combine: THREE.MixOperation, reflectivity: t.reflectivity } : {}),
  });
}
