const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'mossbloom.db'));

db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    order_id INTEGER NOT NULL,
    customer_name TEXT,
    customer_email TEXT,
    status TEXT,
    total TEXT,
    currency TEXT,
    date_created TEXT,
    data TEXT NOT NULL,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_id, order_id)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT,
    status TEXT,
    orders_fetched INTEGER DEFAULT 0,
    error_message TEXT,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS custom_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_email TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    store_id TEXT DEFAULT 'custom',
    description TEXT NOT NULL,
    amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'EUR',
    status TEXT DEFAULT 'pending',
    payment_method TEXT DEFAULT 'bank_transfer',
    notes TEXT DEFAULT '',
    deal_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS telegram_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    order_id INTEGER NOT NULL,
    message_id INTEGER DEFAULT 0,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_id, order_id)
  );



  CREATE TABLE IF NOT EXISTS order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT,
    order_id INTEGER,
    deal_id INTEGER,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT DEFAULT 'application/pdf',
    file_size INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounting_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'income',
    source TEXT DEFAULT 'manual',
    store_id TEXT DEFAULT '',
    reference_id TEXT DEFAULT '',
    description TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'EUR',
    entry_date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations — add columns if they don't exist yet
try { db.exec('ALTER TABLE orders_cache ADD COLUMN producer_status TEXT'); } catch {}
try { db.exec('ALTER TABLE custom_deals ADD COLUMN product TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE custom_deals ADD COLUMN size TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE telegram_notifications ADD COLUMN reminded_at DATETIME'); } catch {}
try { db.exec("ALTER TABLE accounting_entries ADD COLUMN category TEXT DEFAULT 'Kita'"); } catch {}
try { db.exec("ALTER TABLE accounting_entries ADD COLUMN notes TEXT DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE order_files ADD COLUMN accounting_id INTEGER'); } catch {}
try {
  db.exec(`CREATE TABLE IF NOT EXISTS b2b_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'EUR',
    description TEXT DEFAULT '',
    has_invoice INTEGER DEFAULT 0,
    order_date TEXT NOT NULL,
    accounting_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
} catch {}
// Back-fill category for auto-synced entries
try { db.exec("UPDATE accounting_entries SET category='Pardavimai' WHERE source IN ('woocommerce','sandoriai') AND (category IS NULL OR category='Kita')"); } catch {}
// Normalize expense categories from Google Sheets
try { db.exec("UPDATE accounting_entries SET category='Žaliavos' WHERE type='expense' AND (description LIKE '%RĖMAI%' OR description LIKE '%REMAI%' OR description LIKE '%SAMANOS%')"); } catch {}
try { db.exec("UPDATE accounting_entries SET category='Darbo užmokestis' WHERE type='expense' AND description LIKE '%ALGA%'"); } catch {}
try { db.exec("UPDATE accounting_entries SET category='Mokesčiai' WHERE type='expense' AND (description LIKE '%PVM%' OR description LIKE '%SODRA%' OR description LIKE '%VMI%')"); } catch {}
try { db.exec("UPDATE accounting_entries SET category='Reklama' WHERE type='expense' AND (description LIKE '%GOOGLE ADS%' OR description LIKE '%FACEBOOK ADS%')"); } catch {}
try { db.exec("UPDATE accounting_entries SET category='Siuntimas' WHERE type='expense' AND description LIKE '%SIUNTIMO%'"); } catch {}
try { db.exec("UPDATE accounting_entries SET category='Paslaugos' WHERE type='expense' AND description LIKE '%B2B PASLAUGOS%'"); } catch {}
try { db.exec("UPDATE accounting_entries SET category='Kitos išlaidos' WHERE type='expense' AND (description LIKE '%KITOS PREKE%' OR description LIKE '%KITOS IŠLAIDOS%' OR description LIKE '%KITOS ISLAIDOS%')"); } catch {}
// Clean up (SF: TRUE/FALSE) suffix from imported descriptions
try { db.exec("UPDATE accounting_entries SET description = REPLACE(REPLACE(description, ' (SF: FALSE)', ''), ' (SF: TRUE)', '') WHERE description LIKE '%(SF:%'"); } catch {}
// Production queue
try {
  db.exec(`CREATE TABLE IF NOT EXISTS production_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    store_id TEXT,
    order_number TEXT,
    product_name TEXT,
    product_size TEXT,
    product_image TEXT,
    country TEXT,
    country_flag TEXT,
    due_date TEXT,
    stage TEXT DEFAULT 'gauta',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
} catch {}

// Order source tagging
try {
  db.exec(`CREATE TABLE IF NOT EXISTS order_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_id, order_id)
  )`);
} catch {}

// Migrate old deal statuses → pipeline statuses
db.exec(`
  UPDATE custom_deals SET status = 'lead'        WHERE status = 'pending';
  UPDATE custom_deals SET status = 'negotiating' WHERE status = 'processing';
  UPDATE custom_deals SET status = 'won'         WHERE status = 'completed';
  UPDATE custom_deals SET status = 'lost'        WHERE status = 'cancelled';
`);


// Create default admin user if not exists
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existing) {
  const password = process.env.ADMIN_PASSWORD || 'mossbloom2024';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
  console.log(`Admin user created — password: ${password}`);
}

module.exports = db;
