'use strict';

const db = require('../database');

const STORE_COUNTRY = {
  bloom_lt:     'LT',
  mossbloom_dk: 'DK',
  mossbloom_de: 'DE',
};

// Resolve country code — prefer billing, fallback to store_id
function getCountryCode(billingCountry, storeId) {
  const bc = (billingCountry || '').trim().toUpperCase();
  if (['LT','DK','DE'].includes(bc)) return bc;
  return STORE_COUNTRY[storeId] || '';
}

function addDays(dateStr, n) {
  const d = new Date(dateStr || new Date());
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Add all line items of a WooCommerce order to the queue (skips if already present)
function addOrderToQueue(storeId, order) {
  const existing = db.prepare(
    'SELECT id FROM production_queue WHERE order_id = ? AND store_id = ? LIMIT 1'
  ).get(String(order.id), storeId);
  if (existing) return 0;

  const country     = getCountryCode(order.billing?.country, storeId);
  const items       = order.line_items || [];
  const dueDate     = addDays((order.date_created || '').slice(0, 10), 14);
  const orderNumber = order.number ? `#${order.number}` : `#${order.id}`;

  let added = 0;

  if (items.length) {
    for (const item of items.slice(0, 5)) {
      const meta     = item.meta_data || [];
      const sizeMeta = meta.find(m =>
        ['pa_size', 'size', 'Size'].includes(m.key) ||
        (m.display_key || '').toLowerCase().includes('size')
      );
      const size = sizeMeta?.display_value || sizeMeta?.value || '';
      const img  = item.image?.src || '';

      db.prepare(`
        INSERT INTO production_queue
          (order_id, store_id, order_number, product_name, product_size, product_image,
           country, country_flag, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(order.id), storeId, orderNumber,
        item.name || `Užsakymas ${orderNumber}`, size, img,
        country, country, dueDate
      );
      added++;
    }
  } else {
    db.prepare(`
      INSERT INTO production_queue
        (order_id, store_id, order_number, product_name, country, country_flag, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(String(order.id), storeId, orderNumber,
      `Užsakymas ${orderNumber}`, country, country, dueDate);
    added++;
  }
  return added;
}

// Scan orders_cache and backfill any missing queue entries (only processing)
function populateFromCache() {
  const orders = db.prepare(`
    SELECT store_id, order_id, date_created, data FROM orders_cache
    WHERE status = 'processing'
    ORDER BY date_created DESC
    LIMIT 500
  `).all();

  let added = 0;
  for (const row of orders) {
    const existing = db.prepare(
      'SELECT id FROM production_queue WHERE order_id = ? AND store_id = ? LIMIT 1'
    ).get(String(row.order_id), row.store_id);
    if (existing) continue;

    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }

    const order = { ...parsed, id: row.order_id, date_created: row.date_created };
    added += addOrderToQueue(row.store_id, order);
  }
  return added;
}

// Move production cards to 'pristatyta' when their WC order is completed/cancelled
function markCompletedAsPristatyta() {
  db.prepare(`
    UPDATE production_queue
    SET stage = 'pristatyta', updated_at = datetime('now')
    WHERE stage != 'pristatyta'
      AND order_id IN (
        SELECT CAST(order_id AS TEXT) FROM orders_cache
        WHERE status IN ('completed','cancelled','refunded','failed')
      )
  `).run();
}

// Remove 'gauta' entries whose orders are no longer processing
function cleanupStaleGauta() {
  db.prepare(`
    DELETE FROM production_queue
    WHERE stage = 'gauta'
      AND order_id IN (
        SELECT CAST(order_id AS TEXT) FROM orders_cache
        WHERE status NOT IN ('processing','on-hold')
      )
  `).run();
}

// Fix existing rows that have blank country — backfill from store_id
function fixBlankCountries() {
  const rows = db.prepare(
    "SELECT id, store_id FROM production_queue WHERE country = '' OR country IS NULL"
  ).all();
  for (const r of rows) {
    const code = STORE_COUNTRY[r.store_id] || '';
    if (code) {
      db.prepare(
        "UPDATE production_queue SET country = ?, country_flag = ? WHERE id = ?"
      ).run(code, code, r.id);
    }
  }
  return rows.length;
}

module.exports = {
  addOrderToQueue,
  populateFromCache,
  markCompletedAsPristatyta,
  cleanupStaleGauta,
  fixBlankCountries,
  getCountryCode,
  addDays,
};
