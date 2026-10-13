'use strict';

// Warmup: mailboxes ↔ seed inboxes the user owns.
//
//  mailbox ──out──▶ seed       (warmupTick, ramp 2→15/day over 21 days, then ~15/day)
//  seed IMAP: SEARCH HEADER Message-ID in INBOX / Spam, rescue from spam,
//             mark read, flag ~30%, plan a reply for ~40% (seedTick, every 10 min)
//  seed ──reply──▶ mailbox     (warmupTick, 15–180 min later)
//  mailbox IMAP: matched by In-Reply-To/References → hidden in a "Warmup"
//                folder, never an outreach reply; continue ~20% (classifyIncoming)
//
// Warmup mail carries no visible marker — it is identified only by the
// Message-IDs stored in outreach_warmup_messages.
//
// Warmup has its own on/off switch (separate from the outreach pause), runs
// every day 08:00–20:00 Vilnius, ignores campaign pauses, and respects dry_run.

const crypto           = require('crypto');
const nodemailer       = require('nodemailer');
const { ImapFlow }     = require('imapflow');
const db               = require('../database');
const common           = require('../services/outreach-common');
const content          = require('./warmup-content');
const { inWarmupWindow, warmupWindowEnd, nextWarmupWindowStart, localDayStart, toSql } = require('./time');
const { pauseMailbox, countMailbox, countWarmup } = require('./send');

const { workerLog: log, getSetting, HEALTH } = common;

const RAMP_START = 2;
const RAMP_END = 15;
const RAMP_DAYS = 21;
const SEED_CHECK_EVERY_MS = 10 * 60000;
const SEED_LOOKBACK_DAYS = 3;
const REPLY_CHANCE = 0.4;
const FLAG_CHANCE = 0.3;
const CONTINUE_CHANCE = 0.2;
const MIN_GAP_MS = 4 * 60000;
const SMTP_ERRORS_BEFORE_BACKOFF = 3;
const WARMUP_FOLDER = 'Warmup';

const rand = (a, b) => a + Math.random() * (b - a);
const minutesFromNow = (lo, hi) => new Date(Date.now() + rand(lo, hi) * 60000);
const domainOf = (email) => String(email).split('@')[1] || 'localhost';
const isOn = () => getSetting('warmup_enabled', 'false') === 'true';
const isDry = () => getSetting('dry_run', 'true') !== 'false';
const fromSqlUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

// ── Volume ramp ──────────────────────────────────────────────────────────────

function rampDay(mb, now = new Date()) {
  if (!mb.seed_warmup_started_at) return 0;
  const start = localDayStart(fromSqlUtc(mb.seed_warmup_started_at));
  return Math.max(0, Math.round((localDayStart(now) - start) / 86400000));
}

// 2/day → 15/day over 21 days, then ~15/day (13–17, stable within a day)
function dailyTarget(mb, now = new Date()) {
  const d = rampDay(mb, now);
  if (d < RAMP_DAYS) return Math.round(RAMP_START + (RAMP_END - RAMP_START) * d / RAMP_DAYS);
  const h = crypto.createHash('md5').update(`${mb.id}:${localDayStart(now).toISOString()}`).digest()[0];
  return RAMP_END - 2 + (h % 5);
}

