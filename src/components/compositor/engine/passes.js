// Post passes for the compositor's Effects: the colour grade (the track
// editor's, which this replaces) as a three ShaderPass, on display colour
// after gamma, like the haze.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GRADE_GLSL, gradeMaterial, setPictureGrade } from '../../../lib/pictureGrade';

// The grade itself (lib/pictureGrade.js), shared with the grade of footage,
// video tracks and screens, so they grade alike.
export { GRADE_GLSL, gradeMaterial, setPictureGrade };

export const GradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        aspect: { value: 1 },
        exposure: { value: 0 },
        contrast: { value: 1 },
        gamma: { value: 1 },
        saturation: { value: 1 },
        temperature: { value: 0 },
        tint: { value: 0 },
        hue: { value: 0 },
        lift: { value: 0 },
        vignette: { value: 0 },
        invert: { value: 0 },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float aspect, exposure, contrast, gamma, saturation, temperature, tint, hue, lift, vignette, invert;
        varying vec2 vUv;
        ${GRADE_GLSL}
        void main() {
            vec4 src = texture2D(tDiffuse, vUv);
            vec3 c = gradeColor(src.rgb, exposure, contrast, gamma, saturation, temperature, tint, hue, lift, invert);
            vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
            float r = length(d) / length(0.5 * vec2(aspect, 1.0));
            c *= 1.0 - vignette * smoothstep(0.3, 1.0, r);
            gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
        }`,
};

export const GRADE_KEYS = ['exposure', 'contrast', 'gamma', 'saturation', 'temperature', 'tint', 'hue', 'lift', 'vignette'];

// ---- Mattes on top of the glow --------------------------------------------------
//
// A matte (a held-out real object) stands in front of all the 3D, which the
// composite already respects. The glows come after it, on the finished
// frame, and would spill their halo and light back over the object. So the
// frame is kept as it stood before the glows (MatteSnapPass), and laid back
// over the glowed one wherever the matte is (MatteTopPass): nothing a glow
// does lands on a held-out object.

const COPY = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }',
    depthTest: false,
    depthWrite: false,
});

/** Keeps a copy of the frame as it reaches it; passes the frame on untouched. */
export class MatteSnapPass extends Pass {
    constructor() {
        super();
        this.needsSwap = false;
        this.snap = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.quad = new FullScreenQuad(COPY);
    }

    setSize(w, h) { this.snap.setSize(w, h); }

    render(renderer, writeBuffer, readBuffer) {
        COPY.uniforms.tDiffuse.value = readBuffer.texture;
        renderer.setRenderTarget(this.snap);
        this.quad.render(renderer);
    }

    dispose() { this.snap.dispose(); this.quad.dispose(); }
}

export const MatteTopShader = {
    uniforms: {
        tDiffuse: { value: null },
        tBase: { value: null },
        tHold: { value: null },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tBase;
        uniform sampler2D tHold;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            // Firmer than the matte's own soft edge: glow through half a blurred finger still reads as light on it.
            float h = smoothstep(0.02, 0.35, texture2D(tHold, vUv).r);
            gl_FragColor = vec4(mix(c.rgb, texture2D(tBase, vUv).rgb, h), c.a);
        }`,
};
