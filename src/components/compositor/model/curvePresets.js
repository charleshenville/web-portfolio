// Ready-made equations: the Curve's shapes (lib/audioScene's CURVES)
// written out, so an Equation can draw any of them, and a few classics.

export const CURVE_FORMULAS = {
    helix: { x: 'cos(t)', y: 't/(3π) - 1', z: 'sin(t)', from: 0, to: 18.8496 },
    lissajous: { x: 'sin(3t)', y: 'sin(2t)', z: 'cos(4t)', from: 0, to: 6.2832 },
    rose: { x: 'cos(4t) cos(t)', y: 'cos(4t) sin(t)', z: '0.25 sin(3t)', from: 0, to: 6.2832 },
    trefoil: { x: '(sin(t) + 2 sin(2t))/3', y: '(cos(t) - 2 cos(2t))/3', z: '-sin(3t)/3', from: 0, to: 6.2832 },
    figure8: { x: 'sin(t)', y: 'sin(t) cos(t)', z: '0.3 cos(t)', from: 0, to: 6.2832 },
    spiral: { x: 't/(8π) cos(t)', y: 't/(4π) - 1', z: 't/(8π) sin(t)', from: 0, to: 25.1327 },
    torusKnot: { x: '(cos(3t) + 2) cos(2t)/3', y: '(cos(3t) + 2) sin(2t)/3', z: '-sin(3t)/3', from: 0, to: 6.2832 },
};

/** The Equation's preset menu: [id, label, formula]. */
export const EQUATION_PRESETS = [
    ['circle', 'Circle', { x: 'cos(t)', y: 'sin(t)', z: '0', from: 0, to: 6.2832 }],
    ['sine', 'Sine wave', { x: 't', y: 'sin(2π t)/2', z: '0', from: -1, to: 1 }],
    ['parabola', 'Parabola', { x: 't', y: 't^2 - 0.5', z: '0', from: -1, to: 1 }],
    ['lemniscate', 'Lemniscate', { x: 'cos(t)/(1 + sin(t)^2)', y: 'sin(t) cos(t)/(1 + sin(t)^2)', z: '0', from: 0, to: 6.2832 }],
    ['cardioid', 'Cardioid', { x: '(1 - cos(t)) cos(t)/2', y: '(1 - cos(t)) sin(t)/2', z: '0', from: 0, to: 6.2832 }],
    ['helix', 'Helix', CURVE_FORMULAS.helix],
    ['lissajous', 'Lissajous', CURVE_FORMULAS.lissajous],
    ['rose', 'Rose', CURVE_FORMULAS.rose],
    ['trefoil', 'Trefoil knot', CURVE_FORMULAS.trefoil],
    ['figure8', 'Figure eight', CURVE_FORMULAS.figure8],
    ['spiral', 'Spiral', CURVE_FORMULAS.spiral],
    ['torusKnot', 'Torus knot', CURVE_FORMULAS.torusKnot],
];
