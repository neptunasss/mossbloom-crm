'use strict';

const express  = require('express');
const router   = express.Router();
const requireAuth = require('../middleware/auth');
const db       = require('../database');
const { populateFromCache } = require('../services/production-queue');

const STAGES = ['gauta', 'gaminama', 'paruosta', 'issista', 'pristatyta'];

// GET /api/production — all items grouped by stage
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM production_queue ORDER BY due_date ASC, id ASC'
  ).all();

  const grouped = {};
  for (const s of STAGES) grouped[s] = [];
  for (const row of rows) {
    const s = STAGES.includes(row.stage) ? row.stage : 'gauta';
    grouped[s].push(row);
  }
  res.json({ stages: grouped });
});

// PATCH /api/production/:id — update stage and/or notes
router.patch('/:id', requireAuth, (req, res) => {
  const { stage, notes } = req.body;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const row = db.prepare('SELECT id FROM production_queue WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  if (stage !== undefined && !STAGES.includes(stage)) {
    return res.status(400).json({ error: 'invalid stage' });
  }

  const fields = [];
  const vals   = [];
  if (stage !== undefined) { fields.push('stage = ?');  vals.push(stage); }
  if (notes !== undefined) { fields.push('notes = ?');  vals.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE production_queue SET ${fields.join(', ')} WHERE id = ?`).run(...vals);

  res.json({ ok: true });
});

// POST /api/production — manually add item
router.post('/', requireAuth, (req, res) => {
  const { order_id = '', store_id = '', order_number = '', product_name, product_size = '',
          product_image = '', country = '', country_flag = '', due_date = '', stage = 'gauta', notes = '' } = req.body;
  if (!product_name) return res.status(400).json({ error: 'product_name required' });

  const info = db.prepare(`
    INSERT INTO production_queue
      (order_id, store_id, order_number, product_name, product_size, product_image,
       country, country_flag, due_date, stage, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(order_id, store_id, order_number, product_name, product_size, product_image,
         country, country_flag, due_date, stage, notes);

  res.json({ ok: true, id: info.lastInsertRowid });
});

// DELETE /api/production/:id
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM production_queue WHERE id = ?').run(id);
  res.json({ ok: true });
});

// POST /api/production/populate — backfill from orders_cache
router.post('/populate', requireAuth, (req, res) => {
  const added = populateFromCache();
  res.json({ ok: true, added });
});

module.exports = { router };
