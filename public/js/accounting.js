'use strict';

const ACCT_STORE = {
  bloom_lt:     { name: 'bloom.lt' },
  mossbloom_dk: { name: 'mossbloom.dk' },
  mossbloom_de: { name: 'mossbloom.de' },
  b2b:          { name: 'B2B' },
};

const SOURCE_BADGE = {
  woocommerce: '<span class="acct-badge acct-badge-wc">WC</span>',
  b2b_import:  '<span class="acct-badge acct-badge-b2b">B2B</span>',
  b2b:         '<span class="acct-badge acct-badge-b2b">B2B</span>',
};

const CHART_MONTHS = ['Sau','Vas','Kov','Bal','Geg','Bir','Lie','Rgp','Rgs','Spa','Lap','Gru'];

const STAT_CARDS = [
  { key: 'income',       label: 'Pajamos',             cls: 'income',  fmt: 'eur' },
  { key: 'expenses',     label: 'Išlaidos',            cls: 'expense', fmt: 'eur' },
  { key: 'profit',       label: 'Pelnas',              cls: 'profit',  fmt: 'eur', signed: true },
  { key: 'profitMargin', label: 'Pelno marža',         cls: 'neutral', fmt: 'pct' },
  { key: 'orderCount',   label: 'Užsakymų skaičius',   cls: 'neutral', fmt: 'int' },
  { key: 'avgOrder',     label: 'Vidutinis užsakymas',  cls: 'neutral', fmt: 'eur' },
  { key: 'roi',          label: 'ROI',                 cls: 'neutral', fmt: 'pct', isRoi: true },
];

let acctChart         = null;
let acctExpensesChart = null;
let acctChartData     = null;
let acctChartMode  = 'eur';
let acctEntries    = [];
let acctSort       = { col: 'entry_date', dir: -1 };
let acctPeriod     = 'this_month';
let acctCustomFrom = '';
let acctCustomTo   = '';
let acctPeriodData = { from: '', to: '' };
let acctLoading    = false;

// ── Period helpers ────────────────────────────────────────────────────────────

function periodQuery() {
  const p = new URLSearchParams({ period: acctPeriod });
  if (acctPeriod === 'custom' && acctCustomFrom && acctCustomTo) {
    p.set('from', acctCustomFrom);
    p.set('to', acctCustomTo);
  }
  const type     = document.getElementById('acct-type-filter')?.value;
  const category = document.getElementById('acct-category-filter')?.value;
  const storeId  = document.getElementById('acct-store-filter')?.value;
  if (type)     p.set('type', type);
  if (category) p.set('category', category);
  if (storeId)  p.set('store_id', storeId);
  return p;
}

function prevPeriodLabel() {
  const labels = {
    this_month: 'praėjusį mėnesį',
    last_month: 'ankstesnį mėnesį',
    this_quarter: 'praėjusį ketvirtį',
    last_quarter: 'ankstesnį ketvirtį',
    this_year: 'praėjusius metus',
    custom: 'ankstesnį laikotarpį',
  };
  return labels[acctPeriod] || 'ankstesnį laikotarpį';
}

// ── Load dashboard ────────────────────────────────────────────────────────────

async function loadAccounting(silent = false) {
  if (acctLoading) return;
  acctLoading = true;
  const loader = document.getElementById('acct-loading');
  if (!silent) loader.hidden = false;

  try {
    const data = await api(`/api/accounting/dashboard?${periodQuery()}`);
    acctPeriodData = data.period || acctPeriodData;
    acctChartData = data.chart.months;
    acctEntries   = data.entries;

    renderRatesNote(data.rate);
    renderStats(data.stats);
    renderChart(acctChartData);
    renderExpensesChart(data.expensesByCategory);
    renderStoreBreakdown(data.stores, data.period);
    renderEntries(acctEntries);

    document.getElementById('acct-stores-period').textContent = data.period.label || '';
    document.getElementById('acct-tx-count').textContent =
      `${data.total} sandorių · ${data.period.from} – ${data.period.to}`;
    document.getElementById('header-count').textContent =
      `${data.total} sandorių`;
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  } finally {
    loader.hidden = true;
    acctLoading = false;
  }
}

