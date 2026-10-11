'use strict';

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const db               = require('../database');
const common           = require('../services/outreach-common');
const { checkBounceRate } = require('./send');
const { toSql }        = require('./time');

const { workerLog: log } = common;

const CHECK_EVERY_MS   = 5 * 60000;
const FIRST_RUN_DAYS   = 14;
const MAX_PER_RUN      = 200;

// ── Classification ───────────────────────────────────────────────────────────

function headerStr(parsed, name) {
  const v = parsed.headers.get(name);
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.value) return `${v.value}; ${JSON.stringify(v.params || {})}`;
  return String(v);
}

function isBounce(parsed, fromAddr, raw) {
  const ct = parsed.headers.get('content-type');
  const isDsn = ct && ct.value === 'multipart/report' && /delivery-status/i.test((ct.params || {})['report-type'] || '');
  const fromDaemon = /^(mailer-daemon|postmaster)@/i.test(fromAddr || '') || /mail delivery (subsystem|system)/i.test(parsed.from?.text || '');
  if (!isDsn && !fromDaemon) return false;
  // A "delayed" DSN is only a warning — the server is still retrying
  if (/^Action:\s*delayed/im.test(raw) && !/^Action:\s*failed/im.test(raw)) return false;
  return true;
}

function isAutoReply(parsed) {
  const auto = headerStr(parsed, 'auto-submitted').toLowerCase();
  if (auto && !auto.startsWith('no')) return true;
  if (parsed.headers.has('x-autoreply') || parsed.headers.has('x-autorespond')) return true;
  if (/auto_reply|auto-reply/i.test(headerStr(parsed, 'precedence'))) return true;
  return /^\s*(automatic reply|auto[- ]?reply|autoreply|out of office|automatinis atsakymas|ne biure)/i.test(parsed.subject || '');
}

function messageIdsIn(text) {
  return [...new Set((String(text).match(/<[^<>\s@]+@[^<>\s]+>/g) || []))].slice(0, 100);
}

function findSentByMessageIds(ids) {
  if (!ids.length) return null;
  return db.prepare(`
    SELECT * FROM outreach_email_queue
    WHERE message_id IN (${ids.map(() => '?').join(',')}) AND sent_at IS NOT NULL
    ORDER BY sent_at DESC LIMIT 1
  `).get(...ids);
}

function latestSentTo(leadId, mailboxId, beforeSql) {
  return db.prepare(`
    SELECT * FROM outreach_email_queue
    WHERE lead_id = ? AND mailbox_id = ? AND sent_at IS NOT NULL AND sent_at <= ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(leadId, mailboxId, beforeSql);
}

const leadByEmail = (email) => db.prepare('SELECT * FROM outreach_leads WHERE lower(email) = lower(?) ORDER BY id LIMIT 1').get(email);

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleBounce(mb, parsed, raw, receivedSql) {
  let item = findSentByMessageIds(messageIdsIn(raw));
  let lead = item ? db.prepare('SELECT * FROM outreach_leads WHERE id = ?').get(item.lead_id) : null;

  if (!lead) {
    const m = /^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im.exec(raw);
    if (m) {
      lead = leadByEmail(m[1]);
      if (lead) item = latestSentTo(lead.id, mb.id, receivedSql);
    }
  }
  if (!lead) {
    log('warn', `bounce received but no matching sent email/lead (subject: "${parsed.subject || ''}")`, mb.id);
    return 'bounce-unmatched';
  }

  db.transaction(() => {
    if (item) db.prepare("UPDATE outreach_email_queue SET status = 'bounced' WHERE id = ? AND status = 'sent'").run(item.id);
    db.prepare(`
      INSERT INTO outreach_replies (queue_id, lead_id, mailbox_id, received_at, subject, body_text, is_bounce, from_email, message_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(item?.id ?? null, lead.id, mb.id, receivedSql, parsed.subject || '', (parsed.text || '').slice(0, 5000),
      parsed.from?.value?.[0]?.address || '', parsed.messageId || null);
    const cancelled = common.stopLead(lead.id, 'bounced', { suppress: true, reason: 'bounce' });
    log('warn', `BOUNCE: ${lead.email} — lead marked bounced + suppressed, ${cancelled} pending email(s) cancelled`, mb.id);
  })();
  // Bounces sent from another mailbox still count against the one that sent it
  checkBounceRate(item ? item.mailbox_id : mb.id);
  return 'bounce';
}

