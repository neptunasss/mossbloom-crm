Apply premium branding across the entire mossbloom-crm app.
This app will be sold as a SaaS product, so it must look top notch.

1. TYPOGRAPHY
   Add to index.html head:
   <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
   
   Apply globally:
   - Font: Inter for all UI
   - Headings: font-weight 600, letter-spacing -0.02em
   - KPI values: font-weight 700, letter-spacing -0.03em
   - Labels: font-weight 500, letter-spacing 0.06em, uppercase, 0.7rem
   - Body text: font-weight 400, line-height 1.6
   - Numbers/amounts: font-variant-numeric: tabular-nums

2. REMOVE ALL EMOJI from entire app
   Replace with Lucide icons (add via CDN):
   <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
   
   Icon replacements:
   - 📥 Gauta -> lucide icon: inbox
   - 🔨 Gaminama -> lucide icon: hammer
   - ✅ Paruošta -> lucide icon: check-circle
   - 📦 Išsiųsta -> lucide icon: package
   - 🏁 Pristatyta -> lucide icon: flag
   - 🌿 placeholder -> lucide icon: leaf
   - Dashboard nav -> lucide: layout-dashboard
   - Orders nav -> lucide: shopping-bag
   - Sandoriai nav -> lucide: git-pull-request
   - Gamyba nav -> lucide: hammer
   - Products nav -> lucide: box
   - Kainodara nav -> lucide: calculator
   - Sync button -> lucide: refresh-cw
   - Add button -> lucide: plus
   - CSV -> lucide: download
   - Delete -> lucide: trash-2
   - Edit -> lucide: pencil
   - Attach -> lucide: paperclip
   - Search -> lucide: search
   - Settings -> lucide: settings
   - Logout -> lucide: log-out
   Country flags keep as text (LT, DK, DE) styled as small badges

3. COLOR SYSTEM - Scandinavian minimal palette
   Update CSS variables:
   --bg-primary: #0a0a0b
   --bg-secondary: #111113
   --bg-card: #18181b
   --bg-hover: #1f1f23
   --border: #27272a
   --border-light: #3f3f46
   --text-primary: #fafafa
   --text-secondary: #a1a1aa
   --text-muted: #71717a
   --accent-green: #22c55e
   --accent-green-dim: #16a34a
   --accent-blue: #3b82f6
   --accent-red: #ef4444
   --accent-amber: #f59e0b
   --accent-purple: #8b5cf6

4. COMPONENT STYLING
   Cards:
   - background: var(--bg-card)
   - border: 1px solid var(--border)
   - border-radius: 12px
   - padding: 24px
   - no box-shadow (flat design)
   - hover: border-color var(--border-light)
   
   Buttons:
   - Primary: bg #fafafa, text #0a0a0b, font-weight 600
     (white button on dark = Scandinavian style)
   - Secondary: bg transparent, border var(--border), text var(--text-primary)
   - Danger: bg transparent, border #ef4444, text #ef4444
   - All buttons: border-radius 8px, padding 8px 16px, font-size 0.875rem
   
   Nav sidebar:
   - bg: var(--bg-secondary)
   - Active item: bg var(--bg-hover), left border 2px solid var(--accent-green)
   - Nav items: icon + label, icon size 16px, gap 10px
   - No rounded pills, just subtle left border on active
   
   Badges (LT, DK, DE, B2B, WC):
   - Monochrome: bg var(--bg-hover), text var(--text-secondary)
   - border: 1px solid var(--border)
   - font-size: 0.7rem, font-weight 600, letter-spacing 0.05em
   - No colors — premium apps dont use rainbow badges
   
   Tables:
   - No background on rows
   - Subtle border-bottom: 1px solid var(--border) on each row
   - Hover: background var(--bg-hover)
   
   Inputs and selects:
   - bg: var(--bg-secondary)
   - border: 1px solid var(--border)
   - border-radius: 8px
   - focus: border-color var(--border-light)
   - No blue glow on focus

5. LOGO / BRAND
   Top of sidebar replace "Mossbloom CRM" text with:
   <div class="brand">
     <span class="brand-mark">M</span>
     <span class="brand-name">Mossbloom</span>
     <span class="brand-sub">CRM</span>
   </div>
   Style:
   - brand-mark: 28px, font-weight 700, color var(--accent-green)
   - brand-name: font-weight 600, color var(--text-primary)
   - brand-sub: font-size 0.65rem, color var(--text-muted), 
     letter-spacing 0.1em, uppercase, margin-left 2px

6. PAGE TITLES
   Each page: large clean title
   - font-size: 1.5rem
   - font-weight: 600  
   - letter-spacing: -0.02em
   - color: var(--text-primary)
   - subtitle/count in var(--text-muted) next to it

7. APPLY TO ALL PAGES
   These changes apply to: Dashboard, Orders, Sandoriai, 
   Gamyba (production), Products, Kainodara
   Consistent across entire app.