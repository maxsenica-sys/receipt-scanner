// The API, run for real against a local Postgres (same schema as Supabase) and local stand-ins
// for storage, Claude, exchange rates and the Google backup.
// Needs: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/receipts
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fakes = require('./fakes');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { test('API tests need TEST_DATABASE_URL', { skip: true }, () => {}); return; }

let F, api, S, L;
const KEY = 'k'.repeat(48);
const today = () => L.todayIn('Europe/Istanbul');
const dayBefore = n => L.addDays(today(), -n);
const reply = (o) => Object.assign({ merchant: 'Migros', date: dayBefore(2), date_printed: null, receipt_number: null, receipt_time: null,
  currency: 'TRY', payment_method: 'Card', receipt_total: 59.85, confidence: 'high', notes: null, items: [
  { original_text: 'MUZ YERLI KG', description_en: 'Bananas', category: 'Groceries', quantity: 1, unit_price: 49.9, line_total: 49.9 },
  { original_text: 'SU 0.5L', description_en: 'Water 0.5L', category: 'Groceries', quantity: 1, unit_price: 9.95, line_total: 9.95 }] }, o || {});

function call(action, body) {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', url: '/api', headers: {}, body: Object.assign({ action: action, key: KEY }, body || {}) };
    const res = { _code: 0, setHeader() {}, status(c) { this._code = c; return this; }, json(o) { resolve(o); } };
    api(req, res).catch(reject);
  });
}
// What the phone does: ask for an upload link, PUT the bytes to it exactly as the app does, scan.
async function scanBytes(bytes, mime) {
  mime = mime || 'image/jpeg';
  const u = await call('uploadUrl', { mime: mime });
  assert.ok(u.ok, u.error);
  const put = await fetch(u.url, { method: 'PUT', headers: { 'content-type': mime, 'x-upsert': 'false', 'cache-control': 'max-age=3600' }, body: bytes });
  assert.ok(put.ok, 'upload to signed url');
  return Object.assign(await call('scan', { path: u.path, mime: mime }), { path: u.path });
}
const settle = () => new Promise(r => setTimeout(r, 150));   // let background backups finish
let n = 0;
const photo = () => Buffer.from('jpeg-bytes-' + (++n) + '-' + Math.random());

test.before(async () => {
  F = await fakes.start();
  Object.assign(process.env, F.env, { DATABASE_URL: DB, PGSSL: 'off', APP_KEY: KEY });
  api = require('../api/index.js'); S = require('../lib/services'); L = require('../lib/logic');
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await S.q('drop table if exists items, receipts, pending, settings, fx_rates cascade');
  await S.q(schema);
});
test.after(async () => { F.close(); await S.db().end(); });
// let the previous test's background backups land before clearing, so none arrive mid-test
test.beforeEach(async () => { await settle(); await settle(); await S.q('truncate receipts, items, pending, fx_rates cascade'); F.claudeCalls.length = 0; F.googleCalls.length = 0; F.setClaude(reply()); });

test('health check passes, including a real signed upload round trip', async () => {
  const r = await call('ping');
  assert.ok(r.ok, r.error); assert.deepEqual(r.problems, []);
});

test('old Google script: the health check says so plainly, with the fix and how many are waiting', async () => {
  F.googleOld(true);
  try {
    await scanBytes(photo()); await settle();
    assert.equal((await S.q('select backup_status from receipts'))[0].backup_status, 'failed');
    await S.q("update receipts set created_at = now() - interval '1 hour', backup_tried_at = now() - interval '1 hour'");
    F.googleCalls.length = 0;
    const r = await call('ping');
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0], /Google Sheet backup is not working/);
    assert.match(r.problems[0], /1 receipt is waiting/);
    assert.match(r.problems[0], /New version/);
    await settle();
    assert.deepEqual(F.googleCalls.map(c => c.action), ['backupCheck'], 'no copies are sent to a script that cannot take them');
  } finally { F.googleOld(false); }
});

