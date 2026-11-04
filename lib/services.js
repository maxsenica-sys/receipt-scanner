// The server's connections: database (Supabase Postgres), photo storage (Supabase Storage),
// exchange rates (European Central Bank via Frankfurter) and the Google Drive/Sheet backup.
'use strict';
const { Pool } = require('pg');
const { StorageClient } = require('@supabase/storage-js');

// ---------------------------------------------------------------- database
let pool = null;
function db() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set in Vercel');
  const local = process.env.PGSSL === 'off';
  pool = new Pool({
    connectionString: url.replace(/[?&]sslmode=[^&]*/, ''),
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000
  });
  return pool;
}
async function q(text, params) { return (await db().query(text, params)).rows; }
async function tx(fn) {
  const c = await db().connect();
  try { await c.query('begin'); const out = await fn(c); await c.query('commit'); return out; }
  catch (e) { try { await c.query('rollback'); } catch (x) { /* connection already gone */ } throw e; }
  finally { c.release(); }
}

// ---------------------------------------------------------------- photo storage
const BUCKET = 'receipts';
function storage() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set in Vercel');
  return new StorageClient(url.replace(/\/$/, '') + '/storage/v1', { apikey: key, Authorization: 'Bearer ' + key }).from(BUCKET);
}
async function check(p) { const { data, error } = await p; if (error) throw new Error('Storage: ' + (error.message || error)); return data; }
const photos = {
  signedUpload: path => check(storage().createSignedUploadUrl(path)).then(d => d.signedUrl),
  upload: (path, buf, mime) => check(storage().upload(path, buf, { contentType: mime, upsert: false })),
  download: async path => Buffer.from(await (await check(storage().download(path))).arrayBuffer()),
  signedUrl: path => check(storage().createSignedUrl(path, 3600)).then(d => d.signedUrl),
  remove: path => check(storage().remove([path]))
};

// ---------------------------------------------------------------- exchange rates
// AUD per 1 unit of `currency` on `day` (ECB reference rate; the last working day before a
// weekend or holiday). Cached in fx_rates. null if no rate can be found right now.
async function audRate(currency, day) {
  if (currency === 'AUD') return 1;
  const hit = await q('select aud from fx_rates where currency = $1 and day = $2', [currency, day]);
  if (hit.length) return Number(hit[0].aud);
  const bases = (process.env.FX_URL ? [process.env.FX_URL] : ['https://api.frankfurter.dev/v1', 'https://api.frankfurter.app']);
  for (const base of bases) {
    try {
      const r = await fetch(base.replace(/\/$/, '') + '/' + day + '?from=' + encodeURIComponent(currency) + '&to=AUD', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json(), rate = j && j.rates && Number(j.rates.AUD);
      if (rate > 0) {
        await q('insert into fx_rates (day, currency, aud) values ($1, $2, $3) on conflict do nothing', [day, currency, rate]);
        return rate;
      }
    } catch (e) { /* try the next source */ }
  }
  // offline: the nearest earlier rate we already have, so totals stay roughly right until the
  // daily maintenance run fills the exact one in
  const near = await q('select aud from fx_rates where currency = $1 and day <= $2 order by day desc limit 1', [currency, day]);
  return near.length ? Number(near[0].aud) : null;
}

// ---------------------------------------------------------------- Google backup
// Copies a receipt (and its photo) into the Google Drive folder and Season_Expenses sheet,
// through the Apps Script web app. Optional: off when GOOGLE_BACKUP_URL is not set.
async function google(action, payload) {
  const url = process.env.GOOGLE_BACKUP_URL, key = process.env.GOOGLE_BACKUP_KEY;
  if (!url || !key) return { off: true };
  const r = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                               body: JSON.stringify(Object.assign({ action: action, key: key }, payload)), signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* Google error page */ }
  if (!r.ok || !j) throw new Error('Google backup answered HTTP ' + r.status);
  if (!j.ok) throw new Error('Google backup: ' + j.error);
  return j;
}

module.exports = { db, q, tx, photos, audRate, google, BUCKET };
