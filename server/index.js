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

app.use('/api/auth',       require('./routes/auth'));
app.use('/api/orders',     require('./routes/orders'));
app.use('/api/customers',  require('./routes/customers'));
app.use('/api/deals',      require('./routes/deals'));
app.use('/api/files',      require('./routes/files'));
app.use('/api/accounting', require('./routes/accounting'));

app.use(express.static(path.join(__dirname, '../public')));

app.listen(PORT, () => {
  const pwd = process.env.ADMIN_PASSWORD || 'mossbloom2024';
  console.log(`\nMossbloom CRM → http://localhost:${PORT}`);
  console.log(`Login: admin / ${pwd}`);
  if (telegram.configured) {
    telegram.startPolling();
    telegram.startReminderCheck();
  } else {
    console.log('Telegram: not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to enable)');
  }
  console.log('');
});
