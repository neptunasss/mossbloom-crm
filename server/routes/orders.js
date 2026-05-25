const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');
const { stores, fetchAllStoreOrders } = require('../services/woocommerce');
const telegram = require('../services/telegram');

// List orders from local cache
router.get('/', requireAuth, (req, res) => {
  const { store, status, search, limit = 300, offset = 0 } = req.query;

  let query = `
    SELECT store_id, order_id, customer_name, customer_email,
           status, total, currency, date_created, producer_status
    FROM orders_cache WHERE 1=1
  `;
  const params = [];

  if (store && store !== 'all') {
    query += ' AND store_id = ?';
    params.push(store);
  }
  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    query += ' AND (customer_name LIKE ? OR customer_email LIKE ? OR CAST(order_id AS TEXT) LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  query += ' ORDER BY date_created DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const orders = db.prepare(query).all(...params);
  const { cnt: total } = db.prepare('SELECT COUNT(*) as cnt FROM orders_cache').get();

  res.json({ orders, total });
});

// Sync all stores from WooCommerce
router.post('/sync', requireAuth, async (req, res) => {
  const results = [];
  console.log('[sync] starting sync for', stores.map(s => `${s.id}(url=${s.url},key=${s.key ? 'set' : 'MISSING'})`).join(', '));

  for (const store of stores) {
    if (!store.url || !store.key || !store.secret) {
      console.error(`[sync] ${store.id} skipped — missing env vars (url=${store.url}, key=${store.key ? 'set' : 'MISSING'}, secret=${store.secret ? 'set' : 'MISSING'})`);
      results.push({ store: store.id, name: store.name, status: 'skipped', reason: 'not configured' });
      continue;
    }

    // Check if this store has been synced before (to avoid spamming on first sync)
    const wasSyncedBefore = db.prepare(
      'SELECT id FROM sync_log WHERE store_id = ? AND status = ? LIMIT 1'
    ).get(store.id, 'success');

    try {
      const orders = await fetchAllStoreOrders(store);

      const upsert = db.prepare(`
        INSERT INTO orders_cache
          (store_id, order_id, customer_name, customer_email, status, total, currency, date_created, data, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(store_id, order_id) DO UPDATE SET
          customer_name  = excluded.customer_name,
          customer_email = excluded.customer_email,
          status         = excluded.status,
          total          = excluded.total,
          currency       = excluded.currency,
          date_created   = excluded.date_created,
          data           = excluded.data,
          synced_at      = excluded.synced_at
      `);

      db.exec('BEGIN');
      try {
        for (const order of orders) {
          const first = order.billing?.first_name || '';
          const last  = order.billing?.last_name  || '';
          const name  = `${first} ${last}`.trim() || order.billing?.email || 'Unknown';
          upsert.run(
            store.id, order.id, name,
            order.billing?.email || '',
            order.status, order.total, order.currency,
            order.date_created, JSON.stringify(order)
          );
        }
        db.exec('COMMIT');
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }

      // Send Telegram notifications for new orders (skip on first-ever sync to avoid flood)
      if (wasSyncedBefore && telegram.configured) {
        const unnotified = db.prepare(`
          SELECT * FROM orders_cache
          WHERE store_id = ?
            AND date_created > datetime('now', '-14 days')
            AND NOT EXISTS (
              SELECT 1 FROM telegram_notifications
              WHERE store_id = orders_cache.store_id
                AND order_id = orders_cache.order_id
            )
          ORDER BY date_created DESC
          LIMIT 20
        `).all(store.id);

        for (const o of unnotified) {
          await telegram.sendOrderNotification(store.id, o);
        }
      }

      db.prepare('INSERT INTO sync_log (store_id, status, orders_fetched) VALUES (?, ?, ?)')
        .run(store.id, 'success', orders.length);

      results.push({ store: store.id, name: store.name, status: 'success', count: orders.length });
    } catch (err) {
      console.error(`[sync] ${store.id} error: ${err.message}`, err.stack);
      db.prepare('INSERT INTO sync_log (store_id, status, error_message) VALUES (?, ?, ?)')
        .run(store.id, 'error', err.message);

      results.push({ store: store.id, name: store.name, status: 'error', error: err.message });
    }
  }

  res.json({ results });
});

// Last sync info per store
router.get('/sync-status', requireAuth, (req, res) => {
  const statuses = stores.map(store => {
    const last = db.prepare(
      'SELECT status, orders_fetched, synced_at FROM sync_log WHERE store_id = ? ORDER BY synced_at DESC LIMIT 1'
    ).get(store.id);

    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM orders_cache WHERE store_id = ?').get(store.id);

    return {
      store: store.id,
      name: store.name,
      label: store.label,
      color: store.color,
      orderCount: cnt,
      configured: !!(store.url && store.key && store.secret),
      lastSync: last?.synced_at || null,
      lastSyncStatus: last?.status || null,
    };
  });

  res.json(statuses);
});

module.exports = router;
