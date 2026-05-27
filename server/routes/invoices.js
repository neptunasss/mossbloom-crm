'use strict';

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
}

const LT_MONTHS = ['sausio','vasario','kovo','balandžio','gegužės','birželio','liepos','rugpjūčio','rugsėjo','spalio','lapkričio','gruodžio'];
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.getDate()} ${LT_MONTHS[dt.getMonth()]} ${dt.getFullYear()} m.`;
}

function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const row = db.prepare(
    `SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1`
  ).get(`SF-${year}-%`);
  let seq = 1;
  if (row) {
    const parts = row.invoice_number.split('-');
    seq = parseInt(parts[2] || '0') + 1;
  }
  return `SF-${year}-${String(seq).padStart(3, '0')}`;
}

// GET /api/invoices/settings
router.get('/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value || '';
  res.json(obj);
});

// PUT /api/invoices/settings
router.put('/settings', requireAuth, (req, res) => {
  const allowed = ['seller_name', 'seller_address', 'seller_vat', 'seller_bank', 'seller_iban'];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const key of allowed) {
    if (req.body[key] !== undefined) upsert.run(key, req.body[key]);
  }
  res.json({ ok: true });
});

// GET /api/invoices — list recent invoices
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

// POST /api/invoices — create invoice record
router.post('/', requireAuth, (req, res) => {
  const {
    order_id, store_id, customer_name, customer_company, customer_vat, customer_address,
    items, issue_date, due_date,
  } = req.body;

  if (!customer_name || !items?.length) {
    return res.status(400).json({ error: 'customer_name and items required' });
  }

  const issueDate = issue_date || new Date().toISOString().slice(0, 10);
  const dueDate   = due_date || (() => {
    const d = new Date(issueDate);
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  })();

  const totalNet = items.reduce((s, it) => s + parseFloat(it.price || 0) * parseFloat(it.qty || 1), 0);
  const vatAmt   = Math.round(totalNet * 0.21 * 100) / 100;
  const totalInc = Math.round((totalNet + vatAmt) * 100) / 100;

  const invNum = nextInvoiceNumber();
  const result = db.prepare(`
    INSERT INTO invoices
      (invoice_number, order_id, store_id, customer_name, customer_company, customer_vat, customer_address,
       amount, vat_amount, issue_date, due_date, items_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    invNum, order_id || '', store_id || '',
    customer_name, customer_company || '', customer_vat || '', customer_address || '',
    totalInc, vatAmt, issueDate, dueDate, JSON.stringify(items)
  );

  res.status(201).json({ id: result.lastInsertRowid, invoice_number: invNum });
});

