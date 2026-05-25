'use strict';

let dealsEditingId   = null;
let dealsCurrentView = 'pipeline';
let dealsCurrentData = [];

const PIPELINE_COLS = [
  { id: 'lead',        label: 'Lead',        color: '#6b7280' },
  { id: 'quoted',      label: 'Quoted',      color: '#2563eb' },
  { id: 'negotiating', label: 'Negotiating', color: '#d97706' },
  { id: 'won',         label: 'Won',         color: '#16a34a' },
  { id: 'lost',        label: 'Lost',        color: '#dc2626' },
];

const DEAL_STATUS_STYLE = {
  lead:        { bg: '#f1f5f9', text: '#475569' },
  quoted:      { bg: '#dbeafe', text: '#1e40af' },
  negotiating: { bg: '#fef3c7', text: '#92400e' },
  won:         { bg: '#dcfce7', text: '#166534' },
  lost:        { bg: '#fee2e2', text: '#991b1b' },
};

const PAYMENT_LABELS = {
  bank_transfer: 'Bank transfer',
  cash:          'Cash',
  invoice:       'Invoice',
  crypto:        'Crypto',
  other:         'Other',
};

const STORE_LABELS = {
  bloom_lt:     { label: 'LT', color: '#2ea043' },
  mossbloom_dk: { label: 'DK', color: '#1f6feb' },
  mossbloom_de: { label: 'DE', color: '#da3633' },
  custom:       { label: '—',  color: '#888' },
};

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadDeals() {
  document.getElementById('deals-loading').hidden = false;

  try {
    const search = document.getElementById('deals-search-input').value.trim();
    const p = new URLSearchParams({ limit: 300 });
    if (search) p.set('search', search);

    const { deals } = await api(`/api/deals?${p}`);
    dealsCurrentData = deals;

    renderDeals(deals);
    renderAccountingWidget(deals);

    document.getElementById('header-count').textContent =
      `${deals.length} sandori${deals.length !== 1 ? 'ų' : 's'}`;
  } catch (err) {
    toast('Failed to load deals: ' + err.message, 'error');
  } finally {
    document.getElementById('deals-loading').hidden = true;
  }
}

function renderDeals(deals) {
  if (dealsCurrentView === 'pipeline') {
    renderPipeline(deals);
    document.getElementById('deals-pipeline-wrap').hidden = false;
    document.getElementById('deals-table-wrap').hidden    = true;
    const empty = document.getElementById('deals-empty');
    if (empty) empty.hidden = true;
  } else {
    renderDealTable(deals);
    document.getElementById('deals-pipeline-wrap').hidden = true;
    document.getElementById('deals-table-wrap').hidden    = false;
  }
}

// ── Accounting widget ─────────────────────────────────────────────────────────

function renderAccountingWidget(deals) {
  const now       = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisYear  = String(now.getFullYear());

  const wonDeals    = deals.filter(d => d.status === 'won');
  const totalsMonth = {};
  const totalsYear  = {};

  for (const d of wonDeals) {
    const date = d.deal_date || '';
    const cur  = d.currency  || 'EUR';
    const amt  = parseFloat(d.amount) || 0;
    if (date.startsWith(thisMonth)) totalsMonth[cur] = (totalsMonth[cur] || 0) + amt;
    if (date.startsWith(thisYear))  totalsYear[cur]  = (totalsYear[cur]  || 0) + amt;
  }

  const fmt = obj =>
    Object.entries(obj).map(([cur, amt]) => fmtTotal(amt, cur)).join(' + ') || '—';

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const widget = document.getElementById('deals-accounting');
  widget.innerHTML = `
    <div class="accounting-item">
      <div class="accounting-val">${fmt(totalsMonth)}</div>
      <div class="accounting-lbl">Won this month (${MONTHS[now.getMonth()]})</div>
    </div>
    <div class="accounting-sep"></div>
    <div class="accounting-item">
      <div class="accounting-val">${fmt(totalsYear)}</div>
      <div class="accounting-lbl">Won this year (${thisYear})</div>
    </div>
    <div class="accounting-sep"></div>
    <div class="accounting-item">
      <div class="accounting-val">${wonDeals.length}</div>
      <div class="accounting-lbl">Total won deals</div>
    </div>
  `;
  widget.hidden = false;
}

// ── Pipeline view ─────────────────────────────────────────────────────────────

