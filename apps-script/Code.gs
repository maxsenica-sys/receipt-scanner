/**
 * RECEIPT SCANNER — Google Sheets edition (runs in Google's cloud, no computer needed)
 *
 * Two ways in:
 *  1. Receipt Scanner app (a normal web page, see APP_URL): point the phone at a receipt, it finds
 *     the edges, takes the photo itself, flattens it and sends it here. It is read straight away.
 *  2. Phone share sheet: photo -> Share -> Drive -> "Receipts Inbox". Picked up within 10 minutes.
 * Either way the receipt is read with Claude, translated, split into line items, written to the
 * Expenses tab, and the image is moved to "Receipts Processed".
 *
 * The app talks to this script through doPost (below). Nothing on the phone needs a Google sign-in:
 * every request carries a secret key, and anything without it is refused.
 *
 * Setup: paste this > Save > run setup() once > approve. Receipts menu > Set API key.
 * Then: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone) > Deploy,
 * and Receipts menu > Set up scanner app.
 * After pasting new code later: Deploy > Manage deployments > pencil > Version: New version > Deploy.
 */

const APP_URL = 'https://maxsenica-sys.github.io/receipt-scanner/';
const MODEL = 'claude-sonnet-5-5';
const DEFAULT_CURRENCY = 'TRY';
const MAX_PER_RUN = 8;
const START_BUDGET_MS = 150000;         // never START a receipt after 2.5 min, so a run ends well inside 6 min
const MAX_TRIES = 6;                    // temporary problems are retried this many runs (~1 hour) before Failed
const TOTAL_TOLERANCE = 0.02;
const FOLDERS = { inbox: 'Receipts Inbox', processed: 'Receipts Processed', failed: 'Receipts Failed' };
const COL = { date:1, merchant:2, item:3, original:4, category:5, qty:6, unit:7, line:8,
              currency:9, aud:10, payment:11, file:12, id:13, flag:14, tag:15 };

// ------------------------------------------------------------------ menu / setup
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Receipts')
    .addItem('Scan inbox now', 'scanInbox')
    .addItem('Set API key', 'setApiKey')
    .addItem('Open inbox folder link', 'showInboxLink')
    .addSeparator()
    .addItem('Set up scanner app', 'setUpScannerApp')
    .addItem('Scanner app link', 'showScannerLink')
    .addItem('New scanner key (old link stops working)', 'newScannerKey')
    .addToUi();
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  const parent = DriveApp.getFileById(ss_().getId()).getParents().next();
  Object.entries(FOLDERS).forEach(([key, name]) => {
    const it = parent.getFoldersByName(name);
    const f = it.hasNext() ? it.next() : parent.createFolder(name);
    props.setProperty('folder_' + key, f.getId());
  });
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'scanInbox')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanInbox').timeBased().everyMinutes(10).create();
  Logger.log('Setup done. Folders created next to the sheet; scanner runs every 10 minutes.');
}

// The spreadsheet this script belongs to. Web-app requests have no "active" spreadsheet, so its
// id is remembered whenever the script runs from the sheet itself.
function ss_() {
  const props = PropertiesService.getScriptProperties();
  let a = null;
  try { a = SpreadsheetApp.getActive(); } catch (e) { a = null; }
  if (a) {
    const id = a.getId();
    if (props.getProperty('SHEET_ID') !== id) props.setProperty('SHEET_ID', id);
    return a;
  }
  const id = props.getProperty('SHEET_ID');
  if (!id) throw new Error('Open the spreadsheet and use Receipts menu > Set up scanner app once.');
  return SpreadsheetApp.openById(id);
}

function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Anthropic API key', 'Paste your key (starts with sk-ant-):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) {
    PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', r.getResponseText().trim());
    ui.alert('Saved.');
  }
}

function showInboxLink() {
  const id = PropertiesService.getScriptProperties().getProperty('folder_inbox');
  SpreadsheetApp.getUi().alert(id ? 'https://drive.google.com/drive/folders/' + id : 'Run setup() first.');
}

// ------------------------------------------------------------------ scanner app link
// Asks for the web app URL (Deploy > Manage deployments > Copy) and builds the phone link.
function setUpScannerApp() {
  ss_();   // remembers this spreadsheet for web-app requests
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Set up scanner app',
    'In the Apps Script editor: Deploy > Manage deployments. Click the active Web app deployment ' +
    '(Execute as: Me, Who has access: Anyone) and press Copy under "Web app URL". Paste it here:',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const url = r.getResponseText().trim().replace(/\?.*$/, '');
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(url)) {
    ui.alert('That is not a web app URL.\n\nIt should look like\nhttps://script.google.com/macros/s/AKfy…/exec\n\n' +
             'Use the Copy button under "Web app URL" in Deploy > Manage deployments.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', url);
  showScannerLink();
}

function scannerLink_() {
  const url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL');
  if (!url) return null;
  return APP_URL + '#u=' + encodeURIComponent(url) + '&k=' + scannerKey_();
}

function showScannerLink() {
  const ui = SpreadsheetApp.getUi();
  const link = scannerLink_();
  if (!link) { ui.alert('Not set up yet: Receipts menu > Set up scanner app.'); return; }
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial,sans-serif;line-height:1.5">' +
    '<p>Open this on your phone in <b>Safari</b> or <b>Chrome</b> (email it to yourself or AirDrop it - ' +
    'not through Facebook/Messenger). Then Share &gt; <b>Add to Home Screen</b>.</p>' +
    '<textarea id="l" readonly style="width:100%;height:110px;font:12px monospace">' + link + '</textarea>' +
    '<p><button onclick="var t=document.getElementById(\'l\');t.select();document.execCommand(\'copy\');this.textContent=\'Copied\'">Copy link</button></p>' +
    '<p style="color:#666">Keep it private: the key in it is what lets it send receipts. ' +
    'Receipts menu &gt; New scanner key replaces it.</p></div>').setWidth(520).setHeight(330);
  ui.showModalDialog(html, 'Scanner app link');
}

function newScannerKey() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('New scanner key', 'The current phone link will stop working and you will need to open the new one. Continue?',
               ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().deleteProperty('SCANNER_KEY');
  showScannerLink();
}

// The phone link carries this key instead of needing a Google sign-in on the phone.
function scannerKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SCANNER_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SCANNER_KEY', key);
  }
  return key;
}

function checkKey_(key) {
  const real = PropertiesService.getScriptProperties().getProperty('SCANNER_KEY');
  if (!real || key !== real) throw new Error('KEY: This phone link is out of date. Open the current one from Receipts menu > Scanner app link.');
}

