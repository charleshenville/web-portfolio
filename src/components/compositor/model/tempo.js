// The project's tempo: one BPM every tempo field (a nod's, a tempo LFO's,
// the cut grid's) follows unless it is given its own. A field that follows
// keeps no number (null); it reads the project's when it is resolved, so
// changing the project's tempo moves them all.

export const DEFAULT_TEMPO = 120;

/** The project's tempo in BPM. */
export const projectTempo = (project) => (Number.isFinite(project?.tempo) && project.tempo > 0 ? project.tempo : DEFAULT_TEMPO);

/** A tempo field's BPM: its own if it has one, else the project's. */
export const bpmOr = (v, tempo) => (Number.isFinite(v) && v > 0 ? v : (Number.isFinite(tempo) && tempo > 0 ? tempo : DEFAULT_TEMPO));

/** `ctx` (a controller evaluation context, the audio analysis or null) that also knows the tempo. */
export function withTempo(ctx, tempo) {
    const out = Object.create(ctx || null);
    out.tempo = tempo;
    return out;
}
