const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');
const { stores, fetchAllStoreOrders } = require('../services/woocommerce');
const telegram = require('../services/telegram');
const { addOrderToQueue, markCompletedAsPristatyta, cleanupStaleGauta } = require('../services/production-queue');
const fx = require('../services/fx');

// List orders — WooCommerce cache + B2B manual orders
router.get('/', requireAuth, (req, res) => {
  const { store, status, search, limit = 300, offset = 0 } = req.query;

  // Load source tags into a lookup map
  const sourceMap = {};
  try {
    const allSources = db.prepare('SELECT store_id, order_id, source FROM order_sources').all();
    for (const s of allSources) sourceMap[`${s.store_id}:${s.order_id}`] = s.source;
  } catch {}

  // WC orders
  let wcOrders = [];
  if (!store || store === 'all' || store !== 'b2b') {
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

    query += ' ORDER BY date_created DESC';
    wcOrders = db.prepare(query).all(...params).map(o => ({
      ...o,
      source: sourceMap[`${o.store_id}:${String(o.order_id)}`] || null,
    }));
  }

  // B2B orders — from b2b_orders table + accounting_entries that have no b2b_orders record
  let b2bOrders = [];
  const includeB2b = !store || store === 'all' || store === 'b2b';
  const statusOk   = !status || status === 'all' || status === 'completed';
  if (includeB2b && statusOk) {
    // Orders created via UI button (b2b_orders table)
    let b2bQuery  = 'SELECT * FROM b2b_orders WHERE 1=1';
    const b2bArgs = [];
    if (search) {
      b2bQuery += ' AND (customer_name LIKE ? OR description LIKE ?)';
      const s = `%${search}%`;
      b2bArgs.push(s, s);
    }
    b2bQuery += ' ORDER BY order_date DESC';
    const uiB2b = db.prepare(b2bQuery).all(...b2bArgs);
    const uiB2bAcctIds = new Set(uiB2b.map(o => o.accounting_id).filter(Boolean));

    b2bOrders = uiB2b.map(o => ({
      store_id:       'b2b',
      order_id:       o.id,
      customer_name:  o.customer_name,
      customer_email: '',
      status:         'completed',
      total:          String(o.amount),
      currency:       o.currency || 'EUR',
      date_created:   o.order_date + 'T00:00:00',
      producer_status: null,
      is_b2b:         true,
      description:    o.description,
      has_invoice:    o.has_invoice,
      source:         sourceMap[`b2b:${String(o.id)}`] || null,
    }));

    // B2B income from accounting_entries without a b2b_orders link (e.g. b2b_import)
    let aeQuery  = `SELECT id, description, amount, currency, entry_date, notes, reference_id
      FROM accounting_entries
      WHERE type='income' AND source IN ('b2b','b2b_import')`;
    const aeArgs = [];
    if (search) {
      aeQuery += ' AND description LIKE ?';
      aeArgs.push(`%${search}%`);
    }
    aeQuery += ' ORDER BY entry_date DESC';
    const aeB2b = db.prepare(aeQuery).all(...aeArgs)
      .filter(e => !uiB2bAcctIds.has(e.id));

    b2bOrders.push(...aeB2b.map(e => ({
      store_id:       'b2b',
      order_id:       `ae-${e.id}`,
      customer_name:  e.description || 'B2B',
      customer_email: '',
      status:         'completed',
      total:          String(e.amount),
      currency:       e.currency || 'EUR',
      date_created:   e.entry_date + 'T00:00:00',
      producer_status: null,
      is_b2b:         true,
      description:    e.description,
      has_invoice:    e.notes?.includes('SF') ? 1 : 0,
      source:         sourceMap[`b2b:ae-${e.id}`] || null,
    })));
  }

  const allOrders = [...b2bOrders, ...wcOrders].sort((a, b) =>
    b.date_created.localeCompare(a.date_created)
  );

  const total   = allOrders.length;
  const sliced  = allOrders.slice(Number(offset), Number(offset) + Number(limit));
  res.json({ orders: sliced, total });
});

// Create a new B2B manual order
router.post('/b2b', requireAuth, (req, res) => {
  const { customer_name, amount, description, has_invoice, order_date } = req.body;

  if (!customer_name || !amount || !order_date) {
    return res.status(400).json({ error: 'customer_name, amount ir order_date privalomi' });
  }
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Netinkama suma' });
  }

  const notes = has_invoice ? 'SF išrašyta' : '';
  const desc  = description || customer_name;

  const acctResult = db.prepare(`
    INSERT INTO accounting_entries
      (type, source, store_id, description, amount, currency, entry_date, category, notes)
    VALUES ('income', 'b2b', 'b2b', ?, ?, 'EUR', ?, 'Pardavimai', ?)
  `).run(desc, amt, order_date, notes);

  const orderResult = db.prepare(`
    INSERT INTO b2b_orders (customer_name, amount, currency, description, has_invoice, order_date, accounting_id)
    VALUES (?, ?, 'EUR', ?, ?, ?, ?)
  `).run(customer_name, amt, description || '', has_invoice ? 1 : 0, order_date, acctResult.lastInsertRowid);

  res.status(201).json({
    id: orderResult.lastInsertRowid,
    customer_name, amount: amt, currency: 'EUR', description, has_invoice, order_date,
  });
});

