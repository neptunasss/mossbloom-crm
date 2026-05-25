'use strict';

const { google } = require('googleapis');
const db = require('../database');

const SHEET_INCOME  = 'PAJAMOS 2026';
const SHEET_EXPENSE = 'IŠLAIDOS 2026';

const CRM_CATEGORIES = [
  'Pardavimai', 'Žaliavos', 'Nuoma', 'Reklama',
  'Transportas', 'Darbo užmokestis', 'Komisiniai', 'Kita',
];

/** Map TIPAS / sheet labels → CRM category names */
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

function excelSerialToDate(serial) {
  const n = parseFloat(String(serial).replace(',', '.'));
  if (!Number.isFinite(n) || n < 1) return null;
  const d = new Date((n - 25569) * 86400 * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

function isHeaderRow(cols) {
  const first = String(cols[0] || '').toLowerCase();
  return first.includes('data') || first.includes('date') || first === 'data';
}

function parseAmount(raw, entryType) {
  const n = parseFloat(String(raw || '').replace(',', '.').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return entryType === 'expense' ? Math.abs(n) : Math.abs(n);
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

function processRows(rows, entryType, sheetKey) {
  const insertStmt = db.prepare(`
    INSERT INTO accounting_entries
      (type, source, store_id, reference_id, description, amount, currency, entry_date, category, notes)
    VALUES (?, 'google_sheets', ?, ?, ?, ?, 'EUR', ?, ?, ?)
  `);

  const existsStmt = db.prepare(`
    SELECT id FROM accounting_entries WHERE source = 'google_sheets' AND reference_id = ?
  `);

  let added = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    if (!row || row.length < 2) continue;
    if (isHeaderRow(row)) continue;

    const entryDate = excelSerialToDate(row[0]);
    const amount    = parseAmount(row[1], entryType);
    const tipas     = row[2];
    const invoice   = row[3];
    const note      = row[4];

    if (!entryDate || amount == null) {
      errors++;
      continue;
    }

    const category = mapCategory(tipas, entryType);
    const storeId  = entryType === 'income' ? mapStoreId(tipas) : '';
    const ref      = referenceId(sheetKey, entryType, entryDate, amount, tipas);

    if (existsStmt.get(ref)) {
      skipped++;
      continue;
    }

    insertStmt.run(
      entryType,
      storeId,
      ref,
      buildDescription(tipas, note, invoice),
      amount,
      entryDate,
      category,
      buildNotes(invoice, note),
    );
    added++;
  }

  return { added, skipped, errors };
}

async function readSheet(sheets, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: `'${sheetName}'!A:E`,
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

  console.log(`[sheets-sync] reading sheet ${getSheetId()}...`);

  const incomeRows  = await readSheet(sheets, SHEET_INCOME);
  const expenseRows = await readSheet(sheets, SHEET_EXPENSE);

  const income  = processRows(incomeRows,  'income',  'pajamos');
  const expense = processRows(expenseRows, 'expense', 'islaidos');

  const result = {
    ok: true,
    income,
    expenses: expense,
    total: {
      added:   income.added   + expense.added,
      skipped: income.skipped + expense.skipped,
      errors:  income.errors  + expense.errors,
    },
  };

  console.log(
    `[sheets-sync] done — income +${income.added}/${income.skipped} skip, ` +
    `expenses +${expense.added}/${expense.skipped} skip, ${result.total.errors} parse errors`,
  );

  return result;
}

module.exports = { runSync, isConfigured, excelSerialToDate, mapCategory };