// ── Stats cards ───────────────────────────────────────────────────────────────

function fmtEUR(v) {
  return `€${parseFloat(v || 0).toLocaleString('lt-LT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtStatValue(val, fmt) {
  if (fmt === 'eur') return fmtEUR(val);
  if (fmt === 'pct') return `${parseFloat(val || 0).toFixed(1)}%`;
  if (fmt === 'int') return String(Math.round(val || 0));
  return String(val);
}

function renderChange(pct, cls) {
  if (pct == null) {
    return `<span class="acct-stat-change neutral">— vs ${prevPeriodLabel()}</span>`;
  }
  const up   = pct >= 0;
  const sign = up ? '+' : '';
  const colorCls = cls === 'expense'
    ? (up ? 'down' : 'up')
    : (up ? 'up' : 'down');
  const arrow = up ? '↑' : '↓';
  return `<span class="acct-stat-change ${colorCls}">${arrow} ${sign}${Math.abs(pct).toFixed(1)}% vs ${prevPeriodLabel()}</span>`;
}

function renderStoreChange(pct) {
  if (pct == null) return '<span class="acct-stat-change neutral">—</span>';
  const up = pct >= 0;
  const sign = up ? '+' : '';
  const chgCls = up ? 'up' : 'down';
  return `<span class="acct-stat-change ${chgCls}">${sign}${pct.toFixed(1)}%</span>`;
}

function sparklineSvg(values, color) {
  if (!values || values.length < 2) return '';
  const w = 72, h = 28, pad = 2;
  const max = Math.max(...values, 0.01);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  return `<svg class="acct-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

const SPARK_COLORS = {
  income: '#4b5563', expense: '#4b5563', profit: '#4b5563', neutral: '#4b5563',
};

function renderStats(stats) {
  const grid = document.getElementById('acct-stats-grid');

  const cardsHtml = STAT_CARDS.map(card => {
    const s = stats[card.key] || { value: 0, changePct: 0 };
    let col = card.cls;
    if (card.key === 'profit') col = (s.value >= 0 ? 'income' : 'expense');
    if (card.isRoi) {
      const v = s.value;
      col = v == null ? 'neutral' : v > 15 ? 'income' : v > 0 ? 'roi-ok' : 'expense';
    }
    const isZeroExpenses = card.key === 'expenses' && !s.value;
    const val = s.value == null ? '—' : fmtStatValue(s.value, card.fmt);
    return `<div class="acct-stat-card acct-stat-${col}${isZeroExpenses ? ' acct-stat-empty' : ''}">
      <span class="acct-stat-label">${card.label}</span>
      <div class="acct-stat-value">${val}</div>
      ${renderChange(s.changePct, card.key === 'expenses' ? 'expense' : col)}
    </div>`;
  }).join('');

  const pvm = stats.pvm || { surinktinas: 0, sumoketas: 0, moketi: 0 };
  const pvmCard = `<div class="acct-stat-card acct-stat-pvm" title="PVM 21% nuo pajamų">
    <span class="acct-stat-label">PVM mokėti</span>
    <div class="acct-stat-value">${fmtEUR(pvm.moketi)}</div>
    <div class="acct-pvm-detail">Surinktinas: ${fmtEUR(pvm.surinktinas)}</div>
    <div class="acct-pvm-detail">Sumokėtas: ${fmtEUR(pvm.sumoketas)}</div>
  </div>`;

  grid.innerHTML = cardsHtml + pvmCard;
}

function renderRatesNote(rate) {
  const el = document.getElementById('acct-rates-note');
  if (el) el.textContent = `1 EUR = ${parseFloat(rate || 7.46).toFixed(2)} DKK`;
}

// ── Chart ─────────────────────────────────────────────────────────────────────

function setChartMode(mode) {
  acctChartMode = mode;
  document.getElementById('chart-mode-eur')?.classList.toggle('active', mode === 'eur');
  document.getElementById('chart-mode-stores')?.classList.toggle('active', mode === 'stores');
  if (acctChartData) renderChart(acctChartData);
}

function renderChart(months) {
  if (!months?.length || !window.Chart) return;

  const labels = months.map(m => {
    const [yr, mo] = m.month.split('-');
    return `${CHART_MONTHS[Number(mo) - 1]} '${yr.slice(2)}`;
  });

  const ctx = document.getElementById('acct-chart')?.getContext('2d');
  if (!ctx) return;
  if (acctChart) acctChart.destroy();

  const tickColor = '#6b7280';

  if (acctChartMode === 'stores') {
    acctChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'bloom.lt',     data: months.map(m => m.stores?.bloom_lt || 0),     backgroundColor: 'rgba(34,197,94,0.9)',  borderRadius: 4, stack: 'income' },
          { label: 'mossbloom.dk', data: months.map(m => m.stores?.mossbloom_dk || 0), backgroundColor: 'rgba(34,197,94,0.55)', borderRadius: 4, stack: 'income' },
          { label: 'mossbloom.de', data: months.map(m => m.stores?.mossbloom_de || 0), backgroundColor: 'rgba(34,197,94,0.35)', borderRadius: 4, stack: 'income' },
          { label: 'B2B',          data: months.map(m => m.stores?.b2b || 0),          backgroundColor: 'rgba(34,197,94,0.2)',  borderRadius: 4, stack: 'income' },
        ],
      },
      options: chartOptions(tickColor, true),
    });
    return;
  }

  const income   = months.map(m => m.incomeEUR || 0);
  const expenses = months.map(m => m.expensesEUR || 0);

  acctChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Pajamos',  data: income,   backgroundColor: 'rgba(34,197,94,0.8)',  borderRadius: 4 },
        { label: 'Išlaidos', data: expenses, backgroundColor: 'rgba(239,68,68,0.8)', borderRadius: 4 },
      ],
    },
    options: chartOptions(tickColor, false),
  });
}

