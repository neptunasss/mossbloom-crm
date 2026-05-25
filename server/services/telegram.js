const axios = require('axios');

const STORE_EMOJI = { bloom_lt: '🟢', mossbloom_dk: '🔵', mossbloom_de: '🔴' };
const STORE_NAME  = { bloom_lt: 'bloom.lt', mossbloom_dk: 'mossbloom.dk', mossbloom_de: 'mossbloom.de' };

const LT_MONTHS = [
  'sausio','vasario','kovo','balandžio','gegužės',
  'birželio','liepos','rugpjūčio','rugsėjo','spalio','lapkričio','gruodžio',
];

class TelegramService {
  constructor() {
    this.offset        = 0;
    this.polling       = false;
    this._reminderTimer = null;
  }

  get token()      { return process.env.TELEGRAM_BOT_TOKEN; }
  get chatId()     { return process.env.TELEGRAM_CHAT_ID; }
  get apiBase()    { return `https://api.telegram.org/bot${this.token}`; }
  get configured() { return !!(this.token && this.chatId); }

  async call(method, data = {}) {
    const res = await axios.post(`${this.apiBase}/${method}`, data, { timeout: 35000 });
    return res.data.result;
  }

  // ── New order notification ──────────────────────────────────────────────────

  async sendOrderNotification(storeId, order) {
    if (!this.configured) return;

    const emoji     = STORE_EMOJI[storeId] || '🛍️';
    const storeName = STORE_NAME[storeId]  || storeId;

    let produktai = '—';
    try {
      const d = JSON.parse(order.data || '{}');
      if (d.line_items && d.line_items.length) {
        produktai = d.line_items.map(i => `• ${i.name} × ${i.quantity}`).join('\n');
      }
    } catch {}

    const deadline = addWorkingDays(order.date_created || new Date(), 5);

    const text = [
      `🌿 <b>Naujas užsakymas!</b>`,
      '',
      `📦 Parduotuvė: <b>${esc(storeName)}</b> ${emoji}`,
      `🔢 Užsakymas: <b>#${order.order_id}</b>`,
      `👤 Klientas: ${esc(order.customer_name || 'Nežinoma')}`,
      `🛍️ Produktas:\n${produktai}`,
      `💰 Suma: <b>${fmtTotal(order.total, order.currency)}</b>`,
      `📅 Pristatyti iki: <b>${fmtDateLT(deadline)}</b>`,
      '',
      'Pasirink statusą:',
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [[
        { text: '▶️ Pradėti gamybą',  callback_data: `start|${storeId}|${order.order_id}` },
        { text: '✅ Paruošta siųsti', callback_data: `ready|${storeId}|${order.order_id}` },
      ]],
    };

    try {
      const msg = await this.call('sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup,
      });

      const db = require('../database');
      db.prepare('INSERT OR IGNORE INTO telegram_notifications (store_id, order_id, message_id) VALUES (?, ?, ?)')
        .run(storeId, order.order_id, msg ? msg.message_id : 0);

      return msg;
    } catch (err) {
      console.error('[Telegram] Siuntimas nepavyko:', err.message);
    }
  }

  // ── 24-hour reminder ────────────────────────────────────────────────────────

  async sendReminder(storeId, order, notifId) {
    if (!this.configured) return;

    const text = [
      `⚠️ <b>Priminimas!</b>`,
      '',
      `Užsakymas <b>#${order.order_id}</b> dar nepradėtas.`,
      `👤 Klientas: ${esc(order.customer_name || 'Nežinoma')}`,
      `💰 Suma: <b>${fmtTotal(order.total, order.currency)}</b>`,
      `⏰ Jau praėjo 24+ valandos`,
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [[
        { text: '▶️ Pradėti gamybą',  callback_data: `start|${storeId}|${order.order_id}` },
        { text: '✅ Paruošta siųsti', callback_data: `ready|${storeId}|${order.order_id}` },
      ]],
    };

    try {
      await this.call('sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup,
      });

      const db = require('../database');
      db.prepare("UPDATE telegram_notifications SET reminded_at = datetime('now') WHERE id = ?").run(notifId);
    } catch (err) {
      console.error('[Telegram] Priminimas nepavyko:', err.message);
    }
  }

  // ── Callback handler ────────────────────────────────────────────────────────

  async handleCallback(callbackQuery) {
    const [action, storeId, orderIdStr] = (callbackQuery.data || '').split('|');
    const orderId = parseInt(orderIdStr);

    if (action === 'noop') {
      await this.call('answerCallbackQuery', {
        callback_query_id: callbackQuery.id, text: '',
      }).catch(() => {});
      return;
    }

    if (!['start', 'ready'].includes(action) || !storeId || !orderId) return;

    const db = require('../database');
    const status = action === 'start' ? 'started' : 'ready';

    db.prepare('UPDATE orders_cache SET producer_status = ? WHERE store_id = ? AND order_id = ?')
      .run(status, storeId, orderId);

    const confirmText = action === 'start'
      ? `✅ Užsakymas #${orderId} — pradėtas!`
      : `✅ Užsakymas #${orderId} — paruoštas siųsti!`;

    const newKeyboard = action === 'start'
      ? { inline_keyboard: [[
          { text: '▶️ Gaminama ✓',    callback_data: `noop|${storeId}|${orderId}` },
          { text: '✅ Paruošta siųsti', callback_data: `ready|${storeId}|${orderId}` },
        ]] }
      : { inline_keyboard: [[
          { text: '✅ Paruošta siųsti! Atlikta.', callback_data: `noop|${storeId}|${orderId}` },
        ]] };

    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: confirmText,
        show_alert: false,
      });
      await this.call('editMessageReplyMarkup', {
        chat_id:    callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        reply_markup: newKeyboard,
      });
    } catch (err) {
      console.error('[Telegram] Atsakymas nepavyko:', err.message);
    }
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  startPolling() {
    if (!this.configured || this.polling) return;
    this.polling = true;
    console.log('[Telegram] Bot polling started');
    this._poll();
  }

  async _poll() {
    while (this.polling) {
      try {
        const updates = await this.call('getUpdates', {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ['callback_query'],
        });
        for (const u of (updates || [])) {
          this.offset = u.update_id + 1;
          if (u.callback_query) await this.handleCallback(u.callback_query);
        }
      } catch {
        await sleep(5000);
      }
    }
  }

  // ── Reminder scheduler ──────────────────────────────────────────────────────

  startReminderCheck() {
    if (!this.configured) return;
    // First check 2 minutes after startup, then every 60 minutes
    setTimeout(() => this._checkReminders(), 2 * 60 * 1000);
    this._reminderTimer = setInterval(() => this._checkReminders(), 60 * 60 * 1000);
    console.log('[Telegram] Reminder check scheduled (every 60 min)');
  }

  async _checkReminders() {
    if (!this.configured) return;
    try {
      const db = require('../database');
      const overdue = db.prepare(`
        SELECT
          oc.store_id, oc.order_id, oc.customer_name, oc.total, oc.currency,
          tn.id as notif_id
        FROM orders_cache oc
        JOIN telegram_notifications tn
          ON tn.store_id = oc.store_id AND tn.order_id = oc.order_id
        WHERE (oc.producer_status IS NULL OR oc.producer_status = '')
          AND tn.sent_at < datetime('now', '-24 hours')
          AND tn.reminded_at IS NULL
      `).all();

      for (const order of overdue) {
        await this.sendReminder(order.store_id, order, order.notif_id);
        await sleep(600);
      }

      if (overdue.length > 0) {
        console.log(`[Telegram] Išsiųsta ${overdue.length} priminimas(-ų)`);
      }
    } catch (err) {
      console.error('[Telegram] Priminimų tikrinimas nepavyko:', err.message);
    }
  }

  stopPolling() {
    this.polling = false;
    if (this._reminderTimer) {
      clearInterval(this._reminderTimer);
      this._reminderTimer = null;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDateLT(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${LT_MONTHS[d.getMonth()]} ${d.getFullYear()} d.`;
}

function fmtTotal(total, currency) {
  const n = parseFloat(total || 0).toFixed(2);
  const sym = { EUR: '€', USD: '$', GBP: '£' }[currency];
  return currency === 'DKK' ? `${n} kr` : sym ? `${sym}${n}` : `${currency || ''} ${n}`.trim();
}

// Add `days` working days (skip Saturday + Sunday) to a date string or Date.
function addWorkingDays(dateStr, days) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return new Date();
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

module.exports = new TelegramService();
