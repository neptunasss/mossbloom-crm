'use strict';

// Shared by the web process (routes) and the outreach worker process.

const crypto = require('crypto');
const db     = require('../database');

// ── Auto-pause / health thresholds (worker + dashboard) ─────────────────────

const HEALTH = {
  SMTP_ERRORS_BEFORE_PAUSE: 3,  // consecutive SMTP errors → pause mailbox
  BOUNCE_WINDOW: 50,            // mailbox: look at its last 50 sends…
  BOUNCE_MIN_SENDS: 20,         // …but only judge once it has 20+
  BOUNCE_RATE_LIMIT: 0.03,      // > 3% → pause (mailbox and domain)
  BOUNCE_WATCH: 0.02,           // 2–3% → WATCH badge on the dashboard
  DOMAIN_WINDOW_DAYS: 7,        // domain: bounce rate over the last 7 days…
  DOMAIN_MIN_SENDS: 30,         // …judged once the domain has 30+ sends
  PLACEMENT_MIN: 0.70,          // warmup inbox placement < 70%…
  PLACEMENT_WINDOW_DAYS: 3,     // …over 3 days → pause campaigns on the domain
  PLACEMENT_MIN_SAMPLES: 10,    // …once 10+ warmup emails have a known placement
  PLACEMENT_REPORT_DAYS: 7,     // dashboard "Inbox placement %" window
};

// ── Encryption (AES-256-GCM) for smtp_pass / imap_pass ──────────────────────

const ENC_PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  // 64 hex chars → use as raw 32-byte key; anything else → SHA-256 of the string
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY is not set — refusing to store mailbox password');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(value) {
  if (!value) return value;
  if (!isEncrypted(value)) return value; // legacy plaintext (migrated on worker start)
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY is not set — cannot decrypt mailbox password');
  const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// Encrypt any plaintext passwords left over from before encryption existed.
function encryptExistingMailboxPasswords() {
  if (!getKey()) return 0;
  const rows = db.prepare('SELECT id, smtp_pass, imap_pass FROM outreach_mailboxes').all();
  const upd = db.prepare('UPDATE outreach_mailboxes SET smtp_pass = ?, imap_pass = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    if ((r.smtp_pass && !isEncrypted(r.smtp_pass)) || (r.imap_pass && !isEncrypted(r.imap_pass))) {
      upd.run(encrypt(r.smtp_pass), encrypt(r.imap_pass), r.id);
      n++;
    }
  }
  return n;
}

// ── Signed unsubscribe tokens ───────────────────────────────────────────────

function unsubscribeKey() {
  const key = getKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update('outreach-unsubscribe').digest();
}

function signLeadToken(leadId) {
  const key = unsubscribeKey();
  if (!key) throw new Error('ENCRYPTION_KEY is not set — cannot sign unsubscribe token');
  const sig = crypto.createHmac('sha256', key).update(String(leadId)).digest('base64url').slice(0, 22);
  return `${leadId}.${sig}`;
}