test('Google script fixed: opening the app sends the waiting receipts by itself, once', async () => {
  await scanBytes(photo()); F.setClaude(reply({ merchant: 'BIM' })); await scanBytes(photo()); await settle();
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 2);
  await S.q("update receipts set backup_status = 'failed', backup_error = 'Google backup: Unknown action record', created_at = now() - interval '1 hour', backup_tried_at = now() - interval '1 hour'");
  F.googleCalls.length = 0;
  const r = await call('ping');
  assert.deepEqual(r.problems, []);
  await settle(); await settle();
  assert.deepEqual((await S.q('select backup_status, backup_error from receipts')).map(x => x.backup_status + ':' + x.backup_error), ['done:null', 'done:null']);
  assert.equal(F.googleCalls.filter(c => c.action === 'record').length, 2);
  F.googleCalls.length = 0;
  await call('ping'); await settle();
  assert.equal(F.googleCalls.filter(c => c.action === 'record').length, 0, 'nothing sent twice');
});

test('a receipt saved moments ago is not resent while its first copy may still be on its way', async () => {
  await scanBytes(photo()); await settle();
  await S.q("update receipts set backup_status = 'pending', backup_tried_at = null");
  F.googleCalls.length = 0;
  await call('ping'); await settle();
  assert.equal(F.googleCalls.filter(c => c.action === 'record').length, 0);
});

test('warm-up answers', async () => { assert.equal((await call('warm')).ok, true); });

test('wrong key is refused', async () => {
  const r = await new Promise(res => api({ method: 'POST', url: '/api', headers: {}, body: { action: 'data', key: 'nope' } },
    { setHeader() {}, status() { return this; }, json: res }));
  assert.equal(r.ok, false); assert.match(r.error, /^KEY:/);
});

test('scan -> read -> logged with items, AUD and a Google backup with the photo', async () => {
  const img = photo();
  const r = await scanBytes(img);
  assert.equal(r.status, 'logged', r.error || r.message);
  assert.match(r.message, /Logged 2 items · Migros · 59.85 TRY/);
  const rec = (await S.q('select * from receipts'))[0];
  assert.equal(Number(rec.total), 59.85); assert.equal(Number(rec.total_aud), 2.18); assert.equal(rec.source, 'scan');
  const items = await S.q('select * from items order by line_no');
  assert.deepEqual(items.map(i => [i.description, Number(i.line_total), Number(i.aud)]), [['Bananas', 49.9, 1.82], ['Water 0.5L', 9.95, 0.36]]);
  // the request to Claude: same model and settings as the Google back end
  const c = F.claudeCalls[0];
  assert.equal(c.body.model, 'claude-sonnet-5-5'); assert.equal(c.body.output_config.effort, 'low'); assert.equal(c.body.tools[0].strict, true);
  assert.match(c.beta, /server-side-fallback-2026-07-01/); assert.equal(c.body.messages[0].content[0].source.data, img.toString('base64'));
  await settle();
  const g = F.googleCalls[0];
  assert.equal(g.action, 'record'); assert.equal(g.key, 'gkey'); assert.equal(g.image, img.toString('base64')); assert.equal(g.receipt.items.length, 2);
  assert.equal((await S.q('select backup_status from receipts'))[0].backup_status, 'done');
});

test('the same upload sent twice (phone retried) returns the same receipt, without reading it again', async () => {
  const r1 = await scanBytes(photo());
  const r2 = await call('scan', { path: r1.path, mime: 'image/jpeg' });
  assert.equal(r2.status, 'logged'); assert.equal(r2.id, r1.id); assert.equal(F.claudeCalls.length, 1);
});

test('the exact same photo again -> duplicate, not read, upload removed', async () => {
  const img = photo();
  await scanBytes(img);
  const r = await scanBytes(img);
  assert.equal(r.status, 'duplicate'); assert.match(r.message, /exact photo/);
  assert.equal(F.claudeCalls.length, 1); assert.equal(F.files[r.path], undefined);
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 1);
});

test('same printed receipt (same day + receipt number), new photo -> skipped', async () => {
  F.setClaude(reply({ receipt_number: '0042', receipt_time: '18:23' }));
  await scanBytes(photo());
  const r = await scanBytes(photo());
  assert.equal(r.status, 'duplicate'); assert.match(r.message, /Same printed receipt/);
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 1);
});