// ------------------------------------------------------------------ web app (the app's back end)
// Opening the web app URL in a browser just confirms the deployment is alive. Shows nothing private.
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(
    { ok: true, service: 'receipt-scanner', note: 'Back end is running. Use the Receipt Scanner app link from the Receipts menu.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Every request from the app: { action, key, ... } as plain text JSON (plain text avoids a CORS
// preflight, which Apps Script cannot answer). Always answers JSON: { ok: true, ... } or { ok: false, error }.
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(req.key);
    switch (req.action) {
      case 'ping':    out = ping_(); break;
      case 'upload':  out = uploadReceipt_(req.data, req.mime, req.name); break;
      case 'process': out = processNow_(req.id); break;
      case 'scan':    out = runScan_(); break;
      case 'status':  out = receiptStatus_(req.id); break;
      default: throw new Error('Unknown action ' + req.action);
    }
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// The app calls this when it opens, so a broken setup is reported on the phone straight away.
function ping_() {
  const props = PropertiesService.getScriptProperties();
  const problems = [];
  if (!props.getProperty('ANTHROPIC_API_KEY')) problems.push('No Anthropic API key: Receipts menu > Set API key.');
  ['inbox', 'processed', 'failed'].forEach(k => {
    const id = props.getProperty('folder_' + k);
    try { if (!id) throw 0; DriveApp.getFolderById(id).getName(); }
    catch (x) { problems.push('Folder "' + FOLDERS[k] + '" missing: run setup() in the script editor.'); }
  });
  let sheet = '';
  try { sheet = ss_().getName(); } catch (x) { problems.push(x.message); }
  return { sheet: sheet, problems: problems };
}

// Saves one scanned receipt (JPEG, or a PDF of several sections) into the inbox. Quick: the app
// waits only for this, so the phone can be put away as soon as it answers.
function uploadReceipt_(base64, mime, name) {
  if (['image/jpeg', 'application/pdf'].indexOf(mime) === -1) throw new Error('Unsupported file type ' + mime);
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if (!bytes.length) throw new Error('The scan arrived empty');
  if (bytes.length > 25e6) throw new Error('Scan is too large (' + Math.round(bytes.length / 1e6) + ' MB)');
  const id = PropertiesService.getScriptProperties().getProperty('folder_inbox');
  if (!id) throw new Error('Run setup() in the script editor first.');
  const safeName = String(name || 'scan').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 60);
  const file = DriveApp.getFolderById(id).createFile(Utilities.newBlob(bytes, mime, safeName));
  file.setDescription('Uploaded from the scanner app - waiting to be read.');
  return { id: file.getId(), name: file.getName() };
}

// Reads one just-uploaded receipt right now and answers with the result. Runs alongside other
// scans; if the phone stops waiting, it still finishes here, and the 10-minute timer is the backstop.
function processNow_(fileId) {
  const out = runScan_(String(fileId));
  const mine = out.results.filter(r => r.id === String(fileId))[0];
  return mine || receiptStatus_(fileId);
}

// Where a receipt has got to: still in the inbox, logged, or failed - with the reason.
function receiptStatus_(fileId) {
  const props = PropertiesService.getScriptProperties();
  const file = DriveApp.getFileById(String(fileId));
  const parents = file.getParents();
  const where = parents.hasNext() ? parents.next().getId() : '';
  const status = where === props.getProperty('folder_processed') ? 'logged'
               : where === props.getProperty('folder_failed') ? 'failed'
               : where === props.getProperty('folder_inbox') ? 'waiting' : 'unknown';
  if (status === 'unknown') throw new Error('That file is not one of the scanner\'s receipts');
  const message = file.getDescription() || '';
  return { id: String(fileId), status: /^Duplicate/.test(message) ? 'duplicate' : status, message: message };
}

// ------------------------------------------------------------------ main loop
// The 10-minute trigger calls this with an event object, which is ignored.
function scanInbox() { runScan_(); }

const CLAIM_MS = 7 * 60 * 1000;   // longer than Apps Script's 6-minute limit, so a claim outlives its run

// Reads receipts in the inbox (or just one, when the app asks). Several runs can work at once:
// each claims its file first, and only the moment of writing to the sheet is done one at a time.
function runScan_(onlyId) {
  const started = Date.now();
  const env = env_();
  const results = [];
  let list = [];
  if (onlyId) list = [DriveApp.getFileById(onlyId)];
  else { const it = env.inbox.getFiles(); while (it.hasNext() && list.length < 50) list.push(it.next()); }
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    if (n >= MAX_PER_RUN || Date.now() - started > START_BUDGET_MS) break;
    const file = list[i], fid = file.getId(), mime = file.getMimeType();
    if (!/^image\//.test(mime) && mime !== 'application/pdf') continue;
    if (onlyId && !inFolder_(file, env.props.getProperty('folder_inbox'))) continue;   // already done
    if (!claim_(env.props, fid)) continue;                                            // another run has it
    n++;
    try { results.push(processFile_(file, env)); }
    finally { unclaim_(env.props, fid); }
  }
  SpreadsheetApp.flush();
  return { results: results };
}

function env_() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('No API key — Receipts menu > Set API key');
  const ss = ss_();
  return {
    props: props, key: key, ss: ss, ws: ss.getSheetByName('Expenses'), tz: ss.getSpreadsheetTimeZone(),
    cats: readCategories_(ss), fx: readFxCurrencies_(ss),
    inbox: DriveApp.getFolderById(props.getProperty('folder_inbox')),
    processed: DriveApp.getFolderById(props.getProperty('folder_processed')),
    failed: DriveApp.getFolderById(props.getProperty('folder_failed'))
  };
}

function inFolder_(file, folderId) {
  const p = file.getParents();
  while (p.hasNext()) if (p.next().getId() === folderId) return true;
  return false;
}

function claim_(props, fid) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const at = Number(props.getProperty('claim_' + fid) || 0);
    if (Date.now() - at < CLAIM_MS) return false;
    props.setProperty('claim_' + fid, String(Date.now()));
    return true;
  } finally { lock.releaseLock(); }
}
function unclaim_(props, fid) { props.deleteProperty('claim_' + fid); }

