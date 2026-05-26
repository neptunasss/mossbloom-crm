The accounting data architecture is wrong. Fix it completely:

1. GOOGLE SHEETS — read IŠLAIDOS 2026 sheet ONLY (expenses)
   - Never read PAJAMOS sheet — delete that code entirely
   - Expenses sync from Sheets, that's it

2. WOOCOMMERCE ORDERS — these are the income source
   - bloom.lt, mossbloom.dk, mossbloom.de orders = income
   - Pull from the existing orders table (already synced)
   - Apskaita income = sum of WooCommerce orders for the period

3. B2B ORDERS — manual entries in the CRM
   - Add a proper "New B2B Order" button in the Orders page
   - B2B orders appear in BOTH the Orders feed AND Apskaita income
   - Fields: date, customer name, amount (EUR), description, invoice (yes/no)
   - Show with B2B badge in orders list, different color from WC orders

4. APSKAITA INCOME = WooCommerce orders + B2B manual entries
   APSKAITA EXPENSES = Google Sheets IŠLAIDOS sync

5. Fix the store breakdown — % viso column is showing 0.0% for all stores, 
   it should show each store's % of total income

6. The chart is only showing red bars (expenses) — income bars are missing.
   Fix so both green (pajamos) and red (išlaidos) bars show correctly.

Delete any Google Sheets income import code completely so it can never 
conflict again.