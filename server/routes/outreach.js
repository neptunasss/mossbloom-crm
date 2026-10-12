'use strict';

const express     = require('express');
const router      = express.Router();
const net         = require('net');
const tls         = require('tls');
const multer      = require('multer');
const requireAuth = require('../middleware/auth');
const db          = require('../database');
const common      = require('../services/outreach-common');
const { localDayStart, localWeekStart, toSql } = require('../worker/time');

// Same formula the worker uses for today's send cap
function effectiveLimit(m) {
  return m.warmup_mode ? (m.warmup_daily_limit ?? m.warmup_start_limit) : m.daily_limit;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Dynamic partial UPDATE helper — only touches fields present in req.body
function buildUpdate(table, id, body, allowedFields) {
  const fields = [];
  const vals   = [];
  for (const f of allowedFields) {
    if (body[f] !== undefined) { fields.push(`${f} = ?`); vals.push(body[f]); }
  }
  if (!fields.length) return false;
  vals.push(id);
  db.prepare(`UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return true;
}

// Minimal CSV parser (handles quoted fields with embedded commas/quotes)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Raw TCP/TLS connectivity check — reads the server's greeting banner.
// NOTE: this only confirms the host/port is reachable and speaking back;
// it does not authenticate or send real mail/IMAP commands (no SMTP/IMAP
// client library is installed yet).
function testBanner(host, port, useTls) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve({ ok: false, error: 'host/port not configured' });
    const connect = useTls ? tls.connect : net.connect;
    const socket = connect({ host, port: Number(port), timeout: 8000, rejectUnauthorized: false });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => { if (useTls) return; });
    socket.once('secureConnect', () => {});
    socket.once('data', (chunk) => finish({ ok: true, banner: chunk.toString('utf8').trim().slice(0, 200) }));
    socket.once('timeout', () => finish({ ok: false, error: 'timed out waiting for server response' }));
    socket.once('error', (err) => finish({ ok: false, error: err.message }));
  });
}

// ── DOMAINS ──────────────────────────────────────────────────────────────────

router.get('/domains', requireAuth, (req, res) => {
  const domains = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM outreach_mailboxes m WHERE m.domain_id = d.id) AS mailbox_count
    FROM outreach_domains d ORDER BY d.created_at DESC
  `).all();
  res.json({ domains });
});

router.post('/domains', requireAuth, (req, res) => {
  const { domain, daily_limit, status } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const result = db.prepare(`
    INSERT INTO outreach_domains (domain, daily_limit, status)
    VALUES (?, ?, ?)
  `).run(domain, daily_limit ?? 100, status || 'active');
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/domains/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_domains WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const updated = buildUpdate('outreach_domains', id, req.body, ['domain', 'daily_limit', 'status']);
  if (!updated) return res.status(400).json({ error: 'nothing to update' });
  res.json({ ok: true });
});

