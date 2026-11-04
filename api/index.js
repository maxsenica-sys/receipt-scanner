// Receipt Scanner API. One endpoint, POST /api with { action, key, ... } -> JSON
// { ok: true, ... } or { ok: false, error }. GET /api?cron=1 is the daily maintenance run.
'use strict';
const crypto = require('crypto');
const L = require('../lib/logic');
const S = require('../lib/services');
const { readReceipt } = require('../lib/claude');

let waitUntil = p => p;   // Vercel keeps the function alive for background work; locally, just run it
try { waitUntil = require('@vercel/functions').waitUntil; } catch (e) { /* not on Vercel */ }

// ---------------------------------------------------------------- helpers
function sameKey(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
async function settings() {
  const rows = await S.q('select key, value from settings');
  const o = {}; rows.forEach(r => { o[r.key] = r.value; });
  return { season: o.season || { start: '2026-09-01', end: '2027-05-31' }, categories: o.categories || ['Other'],
           timezone: o.timezone || 'Europe/Istanbul' };
}
const money = n => (Math.round(Number(n) * 100) / 100).toFixed(2);
function summary(r) {
  const parts = ['Logged ' + r.items.length + ' item' + (r.items.length === 1 ? '' : 's'), r.merchant || 'unknown shop',
                 money(r.total) + ' ' + r.currency, r.receipt_date];
  if (r.flags) parts.push('Check: ' + r.flags);
  return parts.join(' · ');
}
function extOf(mime) { return mime === 'application/pdf' ? 'pdf' : 'jpg'; }
function newPath(mime) {
  const d = new Date();
  return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + crypto.randomUUID() + '.' + extOf(mime);
}
const OK_MIME = ['image/jpeg', 'application/pdf'];

// Writes one receipt and its items in a single transaction, with AUD amounts.
async function insertReceipt(r, extra) {
  const rate = await S.audRate(r.currency, r.receipt_date);
  const aud = x => (rate == null ? null : Math.round(x * rate * 100) / 100);
  return S.tx(async c => {
    const row = (await c.query(
      `insert into receipts (receipt_date, merchant, currency, payment, receipt_no, receipt_time, total, total_aud, fx_rate,
                             photo_path, photo_sha, photo_mime, source, flags, notes, confidence, backup_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id, created_at`,
      [r.receipt_date, r.merchant, r.currency, r.payment, r.receipt_no, r.receipt_time, r.total, aud(r.total), rate,
       extra.photo_path || null, extra.photo_sha || null, extra.photo_mime || null, extra.source || 'scan', r.flags || '',
       r.notes || null, r.confidence || null, process.env.GOOGLE_BACKUP_URL ? 'pending' : 'off'])).rows[0];
    for (const it of r.items) {
      await c.query(`insert into items (receipt_id, line_no, description, original_text, category, qty, unit_price, line_total, aud)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.id, it.line_no, it.description, it.original_text, it.category, it.qty, it.unit_price, it.line_total, aud(it.line_total)]);
    }
    return row.id;
  });
}

async function receiptById(id) {
  const r = (await S.q('select * from receipts where id = $1', [id]))[0];
  if (!r) return null;
  r.items = await S.q('select * from items where receipt_id = $1 order by line_no', [id]);
  return r;
}

// Copies a receipt to Google Drive + the sheet in the background, and records how that went.
function backupLater(id) {
  if (!process.env.GOOGLE_BACKUP_URL) return;
  waitUntil(backup(id).catch(() => {}));
}
async function backup(id) {
  const r = await receiptById(id);
  if (!r) return;
  try {
    let image = null;
    if (r.photo_path) image = (await S.photos.download(r.photo_path)).toString('base64');
    const day = String(r.receipt_date instanceof Date ? r.receipt_date.toISOString() : r.receipt_date).slice(0, 10);
    await S.google('record', { receipt: {
      rid: r.id.replace(/-/g, '').slice(0, 12), date: day, merchant: r.merchant, currency: r.currency, payment: r.payment,
      receipt_no: r.receipt_no, receipt_time: r.receipt_time, flags: r.flags,
      items: r.items.map(i => ({ description: i.description, original_text: i.original_text, category: i.category,
                                 qty: Number(i.qty), unit_price: Number(i.unit_price) })) },
      image: image, mime: r.photo_mime });
    await S.q("update receipts set backup_status = 'done', backup_error = null where id = $1", [id]);
  } catch (e) {
    await S.q("update receipts set backup_status = 'failed', backup_error = $2 where id = $1", [id, String(e.message).slice(0, 300)]);
  }
}
function unbackupLater(rid) {
  if (!process.env.GOOGLE_BACKUP_URL) return;
  waitUntil(S.google('unrecord', { rid: rid }).catch(() => {}));
}

function dayOf(v) { return String(v instanceof Date ? v.toISOString() : v).slice(0, 10); }

// ---------------------------------------------------------------- scanning
// One uploaded photo, start to finish: same photo already logged -> duplicate; read with Claude;
// same printed receipt -> duplicate; look-alike -> ask the owner (pending); otherwise logged.
async function scan(path, mime) {
  if (!OK_MIME.includes(mime)) throw new Error('Unsupported file type ' + mime);
  const done = (await S.q('select id from receipts where photo_path = $1', [path]))[0];
  if (done) { const r = await receiptById(done.id); return { status: 'logged', id: r.id, message: summary(Object.assign(r, { receipt_date: dayOf(r.receipt_date) })) }; }

  const bytes = await S.photos.download(path);
  if (!bytes.length) throw new Error('The scan arrived empty');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const twin = (await S.q('select id, merchant, receipt_date from receipts where photo_sha = $1', [sha]))[0];
  if (twin) {
    await S.photos.remove(path).catch(() => {});
    return { status: 'duplicate', message: 'This exact photo is already logged (' + twin.merchant + ', ' + dayOf(twin.receipt_date) + ').' };
  }

  const set = await settings();
  const today = L.todayIn(set.timezone);
  const media = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } };
  const data = await readReceipt(process.env.ANTHROPIC_API_KEY, media, set.categories, today);
  return place(data, { photo_path: path, photo_sha: sha, photo_mime: mime }, set, today, false);
}

// Decides what happens to a read receipt (shared by a fresh scan and an "add anyway").
async function place(data, photo, set, today, force) {
  const r = L.buildReceipt(data, set.categories, today, set.season.start);
  const sameDay = await S.q('select id, receipt_date, merchant, total, receipt_no, receipt_time from receipts where receipt_date = $1', [r.receipt_date]);
  const match = L.matchReceipt(r, sameDay.map(g => Object.assign({}, g, { receipt_date: dayOf(g.receipt_date) })));
  if (match && match.same) {
    if (photo.photo_path) await S.photos.remove(photo.photo_path).catch(() => {});
    return { status: 'duplicate', message: 'Same printed receipt as one already logged (' + match.receipt.merchant + ', ' +
             dayOf(match.receipt.receipt_date) + ', ' + money(match.receipt.total) + '). Not added again.' };
  }
  if (match && !force) {
    const m = { merchant: match.receipt.merchant, date: dayOf(match.receipt.receipt_date), total: Number(match.receipt.total), id: match.receipt.id };
    const p = (await S.q('insert into pending (photo_path, photo_sha, photo_mime, data, match) values ($1,$2,$3,$4,$5) returning id',
                         [photo.photo_path || null, photo.photo_sha || null, photo.photo_mime || null, JSON.stringify(data), JSON.stringify(m)]))[0];
    return { status: 'confirm', id: p.id, match: m,
             message: 'Already logged? Same shop, day and total as ' + m.merchant + ' on ' + m.date + ' (' + money(m.total) + '). Not added unless you say so.' };
  }
  const id = await insertReceipt(r, Object.assign({ source: 'scan' }, photo));
  backupLater(id);
  return { status: 'logged', id: id, message: summary(r) };
}

async function decide(id, add) {
  const p = (await S.q('select * from pending where id = $1', [id]))[0];
  if (!p) return { status: 'duplicate', message: 'Already answered.' };
  if (!add) {
    await S.q('delete from pending where id = $1', [id]);
    if (p.photo_path) await S.photos.remove(p.photo_path).catch(() => {});
    return { status: 'duplicate', message: 'Not added - you confirmed it was already logged.' };
  }
  const set = await settings();
  const out = await place(p.data, { photo_path: p.photo_path, photo_sha: p.photo_sha, photo_mime: p.photo_mime }, set, L.todayIn(set.timezone), true);
  await S.q('delete from pending where id = $1', [id]);
  return out;
}

// ---------------------------------------------------------------- typed-in receipts and edits
function cleanItems(items, cats) {
  if (!Array.isArray(items) || !items.length) throw new Error('Add at least one item');
  return items.map((it, k) => {
    const qty = Math.round(Number(it.qty) * 1000) / 1000;
    const unit = Math.round(Number(it.unit_price) * 100) / 100;
    if (!(qty > 0) || !isFinite(unit)) throw new Error('Item ' + (k + 1) + ': quantity and price must be numbers');
    if (!String(it.description || '').trim()) throw new Error('Item ' + (k + 1) + ' needs a name');
    return { line_no: k + 1, description: String(it.description).trim(), original_text: String(it.original_text || ''),
             category: cats.indexOf(it.category) > -1 ? it.category : 'Other', qty: qty, unit_price: unit,
             line_total: Math.round(qty * unit * 100) / 100 };
  });
}
async function manual(b) {
  const set = await settings();
  const day = L.parseDay(b.date);
  if (!day) throw new Error('Date must be a real day, e.g. 22/10/2026');
  if (day > L.todayIn(set.timezone)) throw new Error('That date is in the future');
  const items = cleanItems(b.items, set.categories);
  const r = { receipt_date: day, merchant: String(b.merchant || 'Unknown shop').trim(), currency: String(b.currency || 'TRY').toUpperCase(),
              payment: b.payment || null, receipt_no: null, receipt_time: null, flags: '', notes: b.notes || null, confidence: null,
              items: items, total: Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100 };
  const id = await insertReceipt(r, { source: 'manual' });
  backupLater(id);
  return { status: 'logged', id: id, message: summary(r) };
}
// Replaces a receipt's details and items (fixing a misread line, a category, the date...).
async function edit(b) {
  const old = await receiptById(b.id);
  if (!old) throw new Error('That receipt no longer exists');
  const set = await settings();
  const day = L.parseDay(b.date) || dayOf(old.receipt_date);
  const items = cleanItems(b.items, set.categories);
  const currency = String(b.currency || old.currency).toUpperCase();
  const total = Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100;
  const rate = await S.audRate(currency, day);
  const aud = x => (rate == null ? null : Math.round(x * rate * 100) / 100);
  await S.tx(async c => {
    await c.query(`update receipts set receipt_date=$2, merchant=$3, currency=$4, total=$5, total_aud=$6, fx_rate=$7, flags=$8,
                   backup_status = case when backup_status = 'off' then 'off' else 'pending' end where id=$1`,
                  [b.id, day, String(b.merchant != null ? b.merchant : old.merchant), currency, total, aud(total), rate, String(b.flags != null ? b.flags : old.flags)]);
    await c.query('delete from items where receipt_id = $1', [b.id]);
    for (const it of items) {
      await c.query(`insert into items (receipt_id, line_no, description, original_text, category, qty, unit_price, line_total, aud)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [b.id, it.line_no, it.description, it.original_text, it.category, it.qty, it.unit_price, it.line_total, aud(it.line_total)]);
    }
  });
  // keep the sheet copy in step: take the old rows out, put the corrected ones in
  if (process.env.GOOGLE_BACKUP_URL) waitUntil(S.google('unrecord', { rid: old.legacy_id || old.id.replace(/-/g, '').slice(0, 12) })
    .then(() => backup(b.id)).catch(() => {}));
  return { status: 'saved', id: b.id };
}
async function remove(id) {
  const r = (await S.q('delete from receipts where id = $1 returning photo_path, legacy_id', [id]))[0];
  if (!r) return { status: 'gone' };
  if (r.photo_path) await S.photos.remove(r.photo_path).catch(() => {});
  unbackupLater(r.legacy_id || id.replace(/-/g, '').slice(0, 12));
  return { status: 'deleted' };
}

// Everything the app shows: receipts with their items, newest first, and the settings.
async function allData() {
  const set = await settings();
  const rs = await S.q(`select id, receipt_date, merchant, currency, payment, receipt_no, receipt_time, total, total_aud, flags,
                               source, photo_path is not null as has_photo, drive_file, created_at, backup_status
                        from receipts order by receipt_date desc, created_at desc`);
  const items = await S.q('select id, receipt_id, line_no, description, original_text, category, qty, unit_price, line_total, aud from items order by receipt_id, line_no');
  const by = {};
  items.forEach(i => { (by[i.receipt_id] = by[i.receipt_id] || []).push(
    { description: i.description, original_text: i.original_text, category: i.category, qty: Number(i.qty), unit_price: Number(i.unit_price),
      line_total: Number(i.line_total), aud: i.aud == null ? null : Number(i.aud) }); });
  return { settings: set, receipts: rs.map(r => ({
    id: r.id, date: dayOf(r.receipt_date), merchant: r.merchant, currency: r.currency, payment: r.payment, receipt_no: r.receipt_no,
    receipt_time: r.receipt_time, total: Number(r.total), total_aud: r.total_aud == null ? null : Number(r.total_aud), flags: r.flags,
    source: r.source, has_photo: r.has_photo, drive_file: r.drive_file, backup: r.backup_status, items: by[r.id] || [] })) };
}

// ---------------------------------------------------------------- health check
// Run when the app opens: every service the app depends on, tested for real.
async function ping() {
  const problems = [];
  ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY'].forEach(k => { if (!process.env[k]) problems.push(k + ' is not set in Vercel.'); });
  try { await S.q('select 1 from settings limit 1'); } catch (e) { problems.push('Database: ' + e.message); }
  try {   // a real signed upload, exactly as the phone does it, then removed
    const path = 'selftest/' + crypto.randomUUID() + '.txt', url = await S.photos.signedUpload(path);
    const put = await fetch(url, { method: 'PUT', headers: { 'content-type': 'text/plain', 'x-upsert': 'false' }, body: 'ok' });
    if (!put.ok) throw new Error('upload answered HTTP ' + put.status);
    await S.photos.remove(path);
  } catch (e) { problems.push('Photo storage: ' + e.message); }
  const failed = (await S.q("select count(*)::int as n from receipts where backup_status = 'failed'").catch(() => [{ n: 0 }]))[0].n;
  if (failed) problems.push(failed + ' receipt(s) not yet copied to Google - retried daily.');
  const pending = (await S.q('select count(*)::int as n from pending').catch(() => [{ n: 0 }]))[0].n;
  return { sheet: 'Receipt Scanner', problems: problems, pending: pending };
}

// ---------------------------------------------------------------- daily maintenance
async function cron() {
  const out = { aud: 0, backups: 0 };
  const missing = await S.q('select id, currency, receipt_date from receipts where total_aud is null limit 50');
  for (const r of missing) {
    const day = dayOf(r.receipt_date), rate = await S.audRate(r.currency, day);
    if (rate == null) continue;
    await S.q('update receipts set fx_rate = $2, total_aud = round(total * $2, 2) where id = $1', [r.id, rate]);
    await S.q('update items set aud = round(line_total * $2, 2) where receipt_id = $1', [r.id, rate]);
    out.aud++;
  }
  const todo = await S.q("select id from receipts where backup_status in ('pending', 'failed') and created_at < now() - interval '10 minutes' limit 10");
  for (const r of todo) { await backup(r.id); out.backups++; }
  return out;
}

// ---------------------------------------------------------------- the endpoint
async function handle(b) {
  switch (b.action) {
    case 'ping':      return ping();
    case 'uploadUrl': { const mime = b.mime; if (!OK_MIME.includes(mime)) throw new Error('Unsupported file type ' + mime);
                        const path = newPath(mime); return { path: path, url: await S.photos.signedUpload(path) }; }
    case 'scan':      if (!/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|pdf)$/.test(String(b.path))) throw new Error('Bad upload path');
                      return scan(b.path, b.mime);
    case 'scanInline': { const mime = b.mime; if (!OK_MIME.includes(mime)) throw new Error('Unsupported file type ' + mime);
                        const buf = Buffer.from(String(b.data || ''), 'base64'); if (!buf.length) throw new Error('The scan arrived empty');
                        const path = newPath(mime); await S.photos.upload(path, buf, mime); return scan(path, mime); }
    case 'decide':    return decide(b.id, !!b.add);
    case 'held':      return { held: (await S.q('select id, match, created_at from pending order by created_at')).map(p => ({
                        id: p.id, status: 'confirm', match: p.match,
                        message: 'Already logged? Same shop, day and total as ' + p.match.merchant + ' on ' + p.match.date + '.' })) };
    case 'data':      return allData();
    case 'photo':     { const r = (await S.q('select photo_path from receipts where id = $1', [b.id]))[0];
                        if (!r || !r.photo_path) throw new Error('No photo for this receipt'); return { url: await S.photos.signedUrl(r.photo_path) }; }
    case 'manual':    return manual(b);
    case 'edit':      return edit(b);
    case 'delete':    return remove(b.id);
    case 'settings':  { const s = L.parseDay(b.start), e = L.parseDay(b.end);
                        if (!s || !e || e <= s) throw new Error('Season needs a start date before its end date');
                        await S.q("update settings set value = $1 where key = 'season'", [JSON.stringify({ start: s, end: e })]);
                        return { season: { start: s, end: e } }; }
    default: throw new Error('Unknown action ' + b.action);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const isCron = /[?&]cron=1/.test(req.url || '');
      const auth = req.headers && req.headers.authorization;
      if (isCron && (!process.env.CRON_SECRET || auth === 'Bearer ' + process.env.CRON_SECRET)) return res.status(200).json(Object.assign({ ok: true }, await cron()));
      return res.status(200).json({ ok: true, service: 'receipt-scanner' });
    }
    let b = req.body;
    if (typeof b === 'string') b = JSON.parse(b || '{}');
    if (!b || typeof b !== 'object') b = {};
    if (!process.env.APP_KEY) throw new Error('APP_KEY is not set in Vercel');
    if (!sameKey(b.key, process.env.APP_KEY)) throw new Error('KEY: This link is out of date or wrong. Open the link you saved when the app was set up.');
    const out = await handle(b);
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(200).json({ ok: false, error: msg, retryable: !!(e && e.retryable) });
  }
};
module.exports.config = { maxDuration: 60 };
module.exports._internal = { scan, place, decide, manual, edit, remove, allData, ping, cron, backup, settings };
