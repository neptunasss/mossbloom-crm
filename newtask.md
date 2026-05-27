1. ORDERS DISAPPEARING - orders vanish after sync and require multiple 
   refreshes. Check if the sync endpoint clears the table before inserting.
   Fix to use upsert (INSERT OR REPLACE) not DELETE+INSERT.
   Also check frontend - does it clear the DOM before re-rendering?

2. DELETE ORDER - add delete button to each order row.
   For WooCommerce orders: just hide from UI (set hidden=1 flag), 
   don't delete from DB as they will re-sync.
   For B2B orders: actually delete from accounting_entries.
   Show confirmation dialog before deleting.

3. PRODUCT NAMES FROM WOOCOMMERCE - instead of English names from Excel,
   fetch actual product names from WooCommerce API for each store.
   GET /wp-json/wc/v3/products from bloom_lt and mossbloom_dk
   Store in products table as lt_name and dk_name columns.
   Display dk_name when DK filter active, lt_name when LT filter active.

4. B2B ORDERS IN GAMYBA - when a B2B order is created from Products page
   or anywhere, automatically add it to production_queue with stage=gauta.
   Fix the B2B order creation flow to call the production queue populate.

5. PRODUCTS REVENUE FIX - DK revenue should be:
   order total (DKK) / 7.46 = EUR
   Currently seems to be using wrong conversion.
   Also verify LT product matching is working (should match by size + 
   no kupstines keyword = mix).

6. DASHBOARD YEARLY PACE FIX
   const now = new Date()
   const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()
   const daysPassed = now.getDate()
   const projected = (currentMonthRevenue / daysPassed) * daysInMonth
   const yearlyPace = projected * 12
   Log: console.log('[forecast]', {currentMonthRevenue, daysPassed, daysInMonth, projected, yearlyPace})

7. INVOICE GENERATOR
   New page or modal: "Sąskaita faktūra" (Invoice)
   
   Generate PDF invoices for any order (WooCommerce or B2B):
   - Button on each order row: "Generuoti SF"
   - Pre-fills from order data: customer, items, amounts, date
   
   Invoice template includes:
   - Mossbloom logo/brand top left
   - Invoice number (auto-generated: SF-2026-001, SF-2026-002 etc)
   - Issue date + due date (default +14 days)
   - SELLER details (pre-filled from settings):
     Company name, address, VAT code, bank account
   - BUYER details (from order or editable):
     Company name, address, VAT code
   - LINE ITEMS table:
     Product name | Qty | Unit price excl VAT | VAT 21% | Total incl VAT
   - Totals: subtotal, VAT amount, TOTAL
   - Payment details: bank account, reference number
   - Footer: thank you note
   
   Export as PDF (use puppeteer or html-pdf npm package)
   Save invoice to order record
   Show list of generated invoices per order
   
   Also add invoice number tracking table:
   CREATE TABLE invoices (
     id INTEGER PRIMARY KEY,
     invoice_number TEXT UNIQUE,
     order_id TEXT,
     store_id TEXT,
     customer_name TEXT,
     amount REAL,
     vat_amount REAL,
     issue_date TEXT,
     due_date TEXT,
     pdf_path TEXT,
     created_at TEXT
   )