function chartOptions(tickColor, stacked) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels: { color: '#9ca3af', font: { size: 11 }, padding: 20, boxWidth: 10 },
      },
      tooltip: {
        backgroundColor: '#1a1d27',
        borderColor: '#2d3348',
        borderWidth: 1,
        titleColor: '#e5e7eb',
        bodyColor: '#9ca3af',
        callbacks: {
          label: ctx => ` ${ctx.dataset.label}: €${(ctx.parsed.y || 0).toLocaleString('lt-LT', { minimumFractionDigits: 2 })}`,
        },
      },
    },
    scales: {
      x: {
        stacked: !!stacked,
        grid: { display: false },
        ticks: { color: tickColor, font: { size: 11 } },
      },
      y: {
        stacked: !!stacked,
        beginAtZero: true,
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: tickColor,
          font: { size: 11 },
          callback: v => `€${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`,
        },
      },
    },
  };
}

// ── Expenses breakdown chart ──────────────────────────────────────────────────

function renderExpensesChart(expData) {
  const panel = document.getElementById('acct-expenses-panel');
  if (!expData || !window.Chart) { if (panel) panel.hidden = true; return; }

  const ctx = document.getElementById('acct-expenses-chart')?.getContext('2d');
  if (!ctx) return;
  if (acctExpensesChart) acctExpensesChart.destroy();

  const CAT_ORDER = ['Žaliavos', 'Darbo užmokestis', 'Reklama', 'Mokesčiai', 'Paslaugos', 'Siuntimas', 'Kitos išlaidos', 'Kita'];
  const byCategory = expData.byCategory || {};
  const total = expData.total || 1;

  const labels = CAT_ORDER.filter(c => (byCategory[c] || 0) > 0);
  if (!labels.length) { if (panel) panel.hidden = true; return; }
  if (panel) panel.hidden = false;

  const data = labels.map(c => byCategory[c] || 0);

  acctExpensesChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: 'rgba(239,68,68,0.55)',
        borderRadius: 4,
        barThickness: 22,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2d3348',
          borderWidth: 1,
          titleColor: '#e5e7eb',
          bodyColor: '#9ca3af',
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.x || 0;
              const pct = ((v / total) * 100).toFixed(1);
              return ` €${v.toLocaleString('lt-LT', { minimumFractionDigits: 2 })} · ${pct}%`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#6b7280', font: { size: 11 }, callback: v => `€${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}` },
        },
        y: {
          grid: { display: false },
          ticks: { color: '#9ca3af', font: { size: 12 } },
        },
      },
    },
  });
}