router.delete('/domains/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM outreach_domains WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ── MAILBOXES ────────────────────────────────────────────────────────────────

// Strip credential fields out of a mailbox row, replacing with has_* flags
function redactMailbox(m) {
  const { smtp_pass, imap_pass, ...rest } = m;
  return { ...rest, effective_limit: effectiveLimit(m), has_smtp_pass: !!smtp_pass, has_imap_pass: !!imap_pass };
}

router.get('/mailboxes', requireAuth, (req, res) => {
  const { domain_id, status } = req.query;
  let q = `SELECT m.*, (SELECT COUNT(*) FROM outreach_email_queue q WHERE q.mailbox_id = m.id AND q.sent_at >= ?) AS sent_today
    FROM outreach_mailboxes m WHERE 1=1`;
  const params = [toSql(localDayStart())];
  if (domain_id) { q += ' AND domain_id = ?'; params.push(parseInt(domain_id, 10)); }
  if (status && status !== 'all') { q += ' AND status = ?'; params.push(status); }
  q += ' ORDER BY created_at DESC';
  const mailboxes = db.prepare(q).all(...params).map(redactMailbox);
  res.json({ mailboxes });
});

router.post('/mailboxes', requireAuth, (req, res) => {
  const {
    domain_id, email, display_name,
    smtp_host, smtp_port, smtp_user, smtp_pass,
    imap_host, imap_port, imap_user, imap_pass,
    daily_limit, hourly_limit, warmup_mode, warmup_day,
    warmup_start_limit, warmup_end_limit, status,
  } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  let encSmtp, encImap;
  try {
    encSmtp = common.encrypt(smtp_pass || '');
    encImap = common.encrypt(imap_pass || '');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const result = db.prepare(`
    INSERT INTO outreach_mailboxes (
      domain_id, email, display_name,
      smtp_host, smtp_port, smtp_user, smtp_pass,
      imap_host, imap_port, imap_user, imap_pass,
      daily_limit, hourly_limit, warmup_mode, warmup_day,
      warmup_start_limit, warmup_end_limit, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    domain_id ?? null, email, display_name || '',
    smtp_host || '', smtp_port ?? null, smtp_user || '', encSmtp,
    imap_host || '', imap_port ?? null, imap_user || '', encImap,
    daily_limit ?? 30, hourly_limit ?? 5, warmup_mode === false ? 0 : 1, warmup_day ?? 0,
    warmup_start_limit ?? 3, warmup_end_limit ?? 30, status || 'warmup',
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/mailboxes/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_mailboxes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const body = { ...req.body };
  try {
    if (body.smtp_pass !== undefined) body.smtp_pass = common.encrypt(body.smtp_pass);
    if (body.imap_pass !== undefined) body.imap_pass = common.encrypt(body.imap_pass);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const updated = buildUpdate('outreach_mailboxes', id, body, [
    'domain_id', 'email', 'display_name',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
    'imap_host', 'imap_port', 'imap_user', 'imap_pass',
    'daily_limit', 'hourly_limit', 'warmup_mode', 'warmup_day',
    'warmup_start_limit', 'warmup_end_limit', 'bounce_rate', 'status',
  ]);
  if (!updated) return res.status(400).json({ error: 'nothing to update' });
  res.json({ ok: true });
});

router.delete('/mailboxes/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.transaction(() => {
    db.prepare("UPDATE outreach_email_queue SET status = 'cancelled', error_message = 'mailbox deleted' WHERE mailbox_id = ? AND status = 'pending'").run(id);
    db.prepare('DELETE FROM outreach_campaign_mailboxes WHERE mailbox_id = ?').run(id);
    db.prepare('DELETE FROM outreach_mailboxes WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

// POST /api/outreach/mailboxes/:id/test-smtp — connects + authenticates (no email sent)
router.post('/mailboxes/:id/test-smtp', requireAuth, async (req, res) => {
  const m = db.prepare('SELECT * FROM outreach_mailboxes WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!m.smtp_host) return res.json({ ok: false, error: 'SMTP host not set' });
  const port = Number(m.smtp_port) || 587;
  try {
    const transporter = require('nodemailer').createTransport({
      host: m.smtp_host, port, secure: port === 465,
      auth: { user: m.smtp_user || m.email, pass: common.decrypt(m.smtp_pass) },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    await transporter.verify();
    transporter.close();
    res.json({ ok: true, message: `Connected and logged in to ${m.smtp_host}:${port}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/outreach/mailboxes/:id/test-imap — connects + logs in + opens INBOX
router.post('/mailboxes/:id/test-imap', requireAuth, async (req, res) => {
  const m = db.prepare('SELECT * FROM outreach_mailboxes WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!m.imap_host) return res.json({ ok: false, error: 'IMAP host not set' });
  const port = Number(m.imap_port) || 993;
  let client;
  try {
    const { ImapFlow } = require('imapflow');
    client = new ImapFlow({
      host: m.imap_host, port, secure: port === 993,
      auth: { user: m.imap_user || m.email, pass: common.decrypt(m.imap_pass) },
      logger: false, socketTimeout: 20000,
    });
    client.on('error', () => {});
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    res.json({ ok: true, message: `Logged in to ${m.imap_host}:${port} — INBOX has ${box.exists} messages` });
  } catch (err) {
    res.json({ ok: false, error: err.responseText || err.message });
  } finally {
    if (client) await client.logout().catch(() => {});
  }
});

router.post('/mailboxes/:id/pause', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_mailboxes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE outreach_mailboxes SET status = 'paused' WHERE id = ?").run(id);
  res.json({ ok: true });
});

router.post('/mailboxes/:id/resume', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id, warmup_mode FROM outreach_mailboxes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE outreach_mailboxes SET status = ?, pause_reason = NULL, consecutive_smtp_errors = 0 WHERE id = ?')
    .run(row.warmup_mode ? 'warmup' : 'active', id);
  res.json({ ok: true });
});

// ── LEADS ────────────────────────────────────────────────────────────────────

// Segment filter shared by the leads list and "add by filter".
// '__none__' matches leads with an empty value (e.g. no list).
const NONE = '__none__';
function leadFilter(f = {}) {
  let where = '1=1';
  const params = [];
  if (f.status && f.status !== 'all') { where += ' AND status = ?'; params.push(f.status); }
  if (f.search) {
    where += ' AND (company_name LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)';
    const s = `%${f.search}%`;
    params.push(s, s, s, s);
  }
  for (const col of ['industry', 'city', 'list_name']) {
    const v = f[col];
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    if (v === NONE) where += ` AND (${col} IS NULL OR ${col} = '')`;
    else { where += ` AND ${col} = ?`; params.push(v); }
  }
  return { where, params };
}

router.get('/leads', requireAuth, (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const { where, params } = leadFilter(req.query);
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM outreach_leads WHERE ${where}`).get(...params).cnt;
  const leads = db.prepare(`SELECT * FROM outreach_leads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(limit), Number(offset));
  res.json({ leads, total });
});

// GET /api/outreach/leads/facets — distinct industry / city / list values with counts
router.get('/leads/facets', requireAuth, (req, res) => {
  const facet = (col) => db.prepare(`
    SELECT ${col} AS value, COUNT(*) AS count FROM outreach_leads
    WHERE ${col} IS NOT NULL AND trim(${col}) != ''
    GROUP BY ${col} ORDER BY ${col} COLLATE NOCASE
  `).all();
  const none = (col) => db.prepare(`SELECT COUNT(*) AS c FROM outreach_leads WHERE ${col} IS NULL OR trim(${col}) = ''`).get().c;
  res.json({
    industries: facet('industry'), cities: facet('city'), lists: facet('list_name'),
    none: { industry: none('industry'), city: none('city'), list_name: none('list_name') },
  });
});

router.post('/leads', requireAuth, (req, res) => {
  const { company_name, first_name, last_name, email, phone, website, industry, city, country, status } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const result = db.prepare(`
    INSERT INTO outreach_leads (company_name, first_name, last_name, email, phone, website, industry, city, country, status)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(company_name || '', first_name || '', last_name || '', email, phone || '', website || '', industry || '', city || '', country || '', status || 'new');
  res.status(201).json({ id: result.lastInsertRowid });
});

// POST /api/outreach/leads/import-csv — multipart file field "file"
// Expected header row (case-insensitive, any order): company_name,first_name,last_name,email,phone,website,industry,city,country
router.post('/leads/import-csv', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (field name: file)' });

  const rows = parseCsv(req.file.buffer.toString('utf8'));
  if (!rows.length) return res.status(400).json({ error: 'empty CSV' });

  const header = rows[0].map(h => h.trim().toLowerCase());
  const colIndex = (name) => header.indexOf(name);
  const cols = ['company_name', 'first_name', 'last_name', 'email', 'phone', 'website', 'industry', 'city', 'country'];
  const idx = Object.fromEntries(cols.map(c => [c, colIndex(c)]));

  const insert = db.prepare(`
    INSERT INTO outreach_leads (company_name, first_name, last_name, email, phone, website, industry, city, country, status)
    VALUES (?,?,?,?,?,?,?,?,?,'new')
  `);

  let inserted = 0, skipped = 0;
  const tx = db.transaction((dataRows) => {
    for (const r of dataRows) {
      const get = (c) => (idx[c] >= 0 ? (r[idx[c]] || '').trim() : '');
      const email = get('email');
      if (!email) { skipped++; continue; }
      insert.run(get('company_name'), get('first_name'), get('last_name'), email, get('phone'), get('website'), get('industry'), get('city'), get('country'));
      inserted++;
    }
  });
  tx(rows.slice(1));

  res.json({ inserted, skipped, total: rows.length - 1 });
});

// POST /api/outreach/leads/import — body: { rows: [{ email, first_name, ... }] }
// (CSV is parsed + column-mapped in the browser.) Skips invalid emails,
// duplicates (existing leads or repeated in the file) and suppressed emails.
router.post('/leads/import', requireAuth, (req, res) => {
  const { rows } = req.body;
  const listName = String(req.body.list_name ?? '').trim().slice(0, 200);
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
  if (rows.length > 20000) return res.status(400).json({ error: 'max 20000 rows per import' });

  const fields = ['company_name', 'first_name', 'last_name', 'email', 'phone', 'website', 'industry', 'city', 'country'];
  const existing = new Set(db.prepare("SELECT lower(email) AS e FROM outreach_leads WHERE email IS NOT NULL AND email != ''").all().map(r => r.e));
  const suppressed = new Set(db.prepare('SELECT lower(email) AS e FROM outreach_suppressions').all().map(r => r.e));
  const insert = db.prepare(`
    INSERT INTO outreach_leads (company_name, first_name, last_name, email, phone, website, industry, city, country, list_name, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'new')
  `);
  const skipped = { invalid: 0, duplicate: 0, suppressed: 0 };
  let imported = 0;

  db.transaction(() => {
    for (const r of rows) {
      const get = (k) => String(r[k] ?? '').trim();
      const email = get('email').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped.invalid++; continue; }
      if (suppressed.has(email)) { skipped.suppressed++; continue; }
      if (existing.has(email)) { skipped.duplicate++; continue; }
      existing.add(email);
      insert.run(...fields.map(k => (k === 'email' ? email : get(k))), listName);
      imported++;
    }
  })();

  res.json({ imported, skipped: skipped.invalid + skipped.duplicate + skipped.suppressed, skipped_by_reason: skipped, total: rows.length });
});

router.put('/leads/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_leads WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const fields = ['company_name', 'first_name', 'last_name', 'email', 'phone', 'website', 'industry', 'city', 'country', 'list_name', 'status'];
  const present = fields.filter(f => req.body[f] !== undefined);
  if (!present.length) return res.status(400).json({ error: 'nothing to update' });
  const setClause = present.map(f => `${f} = ?`).concat('updated_at = (datetime(\'now\'))').join(', ');
  db.prepare(`UPDATE outreach_leads SET ${setClause} WHERE id = ?`).run(...present.map(f => req.body[f]), id);
  res.json({ ok: true });
});

router.delete('/leads/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM outreach_leads WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/leads/:id/unsubscribe', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lead = db.prepare('SELECT * FROM outreach_leads WHERE id = ?').get(id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const cancelled = common.stopLead(id, 'unsubscribed', { suppress: true, reason: 'unsubscribe' });
  res.json({ ok: true, cancelled });
});

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────

router.get('/campaigns', requireAuth, (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM outreach_campaign_leads cl WHERE cl.campaign_id = c.id) AS lead_count,
      (SELECT COUNT(*) FROM outreach_campaign_mailboxes cm WHERE cm.campaign_id = c.id) AS mailbox_count,
      (SELECT COUNT(*) FROM outreach_sequences s WHERE s.campaign_id = c.id) AS step_count,
      (SELECT COUNT(*) FROM outreach_email_queue q WHERE q.campaign_id = c.id AND q.sent_at IS NOT NULL) AS sent,
      (SELECT COUNT(DISTINCT q.lead_id) FROM outreach_email_queue q WHERE q.campaign_id = c.id AND q.sent_at IS NOT NULL) AS contacted,
      (SELECT COUNT(DISTINCT r.lead_id) FROM outreach_replies r JOIN outreach_email_queue q ON q.id = r.queue_id
        WHERE q.campaign_id = c.id AND r.is_bounce = 0) AS replies,
      (SELECT COUNT(DISTINCT r.lead_id) FROM outreach_replies r JOIN outreach_email_queue q ON q.id = r.queue_id
        WHERE q.campaign_id = c.id AND r.is_bounce = 0 AND r.sentiment = 'positive') AS positive
    FROM outreach_campaigns c ORDER BY c.created_at DESC
  `).all();
  for (const c of campaigns) c.reply_rate = c.contacted ? Math.round(c.replies / c.contacted * 1000) / 10 : 0;
  res.json({ campaigns });
});

router.get('/campaigns/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  campaign.mailbox_ids = db.prepare('SELECT mailbox_id FROM outreach_campaign_mailboxes WHERE campaign_id = ?').all(id).map(r => r.mailbox_id);
  res.json({ campaign });
});

// PUT /api/outreach/campaigns/:id/mailboxes — body: { mailbox_ids: [...] } replaces the assignment
router.put('/campaigns/:id/mailboxes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  const { mailbox_ids } = req.body;
  if (!Array.isArray(mailbox_ids)) return res.status(400).json({ error: 'mailbox_ids array required' });
  db.transaction(() => {
    db.prepare('DELETE FROM outreach_campaign_mailboxes WHERE campaign_id = ?').run(id);
    const ins = db.prepare('INSERT INTO outreach_campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)');
    for (const mid of new Set(mailbox_ids.map(Number))) ins.run(id, mid);
  })();
  res.json({ ok: true });
});

router.get('/campaigns/:id/leads', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const leads = db.prepare(`
    SELECT cl.id, cl.status, cl.added_at, l.id AS lead_id, l.email, l.first_name, l.last_name,
      l.company_name, l.city, l.status AS lead_status,
      (SELECT COUNT(*) FROM outreach_email_queue q
        WHERE q.campaign_id = cl.campaign_id AND q.lead_id = cl.lead_id AND q.sent_at IS NOT NULL) AS sent_count,
      (SELECT MIN(q.scheduled_at) FROM outreach_email_queue q
        WHERE q.campaign_id = cl.campaign_id AND q.lead_id = cl.lead_id AND q.status = 'pending') AS next_at
    FROM outreach_campaign_leads cl
    LEFT JOIN outreach_leads l ON l.id = cl.lead_id
    WHERE cl.campaign_id = ?
    ORDER BY cl.id DESC
  `).all(id);
  res.json({ leads });
});