// Standalone sync function — used by the route AND by startup/interval auto-sync
async function runSync() {
  const results = [];
  console.log('[sync] starting for', stores.map(s => `${s.id}(url=${s.url},key=${s.key ? 'set' : 'MISSING'})`).join(', '));

  for (const store of stores) {
    if (!store.url || !store.key || !store.secret) {
      console.error(`[sync] ${store.id} skipped — missing env vars (url=${store.url}, key=${store.key ? 'set' : 'MISSING'}, secret=${store.secret ? 'set' : 'MISSING'})`);
      results.push({ store: store.id, name: store.name, status: 'skipped', reason: 'not configured' });
      continue;
    }

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

      // Add new processing orders to production queue
      for (const order of orders) {
        if (['processing', 'on-hold'].includes(order.status)) {
          addOrderToQueue(store.id, order);
        }
      }

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

  // Sync production queue state with WC order statuses
  markCompletedAsPristatyta();
  cleanupStaleGauta();

  return results;
}

// Sync all stores from WooCommerce
router.post('/sync', requireAuth, async (req, res) => {
  const results = await runSync();
  res.json({ results });
});

// Update production status from the UI
router.patch('/:storeId/:orderId/producer-status', requireAuth, (req, res) => {
  const { storeId, orderId } = req.params;
  const { status } = req.body;
  const allowed = ['', 'started', 'ready'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE orders_cache SET producer_status = ? WHERE store_id = ? AND order_id = ?')
    .run(status || null, storeId, parseInt(orderId));
  res.json({ ok: true });
});

// Last sync info per store
router.get('/sync-status', requireAuth, async (req, res) => {
  const rate = await fx.getDkkPerEur().catch(() => 7.46);
  const thisMonth = new Date().toISOString().slice(0, 7);

  const statuses = stores.map(store => {
    const last = db.prepare(
      'SELECT status, orders_fetched, synced_at FROM sync_log WHERE store_id = ? ORDER BY synced_at DESC LIMIT 1'
    ).get(store.id);

    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM orders_cache WHERE store_id = ?').get(store.id);

    const monthRows = db.prepare(
      `SELECT total, currency FROM orders_cache
       WHERE store_id = ? AND substr(date_created,1,7) = ?
         AND status NOT IN ('cancelled','refunded','failed')`
    ).all(store.id, thisMonth);

    const monthOrders  = monthRows.length;
    const monthRevenue = monthRows.reduce((s, r) => s + fx.toEur(parseFloat(r.total) || 0, r.currency, rate), 0);

    return {
      store: store.id,
      name: store.name,
      label: store.label,
      color: store.color,
      orderCount: cnt,
      monthOrders,
      monthRevenue,
      configured: !!(store.url && store.key && store.secret),
      lastSync: last?.synced_at || null,
      lastSyncStatus: last?.status || null,
    };
  });

  res.json(statuses);
});

// Get order source tag
router.get('/:storeId/:orderId/source', requireAuth, (req, res) => {
  const { storeId, orderId } = req.params;
  try {
    const row = db.prepare('SELECT source FROM order_sources WHERE store_id = ? AND order_id = ?').get(storeId, orderId);
    res.json({ source: row?.source || null });
  } catch {
    res.json({ source: null });
  }
});

// Set/update order source tag
router.put('/:storeId/:orderId/source', requireAuth, (req, res) => {
  const { storeId, orderId } = req.params;
  const { source } = req.body;
  const ALLOWED = ['Meta', 'Google', 'Organic', 'Referral', 'Repeat', 'B2B outbound', 'Other'];
  if (source && !ALLOWED.includes(source)) return res.status(400).json({ error: 'Invalid source' });
  try {
    if (!source) {
      db.prepare('DELETE FROM order_sources WHERE store_id = ? AND order_id = ?').run(storeId, orderId);
    } else {
      db.prepare(`
        INSERT INTO order_sources (store_id, order_id, source) VALUES (?, ?, ?)
        ON CONFLICT(store_id, order_id) DO UPDATE SET source = excluded.source
      `).run(storeId, orderId, source);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, runSync };