function renderPipeline(deals) {
  PIPELINE_COLS.forEach(col => {
    const container = document.getElementById(`col-${col.id}`);
    const countEl   = document.getElementById(`col-${col.id}-count`);
    const colDeals  = deals.filter(d => d.status === col.id);

    if (countEl) countEl.textContent = colDeals.length;
    if (!container) return;

    if (!colDeals.length) {
      container.innerHTML = '<div class="pipeline-empty-col">Drop here</div>';
      return;
    }

    container.innerHTML = colDeals.map(d => {
      const amount = d.amount ? fmtTotal(d.amount, d.currency) : '';
      const date   = d.deal_date ? fmtDate(d.deal_date) : '';
      return `<div class="deal-card" draggable="true" data-id="${d.id}" data-status="${d.status}"
                   ondragstart="onCardDragStart(event)"
                   ondragend="onCardDragEnd(event)">
        <div class="deal-card-top" onclick="editDeal(${d.id})">
          <div class="deal-card-name">${esc(d.customer_name)}</div>
          ${d.description ? `<div class="deal-card-desc">${esc(d.description)}</div>` : ''}
          <div class="deal-card-meta">
            ${amount ? `<span class="deal-card-amount">${amount}</span>` : ''}
            ${date   ? `<span class="deal-card-date">${date}</span>`   : ''}
          </div>
        </div>
        <div class="deal-card-actions">
          <button class="btn-row-action" onclick="openFileModal(null,null,${d.id})" title="Files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <button class="btn-row-action btn-row-delete" onclick="deleteDeal(${d.id},'${esc(d.customer_name)}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  });
}

// ── Drag and drop ─────────────────────────────────────────────────────────────

let dragId = null;

function onCardDragStart(e) {
  dragId = parseInt(e.currentTarget.dataset.id);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.pipeline-col').forEach(c => c.classList.remove('drag-over'));
}

function initDragDrop() {
  document.querySelectorAll('.pipeline-col').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      col.classList.add('drag-over');
      e.dataTransfer.dropEffect = 'move';
    });

    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });

    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const newStatus = col.dataset.status;
      if (!dragId || !newStatus) return;

      const deal = dealsCurrentData.find(d => d.id === dragId);
      if (deal && deal.status === newStatus) { dragId = null; return; }

      try {
        await api(`/api/deals/${dragId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        });
        dragId = null;
        await loadDeals();
      } catch (err) {
        toast('Status update failed: ' + err.message, 'error');
        dragId = null;
      }
    });
  });
}

// ── Table view ────────────────────────────────────────────────────────────────

function renderDealTable(deals) {
  const tbody = document.getElementById('deals-tbody');
  const empty = document.getElementById('deals-empty');

  if (!deals.length) {
    tbody.innerHTML = '';
    document.getElementById('deals-table-wrap').hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = deals.map(d => {
    const store  = STORE_LABELS[d.store_id] || STORE_LABELS.custom;
    const status = DEAL_STATUS_STYLE[d.status] || { bg: '#f1f5f9', text: '#475569' };
    const pay    = PAYMENT_LABELS[d.payment_method] || d.payment_method || '—';
    const date   = d.deal_date ? fmtDate(d.deal_date) : '—';
    const amount = fmtTotal(d.amount, d.currency);

    return `<tr>
      <td>
        <div class="deal-customer">
          <span class="deal-name">${esc(d.customer_name)}</span>
          ${d.customer_email ? `<span class="deal-email">${esc(d.customer_email)}</span>` : ''}
        </div>
      </td>
      <td>${esc(d.description)}</td>
      <td class="col-date">
        <span class="store-badge" style="background:${store.color}1a;color:${store.color};border:1px solid ${store.color}40">
          ${store.label}
        </span>
      </td>
      <td class="col-date col-email">${date}</td>
      <td>${esc(pay)}</td>
      <td>
        <span class="status-badge" style="background:${status.bg};color:${status.text}">${d.status}</span>
      </td>
      <td class="col-total text-right">${amount}</td>
      <td class="col-actions">
        <button class="btn-row-action" onclick="openFileModal(null,null,${d.id})" title="Files">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <button class="btn-row-action" onclick="editDeal(${d.id})" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-row-action btn-row-delete" onclick="deleteDeal(${d.id},'${esc(d.customer_name)}')" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

// ── View toggle ───────────────────────────────────────────────────────────────

function setDealsView(view) {
  dealsCurrentView = view;
  document.getElementById('deals-view-pipeline').classList.toggle('active', view === 'pipeline');
  document.getElementById('deals-view-table').classList.toggle('active', view === 'table');
  renderDeals(dealsCurrentData);
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openDealModal(deal) {
  deal = deal || null;
  dealsEditingId = deal ? deal.id : null;
  const form = document.getElementById('deal-form');
  form.reset();

  document.getElementById('deal-modal-title').textContent = deal ? 'Edit Deal' : 'New Deal';

  if (deal) {
    Object.entries(deal).forEach(function(entry) {
      var k = entry[0], v = entry[1];
      var el = form.elements[k];
      if (el && v !== null && v !== undefined) el.value = v;
    });
  } else {
    var today = new Date().toISOString().slice(0, 10);
    form.elements['deal_date'].value = today;
  }

  document.getElementById('deal-modal').hidden = false;
}

function closeDealModal() {
  document.getElementById('deal-modal').hidden = true;
  dealsEditingId = null;
}

async function saveDeal() {
  const form = document.getElementById('deal-form');
  if (!form.reportValidity()) return;

  const data = Object.fromEntries(new FormData(form).entries());

  try {
    if (dealsEditingId) {
      await api(`/api/deals/${dealsEditingId}`, { method: 'PUT', body: JSON.stringify(data) });
      toast('Deal updated');
    } else {
      await api('/api/deals', { method: 'POST', body: JSON.stringify(data) });
      toast('Deal saved');
    }
    closeDealModal();
    await loadDeals();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

async function editDeal(id) {
  try {
    const { deals } = await api('/api/deals?limit=300');
    const deal = deals.find(d => d.id === id);
    if (deal) openDealModal(deal);
  } catch (err) {
    toast('Could not load deal: ' + err.message, 'error');
  }
}

async function deleteDeal(id, name) {
  if (!confirm(`Delete deal for "${name}"? This cannot be undone.`)) return;
  try {
    await api(`/api/deals/${id}`, { method: 'DELETE' });
    toast('Deal deleted');
    await loadDeals();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initDeals() {
  document.getElementById('new-deal-btn').addEventListener('click', () => openDealModal());

  let dealsSearchTimer;
  document.getElementById('deals-search-input').addEventListener('input', () => {
    clearTimeout(dealsSearchTimer);
    dealsSearchTimer = setTimeout(loadDeals, 280);
  });

  initDragDrop();
}