// Returns lead id or null
function verifyLeadToken(token) {
  const key = unsubscribeKey();
  if (!key || typeof token !== 'string') return null;
  const m = /^(\d+)\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const expected = crypto.createHmac('sha256', key).update(m[1]).digest('base64url').slice(0, 22);
  const a = Buffer.from(m[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return parseInt(m[1], 10);
}

function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

// ── Settings / log ──────────────────────────────────────────────────────────

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM outreach_system_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO outreach_system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

const insertLog = db.prepare('INSERT INTO outreach_worker_log (level, mailbox_id, message) VALUES (?, ?, ?)');

function workerLog(level, message, mailboxId = null) {
  try { insertLog.run(level, mailboxId, String(message).slice(0, 4000)); } catch (err) {
    console.error('worker log write failed:', err.message);
  }
  const line = `${level.toUpperCase()}${mailboxId ? ` [mb ${mailboxId}]` : ''} ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
}

// ── Template rendering (worker + UI preview) ────────────────────────────────

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// {{first_name}}, {{company_name}}, {{city}}; fallback per use: {{first_name|Sveiki}}
// or globally via outreach_system_settings key fallback_<token>.
function render(tpl, lead, html) {
  return String(tpl || '').replace(/\{\{\s*(first_name|company_name|city)\s*(?:\|([^}]*))?\}\}/g, (_, key, fb) => {
    let v = String(lead[key] || '').trim();
    if (!v) v = fb !== undefined ? fb.trim() : getSetting(`fallback_${key}`, '');
    return html ? escapeHtml(v) : v;
  });
}

function htmlToText(html) {
  return String(html)
    .replace(/<(br|\/p|\/div|\/h\d|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Lead stop events (reply / unsubscribe / bounce) ─────────────────────────

// Cancels ALL pending queue items for the lead across every campaign.
function cancelLeadQueue(leadId, reason) {
  const r = db.prepare(`
    UPDATE outreach_email_queue SET status = 'cancelled', error_message = ?
    WHERE lead_id = ? AND status = 'pending'
  `).run(reason, leadId);
  return r.changes;
}

// status: 'replied' | 'unsubscribed' | 'bounced'. Atomic.
const stopLead = db.transaction((leadId, status, { suppress = false, reason = status } = {}) => {
  const lead = db.prepare('SELECT id, email FROM outreach_leads WHERE id = ?').get(leadId);
  if (!lead) return 0;
  db.prepare("UPDATE outreach_leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, leadId);
  db.prepare(`UPDATE outreach_campaign_leads SET status = ? WHERE lead_id = ? AND status NOT IN ('replied','bounced','unsubscribed')`)
    .run(status, leadId);
  if (suppress && lead.email) {
    db.prepare('INSERT OR IGNORE INTO outreach_suppressions (email, reason) VALUES (?, ?)').run(lead.email.toLowerCase(), reason);
  }
  return cancelLeadQueue(leadId, `lead ${status}`);
});

// ── SMTP / IMAP login tests (mailboxes + warmup seeds) ──────────────────────
// cfg: { email, smtp_host, smtp_port, smtp_user, smtp_pass(encrypted), imap_* }

async function testSmtpLogin(cfg) {
  if (!cfg.smtp_host) return { ok: false, error: 'SMTP host not set' };
  const port = Number(cfg.smtp_port) || 587;
  try {
    const transporter = require('nodemailer').createTransport({
      host: cfg.smtp_host, port, secure: port === 465,
      auth: { user: cfg.smtp_user || cfg.email, pass: decrypt(cfg.smtp_pass) },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    await transporter.verify();
    transporter.close();
    return { ok: true, message: `Connected and logged in to ${cfg.smtp_host}:${port}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testImapLogin(cfg) {
  if (!cfg.imap_host) return { ok: false, error: 'IMAP host not set' };
  const port = Number(cfg.imap_port) || 993;
  let client;
  try {
    const { ImapFlow } = require('imapflow');
    client = new ImapFlow({
      host: cfg.imap_host, port, secure: port === 993,
      auth: { user: cfg.imap_user || cfg.email, pass: decrypt(cfg.imap_pass) },
      logger: false, socketTimeout: 20000,
    });
    client.on('error', () => {});
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    return { ok: true, message: `Logged in to ${cfg.imap_host}:${port} — INBOX has ${box.exists} messages` };
  } catch (err) {
    return { ok: false, error: err.responseText || err.message };
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

module.exports = {
  HEALTH,
  testSmtpLogin, testImapLogin,
  encrypt, decrypt, isEncrypted, encryptExistingMailboxPasswords,
  signLeadToken, verifyLeadToken, publicBaseUrl,
  getSetting, setSetting, workerLog,
  render, htmlToText, escapeHtml,
  cancelLeadQueue, stopLead,
};
