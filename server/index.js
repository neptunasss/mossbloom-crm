require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');

require('./database');

const telegram = require('./services/telegram');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

// 10mb: outreach CSV lead import posts parsed rows as JSON (default 100kb → HTTP 413)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(session({
  store: new SQLiteStore({ dir: DATA_DIR, db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET || 'mossbloom-crm-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

const ordersModule = require('./routes/orders');

app.use('/api/auth',       require('./routes/auth'));
app.use('/api/orders',     ordersModule.router);
app.use('/api/customers',  require('./routes/customers'));
app.use('/api/deals',      require('./routes/deals'));
app.use('/api/files',      require('./routes/files'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/production', require('./routes/production').router);
app.use('/api/products',  require('./routes/products'));
app.use('/api/invoices',  require('./routes/invoices'));
app.use('/api/clients',   require('./routes/clients'));
app.use('/api/todos',     require('./routes/todos'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/outreach',  require('./routes/outreach'));

// Public (no auth) — unsubscribe links from outreach emails
app.use('/u', require('./routes/unsubscribe'));

app.use(express.static(path.join(__dirname, '../public')));

// Outreach worker: separate process in the same service (it needs the same
// SQLite volume). Auto-restarts 30s after a crash.
function startOutreachWorker() {
  if (process.env.OUTREACH_WORKER_DISABLED === 'true') {
    console.log('[WORKER] disabled via OUTREACH_WORKER_DISABLED=true');
    return;
  }
  const { fork } = require('child_process');
  const readline = require('readline');
  let child = null;
  let stopping = false;

  const spawn = () => {
    child = fork(path.join(__dirname, 'worker/index.js'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    readline.createInterface({ input: child.stdout }).on('line', l => console.log(`[WORKER] ${l}`));
    readline.createInterface({ input: child.stderr }).on('line', l => console.error(`[WORKER] ${l}`));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      console.error(`[WORKER] exited (code ${code}, signal ${signal}) — restarting in 30s`);
      setTimeout(spawn, 30000);
    });
  };

  const shutdown = () => {
    stopping = true;
    if (!child) process.exit(0);
    child.once('exit', () => process.exit(0));
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 25000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  spawn();
}

app.listen(PORT, () => {
  const pwd = process.env.ADMIN_PASSWORD || 'mossbloom2024';
  console.log(`\nMossbloom CRM → http://localhost:${PORT}`);
  console.log(`Login: admin / ${pwd}`);

  // ENV CHECK — printed on every startup so Railway logs show config state
  console.log('\n── ENV CHECK ──────────────────────────────────');
  const envCheck = [
    ['BLOOM_LT_URL',        process.env.BLOOM_LT_URL],
    ['BLOOM_LT_KEY',        process.env.BLOOM_LT_KEY],
    ['BLOOM_LT_SECRET',     process.env.BLOOM_LT_SECRET],
    ['MOSSBLOOM_DK_URL',    process.env.MOSSBLOOM_DK_URL],
    ['MOSSBLOOM_DK_KEY',    process.env.MOSSBLOOM_DK_KEY],
    ['MOSSBLOOM_DK_SECRET', process.env.MOSSBLOOM_DK_SECRET],
    ['MOSSBLOOM_DE_URL',    process.env.MOSSBLOOM_DE_URL],
    ['MOSSBLOOM_DE_KEY',    process.env.MOSSBLOOM_DE_KEY],
    ['MOSSBLOOM_DE_SECRET', process.env.MOSSBLOOM_DE_SECRET],
    ['SESSION_SECRET',      process.env.SESSION_SECRET],
    ['ADMIN_PASSWORD',      process.env.ADMIN_PASSWORD],
    ['TELEGRAM_BOT_TOKEN',  process.env.TELEGRAM_BOT_TOKEN],
    ['GOOGLE_SHEET_ID',     process.env.GOOGLE_SHEET_ID],
    ['GOOGLE_SERVICE_ACCOUNT_EMAIL', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL],
    ['GOOGLE_SERVICE_ACCOUNT_KEY', process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? `SET (${process.env.GOOGLE_SERVICE_ACCOUNT_KEY.length} chars)` : 'MISSING ⚠️'],
    ['ENCRYPTION_KEY',      process.env.ENCRYPTION_KEY],
    ['PUBLIC_URL',          process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `(from RAILWAY_PUBLIC_DOMAIN) https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)],
  ];
  for (const [name, val] of envCheck) {
    const display = name.endsWith('_SECRET') || name.endsWith('_KEY') || name === 'SESSION_SECRET' || name === 'ADMIN_PASSWORD'
      ? (val ? `SET (${val.length} chars)` : 'MISSING ⚠️')
      : (val || 'MISSING ⚠️');
    console.log(`  ${name.padEnd(22)} = ${display}`);
  }
  console.log('───────────────────────────────────────────────\n');
  startOutreachWorker();
  if (telegram.configured) {
    telegram.startPolling();
    telegram.startReminderCheck();
  } else {
    console.log('Telegram: not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to enable)');
  }
  console.log('');

  const sheetsSync        = require('./services/sheets-sync');
  const accountingSync    = require('./services/accounting-sync');
  const { syncProductNames }    = require('./services/product-names');
  const { importClientsFromOrders } = require('./services/clients-import');

  async function autoSyncWoo(label) {
    console.log(`[${label}] WooCommerce sync starting...`);
    try {
      const results = await ordersModule.runSync();
      const total   = results.reduce((sum, r) => sum + (r.count || 0), 0);
      const summary = results.map(r => r.status === 'success' ? `${r.name}: ${r.count}` : `${r.name}: ${r.status}`).join(', ');
      console.log(`[${label}] WooCommerce sync complete: ${total} orders (${summary})`);
    } catch (err) {
      console.error(`[${label}] WooCommerce sync failed:`, err.message);
    }
  }

  async function autoSyncAccounting(label) {
    try {
      const { woocommerce: wc, sandoriai: sa } = accountingSync.syncAccountingEntries();
      console.log(`[${label}] accounting entries: WC +${wc.added}, Sandoriai +${sa.added}`);
    } catch (err) {
      console.error(`[${label}] accounting sync failed:`, err.message);
    }
  }

  async function autoSyncSheets(label) {
    try {
      const sheetResult = await sheetsSync.runSync();
      if (sheetResult.ok) {
        console.log(
          `[${label}] Google Sheets sync complete: +${sheetResult.total.added} new, ` +
          `${sheetResult.total.skipped} existing`,
        );
      }
    } catch (err) {
      console.error(`[${label}] Google Sheets sync failed:`, err.message);
    }
  }

  setTimeout(async () => {
    await autoSyncWoo('startup');
    await autoSyncAccounting('startup');
    await autoSyncSheets('startup');
    try {
      const r = await syncProductNames();
      console.log(`[startup] product names: LT +${r.lt}, DK +${r.dk}`);
    } catch (err) {
      console.error('[startup] product names sync failed:', err.message);
    }
    try {
      importClientsFromOrders();
    } catch (err) {
      console.error('[startup] clients import failed:', err.message);
    }
  }, 3000);

  setInterval(() => autoSyncWoo('auto-sync'), 30 * 60 * 1000);
  setInterval(() => autoSyncSheets('sheets-sync'), 6 * 60 * 60 * 1000);
});
