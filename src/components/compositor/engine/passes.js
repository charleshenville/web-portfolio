// Post passes for the compositor's Effects: the colour grade (the track
// editor's, which this replaces) as a three ShaderPass, on display colour
// after gamma, like the haze.

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
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float aspect, exposure, contrast, gamma, saturation, temperature, tint, hue, lift, vignette;
        varying vec2 vUv;

        vec3 hueRotate(vec3 c, float a) {
            const vec3 k = vec3(0.57735027);
            float ca = cos(a);
            return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
        }

        void main() {
            vec4 src = texture2D(tDiffuse, vUv);
            vec3 c = clamp(src.rgb, 0.0, 1.0);
            vec3 l = pow(c, vec3(2.2));
            l *= exp2(exposure);
            l *= vec3(1.0 + 0.25 * temperature, 1.0 - 0.2 * tint, 1.0 - 0.25 * temperature);
            c = pow(max(l, 0.0), vec3(1.0 / 2.2));
            c = c + lift * (1.0 - c);
            c = (c - 0.5) * contrast + 0.5;
            c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / max(gamma, 0.05)));
            float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(vec3(y), c, saturation);
            c = hueRotate(c, hue * 3.14159265 / 180.0);
            vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
            float r = length(d) / length(0.5 * vec2(aspect, 1.0));
            c *= 1.0 - vignette * smoothstep(0.3, 1.0, r);
            gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
        }`,
};

export const GRADE_KEYS = ['exposure', 'contrast', 'gamma', 'saturation', 'temperature', 'tint', 'hue', 'lift', 'vignette'];
