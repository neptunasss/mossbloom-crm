'use strict';

const db = require('../database');

const COUNTRY_FLAG = { LT: '🇱🇹', DK: '🇩🇰', DE: '🇩🇪' };

function getFlag(country) {
  return COUNTRY_FLAG[(country || '').toUpperCase()] || '🌍';
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

  const country = order.billing?.country || '';
  const flag    = getFlag(country);
  const items   = order.line_items || [];
  const dueDate = addDays((order.date_created || '').slice(0, 10), 14);

  let added = 0;

  if (items.length) {
    for (const item of items.slice(0, 5)) {
      const meta     = item.meta_data || [];
      const sizeMeta = meta.find(m =>
        ['pa_size', 'size', 'Size'].includes(m.key) ||
        (m.display_key || '').toLowerCase().includes('size')
      );
      const size = sizeMeta?.value || sizeMeta?.display_value || '';
      const img  = item.image?.src || '';

      db.prepare(`
        INSERT INTO production_queue
          (order_id, store_id, order_number, product_name, product_size, product_image,
           country, country_flag, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(order.id), storeId, `#${order.id}`,
        item.name || 'Produktas', size, img,
        country, flag, dueDate
      );
      added++;
    }
  } else {
    db.prepare(`
      INSERT INTO production_queue
        (order_id, store_id, order_number, product_name, country, country_flag, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(String(order.id), storeId, `#${order.id}`, 'Užsakymas', country, flag, dueDate);
    added++;
  }
  return added;
}

// Scan orders_cache and backfill any missing queue entries
function populateFromCache() {
  const orders = db.prepare(`
    SELECT store_id, order_id, date_created, data FROM orders_cache
    WHERE status IN ('processing','completed','on-hold')
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

module.exports = { addOrderToQueue, populateFromCache, getFlag, addDays };
