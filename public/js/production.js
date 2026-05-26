'use strict';

const PROD_STAGES = [
  { id: 'gauta',      label: 'Gauta' },
  { id: 'gaminama',   label: 'Gaminama' },
  { id: 'paruosta',   label: 'Paruošta' },
  { id: 'issista',    label: 'Išsiųsta' },
  { id: 'pristatyta', label: 'Pristatyta' },
];

const STORE_BADGE = {
  bloom_lt:     { label: 'LT' },
  mossbloom_dk: { label: 'DK' },
  mossbloom_de: { label: 'DE' },
  b2b:          { label: 'B2B' },
};

let prodDragging = null;
let activeProdStage = 'gauta';

function initProduction() {
  loadProduction();

  // Mobile tab click
  document.querySelectorAll('.prod-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeProdStage = btn.dataset.stage;
      document.querySelectorAll('.prod-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateProdMobileView();
    });
  });
}

async function loadProduction() {
  setLoading(true);
  try {
    const data = await api('/api/production');
    renderProduction(data.stages);
  } catch (e) {
    showToast('Klaida kraunant gamybą', 'error');
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  const el = document.getElementById('prod-loading');
  if (el) el.hidden = !on;
}

function renderProduction(stages) {
  for (const { id } of PROD_STAGES) {
    const cards = stages[id] || [];
    const colEl  = document.getElementById(`prod-col-${id}`);
    const countEl = document.getElementById(`pcol-${id}`);
    const tabCount = document.getElementById(`ptab-${id}`);

    if (countEl) countEl.textContent = cards.length;
    if (tabCount) tabCount.textContent = cards.length;
    if (!colEl) continue;

    colEl.innerHTML = cards.length
      ? cards.map(c => renderProdCard(c)).join('')
      : `<div class="prod-empty">Nėra užsakymų</div>`;

    // Attach drag listeners to cards
    colEl.querySelectorAll('.prod-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        prodDragging = card.dataset.id;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        prodDragging = null;
      });
    });

    // Attach touch listeners for mobile
    colEl.querySelectorAll('.prod-card').forEach(card => attachTouchDrag(card));

    // Attach inline note edit
    colEl.querySelectorAll('.prod-notes').forEach(el => {
      el.addEventListener('click', () => startNoteEdit(el));
    });
  }

  if (window.lucide) lucide.createIcons();
  updateProdMobileView();
}

