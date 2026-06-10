1. ORDERS DISAPPEARING ON SYNC
   Critical bug. Orders vanish when sync is pressed.
   Find the sync endpoint in server/routes/orders.js or sync service.
   It likely does DELETE FROM orders_cache then re-inserts.
   Fix to use INSERT OR REPLACE (upsert) by order_id+store_id.
   Never delete existing orders during sync.

2. B2B ORDER BUGS
   a) B2B orders not showing in "Today" dashboard widget
      The today query only checks orders_cache, not accounting_entries.
      Fix: also check accounting_entries WHERE source='b2b' AND entry_date=today
   b) B2B order description showing as email in orders list
      When creating B2B order, description field is being used as customer_email.
      Fix: use customer name as display name, not email field.

3. GAMYBA - drag and drop broken, cards not clickable
   Fix drag and drop: use proper HTML5 dragstart/dragover/drop events.
   Add ondragstart to card, ondragover+ondrop to columns.
   On drop: PATCH /api/production/:id {stage: newStage}
   
   Click on card opens edit modal:
   - Edit product name, notes, due date
   - Change stage dropdown
   - Save button

4. KLIENTAI - country not showing
   The billing country is inside the data JSON column.
   Fix import query:
   JSON.parse(row.data).billing?.country OR JSON.parse(row.data).billing_country
   Run UPDATE to fix existing clients:
   Re-import all clients from orders_cache re-parsing country from data column.
   
   Also fix table design - make it look premium not Excel:
   - Remove all borders between columns
   - Only bottom border per row (1px #f0f0f0)
   - More row height (48px)
   - Hover: entire row background #f8f8f8
   - Name column: show avatar circle with initials (like Linear/Notion)
   - Country: flag emoji + country name (LT->🇱🇹 Lietuva, DK->🇩🇰 Danija)
   - Amounts: right-aligned, bold green
   - Remove visible column grid lines entirely

5. SĄSKAITOS page improvements
   - Veiksmai: replace text with icon buttons only
     👁 view (eye icon) | ⬇ download (download icon) | ✓ mark paid (check icon) | 🗑 delete
     All small (16px), gray, hover darkens
   - Table rows: hover effect = full row background #f8f8f8
   - After creating invoice, auto-add buyer to clients table if not exists

6. KAINODARA - add custom size calculator
   Below the product dropdown, add toggle: "Produktas" | "Pasirinktinis"
   
   Custom mode shows:
   - Shape: Apvalus (round) | Stačiakampis (rectangle)
   - Size: diameter input (for round) OR width x height (for rectangle)
   - Moss type: Kupstinės | Mix
   - Calculate button
   
   Calculation formula (from Excel):
   Round area = π * (diameter/2)² 
   Rectangle area = width * height
   
   Moss cost per m²:
   - Kupstinės (pole5): €199.20/m² (box €249*0.8, covers 1.25m²)
   - Mix: pole2 + flat + reindeer + amaranthus proportional
   
   Frame cost: use nearest standard size price or input custom
   
   Show: Savikaina | Rekomenduojama kaina (cost * 2.5) | Marža

7. DASHBOARD FIXES
   a) Remove scrollbar: html,body{overflow-x:hidden} ::-webkit-scrollbar{display:none}
   
   b) Fix grid symmetry - use CSS grid throughout:
   Top KPI row: 6 equal cards in one row
   grid-template-columns: repeat(6, 1fr)
   Cards: hero cards (Pajamos, Pelnas) same size as others, just different accent color
   
   c) Add 6th KPI card: "Šaltiniai" or "Aktyvūs sandoriai" (pipeline value)
   
   d) Second row: equal 3 columns
   grid-template-columns: 5fr 4fr 3fr
   
   e) Third row: equal 4 columns  
   grid-template-columns: repeat(4, 1fr)
   
   f) Fix text overlap on smaller screens:
   KPI values: clamp(1.2rem, 2vw, 2rem)
   Change text: font-size 11px, single line, no wrap
   
   g) Fix month-to-date comparison:
   Instead of comparing full last month vs full this month,
   compare: last month days 1-10 vs this month days 1-10
   const today = new Date().getDate()
   prevFrom = first day of last month
   prevTo = day X of last month (same day number as today)
   
   h) Right side alignment: all cards in right column must be same width

8. EDIT ORDERS
   Add edit button to each order row (pencil icon).
   Opens slide panel with editable fields:
   - Status (dropdown)
   - Notes
   - For B2B: customer name, amount, description
   - Save button -> PATCH /api/orders/:id

9. INVOICE -> CLIENT AUTO-SAVE
   When invoice is created with buyer details filled:
   Check if client exists by company name or VAT code
   If not: INSERT into clients table automatically
   Show toast: "Klientas išsaugotas"