const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const db          = require('../database');
const fx          = require('../services/fx');
const stats       = require('../services/accounting-stats');

const STORE_NAME = {
  bloom_lt:     'bloom.lt',
  mossbloom_dk: 'mossbloom.dk',
  mossbloom_de: 'mossbloom.de',
};

// ── Dashboard (stats, chart, stores, transactions) ───────────────────────────
// GET /api/accounting/dashboard?period=this_month|last_month|...&from=&to=&type=&category=&store_id=

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { runImport } = require('../scripts/import-b2b');
    runImport(db);

    const data = await stats.buildDashboard(db, req.query);
    res.json(data);
  } catch (err) {
    console.error('[acct-dashboard] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Summary bar ────────────────────────────────────────────────────────────────
// GET /api/accounting/summary?month=YYYY-MM&store_id=

router.get('/summary', requireAuth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const like  = `${month}-%`;
  const base  = req.query.store_id ? ' AND store_id = ?' : '';
  const args  = req.query.store_id ? [like, req.query.store_id] : [like];

  const rate   = await fx.getDkkPerEur();
  const incRow = db.prepare(`SELECT currency, SUM(amount) AS total FROM accounting_entries WHERE type='income'  AND entry_date LIKE ?${base} GROUP BY currency`).all(...args);
  const expRow = db.prepare(`SELECT currency, SUM(amount) AS total FROM accounting_entries WHERE type='expense' AND entry_date LIKE ?${base} GROUP BY currency`).all(...args);

  let incomeEUR = 0, expensesEUR = 0;
  incRow.forEach(r => { incomeEUR   += fx.toEur(r.total, r.currency, rate); });
  expRow.forEach(r => { expensesEUR += fx.toEur(r.total, r.currency, rate); });

  res.json({ incomeEUR, expensesEUR, profitEUR: incomeEUR - expensesEUR, rate, month });
});

// ── P&L chart — last 12 calendar months ───────────────────────────────────────
// GET /api/accounting/chart

router.get('/chart', requireAuth, async (req, res) => {
  const rate = await fx.getDkkPerEur();
  const data = stats.buildChartMonths(db, rate).map(({ month, incomeEUR, expensesEUR }) => ({
    month, incomeEUR, expensesEUR,
  }));

  res.json({ months: data, rate });
});

// ── CSV export ─────────────────────────────────────────────────────────────────
// GET /api/accounting/export.csv?month=YYYY-MM&store_id=

router.get('/export.csv', requireAuth, async (req, res) => {
  const storeId = req.query.store_id || '';
  const rate    = await fx.getDkkPerEur();
  let entries;
  let filename = 'apskaita';

  if (req.query.from && req.query.to) {
    entries = db.prepare(`
      SELECT * FROM accounting_entries WHERE entry_date >= ? AND entry_date <= ?
      ORDER BY entry_date DESC, id DESC
    `).all(req.query.from, req.query.to);
    filename = `apskaita-${req.query.from}_${req.query.to}`;
  } else {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    entries = db.prepare(`
      SELECT * FROM accounting_entries WHERE entry_date LIKE ?
      ORDER BY entry_date DESC, id DESC
    `).all(`${month}-%`);
    filename = `apskaita-${month}`;
  }

  if (storeId) entries = entries.filter(e => stats.matchesStoreFilter(e, storeId));

  const storeLabel = e => {
    if (e.source === 'b2b_import') return 'B2B';
    return STORE_NAME[e.store_id] || e.store_id || '';
  };

  const rows = [
    ['Data', 'Tipas', 'Aprašymas', 'Kategorija', 'Parduotuvė', 'Šaltinis', 'Suma EUR', 'Pastabos'],
    ...entries.map(e => [
      e.entry_date,
      e.type === 'income' ? 'Pajamos' : 'Išlaidos',
      e.description,
      e.category  || '',
      storeLabel(e),
      e.source    || '',
      fx.toEur(e.amount, e.currency, rate).toFixed(2),
      e.notes     || '',
    ]),
  ];

  const csv = rows
    .map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send('﻿' + csv); // UTF-8 BOM for Excel
});

// ── List entries ───────────────────────────────────────────────────────────────
// GET /api/accounting?month=YYYY-MM&type=&category=&store_id=&limit=&offset=

router.get('/', requireAuth, async (req, res) => {
  const { month, from, to, type, category, store_id, limit = 500, offset = 0 } = req.query;
  const rate = await fx.getDkkPerEur();

  let query  = 'SELECT * FROM accounting_entries WHERE 1=1';
  const args = [];

  if (from && to) {
    query += ' AND entry_date >= ? AND entry_date <= ?';
    args.push(from, to);
  } else if (month) {
    query += ' AND entry_date LIKE ?';
    args.push(`${month}-%`);
  }
  if (type)     { query += ' AND type = ?';     args.push(type); }
  if (category) { query += ' AND category = ?'; args.push(category); }

  query += ' ORDER BY entry_date DESC, id DESC';
  let entries = db.prepare(query).all(...args);

  if (store_id) entries = entries.filter(e => stats.matchesStoreFilter(e, store_id));

  const total = entries.length;
  entries = entries.slice(Number(offset), Number(offset) + Number(limit));

  entries = entries.map(e => ({
    ...e,
    amountEUR: fx.toEur(e.amount, e.currency, rate),
    storeKey:  stats.storeKey(e) || e.store_id || '',
  }));

  res.json({ entries, total, rate });
});

// ── Sync WooCommerce + Sandoriai ───────────────────────────────────────────────
// POST /api/accounting/sync

router.post('/sync', requireAuth, async (req, res) => {
  const wc = { added: 0, skipped: 0 };
  const sa = { added: 0, skipped: 0 };

  try {
    // 1. WooCommerce completed / processing orders → income
    const orders = db.prepare(`SELECT * FROM orders_cache WHERE status IN ('completed','processing')`).all();
    console.log(`[acct-sync] found ${orders.length} WooCommerce orders to check`);

    for (const o of orders) {
      const exists = db.prepare(`
        SELECT id FROM accounting_entries WHERE source='woocommerce' AND store_id=? AND reference_id=?
      `).get(o.store_id, String(o.order_id));

      if (exists) { wc.skipped++; continue; }

      const entryDate = (o.date_created || '').slice(0, 10) || new Date().toISOString().slice(0, 10);

      db.prepare(`
        INSERT INTO accounting_entries
          (type, source, store_id, reference_id, description, amount, currency, entry_date, category)
        VALUES ('income','woocommerce',?,?,?,?,?,'${entryDate}','Pardavimai')
      `).run(
        o.store_id,
        String(o.order_id),
        `#${o.order_id} — ${o.customer_name || 'Unknown'}`,
        parseFloat(o.total) || 0,
        o.currency || 'EUR',
      );
      wc.added++;
    }

    // 2. Won Sandoriai deals → income
    const deals = db.prepare(`SELECT * FROM custom_deals WHERE status='won'`).all();
    console.log(`[acct-sync] found ${deals.length} won deals to check`);

    for (const d of deals) {
      const exists = db.prepare(`
        SELECT id FROM accounting_entries WHERE source='sandoriai' AND reference_id=?
      `).get(String(d.id));

      if (exists) { sa.skipped++; continue; }

      const entryDate = d.deal_date || new Date().toISOString().slice(0, 10);
      const desc = d.description ? `${d.customer_name} — ${d.description}` : d.customer_name;

      db.prepare(`
        INSERT INTO accounting_entries
          (type, source, store_id, reference_id, description, amount, currency, entry_date, category)
        VALUES ('income','sandoriai',?,?,?,?,?,'${entryDate}','Pardavimai')
      `).run(d.store_id || 'custom', String(d.id), desc, parseFloat(d.amount) || 0, d.currency || 'EUR');
      sa.added++;
    }

    console.log(`[acct-sync] done — WC +${wc.added}/${wc.skipped} skipped, SA +${sa.added}/${sa.skipped} skipped`);
    res.json({ results: { woocommerce: wc, sandoriai: sa } });
  } catch (err) {
    console.error('[acct-sync] error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Create manual entry ────────────────────────────────────────────────────────
// POST /api/accounting  body: { type, category, description, amount, currency, entry_date, notes }

router.post('/', requireAuth, (req, res) => {
  const { type, category, description, amount, currency, entry_date, notes } = req.body;

  if (!description || !amount || !entry_date) {
    return res.status(400).json({ error: 'Aprašymas, suma ir data yra privalomi' });
  }

  const safeType = ['income', 'expense'].includes(type) ? type : 'expense';

  const result = db.prepare(`
    INSERT INTO accounting_entries
      (type, source, category, description, amount, currency, entry_date, notes)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, ?)
  `).run(
    safeType,
    category || 'Kita',
    description,
    parseFloat(amount) || 0,
    currency || 'EUR',
    entry_date,
    notes || '',
  );

  const entry = db.prepare('SELECT * FROM accounting_entries WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ entry });
});

// ── Delete entry ───────────────────────────────────────────────────────────────
// DELETE /api/accounting/:id

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM accounting_entries WHERE id=?').get(id)) {
    return res.status(404).json({ error: 'Įrašas nerastas' });
  }
  db.prepare('DELETE FROM accounting_entries WHERE id=?').run(id);
  res.json({ success: true });
});

// ── B2B import ─────────────────────────────────────────────────────────────────
// POST /api/accounting/import-b2b
// Safe to call multiple times — skips records that already exist.

router.post('/import-b2b', requireAuth, (req, res) => {
  try {
    const { runImport } = require('../scripts/import-b2b');
    const result = runImport(db);
    console.log(`[import-b2b] inserted=${result.inserted} skipped=${result.skipped}`);
    res.json(result);
  } catch (err) {
    console.error('[import-b2b] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
