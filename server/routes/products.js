'use strict';

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

// GET /api/products — all products with approximate WC sales data
router.get('/', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY margin_pct DESC').all();

  // Build approximate units_sold by scanning recent order line_items
  const recentOrders = db.prepare(
    `SELECT data FROM orders_cache
     WHERE date_created > datetime('now', '-365 days')
       AND status NOT IN ('cancelled','refunded','failed')`
  ).all();

  const sales = {}; // sku -> { units, revenue }

  for (const row of recentOrders) {
    let order;
    try { order = JSON.parse(row.data); } catch { continue; }
    const lineItems = order.line_items || [];
    for (const item of lineItems) {
      if (!item.name) continue;
      const itemName = item.name.toLowerCase();
      for (const p of products) {
        // Match by size token (e.g. "ø30cm", "120×30cm")
        const sizeTok = p.name.split('—')[0].trim().toLowerCase();
        if (itemName.includes(sizeTok)) {
          if (!sales[p.sku]) sales[p.sku] = { units: 0, revenue: 0 };
          sales[p.sku].units   += item.quantity || 1;
          sales[p.sku].revenue += parseFloat(item.subtotal || 0);
          break;
        }
      }
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

  const sorted   = [...products].sort((a, b) => b.margin_pct - a.margin_pct);
  const avgMargin = products.reduce((s, p) => s + p.margin_pct, 0) / products.length;

  res.json({
    best_margin:    { name: sorted[0].name,                 store: sorted[0].store,                 margin_pct: sorted[0].margin_pct },
    worst_margin:   { name: sorted[sorted.length-1].name,   store: sorted[sorted.length-1].store,   margin_pct: sorted[sorted.length-1].margin_pct },
    avg_margin:     Math.round(avgMargin * 10) / 10,
    total_products: products.length,
  });
});

module.exports = router;
