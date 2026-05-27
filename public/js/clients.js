'use strict';

let clientsData  = [];
let clientsStats = {};
let clientFilter = { type: 'all', search: '' };
let _editClientId = null;

async function initClients() {
  await loadClients();
}

async function loadClients() {
  try {
    const p = new URLSearchParams();
    if (clientFilter.type !== 'all') p.set('type', clientFilter.type);
    if (clientFilter.search) p.set('search', clientFilter.search);
    const { clients, stats } = await api(`/api/clients?${p}`);
    clientsData  = clients || [];
    clientsStats = stats  || {};
    renderClientsStats();
    renderClientsTable();
  } catch (err) {
    toast('Klaida kraunant klientus: ' + err.message, 'error');
  }
}

const COUNTRY_FLAGS = {
  LT:'🇱🇹', DK:'🇩🇰', DE:'🇩🇪', SE:'🇸🇪', NO:'🇳🇴', FI:'🇫🇮', GB:'🇬🇧',
  US:'🇺🇸', FR:'🇫🇷', NL:'🇳🇱', BE:'🇧🇪', PL:'🇵🇱', EE:'🇪🇪', LV:'🇱🇻',
};

function renderClientsStats() {
  const el = document.getElementById('clients-stats-row');
  if (!el) return;
  const s = clientsStats;
  el.innerHTML = `
    <div class="prod-stat-card"><div class="prod-stat-label">Viso klientų</div><div class="prod-stat-value">${s.total||0}</div></div>
    <div class="prod-stat-card"><div class="prod-stat-label">B2B</div><div class="prod-stat-value" style="color:var(--purple)">${s.b2b||0}</div></div>
    <div class="prod-stat-card"><div class="prod-stat-label">B2C</div><div class="prod-stat-value">${s.b2c||0}</div></div>
    <div class="prod-stat-card"><div class="prod-stat-label">Šalys</div><div class="prod-stat-value">${s.countries||0}</div></div>
  `;
}

