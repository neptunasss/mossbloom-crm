'use strict';

const ACCT_STORE_NAME = {
  bloom_lt:     'bloom.lt',
  mossbloom_dk: 'mossbloom.dk',
  mossbloom_de: 'mossbloom.de',
};
const ACCT_STORE_COLOR = {
  bloom_lt:     '#2ea043',
  mossbloom_dk: '#1f6feb',
  mossbloom_de: '#da3633',
};
const SOURCE_BADGE = {
  woocommerce: '<span class="acct-src-badge acct-src-wc">WC</span>',
  sandoriai:   '<span class="acct-src-badge acct-src-sa">S</span>',
  manual:      '',
};

let acctChart     = null;
let acctChartData = null;
let acctChartCur  = 'EUR';

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadAccounting() {
  document.getElementById('acct-loading').hidden = false;

  const month    = document.getElementById('acct-month-filter').value;
  const type     = document.getElementById('acct-type-filter').value;
  const category = document.getElementById('acct-category-filter').value;
  const storeId  = document.getElementById('acct-store-filter').value;

  try {
    const p = new URLSearchParams({ month, limit: 300 });
    if (type)     p.set('type',     type);
    if (category) p.set('category', category);
    if (storeId)  p.set('store_id', storeId);

    const summaryP = new URLSearchParams({ month });
    if (storeId) summaryP.set('store_id', storeId);

    const [summary, { entries }, chartData] = await Promise.all([
      api(`/api/accounting/summary?${summaryP}`),
      api(`/api/accounting?${p}`),
      acctChartData ? Promise.resolve(null) : api('/api/accounting/chart'),
    ]);

    renderSummary(summary);
    renderEntries(entries);

    if (chartData) {
      acctChartData = chartData.months;
      renderChart(acctChartData, acctChartCur);
    }

    document.getElementById('header-count').textContent = `${entries.length} įrašas(-ų)`;
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  } finally {
    document.getElementById('acct-loading').hidden = true;
  }
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function renderSummary(data) {
  const fmt = obj => {
    const entries = Object.entries(obj || {});
    if (!entries.length) return '<span style="color:var(--text-muted)">—</span>';
    return entries.map(([c, v]) => fmtTotal(v, c)).join('<br>');
  };

  const profitHtml = Object.entries(data.profit || {}).map(([c, v]) => {
    const cls = v >= 0 ? 'acct-profit-pos' : 'acct-profit-neg';
    return `<span class="${cls}">${fmtTotal(v, c)}</span>`;
  }).join('<br>') || '<span style="color:var(--text-muted)">—</span>';

  document.getElementById('acct-summary').innerHTML = `
    <div class="acct-summary-card acct-income">
      <div class="acct-summary-icon">📈</div>
      <div class="acct-summary-body">
        <div class="acct-summary-val">${fmt(data.income)}</div>
        <div class="acct-summary-lbl">Pajamos šį mėnesį</div>
      </div>
    </div>
    <div class="acct-summary-card acct-expense">
      <div class="acct-summary-icon">📉</div>
      <div class="acct-summary-body">
        <div class="acct-summary-val">${fmt(data.expenses)}</div>
        <div class="acct-summary-lbl">Išlaidos šį mėnesį</div>
      </div>
    </div>
    <div class="acct-summary-card acct-profit">
      <div class="acct-summary-icon">💼</div>
      <div class="acct-summary-body">
        <div class="acct-summary-val">${profitHtml}</div>
        <div class="acct-summary-lbl">Pelnas šį mėnesį</div>
      </div>
    </div>
  `;
}

// ── Entries table ─────────────────────────────────────────────────────────────

function renderEntries(entries) {
  const tbody = document.getElementById('acct-tbody');
  const empty = document.getElementById('acct-empty');

  if (!entries.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  tbody.innerHTML = entries.map(e => {
    const isIncome  = e.type === 'income';
    const rowCls    = isIncome ? 'acct-row-income' : 'acct-row-expense';
    const amtCls    = isIncome ? 'acct-amount-income' : 'acct-amount-expense';
    const amtPfx    = isIncome ? '+' : '−';

    const srcBadge  = SOURCE_BADGE[e.source] || '';
    const notesHtml = e.notes ? `<div class="acct-entry-notes">${esc(e.notes)}</div>` : '';

    const storeName  = ACCT_STORE_NAME[e.store_id]  || e.store_id  || '';
    const storeColor = ACCT_STORE_COLOR[e.store_id] || '#888';
    const storeBadge = storeName
      ? `<span class="store-badge" style="background:${storeColor}1a;color:${storeColor};border:1px solid ${storeColor}40">${storeName}</span>`
      : '<span style="color:var(--text-muted)">—</span>';

    return `<tr class="${rowCls}">
      <td class="col-date" style="white-space:nowrap">${fmtDate(e.entry_date)}</td>
      <td>
        <div class="acct-desc-wrap">
          <span class="acct-desc-text">${esc(e.description)}</span>
          ${srcBadge}
        </div>
        ${notesHtml}
      </td>
      <td><span class="acct-cat-badge">${esc(e.category || 'Kita')}</span></td>
      <td>${storeBadge}</td>
      <td class="col-total text-right ${amtCls}">${amtPfx}${fmtTotal(e.amount, e.currency)}</td>
      <td class="col-actions">
        <button class="btn-file" onclick="openFileModal(null,null,null,${e.id})" title="Failai">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <button class="btn-row-action btn-row-delete" onclick="deleteAcctEntry(${e.id})" title="Ištrinti">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

// ── P&L chart ─────────────────────────────────────────────────────────────────

function renderChart(months, currency) {
  if (!months || !window.Chart) return;

  const labels   = months.map(m => {
    const d = new Date(m.month + '-01');
    return d.toLocaleDateString('lt-LT', { month: 'short', year: '2-digit' });
  });
  const income   = months.map(m => (m.income[currency]   || 0));
  const expenses = months.map(m => (m.expenses[currency] || 0));
  const profit   = income.map((v, i) => v - expenses[i]);

  const fmtVal = v => currency === 'DKK' ? `${v.toFixed(0)} kr` : `€${v.toFixed(2)}`;

  const ctx = document.getElementById('acct-chart').getContext('2d');
  if (acctChart) acctChart.destroy();

  acctChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Pajamos (${currency})`,
          data: income,
          backgroundColor: 'rgba(22,163,74,0.72)',
          borderColor: '#16a34a',
          borderWidth: 1,
          borderRadius: 4,
          order: 2,
        },
        {
          label: `Išlaidos (${currency})`,
          data: expenses,
          backgroundColor: 'rgba(220,38,38,0.72)',
          borderColor: '#dc2626',
          borderWidth: 1,
          borderRadius: 4,
          order: 2,
        },
        {
          label: `Pelnas (${currency})`,
          data: profit,
          type: 'line',
          borderColor: '#1d4ed8',
          backgroundColor: 'rgba(29,78,216,0.08)',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: profit.map(v => v >= 0 ? '#1d4ed8' : '#dc2626'),
          tension: 0.35,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { size: 12, family: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }, padding: 16 },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmtVal(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 12 } } },
        y: {
          beginAtZero: true,
          ticks: {
            callback: v => fmtVal(v),
            font: { size: 11 },
          },
          grid: { color: 'rgba(0,0,0,0.06)' },
        },
      },
    },
  });
}