function sentToday(mailboxId, dry, now = new Date()) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM outreach_warmup_messages
    WHERE mailbox_id = ? AND direction = 'out' AND sent_at >= ?
      AND (status = 'sent' OR (? = 1 AND status = 'dry_run'))
  `).get(mailboxId, toSql(localDayStart(now)), dry ? 1 : 0).c;
}

// ── Seeds ────────────────────────────────────────────────────────────────────

// Never send warmup to leads, suppressed addresses or our own mailboxes
function isForbiddenRecipient(email) {
  return !!db.prepare(`
    SELECT 1 FROM outreach_leads WHERE lower(email) = lower(?)
    UNION ALL SELECT 1 FROM outreach_suppressions WHERE lower(email) = lower(?)
    UNION ALL SELECT 1 FROM outreach_mailboxes WHERE lower(email) = lower(?)
    LIMIT 1
  `).get(email, email, email);
}

function eligibleSeeds() {
  return db.prepare("SELECT * FROM outreach_warmup_seeds WHERE status = 'active'").all()
    .filter(s => !isForbiddenRecipient(s.email));
}

function seedError(seed, message) {
  db.prepare("UPDATE outreach_warmup_seeds SET status = 'error', last_error = ? WHERE id = ?")
    .run(String(message).slice(0, 500), seed.id);
  log('error', `warmup seed ${seed.email} → ERROR, skipped until fixed: ${message}`);
}

function pickSeed(mb, seeds) {
  const last = db.prepare("SELECT seed_id FROM outreach_warmup_messages WHERE mailbox_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(mb.id);
  let pool = seeds.filter(s => domainOf(s.email) !== domainOf(mb.email));
  if (!pool.length) pool = seeds;
  if (pool.length > 1 && last) pool = pool.filter(s => s.id !== last.seed_id);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

async function smtpSend(cfg, mail) {
  const port = Number(cfg.smtp_port) || 587;
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host, port, secure: port === 465,
    auth: { user: cfg.smtp_user || cfg.email, pass: common.decrypt(cfg.smtp_pass) },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
  try { await transporter.sendMail(mail); } finally { transporter.close(); }
}

const insertMsg = db.prepare(`
  INSERT INTO outreach_warmup_messages
    (mailbox_id, seed_id, direction, subject, message_id, in_reply_to, references_header, status, error, sent_at, landed_in, opened_at)
  VALUES (@mailbox_id, @seed_id, @direction, @subject, @message_id, @in_reply_to, @references_header, @status, @error, @sent_at, @landed_in, @opened_at)
