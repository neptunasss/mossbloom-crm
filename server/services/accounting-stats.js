'use strict';

const fx = require('./fx');

const STORE_NAME = {
  bloom_lt:     'bloom.lt',
  mossbloom_dk: 'mossbloom.dk',
  mossbloom_de: 'mossbloom.de',
};

const WC_STORES = ['bloom_lt', 'mossbloom_dk', 'mossbloom_de'];

const STORE_ROWS = [
  { id: 'bloom_lt',     name: 'bloom.lt' },
  { id: 'mossbloom_dk', name: 'mossbloom.dk' },
  { id: 'mossbloom_de', name: 'mossbloom.de' },
  { id: 'b2b',          name: 'B2B' },
];

function pad(n) { return String(n).padStart(2, '0'); }

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / 86400000) + 1;
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function quarterRange(year, q) {
  const startMonth = (q - 1) * 3;
  const from = new Date(year, startMonth, 1);
  const to   = new Date(year, startMonth + 3, 0);
  return { from: toDateStr(from), to: toDateStr(to) };
}

function currentQuarter() {
  const now = new Date();
  return Math.floor(now.getMonth() / 3) + 1;
}

function resolvePeriod(query) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth();

  if (query.from && query.to) {
    return {
      from: query.from,
      to:   query.to,
      label: `${query.from} – ${query.to}`,
      preset: 'custom',
    };
  }

  const preset = query.period || 'this_month';

  switch (preset) {
    case 'last_month': {
      const d = new Date(year, month - 1, 1);
      const last = new Date(year, month, 0);
      return {
        from: toDateStr(d),
        to: toDateStr(last),
        label: d.toLocaleDateString('lt-LT', { month: 'long', year: 'numeric' }),
        preset,
      };
    }
    case 'this_quarter': {
      const q = currentQuarter();
      const r = quarterRange(year, q);
      return { ...r, label: `Q${q} ${year}`, preset };
    }
    case 'last_quarter': {
      let q = currentQuarter() - 1;
      let y = year;
      if (q < 1) { q = 4; y--; }
      const r = quarterRange(y, q);
      return { ...r, label: `Q${q} ${y}`, preset };
    }
    case 'this_year':
      return {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        label: String(year),
        preset,
      };
    case 'this_month':
    default: {
      const from = new Date(year, month, 1);
      const to   = new Date(year, month + 1, 0);
      return {
        from: toDateStr(from),
        to: toDateStr(to),
        label: from.toLocaleDateString('lt-LT', { month: 'long', year: 'numeric' }),
        preset: preset === 'this_month' ? preset : 'this_month',
      };
    }
  }
}

function previousPeriod(from, to) {
  const len = daysBetween(from, to);
  const prevTo   = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(len - 1));
  return { from: prevFrom, to: prevTo };
}

