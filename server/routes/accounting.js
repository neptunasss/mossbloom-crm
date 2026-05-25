const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const db          = require('../database');

const STORE_NAME = {
  bloom_lt:     'bloom.lt',
  mossbloom_dk: 'mossbloom.dk',
  mossbloom_de: 'mossbloom.de',
};

// ── Summary bar ────────────────────────────────────────────────────────────────
// GET /api/accounting/summary?month=YYYY-MM&store_id=

router.get('/summary', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const like  = `${month}-%`;

  const base   = req.query.store_id ? ' AND store_id = ?' : '';
  const args   = req.query.store_id ? [like, req.query.store_id] : [like];

  const incRow  = db.prepare(`SELECT currency, SUM(amount) AS total FROM accounting_entries WHERE type='income'  AND entry_date LIKE ?${base} GROUP BY currency`).all(...args);
  const expRow  = db.prepare(`SELECT currency, SUM(amount) AS total FROM accounting_entries WHERE type='expense' AND entry_date LIKE ?${base} GROUP BY currency`).all(...args);

  const income = {}, expenses = {}, profit = {};
  incRow.forEach(r  => { income[r.currency]   = r.total; });
  expRow.forEach(r  => { expenses[r.currency] = r.total; });

  const currencies = [...new Set([...Object.keys(income), ...Object.keys(expenses)])];
  currencies.forEach(c => { profit[c] = (income[c] || 0) - (expenses[c] || 0); });

  res.json({ income, expenses, profit, month });
});

// ── P&L chart — last 6 calendar months ────────────────────────────────────────
// GET /api/accounting/chart

router.get('/chart', requireAuth, (req, res) => {
  const now    = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }

  const data = months.map(month => {
    const like = `${month}-%`;
    const inc  = db.prepare(`SELECT currency, SUM(amount) AS total FROM accounting_entries WHERE type='income'  AND entry_date LIKE ? GROUP BY currency`).all(like);
    const exp  = db.prepare(`SELECT currency, SUM(amount) AS total FROM accounting_entries WHERE type='expense' AND entry_date LIKE ? GROUP BY currency`).all(like);
    const income = {}, expenses = {};
    inc.forEach(r => { income[r.currency]   = r.total; });
    exp.forEach(r => { expenses[r.currency] = r.total; });
    return { month, income, expenses };
  });

  res.json({ months: data });
});

// ── CSV export ─────────────────────────────────────────────────────────────────
// GET /api/accounting/export.csv?month=YYYY-MM&store_id=

router.get('/export.csv', requireAuth, (req, res) => {
  const month    = req.query.month    || new Date().toISOString().slice(0, 7);
  const storeId  = req.query.store_id || '';

  let query  = 'SELECT * FROM accounting_entries WHERE entry_date LIKE ?';
  const args = [`${month}-%`];
  if (storeId) { query += ' AND store_id = ?'; args.push(storeId); }
  query += ' ORDER BY entry_date DESC, id DESC';

  const entries = db.prepare(query).all(...args);

  const rows = [
    ['Data', 'Tipas', 'Aprašymas', 'Kategorija', 'Parduotuvė', 'Šaltinis', 'Suma EUR', 'Suma DKK', 'Pastabos'],
    ...entries.map(e => [
      e.entry_date,
      e.type === 'income' ? 'Pajamos' : 'Išlaidos',
      e.description,
      e.category  || '',
      STORE_NAME[e.store_id] || e.store_id || '',
      e.source    || '',
      e.currency === 'EUR' ? e.amount.toFixed(2) : '',
      e.currency === 'DKK' ? e.amount.toFixed(2) : '',
      e.notes     || '',
    ]),
  ];

  const csv = rows
    .map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="apskaita-${month}.csv"`);
  res.send('﻿' + csv); // UTF-8 BOM for Excel
});

// ── List entries ───────────────────────────────────────────────────────────────
// GET /api/accounting?month=YYYY-MM&type=&category=&store_id=&limit=&offset=

router.get('/', requireAuth, (req, res) => {
  const { month, type, category, store_id, limit = 300, offset = 0 } = req.query;

  let query  = 'SELECT * FROM accounting_entries WHERE 1=1';
  const args = [];

  if (month)    { query += ' AND entry_date LIKE ?'; args.push(`${month}-%`); }
  if (type)     { query += ' AND type = ?';          args.push(type); }
  if (category) { query += ' AND category = ?';      args.push(category); }
  if (store_id) { query += ' AND store_id = ?';      args.push(store_id); }

  query += ' ORDER BY entry_date DESC, id DESC LIMIT ? OFFSET ?';
  args.push(Number(limit), Number(offset));

  const entries = db.prepare(query).all(...args);
  const { cnt: total } = db.prepare('SELECT COUNT(*) AS cnt FROM accounting_entries').get();

  res.json({ entries, total });
});

// ── Sync WooCommerce + Sandoriai ───────────────────────────────────────────────
// POST /api/accounting/sync

router.post('/sync', requireAuth, (req, res) => {
  const wc = { added: 0, skipped: 0 };
  const sa = { added: 0, skipped: 0 };

  // 1. WooCommerce completed / processing orders → income
  const orders = db.prepare(`SELECT * FROM orders_cache WHERE status IN ('completed','processing')`).all();

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

  res.json({ results: { woocommerce: wc, sandoriai: sa } });
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

module.exports = router;
