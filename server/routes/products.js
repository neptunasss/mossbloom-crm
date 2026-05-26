'use strict';

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

// ── Size extraction ──────────────────────────────────────────────────────────

// LT: extract size token from line item name
function ltSizeFromName(name) {
  let m = name.match(/ø(\d+)\s*cm/i);
  if (m) return `ø${m[1]}cm`;
  m = name.match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (m) return `${m[1]}×${m[2]}cm`;
  return null;
}

// DK: extract size from meta_data pa_stoerrelse value ("o80cm" → "ø80cm")
function dkSizeFromMeta(metaData) {
  const entry = (metaData || []).find(m => m.key === 'pa_stoerrelse');
  if (!entry) return null;
  let val = String(entry.value || '').trim();
  // "o80cm" → "ø80cm"
  val = val.replace(/^o(\d)/i, 'ø$1');
  // Normalise: "ø80 cm" → "ø80cm"
  val = val.replace(/ø\s*(\d+)\s*cm/i, (_, d) => `ø${d}cm`);
  // Rectangular: "120x30cm" / "120X30" → "120×30cm"
  val = val.replace(/(\d+)\s*[xX]\s*(\d+)(\s*cm)?/i, '$1×$2cm');
  return val || null;
}

// ── Moss type extraction ─────────────────────────────────────────────────────

function ltMossType(name) {
  if (/kupstinės|kupstin/i.test(name)) return 'ball';
  return 'mix';
}

function dkMossType(name) {
  if (/pude[\s-]?mos|pudemos/i.test(name)) return 'ball';
  if (/trio/i.test(name)) return 'trio';
  return 'mix';
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/products
router.get('/', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY margin_pct DESC').all();

  // Build lookup: `${store}:${size}:${type}` → product
  const productMap = {};
  for (const p of products) {
    // Derive size token from stored name
    let size = null;
    let m = p.name.match(/ø(\d+)\s*cm/i);
    if (m) { size = `ø${m[1]}cm`; }
    else {
      m = p.name.match(/(\d+)\s*[xX×]\s*(\d+)/);
      if (m) size = `${m[1]}×${m[2]}cm`;
    }
    if (!size) {
      if (/trio/i.test(p.name)) size = 'trio';
    }
    const type = p.moss_type.toLowerCase().includes('mix') ? 'mix' : 'ball';
    if (size) productMap[`${p.store}:${size}:${type}`] = p;
  }

  const recentOrders = db.prepare(
    `SELECT store_id, data FROM orders_cache
     WHERE date_created > datetime('now', '-365 days')
       AND status NOT IN ('cancelled','refunded','failed')`
  ).all();

  const sales = {}; // sku → { units, revenue }

  for (const row of recentOrders) {
    let order;
    try { order = JSON.parse(row.data); } catch { continue; }

    for (const item of (order.line_items || [])) {
      if (!item.name) continue;
      let size = null;
      let type = null;

      if (row.store_id === 'bloom_lt') {
        size = ltSizeFromName(item.name);
        type = ltMossType(item.name);
      } else if (row.store_id === 'mossbloom_dk') {
        size = dkSizeFromMeta(item.meta_data);
        type = dkMossType(item.name);
      } else {
        continue; // DE — skip
      }

      if (!size) continue;

      const store = row.store_id === 'bloom_lt' ? 'LT' : 'DK';
      const p = productMap[`${store}:${size}:${type}`];
      if (!p) continue;

      if (!sales[p.sku]) sales[p.sku] = { units: 0, revenue: 0 };
      sales[p.sku].units   += item.quantity || 1;
      sales[p.sku].revenue += parseFloat(item.subtotal || 0);
    }
  }

  res.json({
    products: products.map(p => ({
      ...p,
      units_sold:    sales[p.sku]?.units   || 0,
      revenue_total: Math.round((sales[p.sku]?.revenue || 0) * 100) / 100,
    })),
  });
});

// GET /api/products/stats
router.get('/stats', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products').all();
  if (!products.length) return res.json({ best_margin: null, worst_margin: null, avg_margin: 0, total_products: 0 });
  const sorted    = [...products].sort((a, b) => b.margin_pct - a.margin_pct);
  const avgMargin = products.reduce((s, p) => s + p.margin_pct, 0) / products.length;
  res.json({
    best_margin:    { name: sorted[0].name,               store: sorted[0].store,               margin_pct: sorted[0].margin_pct },
    worst_margin:   { name: sorted[sorted.length-1].name, store: sorted[sorted.length-1].store, margin_pct: sorted[sorted.length-1].margin_pct },
    avg_margin:     Math.round(avgMargin * 10) / 10,
    total_products: products.length,
  });
});

module.exports = router;
