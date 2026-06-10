'use strict';

const db = require('../database');

function importClientsFromOrders() {
  // ── B2C: unique emails from WC orders ──────────────────────────────────────
  const insB2c = db.prepare(`
    INSERT OR IGNORE INTO clients (name, email, country, type, source)
    VALUES (?, ?, ?, 'b2c', 'woocommerce')
  `);
  const updCountry = db.prepare(`
    UPDATE clients SET country = ? WHERE email = ? AND (country IS NULL OR country = '')
  `);

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
    let country = '';
    try {
      const order = JSON.parse(row.data);
      country = order.billing?.country || order.billing_country || '';
    } catch {}
    if (seen.has(row.customer_email)) {
      // Still try to fill missing country for existing records
      if (country) updCountry.run(country, row.customer_email);
      continue;
    }
    seen.add(row.customer_email);
    insB2c.run(row.customer_name || '', row.customer_email, country);
    if (country) updCountry.run(country, row.customer_email);
    wcCount++;
  }

  // ── B2B: from accounting_entries (source='b2b' or 'b2b_import') ───────────
  // Use description as client name — each unique description becomes a B2B client
  const aeRows = db.prepare(`
    SELECT DISTINCT description FROM accounting_entries
    WHERE type = 'income' AND source IN ('b2b', 'b2b_import')
      AND description IS NOT NULL AND description != ''
    ORDER BY entry_date DESC
  `).all();

  let b2bCount = 0;
  for (const row of aeRows) {
    const name = (row.description || '').trim();
    if (!name) continue;
    const exists = db.prepare(
      "SELECT id FROM clients WHERE name = ? AND type = 'b2b'"
    ).get(name);
    if (!exists) {
      db.prepare(`INSERT INTO clients (name, type, source) VALUES (?, 'b2b', 'b2b')`).run(name);
      b2bCount++;
    }
  }

  // Also from b2b_orders table (UI-created orders)
  const b2bUIRows = db.prepare('SELECT DISTINCT customer_name FROM b2b_orders').all();
  for (const row of b2bUIRows) {
    const name = (row.customer_name || '').trim();
    if (!name) continue;
    const exists = db.prepare(
      "SELECT id FROM clients WHERE name = ? AND type = 'b2b'"
    ).get(name);
    if (!exists) {
      db.prepare(`INSERT INTO clients (name, type, source) VALUES (?, 'b2b', 'b2b')`).run(name);
      b2bCount++;
    }
  }

  console.log(`[clients] imported: ${wcCount} B2C (WC), ${b2bCount} B2B`);
  return { wc: wcCount, b2b: b2bCount };
}

module.exports = { importClientsFromOrders };
