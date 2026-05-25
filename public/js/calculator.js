'use strict';

const DEFAULT_PRICING = {
  mossCosts: {
    reindeer: { name: 'Reindeer Moss',    costPerM2: 65 },
    ball:     { name: 'Ball Moss',        costPerM2: 85 },
    flat:     { name: 'Flat Sheet Moss',  costPerM2: 50 },
    cushion:  { name: 'Cushion Moss',     costPerM2: 80 },
    mixed:    { name: 'Mixed Moss',       costPerM2: 70 },
  },
  framePerM2:      35,
  frameFlatFee:    20,
  laborPerM2:      25,
  packagingPerPiece: 12,
};

let calcType = 'round';

function getPricing() {
  try {
    const s = localStorage.getItem('mossbloom_pricing');
    if (s) {
      const saved = JSON.parse(s);
      return { ...DEFAULT_PRICING, ...saved, mossCosts: { ...DEFAULT_PRICING.mossCosts, ...saved.mossCosts } };
    }
  } catch {}
  return { ...DEFAULT_PRICING };
}

function savePricingSettings() {
  const pricing = getPricing();
  const grid = document.getElementById('pricing-grid');

  grid.querySelectorAll('[data-pricing-key]').forEach(input => {
    const key = input.dataset.pricingKey;
    const mossKey = input.dataset.mossKey;
    if (mossKey) {
      pricing.mossCosts[mossKey].costPerM2 = parseFloat(input.value) || 0;
    } else {
      pricing[key] = parseFloat(input.value) || 0;
    }
  });

  localStorage.setItem('mossbloom_pricing', JSON.stringify(pricing));
  toast('Pricing saved');
  recalculate();
}

function renderPricingGrid() {
  const pricing = getPricing();
  const grid = document.getElementById('pricing-grid');

  const mossRows = Object.entries(pricing.mossCosts).map(([key, m]) => `
    <div class="pricing-row">
      <label>${m.name}</label>
      <div class="pricing-input-wrap">
        <span>€</span>
        <input type="number" class="pricing-inp" data-pricing-key="mossCosts" data-moss-key="${key}"
               value="${m.costPerM2}" min="0" step="1"> <span>/m²</span>
      </div>
    </div>`).join('');

  grid.innerHTML = `
    <div class="pricing-section-title">Material cost per m²</div>
    ${mossRows}
    <div class="pricing-section-title" style="margin-top:12px">Other costs</div>
    <div class="pricing-row">
      <label>Frame (flat fee)</label>
      <div class="pricing-input-wrap"><span>€</span>
        <input type="number" class="pricing-inp" data-pricing-key="frameFlatFee" value="${pricing.frameFlatFee}" min="0" step="1">
      </div>
    </div>
    <div class="pricing-row">
      <label>Frame per m²</label>
      <div class="pricing-input-wrap"><span>€</span>
        <input type="number" class="pricing-inp" data-pricing-key="framePerM2" value="${pricing.framePerM2}" min="0" step="1"> <span>/m²</span>
      </div>
    </div>
    <div class="pricing-row">
      <label>Labor per m²</label>
      <div class="pricing-input-wrap"><span>€</span>
        <input type="number" class="pricing-inp" data-pricing-key="laborPerM2" value="${pricing.laborPerM2}" min="0" step="1"> <span>/m²</span>
      </div>
    </div>
    <div class="pricing-row">
      <label>Packaging (per piece)</label>
      <div class="pricing-input-wrap"><span>€</span>
        <input type="number" class="pricing-inp" data-pricing-key="packagingPerPiece" value="${pricing.packagingPerPiece}" min="0" step="1">
      </div>
    </div>`;
}

function getArea() {
  if (calcType === 'round') {
    const d = parseFloat(document.getElementById('calc-diameter').value);
    if (!d) return null;
    const r = (d / 2) / 100;
    return Math.PI * r * r;
  } else {
    const w = parseFloat(document.getElementById('calc-width').value);
    const h = parseFloat(document.getElementById('calc-height').value);
    if (!w || !h) return null;
    return (w / 100) * (h / 100);
  }
}