// ── Store breakdown ───────────────────────────────────────────────────────────

function renderStoreBreakdown(stores) {
  const tbody = document.getElementById('acct-stores-tbody');
  if (!stores?.length) { tbody.innerHTML = ''; return; }

  tbody.innerHTML = stores.map(row => {
    const isTotal = row.id === 'total';
    return `<tr class="${isTotal ? 'acct-row-total' : ''}">
      <td>${esc(row.name)}</td>
      <td class="num">${row.orders}</td>
      <td class="num acct-val-income">${fmtEUR(row.incomeEUR)}</td>
      <td class="num">${row.pctOfTotal.toFixed(1)}%</td>
      <td class="num">${renderStoreChange(row.changePct)}</td>
    </tr>`;
  }).join('');
}

// ── Transactions ────────────────────────────────────────────────────────────

function storeBadge(entry) {
  const key = entry.storeKey || entry.store_id;
  if (entry.source === 'b2b_import' || entry.source === 'b2b' || key === 'b2b') {
    return '<span class="acct-store-pill">B2B</span>';
  }
  const s = ACCT_STORE[key];
  if (!s) return '<span class="acct-muted">—</span>';
  return `<span class="acct-store-pill">${s.name}</span>`;
}

function sortEntries(entries) {
  const { col, dir } = acctSort;
  return [...entries].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === 'store') {
      va = a.storeKey || a.store_id || '';
      vb = b.storeKey || b.store_id || '';
    }
    if (col === 'entry_date') return dir * String(va).localeCompare(String(vb));
    if (typeof va === 'number') return dir * (va - vb);
    return dir * String(va || '').localeCompare(String(vb || ''));
  });
}

