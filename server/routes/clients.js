'use strict';

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');
const fx = require('../services/fx');

// GET /api/clients
router.get('/', requireAuth, async (req, res) => {
  const { type, search, country } = req.query;
  const rate = await fx.getDkkPerEur().catch(() => 7.46);

  let q = 'SELECT * FROM clients WHERE 1=1';
  const params = [];
  if (type && type !== 'all') { q += ' AND type = ?'; params.push(type); }
  if (country) { q += ' AND country = ?'; params.push(country); }
  if (search) {
    q += ' AND (name LIKE ? OR company LIKE ? OR email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  q += ' ORDER BY name ASC';
  const clients = db.prepare(q).all(...params);

  // Enrich with order stats
  const enriched = clients.map(c => {
    if (!c.email) return { ...c, order_count: 0, total_spent: 0, last_order: null };

    const orders = db.prepare(`
      SELECT status, total, currency, date_created FROM orders_cache
      WHERE customer_email = ? AND (hidden IS NULL OR hidden = 0)
      ORDER BY date_created DESC
    `).all(c.email);

    const order_count = orders.length;
    const total_spent = orders
      .filter(o => !['cancelled','refunded','failed'].includes(o.status))
      .reduce((s, o) => s + fx.toEur(parseFloat(o.total) || 0, o.currency, rate), 0);
    const last_order = orders[0]?.date_created || null;

    return { ...c, order_count, total_spent: Math.round(total_spent * 100) / 100, last_order };
  });

  // Stats
  const total   = db.prepare('SELECT COUNT(*) as cnt FROM clients').get().cnt;
  const b2bCnt  = db.prepare("SELECT COUNT(*) as cnt FROM clients WHERE type='b2b'").get().cnt;
  const b2cCnt  = db.prepare("SELECT COUNT(*) as cnt FROM clients WHERE type='b2c'").get().cnt;
  const countries = db.prepare("SELECT COUNT(DISTINCT country) as cnt FROM clients WHERE country IS NOT NULL AND country != ''").get().cnt;

  res.json({ clients: enriched, stats: { total, b2b: b2bCnt, b2c: b2cCnt, countries } });
});

// GET /api/clients/:id/orders
router.get('/:id/orders', requireAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(parseInt(req.params.id));
  if (!client) return res.status(404).json({ error: 'Not found' });

  const orders = client.email
    ? db.prepare(`
        SELECT store_id, order_id, customer_name, status, total, currency, date_created
        FROM orders_cache WHERE customer_email = ? AND (hidden IS NULL OR hidden = 0)
        ORDER BY date_created DESC LIMIT 20
      `).all(client.email)
    : [];

  res.json({ client, orders });
});

// POST /api/clients
router.post('/', requireAuth, (req, res) => {
  const { type, name, company, email, phone, address, country, company_code, vat_code, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = db.prepare(`
      INSERT INTO clients (type,name,company,email,phone,address,country,company_code,vat_code,notes,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,'manual')
    `).run(type||'b2c', name, company||'', email||null, phone||'', address||'', country||'', company_code||'', vat_code||'', notes||'');
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/clients/:id
router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, company, email, phone, address, country, company_code, vat_code, notes, type } = req.body;
  try {
    db.prepare(`
      UPDATE clients SET
        name=?, company=?, email=?, phone=?, address=?, country=?,
        company_code=?, vat_code=?, notes=?, type=?
      WHERE id=?
    `).run(name||'', company||'', email||null, phone||'', address||'', country||'',
           company_code||'', vat_code||'', notes||'', type||'b2c', id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
