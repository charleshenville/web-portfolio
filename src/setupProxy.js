// Dev-server middleware (create-react-app loads this file by itself when
// `npm start` runs; it is not part of the build).
//
// The Compositor's asset library - which placed assets are screens and
// where each screen's surface sits - is edited in the tool and has to outlive
// the browser. This lets the tool write it straight back into the repo, to
// the JSON the build bundles, so an edit made once is committed like any
// other change and ships with the site. It writes that one file and nothing
// else, and only for requests from this machine.
//
// The file lives in src rather than public on purpose: the dev server reloads
// the page whenever anything under public changes, which would throw away the
// session on every save. (A change in src is picked up by webpack, and the
// library module accepts it without refreshing the tool.)
//
// It also forwards /__scan-compositor/roto/* to the rotoscoping server
// (backend/vidtrack/roto_server.py: SAM 2, kept loaded on 127.0.0.1), and
// starts that server the first time it is asked for, so `npm start` is all
// the Roto panel needs. Like the library endpoint it answers only this
// machine, and none of it exists in the build.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const LIBRARY = path.join(__dirname, 'data', 'scanAssetLibrary.json');
const ROUTE = '/__scan-compositor/library';
const MAX_BYTES = 1024 * 1024;

const isLocal = (req) => {
    const a = req.socket && req.socket.remoteAddress;
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

// ---- Roto ------------------------------------------------------------------

const ROTO_ROUTE = '/__scan-compositor/roto';
const ROTO_PORT = Number(process.env.ROTO_PORT) || 8765;
const BACKEND = path.join(__dirname, '..', 'backend');
const ROTO_PY = path.join(BACKEND, 'venv', 'bin', 'python');
const ROTO_SERVER = path.join(BACKEND, 'vidtrack', 'roto_server.py');
const ROTO_LOG = path.join(BACKEND, 'vidtrack', 'roto_server.log');

let rotoProc = null;
let rotoStarting = null;

function rotoRequest(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: ROTO_PORT,
            method,
            path: url,
            headers: { ...headers, 'Content-Length': body ? body.length : 0 },
        }, resolve);
        req.on('error', reject);
        req.setTimeout(600000, () => req.destroy(new Error('roto server timed out')));
        if (body) req.write(body);
        req.end();
    });
}

const rotoUp = () => rotoRequest('GET', '/health').then((r) => { r.resume(); return r.statusCode === 200; }, () => false);

// Start the server, unless one is already listening (say, run by hand with
// another model). It dies with the dev server.
function startRoto() {
    if (rotoStarting) return rotoStarting;
    rotoStarting = (async () => {
        if (await rotoUp()) return true;
        if (!fs.existsSync(ROTO_PY)) throw new Error(`no Python at ${ROTO_PY}`);
        const log = fs.openSync(ROTO_LOG, 'a');
        rotoProc = spawn(ROTO_PY, [ROTO_SERVER, '--port', String(ROTO_PORT)], {
            cwd: path.dirname(ROTO_SERVER),
            stdio: ['ignore', log, log],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        rotoProc.on('exit', () => { rotoProc = null; rotoStarting = null; });
        for (let i = 0; i < 120; i++) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 250));
            // eslint-disable-next-line no-await-in-loop
            if (await rotoUp()) return true;
            if (!rotoProc) break;
        }
        throw new Error(`the roto server did not start; see ${path.relative(process.cwd(), ROTO_LOG)}`);
    })();
    rotoStarting.catch(() => { rotoStarting = null; });
    return rotoStarting;
}

// react-scripts exits on SIGINT/SIGTERM itself; take the model down with it.
process.on('exit', () => { if (rotoProc) rotoProc.kill(); });

function rotoProxy(req, res) {
    if (!isLocal(req)) { res.status(403).end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        const body = chunks.length ? Buffer.concat(chunks) : null;
        const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
        let up;
        try {
            up = await rotoRequest(req.method, req.url, body, headers);
        } catch (e) {
            if (e.code !== 'ECONNREFUSED') { res.status(502).json({ error: e.message }); return; }
            try {
                await startRoto();
                up = await rotoRequest(req.method, req.url, body, headers);
            } catch (e2) {
                res.status(502).json({ error: e2.message });
                return;
            }
        }
        res.status(up.statusCode);
        ['content-type', 'content-length', 'x-roto-rev'].forEach((h) => {
            if (up.headers[h] != null) res.set(h, up.headers[h]);
        });
        res.set('Cache-Control', 'no-store');
        up.pipe(res);
    });
}

// ---- Compositor projects -----------------------------------------------------
//
// The compositor's project files live in the repo, in compositor-projects/,
// so a project is committed like any other change. Outside src and public on
// purpose: neither webpack nor the dev server's public watcher reloads the
// page when one is saved. Like everything here it answers only this machine.

const PROJECTS = path.join(__dirname, '..', 'compositor-projects');
const PROJECTS_ROUTE = '/__compositor/projects';
const PROJECT_MAX = 32 * 1024 * 1024; // camera paths add up
const slug = (name) => String(name || '').trim().replace(/\.json$/i, '').replace(/[^a-zA-Z0-9 _.-]+/g, '-').slice(0, 80);

