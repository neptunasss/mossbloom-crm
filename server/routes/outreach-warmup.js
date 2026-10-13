'use strict';

// /api/outreach/warmup — seed inboxes, per-mailbox warmup switch, placement stats

const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const db          = require('../database');
const common      = require('../services/outreach-common');
const { localDayStart, toSql } = require('../worker/time');
const { dailyTarget, rampDay, isForbiddenRecipient, probeSeedImap, RAMP_DAYS } = require('../worker/warmup');

const STATS_DAYS = 14;
const GOOGLE = { smtp_host: 'smtp.gmail.com', smtp_port: 465, imap_host: 'imap.gmail.com', imap_port: 993 };
const PROVIDERS = ['gmail', 'google_workspace', 'other_imap', 'receive_only'];
const CRED_FIELDS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'imap_host', 'imap_port', 'imap_user', 'imap_pass'];
const NOT_RECEIVE_ONLY = "AND w.seed_id NOT IN (SELECT id FROM outreach_warmup_seeds WHERE provider = 'receive_only')";

function redactSeed(s) {
  const { smtp_pass, imap_pass, ...rest } = s;
  return { ...rest, has_smtp_pass: !!smtp_pass, has_imap_pass: !!imap_pass };
}

const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);

// ── Overview (Warmup page) ───────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const dry = common.getSetting('dry_run', 'true') !== 'false';
  const since14 = toSql(new Date(Date.now() - STATS_DAYS * 86400000));
  const since7 = toSql(new Date(Date.now() - common.HEALTH.PLACEMENT_REPORT_DAYS * 86400000));
  const today = toSql(localDayStart());

  const mailboxes = db.prepare(`
    SELECT m.id, m.email, m.display_name, m.domain_id, d.domain, m.status, m.seed_warmup_enabled,
      m.seed_warmup_started_at, m.next_warmup_at, m.hourly_limit,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'out'
        AND w.sent_at >= ? AND (w.status = 'sent' OR (? = 1 AND w.status = 'dry_run'))) AS today,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ?) AS sent,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ? AND w.landed_in = 'inbox' ${NOT_RECEIVE_ONLY}) AS inbox,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ? AND w.landed_in = 'spam' ${NOT_RECEIVE_ONLY}) AS spam,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ? AND w.rescued_from_spam = 1 ${NOT_RECEIVE_ONLY}) AS rescued,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'reply' AND w.sent_at >= ?) AS replies,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.mailbox_id = m.id AND w.direction = 'out' AND w.status = 'failed' AND w.sent_at >= ?) AS failed
    FROM outreach_mailboxes m
    LEFT JOIN outreach_domains d ON d.id = m.domain_id
    ORDER BY d.domain, m.email
  `).all(today, dry ? 1 : 0, since14, since14, since14, since14, since14, since14).map(m => {
    const known = m.inbox + m.spam;
    return {
      ...m,
      target_today: m.seed_warmup_enabled ? dailyTarget(m) : 0,
      ramp_day: m.seed_warmup_enabled ? rampDay(m) : null,
      ramp_days: RAMP_DAYS,
      inbox_pct: pct(m.inbox, known),
      spam_pct: pct(m.spam, known),
    };
  });

  const domains = db.prepare(`
    SELECT d.id, d.domain,
      COALESCE(SUM(w.landed_in = 'inbox' AND w.seed_provider != 'receive_only'), 0) AS inbox,
      COALESCE(SUM(w.landed_in = 'spam' AND w.seed_provider != 'receive_only'), 0) AS spam,
      COUNT(w.id) AS sent
    FROM outreach_domains d
    LEFT JOIN outreach_mailboxes m ON m.domain_id = d.id
    LEFT JOIN (
      SELECT wm.*, COALESCE(s.provider, '') AS seed_provider FROM outreach_warmup_messages wm
      LEFT JOIN outreach_warmup_seeds s ON s.id = wm.seed_id
    ) w ON w.mailbox_id = m.id AND w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ?
    GROUP BY d.id ORDER BY d.domain
  `).all(since7).map(d => ({ ...d, placement: pct(d.inbox, d.inbox + d.spam) }));

  const seeds = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM outreach_warmup_messages w WHERE w.seed_id = s.id AND w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ?) AS received_14
    FROM outreach_warmup_seeds s ORDER BY s.email
  `).all(since14).map(redactSeed);

  res.json({
    settings: { warmup_enabled: common.getSetting('warmup_enabled', 'false') === 'true', dry_run: dry },
    thresholds: { placement_min: common.HEALTH.PLACEMENT_MIN * 100, placement_window_days: common.HEALTH.PLACEMENT_WINDOW_DAYS, report_days: common.HEALTH.PLACEMENT_REPORT_DAYS },
    stats_days: STATS_DAYS,
    mailboxes, domains, seeds,
  });
});

// POST /api/outreach/warmup/toggle — body: { enabled: boolean } (separate from the outreach pause)
router.post('/toggle', requireAuth, (req, res) => {
  if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled boolean required' });
  common.setSetting('warmup_enabled', req.body.enabled ? 'true' : 'false');
  common.workerLog('warn', `WARMUP turned ${req.body.enabled ? 'ON' : 'OFF'} from the UI`);
  res.json({ ok: true });
});

// PUT /api/outreach/warmup/mailboxes/:id — body: { enabled: boolean }
router.put('/mailboxes/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const m = db.prepare('SELECT id, email, seed_warmup_started_at FROM outreach_mailboxes WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled boolean required' });
  // The ramp starts the first time warmup is switched on and is kept afterwards
  db.prepare(`
    UPDATE outreach_mailboxes
    SET seed_warmup_enabled = ?, seed_warmup_started_at = COALESCE(seed_warmup_started_at, ?), next_warmup_at = NULL
    WHERE id = ?
  `).run(req.body.enabled ? 1 : 0, req.body.enabled ? toSql(new Date()) : null, id);
  common.workerLog('info', `warmup ${req.body.enabled ? 'enabled' : 'disabled'} for ${m.email}`, id);
  res.json({ ok: true });
});

// ── Seeds ────────────────────────────────────────────────────────────────────

const SEED_FIELDS = ['email', 'provider', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'imap_host', 'imap_port', 'imap_user', 'imap_pass', 'can_automate'];

function seedBody(body, isNew) {
  const out = {};
  for (const f of SEED_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  if (out.email !== undefined) out.email = String(out.email).trim().toLowerCase();
  if (out.provider !== undefined) out.provider = PROVIDERS.includes(out.provider) ? out.provider : 'other_imap';
  if (isNew && out.provider === undefined) out.provider = 'other_imap';
  if (out.can_automate !== undefined) out.can_automate = out.can_automate ? 1 : 0;
  for (const p of ['smtp_port', 'imap_port']) if (out[p] !== undefined) out[p] = out[p] === '' || out[p] === null ? null : parseInt(out[p], 10);

  if (out.provider === 'receive_only') {
    // No credentials, no engagement; wipe anything saved before
    for (const f of CRED_FIELDS) out[f] = null;
    out.can_automate = 0;
    out.spam_folder = null;
    return out;
  }
  if (isNew && (out.provider === 'gmail' || out.provider === 'google_workspace')) {
    for (const [k, v] of Object.entries(GOOGLE)) if (!out[k]) out[k] = v;
  }
  // Server or provider changed → spam folder must be detected again
  if (out.provider !== undefined || out.imap_host !== undefined) out.spam_folder = null;
  // Passwords: only when given; empty/omitted keeps the saved one
  for (const p of ['smtp_pass', 'imap_pass']) {
    if (!out[p]) delete out[p];
    else out[p] = common.encrypt(out[p]);
  }
  return out;
}

function validateSeedEmail(email, selfId = null) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return 'valid email required';
  if (isForbiddenRecipient(email)) return 'this address is a lead, on the suppression list or one of your mailboxes — seeds must be separate inboxes you own';
  const dup = db.prepare('SELECT id FROM outreach_warmup_seeds WHERE lower(email) = lower(?)').get(email);
  if (dup && dup.id !== selfId) return 'seed already exists';
  return null;
}

router.post('/seeds', requireAuth, (req, res) => {
  let s;
  try { s = seedBody(req.body, true); } catch (err) { return res.status(500).json({ error: err.message }); }
  const bad = validateSeedEmail(s.email);
  if (bad) return res.status(400).json({ error: bad });
  const cols = Object.keys(s);
  const r = db.prepare(`INSERT INTO outreach_warmup_seeds (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => s[c]));
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/seeds/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM outreach_warmup_seeds WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  let s;
  try { s = seedBody(req.body, false); } catch (err) { return res.status(500).json({ error: err.message }); }
  if (s.email !== undefined) {
    const bad = validateSeedEmail(s.email, id);
    if (bad) return res.status(400).json({ error: bad });
  }
  const cols = Object.keys(s);
  if (!cols.length) return res.status(400).json({ error: 'nothing to update' });
  db.prepare(`UPDATE outreach_warmup_seeds SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => s[c]), id);
  res.json({ ok: true });
});

router.delete('/seeds/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM outreach_warmup_seeds WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/seeds/:id/pause', requireAuth, (req, res) => {
  db.prepare("UPDATE outreach_warmup_seeds SET status = 'paused' WHERE id = ?").run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/seeds/:id/resume', requireAuth, (req, res) => {
  db.prepare("UPDATE outreach_warmup_seeds SET status = 'active', last_error = NULL, last_check_at = NULL WHERE id = ?").run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/seeds/:id/test-smtp', requireAuth, async (req, res) => {
  const s = db.prepare('SELECT * FROM outreach_warmup_seeds WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.provider === 'receive_only') return res.json({ ok: false, error: 'receive-only seeds have no SMTP access' });
  res.json(await common.testSmtpLogin(s));
});

router.post('/seeds/:id/test-imap', requireAuth, async (req, res) => {
  const s = db.prepare('SELECT * FROM outreach_warmup_seeds WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(await probeSeedImap(s)); // also detects + saves the spam folder
});

module.exports = router;