// One receipt, start to finish. Returns { id, status: logged|duplicate|waiting|failed, message }.
function processFile_(file, env) {
  const fid = file.getId(), mime = file.getMimeType(), props = env.props;
  const rid = fingerprint_(file);   // same photo uploaded twice = same fingerprint
  try {
    if (existingIds_(env.ws).has(rid)) return skipDuplicate_(file, env, 'this exact photo is already logged');
    const media = mediaBlock_(file);
    if (!media) throw retryable_('Drive has not made a preview of this photo yet');
    const data = callClaude_(env.key, media, env.cats);

    // Writing is the only step done one at a time, so two scans can never take the same rows and
    // the duplicate check sees everything written before it.
    const lock = LockService.getScriptLock();
    lock.waitLock(60000);
    let res;
    try {
      const groups = receiptGroups_(env.ws, env.tz);
      if (groups.some(g => g.rid === rid)) return skipDuplicate_(file, env, 'this exact photo is already logged');
      const match = matchReceipt_(signature_(data), groups);
      if (match && match.same) {
        return skipDuplicate_(file, env, 'it is the same printed receipt as one logged on ' + match.group.dateKey +
          ' (' + match.group.merchant + ', rows ' + match.group.rows[0] + '-' + match.group.rows[match.group.rows.length - 1] + ')');
      }
      res = writeReceipt_(env.ws, data, rid, env.cats, env.fx, file.getName(), mime, match);
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }

    file.setName(res.fileName);
    const message = summary_(data, res, env.tz);
    file.setDescription(message);
    file.moveTo(env.processed);
    clearTries_(props, fid);
    return { id: fid, status: 'logged', message: message };
  } catch (e) {
    let msg = e.message;
    if (e.retryable) {
      const tries = bumpTries_(props, fid);
      if (tries < MAX_TRIES) {
        file.setDescription('Will retry (' + tries + '/' + MAX_TRIES + '): ' + msg);
        console.warn(file.getName() + ': ' + msg);
        return { id: fid, status: 'waiting', message: 'Will retry shortly: ' + msg };
      }
      msg += ' (gave up after ' + tries + ' tries - move it back to Receipts Inbox to try again)';
    }
    file.setDescription('Scanner error: ' + msg);
    file.moveTo(env.failed);
    clearTries_(props, fid);
    console.error(file.getName() + ': ' + msg);
    return { id: fid, status: 'failed', message: msg };
  }
}

function skipDuplicate_(file, env, why) {
  const message = 'Duplicate - not added again: ' + why + '.';
  file.setDescription(message);
  file.moveTo(env.processed);
  clearTries_(env.props, file.getId());
  return { id: file.getId(), status: 'duplicate', message: message };
}

function retryable_(msg) { const e = new Error(msg); e.retryable = true; return e; }
function bumpTries_(props, fid) {
  const t = Number(props.getProperty('tries_' + fid) || 0) + 1;
  props.setProperty('tries_' + fid, String(t));
  return t;
}
function clearTries_(props, fid) { props.deleteProperty('tries_' + fid); }

function summary_(data, res, tz) {
  const items = data.items || [];
  const sum = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
  const parts = ['Logged ' + items.length + ' item' + (items.length === 1 ? '' : 's'),
                 String(data.merchant || 'unknown shop'),
                 sum.toFixed(2) + ' ' + res.currency,
                 Utilities.formatDate(res.date, tz, 'd MMM yyyy')];
  if (res.flag) parts.push('Check: ' + res.flag);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ duplicate receipts
// A receipt is "the same receipt" only when its printed identity matches: same day and same
// receipt number, or same day, same printed time and same total. Same shop + day + total with
// nothing else to compare is NOT treated as a duplicate (repeat purchases are normal) - it is
// logged and flagged so it can be checked.
function merchantKey_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0] || '';
}
function receiptNo_(s) { const t = String(s || '').replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, ''); return t || ''; }
function receiptTime_(s) {
  const m = String(s || '').match(/(\d{1,2})[:.](\d{2})/);
  return m && +m[1] < 24 && +m[2] < 60 ? ('0' + (+m[1])).slice(-2) + ':' + m[2] : '';
}
function tagText_(no, time) { return [no ? 'No. ' + no : '', time].filter(String).join(' · '); }
function parseTag_(t) {
  const s = String(t || '');
  const no = s.match(/No\.\s*([A-Za-z0-9]+)/);
  return { no: no ? receiptNo_(no[1]) : '', time: receiptTime_(s.replace(/No\.\s*[A-Za-z0-9]+/, '')) };
}
function dayKey_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  if (typeof v === 'number' && v > 0) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  return '';
}
function ymd_(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

// Every receipt already on the Expenses tab, grouped by Receipt ID.
function receiptGroups_(ws, tz) {
  const last = ws.getLastRow();
  if (last < 2) return [];
  const vals = ws.getRange(2, 1, last - 1, COL.tag).getValues();
  const by = {}, order = [];
  vals.forEach((v, i) => {
    if (String(v[COL.item - 1]).trim() === '' || !v[COL.id - 1]) return;
    const rid = String(v[COL.id - 1]);
    let g = by[rid];
    if (!g) {
      const tag = parseTag_(v[COL.tag - 1]);
      g = by[rid] = { rid: rid, rows: [], total: 0, dateKey: dayKey_(v[COL.date - 1], tz), merchant: String(v[COL.merchant - 1]),
                      mkey: merchantKey_(v[COL.merchant - 1]), no: tag.no, time: tag.time };
      order.push(g);
    }
    g.rows.push(i + 2);
    g.total += Number(v[COL.line - 1]) || 0;
  });
  return order;
}

// What identifies a newly read receipt, computed the same way as the sheet computes its rows.
function signature_(data) {
  const flags = [];
  const d = resolveDate_(data, flags);
  const total = (data.items || []).reduce((s, it) => {
    const q = Math.round(Number(it.quantity || 1) * 1000) / 1000;
    const u = Math.round((it.unit_price != null ? Number(it.unit_price) : Number(it.line_total || 0)) * 100) / 100;
    return s + q * u;
  }, 0);
  return { dateKey: d ? ymd_(d) : '', total: total, mkey: merchantKey_(data.merchant),
           no: receiptNo_(data.receipt_number), time: receiptTime_(data.receipt_time) };
}

// { same: true, group } = the same printed receipt; { same: false, group } = possible duplicate; null = new.
function matchReceipt_(sig, groups) {
  if (!sig.dateKey) return null;
  let possible = null;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.dateKey !== sig.dateKey) continue;
    const shop = !!sig.mkey && g.mkey === sig.mkey;
    const sameTotal = Math.abs(g.total - sig.total) <= Math.max(0.02, 0.002 * Math.abs(sig.total));
    if (sig.no && g.no) { if (shop && sig.no === g.no) return { same: true, group: g }; continue; }
    if (sig.time && g.time) { if (shop && sameTotal && sig.time === g.time) return { same: true, group: g }; continue; }
    if (shop && sameTotal && !possible) possible = { same: false, group: g };
  }
  return possible;
}

