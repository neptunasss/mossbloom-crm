'use strict';

// Outreach email worker — runs as a child process of server/index.js (same
// Railway service, so it can reach the SQLite volume). Never import this
// from the web process.

require('dotenv').config();

const db     = require('../database');
const common = require('../services/outreach-common');
const { sendTick, recoverStuckSending } = require('./send');
const { imapTick } = require('./imap');
const { localDate } = require('./time');

const { workerLog: log, getSetting, setSetting } = common;

const WARMUP_DAYS = 18;

// ── Once-per-day jobs (Europe/Vilnius calendar day) ──────────────────────────

function runWarmup() {
  const today = localDate();
  const due = db.prepare(`
    SELECT * FROM outreach_mailboxes
    WHERE warmup_mode = 1 AND (warmup_last_date IS NULL OR warmup_last_date != ?)
  `).all(today);

  for (const mb of due) {
    const day = mb.warmup_day || 0;
    const start = mb.warmup_start_limit ?? 3;
    const end = mb.warmup_end_limit ?? 30;
    const limit = Math.round(start + (end - start) * day / WARMUP_DAYS);
    const nextDay = day + 1;
    if (nextDay >= WARMUP_DAYS) {
      db.prepare(`
        UPDATE outreach_mailboxes
        SET warmup_daily_limit = ?, warmup_day = ?, warmup_last_date = ?, warmup_mode = 0,
            status = CASE WHEN status = 'warmup' THEN 'active' ELSE status END
        WHERE id = ?
      `).run(limit, nextDay, today, mb.id);
      log('info', `warmup finished after ${WARMUP_DAYS} days — warmup_mode off, now using daily_limit (${mb.daily_limit})`, mb.id);
    } else {
      db.prepare('UPDATE outreach_mailboxes SET warmup_daily_limit = ?, warmup_day = ?, warmup_last_date = ? WHERE id = ?')
        .run(limit, nextDay, today, mb.id);
      log('info', `warmup day ${day}: limit ${limit}/day`, mb.id);
    }
  }
}

function runMaintenance() {
  const today = localDate();
  if (getSetting('maintenance_last_date') === today) return;
  setSetting('maintenance_last_date', today);
  const logs = db.prepare("DELETE FROM outreach_worker_log WHERE timestamp < datetime('now', '-30 days')").run().changes;
  const msgs = db.prepare("DELETE FROM outreach_processed_messages WHERE processed_at < datetime('now', '-180 days')").run().changes;
  if (logs || msgs) log('info', `maintenance: pruned ${logs} log rows, ${msgs} processed-message rows`);
}

// ── Scheduling ───────────────────────────────────────────────────────────────

let sending = false;
let stopping = false;
const timers = [];

function guard(name, fn) {
  return async () => {
    if (stopping) return;
    try { await fn(); } catch (err) {
      log('error', `${name} failed: ${err.stack || err.message}`);
    }
  };
}

const sendLoop = guard('send loop', async () => {
  if (sending) return;
  sending = true;
  try { await sendTick(); } finally { sending = false; }
});
const imapLoop  = guard('IMAP check', imapTick);
const dailyLoop = guard('daily jobs', () => { runWarmup(); runMaintenance(); });

function start() {
  const dry = getSetting('dry_run', 'true') !== 'false';
  log('info', `worker started (pid ${process.pid}) — dry_run=${dry}, global_paused=${getSetting('global_paused', 'false')}`);
  if (!process.env.ENCRYPTION_KEY) {
    log('warn', 'ENCRYPTION_KEY not set — mailbox passwords cannot be decrypted, live sending and IMAP disabled');
  } else {
    const n = common.encryptExistingMailboxPasswords();
    if (n) log('info', `encrypted plaintext passwords for ${n} mailbox(es)`);
  }
  if (!common.publicBaseUrl()) log('warn', 'PUBLIC_URL not set — unsubscribe links cannot be built, live sending blocked');

  recoverStuckSending();

  dailyLoop();
  timers.push(setTimeout(sendLoop, 5000));
  timers.push(setInterval(sendLoop, 60000));
  timers.push(setTimeout(imapLoop, 15000));
  timers.push(setInterval(imapLoop, 60000));
  timers.push(setInterval(dailyLoop, 10 * 60000));
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  timers.forEach(t => clearInterval(t));
  log('info', `worker stopping (${reason})`);
  // Let an in-flight SMTP send finish so its row isn't left in 'sending'
  const wait = setInterval(() => {
    if (!sending) { clearInterval(wait); process.exit(0); }
  }, 200);
  setTimeout(() => process.exit(0), 20000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('disconnect', () => shutdown('parent process gone'));
process.on('unhandledRejection', (err) => {
  log('error', `unhandled rejection: ${err && (err.stack || err.message || err)}`);
  process.exit(1); // parent restarts us after 30s
});

start();
