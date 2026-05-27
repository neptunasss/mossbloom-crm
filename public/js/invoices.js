'use strict';

let invoicesData   = [];
let invoiceFilter  = { status: 'all', search: '' };
let invLineCount   = 0;

async function initInvoices() {
  await loadInvoices();
}

async function loadInvoices() {
  try {
    const p = new URLSearchParams();
    if (invoiceFilter.status !== 'all') p.set('status', invoiceFilter.status);
    if (invoiceFilter.search) p.set('search', invoiceFilter.search);
    const { invoices } = await api(`/api/invoices?${p}`);
    invoicesData = invoices || [];
    renderInvoicesList();
  } catch (err) {
    toast('Klaida kraunant sąskaitas: ' + err.message, 'error');
  }
}

const INV_STATUS = {
  draft: { label: 'Juodraštis', bg: '#f1f5f9', text: '#64748b' },
  sent:  { label: 'Išsiųsta',   bg: '#dbeafe', text: '#1e40af' },
  paid:  { label: 'Apmokėta',   bg: '#dcfce7', text: '#166534' },
};

function renderInvoicesList() {
  const tbody = document.getElementById('invoices-tbody');
  const empty = document.getElementById('invoices-empty');
  if (!tbody) return;

  if (!invoicesData.length) {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = invoicesData.map(inv => {
    const st = INV_STATUS[inv.status] || INV_STATUS.draft;
    const date = inv.issue_date ? new Date(inv.issue_date).toLocaleDateString('lt-LT') : '—';
    const due  = inv.due_date  ? new Date(inv.due_date).toLocaleDateString('lt-LT')  : '—';
    return `<tr>
      <td><span class="inv-number">${esc(inv.invoice_number)}</span></td>
      <td>${date}</td>
      <td>${due}</td>
      <td>${esc(inv.buyer_name || '—')}</td>
      <td class="text-right">€${Number(inv.total||0).toFixed(2)}</td>
      <td><span class="status-badge" style="background:${st.bg};color:${st.text}">${st.label}</span></td>
      <td class="text-right" style="white-space:nowrap">
        <button class="btn-sf" onclick="viewInvoiceHtml(${inv.id})" title="Peržiūrėti">HTML</button>
        <button class="btn-sf" onclick="downloadInvoicePdf(${inv.id},'${esc(inv.invoice_number)}')" title="PDF">PDF</button>
        ${inv.status !== 'paid' ? `<button class="btn-sf" style="color:var(--green-deep)" onclick="markInvoicePaid(${inv.id})" title="Pažymėti apmokėta">✓</button>` : ''}
        <button class="btn-delete" onclick="deleteInvoice(${inv.id})" title="Ištrinti">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function setInvoiceStatus(status) {
  invoiceFilter.status = status;
  document.querySelectorAll('.inv-filter-status').forEach(b =>
    b.classList.toggle('active', b.dataset.status === status)
  );
  loadInvoices();
}

let _invSearchTimer;
function searchInvoices(val) {
  clearTimeout(_invSearchTimer);
  _invSearchTimer = setTimeout(() => {
    invoiceFilter.search = val;
    loadInvoices();
  }, 300);
}

function viewInvoiceHtml(id) {
  window.open(`/api/invoices/${id}/html`, '_blank');
}

async function downloadInvoicePdf(id, num) {
  try {
    const a = document.createElement('a');
    a.href = `/api/invoices/${id}/pdf`;
    a.download = `${num}.pdf`;
    a.click();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

async function markInvoicePaid(id) {
  try {
    await api(`/api/invoices/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) });
    toast('Pažymėta apmokėta');
    await loadInvoices();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

async function deleteInvoice(id) {
  if (!confirm('Ištrinti sąskaitą?')) return;
  try {
    await api(`/api/invoices/${id}`, { method: 'DELETE' });
    toast('Sąskaita ištrinta');
    await loadInvoices();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Create Invoice Modal ──────────────────────────────────────────────────────

function openCreateInvoice(prefill) {
  invLineCount = 0;
  document.getElementById('inv-lines-tbody').innerHTML = '';
  updateInvoiceTotals();

  // Reset dates
  const today = new Date().toISOString().slice(0, 10);
  const due   = new Date(); due.setDate(due.getDate() + 14);
  document.getElementById('inv-issue-date').value = today;
  document.getElementById('inv-due-date').value   = due.toISOString().slice(0, 10);

  // Reset buyer
  document.getElementById('inv-b-name').value = prefill?.buyer_name || '';
  document.getElementById('inv-b-code').value = prefill?.buyer_code || '';
  document.getElementById('inv-b-vat').value  = prefill?.buyer_vat  || '';
  document.getElementById('inv-b-addr').value = prefill?.buyer_addr || '';
  document.getElementById('inv-client-search').value = '';
  document.getElementById('inv-client-suggestions').innerHTML = '';

  // Add one blank line
  addInvoiceLine(prefill?.item_name || '', prefill?.item_price || '');

  document.getElementById('inv-modal').hidden = false;
}

function closeCreateInvoice() {
  document.getElementById('inv-modal').hidden = true;
}

function addInvoiceLine(name = '', price = '') {
  invLineCount++;
  const n = invLineCount;
  const tr = document.createElement('tr');
  tr.id = `inv-line-${n}`;
  tr.innerHTML = `
    <td>
      <input type="text" class="inv-line-name" value="${esc(name)}" placeholder="Pavadinimas" style="width:100%"
        oninput="updateInvoiceTotals()" list="inv-products-list">
    </td>
    <td><input type="text" class="inv-line-unit" value="vnt." style="width:100%" oninput="updateInvoiceTotals()"></td>
    <td><input type="number" class="inv-line-qty" value="1" min="0.01" step="0.01" style="width:100%" oninput="updateInvoiceTotals()"></td>
    <td><input type="number" class="inv-line-price" value="${price}" min="0" step="0.01" style="width:100%" oninput="updateInvoiceTotals()"></td>
    <td class="r inv-line-sum">€0.00</td>
    <td><button class="btn-delete" onclick="removeInvoiceLine(${n})" style="padding:2px 4px">✕</button></td>
  `;
  document.getElementById('inv-lines-tbody').appendChild(tr);
  updateInvoiceTotals();

  // Populate products datalist
  if (!document.getElementById('inv-products-list')) {
    const dl = document.createElement('datalist');
    dl.id = 'inv-products-list';
    if (typeof productsData !== 'undefined') {
      for (const p of productsData) {
        const opt = document.createElement('option');
        opt.value = p.name;
        dl.appendChild(opt);
      }
    }
    document.body.appendChild(dl);
  }
}

function removeInvoiceLine(n) {
  const el = document.getElementById(`inv-line-${n}`);
  if (el) el.remove();
  updateInvoiceTotals();
}

function updateInvoiceTotals() {
  let sub = 0;
  document.querySelectorAll('#inv-lines-tbody tr').forEach(tr => {
    const qty   = parseFloat(tr.querySelector('.inv-line-qty')?.value  || 1);
    const price = parseFloat(tr.querySelector('.inv-line-price')?.value || 0);
    const line  = Math.round(qty * price * 100) / 100;
    const sumEl = tr.querySelector('.inv-line-sum');
    if (sumEl) sumEl.textContent = '€' + line.toFixed(2);
    sub += line;
  });
  const vat   = Math.round(sub * 0.21 * 100) / 100;
  const total = Math.round((sub + vat) * 100) / 100;
  const el = id => document.getElementById(id);
  if (el('inv-preview-sub'))   el('inv-preview-sub').textContent   = '€' + sub.toFixed(2);
  if (el('inv-preview-vat'))   el('inv-preview-vat').textContent   = '€' + vat.toFixed(2);
  if (el('inv-preview-total')) el('inv-preview-total').textContent = '€' + total.toFixed(2);
}

async function saveInvoice() {
  const buyerName = document.getElementById('inv-b-name').value.trim();
  if (!buyerName) { toast('Įveskite pirkėjo pavadinimą', 'error'); return; }

  const lines = [];
  document.querySelectorAll('#inv-lines-tbody tr').forEach(tr => {
    lines.push({
      name:  tr.querySelector('.inv-line-name')?.value.trim()  || '',
      unit:  tr.querySelector('.inv-line-unit')?.value.trim()  || 'vnt.',
      qty:   parseFloat(tr.querySelector('.inv-line-qty')?.value  || 1),
      price: parseFloat(tr.querySelector('.inv-line-price')?.value || 0),
    });
  });

  const data = {
    seller_name:    document.getElementById('inv-s-name').value,
    seller_code:    document.getElementById('inv-s-code').value,
    seller_vat:     document.getElementById('inv-s-vat').value,
    seller_bank:    document.getElementById('inv-s-bank').value,
    seller_iban:    document.getElementById('inv-s-iban').value,
    seller_phone:   document.getElementById('inv-s-phone').value,
    seller_address: document.getElementById('inv-s-addr').value,
    seller_email:   document.getElementById('inv-s-email').value,
    seller_signee:  document.getElementById('inv-s-signee').value,
    buyer_name:     buyerName,
    buyer_code:     document.getElementById('inv-b-code').value,
    buyer_vat:      document.getElementById('inv-b-vat').value,
    buyer_address:  document.getElementById('inv-b-addr').value,
    issue_date:     document.getElementById('inv-issue-date').value,
    due_date:       document.getElementById('inv-due-date').value,
    line_items:     lines,
  };

  try {
    const { id } = await api('/api/invoices', { method: 'POST', body: JSON.stringify(data) });
    toast('Sąskaita sukurta');
    closeCreateInvoice();
    await loadInvoices();
    viewInvoiceHtml(id);
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Client autocomplete in invoice modal ─────────────────────────────────────

let _clientsCache = null;

async function searchInvoiceClient(val) {
  const box = document.getElementById('inv-client-suggestions');
  if (!val.trim()) { box.innerHTML = ''; return; }

  if (!_clientsCache) {
    try {
      const { clients } = await api('/api/clients');
      _clientsCache = clients;
    } catch { return; }
  }

  const matches = (_clientsCache || []).filter(c =>
    (c.name || '').toLowerCase().includes(val.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(val.toLowerCase()) ||
    (c.company || '').toLowerCase().includes(val.toLowerCase())
  ).slice(0, 6);

  box.innerHTML = matches.map(c => `
    <div class="client-suggestion-item" onclick="selectInvoiceClient(${c.id})">
      <span class="client-type-pill ${c.type}">${c.type.toUpperCase()}</span>
      ${esc(c.name)}${c.company ? ` · <em>${esc(c.company)}</em>` : ''}
      ${c.email ? `<span style="color:var(--text-muted);font-size:11px"> ${esc(c.email)}</span>` : ''}
    </div>`).join('');
}

function selectInvoiceClient(id) {
  const c = (_clientsCache || []).find(x => x.id === id);
  if (!c) return;
  document.getElementById('inv-b-name').value  = c.company || c.name || '';
  document.getElementById('inv-b-code').value  = c.company_code || '';
  document.getElementById('inv-b-vat').value   = c.vat_code || '';
  document.getElementById('inv-b-addr').value  = c.address || '';
  document.getElementById('inv-client-search').value = c.name || '';
  document.getElementById('inv-client-suggestions').innerHTML = '';
}
