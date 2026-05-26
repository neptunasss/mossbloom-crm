'use strict';

const STORES = {
  bloom_lt:     { color: '#2ea043', name: 'bloom.lt',     label: 'LT' },
  mossbloom_dk: { color: '#1f6feb', name: 'mossbloom.dk', label: 'DK' },
  mossbloom_de: { color: '#da3633', name: 'mossbloom.de', label: 'DE' },
  b2b:          { color: '#7c3aed', name: 'B2B',          label: 'B2B' },
};

const STATUS_STYLE = {
  completed:  { bg: '#dcfce7', text: '#166534' },
  processing: { bg: '#dbeafe', text: '#1e40af' },
  pending:    { bg: '#fef9c3', text: '#854d0e' },
  'on-hold':  { bg: '#ffedd5', text: '#9a3412' },
  cancelled:  { bg: '#fee2e2', text: '#991b1b' },
  refunded:   { bg: '#ede9fe', text: '#5b21b6' },
  failed:     { bg: '#fee2e2', text: '#991b1b' },
};

const PROD_STATUS = {
  started: { bg: '#fef3c7', text: '#92400e', icon: '▶' },
  ready:   { bg: '#dcfce7', text: '#166534', icon: '✓' },
};

const state = {
  filters: { store: 'all', status: 'all', search: '' },
  syncing: false,
  currentView: 'orders',
};

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await Promise.all([loadSyncStatus()]);
  setupListeners();
  initDeals();
  initAccounting();
  switchView('accounting');
});

async function checkAuth() {
  try {
    const data = await api('/api/auth/status');
    if (!data.authenticated) return redirect('/login.html');
    document.getElementById('user-name').textContent = data.username;
    document.getElementById('user-avatar').textContent = data.username.charAt(0).toUpperCase();
  } catch {
    redirect('/login.html');
  }
}

// ── View switching ─────────────────────────────────────────────────────────────