`);

function recordMsg(row) {
  return insertMsg.run({
    mailbox_id: null, seed_id: null, subject: null, message_id: null, in_reply_to: null, references_header: null,
    status: 'sent', error: null, sent_at: toSql(new Date()), landed_in: 'unknown', opened_at: null, ...row,
  }).lastInsertRowid;
}

// Mailbox → seed (new thread or continuation). No unsubscribe footer, no tracking.
async function sendFromMailbox(mb, seed, msg, dry) {
  const messageId = `<${crypto.randomUUID()}@${domainOf(mb.email)}>`;
  const base = {
    mailbox_id: mb.id, seed_id: seed.id, direction: 'out', subject: msg.subject, message_id: messageId,
    in_reply_to: msg.inReplyTo || null, references_header: msg.references || null,
  };
  if (dry) {
    recordMsg({ ...base, status: 'dry_run' });
    log('info', `[DRY RUN] warmup ${mb.email} → ${seed.email} "${msg.subject}"${msg.inReplyTo ? ' [thread reply]' : ''}`, mb.id);
    return true;
  }
  if (isForbiddenRecipient(seed.email)) {
    seedError(seed, 'seed address is a lead, suppressed or one of our mailboxes');
    return false;
  }
  try {
    await smtpSend(mb, {
      from: { name: mb.display_name || '', address: mb.email },
      to: seed.email, subject: msg.subject, text: msg.text, html: msg.html,
      messageId, inReplyTo: msg.inReplyTo, references: msg.references,
    });
  } catch (err) {
    recordMsg({ ...base, status: 'failed', error: String(err.message).slice(0, 500) });
    const { warmup_smtp_errors: n } = db.prepare(`
      UPDATE outreach_mailboxes SET warmup_smtp_errors = COALESCE(warmup_smtp_errors, 0) + 1 WHERE id = ?
      RETURNING warmup_smtp_errors
    `).get(mb.id);
    log('error', `warmup SMTP error (${n} in a row): ${err.message}`, mb.id);
    if (n >= SMTP_ERRORS_BEFORE_BACKOFF) {
      db.prepare('UPDATE outreach_mailboxes SET warmup_smtp_errors = 0, next_warmup_at = ? WHERE id = ?')
        .run(toSql(new Date(Date.now() + 3600000)), mb.id);
      log('warn', `warmup for this mailbox backs off 1 hour after ${n} SMTP errors`, mb.id);
    }
    return false;
  }
  recordMsg(base);
  db.prepare('UPDATE outreach_mailboxes SET warmup_smtp_errors = 0 WHERE id = ?').run(mb.id);
  log('info', `warmup sent ${mb.email} → ${seed.email} "${msg.subject}"${msg.inReplyTo ? ' [thread reply]' : ''}`, mb.id);
  return true;
}

// ── Pacing ───────────────────────────────────────────────────────────────────

// Spread the remaining sends over what's left of today's 08:00–20:00 window
function setNextSlot(mailboxId, remaining) {
  const now = new Date();
  const left = warmupWindowEnd(now) - now;
  let next;
  if (remaining > 0 && left > MIN_GAP_MS) {
    next = new Date(now.getTime() + Math.max(MIN_GAP_MS, left / (remaining + 0.5) * rand(0.5, 1.5)));
  }
  if (!next || next >= warmupWindowEnd(now)) {
    next = new Date(nextWarmupWindowStart(now).getTime() + rand(0, 90) * 60000);
  }
  db.prepare('UPDATE outreach_mailboxes SET next_warmup_at = ? WHERE id = ?').run(toSql(next), mailboxId);
}

async function mailboxTick(mb, seeds, dry) {
  const now = new Date();
  const target = dailyTarget(mb, now);
  const sent = sentToday(mb.id, dry, now);
  if (sent >= target) return setNextSlot(mb.id, 0);

  // Warmup shares the mailbox hourly limit with campaign sends
  const hourAgo = toSql(new Date(now.getTime() - 3600000));
  if (countMailbox(mb.id, hourAgo, dry) + countWarmup(mb.id, hourAgo, dry) >= (mb.hourly_limit ?? 0)) {
    db.prepare('UPDATE outreach_mailboxes SET next_warmup_at = ? WHERE id = ?').run(toSql(new Date(now.getTime() + 10 * 60000)), mb.id);
    return;
  }

  // First slot after the switch is turned on: start at a random point, not now
  if (!mb.next_warmup_at) return setNextSlot(mb.id, target - sent);

  // A due thread continuation goes first (counts toward today's volume)
  const cont = db.prepare(`
    SELECT r.*, o.subject AS parent_subject, o.references_header AS parent_refs, o.message_id AS parent_mid
    FROM outreach_warmup_messages r
    LEFT JOIN outreach_warmup_messages o ON o.message_id = r.in_reply_to
    WHERE r.mailbox_id = ? AND r.direction = 'reply' AND r.continue_due_at <= ? AND r.replied_at IS NULL
    ORDER BY r.continue_due_at LIMIT 1
  `).get(mb.id, toSql(now));

  if (cont) {
    db.prepare('UPDATE outreach_warmup_messages SET continue_due_at = NULL, replied_at = ? WHERE id = ?').run(toSql(now), cont.id);
    const seed = seeds.find(s => s.id === cont.seed_id);
    if (seed) {
      const m = content.replyMessage({ fromEmail: mb.email, fromName: mb.display_name, continuation: true });
      await sendFromMailbox(mb, seed, {
        ...m,
        subject: content.replySubject(cont.subject || cont.parent_subject),
        inReplyTo: cont.message_id,
        references: [cont.parent_refs, cont.parent_mid, cont.message_id].filter(Boolean).join(' '),
      }, dry);
      return setNextSlot(mb.id, target - sent - 1);
    }
  }

  const seed = pickSeed(mb, seeds);
  const m = content.newMessage({ fromEmail: mb.email, fromName: mb.display_name });
  await sendFromMailbox(mb, seed, m, dry);
  setNextSlot(mb.id, target - sent - 1);
}

// Seed → mailbox replies whose random 15–180 min delay has passed
async function sendDueSeedReplies(dry) {
  if (dry) return; // nothing real to reply to in dry run; due replies wait
  const now = new Date();
  const due = db.prepare(`
    SELECT o.*, m.email AS mailbox_email
    FROM outreach_warmup_messages o
    JOIN outreach_warmup_seeds s ON s.id = o.seed_id
    JOIN outreach_mailboxes m ON m.id = o.mailbox_id
    WHERE o.direction = 'out' AND o.status = 'sent' AND o.reply_due_at <= ? AND o.replied_at IS NULL
      AND s.status = 'active' AND s.can_automate = 1
    ORDER BY o.reply_due_at LIMIT 20
  `).all(toSql(now));

  for (const o of due) {
    if (now - fromSqlUtc(o.reply_due_at) > 24 * 3600000) { // stale (e.g. warmup was off)
      db.prepare('UPDATE outreach_warmup_messages SET reply_due_at = NULL WHERE id = ?').run(o.id);
      continue;
    }
    const seed = db.prepare('SELECT * FROM outreach_warmup_seeds WHERE id = ?').get(o.seed_id);
    if (!seed || seed.status !== 'active') continue;
    const m = content.replyMessage({ fromEmail: seed.email });
    const messageId = `<${crypto.randomUUID()}@${domainOf(seed.email)}>`;
    const refs = [o.references_header, o.message_id].filter(Boolean).join(' ');
    const subject = content.replySubject(o.subject);
    try {
      await smtpSend(seed, { from: seed.email, to: o.mailbox_email, subject, text: m.text, html: m.html, messageId, inReplyTo: o.message_id, references: refs });
    } catch (err) {
      seedError(seed, `SMTP: ${err.message}`);
      continue;
    }
    recordMsg({
      mailbox_id: o.mailbox_id, seed_id: seed.id, direction: 'reply', subject, message_id: messageId,
      in_reply_to: o.message_id, references_header: refs,
    });
    db.prepare('UPDATE outreach_warmup_messages SET replied_at = ?, reply_due_at = NULL WHERE id = ?').run(toSql(new Date()), o.id);
    log('info', `warmup seed ${seed.email} replied to ${o.mailbox_email} "${subject}"`, o.mailbox_id);
  }
}

let lastNoSeedLog = 0;

async function warmupTick() {
  if (!isOn() || !inWarmupWindow()) return;
  const dry = isDry();
  if (!dry && !process.env.ENCRYPTION_KEY) return;

  await sendDueSeedReplies(dry);

  const seeds = eligibleSeeds();
  if (!seeds.length) {
    if (Date.now() - lastNoSeedLog > 3600000) {
      log('warn', 'warmup is ON but there are no active seed inboxes — nothing to send to');
      lastNoSeedLog = Date.now();
    }
    return;
  }

  const mailboxes = db.prepare(`
    SELECT * FROM outreach_mailboxes
    WHERE seed_warmup_enabled = 1 AND smtp_host IS NOT NULL AND smtp_host != ''
      AND (next_warmup_at IS NULL OR next_warmup_at <= ?)
    ORDER BY RANDOM()
  `).all(toSql(new Date()));

  for (const mb of mailboxes) {
    if (!isOn() || !inWarmupWindow()) return;
    try { await mailboxTick(mb, seeds, dry); }
    catch (err) { log('error', `warmup failed: ${err.message}`, mb.id); }
  }
  checkPlacement();
}

// ── Seed engagement (IMAP) ───────────────────────────────────────────────────

function findSpamFolder(boxes, provider) {
  if (provider === 'gmail') {
    const g = boxes.find(b => /^\[(gmail|google mail)\]\/spam$/i.test(b.path));
    if (g) return g.path;
  }
  const special = boxes.find(b => b.specialUse === '\\Junk');
  if (special) return special.path;
  const named = boxes.find(b => /^(\[(gmail|google mail)\]\/spam|spam|junk|junk e-?mail|bulk mail|šlamštas|nepageidaujamas paštas)$/i.test(b.path) ||
    /^(spam|junk|junk e-?mail|šlamštas)$/i.test(b.name));
  return named ? named.path : null;
}

const normId = (id) => String(id || '').trim().replace(/^<?/, '<').replace(/>?$/, '>').toLowerCase();

// IMAP SEARCH HEADER Message-ID for each stored warmup message, OR-ed in
// chunks; returns Map(uid → row) for the selected folder.
async function searchByMessageId(client, rows) {
  const byId = new Map(rows.map(r => [normId(r.message_id), r]));
  const found = new Map();
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25).map(r => ({ header: { 'message-id': r.message_id } }));
    const uids = (await client.search(chunk.length === 1 ? chunk[0] : { or: chunk }, { uid: true })) || [];
    if (!uids.length) continue;
    // Confirm which stored message each hit is (OR search doesn't say)
    for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) {
      const row = byId.get(normId(m.envelope?.messageId));
      if (row) found.set(m.uid, row);
    }
  }
  return found;
}

async function engageSeed(seed) {
  const port = Number(seed.imap_port) || 993;
  const client = new ImapFlow({
    host: seed.imap_host, port, secure: port === 993,
    auth: { user: seed.imap_user || seed.email, pass: common.decrypt(seed.imap_pass) },
    logger: false, socketTimeout: 120000,
  });
  client.on('error', () => {});
  await client.connect();

  const counts = { inbox: 0, spam: 0, replies_planned: 0 };
  try {
    const spamPath = findSpamFolder(await client.list(), seed.provider);
    const folders = [['INBOX', 'inbox']];
    if (spamPath) folders.push([spamPath, 'spam']);
    const since = toSql(new Date(Date.now() - SEED_LOOKBACK_DAYS * 86400000));

    for (const [folder, kind] of folders) {
      // INBOX: only messages not placed yet. Spam: anything still there
      // (also retries a rescue whose move failed last time).
      const rows = db.prepare(`
        SELECT * FROM outreach_warmup_messages
        WHERE seed_id = ? AND direction = 'out' AND status = 'sent' AND message_id IS NOT NULL AND sent_at >= ?
          ${kind === 'inbox' ? "AND landed_in = 'unknown'" : ''}
      `).all(seed.id, since);
      if (!rows.length) continue;

      const lock = await client.getMailboxLock(folder);
      try {
        const hits = await searchByMessageId(client, rows);

        for (const [uid, row] of hits) {
          const firstSeen = row.landed_in === 'unknown';
          const flag = firstSeen && Math.random() < FLAG_CHANCE;
          await client.messageFlagsAdd(String(uid), flag ? ['\\Seen', '\\Flagged'] : ['\\Seen'], { uid: true });
          if (kind === 'spam') await client.messageMove(String(uid), 'INBOX', { uid: true });

          // Reply plan: only thread starters, decided once
          let replyPlanned = row.reply_planned;
          let replyDue = row.reply_due_at;
          if (replyPlanned === null && !row.in_reply_to) {
            replyPlanned = Math.random() < REPLY_CHANCE ? 1 : 0;
            replyDue = replyPlanned ? toSql(minutesFromNow(15, 180)) : null;
            if (replyPlanned) counts.replies_planned++;
          }
          db.prepare(`
            UPDATE outreach_warmup_messages
            SET landed_in = ?, rescued_from_spam = ?, opened_at = COALESCE(opened_at, ?),
                flagged = MAX(flagged, ?), reply_planned = ?, reply_due_at = ?
            WHERE id = ?
          `).run(firstSeen ? kind : row.landed_in, kind === 'spam' ? 1 : row.rescued_from_spam,
            toSql(new Date()), flag ? 1 : 0, replyPlanned, replyDue, row.id);
          counts[kind]++;
        }
      } finally {
        lock.release();
      }
    }
    if (!spamPath) log('warn', `warmup seed ${seed.email}: no Spam/Junk folder found — spam placement can't be measured`);
  } finally {
    await client.logout().catch(() => client.close());
  }

  db.prepare("UPDATE outreach_warmup_seeds SET last_error = NULL WHERE id = ? AND status = 'active'").run(seed.id);
  if (counts.inbox || counts.spam) {
    log('info', `warmup seed ${seed.email}: ${counts.inbox} landed in inbox, ${counts.spam} in spam (moved to inbox), ${counts.replies_planned} replies planned`);
  }
}