// ------------------------------------------------------------------ image handling
// Phone photos can be 5MB+ or HEIC. Drive's thumbnail service returns a resized JPEG for any image.
// Long receipts read best as a multi-page PDF of overlapping sections - which is what the app sends.
function mediaBlock_(file) {
  const mime = file.getMimeType();
  if (mime === 'application/pdf') {
    if (file.getSize() > 24e6) throw new Error('PDF too large (' + Math.round(file.getSize() / 1e6) + ' MB)');
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf',
             data: Utilities.base64Encode(file.getBlob().getBytes()) } };
  }
  const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  // Small enough to send as-is: no need to wait for Drive (this is the scanner app's path).
  if (ok.indexOf(mime) > -1 && file.getSize() <= 3.7e6) {
    return { type: 'image', source: { type: 'base64', media_type: mime,
             data: Utilities.base64Encode(file.getBlob().getBytes()) } };
  }
  const token = ScriptApp.getOAuthToken();
  const meta = JSON.parse(UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + file.getId() + '?fields=thumbnailLink',
    { headers: { Authorization: 'Bearer ' + token } }).getContentText());
  if (!meta.thumbnailLink) return null;
  const url = meta.thumbnailLink.replace(/=s\d+$/, '') + '=s2000';
  const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg',
           data: Utilities.base64Encode(r.getContent()) } };
}

// ------------------------------------------------------------------ Claude call
// Throws a retryable error for anything temporary (rate limit, overload, outage, network,
// timeout), so the receipt stays in the inbox instead of being filed as Failed.
function callClaude_(key, media, cats) {
  const tool = toolSchema_(cats);
  const body = {
    model: MODEL, max_tokens: 8000,
    output_config: { effort: 'low' },   // keeps each read well inside UrlFetch's time limit
    fallbacks: 'default',               // if the model declines, the API retries on another model
    tools: [tool], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [media, { type: 'text', text: prompt_(cats) }] }]
  };
  // Optional extras. If the API ever rejects one, it is dropped and the call repeated,
  // so a request-format change never sends a good receipt to Failed.
  const optional = {
    strict: () => delete tool.strict,
    fallbacks: () => delete body.fallbacks,
    output_config: () => delete body.output_config
  };
  let last = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt && last.indexOf('dropped') === -1) Utilities.sleep(4000 * attempt);
    let resp;
    try {
      const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      if (body.fallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: headers, payload: JSON.stringify(body)
      });
    } catch (e) { last = 'network: ' + e.message; continue; }
    const code = resp.getResponseCode();
    const text = resp.getContentText();
    if (code === 200) {
      const out = JSON.parse(text);
      if (out.stop_reason === 'refusal') throw new Error('Claude declined to read this image');
      const tu = (out.content || []).find(b => b.type === 'tool_use' && b.name === 'record_receipt');
      if (tu) return tu.input;
      if (out.stop_reason === 'max_tokens') throw new Error('Receipt too long to read in one go - scan it in sections with the app');
      last = 'no receipt data in the reply';
      continue;
    }
    if (code === 429 || code === 529 || code >= 500) { last = 'API ' + code; continue; }
    if (code === 400) {
      const named = Object.keys(optional).filter(k => text.indexOf(k) > -1 ||
        (k === 'strict' && /schema/i.test(text)) || (k === 'fallbacks' && /beta/i.test(text)));
      const drop = named.length ? named : Object.keys(optional);
      if (drop.length) {
        drop.forEach(k => { optional[k](); delete optional[k]; });
        last = 'API 400, dropped ' + drop.join(', ');
        console.warn(last + ': ' + text.slice(0, 200));
        continue;
      }
    }
    throw new Error('API ' + code + ': ' + text.slice(0, 300));
  }
  throw retryable_('Claude unavailable right now (' + last + ')');
}

function prompt_(cats) {
  const tz = ss_().getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  return [
    'You are reading a purchase receipt (photo, screenshot or scan). It may be in Turkish or English.',
    'Extract every purchased line item and call the record_receipt tool exactly once.',
    '',
    'SEVERAL PAGES: when the input has more than one page, they are overlapping photos of ONE receipt,',
    'top to bottom. The bottom of each page repeats the top of the next. Record each printed line once:',
    'an item visible in two overlapping pages is one item. Separate identical lines (e.g. the same',
    'product rung up three times) are still separate items - use the line order to tell them apart.',
    '',
    'DATES - day first, always. This is the single most common mistake, so read it twice:',
    '- Today is ' + today + '. No receipt can be dated after today.',
    '- Turkish and Australian receipts print the DAY first: DD.MM.YYYY, DD/MM/YYYY or DD-MM-YYYY.',
    '  01.10.2026 = 1 October 2026. 03.04.2026 = 3 April 2026. Never read the first number as a month.',
    '- date_printed: the date exactly as printed on the receipt, character for character.',
    '- date: that same date as YYYY-MM-DD, converted day-first. null if no date is visible.',
    '- If your converted date lands after ' + today + ', you read it month-first - swap day and month.',
    '- A receipt dated today is completely normal. Never call a date a typo just for being recent.',
    '',
    '- description_en: short plain-English item name ("Bananas", "Chicken breast", "Oat milk 1L"). Translate Turkish;',
    ' expand abbreviations (SUT=milk, EKMEK=bread, YUMURTA=eggs, TAVUK GOGUS=chicken breast, PEYNIR=cheese).',
    '- original_text: the item text exactly as printed.',
    '- quantity & unit_price: "3 x 12,50" or "3 AD"/"ADET" -> quantity 3, unit_price 12.50.',
    ' Weighed items ("0,845 KG x 89,90") -> quantity = kg, unit_price = price per kg. No quantity shown -> 1.',
    '- line_total = the printed amount for that line.',
    '- Discounts/coupons (INDIRIM, KAMPANYA, discount) -> separate line with NEGATIVE unit_price so lines sum to amount paid.',
    '- Never list KDV/TOPKDV/VAT, subtotals, TOPLAM/TOTAL, PARA USTU (change) or payment lines as items.',
    '- Turkish numbers use comma decimals and dot thousands ("1.249,90" = 1249.90). Ignore "*" before prices.',
    '- currency: ISO code; TL or the lira symbol = TRY. Default TRY.',
    '- receipt_total: final amount paid (TOPLAM / GENEL TOPLAM / TOTAL).',
    '- receipt_number: the receipt\'s own number (FİŞ NO, FIS NO, Belge No, Receipt #, Order #), digits as printed. null if none.',
    '- receipt_time: the time printed on the receipt (SAAT), as HH:MM 24-hour. null if none.',
    '- payment_method: "Card" (KREDI KARTI, BANKA KARTI, temassiz), "Cash" (NAKIT), or null.',
    '- category: best fit from: ' + cats.join(', '),
    ' supermarket food -> Groceries; restaurants/delivery -> Eating Out; cafe drinks, bakery, vending -> Coffee & Snacks;',
    ' protein/creatine/vitamins/electrolytes -> Supplements & Nutrition; taxi/fuel/bus -> Transport;',
    ' pharmacy/toiletries -> Personal Care & Pharmacy; cleaning/kitchen -> Household. Categorise each line separately.',
    '- If anything is unreadable or guessed, explain in notes and set confidence low/medium.',
    '- Not a receipt -> empty items and explain in notes.'
  ].join('\n');
}