function handleMessage(mb, parsed, raw, internalDate) {
  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const receivedSql = toSql(parsed.date && !isNaN(parsed.date) ? parsed.date : (internalDate || new Date()));

  if (fromAddr && fromAddr === String(mb.email).toLowerCase()) return 'own-message';
  if (isBounce(parsed, fromAddr, raw)) return handleBounce(mb, parsed, raw, receivedSql);

  // Match: In-Reply-To/References first, then sender address
  const refs = [parsed.inReplyTo, ...[].concat(parsed.references || [])]
    .filter(Boolean).flatMap(messageIdsIn);
  let item = findSentByMessageIds(refs);
  let lead = item ? db.prepare('SELECT * FROM outreach_leads WHERE id = ?').get(item.lead_id) : null;
  if (!lead && fromAddr) {
    lead = leadByEmail(fromAddr);
    // Only counts as a reply if we actually emailed them from this mailbox before it arrived
    item = lead ? latestSentTo(lead.id, mb.id, receivedSql) : null;
    if (!item) lead = null;
  }
  if (!lead) return 'unrelated';

  if (isAutoReply(parsed)) {
    log('info', `auto-reply from ${fromAddr} ignored ("${parsed.subject || ''}") — sequence continues`, mb.id);
    return 'auto-reply';
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO outreach_replies (queue_id, lead_id, mailbox_id, received_at, subject, body_text, is_bounce, from_email, message_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(item?.id ?? null, lead.id, mb.id, receivedSql, parsed.subject || '', (parsed.text || '').slice(0, 20000),
      fromAddr, parsed.messageId || null);
    const cancelled = common.stopLead(lead.id, 'replied');
    log('info', `REPLY from ${lead.email} ("${parsed.subject || ''}") — ${cancelled} pending email(s) cancelled`, mb.id);
  })();
  return 'reply';
}

// ── Per-mailbox check ────────────────────────────────────────────────────────

const isProcessed = db.prepare('SELECT 1 FROM outreach_processed_messages WHERE mailbox_id = ? AND message_key = ?');
const markProcessed = db.prepare('INSERT OR IGNORE INTO outreach_processed_messages (mailbox_id, message_key, result) VALUES (?, ?, ?)');

async function checkMailbox(mb) {
  const port = Number(mb.imap_port) || 993;
  const client = new ImapFlow({
    host: mb.imap_host,
    port,
    secure: port === 993,
    auth: { user: mb.imap_user || mb.email, pass: common.decrypt(mb.imap_pass) },
    logger: false,
    socketTimeout: 120000,
  });
  client.on('error', (err) => log('error', `IMAP connection error: ${err.message}`, mb.id));

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const resume = mb.imap_uidvalidity === uidValidity && mb.imap_last_uid != null;

      let range;
      if (resume) {
        range = `${mb.imap_last_uid + 1}:*`;
      } else {
        const uids = await client.search({ since: new Date(Date.now() - FIRST_RUN_DAYS * 86400000) }, { uid: true });
        range = uids && uids.length ? uids.join(',') : null;
      }

      const fetched = [];
      if (range) {
        for await (const msg of client.fetch(range, { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (resume && msg.uid <= mb.imap_last_uid) continue; // "N:*" always returns the newest message
          fetched.push(msg);
        }
      }
      fetched.sort((a, b) => a.uid - b.uid);
      const batch = fetched.slice(0, MAX_PER_RUN);

      let lastUid = resume ? mb.imap_last_uid : 0;
      const counts = {};
      for (const msg of batch) {
        const uidKey = `uid:${uidValidity}:${msg.uid}`;
        lastUid = Math.max(lastUid, msg.uid);
        if (isProcessed.get(mb.id, uidKey)) continue;

        const raw = msg.source.toString('utf8');
        const parsed = await simpleParser(msg.source);
        const midKey = parsed.messageId ? `mid:${parsed.messageId}` : null;
        if (midKey && isProcessed.get(mb.id, midKey)) {
          markProcessed.run(mb.id, uidKey, 'duplicate');
          continue;
        }

        let result;
        try {
          result = handleMessage(mb, parsed, raw, msg.internalDate);
        } catch (err) {
          result = 'error';
          log('error', `failed to process message uid ${msg.uid}: ${err.message}`, mb.id);
        }
        markProcessed.run(mb.id, uidKey, result);
        if (midKey) markProcessed.run(mb.id, midKey, result);
        counts[result] = (counts[result] || 0) + 1;
      }

      if (!batch.length && !resume) lastUid = Math.max(0, (client.mailbox.uidNext || 1) - 1);
      db.prepare('UPDATE outreach_mailboxes SET imap_uidvalidity = ?, imap_last_uid = ? WHERE id = ?')
        .run(uidValidity, lastUid, mb.id);

      if (batch.length) {
        const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
        log('info', `IMAP: ${batch.length} new message(s) — ${summary}${fetched.length > batch.length ? ` (${fetched.length - batch.length} more next run)` : ''}`, mb.id);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

let running = false;

async function imapTick() {
  if (running) return;
  running = true;
  try {
    const due = db.prepare(`
      SELECT * FROM outreach_mailboxes
      WHERE imap_host IS NOT NULL AND imap_host != '' AND imap_pass IS NOT NULL AND imap_pass != ''
        AND (imap_last_check_at IS NULL OR imap_last_check_at <= ?)
    `).all(toSql(new Date(Date.now() - CHECK_EVERY_MS)));

    for (const mb of due) {
      db.prepare('UPDATE outreach_mailboxes SET imap_last_check_at = ? WHERE id = ?').run(toSql(new Date()), mb.id);
      try {
        await checkMailbox(mb);
      } catch (err) {
        log('error', `IMAP check failed: ${err.message}`, mb.id);
      }
    }
  } finally {
    running = false;
  }
}

module.exports = { imapTick, isBounce, isAutoReply, handleMessage };
