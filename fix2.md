1. KPI CARD HIERARCHY - complete redesign of stats row
   TWO XL cards on left (wider, taller, more prominent):
   - PAJAMOS: green accent, 3.5rem value
   - GRYNASIS PELNAS: blue accent, 3.5rem value
   
   FIVE small cards on right in a 2-row grid:
   - ROI, Užsakymai, Vid. užsakymas, Pelno marža, PVM mokėti
   - 1.8rem values, no colored borders, plain gray
   
   Remove Bruto pelnas card entirely - not needed when you have Net profit

2. FIX SCROLLBAR - add to main CSS:
   html, body { overflow-x: hidden; scrollbar-width: none; }
   ::-webkit-scrollbar { display: none; }

3. FIX PVM CALCULATION
   PVM is always for current month sales, paid next month.
   surinktinas = current period income * 21 / 121
   sumoketas = sum of accounting_entries where category='Mokesčiai' 
               AND description LIKE '%PVM%' 
               AND entry_date in current period
   moketi = surinktinas - sumoketas
   Label: "Mokėti iki [15th next month name]"

4. PASKUTINIAI UŽSAKYMAI - show B2B orders too
   Query should be:
   - Last 5 from orders_cache (WooCommerce)
   - UNION with last 5 from accounting_entries where source='b2b'
   - Sort all by date desc, take top 5
   - Show B2B badge for b2b entries, store badge for WC orders
   - Convert DKK to EUR for display

5. SYMMETRY - fix layout grid
   All three bottom panels (Pipeline, Užsakymai, Šaltiniai) must be 
   equal height with consistent padding 24px
   Store breakdown table: equal column widths
   All cards same border radius (12px), same padding (24px)

6. PIPELINE PANEL - populate from Sandoriai
   Query deals table, show deals where stage != 'won' and stage != 'lost'
   Show: deal name, value, stage badge
   If empty show a useful message: "Pridėkite sandorių pipeline stebėjimui"