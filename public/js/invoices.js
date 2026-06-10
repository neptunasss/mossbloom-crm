'use strict';

let invoicesData  = [];
let invoicesStats = {};
let invoiceFilter = { status: 'all', search: '' };
let invLineCount  = 0;

async function initInvoices() {
  await loadInvoices();
}

async function loadInvoices() {
  try {
    const p = new URLSearchParams();
    if (invoiceFilter.status !== 'all') p.set('status', invoiceFilter.status);
    if (invoiceFilter.search) p.set('search', invoiceFilter.search);
    const { invoices, stats } = await api(`/api/invoices?${p}`);
    invoicesData  = invoices || [];
    invoicesStats = stats   || {};
    renderInvoicesStats();
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

function renderInvoicesStats() {
  const el = document.getElementById('invoices-stats-row');
  if (!el) return;
  const s = invoicesStats;
  el.innerHTML = `
    <div class="prod-stat-card"><div class="prod-stat-label">Visos sąskaitos</div><div class="prod-stat-value">${s.total||0}</div></div>
    <div class="prod-stat-card"><div class="prod-stat-label">Neapmokėtos</div><div class="prod-stat-value" style="color:var(--orange)">${s.unpaid||0}</div></div>
    <div class="prod-stat-card"><div class="prod-stat-label">Apmokėtos</div><div class="prod-stat-value" style="color:var(--green)">${s.paid||0}</div></div>
    <div class="prod-stat-card"><div class="prod-stat-label">Bendra suma</div><div class="prod-stat-value">€${Math.round(s.sum||0).toLocaleString('lt-LT')}</div></div>
  `;
}

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
      <td class="text-right inv-actions-cell" onclick="event.stopPropagation()">
        <button class="inv-act-btn" onclick="viewInvoiceHtml(${inv.id})" title="Peržiūrėti">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M1 12S5 4 12 4s11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="inv-act-btn" onclick="downloadInvoicePdf(${inv.id},'${esc(inv.invoice_number)}')" title="Atsisiųsti PDF">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        ${inv.status !== 'paid' ? `<button class="inv-act-btn" onclick="markInvoicePaid(${inv.id})" title="Pažymėti apmokėta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>
        </button>` : ''}
        <button class="inv-act-btn danger" onclick="deleteInvoice(${inv.id})" title="Ištrinti">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
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
  const a = document.createElement('a');
  a.href = `/api/invoices/${id}/pdf`;
  a.download = `${num}.pdf`;
  a.click();
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

// ── Invoice create full page ──────────────────────────────────────────────────

function openCreateInvoice(prefill) {
  invLineCount = 0;
  document.getElementById('inv-lines-tbody').innerHTML = '';

  const today = new Date().toISOString().slice(0, 10);
  const due   = new Date(); due.setDate(due.getDate() + 14);
  document.getElementById('inv-issue-date').value = today;
  document.getElementById('inv-due-date').value   = due.toISOString().slice(0, 10);

  document.getElementById('inv-b-name').value = prefill?.buyer_name || '';
  document.getElementById('inv-b-code').value = prefill?.buyer_code || '';
  document.getElementById('inv-b-vat').value  = prefill?.buyer_vat  || '';
  document.getElementById('inv-b-addr').value = prefill?.buyer_addr || '';
  document.getElementById('inv-client-search').value = '';
  document.getElementById('inv-client-suggestions').innerHTML = '';

  addInvoiceLine(prefill?.item_name || '', prefill?.item_price || '');
  updateInvoiceTotals();

  switchView('inv-create');
}

function closeInvCreate() {
  switchView('invoices');
}

function addInvoiceLine(name = '', price = '') {
  invLineCount++;
  const n = invLineCount;
  const tr = document.createElement('tr');
  tr.id = `inv-line-${n}`;
  tr.innerHTML = `
    <td>${n}</td>
    <td><input type="text" class="inv-line-name" value="${esc(name)}" placeholder="Pavadinimas" oninput="updateInvoiceTotals();updateLivePreview()" list="inv-products-list"></td>
    <td><input type="text" class="inv-line-unit" value="vnt." oninput="updateLivePreview()"></td>
    <td><input type="number" class="inv-line-qty" value="1" min="0.01" step="0.01" oninput="updateInvoiceTotals();updateLivePreview()"></td>
    <td><input type="number" class="inv-line-price" value="${price}" min="0" step="0.01" oninput="updateInvoiceTotals();updateLivePreview()"></td>
    <td class="r inv-line-sum">€0.00</td>
    <td><button class="btn-delete" onclick="removeInvoiceLine(${n})" style="padding:2px 6px">✕</button></td>
  `;
  document.getElementById('inv-lines-tbody').appendChild(tr);
  updateInvoiceTotals();

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
  updateLivePreview();
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
  const g = id => document.getElementById(id);
  if (g('inv-preview-sub'))   g('inv-preview-sub').textContent   = '€' + sub.toFixed(2);
  if (g('inv-preview-vat'))   g('inv-preview-vat').textContent   = '€' + vat.toFixed(2);
  if (g('inv-preview-total')) g('inv-preview-total').textContent = '€' + total.toFixed(2);
}

// ── Live preview ──────────────────────────────────────────────────────────────

const LT_MONTHS = ['sausio','vasario','kovo','balandžio','gegužės','birželio',
  'liepos','rugpjūčio','rugsėjo','spalio','lapkričio','gruodžio'];

function ltFmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()} m. ${LT_MONTHS[d.getMonth()]} ${d.getDate()} d.`;
}

function updateLivePreview() {
  const frame = document.getElementById('inv-preview-frame');
  if (!frame) return;

  const g = id => document.getElementById(id)?.value || '';
  const issueDate = g('inv-issue-date');
  const dueDate   = g('inv-due-date');

  let sub = 0;
  const lineRows = [];
  let lineNum = 0;
  document.querySelectorAll('#inv-lines-tbody tr').forEach(tr => {
    lineNum++;
    const name  = tr.querySelector('.inv-line-name')?.value || '';
    const unit  = tr.querySelector('.inv-line-unit')?.value || 'vnt.';
    const qty   = parseFloat(tr.querySelector('.inv-line-qty')?.value  || 1);
    const price = parseFloat(tr.querySelector('.inv-line-price')?.value || 0);
    const line  = Math.round(qty * price * 100) / 100;
    sub += line;
    lineRows.push(`<tr><td class="c">${lineNum}</td><td>${esc(name)}</td><td class="c">${esc(unit)}</td><td class="r">${qty}</td><td class="r">${price.toFixed(2)}</td><td class="r">${line.toFixed(2)}</td></tr>`);
  });
  while (lineRows.length < 4) lineRows.push('<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>');

  const vat   = Math.round(sub * 0.21 * 100) / 100;
  const total = Math.round((sub + vat) * 100) / 100;

  const sName = g('inv-s-name'); const sCode = g('inv-s-code'); const sVat = g('inv-s-vat');
  const sAddr = g('inv-s-addr'); const sPhone = g('inv-s-phone'); const sEmail = g('inv-s-email');
  const sBank = g('inv-s-bank'); const sIban = g('inv-s-iban'); const sSignee = g('inv-s-signee');
  const bName = g('inv-b-name'); const bCode = g('inv-b-code'); const bVat = g('inv-b-vat');
  const bAddr = g('inv-b-addr');

  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const previewNum = `PAV${today}-01`;

  frame.srcdoc = `<!DOCTYPE html><html lang="lt"><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:10px;color:#000;background:#fff}
.page{width:100%;padding:12mm 12mm 10mm;min-height:100%}
h1{font-size:13px;text-transform:uppercase;text-align:center;font-weight:700;letter-spacing:1px;margin-bottom:5px}
.inv-meta{text-align:center;margin-bottom:12px;font-size:10px}
.inv-meta p{margin:2px 0}
.parties{width:100%;border-collapse:collapse;margin-bottom:12px}
.parties td{width:50%;vertical-align:top;padding:6px 8px;border:1px solid #000;font-size:10px;line-height:1.6}
.section-hdr{font-weight:700;text-transform:uppercase;border-bottom:1px solid #ccc;margin-bottom:5px;padding-bottom:2px}
.items{width:100%;border-collapse:collapse;margin-bottom:12px}
.items th,.items td{border:1px solid #000;padding:4px 5px}
.items th{background:#f0f0f0;font-weight:700;text-align:center;font-size:9px}
.items td.c{text-align:center}.items td.r{text-align:right}
.totals-wrap{display:flex;justify-content:flex-end;margin-bottom:14px}
.totals{border-collapse:collapse;min-width:220px}
.totals td{padding:3px 8px;border:1px solid #000;font-size:10px}
.totals td:last-child{text-align:right;min-width:80px}
.totals tr.tf td{font-weight:700;background:#f0f0f0}
.sig{display:flex;justify-content:space-between;margin-top:20px;font-size:10px}
.sig-line{border-top:1px solid #000;min-width:180px;padding-top:3px;text-align:center}
</style></head><body><div class="page">
<h1>PVM SĄSKAITA FAKTŪRA</h1>
<div class="inv-meta"><p>Serija PAV Nr. ${previewNum}</p><p>${ltFmtDate(issueDate)}</p></div>
<table class="parties"><tr>
<td><div class="section-hdr">Pardavėjo rekvizitai</div>
<strong>${esc(sName)}</strong><br>Įmonės kodas: ${esc(sCode)}<br>PVM kodas: ${esc(sVat)}<br>
Adresas: ${esc(sAddr)}<br>Tel.: ${esc(sPhone)}<br>El. paštas: ${esc(sEmail)}<br>
Bankas: ${esc(sBank)}<br>IBAN: ${esc(sIban)}</td>
<td><div class="section-hdr">Pirkėjo rekvizitai</div>
<strong>${esc(bName)||'—'}</strong><br>
${bCode?`Įmonės kodas: ${esc(bCode)}<br>`:''}${bVat?`PVM kodas: ${esc(bVat)}<br>`:''}${bAddr?`Adresas: ${esc(bAddr)}<br>`:''}&nbsp;
</td></tr></table>
<table class="items"><thead><tr>
<th style="width:4%">Nr.</th><th style="width:44%">Pavadinimas</th><th style="width:9%">Mat. vnt.</th>
<th class="r" style="width:8%">Kiekis</th><th class="r" style="width:17%">Kaina be PVM, €</th><th class="r" style="width:18%">Suma be PVM, €</th>
</tr></thead><tbody>${lineRows.join('')}</tbody></table>
<div class="totals-wrap"><table class="totals">
<tr><td>Iš viso be PVM:</td><td>${sub.toFixed(2)} €</td></tr>
<tr><td>PVM 21%:</td><td>${vat.toFixed(2)} €</td></tr>
<tr class="tf"><td>Viso su PVM:</td><td>${total.toFixed(2)} €</td></tr>
</table></div>
<div class="sig">
<div><div class="sig-line">Sąskaitą išrašė: ${esc(sSignee)}</div></div>
<div><div class="sig-line">Sąskaitą priėmė: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div></div>
</div>
</div></body></html>`;
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

  const g = id => document.getElementById(id)?.value || '';
  const data = {
    seller_name:    g('inv-s-name'),
    seller_code:    g('inv-s-code'),
    seller_vat:     g('inv-s-vat'),
    seller_bank:    g('inv-s-bank'),
    seller_iban:    g('inv-s-iban'),
    seller_phone:   g('inv-s-phone'),
    seller_address: g('inv-s-addr'),
    seller_email:   g('inv-s-email'),
    seller_signee:  g('inv-s-signee'),
    buyer_name:     buyerName,
    buyer_code:     g('inv-b-code'),
    buyer_vat:      g('inv-b-vat'),
    buyer_address:  g('inv-b-addr'),
    issue_date:     g('inv-issue-date'),
    due_date:       g('inv-due-date'),
    line_items:     lines,
  };

  try {
    const result = await api('/api/invoices', { method: 'POST', body: JSON.stringify(data) });
    toast('Sąskaita sukurta');
    if (result.client_saved) setTimeout(() => toast('Klientas išsaugotas'), 800);
    switchView('invoices');
    await loadInvoices();
    viewInvoiceHtml(result.id);
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Client autocomplete ───────────────────────────────────────────────────────

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
  updateLivePreview();
}

// ── Dot menu shared helper ────────────────────────────────────────────────────

function toggleDotMenu(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains('open');
  // Close all other open menus
  document.querySelectorAll('.dot-menu.open').forEach(m => m.classList.remove('open'));
  if (!isOpen) menu.classList.add('open');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.dot-menu-wrap')) {
    document.querySelectorAll('.dot-menu.open').forEach(m => m.classList.remove('open'));
  }
});
