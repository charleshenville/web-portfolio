// Colour correction for a take's scan texture: the photogrammetry texture
// usually comes out darker and flatter than the footage, so each take keeps a
// correction that brings its textured mesh (and its scan-coloured points) in
// line. A property of the take, like the asset library is of the assets, so
// it is saved apart from projects:
//   1. Under `npm start`, into src/data/takeLooks.json through the dev
//      server (src/setupProxy.js), so it is in the repo and ships.
//   2. Always, into this browser's storage, as a fallback.
// On load, per take, whichever is newer wins.

import bundled from '../../data/takeLooks.json';

// Saving rewrites the JSON this module imports; accepting the update here
// keeps webpack from reloading the compositor every time a slider moves.
if (module.hot) module.hot.accept('../../data/takeLooks.json');

const STORAGE_KEY = 'compositor:take-looks';
const ENDPOINT = '/__compositor/take-looks';

export const LOOK_DEFAULTS = {
    exposure: 0, contrast: 1, gamma: 1, saturation: 1, temperature: 0,
};

export const LOOK_FIELDS = [
    ['exposure', 'Exposure', -2, 3, 0.01],
    ['contrast', 'Contrast', 0.3, 2, 0.01],
    ['gamma', 'Gamma', 0.3, 3, 0.01],
    ['saturation', 'Saturation', 0, 2, 0.01],
    ['temperature', 'Temperature', -1, 1, 0.01],
];

export const isNeutralLook = (l) => !l || Object.entries(LOOK_DEFAULTS).every(([k, v]) => Math.abs((l[k] ?? v) - v) < 1e-6);

function readLocal() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : null;
        return data && typeof data === 'object' ? data : null;
    } catch (e) {
        return null;
    }
}

/** Every take's correction: the repo's, with any newer edits from this browser on top. */
export function loadLooks() {
    const out = JSON.parse(JSON.stringify(bundled || {}));
    const local = readLocal() || {};
    Object.entries(local).forEach(([take, l]) => {
        if (!out[take] || (l.updatedAt || 0) > (out[take].updatedAt || 0)) out[take] = l;
    });
    return out;
}

const tidy = (looks) => {
    const keep = {};
    Object.keys(looks).sort().forEach((take) => {
        const l = looks[take];
        if (isNeutralLook(l)) return;
        keep[take] = { ...LOOK_DEFAULTS, ...l };
    });
    return keep;
};

/** Persist every take's correction. Resolves to 'repo' or 'browser'. */
export async function saveLooks(looks) {
    const data = tidy(looks);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ }
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: `${JSON.stringify(data, null, 2)}\n`,
        });
        if (res.ok) return 'repo';
    } catch (e) { /* no dev server here */ }
    return 'browser';
}

// ---- The shader ----------------------------------------------------------------------

/**
 * Hook a material so its colour (after the texture or vertex colours) goes
 * through `uniforms` (from makeLookUniforms). Works in linear light the way
 * the material does: the correction itself is made on display values.
 */
export function makeLookUniforms() {
    return {
        uLookExposure: { value: 0 },
        uLookContrast: { value: 1 },
        uLookGamma: { value: 1 },
        uLookSaturation: { value: 1 },
        uLookTemperature: { value: 0 },
    };
}

export function setLookUniforms(u, look) {
    const l = { ...LOOK_DEFAULTS, ...(look || {}) };
    u.uLookExposure.value = l.exposure;
    u.uLookContrast.value = l.contrast;
    u.uLookGamma.value = l.gamma;
    u.uLookSaturation.value = l.saturation;
    u.uLookTemperature.value = l.temperature;
}

const GLSL = /* glsl */`
uniform float uLookExposure, uLookContrast, uLookGamma, uLookSaturation, uLookTemperature;
vec3 scanLook(vec3 c) {
    vec3 g = pow(max(c, 0.0), vec3(1.0 / 2.2));
    g *= exp2(uLookExposure);
    g = (g - 0.5) * uLookContrast + 0.5;
    g = pow(max(g, 0.0), vec3(1.0 / max(uLookGamma, 0.05)));
    float y = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = mix(vec3(y), g, uLookSaturation);
    g *= vec3(1.0 + 0.25 * uLookTemperature, 1.0, 1.0 - 0.25 * uLookTemperature);
    return pow(max(g, 0.0), vec3(2.2));
}
`;

/** Patch `material` (after `chunk`, e.g. 'map_fragment' or 'color_fragment') to apply the look. */
export function hookLook(material, uniforms, chunk) {
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${GLSL}`)
            .replace(`#include <${chunk}>`, `#include <${chunk}>\ndiffuseColor.rgb = scanLook(diffuseColor.rgb);`);
    };
    material.customProgramCacheKey = () => `scanLook:${chunk}`;
    material.needsUpdate = true;
}
