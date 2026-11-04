// Receipt rules shared by the server and its tests: how Claude is asked to read a receipt, how its
// answer becomes rows, and how a repeat of an already-logged receipt is recognised.
// Ported from the Google Apps Script back end (apps-script/Code.gs), which it must keep matching.
// Dates are plain calendar days, 'YYYY-MM-DD' strings, so no server timezone can move a receipt.
'use strict';

const TOTAL_TOLERANCE = 0.02;

// ---------------------------------------------------------------- calendar days
function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
function validDay(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();          // day 0 of next month = last day of this one
}
// Today in the given IANA timezone, as YYYY-MM-DD.
function todayIn(tz, now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now || new Date());
  const get = t => p.find(x => x.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n));
  return dayStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// Day first, always. Nothing here is ever read month-first.
function parseDay(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDay(+m[1], +m[2], +m[3]) ? dayStr(+m[1], +m[2], +m[3]) : null;
  m = t.match(/^(\d{1,2})[.\/\- ](\d{1,2})[.\/\- ](\d{2,4})/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return validDay(y, +m[2], +m[1]) ? dayStr(y, +m[2], +m[1]) : null;
  }
  return null;
}
function swapDayMonth(day) {
  const [y, m, d] = day.split('-').map(Number);
  if (d > 12 || !validDay(y, d, m)) return null;
  return dayStr(y, d, m);
}
// The receipt's day: day-first, and a month-first misreading is swapped back when the printed
// reading is impossible (after today) or falls before the season while the swap fits inside it.
function resolveDay(data, today, seasonStart, flags) {
  const d = parseDay(data.date_printed) || parseDay(data.date);
  if (!d) return null;
  const sw = swapDayMonth(d);
  if (d > today && sw && sw <= today) { flags.push('DATE SWAPPED TO DAY-FIRST'); return sw; }
  if (seasonStart && d < seasonStart && sw && sw >= seasonStart && sw <= today) { flags.push('DATE SWAPPED TO DAY-FIRST'); return sw; }
  return d;
}

// ---------------------------------------------------------------- what Claude is asked
function prompt(cats, today) {
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

function toolSchema(cats) {
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

// ---------------------------------------------------------------- Claude's answer -> a receipt
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

// Quantities and prices rounded the way the sheet stores them; line total = qty x unit price.
function itemRows(items, cats) {
  return (items || []).map((it, k) => {
    const qty = r3(Number(it.quantity || 1));
    const unit = r2(it.unit_price != null ? Number(it.unit_price) : Number(it.line_total || 0));
    return { line_no: k + 1, description: String(it.description_en || ''), original_text: String(it.original_text || ''),
             category: cats.indexOf(it.category) > -1 ? it.category : 'Other', qty: qty, unit_price: unit, line_total: r2(qty * unit) };
  });
}

function receiptNo(s) { return String(s || '').replace(/[^A-Za-z0-9]/g, '').replace(/^0+/, ''); }
function receiptTime(s) {
  const m = String(s || '').match(/(\d{1,2})[:.](\d{2})/);
  return m && +m[1] < 24 && +m[2] < 60 ? pad(+m[1]) + ':' + m[2] : '';
}
function currencyOf(data) {
  const c = String(data.currency || 'TRY').toUpperCase().trim();
  return c === 'TL' ? 'TRY' : c;
}

// Everything needed to store one read receipt, plus the flags a person should look at.
function buildReceipt(data, cats, today, seasonStart) {
  if (!(data.items || []).length) throw new Error('No items (' + (data.notes || 'not a receipt?') + ')');
  const flags = [];
  let day = resolveDay(data, today, seasonStart, flags);
  if (!day) { day = today; flags.push('DATE GUESSED'); }
  const items = itemRows(data.items, cats);
  const printedSum = (data.items || []).reduce((s, i) => s + Number(i.line_total || 0), 0);
  const total = Number(data.receipt_total || 0);
  if (total && Math.abs(printedSum - total) > Math.max(0.5, TOTAL_TOLERANCE * total))
    flags.push('ITEMS ' + printedSum.toFixed(2) + ' != TOTAL ' + total.toFixed(2));
  if (data.confidence === 'low' || data.confidence === 'medium') flags.push(data.confidence.toUpperCase() + ' CONFIDENCE');
  if (data.notes && flags.length) flags.push(String(data.notes).slice(0, 120));
  return {
    receipt_date: day, merchant: String(data.merchant || ''), currency: currencyOf(data),
    payment: data.payment_method || null, receipt_no: receiptNo(data.receipt_number) || null,
    receipt_time: receiptTime(data.receipt_time) || null, total: r2(items.reduce((s, i) => s + i.line_total, 0)),
    flags: flags.join(' | '), notes: data.notes || null, confidence: data.confidence || null, items: items
  };
}

// ---------------------------------------------------------------- is it one already logged?
function merchantKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0] || '';
}

// A receipt is "the same receipt" when its printed identity matches: same day and same receipt
// number, or same day, same printed time and same total. Same shop + day + total with nothing
// printed to tell them apart is a look-alike: the owner is asked. A different day never matches.
// `existing`: receipts on that day, as { id, receipt_date, merchant, total, receipt_no, receipt_time }.
// Returns { same: true, receipt } | { same: false, receipt } | null.
function matchReceipt(r, existing) {
  const mkey = merchantKey(r.merchant), no = receiptNo(r.receipt_no), time = receiptTime(r.receipt_time);
  let possible = null;
  for (const g of existing) {
    if (String(g.receipt_date).slice(0, 10) !== r.receipt_date) continue;
    const shop = !!mkey && merchantKey(g.merchant) === mkey;
    const gTotal = Number(g.total);
    const sameTotal = Math.abs(gTotal - r.total) <= Math.max(0.02, 0.002 * Math.abs(r.total));
    const gNo = receiptNo(g.receipt_no), gTime = receiptTime(g.receipt_time);
    if (no && gNo) { if (shop && no === gNo) return { same: true, receipt: g }; continue; }
    if (time && gTime) { if (shop && sameTotal && time === gTime) return { same: true, receipt: g }; continue; }
    if (shop && sameTotal && !possible) possible = { same: false, receipt: g };
  }
  return possible;
}

module.exports = { todayIn, addDays, parseDay, swapDayMonth, resolveDay, prompt, toolSchema, itemRows, buildReceipt,
                   merchantKey, receiptNo, receiptTime, matchReceipt, r2 };
