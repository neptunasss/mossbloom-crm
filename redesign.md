Major UX improvements for mossbloom-crm. Apply all:

1. SIDEBAR STORES SECTION - Apple Mail style
   Replace current dots with richer store cards:
   Each store shows:
   - Colored dot + store name (bold 13px)
   - "139 orders · €12.3k" muted 11px below
   - Connected checkmark on right
   Calculate revenue per store from orders_cache for current month
   Section header: "STORES" 11px uppercase muted

2. KPI HERO CARDS - add sparklines
   Add mini sparkline chart (last 6 months) to Revenue and Net Profit cards
   Use SVG path, no library needed:
   - Get last 6 months values from DB
   - Normalize to 0-100% height
   - Draw as SVG polyline, stroke #34c759 for revenue, #007aff for profit
   - 80px wide, 28px tall, positioned bottom of card
   - strokeWidth 2, no fill, smooth curve

3. DASHBOARD LAYOUT - expand full width
   Main content area:
   max-width: 1600px
   margin: 0 auto
   padding: 24px 32px
   
   KPI row: CSS grid, 12 columns
   Hero cards: span 3 cols each
   Small cards: span 2 cols each
   
   Second row: 
   Store breakdown: span 5
   Expenses chart: span 4
   Forecast: span 3
   
   Third row:
   Pipeline: span 4
   Recent orders: span 4
   Šaltiniai: span 4

4. PIPELINE EMPTY STATE - intentional design
   Remove "Pridėkite sandorių" text
   Show instead:
   - Lucide icon: trending-up (48px, #aeaeb2)
   - "No active opportunities" (16px, #86868b)
   - "+ Add Deal" button (small, secondary style)
   Center vertically in card

5. TOP TOOLBAR - macOS app bar
   Add a toolbar above page content (below nav, above page title):
   Height: 52px
   Background: rgba(255,255,255,0.8), backdrop-filter: blur(20px)
   Border-bottom: 1px solid rgba(0,0,0,0.08)
   Position: sticky top:0, z-index 100
   
   Contents left to right:
   - Search bar (cmd+k style): "Search orders, customers..." 
     bg rgba(0,0,0,0.06), rounded-full, 200px wide, lucide search icon
   - Spacer
   - Date range display: "May 2026" with calendar icon
   - Sync button: icon only, rotate-cw lucide
   - Notification bell: lucide bell, badge if any alerts
   - Avatar: "A" circle, 32px, bg #007aff, white text

6. PAGE TITLE - fix subtitle
   Change from: "Dashboard [38 sandorių]"
   To:
   <h1>Dashboard</h1>
   <p class="page-subtitle">38 sandorių šį mėnesį</p>
   
   h1: 22px weight 600
   subtitle: 13px #86868b, margin-top 2px

7. FOUNDER BRAIN WIDGET - new card in third row
   Title: "Šiandien" with today's date
   
   TOP SECTION - Today's activity:
   Pull from DB and show:
   - Revenue today: sum of orders where date = today
   - Orders today: count
   - Show "Šiandien dar nėra užsakymų" if none
   
   BOTTOM SECTION - Alerts (auto-generated):
   Check these conditions and show relevant alerts:
   
   a) Store silence: if any store has 0 orders in last 30 days:
      "⚠ [store] — [X] dienų be užsakymų"
      Use lucide: alert-triangle, color #ff9500
   
   b) Top performer: store with highest % growth this month vs last:
      "🔥 [store] +X% šį mėnesį"  
      Use lucide: trending-up, color #34c759
   
   c) PVM reminder: if today is between 1-15 of month:
      "PVM mokėtinas iki 15 d. — €X"
      Use lucide: clock, color #007aff
   
   d) Forecast alert: if on pace to miss €8333/month target:
      "Tikslo tempui reikia dar €X"
      Use lucide: target, color #ff3b30
   
   Show max 4 alerts, most important first
   Each alert: icon + text + subtle bg color matching alert type

8. VISUAL HIERARCHY - card sizing
   Apply these explicit heights/sizes:
   Hero KPI cards: min-height 140px
   Small KPI cards: min-height 100px
   Store breakdown + charts row: min-height 280px
   Founder brain + pipeline + recent orders: min-height 220px
   
9. FONT - premium editorial
   Add to index.html:
   <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
   
   Apply:
   - KPI values (big numbers): font-family 'Cormorant Garamond', serif; font-weight 700
   - Everything else: 'Inter', sans-serif
   - Page titles: Cormorant Garamond 600
   - Nav, labels, body: Inter
   
   This gives luxury editorial feel — big serif numbers, clean sans UI