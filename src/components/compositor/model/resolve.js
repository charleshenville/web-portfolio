// Parameters at a moment: an owner's own values with its controller links
// applied. Pure, so the preview, the inspector's live readout and an export
// all agree on what a linked parameter is at any time.

import { controllerValue, switchAt } from './controllers';
import { applyMap, mixColor } from './maps';
import { paramDefs, trackDefs } from './schema';

/**
 * A per-frame evaluation context: controller values are worked out once a
 * frame however many links read them.
 */
export function makeFrame(project, t, analysis) {
    const byId = new Map(project.controllers.map((c) => [c.id, c]));
    const cache = new Map();
    return {
        t,
        analysis,
        controller: (id) => byId.get(id),
        value(id) {
            if (cache.has(id)) return cache.get(id);
            const v = controllerValue(byId.get(id), t, analysis);
            cache.set(id, v);
            return v;
        },
    };
}

export function linkValue(def, link, frame) {
    const c = frame.controller(link.controller);
    if (!c) return undefined;
    if (c.type === 'switch' && Number.isInteger(link.state)) {
        let on = switchAt(c, frame.t) === link.state;
        if (link.map === 'inverted') on = !on;
        if (def.type === 'bool') return on;
        if (def.type === 'color') return on ? link.to : link.from;
        return on ? link.to : link.from;
    }
    const x = applyMap(link.map, frame.value(c.id));
    if (def.type === 'bool') return x >= 0.5;
    if (def.type === 'color') return mixColor(link.from, link.to, x);
    const from = Number.isFinite(link.from) ? link.from : 0;
    const to = Number.isFinite(link.to) ? link.to : 1;
    return from + (to - from) * x;
}

function resolveWith(owner, defs, frame) {
    const links = owner.links;
    if (!links || !frame) return owner.params;
    const keys = Object.keys(links);
    if (!keys.length) return owner.params;
    const out = { ...owner.params };
    for (const key of keys) {
        const def = defs.get(key);
        if (!def || def.link === false) continue;
        const v = linkValue(def, links[key], frame);
        if (v !== undefined) out[key] = v;
    }
    return out;
}

export const resolveObject = (obj, frame) => resolveWith(obj, paramDefs(obj.type), frame);
export const resolveTrack = (track, frame) => resolveWith(track, trackDefs(track.kind), frame);