function toolSchema_(cats) {
  return {
    name: 'record_receipt', description: 'Record the structured contents of one receipt.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false,
      required: ['merchant', 'date', 'date_printed', 'receipt_number', 'receipt_time', 'currency', 'payment_method', 'items',
                 'receipt_total', 'confidence', 'notes'],
      properties: {
        merchant: { type: 'string' },
        date: { type: ['string', 'null'], description: 'YYYY-MM-DD, converted day-first from the printed date' },
        date_printed: { type: ['string', 'null'], description: 'the date exactly as printed on the receipt' },
        receipt_number: { type: ['string', 'null'], description: 'FIS NO / receipt number as printed' },
        receipt_time: { type: ['string', 'null'], description: 'time printed on the receipt, HH:MM' },
        currency: { type: 'string' },
        payment_method: { type: ['string', 'null'] }, receipt_total: { type: ['number', 'null'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, notes: { type: ['string', 'null'] },
        items: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['original_text', 'description_en', 'category', 'quantity', 'unit_price', 'line_total'],
          properties: { original_text: { type: 'string' }, description_en: { type: 'string' },
            category: { type: 'string', enum: cats }, quantity: { type: 'number' },
            unit_price: { type: 'number' }, line_total: { type: 'number' } } } }
      } }
  };
}

// ------------------------------------------------------------------ sheet writing
// All of a receipt's rows go in with a handful of range writes, however many items it has.
function writeReceipt_(ws, data, rid, cats, fx, oldName, mime, possibleDup) {
  const items = data.items || [];
  if (!items.length) throw new Error('No items (' + (data.notes || 'not a receipt?') + ')');
  const flags = [];
  let date = resolveDate_(data, flags);
  if (!date) { date = new Date(); date.setHours(0, 0, 0, 0); flags.push('DATE GUESSED'); }
  const sum = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
  const total = Number(data.receipt_total || 0);
  if (total && Math.abs(sum - total) > Math.max(0.5, TOTAL_TOLERANCE * total))
    flags.push('ITEMS ' + sum.toFixed(2) + ' != TOTAL ' + total.toFixed(2));
  if (data.confidence === 'low' || data.confidence === 'medium') flags.push(data.confidence.toUpperCase() + ' CONFIDENCE');
  const cur0 = String(data.currency || DEFAULT_CURRENCY).toUpperCase().trim();
  const cur = (cur0 === 'TL' ? 'TRY' : cur0);
  if (fx && fx.length && fx.indexOf(cur) === -1) flags.push('NO FX RATE FOR ' + cur);
  if (possibleDup) {
    const g = possibleDup.group;
    flags.push('POSSIBLE DUPLICATE of rows ' + g.rows[0] + '-' + g.rows[g.rows.length - 1] +
               ' (same shop, date and total) - delete these rows if it is the same receipt');
  }
  if (data.notes && flags.length) flags.push(String(data.notes).slice(0, 120));
  const flag = flags.join(' | ');
  const serial = dateSerial_(date);
  const fileName = ymd_(date) + '_' + safe_(data.merchant) + '_' + rid.slice(-6) + ext_(oldName || '', mime);
  const tag = tagText_(receiptNo_(data.receipt_number), receiptTime_(data.receipt_time));

  const first = nextEmptyRow_(ws), n = items.length;
  ws.getRange(first, COL.date, n, 7).setValues(items.map(it => {
    const qty = Number(it.quantity || 1);
    const unit = it.unit_price != null ? Number(it.unit_price) : Number(it.line_total || 0);
    return [serial, data.merchant || '', it.description_en || '', it.original_text || '',
            cats.indexOf(it.category) > -1 ? it.category : 'Other',
            Math.round(qty * 1000) / 1000, Math.round(unit * 100) / 100];
  }));
  ws.getRange(first, COL.line, n, 1).setFormulas(items.map((_, k) => [lineFormula_(first + k)]));
  ws.getRange(first, COL.currency, n, 1).setValues(items.map(() => [cur]));
  ws.getRange(first, COL.aud, n, 1).setFormulas(items.map((_, k) => [audFormula_(first + k)]));
  ws.getRange(first, COL.payment, n, 5).setValues(items.map(() => [data.payment_method || '', fileName, rid, flag, tag]));
  ws.getRange(first, COL.date, n, 1).setNumberFormat('dd mmm yyyy');
  const head = ws.getRange(1, COL.tag);
  if (!head.getValue()) head.setValue('Receipt No / Time');
  return { date: date, count: n, firstRow: first, currency: cur, flag: flag, fileName: fileName };
}

function nextEmptyRow_(ws) {
  const last = Math.max(ws.getLastRow(), 2);
  const vals = ws.getRange(2, 1, last - 1, 3).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] !== '' || vals[i][2] !== '') return i + 3;
  }
  return 2;
}

function existingIds_(ws) {
  const last = ws.getLastRow();
  if (last < 2) return new Set();
  return new Set(ws.getRange(2, COL.id, last - 1, 1).getValues().map(r => String(r[0])).filter(String));
}

function readCategories_(ss) {
  const v = ss.getSheetByName('Settings').getRange('A19:A38').getValues().map(r => String(r[0]).trim()).filter(String);
  return v.length ? v : ['Other'];
}

// Day first, always. Nothing in this workbook is ever read month-first.
function parseDate_(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})[.\/\- ](\d{1,2})[.\/\- ](\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]); }
  return null;
}

function fingerprint_(file) {
  const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '?fields=md5Checksum',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  const md5 = r.getResponseCode() === 200 ? JSON.parse(r.getContentText()).md5Checksum : null;
  return (md5 || file.getId()).slice(0, 12);
}

function safe_(s) { return (String(s || 'receipt').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)) || 'receipt'; }
function ext_(name, mime) { const m = name.match(/\.[A-Za-z0-9]+$/); return m ? m[0].toLowerCase() : (mime === 'application/pdf' ? '.pdf' : '.jpg'); }

// ------------------------------------------------------------------ shared formula templates
function lineFormula_(r) {
  return '=IF(G' + r + '="","",IF(F' + r + '="",1,F' + r + ')*G' + r + ')';
}