router.get('/campaigns/:id/step-stats', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const steps = db.prepare(`
    SELECT s.id, s.step_number, s.subject,
      (SELECT COUNT(*) FROM outreach_email_queue q WHERE q.sequence_id = s.id AND q.sent_at IS NOT NULL) AS sent,
      (SELECT COUNT(*) FROM outreach_email_queue q WHERE q.sequence_id = s.id AND q.status = 'bounced') AS bounced,
      (SELECT COUNT(*) FROM outreach_email_queue q WHERE q.sequence_id = s.id AND q.status = 'pending') AS pending,
      (SELECT COUNT(DISTINCT r.lead_id) FROM outreach_replies r JOIN outreach_email_queue q ON q.id = r.queue_id
        WHERE q.sequence_id = s.id AND r.is_bounce = 0) AS replied,
      (SELECT COUNT(DISTINCT r.lead_id) FROM outreach_replies r JOIN outreach_email_queue q ON q.id = r.queue_id
        WHERE q.sequence_id = s.id AND r.is_bounce = 0 AND r.sentiment = 'positive') AS positive
    FROM outreach_sequences s WHERE s.campaign_id = ? ORDER BY s.step_number
  `).all(id);
  res.json({ steps });
});

// GET /api/outreach/campaigns/:id/start-summary — numbers for the Start confirmation
router.get('/campaigns/:id/start-summary', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'not found' });

  const leads = db.prepare("SELECT COUNT(*) AS c FROM outreach_campaign_leads WHERE campaign_id = ? AND status IN ('pending','queued')").get(id).c;
  const steps = db.prepare('SELECT step_number, delay_days FROM outreach_sequences WHERE campaign_id = ? ORDER BY step_number').all(id);
  const mailboxes = db.prepare(`
    SELECT m.* FROM outreach_campaign_mailboxes cm JOIN outreach_mailboxes m ON m.id = cm.mailbox_id
    WHERE cm.campaign_id = ?
  `).all(id);
  const sendable = mailboxes.filter(m => ['active', 'warmup'].includes(m.status));

  // Daily capacity: mailbox caps, then campaign + system caps (9 sending hours/day)
  let perDay = sendable.reduce((sum, m) => sum + (effectiveLimit(m) || 0), 0);
  if (campaign.daily_limit) perDay = Math.min(perDay, campaign.daily_limit);
  const systemHourly = parseInt(common.getSetting('hourly_system_limit', '50'), 10) || 0;
  perDay = Math.min(perDay, systemHourly * 9);

  const totalEmails = leads * steps.length;
  const delayDays = steps.slice(1).reduce((sum, s) => sum + (s.delay_days || 0), 0);
  const sendingWorkdays = perDay > 0 ? Math.ceil(totalEmails / perDay) : null;
  // Workdays → calendar days (5 of 7), plus the follow-up delays for the last batch
  const estimatedDays = sendingWorkdays === null ? null : Math.ceil(sendingWorkdays * 7 / 5) + delayDays;

  const warnings = [];
  if (!steps.length) warnings.push('Campaign has no sequence steps.');
  if (!leads) warnings.push('No pending leads in this campaign.');
  if (!sendable.length) warnings.push('No active or warmup mailboxes assigned.');
  if (sendable.some(m => !m.smtp_pass || !m.smtp_host)) warnings.push('Some assigned mailboxes have no SMTP host/password.');
  if (common.getSetting('dry_run', 'true') !== 'false') warnings.push('DRY RUN is on — nothing will actually be sent.');
  if (common.getSetting('global_paused', 'false') === 'true') warnings.push('All outreach is globally paused.');

  res.json({
    leads, steps: steps.length, mailboxes: sendable.length, assigned_mailboxes: mailboxes.length,
    per_day: perDay, total_emails: totalEmails, estimated_days: estimatedDays, warnings,
  });
});

