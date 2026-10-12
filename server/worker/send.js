'use strict';

const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const db         = require('../database');
const common     = require('../services/outreach-common');
const { inSendWindow, nextSendWindow, toSql } = require('./time');

const { workerLog: log, getSetting, render, htmlToText, escapeHtml } = common;

const SENDABLE_MAILBOX = ['active', 'warmup'];
const STOPPED_LEAD     = ['replied', 'bounced', 'unsubscribed'];
const MAX_PENDING_STEP1_PER_MAILBOX = 10;
const SMTP_ERRORS_BEFORE_PAUSE = 5;
const BOUNCE_WINDOW = 50;
const BOUNCE_RATE_LIMIT = 0.05;

const randomGapMs = () => (2 + Math.random() * 4) * 60000; // 2–6 min

// ── Limits (counted from real sent_at; in dry run, simulated sends count too) ─

function countSent(where, params, since, dry) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM outreach_email_queue q
    LEFT JOIN outreach_mailboxes m ON m.id = q.mailbox_id
    WHERE ${where} AND (q.sent_at >= ? OR (? = 1 AND q.dry_run_at >= ?))
  `).get(...params, since, dry ? 1 : 0, since).c;
}

const countMailbox  = (id, since, dry) => countSent('q.mailbox_id = ?', [id], since, dry);
const countDomain   = (id, since, dry) => countSent('m.domain_id = ?', [id], since, dry);
const countCampaign = (id, since, dry) => countSent('q.campaign_id = ?', [id], since, dry);
const countSystem   = (since, dry)     => countSent('1 = 1', [], since, dry);

function effectiveDailyLimit(mb) {
  return mb.warmup_mode ? (mb.warmup_daily_limit ?? mb.warmup_start_limit) : mb.daily_limit;
}

// ── Mailbox health ───────────────────────────────────────────────────────────

function pauseMailbox(mailboxId, reason) {
  const r = db.prepare(`
    UPDATE outreach_mailboxes SET status = 'paused', pause_reason = ?
    WHERE id = ? AND status != 'paused'
  `).run(reason, mailboxId);
  if (r.changes) log('warn', `mailbox AUTO-PAUSED: ${reason}`, mailboxId);
}

function checkBounceRate(mailboxId) {
  const rows = db.prepare(`
    SELECT status FROM outreach_email_queue
    WHERE mailbox_id = ? AND sent_at IS NOT NULL
    ORDER BY sent_at DESC LIMIT ${BOUNCE_WINDOW}
  `).all(mailboxId);
  if (!rows.length) return;
  const bounced = rows.filter(r => r.status === 'bounced').length;
  const rate = bounced / rows.length;
  db.prepare('UPDATE outreach_mailboxes SET bounce_rate = ? WHERE id = ?').run(Math.round(rate * 10000) / 100, mailboxId);
  if (rate > BOUNCE_RATE_LIMIT) {
    pauseMailbox(mailboxId, `bounce rate ${(rate * 100).toFixed(1)}% (${bounced}/${rows.length} of last sends) > ${BOUNCE_RATE_LIMIT * 100}%`);
  }
}

// ── Enqueue step 1 for leads of active campaigns ─────────────────────────────

const enqueueStep1 = db.transaction(() => {
  const nowSql = toSql(new Date());
  const campaigns = db.prepare("SELECT id, name FROM outreach_campaigns WHERE status = 'active'").all();

  for (const c of campaigns) {
    const step1 = db.prepare('SELECT id FROM outreach_sequences WHERE campaign_id = ? ORDER BY step_number ASC LIMIT 1').get(c.id);
    if (!step1) continue;

    const mailboxes = db.prepare(`
      SELECT m.id,
        (SELECT COUNT(*) FROM outreach_email_queue q
         WHERE q.mailbox_id = m.id AND q.status = 'pending' AND q.in_reply_to IS NULL) AS pending
      FROM outreach_campaign_mailboxes cm
      JOIN outreach_mailboxes m ON m.id = cm.mailbox_id
      WHERE cm.campaign_id = ? AND m.status IN ('active','warmup')
    `).all(c.id);
    const capacity = mailboxes.reduce((s, m) => s + Math.max(0, MAX_PENDING_STEP1_PER_MAILBOX - m.pending), 0);
    if (!capacity) continue;

    const leads = db.prepare(`
      SELECT cl.id AS cl_id, l.id, l.email, l.status
      FROM outreach_campaign_leads cl
      LEFT JOIN outreach_leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = ? AND cl.status = 'pending'
      ORDER BY cl.id LIMIT ?
    `).all(c.id, capacity);

    for (const lead of leads) {
      let skip = null;
      if (!lead.id) skip = 'lead deleted';
      else if (!lead.email) skip = 'no email';
      else if (STOPPED_LEAD.includes(lead.status)) skip = `lead ${lead.status}`;
      else if (db.prepare('SELECT 1 FROM outreach_suppressions WHERE lower(email) = lower(?)').get(lead.email)) skip = 'suppressed';
      if (skip) {
        db.prepare("UPDATE outreach_campaign_leads SET status = 'skipped' WHERE id = ?").run(lead.cl_id);
        log('info', `campaign "${c.name}": skipped lead ${lead.id ?? '?'} (${skip})`);
        continue;
      }
      // Never run two sequences at a lead at once
      const busy = db.prepare("SELECT 1 FROM outreach_email_queue WHERE lead_id = ? AND status IN ('pending','sending')").get(lead.id);
      if (busy) continue;

      mailboxes.sort((a, b) => a.pending - b.pending);
      const mb = mailboxes[0];
      if (mb.pending >= MAX_PENDING_STEP1_PER_MAILBOX) break;
      db.prepare(`
        INSERT INTO outreach_email_queue (campaign_id, lead_id, mailbox_id, sequence_id, scheduled_at, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(c.id, lead.id, mb.id, step1.id, nowSql);
      db.prepare("UPDATE outreach_campaign_leads SET status = 'queued' WHERE id = ?").run(lead.cl_id);
      mb.pending++;
    }
  }
});