// AUD = line total x FX rate. TRY uses the month-specific rate in Settings!E:F when one is
// filled in, otherwise the base rate in Settings!A:B. Unknown currency -> "no FX rate".
function audFormula_(r) {
  return '=IF(H' + r + '="","",LET(' +
    'c,IF(I' + r + '="","TRY",I' + r + '),' +
    'base,IFERROR(INDEX(Settings!$B$10:$B$17,MATCH(c,Settings!$A$10:$A$17,0)),""),' +
    'mth,IFERROR(MATCH(DATE(YEAR(A' + r + '),MONTH(A' + r + '),1),Settings!$E$10:$E$21,0),0),' +
    'col,IFERROR(MATCH(c,Settings!$F$9:$H$9,0),0),' +
    'ov,IF(OR(mth=0,col=0),"",IFERROR(INDEX(Settings!$F$10:$H$21,mth,col),"")),' +
    'rate,IF(N(ov)>0,ov,base),' +
    'IF(N(rate)>0,H' + r + '*rate,"no FX rate")))';
}

function readFxCurrencies_(ss) {
  return ss.getSheetByName('Settings').getRange('A10:A17').getValues()
    .map(r => String(r[0]).trim().toUpperCase()).filter(String);
}

// Timezone-proof: writes the date as a plain serial number, never a timestamp.
function serialYMD_(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569; }
function dateSerial_(d) { return serialYMD_(d.getFullYear(), d.getMonth() + 1, d.getDate()); }

// ================================================================== one-off maintenance
// Re-applies every formula, range and label in the workbook to the current design.
// Safe to re-run at any time.
function applyFixes() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const log = [];
  try {
    const ss = ss_();
    const ws = ss.getSheetByName('Expenses');
    const dash = ss.getSheetByName('Dashboard');
    const daily = ss.getSheetByName('Daily');
    const mon = ss.getSheetByName('Monthly');
    const cfg = ss.getSheetByName('Settings');
    const how = ss.getSheetByName('How It Works');
    const LAST = 5000, FORM = 2000;
    log.push('timezone sheet=' + ss.getSpreadsheetTimeZone() + ' script=' + Session.getScriptTimeZone());

    // --- Settings: monthly FX override table + honest labels
    const yellow = cfg.getRange('B10').getBackground();
    const baseRate = cfg.getRange('B10').getValue();
    cfg.getRange('C6').setValue('Display label only - the FX table below does the actual conversion.');
    cfg.getRange('E9:G9').setValues([['Month start', 'AUD per TRY', 'Rate used for that month. Blank = use the base rate above.']]);
    cfg.getRange('E9:G9').setFontWeight('bold');
    const start = new Date(cfg.getRange('B4').getValue());
    const eVals = [], fVals = [];
    for (let i = 0; i < 12; i++) {
      const y = start.getFullYear() + Math.floor((start.getMonth() + i) / 12);
      const m = (start.getMonth() + i) % 12 + 1;
      eVals.push([serialYMD_(y, m, 1)]);
      fVals.push([i === 0 ? baseRate : '']);
    }
    cfg.getRange(10, 5, 12, 1).setValues(eVals).setNumberFormat('dd mmm yyyy');
    cfg.getRange(10, 6, 12, 1).setValues(fVals).setNumberFormat('0.0000');
    cfg.getRange('F10:F21').setBackground(yellow);
    cfg.getRange('C12').setValue('Add EUR / USD / GBP in rows 12-17 if you pay in them.');
    writeFxTable_(cfg, start);
    log.push('settings: live monthly FX table written at E9:I21');

    // --- Expenses: strip hidden timestamps from the date column
    const colC = ws.getRange(2, 3, 3000, 1).getValues();
    let n = 0;
    for (let i = 0; i < colC.length; i++) if (String(colC[i][0]).trim() !== '') n = i + 1;
    if (n > 0) {
      const tmp = ws.getRange(2, 20, n, 1);
      const f = [];
      for (let r = 2; r < 2 + n; r++) f.push(['=IF(A' + r + '="","",INT(A' + r + '))']);
      tmp.setFormulas(f);
      SpreadsheetApp.flush();
      const ints = tmp.getValues();
      tmp.clearContent();
      ws.getRange(2, 1, n, 1).setValues(ints).setNumberFormat('dd mmm yyyy');
      log.push('dates normalised on ' + n + ' rows');
    }

    // --- Expenses: refresh line total + AUD formulas
    const hF = [], jF = [];
    for (let r = 2; r <= FORM; r++) { hF.push([lineFormula_(r)]); jF.push([audFormula_(r)]); }
    ws.getRange(2, COL.line, FORM - 1, 1).setFormulas(hF);
    ws.getRange(2, COL.aud, FORM - 1, 1).setFormulas(jF);
    log.push('line-total and AUD formulas refreshed to row ' + FORM);

    // --- Expenses: back-solved unit prices become plain numbers, and get flagged
    if (n > 0) {
      const gF = ws.getRange(2, COL.unit, n, 1).getFormulas();
      let fixed = 0;
      for (let i = 0; i < n; i++) {
        if (gF[i][0]) {
          const r = i + 2;
          const cell = ws.getRange(r, COL.unit);
          cell.setValue(cell.getValue());
          const fl = ws.getRange(r, COL.flag);
          if (!String(fl.getValue()).trim()) fl.setValue('CHECK: unit price was back-solved from a total - confirm Qty is a count, not kg');
          fixed++;
        }
      }
      log.push('back-solved unit prices converted to numbers: ' + fixed);
    }

    // --- Expenses: highlighting and dropdowns out to row 5000
    ws.setConditionalFormatRules(ws.getConditionalFormatRules().map(function (rule) {
      return rule.copy().setRanges([ws.getRange(2, 1, LAST - 1, 14)]).build();
    }));
    ws.getRange(2, COL.category, LAST - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(cfg.getRange('A19:A38'), true).setAllowInvalid(true).build());
    ws.getRange(2, COL.currency, LAST - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(cfg.getRange('A10:A17'), true).setAllowInvalid(true).build());
    log.push('formatting and dropdowns extended to row ' + LAST);

    // --- Dashboard
    dash.getRange('A2').setFormula('="Season "&TEXT(SeasonStart,"d mmm yyyy")&" - "&TEXT(SeasonEnd,"d mmm yyyy")&"  .  all figures "&Settings!$B$6');
    dash.getRange('B10').setFormula('=SUMIFS(Expenses!$J:$J,Expenses!$A:$A,">="&(TODAY()-6),Expenses!$A:$A,"<"&(TODAY()+1))');
    dash.getRange('C10').setValue('Rolling 7 days, including today');
    dash.getRange('A11').setValue('Receipts logged');
    dash.getRange('B11').setFormula('=IFERROR(COUNTA(UNIQUE(FILTER(Expenses!$M$2:$M$' + LAST + ',Expenses!$M$2:$M$' + LAST + '<>""))),0)');
    dash.getRange('C11').setValue('Unique Receipt IDs - scanned receipts plus manual batches');
    dash.getRange('B12').setFormula('=COUNTA(Expenses!$C$2:$C$' + LAST + ')');
    dash.getRange('B13').setFormula('=COUNTIF(Expenses!$N$2:$N$' + LAST + ',"?*")');
    dash.getRange('B16').setFormula('="Total ("&Settings!$B$6&")"');
    log.push('dashboard formulas updated');

    // --- Daily headers follow the reporting currency
    daily.getRange('C1').setFormula('="Spend ("&Settings!$B$6&")"');
    daily.getRange('E1').setFormula('="7-day avg ("&Settings!$B$6&")"');
    daily.getRange('F1').setFormula('="Season to date ("&Settings!$B$6&")"');

    // --- Monthly: months outside the season stay blank instead of showing zero
    const cols = ['B','C','D','E','F','G','H','I','J','K','L','M'];
    for (let i = 1; i < cols.length; i++) {
      const c = cols[i], p = cols[i - 1];
      mon.getRange(c + '3').setFormula('=IF(OR(' + p + '$3="",EDATE(' + p + '$3,1)>SeasonEnd),"",EDATE(' + p + '$3,1))');
    }
    for (const c of cols) {
      const f = [];
      for (let r = 4; r <= 23; r++) {
        f.push(['=IF(OR($A' + r + '="",' + c + '$3=""),"",SUMIFS(Expenses!$J:$J,Expenses!$E:$E,$A' + r + ',Expenses!$A:$A,">="&' + c + '$3,Expenses!$A:$A,"<"&EDATE(' + c + '$3,1)))']);
      }
      mon.getRange(c + '4:' + c + '23').setFormulas(f);
      mon.getRange(c + '24').setFormula('=IF(' + c + '$3="","",SUM(' + c + '4:' + c + '23))');
      mon.getRange(c + '25').setFormula('=IF(' + c + '$3="","",MAX(0,MIN(EDATE(' + c + '$3,1)-1,TODAY(),SeasonEnd)-MAX(' + c + '$3,SeasonStart)+1))');
      mon.getRange(c + '26').setFormula('=IF(OR(' + c + '25="",' + c + '25=0),"",' + c + '24/' + c + '25)');
      mon.getRange(c + '27').setFormula('=IF(OR(' + c + '25="",' + c + '25=0),"",' + c + '24/' + c + '25*7)');
    }
    mon.getRange('A1').setFormula('="Monthly spend by category ("&Settings!$B$6&")"');
    mon.getRange('N26').setFormula('=IF(OR(N25="",N25=0),"",N24/N25)');
    mon.getRange('N27').setFormula('=IF(OR(N25="",N25=0),"",N24/N25*7)');
    log.push('monthly out-of-season guards applied');

    // --- Charts: the pie must cover every category slot
    try {
      const charts = dash.getCharts();
      charts.forEach(function (c) {
        let b = c.modify();
        c.getRanges().forEach(function (rg) { b = b.removeRange(rg); });
        b = b.addRange(dash.getRange('A17:B36'));
        dash.updateChart(b.build());
      });
      log.push('dashboard charts re-ranged: ' + charts.length);
    } catch (e) { log.push('chart update failed: ' + e.message); }

    // --- How It Works: describe the workflow that actually runs
    how.getRange('A3:A12').clearContent();
    how.getRange('A3:A12').setValues([
      ['1. Open the Receipt Scanner app and point it at the receipt - it takes the photo and uploads it. (Or share a photo into the Receipts Inbox folder.)'],
      ['2. App scans are read straight away. Shared photos are picked up within 10 minutes (Receipts menu > Scan inbox now to hurry it).'],
      ['3. Claude reads the receipt, translates Turkish and splits it into line items on the Expenses tab.'],
      ['4. The photo is renamed and moved to Receipts Processed. Anything unreadable goes to Receipts Failed, with the reason in its Drive description.'],
      ['5. Dashboard, Daily and Monthly update themselves. Nothing to open or close.'],
      [''],
      ['Manual entry works too: type into the next empty row. Line Total and Total (AUD) fill themselves.'],
      ['Discounts are negative Unit Price rows, so a receipt still sums to what you paid.'],
      ['Weighed items (kg): Qty = weight, Unit Price = price per kg.'],
      ['Red rows carry a note in the Flag column. Clear the flag once you have checked the row.']
    ]);
    log.push('how it works rewritten');

    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  const out = log.join(' | ');
  console.log(out);
  return out;
}