test('same shop, day and total, nothing printed to tell apart -> asks; nothing written until answered', async () => {
  await scanBytes(photo());
  const r = await scanBytes(photo());
  assert.equal(r.status, 'confirm'); assert.equal(r.match.merchant, 'Migros');
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 1);
  const held = await call('held');
  assert.equal(held.held.length, 1); assert.equal(held.held[0].id, r.id);
  const calls = F.claudeCalls.length;
  const yes = await call('decide', { id: r.id, add: true });
  assert.equal(yes.status, 'logged'); assert.equal(F.claudeCalls.length, calls, 'not read again');
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 2);
  assert.equal((await call('held')).held.length, 0);
});

test('"Don\'t add" -> nothing written, photo removed', async () => {
  await scanBytes(photo());
  const r = await scanBytes(photo());
  const no = await call('decide', { id: r.id, add: false });
  assert.equal(no.status, 'duplicate');
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 1);
  assert.equal(F.files[r.path], undefined);
});

test('identical purchase on a different day -> logged without asking', async () => {
  await scanBytes(photo());
  F.setClaude(reply({ date: dayBefore(3) }));
  const r = await scanBytes(photo());
  assert.equal(r.status, 'logged');
});

test('identical purchase on the same day at a different printed time -> logged without asking', async () => {
  F.setClaude(reply({ receipt_time: '09:10' })); await scanBytes(photo());
  F.setClaude(reply({ receipt_time: '17:45' }));
  const r = await scanBytes(photo());
  assert.equal(r.status, 'logged');
});

// a recent real day whose month-first misreading lands after today (impossible), or before the season
function misreadable(after) {
  for (let k = 1; k < 400; k++) {
    const real = dayBefore(k), sw = L.swapDayMonth(real);
    if (sw && sw !== real && (after ? sw > today() : sw < '2026-09-01') && real >= '2026-09-01') return { real: real, misread: sw };
  }
  return null;
}
test('a month-first misreading that lands in the future is swapped back to day-first and flagged', async () => {
  const c = misreadable(true);
  assert.ok(c, 'found a test date');
  F.setClaude(reply({ date: c.misread, date_printed: null }));
  const r = await scanBytes(photo());
  assert.equal(r.status, 'logged'); assert.match(r.message, /DATE SWAPPED/);
  assert.equal((await S.q('select receipt_date::text d from receipts'))[0].d, c.real);
});
test('a month-first misreading that lands before the season is swapped back too', async () => {
  const c = misreadable(false);
  assert.ok(c, 'found a test date');
  F.setClaude(reply({ date: c.misread, date_printed: null }));
  const r = await scanBytes(photo());
  assert.match(r.message, /DATE SWAPPED/);
  assert.equal((await S.q('select receipt_date::text d from receipts'))[0].d, c.real);
});

test('long receipt (PDF) goes to Claude as a document', async () => {
  const r = await scanBytes(Buffer.from('%PDF-1.4 fake ' + Math.random()), 'application/pdf');
  assert.equal(r.status, 'logged');
  assert.equal(F.claudeCalls[0].body.messages[0].content[0].type, 'document');
});

test('Claude overloaded beyond the SDK retries -> a retryable error, nothing written; the same upload succeeds later', async () => {
  F.failClaude(3);
  const r = await scanBytes(photo());
  assert.equal(r.ok, false); assert.equal(r.retryable, true);
  assert.equal((await S.q('select count(*)::int n from receipts'))[0].n, 0);
  const again = await call('scan', { path: r.path, mime: 'image/jpeg' });
  assert.equal(again.status, 'logged');
});

test('inline upload (fallback when the direct upload fails) works the same', async () => {
  const r = await call('scanInline', { data: photo().toString('base64'), mime: 'image/jpeg' });
  assert.equal(r.status, 'logged', r.error);
});

