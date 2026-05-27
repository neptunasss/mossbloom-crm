Build a Production Queue page in mossbloom-crm.

1. NEW PAGE - /production route, add to nav as "Gamyba" with a 🔨 icon
   Add to navigation between Orders and Sandoriai

2. DATABASE - new table:
   CREATE TABLE IF NOT EXISTS production_queue (
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
   )

3. AUTO-POPULATE - when a new order syncs from WooCommerce, 
   automatically add it to production_queue with:
   - stage = 'gauta'
   - due_date = order date + 14 days
   - product_name from order line items
   - country from billing_country field in orders_cache
   - country_flag: LT=🇱🇹, DK=🇩🇰, DE=🇩🇪, other=🌍
   - If order already exists in queue (by order_id+store_id) skip it

4. KANBAN BOARD UI - 5 columns:
   - 📥 Gauta
   - 🔨 Gaminama  
   - ✅ Paruošta
   - 📦 Išsiųsta
   - 🏁 Pristatyta
   
   Each column shows count badge.
   Cards are draggable between columns (use dragstart/dragover/drop events).
   On drop, call PATCH /api/production/:id with new stage.

5. ORDER CARD design (mobile-friendly, big touch targets):
   - Product image (if available, else green placeholder with 🌿)
   - Product name (bold)
   - Size if available
   - Country flag + store badge (LT/DK/DE)
   - Due date with color: red if overdue, orange if ≤3 days, green if ok
   - Days remaining: "5d" or "VĖLUOJA 2d" in red
   - Notes field (click to edit inline)
   - Small drag handle icon

6. API ROUTES in server/routes/production.js:
   GET /api/production - all queue items, grouped by stage
   PATCH /api/production/:id - update stage and/or notes
   POST /api/production - manually add item
   DELETE /api/production/:id - remove item
   POST /api/production/populate - scan orders_cache and add missing orders

7. PWA SETUP for mobile use by mom:
   - Add manifest.json: name="Mossbloom Gamyba", theme_color="#0f1117"
   - Add service worker for offline support
   - Add to index.html: <link rel="manifest" href="/manifest.json">
   - Meta tags for mobile: viewport, apple-mobile-web-app-capable
   - Icons: use the M logo already in the app

8. PAGE DESIGN - mobile first, works on phone:
   - Horizontal scroll on desktop (5 columns side by side)
   - On mobile: tab buttons to switch between stages (one column at a time)
   - Dark theme matching rest of app
   - Card min-width: 280px, touch-friendly drag on mobile too