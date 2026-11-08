// Dream-like haze: a faint chromatic split and a cool-warm colour shift.
// The Compositor's Haze effect.
const DreamHazeShader = {
    uniforms: {
        tDiffuse: { value: null },
        time: { value: 0 },
        intensity: { value: 0.5 },
        // How much of the colour shift to apply. The chromatic split scales
        // with intensity but the shift never did, so it lands at full strength
        // the moment haze leaves zero; a host that starts at zero ramps this.
        tint: { value: 1 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float intensity;
        uniform float tint;
        varying vec2 vUv;

        void main() {
            vec2 uv = vUv;

            // Soft glow effect
            vec4 color = texture2D(tDiffuse, uv);

            // Subtle chromatic aberration for dream-like quality
            float offset = 0.002 * intensity;
            vec4 r = texture2D(tDiffuse, uv + vec2(offset, 0.0));
            vec4 b = texture2D(tDiffuse, uv - vec2(offset, 0.0));
            color.r = mix(color.r, r.r, 0.3);
            color.b = mix(color.b, b.b, 0.3);

            // Subtle color shift for dreamy atmosphere
            color.rgb *= mix(vec3(1.0), vec3(1.05, 0.98, 1.1), tint);

            gl_FragColor = color;
        }
    `
};

export default DreamHazeShader;