test('typed-in receipt -> logged with AUD, backed up without a photo', async () => {
  const r = await call('manual', { date: '20/10/2026', merchant: 'Local market', currency: 'TRY', items: [
    { description: 'Pomegranates (3)', category: 'Groceries', qty: 1, unit_price: 100 },
    { description: 'Blueberries (punnet)', category: 'Groceries', qty: 2, unit_price: 150 }] });
  assert.equal(r.status, 'logged', r.error);
  const rec = (await S.q('select receipt_date::text d, total, total_aud, source from receipts'))[0];
  assert.equal(rec.d, '2026-10-20'); assert.equal(Number(rec.total), 400); assert.equal(Number(rec.total_aud), 14.6); assert.equal(rec.source, 'manual');
  await settle();
  const g = F.googleCalls.find(c => c.action === 'record' && c.receipt.merchant === 'Local market');
  assert.ok(g, 'backed up'); assert.equal(g.image, null); assert.equal(g.receipt.date, '2026-10-20');
});

test('typed-in receipt validation: future date, missing items, bad numbers', async () => {
  assert.match((await call('manual', { date: L.addDays(today(), 2), items: [{ description: 'x', qty: 1, unit_price: 1 }] })).error, /future/);
  assert.match((await call('manual', { date: dayBefore(1), items: [] })).error, /at least one item/);
  assert.match((await call('manual', { date: dayBefore(1), items: [{ description: 'x', qty: 'a', unit_price: 1 }] })).error, /numbers/);
});

test('edit a receipt -> items replaced, totals and AUD recomputed, sheet copy replaced', async () => {
  const r = await scanBytes(photo());
  await settle(); F.googleCalls.length = 0;
  const e = await call('edit', { id: r.id, merchant: 'Migros Capitol', items: [
    { description: 'Bananas', category: 'Groceries', qty: 2, unit_price: 49.9 }] });
  assert.equal(e.status, 'saved', e.error);
  const rec = (await S.q('select merchant, total, total_aud from receipts'))[0];
  assert.equal(rec.merchant, 'Migros Capitol'); assert.equal(Number(rec.total), 99.8); assert.equal(Number(rec.total_aud), 3.64);
  assert.equal((await S.q('select count(*)::int n from items'))[0].n, 1);
  await settle();
  assert.deepEqual(F.googleCalls.map(c => c.action), ['unrecord', 'record']);
});

test('delete a receipt -> rows and photo gone, sheet copy removed', async () => {
  const r = await scanBytes(photo());
  await settle(); F.googleCalls.length = 0;
  const d = await call('delete', { id: r.id });
  assert.equal(d.status, 'deleted');
  assert.equal((await S.q('select count(*)::int n from items'))[0].n, 0);
  assert.equal(F.files[r.path], undefined);
  await settle();
  assert.equal(F.googleCalls[0].action, 'unrecord');
});

test('data: every receipt with its items and the settings', async () => {
  await scanBytes(photo());
  const d = await call('data');
  assert.equal(d.receipts.length, 1); assert.equal(d.receipts[0].items.length, 2); assert.equal(d.receipts[0].has_photo, true);
  assert.equal(d.settings.season.start, '2026-09-01'); assert.ok(d.settings.categories.includes('Groceries'));
  const p = await call('photo', { id: d.receipts[0].id });
  assert.ok(p.ok && /token=read/.test(p.url));
});

test('daily maintenance fills a missing AUD amount and retries a failed backup', async () => {
  const r = await scanBytes(photo());
  await settle();
  await S.q("update receipts set total_aud = null, backup_status = 'failed', created_at = now() - interval '1 hour', backup_tried_at = now() - interval '1 hour'");
  await S.q('update items set aud = null');
  F.googleCalls.length = 0;
  const out = await new Promise(res => api({ method: 'GET', url: '/api?cron=1', headers: {} }, { setHeader() {}, status() { return this; }, json: res }));
  assert.equal(out.ok, true); assert.equal(out.aud, 1); assert.equal(out.backups, 1);
  assert.equal(Number((await S.q('select total_aud from receipts'))[0].total_aud), 2.18);
  assert.equal((await S.q('select backup_status from receipts'))[0].backup_status, 'done');
  assert.equal(F.googleCalls[0].action, 'record');
});

test('season dates can be changed, and must make sense', async () => {
  assert.equal((await call('settings', { start: '2026-09-01', end: '2027-06-30' })).season.end, '2027-06-30');
  assert.equal((await call('settings', { start: '2027-01-01', end: '2026-01-01' })).ok, false);
  await call('settings', { start: '2026-09-01', end: '2027-05-31' });
});
