'use strict';

const { google } = require('googleapis');
const db = require('../database');

const SHEET_INCOME  = 'PAJAMOS 2026';
const SHEET_EXPENSE = 'IŠLAIDOS 2026';

const CRM_CATEGORIES = [
  'Pardavimai', 'Žaliavos', 'Nuoma', 'Reklama',
  'Transportas', 'Darbo užmokestis', 'Komisiniai', 'Kita',
];

const CATEGORY_MAP = {
  pardavimai: 'Pardavimai',
  pajamos: 'Pardavimai',
  income: 'Pardavimai',
  b2b: 'Pardavimai',
  wc: 'Pardavimai',
  woocommerce: 'Pardavimai',
  žaliavos: 'Žaliavos',
  zaliavos: 'Žaliavos',
  materials: 'Žaliavos',
  materialai: 'Žaliavos',
  žaliava: 'Žaliavos',
  nuoma: 'Nuoma',
  rent: 'Nuoma',
  reklama: 'Reklama',
  ads: 'Reklama',
  advertising: 'Reklama',
  transportas: 'Transportas',
  transport: 'Transportas',
  pristatymas: 'Transportas',
  'darbo užmokestis': 'Darbo užmokestis',
  'darbo uzmokestis': 'Darbo užmokestis',
  atlyginimai: 'Darbo užmokestis',
  atlyginimas: 'Darbo užmokestis',
  salary: 'Darbo užmokestis',
  darbuotojai: 'Darbo užmokestis',
  komisiniai: 'Komisiniai',
  commission: 'Komisiniai',
  kita: 'Kita',
  other: 'Kita',
  kitos: 'Kita',
};

function isConfigured() {
  return !!(
    getSheetId() &&
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  );
}

function getSheetId() {
  return process.env.GOOGLE_SHEET_ID || '1C3CVJq28KZcFsm9mosNTZD9lmXgu5d__yu5Yu-Zghrw';
}

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key   = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google service account credentials not configured');

  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Excel serial → YYYY-MM-DD; also ISO and DD.MM.YYYY strings from Sheets */
function parseDateCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;

  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;

  if (n >= 1 && n < 100000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  return null;
}

function excelSerialToDate(serial) {
  return parseDateCell(serial);
}

function mapCategory(tipas, entryType) {
  const raw = String(tipas || '').trim();
  if (!raw) return entryType === 'income' ? 'Pardavimai' : 'Kita';

  if (CRM_CATEGORIES.includes(raw)) return raw;

  const key = raw.toLowerCase();
  if (CATEGORY_MAP[key]) return CATEGORY_MAP[key];

  for (const [pattern, cat] of Object.entries(CATEGORY_MAP)) {
    if (key.includes(pattern)) return cat;
  }

  return entryType === 'income' ? 'Pardavimai' : 'Kita';
}

function mapStoreId(tipas) {
  const t = String(tipas || '').toLowerCase();
  if (t.includes('b2b')) return 'bloom_lt';
  if (t.includes('dk') || t.includes('danija')) return 'mossbloom_dk';
  if (t.includes('de') || t.includes('vokiet')) return 'mossbloom_de';
  if (t.includes('lt') || t.includes('bloom')) return 'bloom_lt';
  return '';
}

function slug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9ąčęėįšųūž-]/gi, '')
    .slice(0, 48) || 'na';
}

function referenceId(sheetKey, entryType, entryDate, amount, tipas) {
  const cents = Math.round(Math.abs(amount) * 100);
  return `gs-${sheetKey}-${entryType}-${entryDate}-${cents}-${slug(tipas)}`;
}

