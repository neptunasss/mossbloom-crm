'use strict';

// One-time migration — insert B2B orders missing after the data-loss incident.
// Safe to re-run: skips any (order_date, amount) pair that already exists.
const RECORDS = [
  { date: '2026-07-20', amount:  750.00 },
  { date: '2026-07-21', amount:  322.50 },
  { date: '2026-07-22', amount:  359.00 },
  { date: '2026-07-27', amount: 2075.00 },
  { date: '2026-08-14', amount:  967.50 },
  { date: '2026-09-01', amount: 2136.02 },
  { date: '2026-09-03', amount:  749.00 },
  { date: '2026-09-11', amount:  499.00 },
];
const DESCRIPTION = 'B2B užsakymas';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path     = require('path');
const Database = require('better-sqlite3');
const dataDir  = process.env.DATA_DIR || path.join(__dirname, '../../data');
const dbPath   = path.join(dataDir, 'mossbloom.db');

const db = new Database(dbPath);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_orders_date_amount
  ON b2b_orders(order_date, amount)
`);

const insert = db.prepare(`
  INSERT OR IGNORE INTO b2b_orders (customer_name, amount, description, order_date)
  VALUES (?, ?, ?, ?)
`);

let inserted = 0, skipped = 0;
for (const r of RECORDS) {
  const result = insert.run(DESCRIPTION, r.amount, DESCRIPTION, r.date);
  if (result.changes > 0) inserted++; else skipped++;
}

db.close();

console.log(`\nMissing B2B orders migration complete:`);
console.log(`  Inserted : ${inserted}`);
console.log(`  Skipped  : ${skipped} (already existed for that date+amount)`);
console.log(`  Total    : ${RECORDS.length} records checked`);