function projectsRoute(req, res) {
    if (!isLocal(req)) { res.status(403).end(); return; }
    res.set('Cache-Control', 'no-store');
    const name = slug(decodeURIComponent((req.path || '/').slice(1)));
    if (req.method === 'GET' && !name) {
        if (!fs.existsSync(PROJECTS)) { res.json([]); return; }
        const list = fs.readdirSync(PROJECTS).filter((f) => f.endsWith('.json')).map((f) => {
            const st = fs.statSync(path.join(PROJECTS, f));
            return { name: f.replace(/\.json$/, ''), updated: st.mtimeMs, size: st.size };
        }).sort((a, b) => b.updated - a.updated);
        res.json(list);
        return;
    }
    if (!name) { res.status(400).json({ error: 'no project name' }); return; }
    const file = path.join(PROJECTS, `${name}.json`);
    if (req.method === 'GET') {
        if (!fs.existsSync(file)) { res.status(404).json({ error: 'no such project' }); return; }
        res.type('application/json').send(fs.readFileSync(file, 'utf8'));
        return;
    }
    if (req.method !== 'PUT' && req.method !== 'POST') { res.status(405).end(); return; }
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (c) => {
        size += c.length;
        if (size > PROJECT_MAX) { failed = true; res.status(413).end(); req.destroy(); return; }
        chunks.push(c);
    });
    req.on('end', () => {
        if (failed) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch (e) { res.status(400).json({ error: 'not JSON' }); return; }
        if (!data || data.format !== 'compositor-project') { res.status(400).json({ error: 'not a compositor project' }); return; }
        fs.mkdirSync(PROJECTS, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
        fs.renameSync(tmp, file);
        res.json({ ok: true, name, path: path.relative(path.join(__dirname, '..'), file) });
    });
}

// ---- Scan colour corrections ----------------------------------------------------
//
// Per take, saved into src/data/takeLooks.json (in src so saving never
// reloads the page; lib/scanAssets/takeLooks.js accepts the update).

const LOOKS = path.join(__dirname, 'data', 'takeLooks.json');
const LOOKS_ROUTE = '/__compositor/take-looks';
const LOOK_KEYS = ['exposure', 'contrast', 'gamma', 'saturation', 'temperature'];

function looksRoute(req, res) {
    if (!isLocal(req)) { res.status(403).end(); return; }
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET') { res.type('application/json').send(fs.readFileSync(LOOKS, 'utf8')); return; }
    if (req.method !== 'POST') { res.status(405).end(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size < MAX_BYTES) chunks.push(c); });
    req.on('end', () => {
        if (size >= MAX_BYTES) { res.status(413).end(); return; }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.status(400).json({ error: 'not JSON' }); return; }
        const ok = data && typeof data === 'object' && !Array.isArray(data)
            && Object.values(data).every((l) => l && typeof l === 'object' && LOOK_KEYS.every((k) => l[k] === undefined || Number.isFinite(l[k])));
        if (!ok) { res.status(400).json({ error: 'not a set of take looks' }); return; }
        const tmp = `${LOOKS}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
        fs.renameSync(tmp, LOOKS);
        res.json({ ok: true, path: 'src/data/takeLooks.json' });
    });
}

module.exports = function compositorDevServer(app) {
    app.use(LOOKS_ROUTE, looksRoute);
    app.use(ROTO_ROUTE, rotoProxy);
    app.use(PROJECTS_ROUTE, projectsRoute);

    app.get(ROUTE, (req, res) => {
        if (!isLocal(req)) { res.status(403).end(); return; }
        res.set('Cache-Control', 'no-store');
        res.type('application/json').send(fs.readFileSync(LIBRARY, 'utf8'));
    });

    app.post(ROUTE, (req, res) => {
        if (!isLocal(req)) { res.status(403).end(); return; }
        let size = 0;
        const chunks = [];
        let failed = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BYTES) {
                failed = true;
                res.status(413).end();
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (failed) return;
            let data;
            try {
                data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (e) {
                res.status(400).json({ error: 'not JSON' });
                return;
            }
            if (!data || data.version !== 1 || !Array.isArray(data.assets)
                || !data.assets.every((a) => a && typeof a.id === 'string' && typeof a.file === 'string')) {
                res.status(400).json({ error: 'not an asset library' });
                return;
            }
            // Written beside and renamed over, so a crash mid-write can never
            // leave half a file for the build to choke on.
            const tmp = `${LIBRARY}.tmp`;
            // Corners stay one per line, so an edit is a one-line diff.
            const text = JSON.stringify(data, null, 2)
                .replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+){1,3})\s+\]/g, (m, inner) => `[${inner.split(/,\s+/).join(', ')}]`);
            fs.writeFileSync(tmp, `${text}\n`);
            fs.renameSync(tmp, LIBRARY);
            res.json({ ok: true, path: 'src/data/scanAssetLibrary.json' });
        });
    });
};
