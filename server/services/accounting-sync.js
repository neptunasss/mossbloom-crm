'use strict';

const db = require('../database');

// Sources that must never be touched by any sync operation
const PROTECTED_SOURCES = ['b2b', 'b2b_import', 'manual'];

/** Promote orders_cache + won deals into accounting_entries (idempotent). */
function syncAccountingEntries() {
  const wc = { added: 0, skipped: 0 };
  const sa = { added: 0, skipped: 0 };

  const orders = db.prepare(`
    SELECT * FROM orders_cache WHERE status IN ('completed','processing')
  `).all();

  for (const o of orders) {
    const exists = db.prepare(`
      SELECT id FROM accounting_entries WHERE source='woocommerce' AND store_id=? AND reference_id=?
    `).get(o.store_id, String(o.order_id));

    if (exists) { wc.skipped++; continue; }

    const entryDate = (o.date_created || '').slice(0, 10) || new Date().toISOString().slice(0, 10);

    db.prepare(`
      INSERT INTO accounting_entries
        (type, source, store_id, reference_id, description, amount, currency, entry_date, category)
      VALUES ('income','woocommerce',?,?,?,?,?,'${entryDate}','Pardavimai')
    `).run(
      o.store_id,
      String(o.order_id),
      `#${o.order_id} — ${o.customer_name || 'Unknown'}`,
      parseFloat(o.total) || 0,
      o.currency || 'EUR',
    );
    wc.added++;
  }

  const deals = db.prepare(`SELECT * FROM custom_deals WHERE status='won'`).all();

  for (const d of deals) {
    const exists = db.prepare(`
      SELECT id FROM accounting_entries WHERE source='sandoriai' AND reference_id=?
    `).get(String(d.id));

    if (exists) { sa.skipped++; continue; }

    const entryDate = d.deal_date || new Date().toISOString().slice(0, 10);
    const desc = d.description ? `${d.customer_name} — ${d.description}` : d.customer_name;

    db.prepare(`
      INSERT INTO accounting_entries
        (type, source, store_id, reference_id, description, amount, currency, entry_date, category)
      VALUES ('income','sandoriai',?,?,?,?,?,'${entryDate}','Pardavimai')
    `).run(d.store_id || 'custom', String(d.id), desc, parseFloat(d.amount) || 0, d.currency || 'EUR');
    sa.added++;
  }

  return { woocommerce: wc, sandoriai: sa };
}

module.exports = { syncAccountingEntries };