function setChartCurrency(currency) {
  acctChartCur = currency;
  document.getElementById('chart-eur-btn').classList.toggle('active', currency === 'EUR');
  document.getElementById('chart-dkk-btn').classList.toggle('active', currency === 'DKK');
  if (acctChartData) renderChart(acctChartData, currency);
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function syncAccounting() {
  const btn  = document.getElementById('acct-sync-btn');
  const icon = document.getElementById('acct-sync-icon');
  btn.disabled = true;
  icon.style.animation = 'spin 0.9s linear infinite';

  try {
    const { results } = await api('/api/accounting/sync', { method: 'POST' });
    const wc = results.woocommerce, sa = results.sandoriai;
    const lines = [];
    if (wc.added || wc.skipped) lines.push(`WooCommerce: +${wc.added} naujų (${wc.skipped} jau yra)`);
    if (sa.added || sa.skipped) lines.push(`Sandoriai: +${sa.added} naujų (${sa.skipped} jau yra)`);
    toast(lines.join('\n') || 'Nieko nauja');
    acctChartData = null; // force chart reload
    await loadAccounting();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    icon.style.animation = '';
  }
}

// ── CSV export ─────────────────────────────────────────────────────────────────

function exportCSV() {
  const month   = document.getElementById('acct-month-filter').value;
  const storeId = document.getElementById('acct-store-filter').value;
  const p       = new URLSearchParams({ month });
  if (storeId) p.set('store_id', storeId);
  window.location.href = `/api/accounting/export.csv?${p}`;
}

// ── Expense modal ─────────────────────────────────────────────────────────────

function openExpenseModal() {
  const form = document.getElementById('expense-form');
  form.reset();
  form.elements['entry_date'].value = new Date().toISOString().slice(0, 10);
  // Default Kita for expense, keep as is for income
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
    acctChartData = null;
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
    acctChartData = null;
    await loadAccounting();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Month filter ──────────────────────────────────────────────────────────────

function initAccountingMonthFilter() {
  const sel = document.getElementById('acct-month-filter');
  const now = new Date();
  const opts = [];
  for (let i = 0; i < 13; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    // Use local year/month to avoid UTC offset shifting the month back by one day
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const lbl = d.toLocaleDateString('lt-LT', { year: 'numeric', month: 'long' });
    opts.push(`<option value="${val}"${i === 0 ? ' selected' : ''}>${lbl}</option>`);
  }
  sel.innerHTML = opts.join('');
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initAccounting() {
  initAccountingMonthFilter();
  ['acct-month-filter', 'acct-type-filter', 'acct-category-filter', 'acct-store-filter']
    .forEach(id => document.getElementById(id).addEventListener('change', loadAccounting));
}
