// Glow from the points alone, and the light they cast on the scene.
//
// The compositor's ordinary glow blooms the finished frame, so anything
// bright enough glows - a streetlight in the footage as much as a point. This
// pass instead draws only the points (with everything else in the scene
// writing depth, so a point behind the protagonist or the scan's mesh stays
// hidden), blooms that on its own, and lays it over the composite two ways:
//
//   halo   the bloom itself, added on top: the points glow.
//   bleed  the bloom as light falling on whatever is underneath it - the
//          footage, the mesh, the props. It is scaled by that surface's own
//          colour, so a pale wall near the points picks up their colour and
//          the asphalt beside it barely does, which is what makes the points
//          look like they are lighting the place rather than fogging the lens.
//
// The light reaches further than the halo: real light falls off far more
// slowly than a lens glow, so `reach` draws it from the bloom's widest blurs.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tHalo;
uniform sampler2D tMip2;
uniform sampler2D tMip3;
uniform sampler2D tMip4;
uniform sampler2D tHold;
uniform float holdOn;
uniform float halo;
uniform float bleed;
uniform float reach;
uniform float aspect;
varying vec2 vUv;

// Light that has travelled: the bloom's widest blur gathered over a disc a
// good fraction of the frame across, falling off with distance like light
// rather than like a lens glow. The widest blur is already smooth, so a
// spiral of taps is enough.
vec3 farLight(float radius) {
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 24; i++) {
        float fi = float(i) + 0.5;
        float r = sqrt(fi / 24.0) * radius;
        float a = fi * 2.39996;
        vec2 o = vec2(cos(a) / aspect, sin(a)) * r;
        // Equal-area taps, so weighting by 1/(1+d^2) gives the falloff.
        float d = r / max(radius, 1e-4) * 4.0;
        float w = 1.0 / (1.0 + d * d);
        sum += texture2D(tMip4, vUv + o).rgb * w;
        wsum += w;
    }
    return sum / wsum;
}

void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    vec3 glow = texture2D(tHalo, vUv).rgb;
    vec3 mid = (texture2D(tMip2, vUv).rgb + texture2D(tMip3, vUv).rgb + texture2D(tMip4, vUv).rgb) / 3.0;
    // Reach 0 keeps the light about as tight as the halo; 1 spreads it over
    // about half the frame. A wider spread thins the same light out, so it is
    // given back some of what it loses, as more of the cloud lights each spot.
    float radius = 0.04 + reach * 0.5;
    vec3 far = farLight(radius) * (1.0 + reach * 6.0);
    vec3 light = mix(glow * 0.5 + mid, mid * 0.5 + far, reach);
    // How much light a surface sends back. The footage is a photograph, so
    // its pixels already carry the scene's dim ambient light; a dark surface
    // is not black, just under-lit. The square root lifts those back towards
    // what they would reflect, so a night street still catches the light,
    // while the surface's colour still tints it.
    vec3 surface = sqrt(max(base.rgb, 0.0));
    vec3 lit = surface * light * bleed;
    // A held-out object (a matte) stands in front of every point: none of
    // their glow or light lands on it, however near its edge they are. Its
    // soft edges (motion blur) let the 3D partly through, but not the glow:
    // a strong Bleed through even half a matte reads as light on the object.
    float front = holdOn > 0.5 ? smoothstep(0.02, 0.35, texture2D(tHold, vUv).r) : 0.0;
    gl_FragColor = vec4(base.rgb + (glow * halo + lit) * (1.0 - front), base.a);
}`;

export class PointGlowPass extends Pass {
    constructor() {
        super();
        this.needsSwap = true;
        // What the points look like on their own, over black.
        this.source = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
        // Everything in the bloom's source passes its floor: the source is
        // only points, and a dim point should still light its surroundings.
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, 0.6, 0);
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                tHalo: { value: null },
                tMip2: { value: null },
                tMip3: { value: null },
                tMip4: { value: null },
                tHold: { value: null },
                holdOn: { value: 0 },
                halo: { value: 1 },
                bleed: { value: 0 },
                reach: { value: 0.5 },
                aspect: { value: 1 },
            },
            vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: FRAG,
            depthTest: false,
            depthWrite: false,
        });
        this.quad = new FullScreenQuad(this.material);
        this.halo = 1;
        this.bleed = 0;
        this.reach = 0.5;
        this.spread = 0.6;
        // Brightness the source must pass to bloom: 0 for points (a dim one
        // still lights its surroundings); a floor for a whole scene's objects.
        this.threshold = 0;
        // Set by the host each frame: draws the points into the bound target.
        this.drawSource = null;
        // And where held-out objects (mattes) stand in front, 0..1 in its red, or null.
        this.hold = null;
        this.black = new THREE.Color(0, 0, 0);
        this.prevClear = new THREE.Color();
    }

    setSize(width, height) {
        this.source.setSize(width, height);
        this.bloom.setSize(width, height);
    }

    render(renderer, writeBuffer, readBuffer) {
        renderer.getClearColor(this.prevClear);
        const prevAlpha = renderer.getClearAlpha();

        renderer.setRenderTarget(this.source);
        renderer.setClearColor(this.black, 1);
        renderer.clear();
        if (this.drawSource) this.drawSource(renderer);

        // The bloom adds its result back into its input; that is the source
        // here, which nothing reads afterwards, so it is left to do so.
        this.bloom.strength = 1;
        this.bloom.radius = this.spread;
        this.bloom.threshold = this.threshold;
        this.bloom.render(renderer, null, this.source, 0, false);

        const u = this.material.uniforms;
        u.tDiffuse.value = readBuffer.texture;
        u.tHalo.value = this.bloom.renderTargetsHorizontal[0].texture;
        u.tMip2.value = this.bloom.renderTargetsVertical[2].texture;
        u.tMip3.value = this.bloom.renderTargetsVertical[3].texture;
        u.tMip4.value = this.bloom.renderTargetsVertical[4].texture;
        u.halo.value = this.halo;
        u.bleed.value = this.bleed;
        u.reach.value = this.reach;
        u.tHold.value = this.hold;
        u.holdOn.value = this.hold ? 1 : 0;
        u.aspect.value = readBuffer.width / Math.max(1, readBuffer.height);
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);

        renderer.setClearColor(this.prevClear, prevAlpha);
    }

    dispose() {
        this.source.dispose();
        this.bloom.dispose();
        this.material.dispose();
        this.quad.dispose();
    }
}