function renderProdCard(c) {
  const today    = new Date().toISOString().slice(0, 10);
  const due      = c.due_date || '';
  const daysLeft = due ? Math.round((new Date(due) - new Date(today)) / 86400000) : null;

  let dueCls = 'prod-due-ok';
  let dueStr = '';
  if (daysLeft !== null) {
    if      (daysLeft < 0)  { dueCls = 'prod-due-late';  dueStr = `VĖLUOJA ${Math.abs(daysLeft)}d`; }
    else if (daysLeft <= 3) { dueCls = 'prod-due-soon';  dueStr = `${daysLeft}d`; }
    else                    { dueStr = `${daysLeft}d`; }
  }

  const badge  = STORE_BADGE[c.store_id] || { label: c.store_id || '?' };
  const imgHtml = c.product_image
    ? `<img class="prod-card-img" src="${escHtml(c.product_image)}" alt="" loading="lazy">`
    : `<div class="prod-card-img prod-card-img-placeholder"><i data-lucide="leaf"></i></div>`;

  const sizeHtml = c.product_size
    ? `<span class="prod-card-size">${escHtml(c.product_size)}</span>`
    : '';

  const notesText = c.notes || '';

  return `
<div class="prod-card" data-id="${c.id}" draggable="true">
  <div class="prod-card-drag-handle">⠿</div>
  ${imgHtml}
  <div class="prod-card-body">
    <div class="prod-card-name">${escHtml(c.product_name || 'Produktas')}</div>
    ${sizeHtml}
    <div class="prod-card-meta">
      <span class="prod-card-flag">${escHtml(c.country_flag || '')}</span>
      <span class="prod-card-store-badge">${badge.label}</span>
      ${c.order_number ? `<span class="prod-card-order">${escHtml(c.order_number)}</span>` : ''}
    </div>
    <div class="prod-card-due-row">
      <span class="prod-card-due-date">${due}</span>
      ${daysLeft !== null ? `<span class="prod-due-badge ${dueCls}">${dueStr}</span>` : ''}
    </div>
    <div class="prod-notes" data-id="${c.id}" title="Klik. redaguoti pastabas">${escHtml(notesText) || '<span class="prod-notes-placeholder">Pastabos…</span>'}</div>
  </div>
  <div class="prod-card-stage-select">
    <select onchange="moveProdCard(${c.id}, this.value)">
      ${PROD_STAGES.map(s => `<option value="${s.id}"${s.id === c.stage ? ' selected' : ''}>${s.label}</option>`).join('')}
    </select>
  </div>
</div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Drag-and-drop handlers
function prodDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('prod-col-over');
}

function prodDrop(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove('prod-col-over');
  if (!prodDragging) return;
  const newStage = col.dataset.stage;
  moveProdCard(parseInt(prodDragging, 10), newStage);
}

document.addEventListener('dragover', e => {
  document.querySelectorAll('.prod-col').forEach(c => {
    if (!c.contains(e.target)) c.classList.remove('prod-col-over');
  });
});

async function moveProdCard(id, stage) {
  try {
    await api(`/api/production/${id}`, { method: 'PATCH', body: { stage } });
    loadProduction();
  } catch {
    showToast('Klaida keičiant etapą', 'error');
  }
}

// Inline note editing
function startNoteEdit(el) {
  if (el.querySelector('textarea')) return;
  const id      = el.dataset.id;
  const current = el.dataset.noteVal || el.textContent.replace('Pastabos…', '').trim();
  el.innerHTML  = `<textarea class="prod-note-input" rows="2">${escHtml(current)}</textarea>`;
  const ta = el.querySelector('textarea');
  ta.focus();
  ta.addEventListener('blur', () => saveNote(id, ta.value, el));
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
}

async function saveNote(id, notes, el) {
  el.dataset.noteVal = notes;
  el.innerHTML = notes ? escHtml(notes) : '<span class="prod-notes-placeholder">Pastabos…</span>';
  try {
    await api(`/api/production/${id}`, { method: 'PATCH', body: { notes } });
  } catch {
    showToast('Klaida išsaugant pastabas', 'error');
  }
}

// Touch drag for mobile (stage select is the primary mobile UX, touch drag as bonus)
function attachTouchDrag(card) {
  let startX, startY, clone, origParent;

  card.addEventListener('touchstart', e => {
    if (e.target.closest('select, textarea, .prod-notes')) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    origParent = card.parentNode;

    setTimeout(() => {
      clone = card.cloneNode(true);
      clone.style.cssText = `position:fixed;opacity:.8;pointer-events:none;z-index:9999;width:${card.offsetWidth}px;left:${t.clientX - card.offsetWidth/2}px;top:${t.clientY - 30}px`;
      document.body.appendChild(clone);
      card.style.opacity = '.3';
    }, 150);
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (!clone) return;
    e.preventDefault();
    const t = e.touches[0];
    clone.style.left = `${t.clientX - parseInt(clone.style.width)/2}px`;
    clone.style.top  = `${t.clientY - 30}px`;
    document.querySelectorAll('.prod-col').forEach(col => col.classList.remove('prod-col-over'));
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const targetCol = el?.closest('.prod-col');
    if (targetCol) targetCol.classList.add('prod-col-over');
  }, { passive: false });

  card.addEventListener('touchend', e => {
    if (!clone) return;
    const t = e.changedTouches[0];
    clone.remove(); clone = null;
    card.style.opacity = '';
    document.querySelectorAll('.prod-col').forEach(col => col.classList.remove('prod-col-over'));
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const targetCol = el?.closest('.prod-col');
    if (targetCol && targetCol.dataset.stage !== origParent.closest('.prod-col')?.dataset.stage) {
      moveProdCard(parseInt(card.dataset.id, 10), targetCol.dataset.stage);
    }
  });
}

// Mobile: show only active stage column
function updateProdMobileView() {
  const board = document.getElementById('prod-board');
  if (!board) return;
  const isMobile = window.innerWidth < 768;
  document.querySelectorAll('.prod-col').forEach(col => {
    col.style.display = isMobile && col.dataset.stage !== activeProdStage ? 'none' : '';
  });
}

window.addEventListener('resize', updateProdMobileView);