// ── Claim (atomic pending → sending) ─────────────────────────────────────────

function claimNext(mailboxId, dry) {
  const nowSql = toSql(new Date());
  return db.prepare(`
    UPDATE outreach_email_queue SET status = 'sending', claimed_at = ?
    WHERE id = (
      SELECT q.id FROM outreach_email_queue q
      JOIN outreach_campaigns c ON c.id = q.campaign_id
      WHERE q.status = 'pending' AND q.mailbox_id = ? AND q.scheduled_at <= ?
        AND c.status = 'active'
        AND (? = 0 OR q.dry_run_at IS NULL)
      ORDER BY q.scheduled_at ASC, q.id ASC LIMIT 1
    ) AND status = 'pending'
    RETURNING *
  `).get(nowSql, mailboxId, nowSql, dry ? 1 : 0);
}

function releaseItem(id) {
  db.prepare("UPDATE outreach_email_queue SET status = 'pending', claimed_at = NULL WHERE id = ? AND status = 'sending'").run(id);
}

function cancelItem(id, reason) {
  db.prepare("UPDATE outreach_email_queue SET status = 'cancelled', error_message = ? WHERE id = ?").run(reason, id);
}

// Final re-check right before every send. Returns a reason string, or null if OK.
function preSendCheck(item) {
  if (getSetting('global_paused', 'false') === 'true') return 'global pause';
  const mb = db.prepare('SELECT status FROM outreach_mailboxes WHERE id = ?').get(item.mailbox_id);
  if (!mb) return 'mailbox deleted';
  if (!SENDABLE_MAILBOX.includes(mb.status)) return `mailbox ${mb.status}`;
  const c = db.prepare('SELECT status FROM outreach_campaigns WHERE id = ?').get(item.campaign_id);
  if (!c) return 'campaign deleted';
  if (c.status !== 'active') return `campaign ${c.status}`;
  const lead = db.prepare('SELECT email, status FROM outreach_leads WHERE id = ?').get(item.lead_id);
  if (!lead) return 'lead deleted';
  if (!lead.email) return 'lead has no email';
  if (STOPPED_LEAD.includes(lead.status)) return `lead ${lead.status}`;
  if (db.prepare('SELECT 1 FROM outreach_suppressions WHERE lower(email) = lower(?)').get(lead.email)) return 'suppressed';
  const reply = db.prepare('SELECT is_bounce FROM outreach_replies WHERE lead_id = ? LIMIT 1').get(item.lead_id);
  if (reply) return reply.is_bounce ? 'lead bounced' : 'lead replied';
  return null;
}