// GET /api/invoices/:id/print — printable HTML invoice
router.get('/:id/print', requireAuth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(parseInt(req.params.id));
  if (!inv) return res.status(404).send('Sąskaita nerasta');

  const settings = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) settings[r.key] = r.value || '';

  let items = [];
  try { items = JSON.parse(inv.items_json || '[]'); } catch {}

  const itemRows = items.map(it => {
    const qty      = parseFloat(it.qty || 1);
    const unitNet  = parseFloat(it.price || 0);
    const lineNet  = Math.round(qty * unitNet * 100) / 100;
    const lineVat  = Math.round(lineNet * 0.21 * 100) / 100;
    const lineInc  = Math.round((lineNet + lineVat) * 100) / 100;
    return `<tr>
      <td>${esc(it.name || '')}</td>
      <td class="r">${qty}</td>
      <td class="r">${fmt(unitNet)}</td>
      <td class="r">${fmt(lineNet)}</td>
      <td class="r">21%</td>
      <td class="r">${fmt(lineVat)}</td>
      <td class="r"><strong>${fmt(lineInc)}</strong></td>
    </tr>`;
  }).join('');

  const subtotal = items.reduce((s, it) => s + parseFloat(it.price || 0) * parseFloat(it.qty || 1), 0);
  const vat      = Math.round(subtotal * 0.21 * 100) / 100;
  const total    = Math.round((subtotal + vat) * 100) / 100;

  const buyerLines = [
    inv.customer_name,
    inv.customer_company,
    inv.customer_vat ? `PVM mokėtojo kodas: ${inv.customer_vat}` : '',
    inv.customer_address,
  ].filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('');

  const html = `<!DOCTYPE html>
<html lang="lt">
<head>
  <meta charset="UTF-8">
  <title>${esc(inv.invoice_number)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; }
    .page { max-width: 820px; margin: 0 auto; padding: 48px 56px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
    .brand { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .brand span { color: #2d6a4f; }
    .inv-meta { text-align: right; }
    .inv-meta .inv-num { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
    .inv-meta p { color: #555; font-size: 11px; margin: 3px 0; }
    .parties { display: flex; gap: 56px; margin-bottom: 36px; }
    .party { flex: 1; }
    .party-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #999; font-weight: 700; margin-bottom: 8px; }
    .party p { font-size: 12px; line-height: 1.65; }
    .party p:first-of-type { font-weight: 600; font-size: 13px; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
    table.items thead th { background: #f5f5f5; padding: 9px 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #e0e0e0; white-space: nowrap; }
    table.items thead th { text-align: left; }
    table.items thead th.r { text-align: right; }
    table.items tbody td { padding: 9px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    table.items tbody td.r { text-align: right; }
    table.totals { margin-left: auto; border-collapse: collapse; margin-bottom: 36px; min-width: 240px; }
    table.totals td { padding: 5px 10px; font-size: 12px; }
    table.totals td:first-child { color: #555; padding-right: 32px; }
    table.totals td:last-child { text-align: right; font-weight: 500; }
    table.totals tr.total-final td { font-size: 15px; font-weight: 700; border-top: 2px solid #1a1a1a; padding-top: 10px; }
    .payment-box { background: #f9fafb; border: 1px solid #e8e8e8; border-radius: 6px; padding: 18px 22px; margin-bottom: 36px; font-size: 12px; line-height: 1.8; }
    .payment-box .section-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #999; font-weight: 700; margin-bottom: 10px; }
    .footer { text-align: center; color: #bbb; font-size: 11px; padding-top: 20px; border-top: 1px solid #f0f0f0; }
    .print-btn { position: fixed; bottom: 28px; right: 28px; background: #2d6a4f; color: #fff; border: none; padding: 13px 26px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.18); }
    @media print {
      .print-btn { display: none; }
      .page { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="brand">moss<span>bloom</span></div>
      <div class="inv-meta">
        <div class="inv-num">Sąskaita faktūra ${esc(inv.invoice_number)}</div>
        <p>Išrašymo data: ${fmtDate(inv.issue_date)}</p>
        <p>Apmokėjimo terminas: ${fmtDate(inv.due_date)}</p>
      </div>
    </div>

    <div class="parties">
      <div class="party">
        <div class="party-label">Pardavėjas</div>
        <p>${esc(settings.seller_name || 'Mossbloom')}</p>
        ${settings.seller_address ? `<p>${esc(settings.seller_address).replace(/\n/g,'<br>')}</p>` : ''}
        ${settings.seller_vat ? `<p>PVM mokėtojo kodas: ${esc(settings.seller_vat)}</p>` : ''}
        ${settings.seller_iban ? `<p>IBAN: ${esc(settings.seller_iban)}</p>` : ''}
      </div>
      <div class="party">
        <div class="party-label">Pirkėjas</div>
        ${buyerLines}
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>Pavadinimas</th>
          <th class="r">Kiekis</th>
          <th class="r">Kaina be PVM</th>
          <th class="r">Suma be PVM</th>
          <th class="r">PVM %</th>
          <th class="r">PVM suma</th>
          <th class="r">Iš viso su PVM</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <table class="totals">
      <tr><td>Suma be PVM:</td><td>${fmt(subtotal)}</td></tr>
      <tr><td>PVM (21%):</td><td>${fmt(vat)}</td></tr>
      <tr class="total-final"><td>IŠ VISO:</td><td>${fmt(total)}</td></tr>
    </table>

    <div class="payment-box">
      <div class="section-label">Mokėjimo informacija</div>
      <strong>Gavėjas:</strong> ${esc(settings.seller_name || '')}${settings.seller_bank ? ` &nbsp;·&nbsp; <strong>Bankas:</strong> ${esc(settings.seller_bank)}` : ''}<br>
      ${settings.seller_iban ? `<strong>IBAN:</strong> ${esc(settings.seller_iban)}<br>` : ''}
      <strong>Mokėjimo paskirtis:</strong> ${esc(inv.invoice_number)}
    </div>

    <div class="footer">Ačiū už pasitikėjimą! &nbsp;·&nbsp; mossbloom.lt</div>
  </div>
  <button class="print-btn" onclick="window.print()">🖨 Spausdinti / PDF</button>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
