'use strict';

let productsData  = [];
let productsStats = null;
let productFilter = { store: 'all', type: 'all', sort: 'margin_pct' };
let expandedProductId = null;
let b2bPanelProduct   = null;

async function initProducts() {
  if (productsData.length) {
    renderProductsStats();
    renderProductsTable();
    return;
  }
  await loadProducts();
}

async function loadProducts() {
  try {
    const [{ products }, stats] = await Promise.all([
      api('/api/products'),
      api('/api/products/stats'),
    ]);
    productsData  = products || [];
    productsStats = stats;
    renderProductsStats();
    renderProductsTable();
  } catch {
    toast('Klaida kraunant produktus', 'error');
  }
}

function renderProductsStats() {
  const el = document.getElementById('products-stats');
  if (!el) return;
  const s = productsStats || {};
  const mostSold = [...productsData].sort((a, b) => b.units_sold - a.units_sold)[0] || null;

  el.innerHTML = `
    <div class="prod-stat-card">
      <div class="prod-stat-label">Best Margin</div>
      <div class="prod-stat-value" style="color:var(--green-deep)">${s.best_margin ? p1(s.best_margin.margin_pct) + '%' : '—'}</div>
      <div class="prod-stat-name">${esc(s.best_margin?.name || '')} <span class="prod-store-pill prod-store-${(s.best_margin?.store||'').toLowerCase()}">${esc(s.best_margin?.store||'')}</span></div>
    </div>
    <div class="prod-stat-card">
      <div class="prod-stat-label">Worst Margin</div>
      <div class="prod-stat-value" style="color:var(--red)">${s.worst_margin ? p1(s.worst_margin.margin_pct) + '%' : '—'}</div>
      <div class="prod-stat-name">${esc(s.worst_margin?.name || '')} <span class="prod-store-pill prod-store-${(s.worst_margin?.store||'').toLowerCase()}">${esc(s.worst_margin?.store||'')}</span></div>
    </div>
    <div class="prod-stat-card">
      <div class="prod-stat-label">Avg Margin</div>
      <div class="prod-stat-value">${s.avg_margin != null ? p1(s.avg_margin) + '%' : '—'}</div>
      <div class="prod-stat-name">${s.total_products || 0} produktų</div>
    </div>
    <div class="prod-stat-card">
      <div class="prod-stat-label">Daugiausiai parduota</div>
      <div class="prod-stat-value">${mostSold?.units_sold || '—'}</div>
      <div class="prod-stat-name">${esc(mostSold?.name || 'Nėra duomenų')}</div>
    </div>
  `;
}

function getFilteredProducts() {
  let list = [...productsData];
  if (productFilter.store !== 'all') list = list.filter(p => p.store === productFilter.store);
  if (productFilter.type === 'ball') list = list.filter(p => !p.moss_type.toLowerCase().includes('mix'));
  else if (productFilter.type === 'mix') list = list.filter(p => p.moss_type.toLowerCase().includes('mix'));
  const k = productFilter.sort;
  list.sort((a, b) => k === 'name' ? a.name.localeCompare(b.name) : (b[k] || 0) - (a[k] || 0));
  return list;
}