function normalizeHeader(cell) {
  return String(cell || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Detect header row and column indices (TRANSAKCIJOS DATA, SUMA, TIPAS, SF, PASTABA) */
function detectColumns(rows) {
  const defaultCols = { date: 0, amount: 1, tipas: 2, invoice: 3, note: 4, headerRow: -1 };

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const cells = row.map(normalizeHeader);
    const hasDate   = cells.some(c => c.includes('transakcijos') || c === 'data' || c.includes('data'));
    const hasAmount = cells.some(c => c === 'suma' || c.includes('suma'));
    const hasTipas   = cells.some(c => c === 'tipas' || c.includes('tipas'));

    if (hasDate && (hasAmount || hasTipas)) {
      const cols = { ...defaultCols, headerRow: i };
      cells.forEach((c, idx) => {
        if (c.includes('transakcijos') || (c.includes('data') && !c.includes('pastaba'))) cols.date = idx;
        else if (c === 'suma' || c.startsWith('suma')) cols.amount = idx;
        else if (c === 'tipas' || c.startsWith('tipas')) cols.tipas = idx;
        else if (c === 'sf' || c.startsWith('sf')) cols.invoice = idx;
        else if (c.includes('pastaba') || c.includes('note')) cols.note = idx;
      });
      return cols;
    }
  }

  return defaultCols;
}

function isHeaderRow(cols, colMap, rowIndex) {
  if (rowIndex === colMap.headerRow) return true;
  const c0 = normalizeHeader(cols[colMap.date]);
  const c1 = normalizeHeader(cols[colMap.amount]);
  if (c0.includes('transakcijos') || (c0.includes('data') && c1 === 'suma')) return true;
  if (c1 === 'suma' && normalizeHeader(cols[colMap.tipas]) === 'tipas') return true;
  return false;
}

function parseAmount(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-') || s.startsWith('−') || s.startsWith('–')) {
    negative = true;
    s = s.slice(1);
  }

  s = s.replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }

  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n === 0) return null;

  return Math.abs(n);
}

function buildDescription(tipas, note, invoice) {
  const parts = [];
  if (tipas) parts.push(String(tipas).trim());
  if (note)  parts.push(String(note).trim());
  const base = parts.join(' — ') || 'Google Sheets';
  if (invoice && String(invoice).trim()) {
    const inv = String(invoice).trim();
    if (/^(taip|yes|1|true|sf|✓)$/i.test(inv)) return base;
    return `${base} (SF: ${inv})`;
  }
  return base;
}

function buildNotes(invoice, note) {
  const bits = [];
  if (invoice && /^(taip|yes|1|true|sf|✓)$/i.test(String(invoice).trim())) {
    bits.push('SF išrašyta');
  }
  if (note && !bits.some(b => b.includes(note))) bits.push(String(note).trim());
  return bits.join(' · ');
}

function processRows(rows, entryType, sheetKey, logPrefix) {
  const insertStmt = db.prepare(`
    INSERT INTO accounting_entries
      (type, source, store_id, reference_id, description, amount, currency, entry_date, category, notes)
    VALUES (?, 'google_sheets', ?, ?, ?, ?, 'EUR', ?, ?, ?)
  `);

  const existsStmt = db.prepare(`
    SELECT id FROM accounting_entries WHERE source = 'google_sheets' AND reference_id = ?
  `);

  const colMap = detectColumns(rows);
  const dataRows = rows.filter((_, i) => i !== colMap.headerRow && i > colMap.headerRow);

  console.log(`${logPrefix} column map:`, JSON.stringify(colMap));
  console.log(`${logPrefix} raw rows from API (${rows.length} total, ${dataRows.length} data rows):`);
  rows.forEach((row, i) => {
    console.log(`${logPrefix}   [${i}]`, JSON.stringify(row));
  });

  let added = 0, skipped = 0, errors = 0;
  const errorSamples = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;
    if (isHeaderRow(row, colMap, i)) {
      console.log(`${logPrefix} row ${i}: skip header`);
      continue;
    }

    const rawDate   = row[colMap.date];
    const rawAmount = row[colMap.amount];
    const tipas     = row[colMap.tipas];
    const invoice   = row[colMap.invoice];
    const note      = row[colMap.note];

    const entryDate = parseDateCell(rawDate);
    const amount    = parseAmount(rawAmount);

    if (!entryDate || amount == null) {
      errors++;
      if (errorSamples.length < 8) {
        errorSamples.push({ row: i, rawDate, rawAmount, tipas, reason: !entryDate ? 'bad_date' : 'bad_amount' });
      }
      console.log(`${logPrefix} row ${i}: PARSE ERROR`, { rawDate, rawAmount, tipas, entryDate, amount });
      continue;
    }

    const category = mapCategory(tipas, entryType);
    const storeId  = entryType === 'income' ? mapStoreId(tipas) : '';
    const ref      = referenceId(sheetKey, entryType, entryDate, amount, tipas);

    if (existsStmt.get(ref)) {
      skipped++;
      console.log(`${logPrefix} row ${i}: skip duplicate ref=${ref}`);
      continue;
    }

    const description = buildDescription(tipas, note, invoice);
    insertStmt.run(
      entryType,
      storeId,
      ref,
      description,
      amount,
      entryDate,
      category,
      buildNotes(invoice, note),
    );
    added++;
    console.log(`${logPrefix} row ${i}: INSERTED`, {
      type: entryType,
      date: entryDate,
      amount,
      category,
      tipas,
      ref,
      description,
    });
  }

  if (errorSamples.length) {
    console.log(`${logPrefix} parse error samples:`, JSON.stringify(errorSamples));
  }

  return { added, skipped, errors, colMap };
}

