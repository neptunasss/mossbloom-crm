Build a Products page in mossbloom-crm at /products route.

1. CREATE DATABASE TABLE on startup:
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT,
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
)

2. SEED with this exact data on startup if table is empty:
const products = [
  // LT - Ball moss
  {sku:'lt-30-ball', name:'ø30cm — ball moss', moss_type:'mini ball moss', store:'LT', frame_cost:9.90, moss_cost:12.47, extras_cost:0, sell_price_eur:79, sell_price_dkk:null},
  {sku:'lt-40-ball', name:'ø40cm — ball moss', moss_type:'mini ball moss', store:'LT', frame_cost:13.52, moss_cost:22.17, extras_cost:0, sell_price_eur:129, sell_price_dkk:null},
  {sku:'lt-50-ball', name:'ø50cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:18.90, moss_cost:31.29, extras_cost:0, sell_price_eur:189, sell_price_dkk:null},
  {sku:'lt-60-ball', name:'ø60cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:27.90, moss_cost:45.06, extras_cost:0, sell_price_eur:239, sell_price_dkk:null},
  {sku:'lt-70-ball', name:'ø70cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:36.91, moss_cost:61.33, extras_cost:0, sell_price_eur:327.99, sell_price_dkk:null},
  {sku:'lt-80-ball', name:'ø80cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:48.59, moss_cost:80.10, extras_cost:0, sell_price_eur:399, sell_price_dkk:null},
  {sku:'lt-90-ball', name:'ø90cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:61.20, moss_cost:101.38, extras_cost:0, sell_price_eur:478, sell_price_dkk:null},
  {sku:'lt-100-ball', name:'ø100cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:76.50, moss_cost:125.16, extras_cost:0, sell_price_eur:599, sell_price_dkk:null},
  {sku:'lt-120x30-ball', name:'120×30cm — ball moss', moss_type:'pole moss (5) CN', store:'LT', frame_cost:25, moss_cost:57.37, extras_cost:0, sell_price_eur:299, sell_price_dkk:null},
  // LT - Mix
  {sku:'lt-30-mix', name:'ø30cm — mix', moss_type:'mix', store:'LT', frame_cost:9.90, moss_cost:15.41, extras_cost:12.89, sell_price_eur:79, sell_price_dkk:null},
  {sku:'lt-40-mix', name:'ø40cm — mix', moss_type:'mix', store:'LT', frame_cost:13.52, moss_cost:27.40, extras_cost:17.01, sell_price_eur:99, sell_price_dkk:null},
  {sku:'lt-50-mix', name:'ø50cm — mix', moss_type:'mix', store:'LT', frame_cost:18.90, moss_cost:42.81, extras_cost:22.30, sell_price_eur:189, sell_price_dkk:null},
  {sku:'lt-60-mix', name:'ø60cm — mix', moss_type:'mix', store:'LT', frame_cost:27.90, moss_cost:61.64, extras_cost:28.77, sell_price_eur:239, sell_price_dkk:null},
  {sku:'lt-70-mix', name:'ø70cm — mix', moss_type:'mix', store:'LT', frame_cost:36.91, moss_cost:83.90, extras_cost:36.42, sell_price_eur:327.99, sell_price_dkk:null},
  {sku:'lt-80-mix', name:'ø80cm — mix', moss_type:'mix', store:'LT', frame_cost:48.59, moss_cost:109.59, extras_cost:45.24, sell_price_eur:399, sell_price_dkk:null},
  {sku:'lt-90-mix', name:'ø90cm — mix', moss_type:'mix', store:'LT', frame_cost:61.20, moss_cost:138.70, extras_cost:55.24, sell_price_eur:478, sell_price_dkk:null},
  {sku:'lt-100-mix', name:'ø100cm — mix', moss_type:'mix', store:'LT', frame_cost:76.50, moss_cost:171.23, extras_cost:66.42, sell_price_eur:599, sell_price_dkk:null},
  {sku:'lt-120x30-mix', name:'120×30cm — mix', moss_type:'mix', store:'LT', frame_cost:25, moss_cost:78.49, extras_cost:34.56, sell_price_eur:299, sell_price_dkk:null},
  {sku:'lt-60x90-mix', name:'60×90cm — mix', moss_type:'mix', store:'LT', frame_cost:25, moss_cost:117.73, extras_cost:48.04, sell_price_eur:389, sell_price_dkk:null},
  {sku:'lt-trio', name:'TRIO bundle', moss_type:'mini + pole (5) CN', store:'LT', frame_cost:42.30, moss_cost:65.93, extras_cost:0, sell_price_eur:349, sell_price_dkk:null},
  // DK - Ball moss
  {sku:'dk-30-ball', name:'ø30cm — ball moss', moss_type:'mini ball', store:'DK', frame_cost:9.90, moss_cost:12.47, extras_cost:0, sell_price_eur:93.66, sell_price_dkk:700},
  {sku:'dk-50-ball', name:'ø50cm — ball moss', moss_type:'pole (5) CN', store:'DK', frame_cost:18.90, moss_cost:31.29, extras_cost:0, sell_price_eur:247.40, sell_price_dkk:1849},
  {sku:'dk-60-ball', name:'ø60cm — ball moss', moss_type:'pole (5) CN', store:'DK', frame_cost:27.90, moss_cost:45.06, extras_cost:0, sell_price_eur:300.92, sell_price_dkk:2249},
  {sku:'dk-70-ball', name:'ø70cm — ball moss', moss_type:'pole (5) CN', store:'DK', frame_cost:36.91, moss_cost:61.33, extras_cost:0, sell_price_eur:361.13, sell_price_dkk:2699},
  {sku:'dk-80-ball', name:'ø80cm — ball moss', moss_type:'pole (5) CN', store:'DK', frame_cost:48.59, moss_cost:80.10, extras_cost:0, sell_price_eur:508.31, sell_price_dkk:3799},
  {sku:'dk-90-ball', name:'ø90cm — ball moss', moss_type:'pole (5) CN', store:'DK', frame_cost:61.20, moss_cost:101.38, extras_cost:0, sell_price_eur:642.11, sell_price_dkk:4799},
  {sku:'dk-100-ball', name:'ø100cm — ball moss', moss_type:'pole (5) CN', store:'DK', frame_cost:76.50, moss_cost:125.16, extras_cost:0, sell_price_eur:735.77, sell_price_dkk:5499},
  // DK - Mix
  {sku:'dk-50-mix', name:'ø50cm — mix', moss_type:'mix', store:'DK', frame_cost:18.90, moss_cost:42.81, extras_cost:22.30, sell_price_eur:240.71, sell_price_dkk:1799},
  {sku:'dk-60-mix', name:'ø60cm — mix', moss_type:'mix', store:'DK', frame_cost:27.90, moss_cost:61.64, extras_cost:28.77, sell_price_eur:320.99, sell_price_dkk:2399},
  {sku:'dk-70-mix', name:'ø70cm — mix', moss_type:'mix', store:'DK', frame_cost:36.91, moss_cost:83.90, extras_cost:36.42, sell_price_eur:401.27, sell_price_dkk:2999},
  {sku:'dk-80-mix', name:'ø80cm — mix', moss_type:'mix', store:'DK', frame_cost:48.59, moss_cost:109.59, extras_cost:45.24, sell_price_eur:508.31, sell_price_dkk:3799},
  {sku:'dk-90-mix', name:'ø90cm — mix', moss_type:'mix', store:'DK', frame_cost:61.20, moss_cost:138.70, extras_cost:55.24, sell_price_eur:628.73, sell_price_dkk:4699},
  {sku:'dk-100-mix', name:'ø100cm — mix', moss_type:'mix', store:'DK', frame_cost:76.50, moss_cost:171.23, extras_cost:66.42, sell_price_eur:722.39, sell_price_dkk:5399},
  {sku:'dk-trio', name:'TRIO bundle', moss_type:'mini+pole5', store:'DK', frame_cost:42.30, moss_cost:65.93, extras_cost:0, sell_price_eur:401.27, sell_price_dkk:2999},
]
Calculate for each: total_cost = frame+moss+extras, gross_profit = sell_price_eur - total_cost, margin_pct = gross_profit/sell_price_eur*100

3. API ROUTES in server/routes/products.js:
GET /api/products - all products with WooCommerce sales data joined
GET /api/products/stats - summary stats

For each product, join with orders_cache to get:
- units_sold: count of orders containing this product (match by name similarity)
- revenue_total: sum of that product's contribution
This is approximate — match order line_items JSON where name contains the product size

4. PRODUCTS PAGE UI at /products:

TOP STATS ROW (4 cards):
- Best margin product: name + margin %
- Worst margin product: name + margin %  
- Average margin across all products
- Most sold product (by units)

FILTER BAR:
- Toggle: LT | DK | All
- Toggle: Ball moss | Mix | All
- Sort by: Margin % | Profit € | Price | Name

PRODUCTS TABLE:
Columns: Product | Store | Moss Type | Cost | Price | Profit | Margin | Sold* | Revenue*
(*from WooCommerce, approximate)

Margin column: colored bar indicator
- Green if >65%
- Amber if 50-65%
- Red if <50%

Sort by margin descending by default.

PRODUCT DETAIL - click row to expand:
- Cost breakdown: Frame €X | Moss €X | Extras €X | Total €X
- Price: LT €X | DK X DKK (€X)
- Margin bar visualization
- "Add to B2B order" button

5. ADD TO B2B ORDER
When clicking "Add to B2B order" on a product:
- Open a modal/slide panel
- Pre-fill: product name, suggested price (sell_price_eur)
- Fields: quantity, custom price (editable), customer name, date, notes
- On submit: creates an accounting_entry with source=b2b, 
  description = "[quantity]x [product name]", amount = qty * price
- Also creates an entry in orders_cache with store_id=b2b
- Show success toast

6. DESIGN - same macOS light theme as rest of app
   Margin bars: thin colored progress bars in the margin column
   Expandable rows with smooth animation
   Same card/table styling as Dashboard