function renderProductsTable() {
  const tbody = document.getElementById('products-tbody');
  if (!tbody) return;
  const list = getFilteredProducts();

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-secondary)">Nėra produktų</td></tr>`;
    return;
  }

  tbody.innerHTML = list.flatMap(p => {
    const mcls     = p.margin_pct >= 65 ? 'green' : p.margin_pct >= 50 ? 'amber' : 'red';
    const mcolor   = mcls === 'green' ? 'var(--green)' : mcls === 'amber' ? 'var(--orange)' : 'var(--red)';
    const storeCls = p.store === 'LT' ? 'lt' : p.store === 'DK' ? 'dk' : 'de';
    const isExp    = expandedProductId === p.id;
    const barW     = Math.min(p.margin_pct, 100).toFixed(1);

    // Show real WC product name when store filter matches
    const displayName = (productFilter.store === 'LT' && p.lt_name)
      ? p.lt_name
      : (productFilter.store === 'DK' && p.dk_name)
      ? p.dk_name
      : p.name;
    const hasWcName = (p.store === 'LT' && p.lt_name) || (p.store === 'DK' && p.dk_name);
    const wcNameHint = hasWcName
      ? ` <span class="prod-wc-name" title="WooCommerce: ${esc(p.store === 'LT' ? p.lt_name : p.dk_name)}">${esc(p.store === 'LT' ? p.lt_name : p.dk_name)}</span>`
      : '';

    const mainRow = `
<tr class="prod-row${isExp ? ' expanded' : ''}" data-id="${p.id}" onclick="toggleProductExpand(${p.id})">
  <td class="prod-name-cell">
    <span class="prod-internal-name">${esc(p.name)}</span>
    ${hasWcName ? `<span class="prod-wc-name">${esc(p.store === 'LT' ? (p.lt_name||'') : (p.dk_name||''))}</span>` : ''}
  </td>
  <td><span class="prod-store-pill prod-store-${storeCls}">${esc(p.store)}</span></td>
  <td style="color:var(--text-secondary);font-size:12px">${esc(p.moss_type)}</td>
  <td class="text-right">€${p2(p.total_cost)}</td>
  <td class="text-right">€${p2(p.sell_price_eur)}</td>
  <td class="text-right" style="color:var(--green-deep)">€${p2(p.gross_profit)}</td>
  <td>
    <div class="margin-bar-wrap">
      <div class="margin-bar-bg"><div class="margin-bar-fill ${mcls}" style="width:${barW}%"></div></div>
      <span class="margin-pct-label ${mcls}">${p1(p.margin_pct)}%</span>
    </div>
  </td>
  <td class="text-right">${p.units_sold}</td>
  <td class="text-right">${p.revenue_total > 0 ? '€' + p2(p.revenue_total) : '—'}</td>
</tr>`;

    if (!isExp) return [mainRow];

    const extrasHtml = p.extras_cost > 0 ? `
      <span class="prod-cost-divider">+</span>
      <div class="prod-cost-item">
        <div class="prod-cost-lbl">Extras</div>
        <div class="prod-cost-val">€${p2(p.extras_cost)}</div>
      </div>` : '';

    const dkkHtml = p.sell_price_dkk ? `
      <div class="prod-cost-item" style="margin-left:8px">
        <div class="prod-cost-lbl">DKK kaina</div>
        <div class="prod-cost-val">${Math.round(p.sell_price_dkk)} DKK</div>
      </div>` : '';

    const expandRow = `
<tr class="prod-expand-row">
  <td colspan="9">
    <div class="prod-expand-inner">
      <div class="prod-expand-costs">
        <div class="prod-cost-item">
          <div class="prod-cost-lbl">Rėmai</div>
          <div class="prod-cost-val">€${p2(p.frame_cost)}</div>
        </div>
        <span class="prod-cost-divider">+</span>
        <div class="prod-cost-item">
          <div class="prod-cost-lbl">Samanos</div>
          <div class="prod-cost-val">€${p2(p.moss_cost)}</div>
        </div>
        ${extrasHtml}
        <span class="prod-cost-divider">=</span>
        <div class="prod-cost-item">
          <div class="prod-cost-lbl">Savikaina</div>
          <div class="prod-cost-val" style="color:var(--red)">€${p2(p.total_cost)}</div>
        </div>
        ${dkkHtml}
      </div>
      <div class="prod-margin-visual">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">Marža</div>
        <div class="prod-margin-bar-lg">
          <div style="height:100%;border-radius:5px;width:${barW}%;background:${mcolor};transition:width .4s"></div>
        </div>
        <div style="font-size:13px;font-weight:600;margin-top:4px">${p1(p.margin_pct)}% marža · €${p2(p.gross_profit)} pelnas</div>
      </div>
      <button class="btn-add-b2b" onclick="event.stopPropagation();openB2bPanelForProduct(${p.id})">Pridėti į B2B užsakymą</button>
    </div>
  </td>
</tr>`;

    return [mainRow, expandRow];
  }).join('');
}

