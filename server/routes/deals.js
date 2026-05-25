const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

const VALID_STATUSES = ['lead', 'quoted', 'negotiating', 'won', 'lost'];

// List deals
router.get('/', requireAuth, (req, res) => {
  const { status, search, limit = 300, offset = 0 } = req.query;

  let query = 'SELECT * FROM custom_deals WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    query += ' AND (customer_name LIKE ? OR customer_email LIKE ? OR description LIKE ? OR product LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  query += ' ORDER BY deal_date DESC, created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const deals = db.prepare(query).all(...params);
  const { cnt: total } = db.prepare('SELECT COUNT(*) as cnt FROM custom_deals').get();

  res.json({ deals, total });
});

// Create deal
router.post('/', requireAuth, (req, res) => {
  const {
    customer_name, customer_email, customer_phone,
    store_id, description, product, size, amount, currency,
    status, payment_method, notes, deal_date,
  } = req.body;

  if (!customer_name || !description) {
    return res.status(400).json({ error: 'Customer name and description are required' });
  }

  const safeStatus = VALID_STATUSES.includes(status) ? status : 'lead';

  const result = db.prepare(`
    INSERT INTO custom_deals
      (customer_name, customer_email, customer_phone, store_id, description, product, size,
       amount, currency, status, payment_method, notes, deal_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customer_name, customer_email || '', customer_phone || '',
    store_id || 'custom', description, product || '', size || '',
    parseFloat(amount) || 0, currency || 'EUR',
    safeStatus, payment_method || 'bank_transfer',
    notes || '', deal_date || new Date().toISOString().slice(0, 10)
  );

  const deal = db.prepare('SELECT * FROM custom_deals WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ deal });
});

// Update deal (includes quick status patch)
router.put('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT id FROM custom_deals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Deal not found' });

  const {
    customer_name, customer_email, customer_phone,
    store_id, description, product, size, amount, currency,
    status, payment_method, notes, deal_date,
  } = req.body;

  const safeStatus = VALID_STATUSES.includes(status) ? status : 'lead';

  db.prepare(`
    UPDATE custom_deals SET
      customer_name = ?, customer_email = ?, customer_phone = ?,
      store_id = ?, description = ?, product = ?, size = ?, amount = ?, currency = ?,
      status = ?, payment_method = ?, notes = ?, deal_date = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    customer_name, customer_email || '', customer_phone || '',
    store_id || 'custom', description, product || '', size || '',
    parseFloat(amount) || 0, currency || 'EUR',
    safeStatus, payment_method || 'bank_transfer',
    notes || '', deal_date || '',
    id
  );

  res.json({ deal: db.prepare('SELECT * FROM custom_deals WHERE id = ?').get(id) });
});

// Quick status patch (from pipeline drag-drop)
router.patch('/:id/status', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare("UPDATE custom_deals SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  res.json({ success: true });
});

// Delete deal
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM custom_deals WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Deal not found' });
  }
  // Also delete any attached files
  const files = db.prepare('SELECT filename FROM order_files WHERE deal_id = ?').all(id);
  const path = require('path');
  const fs   = require('fs');
  const dir  = path.join(__dirname, '../../data/uploads');
  for (const f of files) {
    const fp = path.join(dir, f.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM order_files WHERE deal_id = ?').run(id);
  db.prepare('DELETE FROM custom_deals WHERE id = ?').run(id);
  res.json({ success: true });
});

module.exports = router;
