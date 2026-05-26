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

// Products catalog
try {
  db.exec(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    name TEXT,
    moss_type TEXT,
    store TEXT,
    frame_cost REAL,
    moss_cost REAL,
    extras_cost REAL,
    total_cost REAL,
    sell_price_eur REAL,
    sell_price_dkk REAL,
    gross_profit REAL,
    margin_pct REAL
  )`);

  const prow = db.prepare('SELECT COUNT(*) as cnt FROM products').get();
  if (prow.cnt === 0) {
    const SEED = [
      // LT - Ball moss
      {sku:'lt-30-ball',    name:'ø30cm — ball moss',   moss_type:'mini ball moss',     store:'LT', frame_cost:9.90,  moss_cost:12.47,  extras_cost:0,     sell_price_eur:79,     sell_price_dkk:null},
      {sku:'lt-40-ball',    name:'ø40cm — ball moss',   moss_type:'mini ball moss',     store:'LT', frame_cost:13.52, moss_cost:22.17,  extras_cost:0,     sell_price_eur:129,    sell_price_dkk:null},
      {sku:'lt-50-ball',    name:'ø50cm — ball moss',   moss_type:'pole moss (5) CN',   store:'LT', frame_cost:18.90, moss_cost:31.29,  extras_cost:0,     sell_price_eur:189,    sell_price_dkk:null},
      {sku:'lt-60-ball',    name:'ø60cm — ball moss',   moss_type:'pole moss (5) CN',   store:'LT', frame_cost:27.90, moss_cost:45.06,  extras_cost:0,     sell_price_eur:239,    sell_price_dkk:null},
      {sku:'lt-70-ball',    name:'ø70cm — ball moss',   moss_type:'pole moss (5) CN',   store:'LT', frame_cost:36.91, moss_cost:61.33,  extras_cost:0,     sell_price_eur:327.99, sell_price_dkk:null},
      {sku:'lt-80-ball',    name:'ø80cm — ball moss',   moss_type:'pole moss (5) CN',   store:'LT', frame_cost:48.59, moss_cost:80.10,  extras_cost:0,     sell_price_eur:399,    sell_price_dkk:null},
      {sku:'lt-90-ball',    name:'ø90cm — ball moss',   moss_type:'pole moss (5) CN',   store:'LT', frame_cost:61.20, moss_cost:101.38, extras_cost:0,     sell_price_eur:478,    sell_price_dkk:null},
      {sku:'lt-100-ball',   name:'ø100cm — ball moss',  moss_type:'pole moss (5) CN',   store:'LT', frame_cost:76.50, moss_cost:125.16, extras_cost:0,     sell_price_eur:599,    sell_price_dkk:null},
      {sku:'lt-120x30-ball',name:'120×30cm — ball moss',moss_type:'pole moss (5) CN',   store:'LT', frame_cost:25,    moss_cost:57.37,  extras_cost:0,     sell_price_eur:299,    sell_price_dkk:null},
      // LT - Mix
      {sku:'lt-30-mix',     name:'ø30cm — mix',         moss_type:'mix',                store:'LT', frame_cost:9.90,  moss_cost:15.41,  extras_cost:12.89, sell_price_eur:79,     sell_price_dkk:null},
      {sku:'lt-40-mix',     name:'ø40cm — mix',         moss_type:'mix',                store:'LT', frame_cost:13.52, moss_cost:27.40,  extras_cost:17.01, sell_price_eur:99,     sell_price_dkk:null},
      {sku:'lt-50-mix',     name:'ø50cm — mix',         moss_type:'mix',                store:'LT', frame_cost:18.90, moss_cost:42.81,  extras_cost:22.30, sell_price_eur:189,    sell_price_dkk:null},
      {sku:'lt-60-mix',     name:'ø60cm — mix',         moss_type:'mix',                store:'LT', frame_cost:27.90, moss_cost:61.64,  extras_cost:28.77, sell_price_eur:239,    sell_price_dkk:null},
      {sku:'lt-70-mix',     name:'ø70cm — mix',         moss_type:'mix',                store:'LT', frame_cost:36.91, moss_cost:83.90,  extras_cost:36.42, sell_price_eur:327.99, sell_price_dkk:null},
      {sku:'lt-80-mix',     name:'ø80cm — mix',         moss_type:'mix',                store:'LT', frame_cost:48.59, moss_cost:109.59, extras_cost:45.24, sell_price_eur:399,    sell_price_dkk:null},
      {sku:'lt-90-mix',     name:'ø90cm — mix',         moss_type:'mix',                store:'LT', frame_cost:61.20, moss_cost:138.70, extras_cost:55.24, sell_price_eur:478,    sell_price_dkk:null},
      {sku:'lt-100-mix',    name:'ø100cm — mix',        moss_type:'mix',                store:'LT', frame_cost:76.50, moss_cost:171.23, extras_cost:66.42, sell_price_eur:599,    sell_price_dkk:null},
      {sku:'lt-120x30-mix', name:'120×30cm — mix',      moss_type:'mix',                store:'LT', frame_cost:25,    moss_cost:78.49,  extras_cost:34.56, sell_price_eur:299,    sell_price_dkk:null},
      {sku:'lt-60x90-mix',  name:'60×90cm — mix',       moss_type:'mix',                store:'LT', frame_cost:25,    moss_cost:117.73, extras_cost:48.04, sell_price_eur:389,    sell_price_dkk:null},
      {sku:'lt-trio',       name:'TRIO bundle',          moss_type:'mini + pole (5) CN', store:'LT', frame_cost:42.30, moss_cost:65.93,  extras_cost:0,     sell_price_eur:349,    sell_price_dkk:null},
      // DK - Ball moss
      {sku:'dk-30-ball',    name:'ø30cm — ball moss',   moss_type:'mini ball',          store:'DK', frame_cost:9.90,  moss_cost:12.47,  extras_cost:0,     sell_price_eur:93.66,  sell_price_dkk:700},
      {sku:'dk-50-ball',    name:'ø50cm — ball moss',   moss_type:'pole (5) CN',        store:'DK', frame_cost:18.90, moss_cost:31.29,  extras_cost:0,     sell_price_eur:247.40, sell_price_dkk:1849},
      {sku:'dk-60-ball',    name:'ø60cm — ball moss',   moss_type:'pole (5) CN',        store:'DK', frame_cost:27.90, moss_cost:45.06,  extras_cost:0,     sell_price_eur:300.92, sell_price_dkk:2249},
      {sku:'dk-70-ball',    name:'ø70cm — ball moss',   moss_type:'pole (5) CN',        store:'DK', frame_cost:36.91, moss_cost:61.33,  extras_cost:0,     sell_price_eur:361.13, sell_price_dkk:2699},
      {sku:'dk-80-ball',    name:'ø80cm — ball moss',   moss_type:'pole (5) CN',        store:'DK', frame_cost:48.59, moss_cost:80.10,  extras_cost:0,     sell_price_eur:508.31, sell_price_dkk:3799},
      {sku:'dk-90-ball',    name:'ø90cm — ball moss',   moss_type:'pole (5) CN',        store:'DK', frame_cost:61.20, moss_cost:101.38, extras_cost:0,     sell_price_eur:642.11, sell_price_dkk:4799},
      {sku:'dk-100-ball',   name:'ø100cm — ball moss',  moss_type:'pole (5) CN',        store:'DK', frame_cost:76.50, moss_cost:125.16, extras_cost:0,     sell_price_eur:735.77, sell_price_dkk:5499},
      // DK - Mix
      {sku:'dk-50-mix',     name:'ø50cm — mix',         moss_type:'mix',                store:'DK', frame_cost:18.90, moss_cost:42.81,  extras_cost:22.30, sell_price_eur:240.71, sell_price_dkk:1799},
      {sku:'dk-60-mix',     name:'ø60cm — mix',         moss_type:'mix',                store:'DK', frame_cost:27.90, moss_cost:61.64,  extras_cost:28.77, sell_price_eur:320.99, sell_price_dkk:2399},
      {sku:'dk-70-mix',     name:'ø70cm — mix',         moss_type:'mix',                store:'DK', frame_cost:36.91, moss_cost:83.90,  extras_cost:36.42, sell_price_eur:401.27, sell_price_dkk:2999},
      {sku:'dk-80-mix',     name:'ø80cm — mix',         moss_type:'mix',                store:'DK', frame_cost:48.59, moss_cost:109.59, extras_cost:45.24, sell_price_eur:508.31, sell_price_dkk:3799},
      {sku:'dk-90-mix',     name:'ø90cm — mix',         moss_type:'mix',                store:'DK', frame_cost:61.20, moss_cost:138.70, extras_cost:55.24, sell_price_eur:628.73, sell_price_dkk:4699},
      {sku:'dk-100-mix',    name:'ø100cm — mix',        moss_type:'mix',                store:'DK', frame_cost:76.50, moss_cost:171.23, extras_cost:66.42, sell_price_eur:722.39, sell_price_dkk:5399},
      {sku:'dk-trio',       name:'TRIO bundle',          moss_type:'mini+pole5',         store:'DK', frame_cost:42.30, moss_cost:65.93,  extras_cost:0,     sell_price_eur:401.27, sell_price_dkk:2999},
    ];
    const ins = db.prepare(`
      INSERT OR IGNORE INTO products
        (sku,name,moss_type,store,frame_cost,moss_cost,extras_cost,total_cost,sell_price_eur,sell_price_dkk,gross_profit,margin_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const p of SEED) {
      const tc = p.frame_cost + p.moss_cost + p.extras_cost;
      const gp = p.sell_price_eur - tc;
      const mp = (gp / p.sell_price_eur) * 100;
      ins.run(p.sku, p.name, p.moss_type, p.store, p.frame_cost, p.moss_cost, p.extras_cost,
        Math.round(tc * 100) / 100, p.sell_price_eur, p.sell_price_dkk || null,
        Math.round(gp * 100) / 100, Math.round(mp * 100) / 100);
    }
    console.log(`[db] seeded ${SEED.length} products`);
  }

  // DK: set EUR price from DKK at 7.46, then correct margin for 21% LT VAT (idempotent)
  db.prepare(`
    UPDATE products
    SET sell_price_eur = ROUND(sell_price_dkk / 7.46 * 100) / 100,
        gross_profit   = ROUND((sell_price_dkk / 7.46 / 1.21 - total_cost) * 100) / 100,
        margin_pct     = ROUND((sell_price_dkk / 7.46 / 1.21 - total_cost) / (sell_price_dkk / 7.46 / 1.21) * 100 * 100) / 100
    WHERE store = 'DK' AND sell_price_dkk IS NOT NULL
  `).run();
} catch (e) {
  console.error('[db] products setup error:', e.message);
}

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
