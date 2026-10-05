const express     = require('express');
const router      = express.Router();
const path        = require('path');
const fs          = require('fs');
const requireAuth = require('../middleware/auth');

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH    = path.join(DATA_DIR, 'mossbloom.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_NAME_RE = /^mossbloom-\d{4}-\d{2}-\d{2}\.db$/;

// List the live database + any daily backups found on the volume
router.get('/backups', requireAuth, (req, res) => {
  const live = fs.existsSync(DB_PATH)
    ? { size: fs.statSync(DB_PATH).size, mtime: fs.statSync(DB_PATH).mtime }
    : null;

  let backups = [];
  if (fs.existsSync(BACKUP_DIR)) {
    backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => BACKUP_NAME_RE.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
  }

  res.json({ dataDir: DATA_DIR, live, backups });
});

// Download the live database file right now
router.get('/backups/db', requireAuth, (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'Database file not found' });
  res.download(DB_PATH, `mossbloom-${new Date().toISOString().slice(0, 10)}.db`);
});

// Download a specific daily backup by filename
router.get('/backups/:file', requireAuth, (req, res) => {
  const { file } = req.params;
  if (!BACKUP_NAME_RE.test(file)) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
  res.download(filePath, file);
});

module.exports = router;
