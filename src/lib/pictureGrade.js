// The colour grade on a display-referred colour, and a grade of a picture's
// own built on it: shared by the compositor's Grade effect (over the frame),
// the footage and each video track, and screens (a prop's, a window's), so
// they all grade alike.

import * as THREE from 'three';

export const GRADE_GLSL = /* glsl */`
vec3 gradeHueRotate(vec3 c, float a) {
    const vec3 k = vec3(0.57735027);
    float ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec3 gradeColor(vec3 c, float exposure, float contrast, float gamma, float saturation, float temperature, float tint, float hue, float lift, float invert) {
    c = clamp(c, 0.0, 1.0);
    // Inverted first, so the rest of the grade works on the negative.
    if (invert > 0.5) c = 1.0 - c;
    vec3 l = pow(c, vec3(2.2));
    l *= exp2(exposure);
    l *= vec3(1.0 + 0.25 * temperature, 1.0 - 0.2 * tint, 1.0 - 0.25 * temperature);
    c = pow(max(l, 0.0), vec3(1.0 / 2.2));
    c = c + lift * (1.0 - c);
    c = (c - 0.5) * contrast + 0.5;
    c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / max(gamma, 0.05)));
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(y), c, saturation);
    return clamp(gradeHueRotate(c, hue * 3.14159265 / 180.0), 0.0, 1.0);
}`;

// ---- A graded picture ------------------------------------------------------------
//
// A picture's own grade (its gradeOn and grade params), applied to its
// texels as they are read, before anything else in the material (a screen's
// brightness) or over it.

const PICTURE_GRADE_KEYS = ['exposure', 'contrast', 'gamma', 'saturation', 'temperature', 'tint', 'hue', 'lift', 'invert'];
const GRADE_DEFAULTS = {
    exposure: 0, contrast: 1, gamma: 1, saturation: 1, temperature: 0, tint: 0, hue: 0, lift: 0, invert: 0,
};

/** Uniforms for gradePictureGlsl, set by setGradeUniforms. */
export function gradeUniforms() {
    const u = { gOn: { value: 0 } };
    PICTURE_GRADE_KEYS.forEach((k) => { u[`g_${k}`] = { value: GRADE_DEFAULTS[k] }; });
    return u;
}

/** Declarations for a shader that grades a picture (after GRADE_GLSL's uniforms). */
export const GRADE_PICTURE_DECL = /* glsl */`
uniform float gOn, ${PICTURE_GRADE_KEYS.map((k) => `g_${k}`).join(', ')};
${GRADE_GLSL}
// A linear-light picture colour, graded as it is seen.
vec3 gradePicture(vec3 c) {
    if (gOn < 0.5) return c;
    vec3 seen = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
    seen = gradeColor(seen, ${PICTURE_GRADE_KEYS.map((k) => `g_${k}`).join(', ')});
    return pow(seen, vec3(2.2));
}`;

/** Set gradeUniforms `u` from params p (gradeOn and the grade's), or turn the grade off when p is null. */
export function setGradeUniforms(u, p) {
    if (!u) return;
    u.gOn.value = p?.gradeOn ? 1 : 0;
    if (!p?.gradeOn) return;
    PICTURE_GRADE_KEYS.forEach((k) => {
        const v = k === 'invert' ? (p.invert ? 1 : 0) : p[k];
        u[`g_${k}`].value = Number.isFinite(v) ? v : GRADE_DEFAULTS[k];
    });
}

/** A MeshBasicMaterial that grades its map; setPictureGrade sets the grade. */
export function gradeMaterial(opts) {
    const m = new THREE.MeshBasicMaterial(opts);
    const u = gradeUniforms();
    m.userData.grade = u;
    m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
${GRADE_PICTURE_DECL}`)
            // The map is decoded to linear light; the grade works on what is
            // seen, and on the picture alone, before the colour scales it.
            .replace('#include <map_fragment>', `#ifdef USE_MAP
vec4 gradeTexel = texture2D(map, vMapUv);
gradeTexel.rgb = gradePicture(gradeTexel.rgb);
diffuseColor *= gradeTexel;
#endif`);
    };
    m.customProgramCacheKey = () => 'compositor-graded-picture';
    return m;
}

/** Grade `m` (a gradeMaterial) by params p (gradeOn and the grade's), or not at all when p is null. */
export function setPictureGrade(m, p) {
    setGradeUniforms(m.userData.grade, p);
}
