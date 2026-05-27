Build two new pages in mossbloom-crm:

## PAGE 1: SĄSKAITOS (Invoices) at /invoices

Add to navigation under TOOLS section: "Sąskaitos" with receipt icon.

### DATABASE
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE,
  series TEXT DEFAULT 'PAV',
  issue_date TEXT,
  due_date TEXT,
  seller_name TEXT DEFAULT 'MB Sydzei',
  seller_code TEXT DEFAULT '306918032',
  seller_vat TEXT DEFAULT 'LT100017928619',
  seller_address TEXT DEFAULT 'Draugystės 1-takas 8, Raseiniai',
  seller_phone TEXT DEFAULT '+3706 31 333 13',
  seller_email TEXT DEFAULT 'info@bloom.lt',
  seller_bank TEXT DEFAULT 'Revolut',
  seller_iban TEXT DEFAULT 'LT353250018909471506',
  seller_signee TEXT DEFAULT 'Simonas Jovaišas',
  buyer_name TEXT,
  buyer_code TEXT,
  buyer_vat TEXT,
  buyer_address TEXT,
  line_items TEXT,
  subtotal REAL,
  vat_amount REAL,
  total REAL,
  order_id TEXT,
  store_id TEXT,
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now'))
)

Invoice number format: PAV + YYYYMMDD + '-' + sequence
Example: PAV20260520-01, PAV20260520-02
Auto-increment sequence per day.

### INVOICES LIST PAGE
- Table showing all invoices: Nr | Data | Pirkėjas | Suma | Statusas | Actions
- Status badges: Juodraštis (draft), Išsiųsta (sent), Apmokėta (paid)
- Actions: View PDF | Download | Mark as paid | Delete
- "+ Nauja sąskaita" button top right
- Filter by status, date range

### CREATE INVOICE PAGE/MODAL
Full form matching the PDF template exactly:

SELLER section (pre-filled, editable):
- Įmonės pavadinimas: MB Sydzei
- Įmonės kodas: 306918032
- PVM kodas: LT100017928619
- Adresas: Draugystės 1-takas 8, Raseiniai
- Tel: +3706 31 333 13
- El. paštas: info@bloom.lt
- Bankas: Revolut
- IBAN: LT353250018909471506

BUYER section:
- Search/select existing client (autocomplete from clients table)
- OR fill manually:
  - Įmonės pavadinimas
  - Įmonės kodas
  - PVM kodas
  - Adresas
- When client selected, auto-fill all fields
- "Išsaugoti kaip naują klientą" checkbox

LINE ITEMS (up to 10 rows, like the PDF):
Each row: Nr | Prekės pavadinimas | Mato vnt | Kiekis | Kaina be PVM | Suma be PVM
- Product name: dropdown from products table OR free text
- When product selected from dropdown, auto-fill price (sell_price_eur / 1.21)
- Unit: default "vnt."
- Quantity: number
- Price excl VAT: editable
- Row total: auto-calculated
- Add row button, remove row button

TOTALS (auto-calculated):
- Iš viso (excl VAT)
- PVM 21%
- Viso su PVM

BOTTOM:
- Sąskaitą išrašė: Simonas Jovaišas (editable)
- Issue date (default today)
- Due date (default +14 days)

### PDF GENERATION
Use html-pdf or puppeteer to generate PDF matching the exact layout:
npm install html-pdf-node

PDF template should match the uploaded invoice exactly:
- "PVM SĄSKAITA FAKTŪRA" bold header
- "Serija PAV Nr. XXXXXXXX" 
- Date in Lithuanian format: "2026 m. gegužės 20 d."
- Two column table: Pardavėjo rekvizitai | Pirkėjo rekvizitai
- Line items table with borders
- Totals table bottom right
- Signature lines at bottom

POST /api/invoices - create invoice
GET /api/invoices - list invoices
GET /api/invoices/:id/pdf - generate and download PDF
PATCH /api/invoices/:id - update status
DELETE /api/invoices/:id - delete

## PAGE 2: KLIENTAI (Clients) at /clients

Add to navigation under COMMERCE section between Orders and Gamyba.

### DATABASE
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT DEFAULT 'b2c',
  name TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  country TEXT,
  company_code TEXT,
  vat_code TEXT,
  notes TEXT,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)

### AUTO-IMPORT on startup
Pull all unique customers from orders_cache:
- B2B: source='b2b' entries from accounting_entries -> type='b2b'
- WooCommerce: billing_email, customer_name from orders_cache -> type='b2c'
- Deduplicate by email
- Set country from billing_country

### CLIENTS LIST PAGE
Top stats: Total clients | B2B clients | B2C clients | Countries

FILTER BAR:
- Toggle: Visi | B2B | B2C
- Search by name/email/company
- Filter by country

TABLE columns:
- Type badge (B2B purple / B2C gray)
- Name / Company
- Email
- Country flag + name
- Orders count (from orders_cache)
- Total spent (sum of their orders in EUR)
- Last order date
- Actions: View | Edit | Create Invoice

CLICK client -> slide panel showing:
- Contact details (editable)
- Order history (last 10 orders)
- Total spent
- Notes field
- "Sukurti sąskaitą" button

### DESIGN
Same macOS light theme as rest of app.
Clean table, same styling as Products/Orders pages.