// POST /api/outreach/campaigns/:id/preview — body: { lead_id, subject, body_html, body_text }
router.post('/campaigns/:id/preview', requireAuth, (req, res) => {
  const { lead_id, subject, body_html, body_text } = req.body;
  const lead = lead_id
    ? db.prepare('SELECT * FROM outreach_leads WHERE id = ?').get(parseInt(lead_id, 10))
    : db.prepare(`
        SELECT l.* FROM outreach_campaign_leads cl JOIN outreach_leads l ON l.id = cl.lead_id
        WHERE cl.campaign_id = ? ORDER BY cl.id LIMIT 1
      `).get(parseInt(req.params.id, 10)) || db.prepare('SELECT * FROM outreach_leads ORDER BY id LIMIT 1').get();
  if (!lead) return res.status(400).json({ error: 'no leads to preview with' });
  res.json({
    lead: { id: lead.id, email: lead.email, first_name: lead.first_name, company_name: lead.company_name, city: lead.city },
    subject: common.render(subject, lead, false),
    html: body_html ? common.render(body_html, lead, true) : null,
    text: body_text ? common.render(body_text, lead, false) : (body_html ? common.htmlToText(common.render(body_html, lead, false)) : ''),
  });
});

router.post('/campaigns', requireAuth, (req, res) => {
  const { name, status, daily_limit, track_opens, track_clicks } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = db.prepare(`
    INSERT INTO outreach_campaigns (name, status, daily_limit, track_opens, track_clicks)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, status || 'draft', daily_limit ?? null, track_opens === false ? 0 : 1, track_clicks === false ? 0 : 1);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/campaigns/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const fields = ['name', 'status', 'daily_limit', 'track_opens', 'track_clicks'];
  const present = fields.filter(f => req.body[f] !== undefined);
  if (!present.length) return res.status(400).json({ error: 'nothing to update' });
  const setClause = present.map(f => `${f} = ?`).concat('updated_at = (datetime(\'now\'))').join(', ');
  db.prepare(`UPDATE outreach_campaigns SET ${setClause} WHERE id = ?`).run(...present.map(f => req.body[f]), id);
  res.json({ ok: true });
});

router.delete('/campaigns/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM outreach_campaign_leads WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM outreach_campaign_mailboxes WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM outreach_sequences WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM outreach_email_queue WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM outreach_campaigns WHERE id = ?').run(id);
  });
  tx();
  res.json({ ok: true });
});

router.post('/campaigns/:id/start', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE outreach_campaigns SET status = 'active', updated_at = (datetime('now')) WHERE id = ?").run(id);
  res.json({ ok: true });
});

router.post('/campaigns/:id/pause', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE outreach_campaigns SET status = 'paused', updated_at = (datetime('now')) WHERE id = ?").run(id);
  res.json({ ok: true });
});

// POST /api/outreach/campaigns/:id/leads — body: { lead_ids: [1,2,3] }
router.post('/campaigns/:id/leads', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  const { lead_ids } = req.body;
  if (!Array.isArray(lead_ids) || !lead_ids.length) return res.status(400).json({ error: 'lead_ids array required' });

  const exists = db.prepare('SELECT id FROM outreach_campaign_leads WHERE campaign_id = ? AND lead_id = ?');
  const insert = db.prepare("INSERT INTO outreach_campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'pending')");
  let added = 0, skipped = 0;
  const tx = db.transaction((ids) => {
    for (const leadId of ids) {
      if (exists.get(id, leadId)) { skipped++; continue; }
      insert.run(id, leadId);
      added++;
    }
  });
  tx(lead_ids);
  res.json({ added, skipped });
});

// POST /api/outreach/campaigns/:id/leads-by-filter — body: { status, search, industry, city, list_name }
// Adds every lead matching the filter, skipping leads already in the campaign
// and suppressed emails. Runs entirely server-side (not limited to one page).
router.post('/campaigns/:id/leads-by-filter', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  const { where, params } = leadFilter(req.body || {});

  const result = db.transaction(() => {
    const matched = db.prepare(`SELECT COUNT(*) AS c FROM outreach_leads WHERE ${where}`).get(...params).c;
    const already = db.prepare(`
      SELECT COUNT(*) AS c FROM outreach_leads l WHERE ${where}
        AND EXISTS (SELECT 1 FROM outreach_campaign_leads cl WHERE cl.campaign_id = ? AND cl.lead_id = l.id)
    `).get(...params, id).c;
    const suppressed = db.prepare(`
      SELECT COUNT(*) AS c FROM outreach_leads l WHERE ${where}
        AND NOT EXISTS (SELECT 1 FROM outreach_campaign_leads cl WHERE cl.campaign_id = ? AND cl.lead_id = l.id)
        AND EXISTS (SELECT 1 FROM outreach_suppressions s WHERE lower(s.email) = lower(l.email))
    `).get(...params, id).c;
    const added = db.prepare(`
      INSERT INTO outreach_campaign_leads (campaign_id, lead_id, status)
      SELECT ?, l.id, 'pending' FROM outreach_leads l WHERE ${where}
        AND NOT EXISTS (SELECT 1 FROM outreach_campaign_leads cl WHERE cl.campaign_id = ? AND cl.lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM outreach_suppressions s WHERE lower(s.email) = lower(l.email))
    `).run(id, ...params, id).changes;
    return { matched, added, skipped_existing: already, skipped_suppressed: suppressed };
  })();
  res.json(result);
});

router.delete('/campaigns/:id/leads/:leadId', requireAuth, (req, res) => {
  const { id, leadId } = req.params;
  db.transaction(() => {
    db.prepare('DELETE FROM outreach_campaign_leads WHERE campaign_id = ? AND lead_id = ?')
      .run(parseInt(id, 10), parseInt(leadId, 10));
    db.prepare("UPDATE outreach_email_queue SET status = 'cancelled', error_message = 'removed from campaign' WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'")
      .run(parseInt(id, 10), parseInt(leadId, 10));
  })();
  res.json({ ok: true });
});

// POST /api/outreach/campaigns/:id/mailboxes — body: { mailbox_ids: [1,2] }
router.post('/campaigns/:id/mailboxes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  const { mailbox_ids } = req.body;
  if (!Array.isArray(mailbox_ids) || !mailbox_ids.length) return res.status(400).json({ error: 'mailbox_ids array required' });

  const exists = db.prepare('SELECT id FROM outreach_campaign_mailboxes WHERE campaign_id = ? AND mailbox_id = ?');
  const insert = db.prepare('INSERT INTO outreach_campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)');
  let added = 0, skipped = 0;
  const tx = db.transaction((ids) => {
    for (const mailboxId of ids) {
      if (exists.get(id, mailboxId)) { skipped++; continue; }
      insert.run(id, mailboxId);
      added++;
    }
  });
  tx(mailbox_ids);
  res.json({ added, skipped });
});

router.get('/campaigns/:id/stats', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'not found' });

  const leadStatusRows = db.prepare(
    'SELECT status, COUNT(*) AS cnt FROM outreach_campaign_leads WHERE campaign_id = ? GROUP BY status'
  ).all(id);
  const queueStatusRows = db.prepare(
    'SELECT status, COUNT(*) AS cnt FROM outreach_email_queue WHERE campaign_id = ? GROUP BY status'
  ).all(id);
  const opens = db.prepare(
    'SELECT COALESCE(SUM(open_count), 0) AS opens FROM outreach_email_queue WHERE campaign_id = ?'
  ).get(id).opens;
  const replies = db.prepare(`
    SELECT COUNT(*) AS cnt FROM outreach_replies r
    JOIN outreach_email_queue q ON q.id = r.queue_id
    WHERE q.campaign_id = ?
  `).get(id).cnt;

  const toMap = (rows) => Object.fromEntries(rows.map(r => [r.status, r.cnt]));
  res.json({
    campaign,
    leads_by_status: toMap(leadStatusRows),
    queue_by_status: toMap(queueStatusRows),
    opens,
    replies,
  });
});

// ── SEQUENCES ────────────────────────────────────────────────────────────────

router.get('/campaigns/:id/sequences', requireAuth, (req, res) => {
  const sequences = db.prepare(
    'SELECT * FROM outreach_sequences WHERE campaign_id = ? ORDER BY step_number ASC'
  ).all(parseInt(req.params.id, 10));
  res.json({ sequences });
});

router.post('/campaigns/:id/sequences', requireAuth, (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT id FROM outreach_campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  const { step_number, subject, body_html, body_text, delay_days } = req.body;
  if (!step_number) return res.status(400).json({ error: 'step_number required' });
  const result = db.prepare(`
    INSERT INTO outreach_sequences (campaign_id, step_number, subject, body_html, body_text, delay_days)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(campaignId, step_number, subject || '', body_html || '', body_text || '', delay_days ?? 0);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/sequences/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_sequences WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const updated = buildUpdate('outreach_sequences', id, req.body, ['step_number', 'subject', 'body_html', 'body_text', 'delay_days']);
  if (!updated) return res.status(400).json({ error: 'nothing to update' });
  res.json({ ok: true });
});

router.delete('/sequences/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM outreach_sequences WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ── QUEUE & STATS ────────────────────────────────────────────────────────────

router.get('/queue', requireAuth, (req, res) => {
  const { status, campaign_id, mailbox_id, limit = 50, offset = 0 } = req.query;
  let q = `
    SELECT q.*, l.email AS lead_email, l.company_name AS lead_company, c.name AS campaign_name
    FROM outreach_email_queue q
    LEFT JOIN outreach_leads l ON l.id = q.lead_id
    LEFT JOIN outreach_campaigns c ON c.id = q.campaign_id
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== 'all') { q += ' AND q.status = ?'; params.push(status); }
  if (campaign_id) { q += ' AND q.campaign_id = ?'; params.push(parseInt(campaign_id, 10)); }
  if (mailbox_id) { q += ' AND q.mailbox_id = ?'; params.push(parseInt(mailbox_id, 10)); }
  q += ' ORDER BY q.scheduled_at ASC LIMIT ? OFFSET ?';
  const queue = db.prepare(q).all(...params, Number(limit), Number(offset));
  res.json({ queue });
});

router.post('/queue/pause-all', requireAuth, (req, res) => {
  common.setSetting('global_paused', 'true');
  common.workerLog('warn', 'ALL OUTREACH PAUSED from the UI');
  res.json({ ok: true });
});

router.post('/queue/resume-all', requireAuth, (req, res) => {
  common.setSetting('global_paused', 'false');
  common.workerLog('info', 'outreach resumed from the UI');
  res.json({ ok: true });
});

// POST /api/outreach/settings/dry-run — body: { dry_run: true|false }
router.post('/settings/dry-run', requireAuth, (req, res) => {
  if (typeof req.body.dry_run !== 'boolean') return res.status(400).json({ error: 'dry_run boolean required' });
  common.setSetting('dry_run', req.body.dry_run ? 'true' : 'false');
  common.workerLog('warn', req.body.dry_run ? 'DRY RUN turned ON from the UI' : 'DRY RUN turned OFF from the UI — live sending enabled');
  res.json({ ok: true });
});

router.get('/dashboard', requireAuth, (req, res) => {
  const today = toSql(localDayStart());
  const week  = toSql(localWeekStart());
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;

  const sentTotal = count('SELECT COUNT(*) AS c FROM outreach_email_queue WHERE sent_at IS NOT NULL');
  const bounces   = count("SELECT COUNT(*) AS c FROM outreach_email_queue WHERE status = 'bounced'");
  const kpis = {
    sent_today:   count('SELECT COUNT(*) AS c FROM outreach_email_queue WHERE sent_at >= ?', today),
    sent_week:    count('SELECT COUNT(*) AS c FROM outreach_email_queue WHERE sent_at >= ?', week),
    sent_total:   sentTotal,
    replies:      count('SELECT COUNT(*) AS c FROM outreach_replies WHERE is_bounce = 0'),
    positive:     count("SELECT COUNT(*) AS c FROM outreach_replies WHERE is_bounce = 0 AND sentiment = 'positive'"),
    untagged:     count('SELECT COUNT(*) AS c FROM outreach_replies WHERE is_bounce = 0 AND sentiment IS NULL'),
    bounces,
    bounce_rate:  sentTotal ? Math.round(bounces / sentTotal * 1000) / 10 : 0,
    unsubscribes: count("SELECT COUNT(*) AS c FROM outreach_suppressions WHERE reason = 'unsubscribe'"),
    pending:      count("SELECT COUNT(*) AS c FROM outreach_email_queue WHERE status = 'pending'"),
  };

  const mailboxes = db.prepare(`
    SELECT m.id, m.email, m.status, m.warmup_mode, m.warmup_day, m.warmup_daily_limit, m.warmup_start_limit,
      m.daily_limit, m.bounce_rate, m.pause_reason, m.imap_last_check_at,
      (SELECT COUNT(*) FROM outreach_email_queue q WHERE q.mailbox_id = m.id AND q.sent_at >= ?) AS sent_today,
      (SELECT message FROM outreach_worker_log w WHERE w.mailbox_id = m.id AND w.level = 'error' ORDER BY w.id DESC LIMIT 1) AS last_error,
      (SELECT timestamp FROM outreach_worker_log w WHERE w.mailbox_id = m.id AND w.level = 'error' ORDER BY w.id DESC LIMIT 1) AS last_error_at
    FROM outreach_mailboxes m ORDER BY m.email
  `).all(today).map(m => ({ ...m, effective_limit: effectiveLimit(m) }));

  res.json({
    settings: {
      global_paused: common.getSetting('global_paused', 'false') === 'true',
      dry_run: common.getSetting('dry_run', 'true') !== 'false',
    },
    kpis,
    mailboxes,
  });
});

// ── REPLIES (Inbox) ──────────────────────────────────────────────────────────

const SENTIMENTS = ['positive', 'neutral', 'negative', 'unsubscribe'];

router.get('/replies', requireAuth, (req, res) => {
  const { sentiment, bounces, limit = 50, offset = 0 } = req.query;
  let where = bounces === 'only' ? 'r.is_bounce = 1' : 'r.is_bounce = 0';
  const params = [];
  if (sentiment === 'untagged') where += ' AND r.sentiment IS NULL';
  else if (sentiment && sentiment !== 'all') { where += ' AND r.sentiment = ?'; params.push(sentiment); }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM outreach_replies r WHERE ${where}`).get(...params).c;
  const replies = db.prepare(`
    SELECT r.*, l.email AS lead_email, l.first_name, l.last_name, l.company_name, l.phone AS lead_phone,
      l.city, l.status AS lead_status, q.campaign_id, c.name AS campaign_name, m.email AS mailbox_email
    FROM outreach_replies r
    LEFT JOIN outreach_leads l ON l.id = r.lead_id
    LEFT JOIN outreach_email_queue q ON q.id = r.queue_id
    LEFT JOIN outreach_campaigns c ON c.id = q.campaign_id
    LEFT JOIN outreach_mailboxes m ON m.id = r.mailbox_id
    WHERE ${where}
    ORDER BY COALESCE(r.received_at, r.created_at) DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.min(Number(limit) || 50, 500), Number(offset) || 0);
  res.json({ replies, total });
});

// PUT /api/outreach/replies/:id — body: { sentiment?, deal_id? }
router.put('/replies/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reply = db.prepare('SELECT * FROM outreach_replies WHERE id = ?').get(id);
  if (!reply) return res.status(404).json({ error: 'not found' });
  const { sentiment, deal_id } = req.body;
  if (sentiment !== undefined) {
    if (sentiment !== null && !SENTIMENTS.includes(sentiment)) return res.status(400).json({ error: 'invalid sentiment' });
    db.prepare('UPDATE outreach_replies SET sentiment = ? WHERE id = ?').run(sentiment, id);
    if (sentiment === 'unsubscribe' && reply.lead_id) {
      common.stopLead(reply.lead_id, 'unsubscribed', { suppress: true, reason: 'unsubscribe' });
    }
  }
  if (deal_id !== undefined) db.prepare('UPDATE outreach_replies SET deal_id = ? WHERE id = ?').run(deal_id, id);
  res.json({ ok: true });
});

router.get('/stats', requireAuth, (req, res) => {
  const count = (sql, ...args) => db.prepare(sql).get(...args).cnt;
  const byStatus = (table) => Object.fromEntries(
    db.prepare(`SELECT status, COUNT(*) AS cnt FROM ${table} GROUP BY status`).all().map(r => [r.status, r.cnt])
  );
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM outreach_system_settings').all().map(r => [r.key, r.value]));

  res.json({
    domains: count('SELECT COUNT(*) AS cnt FROM outreach_domains'),
    mailboxes_by_status: byStatus('outreach_mailboxes'),
    leads_by_status: byStatus('outreach_leads'),
    campaigns_by_status: byStatus('outreach_campaigns'),
    queue_by_status: byStatus('outreach_email_queue'),
    replies: count('SELECT COUNT(*) AS cnt FROM outreach_replies'),
    suppressions: count('SELECT COUNT(*) AS cnt FROM outreach_suppressions'),
    settings,
  });
});

// ── SUPPRESSIONS ─────────────────────────────────────────────────────────────

router.get('/suppressions', requireAuth, (req, res) => {
  const suppressions = db.prepare('SELECT * FROM outreach_suppressions ORDER BY created_at DESC').all();
  res.json({ suppressions });
});

router.post('/suppressions', requireAuth, (req, res) => {
  const { email, reason } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  db.prepare('INSERT OR IGNORE INTO outreach_suppressions (email, reason) VALUES (?, ?)').run(email, reason || 'manual');
  res.status(201).json({ ok: true });
});

router.delete('/suppressions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM outreach_suppressions WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ── WORKER LOG ───────────────────────────────────────────────────────────────

// GET /api/outreach/worker-log?level=error&mailbox_id=3&since_id=120&limit=100
router.get('/worker-log', requireAuth, (req, res) => {
  const { level, mailbox_id, since_id, limit = 100, offset = 0 } = req.query;
  let q = 'SELECT * FROM outreach_worker_log WHERE 1=1';
  const params = [];
  if (level && level !== 'all') { q += ' AND level = ?'; params.push(level); }
  if (mailbox_id) { q += ' AND mailbox_id = ?'; params.push(parseInt(mailbox_id, 10)); }
  if (since_id) { q += ' AND id > ?'; params.push(parseInt(since_id, 10)); }
  q += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const log = db.prepare(q).all(...params, Math.min(Number(limit) || 100, 1000), Number(offset) || 0);
  res.json({ log });
});

module.exports = router;
