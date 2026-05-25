'use strict';

const fx = require('./fx');

const STORE_NAME = {
  bloom_lt:     'bloom.lt',
  mossbloom_dk: 'mossbloom.dk',
  mossbloom_de: 'mossbloom.de',
};

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

/** Resolve period preset → { from, to, label } */
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
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function storeKey(entry) {
  if (entry.source === 'b2b_import') return 'b2b';
  if (entry.store_id === 'bloom_lt') return 'bloom_lt';
  if (entry.store_id === 'mossbloom_dk') return 'mossbloom_dk';
  if (entry.store_id === 'mossbloom_de') return 'mossbloom_de';
  return null;
}

function matchesStoreFilter(entry, storeId) {
  if (!storeId) return true;
  if (storeId === 'b2b') return entry.source === 'b2b_import';
  if (storeId === 'bloom_lt') return entry.store_id === 'bloom_lt' && entry.source !== 'b2b_import';
  return entry.store_id === storeId;
}

function aggregateEntries(entries, rate) {
  let incomeEUR = 0;
  let expensesEUR = 0;
  let orderCount = 0;

  for (const e of entries) {
    const eur = fx.toEur(e.amount, e.currency, rate);
    if (e.type === 'income') {
      incomeEUR += eur;
      if (['woocommerce', 'sandoriai', 'b2b_import'].includes(e.source)) orderCount++;
    } else {
      expensesEUR += eur;
    }
  }

  const profitEUR = incomeEUR - expensesEUR;
  const profitMarginPct = incomeEUR > 0 ? (profitEUR / incomeEUR) * 100 : 0;
  const avgOrderEUR = orderCount > 0 ? incomeEUR / orderCount : 0;

  return { incomeEUR, expensesEUR, profitEUR, profitMarginPct, orderCount, avgOrderEUR };
}

function aggregateByStore(entries, rate) {
  const stores = {};
  for (const row of STORE_ROWS) {
    stores[row.id] = { orders: 0, incomeEUR: 0 };
  }

  for (const e of entries) {
    if (e.type !== 'income') continue;
    const key = storeKey(e);
    if (!key || !stores[key]) continue;
    stores[key].incomeEUR += fx.toEur(e.amount, e.currency, rate);
    if (['woocommerce', 'sandoriai', 'b2b_import'].includes(e.source)) {
      stores[key].orders++;
    }
  }

  return stores;
}

function buildStoreBreakdown(currentEntries, prevEntries, rate) {
  const cur  = aggregateByStore(currentEntries, rate);
  const prev = aggregateByStore(prevEntries, rate);

  const totalIncome = Object.values(cur).reduce((s, v) => s + v.incomeEUR, 0);
  const totalOrders = Object.values(cur).reduce((s, v) => s + v.orders, 0);

  const rows = STORE_ROWS.map(row => {
    const c = cur[row.id]  || { orders: 0, incomeEUR: 0 };
    const p = prev[row.id] || { orders: 0, incomeEUR: 0 };
    const pctOfTotal = totalIncome > 0 ? (c.incomeEUR / totalIncome) * 100 : 0;
    return {
      id: row.id,
      name: row.name,
      orders: c.orders,
      incomeEUR: c.incomeEUR,
      pctOfTotal,
      changePct: pctChange(c.incomeEUR, p.incomeEUR),
    };
  });

  rows.push({
    id: 'total',
    name: 'TOTAL',
    orders: totalOrders,
    incomeEUR: totalIncome,
    pctOfTotal: 100,
    changePct: pctChange(totalIncome, Object.values(prev).reduce((s, v) => s + v.incomeEUR, 0)),
  });

  return rows;
}

function monthlySparkline(db, metric, from, to, rate) {
  const months = [];
  const start  = parseDate(from);
  const end    = parseDate(to);
  let d = new Date(start.getFullYear(), start.getMonth(), 1);

  while (d <= end) {
    const key  = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const mFrom = toDateStr(d > start ? d : start);
    const mTo   = toDateStr(mEnd < end ? mEnd : end);

    const rows = db.prepare(`
      SELECT type, source, amount, currency FROM accounting_entries
      WHERE entry_date >= ? AND entry_date <= ?
    `).all(mFrom, mTo);

    const agg = aggregateEntries(rows, rate);
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
    const like = `${month}-%`;
    const entries = db.prepare(`
      SELECT type, source, store_id, amount, currency FROM accounting_entries
      WHERE entry_date LIKE ?
    `).all(like);

    let incomeEUR = 0;
    let expensesEUR = 0;
    const stores = { bloom_lt: 0, mossbloom_dk: 0, mossbloom_de: 0, b2b: 0 };

    for (const e of entries) {
      const eur = fx.toEur(e.amount, e.currency, rate);
      if (e.type === 'income') {
        incomeEUR += eur;
        const sk = storeKey(e);
        if (sk && stores[sk] !== undefined) stores[sk] += eur;
      } else {
        expensesEUR += eur;
      }
    }

    return { month, incomeEUR, expensesEUR, stores };
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

  const curAgg  = aggregateEntries(currentAll, rate);
  const prevAgg = aggregateEntries(prevAll, rate);

  const stats = {
    income:       statBlock(curAgg.incomeEUR,       prevAgg.incomeEUR,       monthlySparkline(db, 'income',   period.from, period.to, rate)),
    expenses:     statBlock(curAgg.expensesEUR,     prevAgg.expensesEUR,     monthlySparkline(db, 'expenses', period.from, period.to, rate)),
    profit:       statBlock(curAgg.profitEUR,       prevAgg.profitEUR,       monthlySparkline(db, 'profit',   period.from, period.to, rate)),
    profitMargin: statBlock(curAgg.profitMarginPct, prevAgg.profitMarginPct, monthlySparkline(db, 'margin',   period.from, period.to, rate)),
    orderCount:   statBlock(curAgg.orderCount,       prevAgg.orderCount,       monthlySparkline(db, 'orders',   period.from, period.to, rate)),
    avgOrder:     statBlock(curAgg.avgOrderEUR,     prevAgg.avgOrderEUR,     monthlySparkline(db, 'avg',      period.from, period.to, rate)),
  };

  let entries = currentAll.map(e => ({
    ...e,
    amountEUR: fx.toEur(e.amount, e.currency, rate),
    storeKey:  storeKey(e) || e.store_id || '',
  }));

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
    stores: buildStoreBreakdown(currentAll, prevAll, rate),
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
  matchesStoreFilter,
  buildDashboard,
};