function switchView(view) {
  state.currentView = view;

  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.getElementById(`view-${view}`).hidden = false;

  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.add('active');

  const titles = { orders: 'Orders', deals: 'Sandoriai', accounting: 'Dashboard', products: 'Products', calculator: 'Kainodara' };
  document.getElementById('page-title').textContent = titles[view] || view;
  document.body.classList.toggle('acct-mode', view === 'accounting');

  document.getElementById('sync-btn').hidden     = view !== 'orders';
  document.getElementById('new-b2b-btn').hidden  = view !== 'orders';
  document.getElementById('new-deal-btn').hidden = view !== 'deals';
  document.getElementById('header-count').hidden = view === 'calculator';

  if (view === 'orders')     loadOrders();
  if (view === 'deals')      loadDeals();
  if (view === 'accounting') loadAccounting();
  if (view === 'calculator') initCalculator();

  // Close sidebar on mobile after nav click
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

// ── Orders ────────────────────────────────────────────────────────────────────

async function loadOrders() {
  setLoading('orders', true);
  try {
    const p = new URLSearchParams({ limit: 300 });
    if (state.filters.store !== 'all')  p.set('store',  state.filters.store);
    if (state.filters.status !== 'all') p.set('status', state.filters.status);
    if (state.filters.search)           p.set('search', state.filters.search);

    const { orders } = await api(`/api/orders?${p}`);
    renderOrders(orders);
  } catch (err) {
    toast('Failed to load orders: ' + err.message, 'error');
  } finally {
    setLoading('orders', false);
  }
}

function renderOrders(orders) {
  const tbody = document.getElementById('orders-tbody');
  const empty = document.getElementById('orders-empty');
  const badge = document.getElementById('header-count');

  badge.textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;

  if (!orders.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const SOURCE_OPTS = ['', 'Meta', 'Google', 'Organic', 'Referral', 'Repeat', 'B2B outbound', 'Other'];

  tbody.innerHTML = orders.map(o => {
    const isB2b  = !!o.is_b2b;
    const store  = STORES[o.store_id] || { color: '#888', label: '?', name: o.store_id };
    const status = STATUS_STYLE[o.status] || { bg: '#f1f5f9', text: '#475569' };
    const prod   = PROD_STATUS[o.producer_status];
    const date   = fmtDate(o.date_created);
    const total  = fmtTotal(o.total, o.currency);
    const hasEmail = !!o.customer_email;

    const customerCell = hasEmail
      ? `<span class="customer-link" data-email="${esc(o.customer_email)}">${esc(o.customer_name || '—')}</span>`
      : esc(o.customer_name || '—');

    const ps = o.producer_status || '';
    const prodBadge = isB2b
      ? `<span class="prod-none">—</span>`
      : prod
        ? `<span class="prod-badge" style="background:${prod.bg};color:${prod.text};cursor:pointer" title="Keisti statusą" onclick="cycleProducerStatus('${esc(o.store_id)}',${o.order_id},'${ps}')">${prod.icon} ${ps}</span>`
        : `<span class="prod-none" style="cursor:pointer" title="Pradėti gamybą" onclick="cycleProducerStatus('${esc(o.store_id)}',${o.order_id},'')">—</span>`;

    const orderNum = isB2b
      ? `<span class="b2b-order-badge">B2B</span>`
      : `#${o.order_id}`;

    const storeIdEsc = esc(o.store_id);
    const orderIdEsc = esc(String(o.order_id));
    const curSrc = o.source || '';
    const sourceSelect = `<select class="source-select" title="Šaltinis"
      onchange="setOrderSource('${storeIdEsc}','${orderIdEsc}',this.value)">
      ${SOURCE_OPTS.map(s => `<option value="${s}"${s === curSrc ? ' selected' : ''}>${s || '—'}</option>`).join('')}
    </select>`;

    return `<tr class="${isB2b ? 'b2b-row' : ''}">
      <td style="border-left:3px solid ${store.color};padding-left:11px">
        <span class="store-badge" style="background:${store.color}1a;color:${store.color};border:1px solid ${store.color}40">
          ${store.label}
        </span>
      </td>
      <td class="col-order">${orderNum}</td>
      <td class="col-customer">${customerCell}</td>
      <td class="col-email">${esc(o.customer_email || (isB2b && o.description ? o.description : ''))}</td>
      <td class="col-date">${date}</td>
      <td><span class="status-badge" style="background:${status.bg};color:${status.text}">${esc(o.status)}</span></td>
      <td>${prodBadge}</td>
      <td class="col-source">${sourceSelect}</td>
      <td class="col-total text-right">${total}</td>
      <td class="col-actions">
        <button class="btn-file" onclick="openFileModal('${esc(o.store_id)}',${o.order_id},null)" title="Files">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  // Click-to-open customer panel
  tbody.querySelectorAll('.customer-link').forEach(el => {
    el.addEventListener('click', () => openCustomerPanel(el.dataset.email));
  });
}

// ── B2B Order Modal ───────────────────────────────────────────────────────────

function openB2bModal() {
  const form = document.getElementById('b2b-form');
  form.reset();
  form.elements['order_date'].value = new Date().toISOString().slice(0, 10);
  document.getElementById('b2b-modal').hidden = false;
}

function closeB2bModal() {
  document.getElementById('b2b-modal').hidden = true;
}

async function saveB2bOrder() {
  const form = document.getElementById('b2b-form');
  if (!form.reportValidity()) return;
  const fd   = new FormData(form);
  const data = Object.fromEntries(fd.entries());
  data.has_invoice = form.elements['has_invoice'].checked ? 1 : 0;
  try {
    await api('/api/orders/b2b', { method: 'POST', body: JSON.stringify(data) });
    toast('B2B užsakymas išsaugotas');
    closeB2bModal();
    await loadOrders();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function syncOrders() {
  if (state.syncing) return;
  state.syncing = true;

  const btn   = document.getElementById('sync-btn');
  const label = document.getElementById('sync-label');
  btn.disabled = true;
  btn.classList.add('syncing');
  label.textContent = 'Syncing…';

  try {
    const { results } = await api('/api/orders/sync', { method: 'POST' });
    const lines = results.map(r =>
      r.status === 'success'  ? `${r.name}: ${r.count} orders` :
      r.status === 'skipped' ? `${r.name}: not configured` :
      `${r.name}: ${r.error}`
    );
    toast(lines.join('\n'));
    await Promise.all([loadSyncStatus(), loadOrders()]);
  } catch (err) {
    toast('Sync failed: ' + err.message, 'error');
  } finally {
    state.syncing = false;
    btn.disabled = false;
    btn.classList.remove('syncing');
    label.textContent = 'Sync';
  }
}

// ── Sync status (sidebar) ─────────────────────────────────────────────────────

async function loadSyncStatus() {
  try {
    const statuses = await api('/api/orders/sync-status');
    renderStoreStatus(statuses);
  } catch {}
}

function renderStoreStatus(statuses) {
  const container = document.getElementById('store-status');
  container.innerHTML = statuses.map(s => {
    const store = STORES[s.store] || {};
    const icon  = !s.configured ? '○' : s.lastSyncStatus === 'success' ? '✓' : s.lastSyncStatus === 'error' ? '!' : '○';
    const cls   = !s.configured ? 'unconfigured' : s.lastSyncStatus || 'unconfigured';
    const tip   = s.lastSync ? `Last sync: ${timeAgo(s.lastSync)}` : 'Never synced';

    return `<div class="store-stat" title="${esc(tip)}">
      <div class="store-stat-dot" style="background:${store.color || '#484f58'}"></div>
      <div class="store-stat-info">
        <span class="store-stat-name">${esc(s.name)}</span>
        <span class="store-stat-count">${s.orderCount} order${s.orderCount !== 1 ? 's' : ''}</span>
      </div>
      <span class="store-stat-icon ${esc(cls)}">${icon}</span>
    </div>`;
  }).join('');
}

// ── Customer Panel ────────────────────────────────────────────────────────────

async function openCustomerPanel(email) {
  const panel   = document.getElementById('customer-panel');
  const overlay = document.getElementById('customer-overlay');
  const body    = document.getElementById('panel-body');

  document.getElementById('panel-name').textContent  = '…';
  document.getElementById('panel-email').textContent = email;
  document.getElementById('panel-avatar').textContent = email.charAt(0).toUpperCase();
  body.innerHTML = '<div class="panel-loading">Loading…</div>';

  panel.classList.add('open');
  overlay.classList.add('visible');

  try {
    const data = await api(`/api/customers/${encodeURIComponent(email)}`);
    renderCustomerPanel(data);
  } catch (err) {
    body.innerHTML = `<div class="panel-loading" style="color:#da3633">Failed to load: ${esc(err.message)}</div>`;
  }
}

function renderCustomerPanel(data) {
  document.getElementById('panel-name').textContent   = data.name;
  document.getElementById('panel-email').textContent  = data.email;
  document.getElementById('panel-avatar').textContent = (data.name || data.email).charAt(0).toUpperCase();

  const spendLines = Object.entries(data.spendByCurrency || {})
    .map(([cur, amt]) => fmtTotal(amt, cur))
    .join(' + ') || '—';

  const storeLabels = (data.stores || []).map(sid => {
    const s = STORES[sid];
    return s ? `<span class="store-badge" style="background:${s.color}1a;color:${s.color};border:1px solid ${s.color}40">${s.label}</span>` : sid;
  }).join(' ');

  const orderRows = (data.orders || []).map(o => {
    const store  = STORES[o.store_id] || { color: '#888', label: '?' };
    const status = STATUS_STYLE[o.status] || { bg: '#f1f5f9', text: '#475569' };
    return `<div class="panel-order-row">
      <span class="store-badge" style="background:${store.color}1a;color:${store.color};border:1px solid ${store.color}40;margin-right:6px">${store.label}</span>
      <span class="panel-order-num">#${o.order_id}</span>
      <span class="panel-order-date">${fmtDate(o.date_created)}</span>
      <span class="status-badge" style="background:${status.bg};color:${status.text};margin-left:auto">${esc(o.status)}</span>
      <span class="panel-order-total">${fmtTotal(o.total, o.currency)}</span>
    </div>`;
  }).join('');

  const dealRows = (data.deals || []).map(d => {
    const status = { pending:'#fef9c3|#854d0e', processing:'#dbeafe|#1e40af', completed:'#dcfce7|#166534', cancelled:'#fee2e2|#991b1b' }[d.status] || '#f1f5f9|#475569';
    const [bg, text] = status.split('|');
    return `<div class="panel-order-row">
      <span style="font-size:11px;color:var(--text-muted);margin-right:6px">DEAL</span>
      <span class="panel-order-num">${esc(d.description)}</span>
      <span class="panel-order-date">${d.deal_date ? fmtDate(d.deal_date) : '—'}</span>
      <span class="status-badge" style="background:${bg};color:${text};margin-left:auto">${esc(d.status)}</span>
      <span class="panel-order-total">${fmtTotal(d.amount, d.currency)}</span>
    </div>`;
  }).join('');

  document.getElementById('panel-body').innerHTML = `
    <div class="panel-stats">
      <div class="panel-stat">
        <div class="panel-stat-val">${data.orders.length + data.deals.length}</div>
        <div class="panel-stat-lbl">Total orders</div>
      </div>
      <div class="panel-stat">
        <div class="panel-stat-val">${spendLines}</div>
        <div class="panel-stat-lbl">Total spent</div>
      </div>
    </div>

    ${storeLabels ? `<div style="padding:0 16px 12px;display:flex;gap:4px;flex-wrap:wrap">${storeLabels}</div>` : ''}

    ${data.orders.length ? `
    <div class="panel-section-title">WooCommerce Orders (${data.orders.length})</div>
    <div class="panel-orders-list">${orderRows}</div>` : ''}

    ${data.deals.length ? `
    <div class="panel-section-title">Custom Deals (${data.deals.length})</div>
    <div class="panel-orders-list">${dealRows}</div>` : ''}

    ${!data.orders.length && !data.deals.length ? `
    <div style="padding:32px;text-align:center;color:var(--text-muted)">No order history found</div>` : ''}
  `;
}

function closeCustomerPanel() {
  document.getElementById('customer-panel').classList.remove('open');
  document.getElementById('customer-overlay').classList.remove('visible');
}

// ── Listeners ─────────────────────────────────────────────────────────────────

function setupListeners() {
  // Nav view switching
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      switchView(item.dataset.view);
    });
  });

  document.getElementById('sync-btn').addEventListener('click', syncOrders);
  document.getElementById('new-b2b-btn').addEventListener('click', openB2bModal);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    redirect('/login.html');
  });

  // Mobile sidebar
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('visible');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  });

  // Customer panel close
  document.getElementById('close-panel-btn').addEventListener('click', closeCustomerPanel);
  document.getElementById('customer-overlay').addEventListener('click', closeCustomerPanel);

  // Store tabs
  document.querySelectorAll('[data-store]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-store]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filters.store = btn.dataset.store;
      loadOrders();
    });
  });

  // Status filter
  document.getElementById('status-filter').addEventListener('change', e => {
    state.filters.status = e.target.value;
    loadOrders();
  });

  // Search (debounced)
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = e.target.value.trim();
      loadOrders();
    }, 280);
  });
}

// ── Shared helpers (used by deals.js and calculator.js) ───────────────────────

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) { redirect('/login.html'); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function setLoading(view, on) {
  const loadEl = document.getElementById(`${view}-loading`);
  const wrapEl = document.getElementById(`${view}-table-wrap`);
  if (loadEl) loadEl.hidden = !on;
  if (wrapEl) wrapEl.style.opacity = on ? '0.55' : '1';
}

let toastTimer;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type === 'error' ? 'error' : ''} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

function redirect(path) { window.location.href = path; }

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtTotal(total, currency) {
  const n   = parseFloat(total || 0).toFixed(2);
  const sym = { EUR: '€', DKK: 'kr', USD: '$', GBP: '£' }[currency] || (currency ? currency + ' ' : '');
  return currency === 'DKK' ? `${n} kr` : `${sym}${n}`;
}

function timeAgo(str) {
  const ms   = Date.now() - new Date(str).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Lead source tagging ───────────────────────────────────────────────────────

async function setOrderSource(storeId, orderId, source) {
  try {
    await api(`/api/orders/${encodeURIComponent(storeId)}/${encodeURIComponent(orderId)}/source`, {
      method: 'PUT',
      body: JSON.stringify({ source }),
    });
    if (source) toast(`Šaltinis: ${source}`);
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Production status ─────────────────────────────────────────────────────────

async function cycleProducerStatus(storeId, orderId, current) {
  const next = { '': 'started', started: 'ready', ready: '' }[current] ?? 'started';
  try {
    await api(`/api/orders/${encodeURIComponent(storeId)}/${orderId}/producer-status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    await loadOrders();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── File Modal ────────────────────────────────────────────────────────────────

let fileCtx = { storeId: null, orderId: null, dealId: null, accountingId: null };

async function openFileModal(storeId, orderId, dealId, accountingId) {
  fileCtx = { storeId, orderId, dealId, accountingId: accountingId || null };
  document.getElementById('file-modal').hidden = false;
  document.getElementById('file-modal-body').innerHTML = '<div class="file-loading">Loading…</div>';
  await refreshFileList();
}

function closeFileModal() {
  document.getElementById('file-modal').hidden = true;
  fileCtx = { storeId: null, orderId: null, dealId: null, accountingId: null };
}

async function refreshFileList() {
  const p = new URLSearchParams();
  if (fileCtx.storeId)      p.set('store_id',      fileCtx.storeId);
  if (fileCtx.orderId)      p.set('order_id',      fileCtx.orderId);
  if (fileCtx.dealId)       p.set('deal_id',       fileCtx.dealId);
  if (fileCtx.accountingId) p.set('accounting_id', fileCtx.accountingId);

  try {
    const { files } = await api(`/api/files?${p}`);
    renderFileList(files);
  } catch (err) {
    document.getElementById('file-modal-body').innerHTML =
      `<div class="file-loading" style="color:#da3633">Error: ${esc(err.message)}</div>`;
  }
}

function renderFileList(files) {
  const body = document.getElementById('file-modal-body');
  if (!files.length) {
    body.innerHTML = '<div class="file-empty">No files attached yet.</div>';
    return;
  }
  body.innerHTML = files.map(f => {
    const size  = f.file_size > 1024 * 1024
      ? `${(f.file_size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(f.file_size / 1024)} KB`;
    const isImg = f.mime_type && f.mime_type.startsWith('image/');
    const icon  = f.mime_type === 'application/pdf' ? '📄' : isImg ? '🖼' : '📎';
    return `<div class="file-item">
      <span class="file-icon">${icon}</span>
      <div class="file-info">
        <a class="file-name" href="/api/files/${f.id}" target="_blank" rel="noopener">${esc(f.original_name)}</a>
        <span class="file-size">${size}</span>
      </div>
      <button class="btn-row-action btn-row-delete" onclick="deleteFile(${f.id})" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
      </button>
    </div>`;
  }).join('');
}

async function uploadFile(input) {
  if (!input.files.length) return;
  const formData = new FormData();
  formData.append('file', input.files[0]);
  if (fileCtx.storeId)      formData.append('store_id',      fileCtx.storeId);
  if (fileCtx.orderId)      formData.append('order_id',      fileCtx.orderId);
  if (fileCtx.dealId)       formData.append('deal_id',       fileCtx.dealId);
  if (fileCtx.accountingId) formData.append('accounting_id', fileCtx.accountingId);

  try {
    const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
    if (res.status === 401) { redirect('/login.html'); return; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    await refreshFileList();
    toast('File uploaded');
  } catch (err) {
    toast('Upload failed: ' + err.message, 'error');
  }
  input.value = '';
}

async function deleteFile(id) {
  if (!confirm('Delete this file?')) return;
  try {
    await api(`/api/files/${id}`, { method: 'DELETE' });
    await refreshFileList();
    toast('File deleted');
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}
