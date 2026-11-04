// A small stand-in for Vercel, for tests: serves the app's static files and routes /api to the
// real API function, with JSON bodies parsed the way Vercel does.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const REWRITES = VJ.rewrites || [];
const IGNORED = new Set((fs.existsSync(path.join(ROOT, '.vercelignore')) ? fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8') : '')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/^\//, '')));
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.js': 'text/javascript', '.json': 'application/json' };

function start(port) {
  const api = require('../api/index.js');
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          if (raw.length > 4.5e6) { res.writeHead(413); return res.end('Request Entity Too Large'); }   // Vercel's body limit
          let body = raw;
          if (/json/.test(req.headers['content-type'] || '')) { try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; } }
          const vres = {
            setHeader: (k, v) => res.setHeader(k, v),
            status(c) { res.statusCode = c; return this; },
            json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); }
          };
          api({ method: req.method, url: req.url, headers: req.headers, body: body }, vres).catch(e => { res.statusCode = 500; res.end(String(e)); });
        });
        return;
      }
      // Like Vercel: a deployed file wins; only when there is none do vercel.json's rewrites apply.
      // ("/" is the directory's index.html.) Files listed in .vercelignore are not deployed.
      const fileFor = p => { const f = path.join(ROOT, path.normalize(p === '/' || p.endsWith('/') ? p + 'index.html' : p));
        return f.startsWith(ROOT) && fs.existsSync(f) && !fs.statSync(f).isDirectory() && !IGNORED.has(path.relative(ROOT, f)) ? f : null; };
      let f = fileFor(u.pathname);
      if (!f) { const rw = REWRITES.find(r => r.source === u.pathname); if (rw) f = fileFor(rw.destination); }
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(port || 0, '127.0.0.1', () => resolve(server));
  });
}
module.exports = { start };
