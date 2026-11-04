// The whole app in a real browser: fake camera -> scanner -> server -> local Postgres, with the
// stand-ins from test/fakes.js for storage, Claude, exchange rates and Google.
// Run: TEST_DATABASE_URL=... VIDEO_DIR=<folder with single.y4m> PLAYWRIGHT=<path to playwright> node test/browser/e2e.js
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fakes = require('../fakes');
const dev = require('../devserver');

const KEY = 'e'.repeat(48);
const VIDEO = path.join(process.env.VIDEO_DIR || '.', 'single.y4m');
let fail = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : '')); if (!ok) fail++; };

(async () => {
  const F = await fakes.start();
  Object.assign(process.env, F.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, PGSSL: 'off', APP_KEY: KEY });
  const S = require('../../lib/services'), L = require('../../lib/logic');
  await S.q('drop table if exists items, receipts, pending, settings, fx_rates cascade');
  await S.q(fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8'));
  const server = await dev.start(0);
  const APP = 'http://localhost:' + server.address().port + '/';
  const recent = L.addDays(L.todayIn('Europe/Istanbul'), -2);
  const reply = o => Object.assign({ merchant: 'Migros', date: recent, date_printed: null, receipt_number: null, receipt_time: null, currency: 'TRY',
    payment_method: 'Card', receipt_total: 59.85, confidence: 'high', notes: null, items: [
      { original_text: 'MUZ YERLI KG', description_en: 'Bananas', category: 'Groceries', quantity: 1, unit_price: 49.9, line_total: 49.9 },
      { original_text: 'SU 0.5L', description_en: 'Water 0.5L', category: 'Groceries', quantity: 1, unit_price: 9.95, line_total: 9.95 }] }, o || {});
  F.setClaude(reply());

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + VIDEO, '--no-proxy-server'] });
  const errs = [];
  async function open(hash, opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, permissions: ['camera'] }, opts || {}));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await page.goto(APP + (hash || '#k=' + KEY));
    return { ctx, page };
  }
  const count = async t => (await S.q('select count(*)::int n from ' + t))[0].n;
  // The fake camera loops one short video, so two scans can be the very same frame, byte for byte
  // (a real camera never repeats a photo exactly). Forget earlier photos' fingerprints before each
  // scan so every scenario tests what it is meant to, not the exact-photo check.
  const yes = async page => { await S.q('update receipts set photo_sha = null');
    if (await page.isHidden('#scanner')) await page.click('#scanBtn'); await page.waitForSelector('#confirm:not([hidden])', { timeout: 40000 }); await page.click('#yesBtn'); };
  const logText = page => page.textContent('#log');

  try {
    // A. Scan -> Yes -> read -> logged; appears under Receipts; Summary adds it up
    { const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      check('connects (health check passes, incl. storage round trip)', true, await page.textContent('#conn'));
      check('"/" serves the new app, not the old Google-only scanner', await page.title() === 'Season Expenses' && await page.isVisible('#viewHome'), await page.title());
      check('opens on Home with the camera off', await page.isVisible('#viewHome') && await page.isHidden('#scanner') &&
        !(await page.evaluate(() => !!document.getElementById('video').srcObject)));
      await yes(page);
      await page.waitForFunction(() => /Logged/.test(document.getElementById('log').textContent), null, { timeout: 40000 });
      check('scan logged', await count('receipts') === 1, (await logText(page)).trim().slice(0, 80));
      check('scanner shows the result line', /Logged/.test(await page.textContent('#scanLast')));
      await page.click('#closeScan');
      check('Close turns the camera off', await page.isHidden('#scanner') && !(await page.evaluate(() => !!document.getElementById('video').srcObject)));
      check('the scan is listed under Scans on Home', await page.isVisible('#homeScans') && /Logged/.test(await page.textContent('#homeScans')));
      const photoInStorage = Object.keys(F.files).filter(k => !/^selftest/.test(k)).length;
      check('photo uploaded straight to storage (not through the server)', photoInStorage === 1 && F.claudeCalls.length === 1);
      await page.click('#nav [data-tab="list"]');
      await page.waitForSelector('#list .rc', { timeout: 10000 });
      check('Receipts tab lists it', /Migros/.test(await page.textContent('#list')) && /59\.85 TRY/.test(await page.textContent('#list')));
      await page.screenshot({ path: path.join(process.env.SHOTS || '.', 'list.png') });
      await page.click('#nav [data-tab="home"]');
      await page.waitForSelector('#home .hero', { timeout: 10000 });
      check('Home dashboard shows the AUD total', /A\$2\.18/.test(await page.textContent('#home .hero')), (await page.textContent('#home .hero')).slice(0, 60));
      check('Home lists it under latest receipts and categories', /Migros/.test(await page.textContent('#home')) && /Groceries/.test(await page.textContent('#home')));
      await page.screenshot({ path: path.join(process.env.SHOTS || '.', 'summary.png') });
      await ctx.close(); }

    // B. Add by hand -> saved -> listed as typed in; totals right
    { const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      await page.click('#nav [data-tab="list"]');
      await page.click('#addBtn');
      await page.fill('#sheetBody input[type=date]', '2026-10-22');
      await page.fill('#sheetBody input[placeholder="e.g. Local market"]', 'Local market');
      const forms = () => page.$$('#sheetBody .itemform');
      let f = (await forms())[0];
      await (await f.$('input')).fill('Pomegranates (3)');
      await (await f.$$('input'))[2].fill('100');
      await page.click('text=+ Another item');
      f = (await forms())[1];
      await (await f.$('input')).fill('Blueberries (punnet)');
      await (await f.$$('input'))[1].fill('2');
      await (await f.$$('input'))[2].fill('150');
      check('form shows the running total', /Total 400\.00 TRY/.test(await page.textContent('#sheetBody')));
      await page.screenshot({ path: path.join(process.env.SHOTS || '.', 'add.png') });
      await page.click('text=Save receipt');
      await page.waitForFunction(() => /Local market/.test(document.getElementById('list').textContent), null, { timeout: 15000 });
      const r = (await S.q("select total, source, receipt_date::text d from receipts where merchant = 'Local market'"))[0];
      check('typed-in receipt saved with the right total and date', r && Number(r.total) === 400 && r.source === 'manual' && r.d === '2026-10-22');
      check('listed as typed in', /typed in/.test(await page.textContent('#list')));
      await ctx.close(); }

    // C. Open a receipt -> edit an item -> totals updated; delete -> gone
    { const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      await page.click('#nav [data-tab="list"]');
      await page.click('#list .rc:has-text("Local market")');
      await page.click('#sheetBody >> text=Edit');
      const f = (await page.$$('#sheetBody .itemform'))[1];
      await (await f.$$('input'))[1].fill('3');
      await page.click('text=Save changes');
      await page.waitForFunction(() => /550\.00 TRY/.test(document.getElementById('list').textContent), null, { timeout: 15000 });
      check('edit saved: 3 punnets -> 100 + 3 x 150 = 550', Number((await S.q("select total from receipts where merchant = 'Local market'"))[0].total) === 550);
      page.once('dialog', d => d.accept());
      await page.click('#list .rc:has-text("Local market")');
      await page.click('#sheetBody >> text=Delete');
      await page.waitForFunction(() => !/Local market/.test(document.getElementById('list').textContent), null, { timeout: 15000 });
      check('delete removes it', (await S.q("select count(*)::int n from receipts where merchant = 'Local market'"))[0].n === 0);
      await ctx.close(); }

    // D. A look-alike scan -> asked; "Add anyway" adds it
    { const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      await yes(page);
      await page.waitForFunction(() => /Add anyway/.test(document.getElementById('log').textContent), null, { timeout: 40000 });
      check('same shop/day/total -> asks first, nothing written', await count('receipts') === 1 && await count('pending') === 1);
      await page.click('#closeScan');
      await page.click('#log >> text=Add anyway');
      await page.waitForFunction(() => /Logged/.test(document.getElementById('log').textContent), null, { timeout: 40000 });
      check('"Add anyway" -> logged', await count('receipts') === 2 && await count('pending') === 0);
      await ctx.close(); }

    // E. Storage down and server unreachable while sending -> kept on the phone -> sent on reopening
    { F.setClaude(reply({ date: L.addDays(recent, -1), merchant: 'BIM' }));
      const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      await ctx.route('**/api', r => r.abort());
      await yes(page);
      await page.waitForFunction(() => /kept on this phone/.test(document.getElementById('log').textContent), null, { timeout: 40000 });
      check('no connection -> scan kept on the phone', true);
      await page.close();
      await ctx.unroute('**/api');
      const p2 = await ctx.newPage(); p2.on('pageerror', e => errs.push(e.message));
      await p2.goto(APP + '#k=' + KEY);
      await p2.waitForFunction(() => /Logged/.test(document.getElementById('log').textContent), null, { timeout: 40000 });
      check('reopened -> sent and logged by itself', (await S.q("select count(*)::int n from receipts where merchant = 'BIM'"))[0].n === 1);
      await ctx.close(); }

    // F. Direct upload to storage fails -> the photo goes through the server instead
    { F.setClaude(reply({ date: L.addDays(recent, -3), merchant: 'A101' }));
      const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      await ctx.route(/\/storage\/v1\/object\/upload\/sign\//, r => r.request().method() === 'PUT' ? r.abort() : r.continue());
      await yes(page);
      await page.waitForFunction(() => /Logged/.test(document.getElementById('log').textContent), null, { timeout: 40000 });
      check('fallback upload through the server works', (await S.q("select count(*)::int n from receipts where merchant = 'A101'"))[0].n === 1);
      await page.waitForTimeout(500);
      const left = await page.evaluate(() => new Promise(r => { const q = indexedDB.open('receiptScannerOutbox', 1); q.onsuccess = () => { const g = q.result.transaction('scans').objectStore('scans').getAll(); g.onsuccess = () => r(g.result.length); }; }));
      check('after the fallback, nothing is left in the phone outbox', left === 0, left);
      await ctx.close(); }

    // G. Wrong key -> locked, asks for the key
    { const { ctx, page } = await open('#k=' + 'x'.repeat(48));
      await page.waitForSelector('#setup:not([hidden])', { timeout: 15000 });
      check('wrong key -> locked screen', /Unlock/.test(await page.textContent('#setup')));
      await ctx.close(); }

    // H. Nothing wider than the phone, at 320 px, on every screen
    { const { ctx, page } = await open(undefined, { viewport: { width: 320, height: 640 } });
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      const wide = async () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 0.5 ||
        [...document.querySelectorAll('body *')].some(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5) && getComputedStyle(e).position !== 'fixed' && e.offsetParent; }));
      const res = {};
      for (const t of ['home', 'list']) { await page.click('#nav [data-tab="' + t + '"]'); await page.waitForTimeout(800); res[t] = await wide(); }
      await page.click('#scanBtn'); await page.waitForTimeout(800); res.scan = await wide(); await page.click('#closeScan');
      await page.click('#nav [data-tab="list"]'); await page.click('#addBtn'); await page.waitForTimeout(300); res.add = await wide();
      check('320 px: nothing cut off on home, receipts, scanner, add form', !Object.values(res).some(Boolean), JSON.stringify(res));
      await ctx.close(); }

    // I. A new deploy -> the open app notices and reloads itself (no re-adding to the home screen)
    { const { ctx, page } = await open();
      await page.waitForFunction(() => document.getElementById('conn').className === 'ok', null, { timeout: 15000 });
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.__old = true; });
      await ctx.route('**/api?version=1', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, version: 'next-deploy' }) }));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => !window.__old, null, { timeout: 10000 }).catch(() => {});
      check('new version -> app reloads itself', await page.evaluate(() => !window.__old));
      // ...but never in the middle of a scan: it waits and offers the update instead
      await page.waitForSelector('#home .hero', { timeout: 15000 });
      await page.evaluate(() => { window.__old = true; });
      await page.click('#scanBtn');
      await ctx.route('**/api?version=1', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, version: 'third-deploy' }) }));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForSelector('#update:not([hidden])', { timeout: 10000 });
      check('scanner open -> no reload, update offered', await page.evaluate(() => window.__old === true));
      await page.click('#closeScan');
      await page.waitForFunction(() => !window.__old, null, { timeout: 10000 }).catch(() => {});
      check('closing the scanner -> update applied', await page.evaluate(() => !window.__old));
      await ctx.close(); }
  } catch (e) {
    console.log('FAIL (crashed) ' + e.stack); fail++;
  }
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await browser.close(); server.close(); F.close(); await S.db().end();
  console.log(fail ? '\nE2E FAIL (' + fail + ')' : '\nE2E ALL PASS');
  process.exit(fail ? 1 : 0);
})();