// ------------------------------------------------------------------ one-off date repair
// Rows written by the scanner before the timezone fix were stored one day early
// (script ran on Istanbul time, sheet reads Los Angeles time). Shifts them forward one day.
// Manually typed rows (Receipt ID starting 'manual') are left alone. Runs once.
function fixScannerDates() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DATES_SHIFTED_V1')) return 'already applied';
  const ws = ss_().getSheetByName('Expenses');
  const colC = ws.getRange(2, 3, 3000, 1).getValues();
  let n = 0;
  for (let i = 0; i < colC.length; i++) if (String(colC[i][0]).trim() !== '') n = i + 1;
  if (!n) return 'no data rows';
  const ids = ws.getRange(2, COL.id, n, 1).getValues();
  const tmp = ws.getRange(2, 20, n, 1);
  const f = [];
  for (let r = 2; r < 2 + n; r++) f.push(['=IF(A' + r + '="","",INT(A' + r + '))']);
  tmp.setFormulas(f);
  SpreadsheetApp.flush();
  const serials = tmp.getValues();
  tmp.clearContent();
  let moved = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = String(ids[i][0]).trim().toLowerCase();
    const s = serials[i][0];
    if (typeof s === 'number' && s > 0 && id && id.indexOf('manual') !== 0) { out.push([s + 1]); moved++; }
    else out.push([s]);
  }
  ws.getRange(2, COL.date, n, 1).setValues(out).setNumberFormat('dd mmm yyyy');
  SpreadsheetApp.flush();
  props.setProperty('DATES_SHIFTED_V1', new Date().toISOString());
  const msg = 'rows checked ' + n + ', scanner rows shifted +1 day: ' + moved;
  console.log(msg);
  return msg;
}

// Re-points the Dashboard charts at the full category block.
function fixCharts() {
  const dash = ss_().getSheetByName('Dashboard');
  const strays = ['Dashboard!A33:A36', 'Dashboard!B33:B36'];
  const notes = [];
  dash.getCharts().forEach(function (c, idx) {
    const rs = c.getRanges().map(function (r) { return { r: r, a1: r.getSheet().getName() + '!' + r.getA1Notation() }; });
    const names = rs.map(function (x) { return x.a1; });
    const isCategoryPie = names.indexOf('Dashboard!A16:A32') > -1;
    if (isCategoryPie) { notes.push('chart ' + idx + ' pie kept [' + names.join(',') + ']'); return; }
    let b = c.modify(); let changed = false;
    rs.forEach(function (x) { if (strays.indexOf(x.a1) > -1) { b = b.removeRange(x.r); changed = true; } });
    if (!changed) { notes.push('chart ' + idx + ' clean'); return; }
    try { dash.updateChart(b.build()); notes.push('chart ' + idx + ' strays removed'); }
    catch (e) { notes.push('chart ' + idx + ' FAILED: ' + e.message); }
  });
  const msg = notes.join(' || ');
  console.log(msg);
  return msg;
}