function toggleProductExpand(id) {
  expandedProductId = expandedProductId === id ? null : id;
  renderProductsTable();
}

function setProductStore(store) {
  productFilter.store = store;
  document.querySelectorAll('.prod-filter-store').forEach(b =>
    b.classList.toggle('active', b.dataset.store === store)
  );
  renderProductsTable();
}

function setProductType(type) {
  productFilter.type = type;
  document.querySelectorAll('.prod-filter-type').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  renderProductsTable();
}

function setProductSort(sort) {
  productFilter.sort = sort;
  renderProductsTable();
}

async function syncProductNamesFromWC() {
  const btn = document.getElementById('sync-names-btn');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }
  try {
    const r = await api('/api/products/sync-names', { method: 'POST' });
    toast(`Atnaujinta: LT ${r.lt}, DK ${r.dk} pavadinimų`);
    productsData = [];
    await loadProducts();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Sync names'; }
  }
}

// ── B2B Slide Panel ─────────────────────────────────────────────────────────

function openB2bPanelForProduct(productId) {
  const p = productsData.find(x => x.id === productId);
  if (p) openB2bPanel(p);
}

function openB2bPanel(product, defaultQty = 1, defaultPrice = null) {
  b2bPanelProduct = product;

  document.getElementById('pb2b-product-name').value = product.name;
  document.getElementById('pb2b-product-label').textContent = product.name;
  document.getElementById('pb2b-price').value     = defaultPrice != null ? defaultPrice : product.sell_price_eur;
  document.getElementById('pb2b-qty').value        = defaultQty;
  document.getElementById('pb2b-customer').value   = '';
  document.getElementById('pb2b-date').value       = new Date().toISOString().slice(0, 10);
  document.getElementById('pb2b-notes').value      = '';
  updateB2bTotal();

  document.getElementById('b2b-panel-overlay').classList.add('visible');
  document.getElementById('b2b-slide-panel').classList.add('open');
}

function closeB2bPanel() {
  document.getElementById('b2b-panel-overlay').classList.remove('visible');
  document.getElementById('b2b-slide-panel').classList.remove('open');
  b2bPanelProduct = null;
}

function updateB2bTotal() {
  const qty   = parseFloat(document.getElementById('pb2b-qty').value)   || 1;
  const price = parseFloat(document.getElementById('pb2b-price').value) || 0;
  const el = document.getElementById('pb2b-total');
  if (el) el.textContent = `€${(qty * price).toFixed(2)}`;
}

async function submitB2bPanel() {
  if (!b2bPanelProduct) return;

  const qty      = Math.max(1, parseFloat(document.getElementById('pb2b-qty').value) || 1);
  const price    = parseFloat(document.getElementById('pb2b-price').value) || b2bPanelProduct.sell_price_eur;
  const customer = document.getElementById('pb2b-customer').value.trim();
  const date     = document.getElementById('pb2b-date').value;
  const notes    = document.getElementById('pb2b-notes').value.trim();

  if (!customer) { toast('Įveskite kliento vardą', 'error'); return; }
  if (!date)     { toast('Pasirinkite datą', 'error'); return; }

  const description = qty > 1
    ? `${qty}x ${b2bPanelProduct.name}${notes ? ' · ' + notes : ''}`
    : `${b2bPanelProduct.name}${notes ? ' · ' + notes : ''}`;

  const btn = document.getElementById('pb2b-submit-btn');
  btn.disabled = true;

  try {
    await api('/api/orders/b2b', {
      method: 'POST',
      body:   JSON.stringify({ customer_name: customer, amount: qty * price, description, order_date: date, has_invoice: false }),
    });
    toast('B2B užsakymas sukurtas!');
    closeB2bPanel();
  } catch {
    toast('Klaida kuriant užsakymą', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function p1(n) { return (Math.round((n || 0) * 10)  / 10).toFixed(1); }
function p2(n) { return (Math.round((n || 0) * 100) / 100).toFixed(2); }