function pctChange(current, previous) {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function entryText(entry) {
  return `${entry.description || ''} ${entry.notes || ''} ${entry.category || ''}`.toUpperCase();
}

/** B2B manual orders or legacy b2b_import */
function isB2bEntry(entry) {
  if (entry.type !== 'income') return false;
  return entry.source === 'b2b_import' || entry.source === 'b2b';
}

function storeKeyFromEntry(entry) {
  if (isB2bEntry(entry)) return 'b2b';

  if (entry.store_id === 'bloom_lt') return 'bloom_lt';
  if (entry.store_id === 'mossbloom_dk') return 'mossbloom_dk';
  if (entry.store_id === 'mossbloom_de') return 'mossbloom_de';
  return null;
}

function storeKey(entry) {
  return storeKeyFromEntry(entry);
}

function matchesStoreFilter(entry, storeId) {
  if (!storeId) return true;
  if (storeId === 'b2b') return isB2bEntry(entry);
  if (storeId === 'bloom_lt') {
    return storeKeyFromEntry(entry) === 'bloom_lt' && !isB2bEntry(entry);
  }
  return storeKeyFromEntry(entry) === storeId;
}

function wcOrdersInPeriod(db, storeId, from, to) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM orders_cache
    WHERE store_id = ?
      AND status IN ('completed','processing')
      AND substr(date_created, 1, 10) >= ?
      AND substr(date_created, 1, 10) <= ?
  `).get(storeId, from, to);
  return row.c || 0;
}

function wcIncomeFromCache(db, storeId, from, to, rate) {
  const rows = db.prepare(`
    SELECT total, currency FROM orders_cache
    WHERE store_id = ?
      AND status IN ('completed','processing')
      AND substr(date_created, 1, 10) >= ?
      AND substr(date_created, 1, 10) <= ?
  `).all(storeId, from, to);

  let sum = 0;
  for (const r of rows) sum += fx.toEur(r.total, r.currency, rate);
  return sum;
}

function sandoriaiIncome(entries, storeId, rate) {
  let sum = 0;
  for (const e of entries) {
    if (e.type !== 'income' || e.source !== 'sandoriai') continue;
    if (storeId && storeKeyFromEntry(e) !== storeId) continue;
    sum += fx.toEur(e.amount, e.currency, rate);
  }
  return sum;
}

function b2bIncome(entries, rate) {
  let sum = 0;
  let count = 0;
  for (const e of entries) {
    if (!isB2bEntry(e)) continue;
    sum += fx.toEur(e.amount, e.currency, rate);
    count++;
  }
  return { incomeEUR: sum, orders: count };
}

function manualAndOtherIncome(entries, rate) {
  let sum = 0;
  for (const e of entries) {
    if (e.type !== 'income') continue;
    if (['woocommerce', 'sandoriai', 'b2b_import', 'b2b', 'google_sheets'].includes(e.source)) continue;
    sum += fx.toEur(e.amount, e.currency, rate);
  }
  return sum;
}

function storeIncome(entries, storeId, rate) {
  if (storeId === 'b2b') {
    return b2bIncome(entries, rate).incomeEUR;
  }

  let sum = 0;
  for (const e of entries) {
    if (e.type !== 'income') continue;
    if (e.source === 'woocommerce' && e.store_id === storeId) {
      sum += fx.toEur(e.amount, e.currency, rate);
    }
  }
  return sum + sandoriaiIncome(entries, storeId, rate);
}

function storeOrderCount(entries, storeId) {
  if (storeId === 'b2b') return b2bIncome(entries, 1).orders;
  return entries.filter(e => e.type === 'income' && e.source === 'woocommerce' && e.store_id === storeId).length;
}

function expensesByCategory(entries, rate) {
  const byCategory = {};
  let total = 0;
  for (const e of entries) {
    if (e.type !== 'expense') continue;
    const eur = fx.toEur(e.amount, e.currency, rate);
    const cat = e.category || 'Kita';
    byCategory[cat] = (byCategory[cat] || 0) + eur;
    total += eur;
  }
  return { byCategory, total };
}

function aggregateEntries(db, entries, from, to, rate) {
  let expensesEUR = 0;
  let incomeEUR   = 0;
  let orderCount  = 0;

  for (const e of entries) {
    if (e.type === 'expense') {
      expensesEUR += fx.toEur(e.amount, e.currency, rate);
    } else if (e.type === 'income' && e.source === 'woocommerce') {
      incomeEUR += fx.toEur(e.amount, e.currency, rate);
      orderCount++;
    }
  }

  incomeEUR += sandoriaiIncome(entries, null, rate);
  for (const e of entries) {
    if (e.type === 'income' && e.source === 'sandoriai') orderCount++;
  }

  const b2b = b2bIncome(entries, rate);
  incomeEUR  += b2b.incomeEUR;
  orderCount += b2b.orders;

  incomeEUR += manualAndOtherIncome(entries, rate);

  const profitEUR = incomeEUR - expensesEUR;
  const profitMarginPct = incomeEUR > 0 ? (profitEUR / incomeEUR) * 100 : 0;
  const avgOrderEUR = orderCount > 0 ? incomeEUR / orderCount : 0;

  return { incomeEUR, expensesEUR, profitEUR, profitMarginPct, orderCount, avgOrderEUR };
}

function buildStoreBreakdown(db, currentEntries, prevEntries, rate, period, prevPeriod) {
  const curAll  = aggregateEntries(db, currentEntries, period.from, period.to, rate);
  const prevAll = aggregateEntries(db, prevEntries, prevPeriod.from, prevPeriod.to, rate);

  const rows = STORE_ROWS.map(row => {
    const incomeEUR  = storeIncome(currentEntries, row.id, rate);
    const prevIncome = storeIncome(prevEntries, row.id, rate);
    const orders     = storeOrderCount(currentEntries, row.id);

    return {
      id: row.id,
      name: row.name,
      orders,
      incomeEUR,
      pctOfTotal: curAll.incomeEUR > 0 ? (incomeEUR / curAll.incomeEUR) * 100 : 0,
      changePct: pctChange(incomeEUR, prevIncome),
    };
  });

  rows.push({
    id: 'total',
    name: 'TOTAL',
    orders: curAll.orderCount,
    incomeEUR: curAll.incomeEUR,
    pctOfTotal: 100,
    changePct: pctChange(curAll.incomeEUR, prevAll.incomeEUR),
  });

  return rows;
}

function monthlySparkline(db, metric, from, to, rate) {
  const months = [];
  const start  = parseDate(from);
  const end    = parseDate(to);
  let d = new Date(start.getFullYear(), start.getMonth(), 1);

  while (d <= end) {
    const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const mFrom = toDateStr(d > start ? d : start);
    const mTo   = toDateStr(mEnd < end ? mEnd : end);

    const rows = db.prepare(`
      SELECT * FROM accounting_entries
      WHERE entry_date >= ? AND entry_date <= ?
    `).all(mFrom, mTo);

    const agg = aggregateEntries(db, rows, mFrom, mTo, rate);
    let val = 0;
    if (metric === 'income')       val = agg.incomeEUR;
    else if (metric === 'expenses') val = agg.expensesEUR;
    else if (metric === 'profit')   val = agg.profitEUR;
    else if (metric === 'orders')   val = agg.orderCount;
    else if (metric === 'avg')      val = agg.avgOrderEUR;
    else if (metric === 'margin')   val = agg.profitMarginPct;

    months.push(val);
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }

  return months.length ? months : [0];
}

function buildChartMonths(db, rate) {
  const now = new Date();
  const monthKeys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }

  return monthKeys.map(month => {
    const from = `${month}-01`;
    const lastDay = new Date(parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10), 0);
    const to = toDateStr(lastDay);

    const entries = db.prepare(`
      SELECT * FROM accounting_entries WHERE entry_date LIKE ?
    `).all(`${month}-%`);

    const agg = aggregateEntries(db, entries, from, to, rate);

    const stores = { bloom_lt: 0, mossbloom_dk: 0, mossbloom_de: 0, b2b: 0 };
    for (const e of entries) {
      if (e.type !== 'income') continue;
      if (e.source === 'woocommerce' && stores[e.store_id] !== undefined) {
        stores[e.store_id] += fx.toEur(e.amount, e.currency, rate);
      }
    }
    stores.b2b = b2bIncome(entries, rate).incomeEUR;

    return {
      month,
      incomeEUR: agg.incomeEUR,
      expensesEUR: agg.expensesEUR,
      stores,
    };
  });
}

function statBlock(current, previous, sparkline) {
  return {
    value: current,
    changePct: pctChange(current, previous),
    sparkline,
  };
}

async function buildDashboard(db, query) {
  const period     = resolvePeriod(query);
  const prev       = previousPeriod(period.from, period.to);
  const rate       = await fx.getDkkPerEur();

  const fetchEntries = (from, to) => db.prepare(`
    SELECT * FROM accounting_entries
    WHERE entry_date >= ? AND entry_date <= ?
    ORDER BY entry_date DESC, id DESC
  `).all(from, to);

  const currentAll = fetchEntries(period.from, period.to);
  const prevAll    = fetchEntries(prev.from, prev.to);

  const curAgg  = aggregateEntries(db, currentAll, period.from, period.to, rate);
  const prevAgg = aggregateEntries(db, prevAll, prev.from, prev.to, rate);

  const roiValue   = curAgg.expensesEUR  > 0 ? (curAgg.profitEUR  / curAgg.expensesEUR)  * 100 : null;
  const prevRoiVal = prevAgg.expensesEUR > 0 ? (prevAgg.profitEUR / prevAgg.expensesEUR) * 100 : null;

  const pvmSurinktinas = curAgg.incomeEUR * 21 / 121;
  const pvmSumoketas   = currentAll
    .filter(e => e.category === 'Mokesčiai' && (e.description || '').toUpperCase().includes('PVM'))
    .reduce((sum, e) => sum + fx.toEur(e.amount, e.currency, rate), 0);

  const stats = {
    income:       statBlock(curAgg.incomeEUR,       prevAgg.incomeEUR,       []),
    expenses:     statBlock(curAgg.expensesEUR,     prevAgg.expensesEUR,     []),
    profit:       statBlock(curAgg.profitEUR,       prevAgg.profitEUR,       []),
    profitMargin: statBlock(curAgg.profitMarginPct, prevAgg.profitMarginPct, []),
    orderCount:   statBlock(curAgg.orderCount,      prevAgg.orderCount,      []),
    avgOrder:     statBlock(curAgg.avgOrderEUR,     prevAgg.avgOrderEUR,     []),
    roi:          statBlock(roiValue, prevRoiVal, []),
    pvm:          { surinktinas: pvmSurinktinas, sumoketas: pvmSumoketas, moketi: pvmSurinktinas - pvmSumoketas },
  };

  // WooCommerce orders from orders_cache — only those not already in accounting_entries
  const syncedIds = new Set(
    db.prepare(`
      SELECT reference_id FROM accounting_entries
      WHERE source = 'woocommerce' AND entry_date >= ? AND entry_date <= ?
    `).all(period.from, period.to).map(r => r.reference_id)
  );

  const wcRows = db.prepare(`
    SELECT store_id, order_id, customer_name, total, currency, date_created, status
    FROM orders_cache
    WHERE substr(date_created, 1, 10) >= ? AND substr(date_created, 1, 10) <= ?
      AND status NOT IN ('cancelled','refunded','failed')
    ORDER BY date_created DESC
  `).all(period.from, period.to);

  const wcEntries = wcRows
    .filter(o => !syncedIds.has(String(o.order_id)))
    .map(o => {
      const amount    = parseFloat(o.total) || 0;
      const amountEUR = fx.toEur(amount, o.currency, rate);
      return {
        id:           `wc-${o.store_id}-${o.order_id}`,
        type:         'income',
        source:       'woocommerce',
        store_id:     o.store_id,
        reference_id: String(o.order_id),
        description:  `#${o.order_id} — ${o.customer_name || ''}`.trimEnd().replace(/ —$/, ''),
        amount,
        currency:     o.currency,
        entry_date:   o.date_created.slice(0, 10),
        category:     'Pardavimai',
        notes:        o.status,
        amountEUR,
        storeKey:     o.store_id,
      };
    });

  let entries = [
    ...wcEntries,
    ...currentAll.map(e => ({
      ...e,
      amountEUR: fx.toEur(e.amount, e.currency, rate),
      storeKey:  storeKeyFromEntry(e) || e.store_id || '',
    })),
  ].sort((a, b) => b.entry_date.localeCompare(a.entry_date));

  const { type, category, store_id } = query;
  if (type)     entries = entries.filter(e => e.type === type);
  if (category) entries = entries.filter(e => e.category === category);
  if (store_id) entries = entries.filter(e => matchesStoreFilter(e, store_id));

  return {
    rate,
    period,
    previousPeriod: prev,
    stats,
    chart: { months: buildChartMonths(db, rate) },
    stores: buildStoreBreakdown(db, currentAll, prevAll, rate, period, prev),
    expensesByCategory: expensesByCategory(currentAll, rate),
    entries,
    total: entries.length,
  };
}

module.exports = {
  STORE_NAME,
  STORE_ROWS,
  resolvePeriod,
  previousPeriod,
  storeKey,
  storeKeyFromEntry,
  matchesStoreFilter,
  isB2bEntry,
  buildDashboard,
};
