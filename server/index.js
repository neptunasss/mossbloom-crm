require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

require('./database');

const telegram = require('./services/telegram');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
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

app.use(express.static(path.join(__dirname, '../public')));

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
  ];
  for (const [name, val] of envCheck) {
    const display = name.endsWith('_SECRET') || name.endsWith('_KEY') || name === 'SESSION_SECRET' || name === 'ADMIN_PASSWORD'
      ? (val ? `SET (${val.length} chars)` : 'MISSING ⚠️')
      : (val || 'MISSING ⚠️');
    console.log(`  ${name.padEnd(22)} = ${display}`);
  }
  console.log('───────────────────────────────────────────────\n');
  if (telegram.configured) {
    telegram.startPolling();
    telegram.startReminderCheck();
  } else {
    console.log('Telegram: not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to enable)');
  }
  console.log('');

  const sheetsSync     = require('./services/sheets-sync');
  const accountingSync = require('./services/accounting-sync');

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
  }, 3000);

  setInterval(() => autoSyncWoo('auto-sync'), 30 * 60 * 1000);
  setInterval(() => autoSyncSheets('sheets-sync'), 6 * 60 * 60 * 1000);
});
