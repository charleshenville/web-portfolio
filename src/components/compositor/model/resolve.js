// Parameters at a moment: an owner's own values with its controller links
// applied. Pure, so the preview, the inspector's live readout and an export
// all agree on what a linked parameter is at any time.

import {
    controllerValue, switchAt, isSwitch, textAt,
} from './controllers';
import { applyMap, mixColor } from './maps';
import { paramDefs, trackDefs } from './schema';
import { projectTempo, withTempo } from './tempo';

/**
 * A per-frame evaluation context: controller values are worked out once a
 * frame however many links read them.
 */
export function makeFrame(project, t, analysis) {
    const byId = new Map(project.controllers.map((c) => [c.id, c]));
    const cache = new Map();
    const tempo = projectTempo(project);
    const ctx = withTempo(analysis, tempo);
    return {
        t,
        analysis,
        project,
        tempo,
        controller: (id) => byId.get(id),
        value(id) {
            if (cache.has(id)) return cache.get(id);
            const v = controllerValue(byId.get(id), t, ctx, (x) => byId.get(x));
            cache.set(id, v);
            return v;
        },
    };
}

/** A select's option values. */
const optionValues = (def) => (def.options || []).map(([v]) => v);

/**
 * What `link` makes `def` at this frame. Every kind of parameter can be
 * linked: a number swings between `from` and `to`, a colour mixes them, and
 * a toggle, a choice or a piece of text is one or the other (a choice also
 * steps through the options between them as the signal rises). A Switch
 * picks `to` in its chosen state and `from` otherwise; text linked to a
 * Text controller shows its words.
 */
export function linkValue(def, link, frame) {
    const c = frame.controller(link.controller);
    if (!c) return undefined;
    const words = def.type === 'text' || def.type === 'string';
    if (words && c.type === 'text' && !Number.isInteger(link.state)) return textAt(c, frame.t, frame.controller);
    if (isSwitch(c) && Number.isInteger(link.state)) {
        let on = switchAt(c, frame.t, frame.controller) === link.state;
        if (link.map === 'inverted') on = !on;
        if (def.type === 'bool') return on;
        return on ? link.to : link.from;
    }
    const x = applyMap(link.map, frame.value(c.id));
    if (def.type === 'bool') return x >= 0.5;
    if (def.type === 'color') return mixColor(link.from, link.to, x);
    if (words) return x >= 0.5 ? link.to : link.from;
    if (def.type === 'select') {
        const opts = optionValues(def);
        const a = opts.indexOf(link.from);
        const b = opts.indexOf(link.to);
        if (a < 0 || b < 0) return x >= 0.5 ? link.to : link.from;
        return opts[Math.round(a + (b - a) * x)];
    }
    const from = Number.isFinite(link.from) ? link.from : 0;
    const to = Number.isFinite(link.to) ? link.to : 1;
    const v = from + (to - from) * x;
    // What rebuilds something moves in its own steps, so a smooth signal
    // rebuilds it only as it crosses one, not every frame.
    if (def.rebuilds && def.step > 0) {
        const lo = Number.isFinite(def.min) ? def.min : 0;
        return lo + Math.round((v - lo) / def.step) * def.step;
    }
    return v;
}

// The keys of a set of parameters that are tempos (follow the project's when unset).
const tempoCache = new WeakMap();
function tempoKeys(defs) {
    let k = tempoCache.get(defs);
    if (!k) {
        k = [];
        defs.forEach((d, key) => { if (d.tempo) k.push(key); });
        tempoCache.set(defs, k);
    }
    return k;
}

function resolveWith(owner, defs, frame) {
    const links = owner.links;
    const tempos = tempoKeys(defs).filter((key) => !(Number.isFinite(owner.params[key]) && owner.params[key] > 0));
    if (tempos.length) {
        // Tempo fields that follow the project read its tempo.
        const tempo = frame ? frame.tempo : projectTempo(null);
        owner = { ...owner, params: { ...owner.params, ...Object.fromEntries(tempos.map((key) => [key, tempo])) } };
    }
    if (!links || !frame) return owner.params;
    const keys = Object.keys(links);
    if (!keys.length) return owner.params;
    const out = { ...owner.params };
    for (const key of keys) {
        const def = defs.get(key);
        if (!def) continue;
        const v = linkValue(def, links[key], frame);
        if (v !== undefined) out[key] = v;
    }
    return out;
}

export const resolveObject = (obj, frame) => resolveWith(obj, paramDefs(obj.type), frame);
export const resolveTrack = (track, frame) => resolveWith(track, trackDefs(track.kind), frame);
