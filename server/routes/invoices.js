'use strict';

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

const LT_MONTHS_GEN = ['sausio','vasario','kovo','balandžio','gegužės','birželio',
  'liepos','rugpjūčio','rugsėjo','spalio','lapkričio','gruodžio'];

function ltDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.getFullYear()} m. ${LT_MONTHS_GEN[dt.getMonth()]} ${dt.getDate()} d.`;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmt2(n) {
  return Number(n || 0).toFixed(2);
}

function nextInvoiceNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `PAV${today}-`;
  const last = db.prepare(
    `SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1`
  ).get(prefix + '%');
  let seq = 1;
  if (last) seq = parseInt(last.invoice_number.split('-').pop() || '0') + 1;
  return `${prefix}${String(seq).padStart(2, '0')}`;
}

function buildInvoiceHtml(inv) {
  let items = [];
  try { items = JSON.parse(inv.line_items || '[]'); } catch {}

  const itemRows = items.map((it, i) => {
    const qty    = parseFloat(it.qty || 1);
    const price  = parseFloat(it.price || 0);
    const total  = Math.round(qty * price * 100) / 100;
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name || '')}</td>
      <td class="c">${esc(it.unit || 'vnt.')}</td>
      <td class="r">${qty}</td>
      <td class="r">${fmt2(price)}</td>
      <td class="r">${fmt2(total)}</td>
    </tr>`;
  }).join('');

  // Pad to at least 5 rows so the table looks full
  const blankRows = Math.max(0, 5 - items.length);
  const blanks = Array(blankRows).fill(`<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="UTF-8">
<title>${esc(inv.invoice_number)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; background: #fff; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 14mm 14mm 14mm; }
h1 { font-size: 15px; text-transform: uppercase; text-align: center; font-weight: 700; letter-spacing: 1px; margin-bottom: 6px; }
.inv-meta { text-align: center; margin-bottom: 14px; font-size: 12px; }
.inv-meta p { margin: 2px 0; }
.parties { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
.parties td { width: 50%; vertical-align: top; padding: 8px 10px; border: 1px solid #000; font-size: 11px; line-height: 1.6; }
.parties .section-hdr { font-weight: 700; font-size: 11px; text-transform: uppercase; border-bottom: 1px solid #ccc; margin-bottom: 6px; padding-bottom: 3px; }
.items { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
.items th, .items td { border: 1px solid #000; padding: 5px 6px; }
.items th { background: #f0f0f0; font-weight: 700; text-align: center; font-size: 10px; }
.items td.c { text-align: center; }
.items td.r { text-align: right; }
.items th.r { text-align: right; }
.totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.totals { border-collapse: collapse; min-width: 240px; }
.totals td { padding: 4px 10px; border: 1px solid #000; font-size: 11px; }
.totals td:last-child { text-align: right; min-width: 90px; }
.totals tr.total-final td { font-weight: 700; background: #f0f0f0; }
.sig { display: flex; justify-content: space-between; margin-top: 28px; font-size: 11px; }
.sig-line { border-top: 1px solid #000; min-width: 200px; padding-top: 4px; text-align: center; }
.print-btn { position: fixed; bottom: 20px; right: 20px; background: #2d6a4f; color: #fff; border: none; padding: 10px 22px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
@media print { .print-btn { display: none; } }
</style>
</head>
<body>
<div class="page">
  <h1>PVM SĄSKAITA FAKTŪRA</h1>
  <div class="inv-meta">
    <p>Serija ${esc(inv.series || 'PAV')} Nr. ${esc(inv.invoice_number)}</p>
    <p>${ltDate(inv.issue_date)}</p>
  </div>

  <table class="parties">
    <tr>
      <td>
        <div class="section-hdr">Pardavėjo rekvizitai</div>
        <strong>${esc(inv.seller_name)}</strong><br>
        Įmonės kodas: ${esc(inv.seller_code)}<br>
        PVM mokėtojo kodas: ${esc(inv.seller_vat)}<br>
        Adresas: ${esc(inv.seller_address)}<br>
        Tel.: ${esc(inv.seller_phone)}<br>
        El. paštas: ${esc(inv.seller_email)}<br>
        Bankas: ${esc(inv.seller_bank)}<br>
        Sąskaitos Nr. (IBAN): ${esc(inv.seller_iban)}
      </td>
      <td>
        <div class="section-hdr">Pirkėjo rekvizitai</div>
        <strong>${esc(inv.buyer_name || '')}</strong><br>
        ${inv.buyer_code ? `Įmonės kodas: ${esc(inv.buyer_code)}<br>` : ''}
        ${inv.buyer_vat ? `PVM kodas: ${esc(inv.buyer_vat)}<br>` : ''}
        ${inv.buyer_address ? `Adresas: ${esc(inv.buyer_address)}<br>` : ''}
        &nbsp;
      </td>
    </tr>
  </table>

  <table class="items">
    <thead>
      <tr>
        <th style="width:4%">Nr.</th>
        <th style="width:46%">Prekės (paslaugos) pavadinimas</th>
        <th style="width:8%">Mat. vnt.</th>
        <th class="r" style="width:8%">Kiekis</th>
        <th class="r" style="width:17%">Kaina be PVM, €</th>
        <th class="r" style="width:17%">Suma be PVM, €</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      ${blanks}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      <tr><td>Iš viso be PVM:</td><td>${fmt2(inv.subtotal)} €</td></tr>
      <tr><td>PVM 21%:</td><td>${fmt2(inv.vat_amount)} €</td></tr>
      <tr class="total-final"><td>Viso su PVM:</td><td>${fmt2(inv.total)} €</td></tr>
    </table>
  </div>

  <div class="sig">
    <div>
      <div class="sig-line">Sąskaitą išrašė: ${esc(inv.seller_signee || '')}</div>
    </div>
    <div>
      <div class="sig-line">Sąskaitą priėmė: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
    </div>
  </div>
</div>
<button class="print-btn" onclick="window.print()">🖨 Spausdinti / PDF</button>
</body>
</html>`;
}

