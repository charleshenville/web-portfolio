// Object mattes for the Compositor: talking to the rotoscoping server
// while making them, and playing the finished ones back in step with the
// footage while compositing.
//
// Making them needs `npm start`: the dev server forwards /__scan-compositor/
// roto/* to backend/vidtrack/roto_server.py (SAM 2 on this machine) and
// starts it when first asked. A finished matte is a grayscale H.264 file
// beside the take (public/mv/<take>/<take>_matte_<id>_<stamp>.mp4, and a
// reversed copy for ping-pong), listed in src/data/mattes.json - so the
// published site plays mattes back without any of the above.
//
// Playback decodes the exact frame the footage is on (lib/mp4Frames), in the
// preview as in an export: a holdout a frame out of step with the footage
// shows as an edge sliding off the thing it is supposed to hug.

import * as THREE from 'three';
import bundledIndex from '../../data/mattes.json';
import { Mp4FrameReader } from '../mp4Frames';

const listeners = new Set();
const written = {}; // take -> entry, from a write this session (ahead of the bundle)

// Writing mattes rewrites the index this module imports. Accepting the update
// here keeps webpack from refreshing the whole compositor for it.
if (module.hot) {
    module.hot.accept('../../data/mattes.json', () => {
        // The bundle has caught up with the disk.
        Object.keys(written).forEach((k) => delete written[k]);
        listeners.forEach((fn) => fn());
    });
}

const stamp = (entry) => Math.max(0, ...((entry && entry.objects) || []).map((o) => o.writtenAt || 0));

/** The published mattes for a take: `[{ id, name, color, file, rev, frames, ... }]`. */
export function mattesFor(take) {
    // Whichever is newer: a write from the tool this session, or the index
    // (which a pipeline run may have rewritten since).
    const a = written[take];
    const b = bundledIndex[take];
    const entry = a && (!b || stamp(a) >= stamp(b)) ? a : b;
    return entry && Array.isArray(entry.objects) ? entry.objects : [];
}

export function onMattesChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Record a take's entry as the server just wrote it. */
export function setWritten(take, entry) {
    written[take] = entry;
    listeners.forEach((fn) => fn());
}

// ---- The server --------------------------------------------------------------

const BASE = '/__scan-compositor/roto';

