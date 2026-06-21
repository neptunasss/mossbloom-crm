'use strict';

const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

// GET /api/todos
router.get('/', requireAuth, (req, res) => {
  const { status, priority, sort } = req.query;

  let q = 'SELECT * FROM todos WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    if (status === 'active') {
      q += " AND status = 'pending'";
    } else if (status === 'completed') {
      q += " AND status = 'completed'";
    }
  }
  if (priority && priority !== 'all') {
    q += ' AND priority = ?';
    params.push(priority);
  }

  const orderMap = { due_date: 'due_date ASC, created_at ASC', priority: "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END ASC", created: 'created_at DESC' };
  q += ' ORDER BY ' + (orderMap[sort] || 'created_at DESC');

  const todos = db.prepare(q).all(...params);

  const now = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const stats = {
    active: db.prepare("SELECT COUNT(*) as c FROM todos WHERE status='pending'").get().c,
    overdue: db.prepare("SELECT COUNT(*) as c FROM todos WHERE status='pending' AND due_date IS NOT NULL AND due_date < ?").get(now).c,
    completed_week: db.prepare("SELECT COUNT(*) as c FROM todos WHERE status='completed' AND completed_at >= ?").get(weekStart).c,
    high_priority: db.prepare("SELECT COUNT(*) as c FROM todos WHERE status='pending' AND priority='high'").get().c,
  };

  res.json({ todos, stats });
});

// POST /api/todos
router.post('/', requireAuth, (req, res) => {
  const { title, description, priority, due_date, category } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });

  const result = db.prepare(`
    INSERT INTO todos (title, description, priority, due_date, status, category)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(title.trim(), description || '', priority || 'medium', due_date || null, category || null);

  res.status(201).json({ id: result.lastInsertRowid });
});

// PATCH /api/todos/:id
router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const todo = db.prepare('SELECT * FROM todos WHERE id=?').get(id);
  if (!todo) return res.status(404).json({ error: 'not found' });

  const fields = ['title', 'description', 'priority', 'due_date', 'status', 'category'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }

  if (updates.status === 'completed' && todo.status !== 'completed') {
    updates.completed_at = new Date().toISOString();
  } else if (updates.status === 'pending') {
    updates.completed_at = null;
  }

  if (!Object.keys(updates).length) return res.json({ ok: true });

  const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
  db.prepare(`UPDATE todos SET ${setClauses} WHERE id=?`).run(...Object.values(updates), id);

  res.json({ ok: true });
});

// DELETE /api/todos/:id
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM todos WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