// GET /api/invoices
router.get('/', requireAuth, (req, res) => {
  const { status, search, limit = 100, offset = 0 } = req.query;
  let q = 'SELECT id,invoice_number,series,issue_date,due_date,buyer_name,subtotal,vat_amount,total,status,order_id,store_id,created_at FROM invoices WHERE 1=1';
  const params = [];
  if (status && status !== 'all') { q += ' AND status = ?'; params.push(status); }
  if (search) { q += ' AND (buyer_name LIKE ? OR invoice_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  const rows = db.prepare(q).all(...params);
  const statsRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('draft','sent') THEN 1 ELSE 0 END) as unpaid,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
      SUM(total) as sum
    FROM invoices
  `).get();
  res.json({ invoices: rows, stats: statsRow });
});

// POST /api/invoices
router.post('/', requireAuth, (req, res) => {
  const {
    seller_name, seller_code, seller_vat, seller_address, seller_phone,
    seller_email, seller_bank, seller_iban, seller_signee,
    buyer_name, buyer_code, buyer_vat, buyer_address,
    line_items, issue_date, due_date, order_id, store_id,
  } = req.body;

  if (!buyer_name) return res.status(400).json({ error: 'buyer_name required' });

  const items = Array.isArray(line_items) ? line_items : [];
  const subtotal   = items.reduce((s, it) => s + parseFloat(it.price || 0) * parseFloat(it.qty || 1), 0);
  const vatAmount  = Math.round(subtotal * 0.21 * 100) / 100;
  const total      = Math.round((subtotal + vatAmount) * 100) / 100;

  const issueDate = issue_date || new Date().toISOString().slice(0, 10);
  const dueDate   = due_date || (() => {
    const d = new Date(issueDate); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10);
  })();

  const invNum = nextInvoiceNumber();
  const result = db.prepare(`
    INSERT INTO invoices
      (invoice_number,issue_date,due_date,
       seller_name,seller_code,seller_vat,seller_address,seller_phone,seller_email,seller_bank,seller_iban,seller_signee,
       buyer_name,buyer_code,buyer_vat,buyer_address,
       line_items,subtotal,vat_amount,total,order_id,store_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    invNum, issueDate, dueDate,
    seller_name || 'MB Sydzei', seller_code || '306918032', seller_vat || 'LT100017928619',
    seller_address || 'Draugystės 1-takas 8, Raseiniai', seller_phone || '+3706 31 333 13',
    seller_email || 'info@bloom.lt', seller_bank || 'Revolut', seller_iban || 'LT353250018909471506',
    seller_signee || 'Simonas Jovaišas',
    buyer_name, buyer_code || '', buyer_vat || '', buyer_address || '',
    JSON.stringify(items), subtotal, vatAmount, total, order_id || '', store_id || ''
  );

  res.status(201).json({ id: result.lastInsertRowid, invoice_number: invNum });
});

// GET /api/invoices/:id/html — printable HTML
router.get('/:id/html', requireAuth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(parseInt(req.params.id));
  if (!inv) return res.status(404).send('Nerasta');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildInvoiceHtml(inv));
});

// GET /api/invoices/:id/pdf — generate PDF
router.get('/:id/pdf', requireAuth, async (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(parseInt(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Nerasta' });

  try {
    const HtmlPdf = require('html-pdf-node');
    const html = buildInvoiceHtml(inv);
    const buffer = await HtmlPdf.generatePdf(
      { content: html },
      { format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } }
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[invoices] PDF error:', err.message);
    // Fallback — redirect to HTML print view
    res.redirect(`/api/invoices/${req.params.id}/html`);
  }
});

// PATCH /api/invoices/:id
router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const allowed = ['draft', 'sent', 'paid'];
  const { status } = req.body;
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
  res.json({ ok: true });
});

// DELETE /api/invoices/:id
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