function buildMessage(item, mb, lead, seq, unsubUrl) {
  const baseSubject = render(seq.subject, lead, false);
  const subject = item.subject || baseSubject;
  let text = seq.body_text ? render(seq.body_text, lead, false) : htmlToText(render(seq.body_html, lead, false));
  let html = seq.body_html ? render(seq.body_html, lead, true) : null;

  text += `\n\n--\nNebenorite gauti šių laiškų? Atsisakyti: ${unsubUrl}`;
  if (html) {
    html += `<p style="font-size:12px;color:#888;margin-top:24px">Nebenorite gauti šių laiškų? <a href="${escapeHtml(unsubUrl)}">Atsisakyti</a></p>`;
  }

  const domain = mb.email.split('@')[1] || 'localhost';
  return {
    from: { name: mb.display_name || '', address: mb.email },
    to: lead.email,
    subject,
    text,
    html: html || undefined,
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    inReplyTo: item.in_reply_to || undefined,
    references: item.thread_references || undefined,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

// ── After send ───────────────────────────────────────────────────────────────

function nextStep(item) {
  const cur = db.prepare('SELECT step_number FROM outreach_sequences WHERE id = ?').get(item.sequence_id);
  if (!cur) return null;
  return db.prepare(`
    SELECT * FROM outreach_sequences WHERE campaign_id = ? AND step_number > ?
    ORDER BY step_number ASC LIMIT 1
  `).get(item.campaign_id, cur.step_number);
}

function threadSubject(subject) {
  return 'Re: ' + String(subject).replace(/^\s*(re:\s*)+/i, '');
}

const recordSent = db.transaction((item, msg, sentAt) => {
  const sentSql = toSql(sentAt);
  db.prepare(`
    UPDATE outreach_email_queue
    SET status = 'sent', sent_at = ?, message_id = ?, subject = ?, error_message = NULL
    WHERE id = ?
  `).run(sentSql, msg.messageId, msg.subject, item.id);
  db.prepare("UPDATE outreach_leads SET status = 'contacted', updated_at = datetime('now') WHERE id = ? AND status = 'new'").run(item.lead_id);
  db.prepare(`
    UPDATE outreach_mailboxes SET consecutive_smtp_errors = 0, next_send_at = ? WHERE id = ?
  `).run(toSql(new Date(Date.now() + randomGapMs())), item.mailbox_id);

  const next = nextStep(item);
  if (next) {
    const when = nextSendWindow(new Date(sentAt.getTime() + (next.delay_days || 0) * 86400000));
    const refs = [item.thread_references, msg.messageId].filter(Boolean).join(' ');
    db.prepare(`
      INSERT INTO outreach_email_queue
        (campaign_id, lead_id, mailbox_id, sequence_id, scheduled_at, status, subject, in_reply_to, thread_references)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(item.campaign_id, item.lead_id, item.mailbox_id, next.id, toSql(when), threadSubject(msg.subject), msg.messageId, refs);
    db.prepare(`UPDATE outreach_campaign_leads SET status = 'contacted' WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','queued')`)
      .run(item.campaign_id, item.lead_id);
    return { step: next.step_number, at: toSql(when) };
  }
  db.prepare(`UPDATE outreach_campaign_leads SET status = 'completed' WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','queued','contacted')`)
    .run(item.campaign_id, item.lead_id);
  return null;
});

// ── Process one claimed item ─────────────────────────────────────────────────

async function processItem(item, dry) {
  const reason = preSendCheck(item);
  if (reason) {
    cancelItem(item.id, `pre-send check: ${reason}`);
    log('info', `queue #${item.id} cancelled — ${reason}`, item.mailbox_id);
    return;
  }

  const campaign = db.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(item.campaign_id);
  if (campaign.daily_limit && countCampaign(campaign.id, toSql(new Date(Date.now() - 86400000)), dry) >= campaign.daily_limit) {
    releaseItem(item.id);
    return;
  }

  const mb   = db.prepare('SELECT * FROM outreach_mailboxes WHERE id = ?').get(item.mailbox_id);
  const lead = db.prepare('SELECT * FROM outreach_leads WHERE id = ?').get(item.lead_id);
  const seq  = db.prepare('SELECT * FROM outreach_sequences WHERE id = ?').get(item.sequence_id);
  if (!seq) {
    cancelItem(item.id, 'sequence step deleted');
    log('warn', `queue #${item.id} cancelled — sequence step deleted`, mb.id);
    return;
  }

  let unsubUrl;
  try {
    unsubUrl = `${common.publicBaseUrl() || 'https://PUBLIC_URL-NOT-SET'}/u/${common.signLeadToken(lead.id)}`;
  } catch {
    unsubUrl = `${common.publicBaseUrl() || 'https://PUBLIC_URL-NOT-SET'}/u/TOKEN-NEEDS-ENCRYPTION_KEY`;
  }
  const msg = buildMessage(item, mb, lead, seq, unsubUrl);

  if (dry) {
    db.prepare("UPDATE outreach_email_queue SET status = 'pending', claimed_at = NULL, dry_run_at = ? WHERE id = ?")
      .run(toSql(new Date()), item.id);
    db.prepare('UPDATE outreach_mailboxes SET next_send_at = ? WHERE id = ?')
      .run(toSql(new Date(Date.now() + randomGapMs())), mb.id);
    const next = nextStep(item);
    log('info', [
      `[DRY RUN] would send queue #${item.id} (campaign "${campaign.name}", step ${item.in_reply_to ? 'follow-up' : '1'})`,
      `  From: ${mb.display_name || ''} <${mb.email}>  To: ${lead.email}`,
      `  Subject: ${msg.subject}`,
      msg.inReplyTo ? `  In-Reply-To: ${msg.inReplyTo}` : null,
      `  List-Unsubscribe: <${unsubUrl}>`,
      `  Body: ${msg.text.slice(0, 600)}${msg.text.length > 600 ? '…' : ''}`,
      next ? `  Would then schedule step ${next.step_number} at ~${toSql(nextSendWindow(new Date(Date.now() + (next.delay_days || 0) * 86400000)))} UTC` : '  (last step)',
    ].filter(Boolean).join('\n'), mb.id);
    return;
  }

  let pass;
  try {
    pass = common.decrypt(mb.smtp_pass);
  } catch (err) {
    releaseItem(item.id);
    pauseMailbox(mb.id, `cannot decrypt SMTP password: ${err.message}`);
    return;
  }

  const port = Number(mb.smtp_port) || 587;
  const transporter = nodemailer.createTransport({
    host: mb.smtp_host,
    port,
    secure: port === 465,
    auth: { user: mb.smtp_user || mb.email, pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });

  try {
    await transporter.sendMail(msg);
  } catch (err) {
    handleSendError(item, mb, lead, msg, err);
    return;
  } finally {
    transporter.close();
  }

  // Outside the SMTP try: a DB error here must not be mistaken for a send
  // failure. If it throws, the item stays 'sending' and is never retried.
  const next = recordSent(item, msg, new Date());
  log('info', `sent queue #${item.id} to ${lead.email} ("${msg.subject}")${next ? ` — step ${next.step} scheduled ${next.at} UTC` : ' — sequence complete'}`, mb.id);
  checkBounceRate(mb.id);
}

function handleSendError(item, mb, lead, msg, err) {
  const recipientRejected = err.responseCode >= 500 && /RCPT/i.test(err.command || '');
  if (recipientRejected) {
    // Hard bounce at SMTP time — counts as a send + bounce for this mailbox
    db.prepare(`
      UPDATE outreach_email_queue SET status = 'bounced', sent_at = ?, message_id = ?, subject = ?, error_message = ?
      WHERE id = ?
    `).run(toSql(new Date()), msg.messageId, msg.subject, String(err.response || err.message).slice(0, 1000), item.id);
    db.prepare(`
      INSERT INTO outreach_replies (queue_id, lead_id, mailbox_id, received_at, subject, body_text, is_bounce, from_email)
      VALUES (?, ?, ?, datetime('now'), ?, ?, 1, ?)
    `).run(item.id, lead.id, mb.id, 'SMTP recipient rejected', String(err.response || err.message).slice(0, 2000), mb.email);
    common.stopLead(lead.id, 'bounced', { suppress: true, reason: 'bounce' });
    db.prepare('UPDATE outreach_mailboxes SET next_send_at = ? WHERE id = ?').run(toSql(new Date(Date.now() + randomGapMs())), mb.id);
    log('warn', `queue #${item.id}: recipient ${lead.email} rejected (${err.responseCode}) — lead marked bounced + suppressed`, mb.id);
    checkBounceRate(mb.id);
  } else {
    db.prepare("UPDATE outreach_email_queue SET status = 'failed', error_message = ? WHERE id = ?")
      .run(String(err.message).slice(0, 1000), item.id);
    db.prepare(`UPDATE outreach_campaign_leads SET status = 'failed' WHERE campaign_id = ? AND lead_id = ? AND status = 'queued'`)
      .run(item.campaign_id, item.lead_id);
    const { consecutive_smtp_errors: n } = db.prepare(`
      UPDATE outreach_mailboxes SET consecutive_smtp_errors = COALESCE(consecutive_smtp_errors, 0) + 1, next_send_at = ?
      WHERE id = ? RETURNING consecutive_smtp_errors
    `).get(toSql(new Date(Date.now() + randomGapMs())), mb.id);
    log('error', `queue #${item.id} SMTP error (${n} in a row): ${err.message}`, mb.id);
    if (n >= SMTP_ERRORS_BEFORE_PAUSE) pauseMailbox(mb.id, `${n} SMTP errors in a row (last: ${err.message})`);
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────

let lastConfigError = 0;

async function sendTick() {
  const dry = getSetting('dry_run', 'true') !== 'false';
  if (getSetting('global_paused', 'false') === 'true') return;

  enqueueStep1();

  if (!inSendWindow()) return;

  if (!dry) {
    const missing = [];
    if (!process.env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');
    if (!common.publicBaseUrl()) missing.push('PUBLIC_URL');
    if (missing.length) {
      if (Date.now() - lastConfigError > 3600000) {
        log('error', `live sending blocked — missing env: ${missing.join(', ')}`);
        lastConfigError = Date.now();
      }
      return;
    }
  }

  const systemHourly = parseInt(getSetting('hourly_system_limit', '50'), 10) || 0;
  const mailboxes = db.prepare(`
    SELECT m.*, d.daily_limit AS domain_daily_limit, d.status AS domain_status
    FROM outreach_mailboxes m
    LEFT JOIN outreach_domains d ON d.id = m.domain_id
    WHERE m.status IN ('active','warmup') AND (m.next_send_at IS NULL OR m.next_send_at <= ?)
    ORDER BY RANDOM()
  `).all(toSql(new Date()));

  for (const mb of mailboxes) {
    if (getSetting('global_paused', 'false') === 'true') return;
    if (!inSendWindow()) return;

    const now = Date.now();
    const hourAgo = toSql(new Date(now - 3600000));
    const dayAgo  = toSql(new Date(now - 86400000));

    if (countSystem(hourAgo, dry) >= systemHourly) return;
    if (mb.domain_status && mb.domain_status !== 'active') continue;
    if (countMailbox(mb.id, hourAgo, dry) >= (mb.hourly_limit ?? 0)) continue;
    if (countMailbox(mb.id, dayAgo, dry) >= (effectiveDailyLimit(mb) ?? 0)) continue;
    if (mb.domain_id && mb.domain_daily_limit != null && countDomain(mb.domain_id, dayAgo, dry) >= mb.domain_daily_limit) continue;

    const item = claimNext(mb.id, dry);
    if (!item) continue;
    await processItem(item, dry);
  }
}

// Items left in 'sending' by a crash may or may not have been delivered —
// never retry them (that could double-send); mark failed for manual review.
function recoverStuckSending() {
  const r = db.prepare(`
    UPDATE outreach_email_queue
    SET status = 'failed', error_message = 'worker stopped mid-send — delivery unknown, not retried'
    WHERE status = 'sending'
  `).run();
  if (r.changes) log('warn', `${r.changes} queue item(s) were stuck in 'sending' after restart — marked failed, not retried`);
}

module.exports = { sendTick, recoverStuckSending, checkBounceRate, pauseMailbox };
