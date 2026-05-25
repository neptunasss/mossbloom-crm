const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const requireAuth = require('../middleware/auth');
const db = require('../database');

const uploadsDir = path.join(__dirname, '../../data/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Leidžiami tik PDF ir paveikslėliai'));
    cb(null, true);
  },
});

// List files for an order, deal, or accounting entry
router.get('/', requireAuth, (req, res) => {
  const { store_id, order_id, deal_id, accounting_id } = req.query;
  let query = 'SELECT * FROM order_files WHERE 1=1';
  const params = [];
  if (store_id)     { query += ' AND store_id = ?';      params.push(store_id); }
  if (order_id)     { query += ' AND order_id = ?';      params.push(Number(order_id)); }
  if (deal_id)      { query += ' AND deal_id = ?';       params.push(Number(deal_id)); }
  if (accounting_id){ query += ' AND accounting_id = ?'; params.push(Number(accounting_id)); }
  query += ' ORDER BY uploaded_at DESC';
  res.json({ files: db.prepare(query).all(...params) });
});

// Upload
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Failas nepasirinktas' });
  const { store_id, order_id, deal_id, accounting_id } = req.body;

  const result = db.prepare(`
    INSERT INTO order_files (store_id, order_id, deal_id, accounting_id, filename, original_name, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    store_id       || null,
    order_id       ? Number(order_id)       : null,
    deal_id        ? Number(deal_id)        : null,
    accounting_id  ? Number(accounting_id)  : null,
    req.file.filename,
    req.file.originalname,
    req.file.mimetype,
    req.file.size
  );

  res.status(201).json({ file: db.prepare('SELECT * FROM order_files WHERE id = ?').get(result.lastInsertRowid) });
});

// Serve / view file inline
router.get('/:id', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM order_files WHERE id = ?').get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Failas nerastas' });

  const filePath = path.join(uploadsDir, file.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Failas nerastas diske' });

  const isViewable = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mime_type);
  res.setHeader('Content-Disposition',
    `${isViewable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.sendFile(filePath);
});

// Delete
router.delete('/:id', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM order_files WHERE id = ?').get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Failas nerastas' });

  const filePath = path.join(uploadsDir, file.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM order_files WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Failas per didelis (maks. 15 MB)' });
  res.status(400).json({ error: err.message });
});

module.exports = router;
