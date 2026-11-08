// Saving and opening projects. Under `npm start` they go to the repo
// (compositor-projects/, through src/setupProxy.js); a project can always be
// downloaded or opened from a file as well, which is all a deployed build
// can do.

import { serializeProject, parseProject } from './project';

const ROUTE = '/__compositor/projects';

/** The repo's projects, newest first, or null where there is no dev server. */
export async function listProjects() {
    try {
        const r = await fetch(ROUTE, { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
        const list = await r.json();
        return Array.isArray(list) ? list : null;
    } catch (e) {
        return null;
    }
}

export async function openProject(name) {
    const r = await fetch(`${ROUTE}/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`could not open ${name} (${r.status})`);
    return parseProject(await r.text());
}

/** Write to the repo. Resolves to the path written, or throws. */
export async function saveProject(name, project) {
    const r = await fetch(`${ROUTE}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: serializeProject({ ...project, name }),
    });
    if (!r.ok) throw new Error(`save failed (${r.status})`);
    return (await r.json()).path;
}

export function downloadProject(project) {
    const blob = new Blob([serializeProject(project)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(project.name || 'project').replace(/[^a-zA-Z0-9 _.-]+/g, '-')}.compositor.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function readProjectFile(file) {
    return parseProject(await file.text());
}
