1. TRANSACTIONS LIST cleanup
   - Remove "(SF: FALSE)" and "(SF: TRUE)" from all descriptions in DB:
     UPDATE accounting_entries SET description = REPLACE(REPLACE(description, ' (SF: FALSE)', ''), ' (SF: TRUE)', '')
   - Show only category as subtitle, remove source text

2. FORECAST calculation fix
   - Projected = (current revenue / days passed) * total days in month
   - Yearly pace = projected * 12
   - Label: "Mokėti iki 15 [next month]"

3. PVM - calculate for current month, due next month 15th
   Label example: "Mokėti iki birželio 15"

4. STORE BREAKDOWN with real profit per store
   Columns: Parduotuvė | Užsakymai | Pajamos | Išlaidos | Pelnas | Marža
   
   Cost attribution (exact):
   - bloom.lt costs = Facebook Ads spend (category=Reklama, description contains FACEBOOK)
     + proportional share of Žaliavos (bloom.lt revenue / total WC revenue * total Žaliavos)
   - mossbloom.dk costs = Google Ads spend (category=Reklama, description contains GOOGLE)
     + proportional share of Žaliavos
   - mossbloom.de costs = proportional share of Žaliavos only
   - B2B costs = proportional share of Žaliavos only (no ad spend)
   
   Profit = Revenue - Costs
   Margin = Profit / Revenue * 100

5. Add Products page to navigation (empty, "Netrukus..." placeholder)

6. DESIGN - Stripe/Linear/Framer aesthetic
   - KPI cards: min 120px tall, values 2.8rem bold, padding 24px
   - Labels: 0.7rem uppercase letter-spacing
   - Gap between sections: 24px minimum
   - Hide transactions table by default, show "Rodyti sandorius ↓" button
   - Card borders: 1px solid #2a2d3a, subtle hover glow
   - Remove all non-essential text from main view
   - Premium SaaS feel, not accounting software