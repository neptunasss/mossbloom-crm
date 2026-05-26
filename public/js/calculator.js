'use strict';

let kainStore    = 'LT';
let kainProducts = [];

async function initCalculator() {
  // Use products already loaded by products.js, or fetch fresh
  if (typeof productsData !== 'undefined' && productsData.length) {
    kainProducts = productsData;
  } else {
    try {
      const { products } = await api('/api/products');
      kainProducts = products || [];
      // Share back so products page can use them if visited next
      if (typeof productsData !== 'undefined') productsData = kainProducts;
    } catch {
      toast('Klaida kraunant produktus', 'error');
    }
  }
  populateKainSelector();
  kainRecalc();
}

function setKainStore(store) {
  kainStore = store;
  document.querySelectorAll('.kain-store-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.store === store)
  );
  // Clear custom price when switching store
  const priceEl = document.getElementById('kain-custom-price');
  if (priceEl) priceEl.value = '';
  populateKainSelector();
}

function populateKainSelector() {
  const sel = document.getElementById('kain-product');
  if (!sel) return;
  const list = kainProducts.filter(p => p.store === kainStore);
  sel.innerHTML = list.length
    ? list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">Nėra produktų</option>';
  kainRecalc();
}

function kainRecalc() {
  const sel = document.getElementById('kain-product');
  const results = document.getElementById('kain-results');
  if (!sel || !results) return;

  const productId = parseInt(sel.value);
  const p = kainProducts.find(x => x.id === productId);

  if (!p) {
    results.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px 0">Pasirinkite produktą</div>`;
    return;
  }

  const qty         = Math.max(1, parseInt(document.getElementById('kain-qty').value) || 1);
  const customPrice = parseFloat(document.getElementById('kain-custom-price').value);
  const price       = !isNaN(customPrice) && customPrice > 0 ? customPrice : p.sell_price_eur;
  const isDK        = p.store === 'DK';

  // DK prices include 21% LT VAT — use net for margin calc
  const netPrice  = isDK ? price / 1.21 : price;
  const profit    = netPrice - p.total_cost;
  const margin    = netPrice > 0 ? (profit / netPrice) * 100 : 0;
  const mcls      = margin >= 65 ? 'green' : margin >= 50 ? 'amber' : 'red';
  const mcolor    = mcls === 'green' ? 'var(--green)' : mcls === 'amber' ? 'var(--orange)' : 'var(--red)';
  const barW      = Math.min(Math.max(margin, 0), 100).toFixed(1);

  const dkkRow = (isDK && p.sell_price_dkk)
    ? `<div class="kain-result-row"><div class="kain-result-lbl">DKK kaina</div><div class="kain-result-val">${Math.round(p.sell_price_dkk)} DKK</div></div>`
    : '';
  const vatRow = isDK
    ? `<div class="kain-result-row"><div class="kain-result-lbl">Kaina be PVM</div><div class="kain-result-val">€${p2(netPrice)}</div></div>`
    : '';
  const totalRows = qty > 1 ? `
    <div class="kain-result-divider"></div>
    <div class="kain-result-row"><div class="kain-result-lbl">Viso kaina ×${qty}</div><div class="kain-result-val">€${p2(price * qty)}</div></div>
    <div class="kain-result-row"><div class="kain-result-lbl">Viso pelnas ×${qty}</div><div class="kain-result-val" style="color:var(--green-deep)">€${p2(profit * qty)}</div></div>
  ` : '';

  results.innerHTML = `
    <div class="kain-result-card">
      <div class="kain-result-title">${esc(p.name)}</div>

      <div class="kain-result-row"><div class="kain-result-lbl">Savikaina</div><div class="kain-result-val">€${p2(p.total_cost)}</div></div>
      <div class="kain-result-row"><div class="kain-result-lbl">Pardavimo kaina</div><div class="kain-result-val">€${p2(price)}</div></div>
      ${vatRow}
      ${dkkRow}
      <div class="kain-result-divider"></div>
      <div class="kain-result-row">
        <div class="kain-result-lbl">Pelnas / vnt.</div>
        <div class="kain-result-val" style="color:var(--green-deep)">€${p2(profit)}</div>
      </div>
      <div class="kain-result-row">
        <div class="kain-result-lbl">Marža</div>
        <div class="kain-result-val ${mcls === 'green' ? '' : mcls === 'amber' ? '' : ''}" style="color:${mcolor}">${p1(margin)}%</div>
      </div>
      <div class="kain-margin-bar-wrap">
        <div class="kain-margin-bar-bg">
          <div style="height:100%;border-radius:4px;width:${barW}%;background:${mcolor};transition:width .3s"></div>
        </div>
      </div>
      ${totalRows}
    </div>
  `;
}

function kainAddToB2b() {
  const sel = document.getElementById('kain-product');
  const productId = parseInt(sel?.value);
  const p = kainProducts.find(x => x.id === productId);
  if (!p) { toast('Pasirinkite produktą', 'error'); return; }

  const qty         = Math.max(1, parseInt(document.getElementById('kain-qty').value) || 1);
  const customPrice = parseFloat(document.getElementById('kain-custom-price').value);
  const price       = !isNaN(customPrice) && customPrice > 0 ? customPrice : p.sell_price_eur;

  openB2bPanel(p, qty, price);
}

function p1(n) { return (Math.round((n || 0) * 10)  / 10).toFixed(1); }
function p2(n) { return (Math.round((n || 0) * 100) / 100).toFixed(2); }