// ================================================================== day-first dates + live FX
// Picks the receipt date day-first and refuses to accept a month-first reading of it.
function resolveDate_(data, flags) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const printed = parseDate_(data.date_printed);
  const d = printed || parseDate_(data.date);
  if (!d) return null;
  const swapped = swapDayMonth_(d);
  if (d.getTime() > today.getTime() && swapped && swapped.getTime() <= today.getTime()) {
    flags.push('DATE SWAPPED TO DAY-FIRST');
    return swapped;
  }
  const ss0 = seasonStart_();
  if (ss0 && d.getTime() < ss0.getTime() && swapped &&
      swapped.getTime() >= ss0.getTime() && swapped.getTime() <= today.getTime()) {
    flags.push('DATE SWAPPED TO DAY-FIRST');
    return swapped;
  }
  return d;
}
function swapDayMonth_(d) {
  const D = d.getDate();
  if (D > 12) return null;
  return new Date(d.getFullYear(), D - 1, d.getMonth() + 1);
}
function seasonStart_() {
  try {
    const v = ss_().getSheetByName('Settings').getRange('B4').getValue();
    return v instanceof Date ? v : null;
  } catch (e) { return null; }
}

// Monthly FX table that fills itself from live market rates. No month ever needs typing in.
function writeFxTable_(cfg, start) {
  const s = new Date(start);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const y = s.getFullYear() + Math.floor((s.getMonth() + i) / 12);
    const mm = (s.getMonth() + i) % 12 + 1;
    months.push([serialYMD_(y, mm, 1)]);
  }
  cfg.getRange('E9:I9').setValues([['Month start', 'TRY', 'USD', 'EUR',
    'Fills itself: that month average vs AUD, live from Google Finance. Type over a cell to pin your own rate.']]);
  cfg.getRange('E9:H9').setFontWeight('bold');
  cfg.getRange('I9').setFontWeight('normal').setFontStyle('italic');
  cfg.getRange(10, 5, 12, 1).setValues(months).setNumberFormat('dd mmm yyyy');
  const f = [];
  for (let r = 10; r <= 21; r++) {
    const row = [];
    ['F', 'G', 'H'].forEach(function (c) {
      row.push('=IF(OR($E' + r + '="",$E' + r + '>TODAY()),"",IFERROR(AVERAGE(INDEX(GOOGLEFINANCE("CURRENCY:"&' + c +
        '$9&"AUD","price",$E' + r + ',MIN(EOMONTH($E' + r + ',0),TODAY())),,2)),IFERROR(GOOGLEFINANCE("CURRENCY:"&' + c + '$9&"AUD"),"")))');
    });
    f.push(row);
  }
  cfg.getRange(10, 6, 12, 3).setFormulas(f).setNumberFormat('0.000000');
  cfg.getRange('F10:H21').setBackground(null);
  cfg.getRange('B10').setFormula('=IFERROR(GOOGLEFINANCE("CURRENCY:TRYAUD"),0.0303)').setNumberFormat('0.000000');
  cfg.getRange('B12').setFormula('=IFERROR(GOOGLEFINANCE("CURRENCY:USDAUD"),1.4362)').setNumberFormat('0.0000');
  cfg.getRange('C10').setValue('Live spot rate, fallback only - the monthly table at right drives the conversion.');
  cfg.getRange('C12').setValue('Live spot rate. Add EUR / GBP in rows 13-17 if you ever pay in them.');
}

// One and done: Australian locale, day-first dates everywhere, live FX, and repair of any
// row that was logged month-first. Safe to re-run.
function applyAuAndLiveFx() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const out = [];
  try {
    const ss = ss_();
    const cfg = ss.getSheetByName('Settings');
    const ws = ss.getSheetByName('Expenses');
    const daily = ss.getSheetByName('Daily');
    out.push('was locale=' + ss.getSpreadsheetLocale() + ' tz=' + ss.getSpreadsheetTimeZone());
    ss.setSpreadsheetLocale('en_AU');
    ss.setSpreadsheetTimeZone('Europe/Istanbul');
    out.push('now locale=' + ss.getSpreadsheetLocale() + ' tz=' + ss.getSpreadsheetTimeZone());

    writeFxTable_(cfg, cfg.getRange('B4').getValue());
    out.push('FX table live');

    ws.getRange(2, COL.date, 4999, 1).setNumberFormat('dd mmm yyyy');
    daily.getRange(2, 1, 400, 1).setNumberFormat('dd mmm yyyy');
    cfg.getRange('B4:B5').setNumberFormat('dd mmm yyyy');
    out.push('date columns dd mmm yyyy');

    const seasonStart = cfg.getRange('B4').getValue();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const last = Math.max(ws.getLastRow(), 2);
    const vals = ws.getRange(2, 1, last - 1, 14).getValues();
    let fixed = 0;
    for (let i = 0; i < vals.length; i++) {
      const d = vals[i][COL.date - 1];
      if (!(d instanceof Date)) continue;
      if (d.getTime() >= seasonStart.getTime() && d.getTime() <= today.getTime()) continue;
      const sw = swapDayMonth_(d);
      if (!sw || sw.getTime() < seasonStart.getTime() || sw.getTime() > today.getTime()) continue;
      const r = i + 2;
      ws.getRange(r, COL.date).setValue(serialYMD_(sw.getFullYear(), sw.getMonth() + 1, sw.getDate()))
        .setNumberFormat('dd mmm yyyy');
      ws.getRange(r, COL.flag).setValue('');
      const oldName = String(vals[i][COL.file - 1] || '');
      const mm = oldName.match(/^\d{4}-\d{2}-\d{2}(_.*)$/);
      if (mm) {
        const newName = Utilities.formatDate(sw, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') + mm[1];
        try {
          const fid = PropertiesService.getScriptProperties().getProperty('folder_processed');
          const it = DriveApp.getFolderById(fid).getFilesByName(oldName);
          if (it.hasNext()) it.next().setName(newName);
          ws.getRange(r, COL.file).setValue(newName);
        } catch (e) { out.push('rename failed row ' + r + ': ' + e.message); }
      }
      fixed++;
      out.push('row ' + r + ' -> ' + Utilities.formatDate(sw, ss.getSpreadsheetTimeZone(), 'dd MMM yyyy'));
    }
    out.push('rows repaired: ' + fixed);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  const msg = out.join(' | ');
  console.log(msg);
  return msg;
}
