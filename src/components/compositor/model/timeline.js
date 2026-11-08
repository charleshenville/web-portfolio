// The timeline: tracks of clips, and what is on screen at a moment.
//
// Video tracks are listed top first. At any time the topmost visible clip
// that is a 3D scene (a take, or an empty stage) is the base: its scene is
// rendered, through its take's solve or a camera object. Plain video clips
// on visible tracks above it composite over it as flat layers. Anything
// below the base is hidden. Audio tracks are mixed; the mix is what the audio
// controllers listen to.
//
// A clip plays its media from `in` (seconds into the source) for `dur`
// seconds of timeline, at `rate`, and when it runs past the end of its
// source either holds, loops, or ping-pongs.

export const LOOP_MODES = [
    ['off', 'Hold'],
    ['loop', 'Loop'],
    ['bounce', 'Ping-pong'],
];

export const is3D = (media) => media && (media.kind === 'take' || media.kind === 'stage');

/** Seconds of source a clip can play from `in`, or Infinity for a stage. */
export function sourceSpan(clip, media) {
    if (!media) return 0;
    if (media.kind === 'stage') return Infinity;
    const d = Number.isFinite(media.duration) ? media.duration : 0;
    return Math.max(1 / 120, d - (clip.in || 0));
}

/**
 * Where in its source a clip is at timeline time `t`: `{ time, dir }`, dir
 * -1 on the way back of a ping-pong. Null when the clip is not under `t`.
 */
export function clipSourceTime(clip, media, t, { clampEnd = true } = {}) {
    if (!clip || t < clip.start - 1e-9 || (clampEnd && t >= clip.start + clip.dur)) return null;
    const span = sourceSpan(clip, media);
    const local = Math.max(0, (t - clip.start) * (clip.rate || 1));
    if (!Number.isFinite(span)) return { time: (clip.in || 0) + local, dir: 1 };
    let s;
    let dir = 1;
    if (clip.loop === 'loop') {
        s = local % span;
    } else if (clip.loop === 'bounce') {
        const period = span * 2;
        const p = local % period;
        if (p < span) s = p;
        else { s = period - p; dir = -1; }
    } else {
        // A video element never quite reaches its stated duration.
        s = Math.min(local, Math.max(0, span - 1 / 60));
    }
    return { time: (clip.in || 0) + s, dir };
}

export const clipEnd = (c) => c.start + c.dur;

export function projectDuration(project) {
    let end = 0;
    (project.clips || []).forEach((c) => { end = Math.max(end, clipEnd(c)); });
    return Math.max(1, end);
}

/**
 * What the program shows at `t`: the base 3D clip (or null) and the plain
 * video clips over it, bottom first. `trackOn(track)` says whether a track
 * is visible at `t` (links resolved).
 */
export function programAt(project, t, trackOn = (tr) => tr.params?.visible !== false) {
    const media = new Map(project.media.map((m) => [m.id, m]));
    const videoTracks = project.tracks.filter((tr) => tr.kind === 'video');
    const overlays = [];
    let base = null;
    for (const tr of videoTracks) {
        if (!trackOn(tr)) continue;
        const clip = project.clips.find((c) => c.trackId === tr.id && t >= c.start && t < clipEnd(c));
        if (!clip) continue;
        const m = media.get(clip.mediaId);
        if (!m) continue;
        if (is3D(m)) { base = { clip, media: m, track: tr }; break; }
        overlays.push({ clip, media: m, track: tr });
    }
    overlays.reverse();
    return { base, overlays };
}

/** Audio clips under `t`. */
export const audioClipsAt = (project, t) => project.clips.filter((c) => {
    const tr = project.tracks.find((x) => x.id === c.trackId);
    return tr?.kind === 'audio' && t >= c.start && t < clipEnd(c);
});

/** Free room on a track starting at `at` for `dur`: true if nothing overlaps. */
export function fits(project, trackId, at, dur, ignoreId = null) {
    return !project.clips.some((c) => c.trackId === trackId && c.id !== ignoreId
        && at < clipEnd(c) - 1e-6 && at + dur > c.start + 1e-6);
}

/** The first time at or after `at` on a track where `dur` fits. */
export function firstFit(project, trackId, at, dur) {
    const clips = project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
    let t = Math.max(0, at);
    for (const c of clips) {
        if (t + dur <= c.start + 1e-6) break;
        if (t < clipEnd(c)) t = clipEnd(c);
    }
    return t;
}