async function ask(path, opts = {}) {
    const res = await fetch(`${BASE}/${path}`, { cache: 'no-store', ...opts });
    if (res.status === 204) return { res, empty: true };
    const type = res.headers.get('content-type') || '';
    if (!res.ok) {
        let msg = `${res.status}`;
        if (type.includes('json')) {
            try { msg = (await res.json()).error || msg; } catch (e) { /* keep status */ }
        } else if (res.status === 404) {
            msg = 'no roto endpoint here (rotoscoping needs npm start)';
        }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return { res, type };
}

const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const post = (path, body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

async function json(path, opts) {
    const { res } = await ask(path, opts);
    return res.json();
}

/** A mask PNG answer as `{ bitmap, rev }`, bitmap null when the frame has none. */
async function maskReply(path, opts) {
    const { res, empty } = await ask(path, opts);
    const rev = Number(res.headers.get('x-roto-rev') || 0);
    if (empty) return { bitmap: null, rev };
    const blob = await res.blob();
    return { bitmap: await createImageBitmap(blob), rev };
}

export const rotoApi = {
    session: (take) => json(`session?${q({ take })}`),
    status: (take) => json(`status?${q({ take })}`),
    mask: (take, obj, frame, rev = 0) => maskReply(`mask?${q({ take, obj, frame, rev })}`),
    object: (take, body) => json('object', post('object', { take, ...body })),
    prompt: (take, obj, frame, points, box) => maskReply('prompt', post('prompt', {
        take, obj, frame, points, box,
    })),
    stroke: (take, obj, frame, body) => maskReply('stroke', post('stroke', {
        take, obj, frame, ...body,
    })),
    propagate: (take, obj, mode, frame) => json('propagate', post('propagate', {
        take, obj, mode, frame,
    })),
    write: (take, matte, objs) => json('write', post('write', { take, matte, objs })),
    cancel: (take) => json('cancel', post('cancel', { take })),
};

// ---- Playback ------------------------------------------------------------------

/**
 * One published matte, decoded frame by frame to a texture. `want` asks for
 * the frame the footage is on; the decode lands a moment later and the
 * texture follows. Running backwards (ping-pong) reads the reversed copy, so
 * each step is still one decode rather than a trip back to a keyframe.
 */
export class MatteTrack {
    constructor(take, entry) {
        this.entry = entry;
        this.id = entry.id;
        const dir = `${process.env.PUBLIC_URL}/mv/${take}`;
        this.urls = { fwd: `${dir}/${entry.file}`, rev: entry.rev ? `${dir}/${entry.rev}` : null };
        this.readers = { fwd: null, rev: null };
        this.opening = {};
        this.texture = null; // null until the first frame lands
        this.frame = null; // the VideoFrame on the texture (ours to close)
        this.shown = null; // which take frame that is
        this.busy = false;
        this.queued = null;
        this.failed = false;
    }

    reader(back) {
        const key = back && this.urls.rev ? 'rev' : 'fwd';
        if (this.readers[key]) return Promise.resolve(this.readers[key]);
        if (!this.opening[key]) {
            this.opening[key] = Mp4FrameReader.open(this.urls[key]).then((r) => {
                if (this.disposed) { r?.close(); return null; }
                if (!r) this.failed = true;
                this.readers[key] = r;
                return r;
            }, () => { this.failed = true; return null; });
        }
        return this.opening[key];
    }

    /** Decode take frame `index` (going backwards: from the reversed copy). */
    async decode(index, back) {
        const r = await this.reader(back);
        if (!r || this.disposed) return false;
        const n = r.frameCount;
        const useRev = back && this.urls.rev && r === this.readers.rev;
        const k = Math.max(0, Math.min(n - 1, useRev ? n - 1 - index : index));
        const vf = await r.frame(k);
        if (!vf || this.disposed) return false;
        // The reader recycles its pictures; keep our own reference to this one.
        const mine = vf.clone();
        if (!this.texture) {
            this.texture = new THREE.VideoTexture(mine);
            // Coverage, not colour: sampled as stored.
            this.texture.colorSpace = THREE.NoColorSpace;
            this.texture.minFilter = THREE.LinearFilter;
            this.texture.magFilter = THREE.LinearFilter;
            this.texture.generateMipmaps = false;
        }
        this.texture.image = mine;
        this.texture.needsUpdate = true;
        this.frame?.close();
        this.frame = mine;
        this.shown = index;
        this.shownBack = back;
        return true;
    }

    /** Preview: follow the footage. Decodes run one at a time; the latest ask wins. */
    want(index, back) {
        if (this.failed || this.disposed) return;
        if (this.shown === index && this.shownBack === back) return;
        if (this.busy) { this.queued = [index, back]; return; }
        this.busy = true;
        this.decode(index, back)
            .catch(() => {})
            .finally(() => {
                this.busy = false;
                const nx = this.queued;
                this.queued = null;
                if (nx) this.want(nx[0], nx[1]);
            });
    }

    /** Export: this exact frame, before the frame is drawn. */
    async exact(index, back) {
        while (this.busy) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 1));
        }
        this.queued = null;
        this.busy = true;
        try {
            await this.decode(index, back);
        } finally {
            this.busy = false;
        }
    }

    get ready() { return !!this.texture && this.shown != null; }

    dispose() {
        this.disposed = true;
        Object.values(this.readers).forEach((r) => r?.close());
        this.frame?.close();
        this.texture?.dispose();
    }
}

/** A take's published mattes, by id. */
export class MatteSet {
    constructor() {
        this.take = null;
        this.tracks = new Map();
        this.key = '';
    }

    /** Load (or keep) the tracks for `entries`; returns whether anything changed. */
    set(take, entries) {
        const key = `${take}|${entries.map((e) => `${e.id}:${e.file}`).join(',')}`;
        if (key === this.key) return false;
        this.key = key;
        const keep = new Map();
        entries.forEach((e) => {
            const old = this.tracks.get(e.id);
            if (old && take === this.take && old.entry.file === e.file) keep.set(e.id, old);
            else keep.set(e.id, new MatteTrack(take, e));
        });
        this.tracks.forEach((t, id) => { if (keep.get(id) !== t) t.dispose(); });
        this.tracks = keep;
        this.take = take;
        return true;
    }

