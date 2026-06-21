'use strict';

let todosData = [];
let todosStats = {};
let todoFilter = { status: 'all', priority: 'all' };
let todoQuickPriority = 'medium';
let _editTodoId = null;

// ── Init ──────────────────────────────────────────────────────────────────────

function initTodos() {
  setupTodoQuickAdd();
  loadTodos();
}

function setupTodoQuickAdd() {
  const input = document.getElementById('todo-quick-input');
  if (!input || input._todoSetup) return;
  input._todoSetup = true;

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') todoQuickAdd();
  });

  document.getElementById('todo-priority-dots').addEventListener('click', e => {
    const dot = e.target.closest('[data-priority]');
    if (!dot) return;
    todoQuickPriority = dot.dataset.priority;
    document.querySelectorAll('#todo-priority-dots [data-priority]').forEach(d => d.classList.remove('active'));
    dot.classList.add('active');
  });

  // 'n' shortcut to focus quick-add
  document.addEventListener('keydown', e => {
    if (e.key === 'n' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      const v = document.getElementById('view-todos');
      if (v && !v.hidden) {
        e.preventDefault();
        input.focus();
      }
    }
  });
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadTodos() {
  try {
    const p = new URLSearchParams();
    if (todoFilter.status !== 'all') p.set('status', todoFilter.status);
    if (todoFilter.priority !== 'all') p.set('priority', todoFilter.priority);
    const sort = document.getElementById('todo-sort')?.value || 'created';
    p.set('sort', sort);

    const { todos, stats } = await api(`/api/todos?${p}`);
    todosData = todos || [];
    todosStats = stats || {};
    renderTodoStats();
    renderTodoList();
  } catch (err) {
    toast('Klaida kraunant užduotis: ' + err.message, 'error');
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function renderTodoStats() {
  const s = todosStats;
  document.getElementById('todo-stat-active').textContent = s.active ?? 0;
  document.getElementById('todo-stat-overdue').textContent = s.overdue ?? 0;
  document.getElementById('todo-stat-week').textContent = s.completed_week ?? 0;
  document.getElementById('todo-stat-high').textContent = s.high_priority ?? 0;
}

// ── Render List ───────────────────────────────────────────────────────────────

function renderTodoList() {
  const container = document.getElementById('todos-list');
  const emptyEl = document.getElementById('todos-empty');

  const active = todosData.filter(t => t.status !== 'completed');
  const completed = todosData.filter(t => t.status === 'completed');

  if (!todosData.length) {
    container.innerHTML = '';
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Group active tasks
  const groups = [
    { key: 'overdue',  label: 'Vėluoja',    tasks: active.filter(t => t.due_date && t.due_date < today) },
    { key: 'today',    label: 'Šiandien',   tasks: active.filter(t => t.due_date === today) },
    { key: 'week',     label: 'Šią savaitę',tasks: active.filter(t => t.due_date && t.due_date > today && t.due_date <= weekEnd) },
    { key: 'later',    label: 'Vėliau',     tasks: active.filter(t => t.due_date && t.due_date > weekEnd) },
    { key: 'nodate',   label: 'Be termino', tasks: active.filter(t => !t.due_date) },
  ];

  let html = '';
  for (const g of groups) {
    if (!g.tasks.length) continue;
    const headerClass = g.key === 'overdue' ? 'todo-group-header overdue' : 'todo-group-header';
    html += `<div class="todo-group">
      <div class="${headerClass}">${esc(g.label)}</div>
      ${g.tasks.map(t => renderTodoRow(t, today)).join('')}
    </div>`;
  }

  // Completed section (collapsed by default)
  if (completed.length) {
    html += `<details class="todo-completed-section" id="todos-completed-details">
      <summary class="todo-completed-summary">Užbaigtos (${completed.length})</summary>
      <div class="todo-group todo-group-completed">
        ${completed.map(t => renderTodoRow(t, today)).join('')}
      </div>
    </details>`;
  }

  container.innerHTML = html;
}

function renderTodoRow(t, today) {
  const isDone = t.status === 'completed';
  const dueHtml = renderDueDate(t.due_date, today, isDone);
  const priBadge = renderPriorityBadge(t.priority);
  const catTag = t.category ? `<span class="todo-category-tag">${esc(t.category)}</span>` : '';

  return `<div class="todo-row${isDone ? ' todo-row-done' : ''}" data-id="${t.id}" onclick="openTodoEdit(${t.id})">
    <button class="todo-checkbox${isDone ? ' checked' : ''}" onclick="event.stopPropagation();toggleTodo(${t.id}, ${isDone})" title="${isDone ? 'Atnaujinti' : 'Pažymėti užbaigta'}">
      ${isDone ? '<svg viewBox="0 0 12 12" fill="none" width="12" height="12"><path d="M2 6l3 3 5-5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
    </button>
    <div class="todo-row-body">
      <span class="todo-row-title${isDone ? ' done-text' : ''}">${esc(t.title)}</span>
      <div class="todo-row-meta">
        ${priBadge}
        ${dueHtml}
        ${catTag}
      </div>
    </div>
    <div class="todo-row-actions">
      <button class="todo-action-btn" onclick="event.stopPropagation();openTodoEdit(${t.id})" title="Redaguoti">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="todo-action-btn todo-action-delete" onclick="event.stopPropagation();deleteTodo(${t.id})" title="Ištrinti">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>
  </div>`;
}

function renderDueDate(due_date, today, isDone) {
  if (!due_date || isDone) return '';
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const diff = Math.round((new Date(due_date) - new Date(today)) / 86400000);
  let cls = 'todo-due';
  let label = new Date(due_date).toLocaleDateString('lt-LT', { month: 'short', day: 'numeric' });

  if (diff < 0) {
    cls = 'todo-due overdue';
    label += ` · Vėluoja ${-diff}d`;
  } else if (diff === 0) {
    cls = 'todo-due today';
    label = 'Šiandien';
  } else if (diff === 1) {
    cls = 'todo-due soon';
    label = 'Rytoj';
  }

  return `<span class="${cls}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    ${esc(label)}
  </span>`;
}

function renderPriorityBadge(priority) {
  const map = {
    high:   { cls: 'todo-pri-badge high',   label: 'Aukštas' },
    medium: { cls: 'todo-pri-badge medium', label: 'Vidutinis' },
    low:    { cls: 'todo-pri-badge low',    label: 'Žemas' },
  };
  const m = map[priority] || map.medium;
  return `<span class="${m.cls}">${m.label}</span>`;
}

// ── Quick Add ─────────────────────────────────────────────────────────────────

async function todoQuickAdd() {
  const input = document.getElementById('todo-quick-input');
  const title = input.value.trim();
  if (!title) { input.focus(); return; }

  const due_date = document.getElementById('todo-quick-due').value || null;

  try {
    await api('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ title, priority: todoQuickPriority, due_date }),
    });
    input.value = '';
    document.getElementById('todo-quick-due').value = '';
    await loadTodos();
    toast('Užduotis pridėta');
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Toggle complete ────────────────────────────────────────────────────────────

async function toggleTodo(id, isDone) {
  const newStatus = isDone ? 'pending' : 'completed';
  const row = document.querySelector(`.todo-row[data-id="${id}"]`);

  try {
    await api(`/api/todos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    await loadTodos();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function openTodoEdit(id) {
  const t = todosData.find(x => x.id === id);
  if (!t) return;
  _editTodoId = id;

  document.getElementById('todo-edit-title').value = t.title;
  document.getElementById('todo-edit-desc').value = t.description || '';
  document.getElementById('todo-edit-priority').value = t.priority || 'medium';
  document.getElementById('todo-edit-due').value = t.due_date || '';
  document.getElementById('todo-edit-category').value = t.category || '';
  document.getElementById('todo-edit-modal').hidden = false;
}

function closeTodoEditModal() {
  document.getElementById('todo-edit-modal').hidden = true;
  _editTodoId = null;
}

async function saveTodoEdit() {
  if (!_editTodoId) return;
  const title = document.getElementById('todo-edit-title').value.trim();
  if (!title) { toast('Pavadinimas būtinas', 'error'); return; }

  const data = {
    title,
    description: document.getElementById('todo-edit-desc').value.trim(),
    priority: document.getElementById('todo-edit-priority').value,
    due_date: document.getElementById('todo-edit-due').value || null,
    category: document.getElementById('todo-edit-category').value.trim() || null,
  };

  try {
    await api(`/api/todos/${_editTodoId}`, { method: 'PATCH', body: JSON.stringify(data) });
    toast('Užduotis atnaujinta');
    closeTodoEditModal();
    await loadTodos();
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

async function deleteTodoFromModal() {
  if (!_editTodoId) return;
  if (!confirm('Ištrinti šią užduotį?')) return;
  await deleteTodo(_editTodoId);
  closeTodoEditModal();
}

async function deleteTodo(id) {
  try {
    await api(`/api/todos/${id}`, { method: 'DELETE' });
    todosData = todosData.filter(t => t.id !== id);
    renderTodoList();
    toast('Užduotis ištrinta');
  } catch (err) {
    toast('Klaida: ' + err.message, 'error');
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

function setTodoStatusFilter(status, btn) {
  todoFilter.status = status;
  document.querySelectorAll('[data-todo-status]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadTodos();
}

function setTodoPriFilter(priority, btn) {
  todoFilter.priority = priority;
  document.querySelectorAll('[data-todo-pri]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadTodos();
}