function renderClientsTable() {
  const tbody = document.getElementById('clients-tbody');
  const empty = document.getElementById('clients-empty');
  if (!tbody) return;

  if (!clientsData.length) {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = clientsData.map(c => {
    const flag = COUNTRY_FLAGS[c.country] || '';
    const typePill = c.type === 'b2b'
      ? `<span class="client-type-pill b2b">B2B</span>`
      : `<span class="client-type-pill b2c">B2C</span>`;
    const spent = c.total_spent > 0 ? `€${Math.round(c.total_spent).toLocaleString('lt-LT')}` : '—';
    const lastOrder = c.last_order ? new Date(c.last_order).toLocaleDateString('lt-LT') : '—';
    return `<tr class="client-row" onclick="openClientPanel(${c.id})">
      <td>${typePill}</td>
      <td>
        <div class="cli-name">${esc(c.name || '—')}</div>
        ${c.company ? `<div class="cli-company">${esc(c.company)}</div>` : ''}
      </td>
      <td class="col-email">${esc(c.email || '—')}</td>
      <td>${flag} ${esc(c.country || '—')}</td>
      <td class="text-right">${c.order_count}</td>
      <td class="text-right">${spent}</td>
      <td>${lastOrder}</td>
      <td class="text-right" style="white-space:nowrap" onclick="event.stopPropagation()">
        <button class="btn-sf" onclick="openCreateInvoiceForClient(${c.id})" title="Sukurti sąskaitą">SF</button>
        <button class="btn-sf" onclick="openEditClient(${c.id})" title="Redaguoti">✎</button>
        <button class="btn-delete" onclick="deleteClient(${c.id})" title="Ištrinti">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function setClientType(type) {
  clientFilter.type = type;
  document.querySelectorAll('.cli-filter-type').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  loadClients();
}

let _cliSearchTimer;
function searchClients(val) {
  clearTimeout(_cliSearchTimer);
  _cliSearchTimer = setTimeout(() => {
    clientFilter.search = val;
    loadClients();
  }, 300);
}

// ── Client panel ──────────────────────────────────────────────────────────────

function openClientPanel(id) {
  const panel   = document.getElementById('client-panel');
  const overlay = document.getElementById('client-overlay');
  const body    = document.getElementById('cp-body');
  const c = clientsData.find(x => x.id === id);
  if (!c) return;

  document.getElementById('cp-avatar').textContent = (c.name||'?').charAt(0).toUpperCase();
  document.getElementById('cp-name').textContent   = c.name || '—';
  document.getElementById('cp-email').textContent  = c.email || '';

  body.innerHTML = '<div class="panel-loading">Kraunama…</div>';
  panel.classList.add('open');
  overlay.classList.add('visible');

  api(`/api/clients/${id}/orders`).then(({ client: cl, orders }) => {
    const flag = COUNTRY_FLAGS[cl.country] || '';
    const detailHtml = `
      <div class="cli-panel-details">
        ${cl.company    ? `<div class="cli-detail-row"><span>Įmonė</span><strong>${esc(cl.company)}</strong></div>` : ''}
        ${cl.email      ? `<div class="cli-detail-row"><span>El. paštas</span><strong>${esc(cl.email)}</strong></div>` : ''}
        ${cl.phone      ? `<div class="cli-detail-row"><span>Tel.</span><strong>${esc(cl.phone)}</strong></div>` : ''}
        ${cl.country    ? `<div class="cli-detail-row"><span>Šalis</span><strong>${flag} ${esc(cl.country)}</strong></div>` : ''}
        ${cl.vat_code   ? `<div class="cli-detail-row"><span>PVM</span><strong>${esc(cl.vat_code)}</strong></div>` : ''}
        ${cl.address    ? `<div class="cli-detail-row"><span>Adresas</span><strong>${esc(cl.address)}</strong></div>` : ''}
        ${cl.notes      ? `<div class="cli-panel-notes">${esc(cl.notes)}</div>` : ''}
      </div>
      <div class="cli-panel-spent">
        <div>Užsakymai: <strong>${cl.order_count}</strong></div>
        <div>Išleista: <strong>€${Math.round(cl.total_spent||0).toLocaleString('lt-LT')}</strong></div>
      </div>
      <button class="btn-primary" style="width:100%;margin-bottom:12px" onclick="openCreateInvoiceForClient(${cl.id});closeClientPanel()">Sukurti sąskaitą</button>
      <div class="cli-orders-label">Paskutiniai užsakymai</div>
      ${orders.length ? `<div class="cli-orders-list">
        ${orders.map(o => {
          const STORES = { bloom_lt:'LT', mossbloom_dk:'DK', mossbloom_de:'DE', b2b:'B2B' };
          const storeLabel = STORES[o.store_id] || o.store_id;
          const date = new Date(o.date_created).toLocaleDateString('lt-LT');
          return `<div class="cli-order-row">
            <span class="store-badge store-badge-${(o.store_id||'').replace('bloom_','').replace('mossbloom_','')}">${storeLabel}</span>
            <span>#${o.order_id}</span>
            <span>${esc(o.status)}</span>
            <span class="text-right">${o.currency} ${Number(o.total||0).toFixed(2)}</span>
            <span>${date}</span>
          </div>`;
        }).join('')}
      </div>` : '<div class="panel-loading" style="color:var(--text-muted)">Nėra užsakymų</div>'}
    `;
    body.innerHTML = detailHtml;
  }).catch(() => {
    body.innerHTML = '<div class="panel-loading" style="color:var(--red)">Klaida kraunant</div>';
  });
}

function closeClientPanel() {
  document.getElementById('client-panel').classList.remove('open');
  document.getElementById('client-overlay').classList.remove('visible');
}

function openCreateInvoiceForClient(id) {
  const c = clientsData.find(x => x.id === id);
  if (!c) return;
  switchView('invoices');
  openCreateInvoice({
    buyer_name: c.company || c.name || '',
    buyer_code: c.company_code || '',
    buyer_vat:  c.vat_code || '',
    buyer_addr: c.address || '',
  });
}

// ── Create / Edit Client Modal ────────────────────────────────────────────────

function openCreateClient() {
  _editClientId = null;
  document.getElementById('cli-modal-title').textContent = 'Naujas klientas';
  ['cli-type','cli-name','cli-company','cli-email','cli-phone',
   'cli-country','cli-code','cli-vat','cli-addr','cli-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'cli-type' ? 'b2c' : '';
  });
  document.getElementById('cli-modal').hidden = false;
}

function openEditClient(id) {
  const c = clientsData.find(x => x.id === id);
  if (!c) return;
  _editClientId = id;
  document.getElementById('cli-modal-title').textContent = 'Redaguoti klientą';
  document.getElementById('cli-type').value    = c.type || 'b2c';
  document.getElementById('cli-name').value    = c.name || '';
  document.getElementById('cli-company').value = c.company || '';
  document.getElementById('cli-email').value   = c.email || '';
  document.getElementById('cli-phone').value   = c.phone || '';
  document.getElementById('cli-country').value = c.country || '';
  document.getElementById('cli-code').value    = c.company_code || '';
  document.getElementById('cli-vat').value     = c.vat_code || '';
  document.getElementById('cli-addr').value    = c.address || '';
  document.getElementById('cli-notes').value   = c.notes || '';
  document.getElementById('cli-modal').hidden  = false;
}

function closeCreateClient() {
  document.getElementById('cli-modal').hidden = true;
  _editClientId = null;
}

async function saveClient() {
  const name = document.getElementById('cli-name').value.trim();
  if (!name) { toast('Įveskite vardą', 'error'); return; }
  const data = {
    type:         document.getElementById('cli-type').value,
    name,
    company:      document.getElementById('cli-company').value,
    email:        document.getElementById('cli-email').value || null,
    phone:        document.getElementById('cli-phone').value,
    country:      document.getElementById('cli-country').value,
    company_code: document.getElementById('cli-code').value,
    vat_code:     document.getElementById('cli-vat').value,
    address:      document.getElementById('cli-addr').value,
    notes:        document.getElementById('cli-notes').value,
  };
  try {
    if (_editClientId) {
      await api(`/api/clients/${_editClientId}`, { method: 'PATCH', body: JSON.stringify(data) });
      toast('Klientas atnaujintas');
    } else {
      await api('/api/clients', { method: 'POST', body: JSON.stringify(data) });
      toast('Klientas sukurtas');
    }
    closeCreateClient();
    await loadClients();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

async function deleteClient(id) {
  if (!confirm('Ištrinti klientą?')) return;
  try {
    await api(`/api/clients/${id}`, { method: 'DELETE' });
    toast('Klientas ištrintas');
    await loadClients();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}
