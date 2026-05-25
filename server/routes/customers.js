const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const db = require('../database');

// GET /api/customers/:email
router.get('/:email', requireAuth, (req, res) => {
  const email = decodeURIComponent(req.params.email);

  const orders = db.prepare(`
    SELECT store_id, order_id, customer_name, customer_email, status, total, currency, date_created, producer_status
    FROM orders_cache
    WHERE customer_email = ?
    ORDER BY date_created DESC
  `).all(email);

  const deals = db.prepare(`
    SELECT * FROM custom_deals WHERE customer_email = ? ORDER BY deal_date DESC
  `).all(email);

  const name = orders[0]?.customer_name || deals[0]?.customer_name || email;

  // Aggregate spend by currency
  const spendByCurrency = {};
  for (const o of orders) {
    const cur = o.currency || 'EUR';
    spendByCurrency[cur] = (spendByCurrency[cur] || 0) + parseFloat(o.total || 0);
  }
  for (const d of deals) {
    if (d.status === 'completed') {
      const cur = d.currency || 'EUR';
      spendByCurrency[cur] = (spendByCurrency[cur] || 0) + parseFloat(d.amount || 0);
    }
  }

  const stores = [...new Set(orders.map(o => o.store_id))];

  res.json({ name, email, orders, deals, spendByCurrency, stores });
});

// GET /api/customers — list unique customers
router.get('/', requireAuth, (req, res) => {
  const { search, limit = 100 } = req.query;
  let query = `
    SELECT customer_email, customer_name, COUNT(*) as order_count, MAX(date_created) as last_order
    FROM orders_cache
    WHERE customer_email != ''
  `;
  const params = [];
  if (search) {
    query += ' AND (customer_name LIKE ? OR customer_email LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s);
  }
  query += ' GROUP BY customer_email ORDER BY last_order DESC LIMIT ?';
  params.push(Number(limit));

  const customers = db.prepare(query).all(...params);
  res.json({ customers });
});

module.exports = router;
