'use strict';

// B2B orders YTD — source of truth, updated 2026-06-21
const B2B_ORDERS = [
  { date: '2026-01-08', amount: 3025.00, note: 'AVANSAS',                         invoice: true  },
  { date: '2026-02-19', amount: 5000.00, note: 'išmokėjo kitą dalį įmonė',        invoice: false },
  { date: '2026-02-20', amount:  170.00, note: null,                               invoice: true  },
  { date: '2026-03-12', amount:  629.20, note: null,                               invoice: true  },
  { date: '2026-03-19', amount:  314.60, note: null,                               invoice: true  },
  { date: '2026-04-07', amount: 2330.70, note: 'B2B',                              invoice: true  },
  { date: '2026-04-07', amount:   78.65, note: null,                               invoice: true  },
  { date: '2026-04-08', amount: 2000.00, note: 'VIS DAR TA PATI VELUOJANTI IMONE',invoice: true  },
  { date: '2026-05-13', amount: 1890.50, note: 'B2B',                              invoice: false },
  { date: '2026-05-18', amount:  968.00, note: null,                               invoice: false },
  { date: '2026-05-25', amount:  478.00, note: null,                               invoice: false },
  { date: '2026-05-29', amount:  794.97, note: null,                               invoice: false },
  { date: '2026-06-03', amount: 2420.00, note: null,                               invoice: false },
  { date: '2026-06-17', amount:  248.99, note: null,                               invoice: false },
];

// Stable reference ID: date + amount in cents — unique per record, safe to re-run
function refId(o) {
  return `b2b-${o.date}-${Math.round(o.amount * 100)}`;
}

function runImport(db) {
  let inserted = 0, skipped = 0, removed = 0;

  // Build set of valid reference IDs
  const validRefs = new Set(B2B_ORDERS.map(refId));

  // Remove stale b2b_import entries that are no longer in the list
  const existing = db.prepare("SELECT id, reference_id FROM accounting_entries WHERE source = 'b2b_import'").all();
  for (const row of existing) {
    if (!validRefs.has(row.reference_id)) {
      db.prepare('DELETE FROM accounting_entries WHERE id = ?').run(row.id);
      removed++;
    }
  }

  // Insert any missing entries
  for (const o of B2B_ORDERS) {
    const ref = refId(o);
    const exists = db.prepare(
      "SELECT id FROM accounting_entries WHERE source = 'b2b_import' AND reference_id = ?"
    ).get(ref);

    if (exists) { skipped++; continue; }

    const description = o.note || 'B2B užsakymas';
    const notes       = o.invoice ? 'SF išrašyta' : '';

    db.prepare(`
      INSERT INTO accounting_entries
        (type, source, store_id, reference_id, description, amount, currency, entry_date, category, notes)
      VALUES ('income', 'b2b_import', 'bloom_lt', ?, ?, ?, 'EUR', ?, 'Pardavimai', ?)
    `).run(ref, description, o.amount, o.date, notes);

    inserted++;
  }

  const expectedTotal = B2B_ORDERS.reduce((s, o) => s + o.amount, 0);
  return { inserted, skipped, removed, total: B2B_ORDERS.length, expectedTotal };
}

module.exports = { runImport, B2B_ORDERS };

// ── Standalone execution: node server/scripts/import-b2b.js ──────────────────
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  const path     = require('path');
  const Database = require('better-sqlite3');
  const dbPath   = path.join(__dirname, '../../data/mossbloom.db');

  const db     = new Database(dbPath);
  const result = runImport(db);
  db.close();

  console.log(`\nB2B import complete:`);
  console.log(`  Inserted : ${result.inserted}`);
  console.log(`  Skipped  : ${result.skipped} (already exist)`);
  console.log(`  Removed  : ${result.removed} (no longer in list)`);
  console.log(`  Total    : ${result.total} records`);
  console.log(`  Expected : €${result.expectedTotal.toFixed(2)}`);
}
