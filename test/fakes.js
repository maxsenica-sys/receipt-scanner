// Local stand-ins for the services the API talks to, so tests run the real server code against a
// real Postgres: Supabase Storage (the endpoints storage-js calls), Claude, Frankfurter, and the
// Google Apps Script backup.
'use strict';
const http = require('http');

function listen(handler) {
  return new Promise(res => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
}
function readBody(req) {
  return new Promise(res => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function start() {
  const files = {}, tokens = {}, claudeCalls = [], googleCalls = [];
  let googleOld = false;
  let claudeReply = null, claudeFail = 0, fxCalls = 0, storageDown = false;

  const storage = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname), body = await readBody(req);
    // the phone uploads from the app's own origin, so storage answers cross-origin like Supabase does
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
                           'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*' });
      return res.end();
    }
    if (storageDown) return json(res, 503, { message: 'unavailable' });
    let m;
    if (req.method === 'POST' && (m = p.match(/^\/storage\/v1\/object\/upload\/sign\/receipts\/(.+)$/))) {
      const t = 'tok' + Math.random().toString(36).slice(2); tokens[t] = m[1];
      return json(res, 200, { url: '/object/upload/sign/receipts/' + m[1] + '?token=' + t });
    }
    if (req.method === 'PUT' && (m = p.match(/^\/storage\/v1\/object\/upload\/sign\/receipts\/(.+)$/))) {
      if (tokens[u.searchParams.get('token')] !== m[1]) return json(res, 400, { message: 'bad token' });
      files[m[1]] = { bytes: body, type: req.headers['content-type'] }; return json(res, 200, { Key: 'receipts/' + m[1] });
    }
    if (req.method === 'POST' && (m = p.match(/^\/storage\/v1\/object\/receipts\/(.+)$/))) {
      files[m[1]] = { bytes: body, type: req.headers['content-type'] }; return json(res, 200, { Key: 'receipts/' + m[1] });
    }
    if (req.method === 'GET' && (m = p.match(/^\/storage\/v1\/object\/(?:authenticated\/)?receipts\/(.+)$/))) {
      if (!files[m[1]]) return json(res, 404, { message: 'not found' });
      res.writeHead(200, { 'content-type': files[m[1]].type || 'application/octet-stream' }); return res.end(files[m[1]].bytes);
    }
    if (req.method === 'POST' && (m = p.match(/^\/storage\/v1\/object\/sign\/receipts\/(.+)$/))) {
      return json(res, 200, { signedURL: '/object/sign/receipts/' + m[1] + '?token=read' });
    }
    if (req.method === 'DELETE' && p === '/storage/v1/object/receipts') {
      const b = JSON.parse(body.toString() || '{}'); (b.prefixes || []).forEach(k => { delete files[k]; }); return json(res, 200, []);
    }
    json(res, 404, { message: 'fake storage: no route ' + req.method + ' ' + p });
  });

  const claude = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString());
    claudeCalls.push({ body: body, beta: req.headers['anthropic-beta'] || '' });
    if (claudeFail > 0) { claudeFail--; return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }); }
    const input = typeof claudeReply === 'function' ? claudeReply(body) : claudeReply;
    json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', stop_sequence: null,
                     content: [{ type: 'tool_use', id: 'tu_1', name: 'record_receipt', input: input }],
                     usage: { input_tokens: 10, output_tokens: 10 } });
  });

  const fx = await listen((req, res) => {
    fxCalls++;
    const u = new URL(req.url, 'http://x'), day = u.pathname.split('/').pop(), from = u.searchParams.get('from');
    const rates = { TRY: 0.0365, USD: 1.52, EUR: 1.71 };
    if (!rates[from]) return json(res, 404, { message: 'not found' });
    json(res, 200, { amount: 1, base: from, date: day, rates: { AUD: rates[from] } });
  });

  const google = await listen(async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString());
    googleCalls.push(b);
    if (googleOld && ['record', 'unrecord', 'backupCheck'].includes(b.action)) return json(res, 200, { ok: false, error: 'Unknown action ' + b.action });
    json(res, 200, { ok: true });
  });

  const base = s => 'http://127.0.0.1:' + s.address().port;
  return {
    env: { SUPABASE_URL: base(storage), SUPABASE_SECRET_KEY: 'sb_secret_test', ANTHROPIC_BASE_URL: base(claude), ANTHROPIC_API_KEY: 'sk-ant-test',
           FX_URL: base(fx), GOOGLE_BACKUP_URL: base(google) + '/macros/s/test/exec', GOOGLE_BACKUP_KEY: 'gkey' },
    files, claudeCalls, googleCalls,
    setClaude: r => { claudeReply = r; }, failClaude: n => { claudeFail = n; }, fxCalls: () => fxCalls,
    storageDown: v => { storageDown = v; }, googleOld: v => { googleOld = v; },
    close: () => [storage, claude, fx, google].forEach(s => s.close())
  };
}

module.exports = { start };