let seedRunning = false;

async function seedTick() {
  if (!isOn() || seedRunning) return;
  seedRunning = true;
  try {
    const due = db.prepare(`
      SELECT * FROM outreach_warmup_seeds
      WHERE status = 'active' AND can_automate = 1 AND imap_host IS NOT NULL AND imap_host != ''
        AND (last_check_at IS NULL OR last_check_at <= ?)
    `).all(toSql(new Date(Date.now() - SEED_CHECK_EVERY_MS)));
    for (const seed of due) {
      if (!isOn()) break;
      db.prepare('UPDATE outreach_warmup_seeds SET last_check_at = ? WHERE id = ?').run(toSql(new Date()), seed.id);
      try { await engageSeed(seed); }
      catch (err) { seedError(seed, `IMAP: ${err.responseText || err.message}`); }
    }
    checkPlacement();
  } finally {
    seedRunning = false;
  }
}

// ── Mailbox side: recognise warmup mail so it never reaches outreach ─────────

const idsIn = (text) => [...new Set(String(text || '').match(/<[^<>\s@]+@[^<>\s]+>/g) || [])].slice(0, 100);

// Returns a result label if the message is warmup traffic (caller hides it in
// the Warmup folder), or null for normal processing.
function classifyIncoming(mb, parsed, raw) {
  const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
  const seed = from ? db.prepare('SELECT * FROM outreach_warmup_seeds WHERE lower(email) = ?').get(from) : null;

  // In-Reply-To / References vs. the Message-IDs we stored
  const refs = idsIn([parsed.inReplyTo, ...[].concat(parsed.references || [])].join(' '));
  const inList = refs.map(() => '?').join(',');
  const thread = refs.length
    ? db.prepare(`SELECT * FROM outreach_warmup_messages WHERE message_id IN (${inList}) ORDER BY id DESC LIMIT 1`).get(...refs)
    : null;
  // The seed reply we recorded when sending it answers one of those messages
  let row = refs.length
    ? db.prepare(`SELECT * FROM outreach_warmup_messages WHERE direction = 'reply' AND mailbox_id = ? AND in_reply_to IN (${inList}) ORDER BY id DESC LIMIT 1`).get(mb.id, ...refs)
    : null;

  if (!seed && !row && !thread) {
    // A bounce of a warmup email → the seed address is broken
    const ct = parsed.headers.get('content-type');
    const looksLikeBounce = /^(mailer-daemon|postmaster)@/i.test(from) ||
      (ct && ct.value === 'multipart/report');
    if (!looksLikeBounce) return null;
    const ids = idsIn(raw);
    if (!ids.length) return null;
    const out = db.prepare(`SELECT * FROM outreach_warmup_messages WHERE direction = 'out' AND message_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(...ids);
    if (!out) return null;
    db.prepare("UPDATE outreach_warmup_messages SET status = 'failed', error = 'bounced' WHERE id = ?").run(out.id);
    const s = db.prepare('SELECT * FROM outreach_warmup_seeds WHERE id = ?').get(out.seed_id);
    if (s) seedError(s, 'a warmup email to this seed bounced');
    return 'warmup-bounce';
  }

  const now = toSql(new Date());
  if (row) {
    db.prepare("UPDATE outreach_warmup_messages SET landed_in = 'inbox', opened_at = COALESCE(opened_at, ?) WHERE id = ?").run(now, row.id);
  } else {
    const id = recordMsg({
      mailbox_id: mb.id, seed_id: seed ? seed.id : thread.seed_id, direction: 'reply',
      subject: parsed.subject || '', message_id: parsed.messageId || null,
      in_reply_to: parsed.inReplyTo || null, references_header: refs.join(' ') || null,
      sent_at: toSql(parsed.date && !isNaN(parsed.date) ? parsed.date : new Date()), landed_in: 'inbox', opened_at: now,
    });
    row = db.prepare('SELECT * FROM outreach_warmup_messages WHERE id = ?').get(id);
  }

  // Continue the thread once (~20%), only when it answers a thread starter
  if (row.reply_planned === null) {
    const parent = row.in_reply_to
      ? db.prepare("SELECT * FROM outreach_warmup_messages WHERE message_id = ? AND direction = 'out'").get(row.in_reply_to)
      : null;
    const go = !!(parent && !parent.in_reply_to && Math.random() < CONTINUE_CHANCE);
    db.prepare('UPDATE outreach_warmup_messages SET reply_planned = ?, continue_due_at = ? WHERE id = ?')
      .run(go ? 1 : 0, go ? toSql(minutesFromNow(15, 180)) : null, row.id);
  }
  return 'warmup';
}

// Mark read + move into "Warmup" (created if missing). Never throws.
async function hideInWarmupFolder(client, uid, mailboxId) {
  try {
    if (!client.__warmupPath) {
      const boxes = await client.list();
      let box = boxes.find(b => b.name.toLowerCase() === WARMUP_FOLDER.toLowerCase());
      if (!box) {
        try { box = { path: (await client.mailboxCreate(WARMUP_FOLDER)).path }; }
        catch { box = { path: WARMUP_FOLDER }; }
      }
      client.__warmupPath = box.path;
    }
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    await client.messageMove(String(uid), client.__warmupPath, { uid: true });
  } catch (err) {
    log('warn', `could not move warmup message to "${WARMUP_FOLDER}": ${err.message}`, mailboxId);
  }
}

// ── Safety: inbox placement per domain ───────────────────────────────────────

let lastPlacementCheck = 0;

function checkPlacement(force = false) {
  if (!force && Date.now() - lastPlacementCheck < 30 * 60000) return;
  lastPlacementCheck = Date.now();
  const since = toSql(new Date(Date.now() - HEALTH.PLACEMENT_WINDOW_DAYS * 86400000));
  const rows = db.prepare(`
    SELECT m.domain_id, d.domain,
      SUM(w.landed_in = 'inbox') AS inbox, SUM(w.landed_in = 'spam') AS spam
    FROM outreach_warmup_messages w
    JOIN outreach_mailboxes m ON m.id = w.mailbox_id
    JOIN outreach_domains d ON d.id = m.domain_id
    WHERE w.direction = 'out' AND w.status = 'sent' AND w.sent_at >= ? AND w.landed_in IN ('inbox', 'spam')
    GROUP BY m.domain_id
  `).all(since);

  for (const r of rows) {
    const total = r.inbox + r.spam;
    if (total < HEALTH.PLACEMENT_MIN_SAMPLES || r.inbox / total >= HEALTH.PLACEMENT_MIN) continue;
    const reason = `domain ${r.domain} inbox placement ${Math.round(r.inbox / total * 100)}% (${r.inbox}/${total} warmup emails, last ${HEALTH.PLACEMENT_WINDOW_DAYS} days) < ${HEALTH.PLACEMENT_MIN * 100}% — campaigns paused, warmup continues`;
    const boxes = db.prepare("SELECT id FROM outreach_mailboxes WHERE domain_id = ? AND status != 'paused'").all(r.domain_id);
    if (!boxes.length) continue;
    log('warn', `PLACEMENT AUTO-PAUSE: ${reason}`);
    for (const b of boxes) pauseMailbox(b.id, reason);
  }
}

module.exports = {
  warmupTick, seedTick, classifyIncoming, hideInWarmupFolder,
  dailyTarget, rampDay, isForbiddenRecipient, checkPlacement,
  RAMP_DAYS,
};
