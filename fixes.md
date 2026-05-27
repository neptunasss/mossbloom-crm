Fix the Gamyba (production) page - two main issues:

1. GAUTA COLUMN - only show active/processing orders
   In server/routes/production.js and the populate logic:
   - Only pull orders where status = 'processing' from orders_cache
   - Do NOT include 'completed', 'cancelled', 'refunded' orders
   - When an order status changes to 'completed' in WooCommerce sync,
     automatically move it to 'Pristatyta' stage in production_queue
   - Run a cleanup: DELETE from production_queue where order_id is in
     orders_cache with status != 'processing' AND stage = 'gauta'
   - On populate, only insert orders with status = 'processing'

2. CARD CONTENT - cards are showing blank/dotted lines
   Fix cards to display:
   - Order number: #9347
   - Product name: parse from line_items JSON - 
     try JSON.parse(line_items), get first item name
     fallback to "Užsakymas " + order_number
   - Country flag text badge: LT / DK / DE based on billing_country
   - Due date: order date + 14 days, formatted as "2026-06-05"
   - Days remaining: calculated from today, colored chip
     green if >3 days, amber if 1-3 days, red if overdue
   - Store badge: small pill

3. DRAG AND DROP - verify it works
   When card is dragged to new column, PATCH /api/production/:id 
   with { stage: 'gaminama' } etc.
   Show visual feedback on drag over column.

4. AUTO-SYNC with WooCommerce
   Every time WooCommerce sync runs, also:
   - Add new processing orders to production_queue (stage=gauta)
   - Update stage to 'pristatyta' for orders that became completed