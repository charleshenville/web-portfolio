// Dev-server middleware (create-react-app loads this file by itself when
// `npm start` runs; it is not part of the build).
//
// The Scan Compositor's asset library - which placed assets are screens and
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

const fs = require('fs');
const path = require('path');

const LIBRARY = path.join(__dirname, 'data', 'scanAssetLibrary.json');
const ROUTE = '/__scan-compositor/library';
const MAX_BYTES = 1024 * 1024;

const isLocal = (req) => {
    const a = req.socket && req.socket.remoteAddress;
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

module.exports = function scanCompositorLibrary(app) {
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