    get(id) { return this.tracks.get(id) || null; }

    texture(id) {
        const t = this.tracks.get(id);
        return t && t.ready ? t.texture : null;
    }

    /** Preview: put every matte in `ids` on take frame `index`. */
    follow(ids, index, back) {
        ids.forEach((id) => this.tracks.get(id)?.want(index, back));
    }

    exact(ids, index, back) {
        return Promise.all(ids.map((id) => this.tracks.get(id)?.exact(index, back)));
    }

    dispose() {
        this.tracks.forEach((t) => t.dispose());
        this.tracks.clear();
        this.key = '';
    }
}

// ---- Holdout pass ---------------------------------------------------------------

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Builds the frame's combined holdout (the most covering of every matte in
 * use) and lays the shot as it was before the front pass back over the
 * front pass through it - so whatever 3D was drawn in front of the video
 * disappears behind the real object, glow and window effects untouched.
 */
export class HoldoutPass {
    constructor(renderer) {
        this.renderer = renderer;
        this.holdRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
        // The shot as it stood before the front pass, in linear light.
        this.baseRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.scene = new THREE.Scene();
        this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.maxMat = new THREE.ShaderMaterial({
            uniforms: { tMatte: { value: null }, invert: { value: 0 }, crop: { value: new THREE.Vector2(1, 1) } },
            vertexShader: QUAD_VERT,
            fragmentShader: /* glsl */`
                uniform sampler2D tMatte;
                uniform float invert;
                uniform vec2 crop; // the footage's crop to the frame
                varying vec2 vUv;
                void main() {
                    // H.264 keeps a little noise in the flat areas; snap it.
                    float m = smoothstep(0.03, 0.97, texture2D(tMatte, (vUv - 0.5) * crop + 0.5).r);
                    gl_FragColor = vec4(vec3(mix(m, 1.0 - m, invert)), 1.0);
                }`,
            depthTest: false,
            depthWrite: false,
            blending: THREE.CustomBlending,
            blendEquation: THREE.MaxEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneFactor,
        });
        this.overMat = new THREE.ShaderMaterial({
            uniforms: { tBase: { value: null }, tHold: { value: null } },
            vertexShader: QUAD_VERT,
            fragmentShader: /* glsl */`
                uniform sampler2D tBase;
                uniform sampler2D tHold;
                varying vec2 vUv;
                void main() {
                    gl_FragColor = vec4(texture2D(tBase, vUv).rgb, texture2D(tHold, vUv).r);
                    #include <encodings_fragment>
                }`,
            depthTest: false,
            depthWrite: false,
            transparent: true,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.maxMat);
        this.quad.frustumCulled = false;
        this.scene.add(this.quad);
    }

    ensure(size) {
        if (this.holdRT.width !== size.x || this.holdRT.height !== size.y) {
            this.holdRT.setSize(size.x, size.y);
            this.baseRT.setSize(size.x, size.y);
        }
    }

    /**
     * Combine `textures` into the holdout target. `crop` is how the footage
     * is cropped to cover the frame ((1, 1) when it fills it exactly), so a
     * matte lands on the object whatever shape the output is.
     */
    build(textures, size, crop = null) {
        this.ensure(size);
        const r = this.renderer;
        const prev = r.getRenderTarget();
        r.setRenderTarget(this.holdRT);
        r.setClearColor(0x000000, 1);
        r.clear(true, false, false);
        this.quad.material = this.maxMat;
        if (crop) this.maxMat.uniforms.crop.value.copy(crop); else this.maxMat.uniforms.crop.value.set(1, 1);
        textures.forEach((tex) => {
            this.maxMat.uniforms.tMatte.value = tex;
            r.render(this.scene, this.cam);
        });
        r.setRenderTarget(prev);
    }

    /** Over whatever target is bound: `base` wherever the holdout covers. */
    apply(baseTexture) {
        this.quad.material = this.overMat;
        this.overMat.uniforms.tBase.value = baseTexture;
        this.overMat.uniforms.tHold.value = this.holdRT.texture;
        this.renderer.render(this.scene, this.cam);
    }

    dispose() {
        this.holdRT.dispose();
        this.baseRT.dispose();
        this.maxMat.dispose();
        this.overMat.dispose();
        this.quad.geometry.dispose();
    }
}
