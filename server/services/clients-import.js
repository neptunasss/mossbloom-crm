'use strict';

const db = require('../database');

function importClientsFromOrders() {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO clients (name, email, country, type, source)
    VALUES (?, ?, ?, 'b2c', 'woocommerce')
  `);

  // Unique emails from WC orders — get name + country from most recent order
  const rows = db.prepare(`
    SELECT customer_email, customer_name, data
    FROM orders_cache
    WHERE customer_email IS NOT NULL AND customer_email != ''
      AND (hidden IS NULL OR hidden = 0)
    ORDER BY date_created DESC
  `).all();

  const seen = new Set();
  let wcCount = 0;
  for (const row of rows) {
    if (seen.has(row.customer_email)) continue;
    seen.add(row.customer_email);
    let country = '';
    try {
      const order = JSON.parse(row.data);
      country = order.billing?.country || '';
    } catch {}
    ins.run(row.customer_name || '', row.customer_email, country);
    wcCount++;
  }

  // B2B clients without emails — insert by name only if not already present
  const b2bRows = db.prepare('SELECT DISTINCT customer_name FROM b2b_orders').all();
  let b2bCount = 0;
  for (const row of b2bRows) {
    const exists = db.prepare('SELECT id FROM clients WHERE name = ? AND (email IS NULL OR email = \'\')').get(row.customer_name);
    if (!exists) {
      db.prepare(`INSERT INTO clients (name, type, source) VALUES (?, 'b2b', 'b2b')`).run(row.customer_name);
      b2bCount++;
    }
  }

  console.log(`[clients] imported: ${wcCount} WC, ${b2bCount} B2B`);
  return { wc: wcCount, b2b: b2bCount };
}

module.exports = { importClientsFromOrders };