function normalizeSheetTitle(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function listSheetTabs(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: getSheetId(),
    fields: 'sheets.properties.title',
  });
  return (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
}

function resolveTabName(tabs, preferred, keywords) {
  if (tabs.includes(preferred)) return preferred;

  const normPreferred = normalizeSheetTitle(preferred);
  const match = tabs.find(t => normalizeSheetTitle(t) === normPreferred);
  if (match) return match;

  const fuzzy = tabs.find(t => {
    const n = normalizeSheetTitle(t);
    return keywords.every(kw => n.includes(kw));
  });
  if (fuzzy) {
    console.log(`[sheets-sync] tab "${preferred}" → resolved as "${fuzzy}"`);
    return fuzzy;
  }

  return preferred;
}

async function readSheet(sheets, sheetName) {
  const range = `'${sheetName.replace(/'/g, "''")}'!A:E`;
  console.log(`[sheets-sync] GET range: ${range}`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range,
  });
  return res.data.values || [];
}

async function runSync() {
  if (!isConfigured()) {
    console.log('[sheets-sync] skipped — Google credentials not configured');
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  const auth   = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`[sheets-sync] reading spreadsheet ${getSheetId()}...`);

  const tabs = await listSheetTabs(sheets);
  console.log('[sheets-sync] available tabs:', JSON.stringify(tabs));

  const incomeTab  = resolveTabName(tabs, SHEET_INCOME,  ['pajamos', '2026']);
  const expenseTab = resolveTabName(tabs, SHEET_EXPENSE, ['islaidos', '2026']);

  console.log(`[sheets-sync] income tab: "${incomeTab}"`);
  console.log(`[sheets-sync] expense tab: "${expenseTab}"`);

  let incomeRows = [];
  let expenseRows = [];

  try {
    incomeRows = await readSheet(sheets, incomeTab);
    console.log(`[sheets-sync] PAJAMOS: read ${incomeRows.length} rows`);
  } catch (err) {
    console.error(`[sheets-sync] PAJAMOS read failed:`, err.message);
    throw err;
  }

  try {
    expenseRows = await readSheet(sheets, expenseTab);
    console.log(`[sheets-sync] IŠLAIDOS: read ${expenseRows.length} rows`);
  } catch (err) {
    console.error(`[sheets-sync] IŠLAIDOS read failed (tab="${expenseTab}"):`, err.message);
    console.error('[sheets-sync] tip: verify tab name matches exactly, including Š in IŠLAIDOS');
    throw err;
  }

  const income  = processRows(incomeRows,  'income',  'pajamos',  '[sheets-sync][PAJAMOS]');
  const expense = processRows(expenseRows, 'expense', 'islaidos', '[sheets-sync][IŠLAIDOS]');

  const result = {
    ok: true,
    incomeTab,
    expenseTab,
    income,
    expenses: expense,
    total: {
      added:   income.added   + expense.added,
      skipped: income.skipped + expense.skipped,
      errors:  income.errors  + expense.errors,
    },
  };

  console.log(
    `[sheets-sync] done — income +${income.added}/${income.skipped} skip (${income.errors} err), ` +
    `expenses +${expense.added}/${expense.skipped} skip (${expense.errors} err)`,
  );

  return result;
}

module.exports = { runSync, isConfigured, excelSerialToDate, mapCategory, parseDateCell, parseAmount };