function recalculate() {
  const area = getArea();
  const results = document.getElementById('calc-results');

  if (!area || area <= 0) {
    results.innerHTML = `<div class="calc-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48" opacity="0.3">
        <rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h8M8 14h4"/>
      </svg>
      <p>Enter dimensions to calculate</p>
    </div>`;
    return;
  }

  const mossKey    = document.getElementById('calc-moss').value;
  const qty        = Math.max(1, parseInt(document.getElementById('calc-qty').value) || 1);
  const incFrame   = document.getElementById('inc-frame').checked;
  const incLabor   = document.getElementById('inc-labor').checked;
  const incPack    = document.getElementById('inc-packaging').checked;
  const markup     = Math.max(1, parseFloat(document.getElementById('calc-markup').value) || 2.5);
  const pricing    = getPricing();
  const mossConf   = pricing.mossCosts[mossKey];

  const matPerPiece    = area * mossConf.costPerM2;
  const framePerPiece  = incFrame  ? (pricing.frameFlatFee + area * pricing.framePerM2) : 0;
  const laborPerPiece  = incLabor  ? (area * pricing.laborPerM2) : 0;
  const packPerPiece   = incPack   ? pricing.packagingPerPiece : 0;
  const costPerPiece   = matPerPiece + framePerPiece + laborPerPiece + packPerPiece;
  const sellPerPiece   = costPerPiece * markup;
  const profitPerPiece = sellPerPiece - costPerPiece;
  const marginPct      = (profitPerPiece / sellPerPiece * 100);

  const fmt = n => `€${n.toFixed(2)}`;
  const areaLabel = calcType === 'round'
    ? `⌀${document.getElementById('calc-diameter').value} cm`
    : `${document.getElementById('calc-width').value} × ${document.getElementById('calc-height').value} cm`;

  const rows = [
    incFrame  && ['Frame / Backing',       framePerPiece ],
    incLabor  && ['Labor',                 laborPerPiece ],
    incPack   && ['Packaging',             packPerPiece  ],
  ].filter(Boolean);

  results.innerHTML = `
    <div class="calc-result-card">
      <div class="calc-result-header">
        <span class="calc-area-label">${mossConf.name} · ${areaLabel} · ${area.toFixed(4)} m²</span>
      </div>

      <div class="cost-breakdown">
        <div class="cost-row">
          <span>Material (${mossConf.name})</span>
          <span>${fmt(matPerPiece)}</span>
        </div>
        ${rows.map(([label, cost]) => `
        <div class="cost-row">
          <span>${label}</span>
          <span>${fmt(cost)}</span>
        </div>`).join('')}
        <div class="cost-row cost-row--total">
          <span>Cost price / piece</span>
          <span>${fmt(costPerPiece)}</span>
        </div>
      </div>

      <div class="sell-card">
        <div class="sell-card-top">
          <div>
            <div class="sell-label">Sell price / piece</div>
            <div class="sell-price">${fmt(sellPerPiece)}</div>
          </div>
          ${qty > 1 ? `<div>
            <div class="sell-label">Total × ${qty}</div>
            <div class="sell-price">${fmt(sellPerPiece * qty)}</div>
          </div>` : ''}
        </div>
        <div class="margin-row">
          <span>Margin: <b>${marginPct.toFixed(1)}%</b></span>
          <span>Profit: <b>${fmt(profitPerPiece)}</b> / piece</span>
          ${qty > 1 ? `<span>Total profit: <b>${fmt(profitPerPiece * qty)}</b></span>` : ''}
        </div>
      </div>

      ${qty > 1 ? `
      <div class="cost-breakdown" style="margin-top:12px">
        <div class="cost-row cost-row--total">
          <span>Total cost price × ${qty}</span>
          <span>${fmt(costPerPiece * qty)}</span>
        </div>
      </div>` : ''}
    </div>`;
}

function initCalculator() {
  renderPricingGrid();
}

// Bind events (called once on page load)
(function bindCalcEvents() {
  // Type toggle
  document.querySelectorAll('.toggle-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn[data-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      calcType = btn.dataset.type;
      document.getElementById('round-inputs').hidden  = calcType !== 'round';
      document.getElementById('rect-inputs').hidden   = calcType !== 'rectangular';
      recalculate();
    });
  });

  // All calc inputs
  ['calc-diameter','calc-width','calc-height','calc-moss','calc-qty','calc-markup',
   'inc-frame','inc-labor','inc-packaging'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalculate);
  });
})();