function renderEntries(entries) {
  const tbody = document.getElementById('acct-tbody');
  const empty = document.getElementById('acct-empty');
  const sorted = sortEntries(entries);

  if (!sorted.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  tbody.innerHTML = sorted.map(e => {
    const isIncome = e.type === 'income';
    const amtCls   = isIncome ? 'acct-amt-in' : 'acct-amt-out';
    const amtPfx   = isIncome ? '+' : '−';
    const srcBadge = SOURCE_BADGE[e.source] || '';
    const notesHtml = e.notes ? `<div class="acct-tx-notes">${esc(e.notes)}</div>` : '';

    return `<tr>
      <td class="acct-tx-date">${fmtDate(e.entry_date)}</td>
      <td>
        <div class="acct-tx-desc">${esc(e.description)}${srcBadge}</div>
        <div class="acct-tx-cat">${esc(e.category || 'Kita')}</div>
        ${notesHtml}
      </td>
      <td>${storeBadge(e)}</td>
      <td class="num ${amtCls}">${amtPfx}${fmtEUR(e.amountEUR)}</td>
      <td class="acct-tx-actions">
        <button type="button" class="acct-icon-btn" onclick="openFileModal(null,null,null,${e.id})" title="Failai">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <button type="button" class="acct-icon-btn acct-icon-del" onclick="deleteAcctEntry(${e.id})" title="Ištrinti">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function updateSortIndicators() {
  document.querySelectorAll('#acct-tx-table th.sortable').forEach(th => {
    const col = th.dataset.sort;
    th.classList.remove('sort-asc', 'sort-desc');
    if (col === acctSort.col) th.classList.add(acctSort.dir > 0 ? 'sort-asc' : 'sort-desc');
  });
}

// ── Sync (refresh from WooCommerce) ───────────────────────────────────────────

async function syncAccounting() {
  const btn  = document.getElementById('acct-sync-btn');
  const icon = document.getElementById('acct-sync-icon');
  btn.disabled = true;
  if (icon) icon.style.animation = 'acct-spin 0.9s linear infinite';

  try {
    const { results } = await api('/api/accounting/sync', { method: 'POST' });
    const wc = results.woocommerce, sa = results.sandoriai;
    const parts = [];
    if (wc.added) parts.push(`WC: +${wc.added}`);
    if (sa.added) parts.push(`Sandoriai: +${sa.added}`);
    if (parts.length) toast(parts.join(' · '));
    await loadAccounting(true);
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    if (icon) icon.style.animation = '';
  }
}

async function syncSheetsAccounting() {
  const btn  = document.getElementById('acct-sheets-sync-btn');
  const icon = document.getElementById('acct-sheets-sync-icon');
  btn.disabled = true;
  if (icon) icon.style.animation = 'acct-spin 0.9s linear infinite';

  try {
    const { results } = await api('/api/accounting/sync-sheets', { method: 'POST' });
    if (!results.ok) {
      toast(results.reason === 'not_configured'
        ? 'Google Sheets neprijungta (trūksta ENV)'
        : 'Sinchronizacija praleista', 'error');
      return;
    }
    const exp = results.expenses;
    toast(`Sheets: išlaidos +${exp.added} (${exp.skipped} jau yra)`);
    await loadAccounting(true);
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    if (icon) icon.style.animation = '';
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV() {
  const p = new URLSearchParams();
  if (acctPeriodData.from && acctPeriodData.to) {
    p.set('from', acctPeriodData.from);
    p.set('to', acctPeriodData.to);
  }
  const storeId = document.getElementById('acct-store-filter')?.value;
  if (storeId) p.set('store_id', storeId);
  window.location.href = `/api/accounting/export.csv?${p}`;
}

// ── Expense modal ─────────────────────────────────────────────────────────────

function openExpenseModal() {
  const form = document.getElementById('expense-form');
  form.reset();
  form.elements['entry_date'].value = new Date().toISOString().slice(0, 10);
  if (form.elements['category']) form.elements['category'].value = 'Kita';
  document.getElementById('expense-modal').hidden = false;
}

function closeExpenseModal() {
  document.getElementById('expense-modal').hidden = true;
}

async function saveExpense() {
  const form = document.getElementById('expense-form');
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api('/api/accounting', { method: 'POST', body: JSON.stringify(data) });
    toast('Įrašas išsaugotas');
    closeExpenseModal();
    await loadAccounting();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

async function deleteAcctEntry(id) {
  if (!confirm('Ištrinti šį įrašą?')) return;
  try {
    await api(`/api/accounting/${id}`, { method: 'DELETE' });
    toast('Įrašas ištrintas');
    await loadAccounting();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function setPeriod(period) {
  acctPeriod = period;
  document.querySelectorAll('.acct-period-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });
  const customEl = document.getElementById('acct-custom-range');
  customEl.hidden = period !== 'custom';
  if (period === 'custom') return;
  loadAccounting();
}

function initAccounting() {
  document.querySelectorAll('.acct-period-btn').forEach(btn => {
    btn.addEventListener('click', () => setPeriod(btn.dataset.period));
  });

  document.getElementById('chart-mode-eur')?.addEventListener('click', () => setChartMode('eur'));
  document.getElementById('chart-mode-stores')?.addEventListener('click', () => setChartMode('stores'));

  document.getElementById('acct-apply-range')?.addEventListener('click', () => {
    acctCustomFrom = document.getElementById('acct-from').value;
    acctCustomTo   = document.getElementById('acct-to').value;
    if (acctCustomFrom && acctCustomTo) loadAccounting();
  });

  ['acct-type-filter', 'acct-category-filter', 'acct-store-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => loadAccounting());
  });

  document.querySelectorAll('#acct-tx-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (acctSort.col === col) acctSort.dir *= -1;
      else { acctSort.col = col; acctSort.dir = col === 'entry_date' ? -1 : 1; }
      updateSortIndicators();
      renderEntries(acctEntries);
    });
  });

  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  document.getElementById('acct-from').value = first.toISOString().slice(0, 10);
  document.getElementById('acct-to').value   = now.toISOString().slice(0, 10);
  acctCustomFrom = first.toISOString().slice(0, 10);
  acctCustomTo   = now.toISOString().slice(0, 10);
}
