'use strict';

const express     = require('express');
const router      = express.Router();
const net         = require('net');
const tls         = require('tls');
const multer      = require('multer');
const requireAuth = require('../middleware/auth');
const db          = require('../database');

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
  return { ...rest, has_smtp_pass: !!smtp_pass, has_imap_pass: !!imap_pass };
}

router.get('/mailboxes', requireAuth, (req, res) => {
  const { domain_id, status } = req.query;
  let q = 'SELECT * FROM outreach_mailboxes WHERE 1=1';
  const params = [];
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
    smtp_host || '', smtp_port ?? null, smtp_user || '', smtp_pass || '',
    imap_host || '', imap_port ?? null, imap_user || '', imap_pass || '',
    daily_limit ?? 30, hourly_limit ?? 5, warmup_mode === false ? 0 : 1, warmup_day ?? 0,
    warmup_start_limit ?? 3, warmup_end_limit ?? 30, status || 'warmup',
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/mailboxes/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_mailboxes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const updated = buildUpdate('outreach_mailboxes', id, req.body, [
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
  db.prepare('DELETE FROM outreach_mailboxes WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// POST /api/outreach/mailboxes/:id/test-smtp — connectivity check only (see testBanner note above)
router.post('/mailboxes/:id/test-smtp', requireAuth, async (req, res) => {
  const mailbox = db.prepare('SELECT smtp_host, smtp_port FROM outreach_mailboxes WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!mailbox) return res.status(404).json({ error: 'not found' });
  const useTls = Number(mailbox.smtp_port) === 465;
  const result = await testBanner(mailbox.smtp_host, mailbox.smtp_port, useTls);
  result.note = 'connectivity check only — sending a real test email requires an SMTP client library, not yet installed';
  res.json(result);
});

// POST /api/outreach/mailboxes/:id/test-imap — connectivity check only
router.post('/mailboxes/:id/test-imap', requireAuth, async (req, res) => {
  const mailbox = db.prepare('SELECT imap_host, imap_port FROM outreach_mailboxes WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!mailbox) return res.status(404).json({ error: 'not found' });
  const useTls = Number(mailbox.imap_port) === 993;
  const result = await testBanner(mailbox.imap_host, mailbox.imap_port, useTls);
  res.json(result);
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
  db.prepare('UPDATE outreach_mailboxes SET status = ? WHERE id = ?').run(row.warmup_mode ? 'warmup' : 'active', id);
  res.json({ ok: true });
});

// ── LEADS ────────────────────────────────────────────────────────────────────

router.get('/leads', requireAuth, (req, res) => {
  const { search, status, limit = 50, offset = 0 } = req.query;
  let q = 'SELECT * FROM outreach_leads WHERE 1=1';
  let countQ = 'SELECT COUNT(*) AS cnt FROM outreach_leads WHERE 1=1';
  const params = [];
  if (status && status !== 'all') {
    q += ' AND status = ?'; countQ += ' AND status = ?'; params.push(status);
  }
  if (search) {
    const clause = ' AND (company_name LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)';
    q += clause; countQ += clause;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  const total = db.prepare(countQ).get(...params).cnt;
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const leads = db.prepare(q).all(...params, Number(limit), Number(offset));
  res.json({ leads, total });
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

router.put('/leads/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM outreach_leads WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const fields = ['company_name', 'first_name', 'last_name', 'email', 'phone', 'website', 'industry', 'city', 'country', 'status'];
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
  db.prepare("UPDATE outreach_leads SET status = 'unsubscribed', updated_at = (datetime('now')) WHERE id = ?").run(id);
  if (lead.email) {
    db.prepare('INSERT OR IGNORE INTO outreach_suppressions (email, reason) VALUES (?, ?)').run(lead.email, 'unsubscribe');
  }
  res.json({ ok: true });
});

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────

router.get('/campaigns', requireAuth, (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM outreach_campaign_leads cl WHERE cl.campaign_id = c.id) AS lead_count,
      (SELECT COUNT(*) FROM outreach_campaign_mailboxes cm WHERE cm.campaign_id = c.id) AS mailbox_count
    FROM outreach_campaigns c ORDER BY c.created_at DESC
  `).all();
  res.json({ campaigns });
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

router.delete('/campaigns/:id/leads/:leadId', requireAuth, (req, res) => {
  const { id, leadId } = req.params;
  db.prepare('DELETE FROM outreach_campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .run(parseInt(id, 10), parseInt(leadId, 10));
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
  db.prepare("INSERT INTO outreach_system_settings (key, value) VALUES ('global_paused', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
  res.json({ ok: true });
});

router.post('/queue/resume-all', requireAuth, (req, res) => {
  db.prepare("INSERT INTO outreach_system_settings (key, value) VALUES ('global_paused', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'").run();
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

module.exports = router;
