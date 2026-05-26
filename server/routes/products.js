'use strict';

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

const STORE_MAP = { bloom_lt: 'LT', mossbloom_dk: 'DK', mossbloom_de: 'DE' };

// Extract size token from product/item name
function sizeToken(name) {
  let m = name.match(/ø(\d+)\s*cm/i);
  if (m) return `ø${m[1]}cm`;
  m = name.match(/(\d+)\s*[x×]\s*(\d+)\s*cm/i);
  if (m) return `${m[1]}×${m[2]}cm`;
  if (/trio|bundle/i.test(name)) return 'trio';
  return null;
}

// Determine moss type (ball vs mix) from WC line item name
function mossTypeOf(name) {
  if (/kupstinė|kupstine|kupstin/i.test(name)) return 'ball';
  if (/pudemos|pude[\s-]?mos|bolde/i.test(name)) return 'ball';
  return 'mix';
}

// GET /api/products — all products with approximate WC sales data
router.get('/', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY margin_pct DESC').all();

  // Build lookup: `${store}:${size}:${type}` → product
  const productMap = {};
  for (const p of products) {
    const size = sizeToken(p.name);
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
    const store = STORE_MAP[row.store_id];
    if (!store) continue;
    let order;
    try { order = JSON.parse(row.data); } catch { continue; }
    for (const item of (order.line_items || [])) {
      if (!item.name) continue;
      const size = sizeToken(item.name);
      if (!size) continue;
      const type = mossTypeOf(item.name);
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

// GET /api/products/stats — summary KPIs
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
