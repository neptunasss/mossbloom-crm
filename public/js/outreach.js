'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// Outreach UI — dashboard, campaigns, leads, inbox, mailboxes, suppressions.
// Uses shared helpers from app.js: api(), esc(), toast(), switchView().
// ══════════════════════════════════════════════════════════════════════════════

const OR = {
  dashTimer: null,
  leads: { offset: 0, limit: 50, status: 'all', search: '', industry: 'all', city: 'all', list_name: 'all', selected: new Set(), allMatching: false, allFilter: null, total: 0 },
  inbox: { filter: 'untagged', offset: 0, limit: 30, items: [] },
  campaignId: null,      // open in editor, null = list
  editorTab: 'settings',
  steps: [],             // sequence being edited
  lastFocus: null,       // { stepIdx, field } for token insertion
  suppressions: [],
};

const OR_STATUS = {
  active:       ['#e8faf0', '#248a3d'],
  warmup:       ['#fff5e6', '#b25f00'],
  paused:       ['#fff0ef', '#cc2f26'],
  draft:        ['rgba(0,0,0,0.06)', '#3a3a3c'],
  completed:    ['#e8f2ff', '#0058d0'],
  new:          ['rgba(0,0,0,0.06)', '#3a3a3c'],
  pending:      ['#fffbe6', '#8a6d00'],
  queued:       ['#e8f2ff', '#0058d0'],
  contacted:    ['#e8f2ff', '#0058d0'],
  replied:      ['#e8faf0', '#248a3d'],
  bounced:      ['#fff0ef', '#cc2f26'],
  unsubscribed: ['#f5eeff', '#8a2be2'],
  skipped:      ['rgba(0,0,0,0.06)', '#86868b'],
  failed:       ['#fff0ef', '#cc2f26'],
};

const SENTIMENT = {
  positive:    { label: 'Positive',    icon: '👍', cls: 'pos' },
  neutral:     { label: 'Neutral',     icon: '😐', cls: 'neu' },
  negative:    { label: 'Negative',    icon: '👎', cls: 'neg' },
  unsubscribe: { label: 'Unsubscribe', icon: '🚫', cls: 'uns' },
};

const LEAD_FIELDS = [
  ['email', 'Email *'], ['first_name', 'First name'], ['last_name', 'Last name'],
  ['company_name', 'Company'], ['city', 'City'], ['country', 'Country'],
  ['phone', 'Phone'], ['website', 'Website'], ['industry', 'Industry'],
];

// ── Shared bits ───────────────────────────────────────────────────────────────

function orBadge(status) {
  const [bg, fg] = OR_STATUS[status] || ['rgba(0,0,0,0.06)', '#3a3a3c'];
  return `<span class="status-badge" style="background:${bg};color:${fg}">${esc(status || '—')}</span>`;
}

// DB timestamps are UTC 'YYYY-MM-DD HH:MM:SS'
function orDate(sql, withTime = true) {
  if (!sql) return '—';
  const d = new Date(String(sql).replace(' ', 'T') + (String(sql).includes('Z') ? '' : 'Z'));
  if (isNaN(d)) return esc(sql);
  return d.toLocaleString('lt-LT', withTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function orAgo(sql) {
  return sql ? timeAgo(String(sql).replace(' ', 'T') + 'Z') : '—';
}

function orRoot(view) { return document.getElementById(`or-${view}-root`); }

function orIcons() { if (window.lucide) lucide.createIcons(); }

function orModal({ title, body, buttons = [], wide = false }) {
  document.getElementById('or-modal-title').textContent = title;
  document.getElementById('or-modal-body').innerHTML = body;
  const footer = document.getElementById('or-modal-footer');
  footer.innerHTML = '';
  footer.hidden = !buttons.length;
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = b.cls || 'btn-secondary';
    el.textContent = b.label;
    el.onclick = b.onClick;
    footer.appendChild(el);
  }
  document.getElementById('or-modal-box').classList.toggle('or-modal-wide', wide);
  document.getElementById('or-modal').hidden = false;
}

function orCloseModal() {
  document.getElementById('or-modal').hidden = true;
}

// Promise<boolean> confirmation built on the modal (no native confirm())
function orConfirm(title, html, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    orModal({
      title,
      body: html,
      buttons: [
        { label: 'Cancel', onClick: () => { orCloseModal(); resolve(false); } },
        { label: okLabel, cls: danger ? 'btn-primary or-btn-danger' : 'btn-primary', onClick: () => { orCloseModal(); resolve(true); } },
      ],
    });
  });
}

function orFormValues(container) {
  const out = {};
  container.querySelectorAll('[name]').forEach(el => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  });
  return out;
}

// ── View lifecycle ────────────────────────────────────────────────────────────

function orOnView(view) {
  clearInterval(OR.dashTimer);
  OR.dashTimer = null;
  if (!view.startsWith('or-')) return;

  if (view === 'or-dashboard') {
    orLoadDashboard();
    OR.dashTimer = setInterval(() => {
      if (!document.hidden) orLoadDashboard(true);
    }, 30000);
  }
  if (view === 'or-campaigns')    OR.campaignId ? orOpenCampaign(OR.campaignId) : orLoadCampaigns();
  if (view === 'or-leads')        orLoadLeads();
  if (view === 'or-inbox')        orLoadInbox(true);
  if (view === 'or-mailboxes')    orLoadMailboxes();
  if (view === 'or-suppressions') orLoadSuppressions();
}

function orUpdateInboxBadge(n) {
  const b = document.getElementById('or-inbox-badge');
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

async function orLoadDashboard(silent = false) {
  const root = orRoot('dashboard');
  if (!silent && !root.innerHTML) root.innerHTML = '<div class="or-loading">Loading…</div>';
  try {
    const [dash, { log }] = await Promise.all([
      api('/api/outreach/dashboard'),
      api('/api/outreach/worker-log?limit=50'),
    ]);
    orRenderDashboard(dash, log);
    orUpdateInboxBadge(dash.kpis.untagged);
  } catch (err) {
    if (!silent) root.innerHTML = `<div class="or-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

function orRenderDashboard({ settings, kpis, mailboxes }, log) {
  const paused = settings.global_paused;
  const dry = settings.dry_run;

  const kpi = (label, value, sub = '', tone = '') => `
    <div class="prod-stat-card or-kpi ${tone}">
      <span class="prod-stat-label">${label}</span>
      <span class="prod-stat-value">${value}</span>
      ${sub ? `<span class="prod-stat-name">${sub}</span>` : ''}
    </div>`;

  const bounceTone = kpis.bounce_rate > 5 ? 'or-kpi-bad' : kpis.bounce_rate > 2 ? 'or-kpi-warn' : '';

  const mbRows = mailboxes.map(m => {
    const pct = m.effective_limit ? Math.min(100, Math.round(m.sent_today / m.effective_limit * 100)) : 0;
    const warm = m.warmup_mode
      ? `<div class="or-progress" title="Warmup day ${m.warmup_day}/18"><div style="width:${Math.min(100, m.warmup_day / 18 * 100)}%"></div></div>
         <span class="or-muted">day ${m.warmup_day}/18</span>`
      : '<span class="or-muted">done</span>';
    const err = m.pause_reason
      ? `<span class="or-err-text" title="${esc(m.pause_reason)}">${esc(m.pause_reason)}</span>`
      : m.last_error
        ? `<span class="or-err-text" title="${esc(m.last_error)}">${esc(m.last_error)}</span> <span class="or-muted">${orAgo(m.last_error_at)}</span>`
        : '<span class="or-muted">—</span>';
    return `<tr>
      <td class="col-customer">${esc(m.email)}</td>
      <td>${orBadge(m.status)}</td>
      <td>
        <div class="or-limit"><span>${m.sent_today} / ${m.effective_limit ?? '—'}</span>
        <div class="or-progress or-progress-sm"><div style="width:${pct}%"></div></div></div>
      </td>
      <td><div class="or-warm-cell">${warm}</div></td>
      <td class="${m.bounce_rate > 5 ? 'or-err-text' : ''}">${(m.bounce_rate || 0).toFixed(1)}%</td>
      <td class="or-err-cell">${err}</td>
    </tr>`;
  }).join('');

  const logLines = log.map(l => `
    <div class="or-log-line or-log-${esc(l.level)}">
      <span class="or-log-ts">${orDate(l.timestamp)}</span>
      <span class="or-log-lvl">${esc(l.level)}</span>
      ${l.mailbox_id ? `<span class="or-log-mb">mb ${l.mailbox_id}</span>` : ''}
      <span class="or-log-msg">${esc(l.message)}</span>
    </div>`).join('');

  orRoot('dashboard').innerHTML = `
    <div class="or-topbar ${paused ? 'is-paused' : ''}">
      <div class="or-topbar-state">
        <span class="or-state-dot"></span>
        <div>
          <div class="or-state-title">${paused ? 'All outreach is PAUSED' : 'Outreach is running'}</div>
          <div class="or-state-sub">${paused ? 'The worker sends nothing until you resume.' : `${kpis.pending} email(s) queued · weekdays 08:00–17:00 Vilnius`}</div>
        </div>
        ${dry ? '<span class="or-dry-badge" title="The worker logs what it would send but sends nothing">DRY RUN</span>' : '<span class="or-live-badge">LIVE</span>'}
      </div>
      <div class="or-topbar-actions">
        <label class="or-switch" title="Dry run: log instead of sending">
          <input type="checkbox" ${dry ? 'checked' : ''} onchange="orToggleDryRun(this)">
          <span class="or-switch-track"></span>
          <span>Dry run</span>
        </label>
        <button class="or-pause-btn ${paused ? 'is-paused' : ''}" onclick="orTogglePause(${paused})">
          ${paused ? '▶ Resume outreach' : '⏸ Pause all outreach'}
        </button>
      </div>
    </div>

    <div class="or-kpi-grid">
      ${kpi('Sent today', kpis.sent_today)}
      ${kpi('Sent this week', kpis.sent_week, `${kpis.sent_total} total`)}
      ${kpi('Replies', kpis.replies, kpis.untagged ? `<a href="#" onclick="switchView('or-inbox');return false">${kpis.untagged} to tag →</a>` : '')}
      ${kpi('Positive', kpis.positive, '', kpis.positive ? 'or-kpi-good' : '')}
      ${kpi('Bounces', kpis.bounces)}
      ${kpi('Bounce rate', `${kpis.bounce_rate}%`, 'pause above 5%', bounceTone)}
      ${kpi('Unsubscribes', kpis.unsubscribes)}
    </div>

    <div class="or-card">
      <div class="or-card-head">
        <h3>Mailbox health</h3>
        <a href="#" class="or-link" onclick="switchView('or-mailboxes');return false">Manage →</a>
      </div>
      ${mailboxes.length ? `
      <div class="table-wrap or-flat">
        <table class="orders-table">
          <thead><tr><th>Mailbox</th><th>Status</th><th>Sent today / limit</th><th>Warmup</th><th>Bounce</th><th>Last error</th></tr></thead>
          <tbody>${mbRows}</tbody>
        </table>
      </div>` : '<div class="or-empty">No mailboxes yet. <a href="#" class="or-link" onclick="switchView(\'or-mailboxes\');return false">Add one →</a></div>'}
    </div>

    <div class="or-card">
      <div class="or-card-head">
        <h3>Worker log</h3>
        <span class="or-muted">latest 50 · auto-refresh 30s · updated ${new Date().toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      </div>
      <div class="or-log">${logLines || '<div class="or-empty">No log entries yet — is the worker running?</div>'}</div>
    </div>`;
}

async function orTogglePause(currentlyPaused) {
  try {
    await api(`/api/outreach/queue/${currentlyPaused ? 'resume-all' : 'pause-all'}`, { method: 'POST' });
    toast(currentlyPaused ? 'Outreach resumed' : 'All outreach paused');
    orLoadDashboard(true);
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orToggleDryRun(input) {
  const wantDry = input.checked;
  input.checked = !wantDry; // revert until confirmed / saved
  if (!wantDry) {
    const ok = await orConfirm('Turn off dry run?', `
      <p class="or-confirm-lead">The worker will start <strong>sending real emails</strong> in the next send window
      (weekdays 08:00–17:00 Vilnius).</p>
      <ul class="or-confirm-list">
        <li>Check that every mailbox passes <em>Test SMTP</em> and <em>Test IMAP</em>.</li>
        <li>Check the dry-run previews in the worker log look right.</li>
        <li>You can pause everything at any time with <em>Pause all outreach</em>.</li>
      </ul>`, { okLabel: 'Yes, start sending for real', danger: true });
    if (!ok) return;
  }
  try {
    await api('/api/outreach/settings/dry-run', { method: 'POST', body: JSON.stringify({ dry_run: wantDry }) });
    toast(wantDry ? 'Dry run ON — nothing will be sent' : 'Dry run OFF — live sending enabled');
    orLoadDashboard(true);
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. MAILBOXES
// ══════════════════════════════════════════════════════════════════════════════

let orDomains = [];
let orMailboxes = [];

async function orLoadMailboxes() {
  const root = orRoot('mailboxes');
  if (!root.innerHTML) root.innerHTML = '<div class="or-loading">Loading…</div>';
  try {
    const [{ domains }, { mailboxes }] = await Promise.all([
      api('/api/outreach/domains'),
      api('/api/outreach/mailboxes'),
    ]);
    orDomains = domains;
    orMailboxes = mailboxes;
    orRenderMailboxes();
  } catch (err) {
    root.innerHTML = `<div class="or-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

function orRenderMailboxes() {
  const groups = orDomains.map(d => ({ domain: d, boxes: orMailboxes.filter(m => m.domain_id === d.id) }));
  const orphans = orMailboxes.filter(m => !orDomains.some(d => d.id === m.domain_id));
  if (orphans.length) groups.push({ domain: null, boxes: orphans });

  const mbRow = (m) => {
    const warm = m.warmup_mode ? `
      <div class="or-mb-warm">
        <div class="or-progress"><div style="width:${Math.min(100, m.warmup_day / 18 * 100)}%"></div></div>
        <span class="or-muted">Warmup day ${m.warmup_day}/18 · ${m.effective_limit}/day today</span>
      </div>` : `<span class="or-muted">${m.daily_limit}/day · ${m.hourly_limit}/hour</span>`;
    const paused = m.status === 'paused';
    return `
      <div class="or-mb-row">
        <div class="or-mb-main">
          <div class="or-mb-email">${esc(m.email)} ${orBadge(m.status)}</div>
          <div class="or-muted">${esc(m.display_name || '')}${m.display_name ? ' · ' : ''}sent today ${m.sent_today}/${m.effective_limit ?? '—'} · bounce ${(m.bounce_rate || 0).toFixed(1)}%</div>
          ${warm}
          ${paused && m.pause_reason ? `<div class="or-err-text or-mb-reason">Paused: ${esc(m.pause_reason)}</div>` : ''}
          <div class="or-test-result" id="or-test-${m.id}"></div>
        </div>
        <div class="or-mb-actions">
          <button class="btn-secondary or-btn-sm" onclick="orTestMailbox(${m.id},'smtp')">Test SMTP</button>
          <button class="btn-secondary or-btn-sm" onclick="orTestMailbox(${m.id},'imap')">Test IMAP</button>
          <button class="btn-secondary or-btn-sm" onclick="orMailboxPause(${m.id},${paused})">${paused ? 'Resume' : 'Pause'}</button>
          <button class="btn-row-action" title="Edit" onclick="orEditMailbox(${m.id})"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
          <button class="btn-row-action btn-row-delete" title="Delete" onclick="orDeleteMailbox(${m.id})"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
        </div>
      </div>`;
  };

  const groupHtml = groups.map(({ domain: d, boxes }) => `
    <div class="or-card">
      <div class="or-card-head">
        <div>
          <h3>${d ? esc(d.domain) : 'No domain'}</h3>
          ${d ? `<span class="or-muted">${d.daily_limit}/day domain limit · ${boxes.length} mailbox${boxes.length === 1 ? '' : 'es'}</span> ${d.status !== 'active' ? orBadge(d.status) : ''}` : ''}
        </div>
        ${d ? `<div class="or-mb-actions">
          <button class="btn-secondary or-btn-sm" onclick="orEditMailbox(null, ${d.id})">+ Mailbox</button>
          <button class="btn-row-action" title="Edit domain" onclick="orEditDomain(${d.id})"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
          <button class="btn-row-action btn-row-delete" title="Delete domain" onclick="orDeleteDomain(${d.id})"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
        </div>` : ''}
      </div>
      ${boxes.length ? boxes.map(mbRow).join('') : '<div class="or-empty">No mailboxes on this domain yet.</div>'}
    </div>`).join('');

  orRoot('mailboxes').innerHTML = `
    <div class="filters-bar">
      <span class="or-muted">${orMailboxes.length} mailbox${orMailboxes.length === 1 ? '' : 'es'} on ${orDomains.length} domain${orDomains.length === 1 ? '' : 's'}</span>
      <div class="filter-controls">
        <button class="btn-secondary" onclick="orEditDomain(null)">+ Domain</button>
        <button class="btn-primary" onclick="orEditMailbox(null)">+ Mailbox</button>
      </div>
    </div>
    ${groupHtml || `<div class="empty-state"><h3>No sending domains yet</h3><p>Add a domain, then add the mailboxes that send from it.</p><button class="btn-primary" onclick="orEditDomain(null)">+ Domain</button></div>`}`;
  orIcons();
}

async function orTestMailbox(id, kind) {
  const el = document.getElementById(`or-test-${id}`);
  el.className = 'or-test-result is-loading';
  el.textContent = `Testing ${kind.toUpperCase()}…`;
  try {
    const r = await api(`/api/outreach/mailboxes/${id}/test-${kind}`, { method: 'POST' });
    el.className = `or-test-result ${r.ok ? 'is-ok' : 'is-err'}`;
    el.textContent = `${kind.toUpperCase()}: ${r.ok ? '✓ ' + (r.message || 'OK') : '✗ ' + r.error}`;
  } catch (err) {
    el.className = 'or-test-result is-err';
    el.textContent = `${kind.toUpperCase()}: ✗ ${err.message}`;
  }
}

async function orMailboxPause(id, isPaused) {
  try {
    await api(`/api/outreach/mailboxes/${id}/${isPaused ? 'resume' : 'pause'}`, { method: 'POST' });
    toast(isPaused ? 'Mailbox resumed' : 'Mailbox paused');
    orLoadMailboxes();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

function orEditDomain(id) {
  const d = orDomains.find(x => x.id === id) || { domain: '', daily_limit: 100, status: 'active' };
  orModal({
    title: id ? 'Edit domain' : 'New domain',
    body: `<div id="or-dom-form">
      <div class="form-group"><label>Domain *</label><input name="domain" value="${esc(d.domain)}" placeholder="mossbloom-mail.lt"></div>
      <div class="form-row">
        <div class="form-group"><label>Daily limit (all mailboxes)</label><input name="daily_limit" type="number" min="0" value="${d.daily_limit}"></div>
        <div class="form-group"><label>Status</label>
          <select name="status">
            <option value="active" ${d.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="paused" ${d.status === 'paused' ? 'selected' : ''}>Paused</option>
          </select>
        </div>
      </div>
    </div>`,
    buttons: [
      { label: 'Cancel', onClick: orCloseModal },
      { label: 'Save', cls: 'btn-primary', onClick: async () => {
        const v = orFormValues(document.getElementById('or-dom-form'));
        if (!v.domain.trim()) return toast('Domain is required', 'error');
        const body = JSON.stringify({ domain: v.domain.trim(), daily_limit: parseInt(v.daily_limit, 10) || 0, status: v.status });
        try {
          await api(id ? `/api/outreach/domains/${id}` : '/api/outreach/domains', { method: id ? 'PUT' : 'POST', body });
          orCloseModal(); toast('Domain saved'); orLoadMailboxes();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      } },
    ],
  });
}

async function orDeleteDomain(id) {
  const d = orDomains.find(x => x.id === id);
  if (!await orConfirm('Delete domain?', `<p>Delete <strong>${esc(d?.domain)}</strong>? Its mailboxes are kept but no longer grouped under it.</p>`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/outreach/domains/${id}`, { method: 'DELETE' }); toast('Domain deleted'); orLoadMailboxes(); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

// Password field: saved passwords are never shown — only "••••••" + Replace
function orPassField(name, label, hasSaved) {
  if (!hasSaved) {
    return `<div class="form-group"><label>${label}</label><input name="${name}" type="password" autocomplete="new-password"></div>`;
  }
  return `<div class="form-group"><label>${label}</label>
    <div class="or-pass-saved" id="or-pass-${name}">
      <span class="or-pass-dots">••••••</span>
      <button type="button" class="btn-secondary or-btn-sm" onclick="orReplacePass('${name}')">Replace</button>
    </div></div>`;
}

function orReplacePass(name) {
  const wrap = document.getElementById(`or-pass-${name}`);
  wrap.innerHTML = `<input name="${name}" type="password" autocomplete="new-password" placeholder="New password">
    <button type="button" class="btn-secondary or-btn-sm" onclick="orKeepPass('${name}')">Keep saved</button>`;
  wrap.querySelector('input').focus();
}

function orKeepPass(name) {
  document.getElementById(`or-pass-${name}`).innerHTML = `<span class="or-pass-dots">••••••</span>
    <button type="button" class="btn-secondary or-btn-sm" onclick="orReplacePass('${name}')">Replace</button>`;
}

function orEditMailbox(id, domainId) {
  const m = orMailboxes.find(x => x.id === id) || {
    domain_id: domainId ?? orDomains[0]?.id ?? null, email: '', display_name: '',
    smtp_host: '', smtp_port: 465, smtp_user: '', imap_host: '', imap_port: 993, imap_user: '',
    daily_limit: 30, hourly_limit: 5, warmup_mode: 1, warmup_day: 0, warmup_start_limit: 3, warmup_end_limit: 30,
  };
  const domOpts = `<option value="">— none —</option>` + orDomains.map(d =>
    `<option value="${d.id}" ${d.id === m.domain_id ? 'selected' : ''}>${esc(d.domain)}</option>`).join('');

  orModal({
    title: id ? `Edit ${m.email}` : 'New mailbox',
    wide: true,
    body: `<div id="or-mb-form">
      <div class="form-row">
        <div class="form-group"><label>Email *</label><input name="email" type="email" value="${esc(m.email)}"></div>
        <div class="form-group"><label>Display name</label><input name="display_name" value="${esc(m.display_name || '')}" placeholder="Simonas iš Mossbloom"></div>
      </div>
      <div class="form-group"><label>Domain</label><select name="domain_id">${domOpts}</select></div>

      <div class="or-form-section">SMTP (sending)</div>
      <div class="form-row">
        <div class="form-group"><label>Host</label><input name="smtp_host" value="${esc(m.smtp_host || '')}" placeholder="smtp.example.com"></div>
        <div class="form-group"><label>Port</label><input name="smtp_port" type="number" value="${m.smtp_port ?? ''}" placeholder="465"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Username</label><input name="smtp_user" value="${esc(m.smtp_user || '')}" placeholder="defaults to email"></div>
        ${orPassField('smtp_pass', 'Password', id && m.has_smtp_pass)}
      </div>

      <div class="or-form-section">IMAP (replies &amp; bounces)</div>
      <div class="form-row">
        <div class="form-group"><label>Host</label><input name="imap_host" value="${esc(m.imap_host || '')}" placeholder="imap.example.com"></div>
        <div class="form-group"><label>Port</label><input name="imap_port" type="number" value="${m.imap_port ?? ''}" placeholder="993"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Username</label><input name="imap_user" value="${esc(m.imap_user || '')}" placeholder="defaults to email"></div>
        ${orPassField('imap_pass', 'Password', id && m.has_imap_pass)}
      </div>

      <div class="or-form-section">Limits &amp; warmup</div>
      <div class="form-row">
        <div class="form-group"><label>Daily limit (after warmup)</label><input name="daily_limit" type="number" min="0" value="${m.daily_limit}"></div>
        <div class="form-group"><label>Hourly limit</label><input name="hourly_limit" type="number" min="0" value="${m.hourly_limit}"></div>
      </div>
      <label class="or-check"><input type="checkbox" name="warmup_mode" ${m.warmup_mode ? 'checked' : ''}> Warmup mode (ramp up over 18 days)</label>
      <div class="form-row">
        <div class="form-group"><label>Warmup start /day</label><input name="warmup_start_limit" type="number" min="0" value="${m.warmup_start_limit}"></div>
        <div class="form-group"><label>Warmup end /day</label><input name="warmup_end_limit" type="number" min="0" value="${m.warmup_end_limit}"></div>
      </div>
      <div class="form-group"><label>Warmup day (0–18)</label><input name="warmup_day" type="number" min="0" max="18" value="${m.warmup_day}"></div>
    </div>`,
    buttons: [
      { label: 'Cancel', onClick: orCloseModal },
      { label: 'Save mailbox', cls: 'btn-primary', onClick: () => orSaveMailbox(id) },
    ],
  });
}

async function orSaveMailbox(id) {
  const v = orFormValues(document.getElementById('or-mb-form'));
  if (!v.email.trim()) return toast('Email is required', 'error');
  const num = (x) => (x === '' || x === undefined ? null : parseInt(x, 10));
  const body = {
    email: v.email.trim(), display_name: v.display_name.trim(),
    domain_id: v.domain_id ? parseInt(v.domain_id, 10) : null,
    smtp_host: v.smtp_host.trim(), smtp_port: num(v.smtp_port), smtp_user: v.smtp_user.trim(),
    imap_host: v.imap_host.trim(), imap_port: num(v.imap_port), imap_user: v.imap_user.trim(),
    daily_limit: num(v.daily_limit) ?? 30, hourly_limit: num(v.hourly_limit) ?? 5,
    warmup_mode: v.warmup_mode ? 1 : 0,
    warmup_start_limit: num(v.warmup_start_limit) ?? 3, warmup_end_limit: num(v.warmup_end_limit) ?? 30,
    warmup_day: Math.min(18, Math.max(0, num(v.warmup_day) ?? 0)),
  };
  // Password inputs only exist when new or "Replace" was clicked
  if (v.smtp_pass) body.smtp_pass = v.smtp_pass;
  if (v.imap_pass) body.imap_pass = v.imap_pass;
  if (!id) body.status = body.warmup_mode ? 'warmup' : 'active';
  try {
    await api(id ? `/api/outreach/mailboxes/${id}` : '/api/outreach/mailboxes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    orCloseModal(); toast('Mailbox saved'); orLoadMailboxes();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orDeleteMailbox(id) {
  const m = orMailboxes.find(x => x.id === id);
  if (!await orConfirm('Delete mailbox?', `<p>Delete <strong>${esc(m?.email)}</strong>? Emails queued for it are cancelled and it is removed from campaigns.</p>`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/outreach/mailboxes/${id}`, { method: 'DELETE' }); toast('Mailbox deleted'); orLoadMailboxes(); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. LEADS
// ══════════════════════════════════════════════════════════════════════════════

let orLeadRows = [];
let orLeadSearchTimer;

// ── Segment filters (industry / city / list) shared by Leads page + campaign ──

let orFacets = null;

async function orLoadFacets() {
  try { orFacets = await api('/api/outreach/leads/facets'); }
  catch { orFacets = { industries: [], cities: [], lists: [], none: {} }; }
  return orFacets;
}

const OR_FACET = {
  industry:  { key: 'industries', label: 'Industry', all: 'All industries', none: '(no industry)' },
  city:      { key: 'cities',     label: 'City',     all: 'All cities',     none: '(no city)' },
  list_name: { key: 'lists',      label: 'List',     all: 'All lists',      none: '(no list)' },
};

function orFacetSelect(field, current, attrs) {
  const meta = OR_FACET[field];
  const items = orFacets?.[meta.key] || [];
  const noneCount = orFacets?.none?.[field] || 0;
  return `<select class="filter-select or-facet-select" ${attrs}>
    <option value="all">${meta.all}</option>
    ${items.map(f => `<option value="${esc(f.value)}" ${current === f.value ? 'selected' : ''}>${esc(f.value)} (${f.count})</option>`).join('')}
    ${noneCount ? `<option value="__none__" ${current === '__none__' ? 'selected' : ''}>${meta.none} (${noneCount})</option>` : ''}
  </select>`;
}

// Filter object → query params (skips "all"/empty)
function orFilterParams(f, p = new URLSearchParams()) {
  for (const k of ['status', 'search', 'industry', 'city', 'list_name']) {
    if (f[k] && f[k] !== 'all') p.set(k, f[k]);
  }
  return p;
}

function orFilterSummary(f) {
  const parts = [];
  if (f.status && f.status !== 'all') parts.push(`status: ${f.status}`);
  for (const k of ['industry', 'city', 'list_name']) {
    if (f[k] && f[k] !== 'all') parts.push(`${OR_FACET[k].label.toLowerCase()}: ${f[k] === '__none__' ? OR_FACET[k].none : f[k]}`);
  }
  if (f.search) parts.push(`search: “${f.search}”`);
  return parts.length ? parts.join(' · ') : 'all leads (no filter)';
}

function orLeadFilterNow() {
  const L = OR.leads;
  return { status: L.status, search: L.search, industry: L.industry, city: L.city, list_name: L.list_name };
}

function orRenderLeadsShell() {
  const L = OR.leads;
  orRoot('leads').innerHTML = `
    <div class="filters-bar">
      <div class="filter-controls">
        <select class="filter-select" onchange="orSetLeadFilter('status', this.value)">
          ${['all', 'new', 'contacted', 'replied', 'bounced', 'unsubscribed'].map(s =>
            `<option value="${s}" ${L.status === s ? 'selected' : ''}>${s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
        ${orFacetSelect('industry', L.industry, `onchange="orSetLeadFilter('industry', this.value)"`)}
        ${orFacetSelect('city', L.city, `onchange="orSetLeadFilter('city', this.value)"`)}
        ${orFacetSelect('list_name', L.list_name, `onchange="orSetLeadFilter('list_name', this.value)"`)}
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input type="search" class="search-input" id="or-lead-search" placeholder="Name, company or email" value="${esc(L.search)}" oninput="orLeadSearch(this.value)">
        </div>
      </div>
      <div class="filter-controls">
        <button class="btn-secondary" onclick="orImportStart()">Import CSV</button>
        <button class="btn-primary" onclick="orEditLead(null)">+ Lead</button>
      </div>
    </div>
    <div class="or-bulkbar" id="or-bulkbar" hidden></div>
    <div class="table-wrap" id="or-leads-table"></div>
    <div class="or-pager" id="or-leads-pager"></div>`;
}

function orSetLeadFilter(key, value) {
  OR.leads[key] = value;
  OR.leads.offset = 0;
  OR.leads.allMatching = false; // a new filter means a new segment
  orLoadLeads();
}

function orLeadSearch(value) {
  clearTimeout(orLeadSearchTimer);
  orLeadSearchTimer = setTimeout(() => orSetLeadFilter('search', value.trim()), 280);
}

// Re-render filter dropdowns (e.g. after import added new industries/lists)
async function orRefreshLeadFacets() {
  await orLoadFacets();
  orRoot('leads').innerHTML = '';
  orLoadLeads();
}

async function orLoadLeads() {
  if (!document.getElementById('or-leads-table')) {
    if (!orFacets) await orLoadFacets();
    orRenderLeadsShell();
  }
  const L = OR.leads;
  const p = orFilterParams(orLeadFilterNow(), new URLSearchParams({ limit: L.limit, offset: L.offset }));
  try {
    const { leads, total } = await api(`/api/outreach/leads?${p}`);
    orLeadRows = leads;
    L.total = total;
    orRenderLeads();
  } catch (err) { toast('Failed to load leads: ' + err.message, 'error'); }
}

function orRenderLeads() {
  const L = OR.leads;
  const wrap = document.getElementById('or-leads-table');
  const filtered = L.search || L.status !== 'all' || L.industry !== 'all' || L.city !== 'all' || L.list_name !== 'all';
  if (!orLeadRows.length) {
    wrap.innerHTML = `<div class="empty-state"><h3>No leads found</h3><p>${filtered ? 'Try another filter.' : 'Import a CSV or add leads one by one.'}</p></div>`;
  } else {
    const isSel = (id) => L.allMatching || L.selected.has(id);
    const allOnPage = orLeadRows.every(l => isSel(l.id));
    wrap.innerHTML = `
      <table class="orders-table or-leads-table">
        <thead><tr>
          <th class="or-col-check"><input type="checkbox" ${allOnPage ? 'checked' : ''} ${L.allMatching ? 'disabled' : ''} onchange="orSelectPage(this.checked)" aria-label="Select page"></th>
          <th>Name</th><th>Company</th><th class="col-email">Email</th><th>City</th><th>Industry</th><th>List</th><th>Status</th><th class="col-date">Added</th><th></th>
        </tr></thead>
        <tbody>${orLeadRows.map(l => `
          <tr class="${isSel(l.id) ? 'or-row-selected' : ''}">
            <td class="or-col-check"><input type="checkbox" ${isSel(l.id) ? 'checked' : ''} ${L.allMatching ? 'disabled' : ''} onchange="orSelectLead(${l.id}, this.checked)"></td>
            <td class="col-customer">${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '—')}</td>
            <td>${esc(l.company_name || '—')}</td>
            <td class="col-email">${esc(l.email)}</td>
            <td>${esc(l.city || '—')}</td>
            <td>${esc(l.industry || '—')}</td>
            <td>${l.list_name ? `<span class="or-list-chip">${esc(l.list_name)}</span>` : '<span class="or-muted">—</span>'}</td>
            <td>${orBadge(l.status)}</td>
            <td class="col-date">${orDate(l.created_at, false)}</td>
            <td class="col-actions">
              <button class="btn-row-action" title="Edit" onclick="orEditLead(${l.id})"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
              ${l.status !== 'unsubscribed' ? `<button class="btn-row-action" title="Unsubscribe" onclick="orUnsubLead(${l.id})"><i data-lucide="ban" style="width:14px;height:14px"></i></button>` : ''}
              <button class="btn-row-action btn-row-delete" title="Delete" onclick="orDeleteLead(${l.id})"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  const from = L.total ? L.offset + 1 : 0;
  const to = Math.min(L.offset + L.limit, L.total);
  document.getElementById('or-leads-pager').innerHTML = `
    <span class="or-muted">${from}–${to} of ${L.total}</span>
    <button class="btn-secondary or-btn-sm" ${L.offset === 0 ? 'disabled' : ''} onclick="OR.leads.offset=Math.max(0,OR.leads.offset-OR.leads.limit);orLoadLeads()">← Prev</button>
    <button class="btn-secondary or-btn-sm" ${to >= L.total ? 'disabled' : ''} onclick="OR.leads.offset+=OR.leads.limit;orLoadLeads()">Next →</button>`;

  orRenderBulkbar();
  orIcons();
}

function orSelectLead(id, on) {
  on ? OR.leads.selected.add(id) : OR.leads.selected.delete(id);
  orRenderLeads();
}

function orSelectPage(on) {
  orLeadRows.forEach(l => on ? OR.leads.selected.add(l.id) : OR.leads.selected.delete(l.id));
  orRenderLeads();
}

function orSelectAllMatching(on) {
  const L = OR.leads;
  L.allMatching = on;
  L.allFilter = on ? orLeadFilterNow() : null;
  if (on) L.selected.clear();
  orRenderLeads();
}

function orRenderBulkbar() {
  const L = OR.leads;
  const bar = document.getElementById('or-bulkbar');
  const n = L.selected.size;
  bar.hidden = !L.total && !n;
  bar.classList.toggle('is-idle', !L.allMatching && !n);

  const selectAllBtn = `<button class="or-link-btn" onclick="orSelectAllMatching(true)">Select all matching filter (${L.total} lead${L.total === 1 ? '' : 's'})</button>`;
  if (L.allMatching) {
    bar.innerHTML = `<span><strong>All ${L.total}</strong> lead${L.total === 1 ? '' : 's'} matching filter selected
        <span class="or-muted">— ${esc(orFilterSummary(L.allFilter))}</span></span>
      <div class="filter-controls">
        <button class="btn-secondary or-btn-sm" onclick="orSelectAllMatching(false)">Clear</button>
        <button class="btn-primary or-btn-sm" onclick="orAddSelectedToCampaign()">Add to campaign</button>
      </div>`;
  } else if (n) {
    bar.innerHTML = `<span><strong>${n}</strong> lead${n === 1 ? '' : 's'} selected ${L.total > n ? `· ${selectAllBtn}` : ''}</span>
      <div class="filter-controls">
        <button class="btn-secondary or-btn-sm" onclick="OR.leads.selected.clear();orRenderLeads()">Clear</button>
        <button class="btn-primary or-btn-sm" onclick="orAddSelectedToCampaign()">Add to campaign</button>
      </div>`;
  } else {
    bar.innerHTML = `<span class="or-muted">Tick leads to add them to a campaign, or</span> ${selectAllBtn}`;
  }
}

async function orAddSelectedToCampaign() {
  let campaigns;
  try { ({ campaigns } = await api('/api/outreach/campaigns')); }
  catch (err) { return toast('Error: ' + err.message, 'error'); }
  if (!campaigns.length) {
    return toast('Create a campaign first (Campaigns → New campaign)', 'error');
  }
  const L = OR.leads;
  const bySegment = L.allMatching;
  const ids = [...L.selected];
  const count = bySegment ? L.total : ids.length;
  orModal({
    title: `Add ${count} lead${count === 1 ? '' : 's'} to campaign`,
    body: `<div class="form-group"><label>Campaign</label>
      <select id="or-add-camp">${campaigns.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.status)}, ${c.lead_count} leads)</option>`).join('')}</select></div>
      ${bySegment ? `<p class="or-muted">Segment: ${esc(orFilterSummary(L.allFilter))}</p>` : ''}
      <p class="or-muted">Leads already in the campaign${bySegment ? ' and suppressed emails' : ''} are skipped.${bySegment ? '' : ' Suppressed or bounced leads are skipped by the worker.'}</p>`,
    buttons: [
      { label: 'Cancel', onClick: orCloseModal },
      { label: 'Add leads', cls: 'btn-primary', onClick: async () => {
        const cid = document.getElementById('or-add-camp').value;
        try {
          if (bySegment) {
            const r = await api(`/api/outreach/campaigns/${cid}/leads-by-filter`, { method: 'POST', body: JSON.stringify(L.allFilter) });
            orCloseModal();
            toast(orSegmentResultText(r));
            orSelectAllMatching(false);
          } else {
            const r = await api(`/api/outreach/campaigns/${cid}/leads`, { method: 'POST', body: JSON.stringify({ lead_ids: ids }) });
            orCloseModal();
            toast(`${r.added} added, ${r.skipped} already in campaign`);
            L.selected.clear();
            orRenderLeads();
          }
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      } },
    ],
  });
}

function orSegmentResultText(r) {
  const parts = [`${r.added} added`];
  if (r.skipped_existing) parts.push(`${r.skipped_existing} already in campaign`);
  if (r.skipped_suppressed) parts.push(`${r.skipped_suppressed} suppressed`);
  return parts.join(', ');
}

// Campaign side: "Add leads by filter" (industry / city / list)
async function orAddByFilterModal(campaignId) {
  await orLoadFacets();
  const f = { industry: 'all', city: 'all', list_name: 'all' };
  const sel = (field) => orFacetSelect(field, f[field], `data-field="${field}" onchange="orAddByFilterCount()"`);
  orModal({
    title: 'Add leads by filter',
    body: `<div id="or-abf">
      <div class="form-group"><label>Industry</label>${sel('industry')}</div>
      <div class="form-group"><label>City</label>${sel('city')}</div>
      <div class="form-group"><label>List</label>${sel('list_name')}</div>
      <div class="or-abf-count" id="or-abf-count">Counting…</div>
      <p class="or-muted">Leads already in this campaign and suppressed emails are skipped.</p>
    </div>`,
    buttons: [
      { label: 'Cancel', onClick: orCloseModal },
      { label: 'Add matching leads', cls: 'btn-primary', onClick: async () => {
        try {
          const r = await api(`/api/outreach/campaigns/${campaignId}/leads-by-filter`, { method: 'POST', body: JSON.stringify(orAddByFilterValues()) });
          orCloseModal();
          toast(orSegmentResultText(r));
          orTabLeads();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      } },
    ],
  });
  orAddByFilterCount();
}

function orAddByFilterValues() {
  const out = {};
  document.querySelectorAll('#or-abf select[data-field]').forEach(s => { out[s.dataset.field] = s.value; });
  return out;
}

async function orAddByFilterCount() {
  const el = document.getElementById('or-abf-count');
  if (!el) return;
  try {
    const p = orFilterParams(orAddByFilterValues(), new URLSearchParams({ limit: 1 }));
    const { total } = await api(`/api/outreach/leads?${p}`);
    el.innerHTML = `<strong>${total}</strong> lead${total === 1 ? '' : 's'} match`;
  } catch { el.textContent = ''; }
}

function orEditLead(id) {
  const l = orLeadRows.find(x => x.id === id) || {};
  orModal({
    title: id ? 'Edit lead' : 'New lead',
    body: `<div id="or-lead-form">
      <div class="form-row">${LEAD_FIELDS.slice(0, 2).map(([k, lbl]) => `<div class="form-group"><label>${lbl}</label><input name="${k}" value="${esc(l[k] || '')}" ${k === 'email' ? 'type="email"' : ''}></div>`).join('')}</div>
      <div class="form-row">${LEAD_FIELDS.slice(2, 4).map(([k, lbl]) => `<div class="form-group"><label>${lbl}</label><input name="${k}" value="${esc(l[k] || '')}"></div>`).join('')}</div>
      <div class="form-row">${LEAD_FIELDS.slice(4, 6).map(([k, lbl]) => `<div class="form-group"><label>${lbl}</label><input name="${k}" value="${esc(l[k] || '')}"></div>`).join('')}</div>
      <div class="form-row">${LEAD_FIELDS.slice(6, 8).map(([k, lbl]) => `<div class="form-group"><label>${lbl}</label><input name="${k}" value="${esc(l[k] || '')}"></div>`).join('')}</div>
      <div class="form-row">
        <div class="form-group"><label>Industry</label><input name="industry" value="${esc(l.industry || '')}"></div>
        <div class="form-group"><label>List name</label><input name="list_name" value="${esc(l.list_name || '')}" placeholder="optional"></div>
      </div>
    </div>`,
    buttons: [
      { label: 'Cancel', onClick: orCloseModal },
      { label: 'Save', cls: 'btn-primary', onClick: async () => {
        const v = orFormValues(document.getElementById('or-lead-form'));
        if (!v.email.trim()) return toast('Email is required', 'error');
        try {
          await api(id ? `/api/outreach/leads/${id}` : '/api/outreach/leads', { method: id ? 'PUT' : 'POST', body: JSON.stringify(v) });
          orCloseModal(); toast('Lead saved'); orLoadLeads();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      } },
    ],
  });
}

async function orUnsubLead(id) {
  const l = orLeadRows.find(x => x.id === id);
  if (!await orConfirm('Unsubscribe lead?', `<p><strong>${esc(l?.email)}</strong> will be added to suppressions and all their pending emails cancelled.</p>`, { okLabel: 'Unsubscribe', danger: true })) return;
  try { await api(`/api/outreach/leads/${id}/unsubscribe`, { method: 'POST' }); toast('Lead unsubscribed'); orLoadLeads(); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orDeleteLead(id) {
  const l = orLeadRows.find(x => x.id === id);
  if (!await orConfirm('Delete lead?', `<p>Delete <strong>${esc(l?.email)}</strong>? Pending emails to them will be cancelled.</p>`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/outreach/leads/${id}`, { method: 'DELETE' }); OR.leads.selected.delete(id); toast('Lead deleted'); orLoadLeads(); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ── CSV import: upload → preview + map → import → summary ────────────────────

let orImport = null; // { header: [], rows: [[]], mapping: [] }

function orParseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // Excel BOM
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Guess which lead field a CSV header means (EN + LT)
function orGuessField(h) {
  const x = h.toLowerCase().replace(/[\s_.-]+/g, '');
  const map = {
    email: ['email', 'emailaddress', 'elpaštas', 'elpastas', 'paštas', 'mail', 'epaštas'],
    first_name: ['firstname', 'first', 'vardas', 'name', 'givenname'],
    last_name: ['lastname', 'last', 'pavardė', 'pavarde', 'surname', 'familyname'],
    company_name: ['company', 'companyname', 'įmonė', 'imone', 'organization', 'organisation', 'business', 'pavadinimas'],
    city: ['city', 'miestas', 'town'],
    country: ['country', 'šalis', 'salis'],
    phone: ['phone', 'tel', 'telefonas', 'phonenumber', 'mobile'],
    website: ['website', 'web', 'url', 'svetainė', 'svetaine', 'domain'],
    industry: ['industry', 'sector', 'sritis', 'category', 'kategorija'],
  };
  for (const [field, keys] of Object.entries(map)) if (keys.includes(x)) return field;
  return '';
}

function orImportStart() {
  orImport = null;
  orModal({
    title: 'Import leads from CSV',
    wide: true,
    body: `<div class="or-import-drop">
      <p><strong>1. Choose a CSV file</strong></p>
      <p class="or-muted">First row must be column headers. Comma, semicolon or tab separated. You'll map the columns next.</p>
      <input type="file" accept=".csv,text/csv" onchange="orImportFile(this)">
    </div>`,
    buttons: [{ label: 'Cancel', onClick: orCloseModal }],
  });
}

function orImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const rows = orParseCsv(String(reader.result));
    if (rows.length < 2) return toast('CSV has no data rows', 'error');
    const header = rows[0].map(h => h.trim());
    const used = new Set();
    const mapping = header.map(h => {
      const g = orGuessField(h);
      if (!g || used.has(g)) return '';
      used.add(g);
      return g;
    });
    orImport = { fileName: file.name, header, rows: rows.slice(1), mapping };
    orImportPreview();
  };
  reader.readAsText(file);
}

function orImportPreview() {
  const { header, rows, mapping, fileName } = orImport;
  const opts = (sel) => `<option value="">— ignore —</option>` +
    LEAD_FIELDS.map(([k, lbl]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${lbl.replace(' *', '')}</option>`).join('');

  orModal({
    title: 'Import leads — map columns',
    wide: true,
    body: `
      <div class="form-group or-import-list">
        <label>List name <span class="or-muted">(optional — lets you filter and add this import as a segment)</span></label>
        <input value="${esc(orImport.listName || '')}" placeholder="e.g. Kavinės Vilnius 2026-10" maxlength="200" oninput="orImport.listName=this.value">
      </div>
      <p><strong>2. Map columns</strong> <span class="or-muted">${esc(fileName)} · ${rows.length} rows · preview of first 10</span></p>
      <div class="table-wrap or-import-table">
        <table class="orders-table">
          <thead>
            <tr>${header.map((h, i) => `<th><select class="filter-select or-map-select" onchange="orImport.mapping[${i}]=this.value">${opts(mapping[i])}</select><div class="or-csv-head">${esc(h)}</div></th>`).join('')}</tr>
          </thead>
          <tbody>${rows.slice(0, 10).map(r => `<tr>${header.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="or-muted">Duplicates (by email, case-insensitive), suppressed addresses and invalid emails are skipped automatically.</p>`,
    buttons: [
      { label: 'Back', onClick: orImportStart },
      { label: `Import ${rows.length} rows`, cls: 'btn-primary', onClick: orImportRun },
    ],
  });
}

async function orImportRun() {
  const { rows, mapping } = orImport;
  if (!mapping.includes('email')) return toast('Map one column to Email first', 'error');
  const objects = rows.map(r => {
    const o = {};
    mapping.forEach((field, i) => { if (field) o[field] = r[i] ?? ''; });
    return o;
  });

  document.getElementById('or-modal-footer').innerHTML = '<span class="or-muted">Importing…</span>';
  const totals = { imported: 0, skipped: 0, skipped_by_reason: { invalid: 0, duplicate: 0, suppressed: 0 } };
  try {
    for (let i = 0; i < objects.length; i += 2000) {
      const r = await api('/api/outreach/leads/import', { method: 'POST', body: JSON.stringify({ rows: objects.slice(i, i + 2000), list_name: (orImport.listName || '').trim() }) });
      totals.imported += r.imported;
      totals.skipped += r.skipped;
      for (const k of Object.keys(totals.skipped_by_reason)) totals.skipped_by_reason[k] += r.skipped_by_reason[k] || 0;
    }
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
    return orImportPreview();
  }

  const s = totals.skipped_by_reason;
  orModal({
    title: 'Import complete',
    body: `<div class="or-import-result">
      <div class="or-import-big"><strong>${totals.imported}</strong> imported, <strong>${totals.skipped}</strong> skipped</div>
      ${totals.skipped ? `<ul class="or-confirm-list">
        ${s.duplicate ? `<li>${s.duplicate} duplicate email${s.duplicate === 1 ? '' : 's'}</li>` : ''}
        ${s.suppressed ? `<li>${s.suppressed} on the suppression list</li>` : ''}
        ${s.invalid ? `<li>${s.invalid} missing or invalid email</li>` : ''}
      </ul>` : ''}
    </div>`,
    buttons: [{ label: 'Done', cls: 'btn-primary', onClick: () => {
      orCloseModal();
      const list = (orImport.listName || '').trim();
      Object.assign(OR.leads, { offset: 0, allMatching: false, list_name: list && totals.imported ? list : OR.leads.list_name });
      orRefreshLeadFacets(); // new industries/cities/list show up in the filters
    } }],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. CAMPAIGNS
// ══════════════════════════════════════════════════════════════════════════════

let orCampaignRows = [];

async function orLoadCampaigns() {
  OR.campaignId = null;
  const root = orRoot('campaigns');
  if (!root.innerHTML) root.innerHTML = '<div class="or-loading">Loading…</div>';
  try {
    const { campaigns } = await api('/api/outreach/campaigns');
    orCampaignRows = campaigns;
    root.innerHTML = `
      <div class="filters-bar">
        <span class="or-muted">${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}</span>
        <button class="btn-primary" onclick="orNewCampaign()">+ New campaign</button>
      </div>
      ${campaigns.length ? `
      <div class="table-wrap">
        <table class="orders-table">
          <thead><tr>
            <th>Campaign</th><th>Status</th><th class="text-right">Leads</th><th class="text-right">Sent</th>
            <th class="text-right">Replies</th><th class="text-right">Positive</th><th class="text-right">Reply rate</th><th></th>
          </tr></thead>
          <tbody>${campaigns.map(c => `
            <tr class="or-click-row" onclick="orOpenCampaign(${c.id})">
              <td class="col-customer">${esc(c.name)}<div class="or-muted">${c.step_count} step${c.step_count === 1 ? '' : 's'} · ${c.mailbox_count} mailbox${c.mailbox_count === 1 ? '' : 'es'}</div></td>
              <td>${orBadge(c.status)}</td>
              <td class="text-right">${c.lead_count}</td>
              <td class="text-right">${c.sent}</td>
              <td class="text-right">${c.replies}</td>
              <td class="text-right">${c.positive}</td>
              <td class="text-right">${c.reply_rate}%</td>
              <td class="col-actions"><i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-muted)"></i></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<div class="empty-state"><h3>No campaigns yet</h3><p>Create a campaign, write the sequence, assign mailboxes and add leads.</p><button class="btn-primary" onclick="orNewCampaign()">+ New campaign</button></div>`}`;
    orIcons();
  } catch (err) {
    root.innerHTML = `<div class="or-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

function orNewCampaign() {
  orModal({
    title: 'New campaign',
    body: `<div class="form-group"><label>Name *</label><input id="or-new-camp" placeholder="e.g. Restoranai Vilnius — ruduo"></div>`,
    buttons: [
      { label: 'Cancel', onClick: orCloseModal },
      { label: 'Create', cls: 'btn-primary', onClick: async () => {
        const name = document.getElementById('or-new-camp').value.trim();
        if (!name) return toast('Name is required', 'error');
        try {
          const { id } = await api('/api/outreach/campaigns', { method: 'POST', body: JSON.stringify({ name }) });
          orCloseModal();
          OR.editorTab = 'settings';
          orOpenCampaign(id);
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      } },
    ],
  });
  setTimeout(() => document.getElementById('or-new-camp')?.focus(), 50);
}

let orCampaign = null;

async function orOpenCampaign(id) {
  if (OR.campaignId !== id) OR.steps = [];
  OR.campaignId = id;
  if (document.getElementById('view-or-campaigns').hidden) return switchView('or-campaigns');
  try {
    const [{ campaign }, { campaigns }] = await Promise.all([
      api(`/api/outreach/campaigns/${id}`),
      api('/api/outreach/campaigns'),
    ]);
    orCampaign = { ...campaign, ...(campaigns.find(c => c.id === id) || {}) };
    orRenderCampaignEditor();
  } catch (err) {
    toast('Failed to open campaign: ' + err.message, 'error');
    orLoadCampaigns();
  }
}

function orRenderCampaignEditor() {
  const c = orCampaign;
  const tabs = [['settings', 'Settings'], ['sequence', 'Sequence'], ['leads', 'Leads'], ['stats', 'Stats']];
  const running = c.status === 'active';
  orRoot('campaigns').innerHTML = `
    <div class="or-editor-head">
      <button class="btn-secondary or-btn-sm" onclick="orLoadCampaigns()">← Campaigns</button>
      <div class="or-editor-title">
        <h2>${esc(c.name)}</h2> ${orBadge(c.status)}
      </div>
      <div class="filter-controls">
        ${running
          ? `<button class="btn-secondary" onclick="orPauseCampaign()">⏸ Pause</button>`
          : `<button class="btn-primary" onclick="orStartCampaign()">▶ Start</button>`}
        <button class="btn-row-action btn-row-delete" title="Delete campaign" onclick="orDeleteCampaign()"><i data-lucide="trash-2" style="width:15px;height:15px"></i></button>
      </div>
    </div>
    <div class="or-tabs">
      <div class="seg-control">
        ${tabs.map(([k, l]) => `<button class="seg-btn ${OR.editorTab === k ? 'active' : ''}" onclick="orEditorTab('${k}')">${l}</button>`).join('')}
      </div>
    </div>
    <div id="or-editor-body"><div class="or-loading">Loading…</div></div>`;
  orIcons();
  orEditorTab(OR.editorTab);
}

function orEditorTab(tab) {
  OR.editorTab = tab;
  document.querySelectorAll('.or-tabs .seg-btn').forEach((b, i) =>
    b.classList.toggle('active', ['settings', 'sequence', 'leads', 'stats'][i] === tab));
  ({ settings: orTabSettings, sequence: orTabSequence, leads: orTabLeads, stats: orTabStats })[tab]();
}

// a) Settings
async function orTabSettings() {
  const body = document.getElementById('or-editor-body');
  let mailboxes;
  try { ({ mailboxes } = await api('/api/outreach/mailboxes')); }
  catch (err) { body.innerHTML = `<div class="or-error">${esc(err.message)}</div>`; return; }
  const c = orCampaign;
  body.innerHTML = `
    <div class="or-card" id="or-camp-settings">
      <div class="form-row">
        <div class="form-group"><label>Campaign name</label><input name="name" value="${esc(c.name)}"></div>
        <div class="form-group"><label>Campaign daily limit <span class="or-muted">(optional)</span></label><input name="daily_limit" type="number" min="0" value="${c.daily_limit ?? ''}" placeholder="no extra limit"></div>
      </div>
      <div class="form-group">
        <label>Sending mailboxes</label>
        ${mailboxes.length ? `<div class="or-check-list">${mailboxes.map(m => `
          <label class="or-check-item">
            <input type="checkbox" value="${m.id}" ${c.mailbox_ids.includes(m.id) ? 'checked' : ''}>
            <span class="or-check-main">${esc(m.email)}</span>
            ${orBadge(m.status)}
            <span class="or-muted">${m.effective_limit}/day</span>
          </label>`).join('')}</div>` : `<div class="or-empty">No mailboxes yet — <a href="#" class="or-link" onclick="switchView('or-mailboxes');return false">add one</a>.</div>`}
      </div>
      <div class="or-card-foot"><button class="btn-primary" onclick="orSaveCampaignSettings()">Save settings</button></div>
    </div>`;
}

async function orSaveCampaignSettings() {
  const box = document.getElementById('or-camp-settings');
  const name = box.querySelector('[name=name]').value.trim();
  const dl = box.querySelector('[name=daily_limit]').value;
  const mailbox_ids = [...box.querySelectorAll('.or-check-item input:checked')].map(i => parseInt(i.value, 10));
  if (!name) return toast('Name is required', 'error');
  try {
    await api(`/api/outreach/campaigns/${orCampaign.id}`, { method: 'PUT', body: JSON.stringify({ name, daily_limit: dl === '' ? null : parseInt(dl, 10) }) });
    await api(`/api/outreach/campaigns/${orCampaign.id}/mailboxes`, { method: 'PUT', body: JSON.stringify({ mailbox_ids }) });
    toast('Campaign settings saved');
    orOpenCampaign(orCampaign.id);
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// b) Sequence
async function orTabSequence() {
  const body = document.getElementById('or-editor-body');
  try {
    const { sequences } = await api(`/api/outreach/campaigns/${orCampaign.id}/sequences`);
    OR.steps = sequences.map(s => ({ ...s }));
  } catch (err) { body.innerHTML = `<div class="or-error">${esc(err.message)}</div>`; return; }
  if (!OR.steps.length) OR.steps.push({ subject: '', body_text: '', delay_days: 0 });
  orRenderSteps();
}

function orRenderSteps() {
  const body = document.getElementById('or-editor-body');
  body.innerHTML = `
    ${OR.steps.map((s, i) => `
      <div class="or-card or-step">
        <div class="or-card-head">
          <h3>Step ${i + 1} ${i === 0 ? '<span class="or-muted">— first email</span>' : '<span class="or-muted">— follow-up, sent in the same thread as "Re:"</span>'}</h3>
          ${OR.steps.length > 1 ? `<button class="btn-row-action btn-row-delete" title="Delete step" onclick="orDeleteStep(${i})"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>` : ''}
        </div>
        ${i > 0 ? `<div class="form-group or-delay"><label>Wait</label>
          <input type="number" min="0" value="${s.delay_days || 0}" oninput="OR.steps[${i}].delay_days=parseInt(this.value,10)||0">
          <span class="or-muted">days after step ${i} (shifted into the next weekday 08:00–17:00 window)</span></div>` : ''}
        ${i === 0 ? `<div class="form-group"><label>Subject</label>
          <input value="${esc(s.subject || '')}" oninput="OR.steps[${i}].subject=this.value" onfocus="OR.lastFocus={i:${i},f:'subject',el:this}"></div>`
          : `<div class="or-muted or-thread-note">Subject: “Re: ${esc(OR.steps[0].subject || '…')}”</div>`}
        <div class="form-group"><label>Body</label>
          <textarea rows="8" oninput="OR.steps[${i}].body_text=this.value" onfocus="OR.lastFocus={i:${i},f:'body_text',el:this}">${esc(s.body_text || '')}</textarea>
          ${s.body_html && !s.body_text ? '<span class="or-muted">This step has an HTML body set via the API — editing here only changes the plain-text version.</span>' : ''}
        </div>
        <div class="or-step-tools">
          <div class="or-tokens">
            <span class="or-muted">Insert:</span>
            ${['first_name', 'company_name', 'city'].map(t => `<button type="button" class="or-token" onmousedown="event.preventDefault()" onclick="orInsertToken(${i},'${t}')">{{${t}}}</button>`).join('')}
            <span class="or-muted or-token-hint">fallback: {{first_name|Sveiki}}</span>
          </div>
          <button class="btn-secondary or-btn-sm" onclick="orPreviewStep(${i})">Preview with real lead</button>
        </div>
      </div>`).join('')}
    <div class="or-steps-foot">
      <button class="btn-secondary" onclick="OR.steps.push({subject:'',body_text:'',delay_days:3});orRenderSteps()">+ Add follow-up step</button>
      <button class="btn-primary" onclick="orSaveSteps()">Save sequence</button>
    </div>
    <p class="or-muted">An unsubscribe link is added to the footer of every email automatically.</p>`;
  orIcons();
}

function orInsertToken(i, token) {
  const tag = `{{${token}}}`;
  let f = OR.lastFocus;
  if (!f || f.i !== i || !document.body.contains(f.el)) {
    const el = document.querySelectorAll('.or-step')[i].querySelector('textarea');
    f = { i, f: 'body_text', el };
  }
  const el = f.el;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + tag + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + tag.length;
  OR.steps[i][f.f] = el.value;
  OR.lastFocus = f;
}

async function orDeleteStep(i) {
  const s = OR.steps[i];
  if (!await orConfirm('Delete step?', `<p>Delete step ${i + 1}? Pending emails for this step will be cancelled.</p>`, { okLabel: 'Delete', danger: true })) return;
  try {
    if (s.id) await api(`/api/outreach/sequences/${s.id}`, { method: 'DELETE' });
    OR.steps.splice(i, 1);
    await orSaveSteps(true);
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orSaveSteps(quiet = false) {
  if (!OR.steps[0]?.subject?.trim()) return toast('Step 1 needs a subject', 'error');
  try {
    for (let i = 0; i < OR.steps.length; i++) {
      const s = OR.steps[i];
      const payload = { step_number: i + 1, subject: i === 0 ? s.subject : (s.subject || ''), body_text: s.body_text || '', delay_days: i === 0 ? 0 : (s.delay_days || 0) };
      if (s.id) await api(`/api/outreach/sequences/${s.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else {
        const { id } = await api(`/api/outreach/campaigns/${orCampaign.id}/sequences`, { method: 'POST', body: JSON.stringify(payload) });
        s.id = id;
      }
    }
    if (!quiet) toast('Sequence saved');
    orTabSequence();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orPreviewStep(i, leadId) {
  let leads = [];
  try { ({ leads } = await api(`/api/outreach/campaigns/${orCampaign.id}/leads`)); } catch {}
  const s = OR.steps[i];
  const subject = i === 0 ? s.subject : `Re: ${OR.steps[0].subject || ''}`;
  try {
    const p = await api(`/api/outreach/campaigns/${orCampaign.id}/preview`, {
      method: 'POST',
      body: JSON.stringify({ lead_id: leadId || leads[0]?.lead_id || null, subject, body_text: s.body_text, body_html: s.body_text ? '' : s.body_html }),
    });
    const leadOpts = leads.slice(0, 200).map(l =>
      `<option value="${l.lead_id}" ${l.lead_id === p.lead.id ? 'selected' : ''}>${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email)} — ${esc(l.company_name || l.email)}</option>`).join('');
    orModal({
      title: `Preview — step ${i + 1}`,
      wide: true,
      body: `
        ${leads.length ? `<div class="form-group"><label>Preview as</label><select onchange="orPreviewStep(${i}, parseInt(this.value,10))">${leadOpts}</select></div>`
          : `<p class="or-muted">This campaign has no leads yet — previewing with ${esc(p.lead.email)}.</p>`}
        <div class="or-preview">
          <div class="or-preview-meta"><span class="or-muted">To</span> ${esc(p.lead.email)}</div>
          <div class="or-preview-meta"><span class="or-muted">Subject</span> <strong>${esc(p.subject)}</strong></div>
          <div class="or-preview-body">${esc(p.text)}</div>
          <div class="or-preview-foot">Nebenorite gauti šių laiškų? <a href="#" onclick="return false" class="or-link" title="Links to this lead's personal unsubscribe page">Atsisakyti</a></div>
        </div>`,
      buttons: [{ label: 'Close', cls: 'btn-primary', onClick: orCloseModal }],
    });
  } catch (err) { toast('Preview failed: ' + err.message, 'error'); }
}

// c) Leads
async function orTabLeads() {
  const body = document.getElementById('or-editor-body');
  try {
    const { leads } = await api(`/api/outreach/campaigns/${orCampaign.id}/leads`);
    const counts = leads.reduce((m, l) => (m[l.status] = (m[l.status] || 0) + 1, m), {});
    body.innerHTML = `
      <div class="filters-bar">
        <span class="or-muted">${leads.length} lead${leads.length === 1 ? '' : 's'} · ${Object.entries(counts).map(([k, v]) => `${v} ${esc(k)}`).join(' · ') || 'none yet'}</span>
        <div class="filter-controls">
          <button class="btn-secondary or-btn-sm" onclick="switchView('or-leads')">Pick on Leads page</button>
          <button class="btn-primary or-btn-sm" onclick="orAddByFilterModal(${orCampaign.id})">+ Add leads by filter</button>
        </div>
      </div>
      ${leads.length ? `
      <div class="table-wrap">
        <table class="orders-table">
          <thead><tr><th>Lead</th><th>Company</th><th class="col-email">Email</th><th>In campaign</th><th>Lead status</th><th class="text-right">Sent</th><th>Next email</th><th></th></tr></thead>
          <tbody>${leads.map(l => `
            <tr>
              <td class="col-customer">${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '—')}</td>
              <td>${esc(l.company_name || '—')}</td>
              <td class="col-email">${esc(l.email || '(deleted)')}</td>
              <td>${orBadge(l.status)}</td>
              <td>${l.lead_status ? orBadge(l.lead_status) : '—'}</td>
              <td class="text-right">${l.sent_count}</td>
              <td class="col-date">${l.next_at ? orDate(l.next_at) : '—'}</td>
              <td class="col-actions"><button class="btn-row-action btn-row-delete" title="Remove from campaign" onclick="orRemoveCampaignLead(${l.lead_id})"><i data-lucide="x" style="width:14px;height:14px"></i></button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state"><h3>No leads in this campaign</h3><p>Go to Leads, select leads and use “Add to campaign”.</p></div>'}`;
    orIcons();
  } catch (err) { body.innerHTML = `<div class="or-error">${esc(err.message)}</div>`; }
}

async function orRemoveCampaignLead(leadId) {
  if (!await orConfirm('Remove lead from campaign?', '<p>Emails queued for this lead in this campaign are cancelled. The lead itself is kept.</p>', { okLabel: 'Remove', danger: true })) return;
  try {
    await api(`/api/outreach/campaigns/${orCampaign.id}/leads/${leadId}`, { method: 'DELETE' });
    toast('Lead removed'); orTabLeads();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// d) Stats
async function orTabStats() {
  const body = document.getElementById('or-editor-body');
  try {
    const { steps } = await api(`/api/outreach/campaigns/${orCampaign.id}/step-stats`);
    const c = orCampaign;
    const pct = (a, b) => (b ? `${Math.round(a / b * 1000) / 10}%` : '—');
    body.innerHTML = `
      <div class="or-kpi-grid">
        <div class="prod-stat-card"><span class="prod-stat-label">Sent</span><span class="prod-stat-value">${c.sent ?? 0}</span><span class="prod-stat-name">${c.contacted ?? 0} leads contacted</span></div>
        <div class="prod-stat-card"><span class="prod-stat-label">Replies</span><span class="prod-stat-value">${c.replies ?? 0}</span><span class="prod-stat-name">${c.reply_rate ?? 0}% reply rate</span></div>
        <div class="prod-stat-card"><span class="prod-stat-label">Positive</span><span class="prod-stat-value">${c.positive ?? 0}</span><span class="prod-stat-name">${pct(c.positive || 0, c.contacted || 0)} of contacted</span></div>
        <div class="prod-stat-card"><span class="prod-stat-label">Leads</span><span class="prod-stat-value">${c.lead_count ?? 0}</span></div>
      </div>
      <div class="table-wrap">
        <table class="orders-table">
          <thead><tr><th>Step</th><th>Subject</th><th class="text-right">Sent</th><th class="text-right">Replied</th><th class="text-right">Positive</th><th class="text-right">Bounced</th><th class="text-right">Queued</th></tr></thead>
          <tbody>${steps.map(s => `
            <tr>
              <td class="col-order">${s.step_number}</td>
              <td class="or-ellipsis">${esc(s.subject || (s.step_number > 1 ? '(Re: thread)' : '—'))}</td>
              <td class="text-right">${s.sent}</td>
              <td class="text-right">${s.replied} <span class="or-muted">${pct(s.replied, s.sent)}</span></td>
              <td class="text-right">${s.positive}</td>
              <td class="text-right ${s.sent && s.bounced / s.sent > 0.05 ? 'or-err-text' : ''}">${s.bounced} <span class="or-muted">${pct(s.bounced, s.sent)}</span></td>
              <td class="text-right">${s.pending}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="or-muted">No steps yet.</td></tr>'}
          </tbody>
        </table>
      </div>`;
  } catch (err) { body.innerHTML = `<div class="or-error">${esc(err.message)}</div>`; }
}

async function orStartCampaign() {
  let s;
  try { s = await api(`/api/outreach/campaigns/${orCampaign.id}/start-summary`); }
  catch (err) { return toast('Error: ' + err.message, 'error'); }
  const blocking = !s.steps || !s.leads || !s.mailboxes;
  const ok = await orConfirm(`Start “${orCampaign.name}”?`, `
    <div class="or-start-summary">
      <strong>${s.leads}</strong> lead${s.leads === 1 ? '' : 's'},
      <strong>${s.steps}</strong> step${s.steps === 1 ? '' : 's'},
      <strong>${s.mailboxes}</strong> mailbox${s.mailboxes === 1 ? '' : 'es'},
      estimated <strong>${s.estimated_days ?? '—'}</strong> day${s.estimated_days === 1 ? '' : 's'} to complete
    </div>
    <p class="or-muted">${s.total_emails} emails at up to ${s.per_day}/day (current mailbox, campaign and system limits; weekdays only).</p>
    ${s.warnings.length ? `<ul class="or-confirm-list or-warn-list">${s.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`,
    { okLabel: blocking ? 'Start anyway' : 'Start campaign' });
  if (!ok) return;
  try {
    await api(`/api/outreach/campaigns/${orCampaign.id}/start`, { method: 'POST' });
    toast('Campaign started');
    orOpenCampaign(orCampaign.id);
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orPauseCampaign() {
  try {
    await api(`/api/outreach/campaigns/${orCampaign.id}/pause`, { method: 'POST' });
    toast('Campaign paused');
    orOpenCampaign(orCampaign.id);
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orDeleteCampaign() {
  if (!await orConfirm('Delete campaign?', `<p>Delete <strong>${esc(orCampaign.name)}</strong> with its sequence, lead list and queued emails? Sent history for this campaign is removed too. Leads themselves are kept.</p>`, { okLabel: 'Delete campaign', danger: true })) return;
  try {
    await api(`/api/outreach/campaigns/${orCampaign.id}`, { method: 'DELETE' });
    toast('Campaign deleted');
    orLoadCampaigns();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. INBOX
// ══════════════════════════════════════════════════════════════════════════════

async function orLoadInbox(reset = false) {
  const I = OR.inbox;
  if (reset) { I.offset = 0; I.items = []; }
  const root = orRoot('inbox');
  const filters = [['untagged', 'To tag'], ['all', 'All'], ['positive', 'Positive'], ['neutral', 'Neutral'], ['negative', 'Negative'], ['unsubscribe', 'Unsubscribe'], ['bounces', 'Bounces']];
  if (reset) {
    root.innerHTML = `
      <div class="filters-bar">
        <div class="seg-control or-seg-scroll">
          ${filters.map(([k, l]) => `<button class="seg-btn ${I.filter === k ? 'active' : ''}" onclick="OR.inbox.filter='${k}';orLoadInbox(true)">${l}</button>`).join('')}
        </div>
        <span class="or-muted" id="or-inbox-count"></span>
      </div>
      <div id="or-inbox-list"><div class="or-loading">Loading…</div></div>
      <div class="or-pager" id="or-inbox-more"></div>`;
  }
  const p = new URLSearchParams({ limit: I.limit, offset: I.offset });
  if (I.filter === 'bounces') p.set('bounces', 'only');
  else p.set('sentiment', I.filter);
  try {
    const { replies, total } = await api(`/api/outreach/replies?${p}`);
    I.items = I.items.concat(replies);
    I.total = total;
    orRenderInbox();
    if (I.filter === 'untagged') orUpdateInboxBadge(total);
  } catch (err) {
    document.getElementById('or-inbox-list').innerHTML = `<div class="or-error">${esc(err.message)}</div>`;
  }
}

function orRenderInbox() {
  const I = OR.inbox;
  document.getElementById('or-inbox-count').textContent = `${I.total} ${I.filter === 'bounces' ? 'bounce' : 'repl'}${I.filter === 'bounces' ? (I.total === 1 ? '' : 's') : (I.total === 1 ? 'y' : 'ies')}`;
  const list = document.getElementById('or-inbox-list');
  if (!I.items.length) {
    list.innerHTML = `<div class="empty-state"><h3>${I.filter === 'untagged' ? 'All caught up' : 'Nothing here'}</h3><p>${I.filter === 'untagged' ? 'Every reply has been tagged.' : 'No replies match this filter.'}</p></div>`;
  } else {
    list.innerHTML = I.items.map(orReplyCard).join('');
  }
  const more = document.getElementById('or-inbox-more');
  more.innerHTML = I.items.length < I.total
    ? `<button class="btn-secondary or-btn-sm" onclick="OR.inbox.offset+=OR.inbox.limit;orLoadInbox()">Load more (${I.total - I.items.length})</button>` : '';
  orIcons();
}

function orReplyCard(r) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
  const who = name || r.from_email || r.lead_email || 'Unknown';
  const body = String(r.body_text || '').trim();
  const long = body.length > 600;
  const tagBtns = r.is_bounce ? '' : Object.entries(SENTIMENT).map(([k, s]) => `
    <button class="or-tag or-tag-${s.cls} ${r.sentiment === k ? 'active' : ''}" onclick="orTagReply(${r.id}, '${k}')">${s.icon} ${s.label}</button>`).join('');
  return `
    <div class="or-card or-reply ${r.sentiment ? '' : 'is-untagged'}" id="or-reply-${r.id}">
      <div class="or-reply-head">
        <div class="or-reply-who">
          <div class="panel-avatar or-reply-avatar">${esc(who.charAt(0).toUpperCase())}</div>
          <div>
            <div class="or-reply-name">
              ${r.lead_id ? `<a href="#" class="or-link" onclick="orGoToLead(${r.id});return false">${esc(who)}</a>` : esc(who)}
              ${r.company_name ? `<span class="or-muted">· ${esc(r.company_name)}</span>` : ''}
              ${r.is_bounce ? orBadge('bounced') : ''}
            </div>
            <div class="or-muted">
              ${esc(r.lead_email || r.from_email || '')}
              ${r.campaign_id ? ` · <a href="#" class="or-link" onclick="orGoToCampaign(${r.campaign_id});return false">${esc(r.campaign_name)}</a>` : ''}
              ${r.mailbox_email ? ` · to ${esc(r.mailbox_email)}` : ''}
            </div>
          </div>
        </div>
        <span class="or-muted or-reply-time" title="${esc(r.received_at || '')}">${orDate(r.received_at || r.created_at)}</span>
      </div>
      <div class="or-reply-subject">${esc(r.subject || '(no subject)')}</div>
      <div class="or-reply-body ${long ? 'is-clamped' : ''}" id="or-reply-body-${r.id}">${esc(body) || '<span class="or-muted">(empty)</span>'}</div>
      ${long ? `<button class="or-link-btn" onclick="this.previousElementSibling.classList.toggle('is-clamped');this.textContent=this.textContent==='Show more'?'Show less':'Show more'">Show more</button>` : ''}
      ${tagBtns ? `<div class="or-reply-tags">${tagBtns}
        ${r.deal_id ? `<a href="#" class="or-link or-deal-link" onclick="switchView('deals');return false">✓ Deal #${r.deal_id} in Sandoriai →</a>` : ''}
      </div>` : ''}
    </div>`;
}

async function orTagReply(id, sentiment) {
  const r = OR.inbox.items.find(x => x.id === id);
  if (!r) return;
  const next = r.sentiment === sentiment ? null : sentiment; // click again to untag

  try {
    if (next === 'unsubscribe') {
      const ok = await orConfirm('Unsubscribe this lead?', `<p><strong>${esc(r.lead_email || r.from_email)}</strong> will be added to suppressions and all their pending emails cancelled.</p>`, { okLabel: 'Unsubscribe', danger: true });
      if (!ok) return;
    }
    const update = { sentiment: next };

    // Positive → create a deal in the Sandoriai pipeline (once per reply)
    if (next === 'positive' && !r.deal_id) {
      const person = [r.first_name, r.last_name].filter(Boolean).join(' ');
      const customer = r.company_name ? (person ? `${r.company_name} (${person})` : r.company_name) : (person || r.lead_email || r.from_email);
      const { deal } = await api('/api/deals', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customer,
          customer_email: r.lead_email || r.from_email || '',
          customer_phone: r.lead_phone || '',
          store_id: 'custom',
          description: `Outreach: ${r.campaign_name || 'cold email'}${r.company_name ? ' — ' + r.company_name : ''}`,
          status: 'lead',
          notes: [
            person ? `Kontaktas: ${person}` : '',
            r.city ? `Miestas: ${r.city}` : '',
            `Atsakymas (${orDate(r.received_at || r.created_at)}): ${r.subject || ''}`,
            '',
            String(r.body_text || '').trim().slice(0, 800),
          ].filter((x, i) => x || i === 3).join('\n'),
        }),
      });
      update.deal_id = deal.id;
      r.deal_id = deal.id;
    }

    await api(`/api/outreach/replies/${id}`, { method: 'PUT', body: JSON.stringify(update) });
    r.sentiment = next;
    toast(update.deal_id ? `Tagged positive — deal #${update.deal_id} created in Sandoriai` : next ? `Tagged ${SENTIMENT[next].label.toLowerCase()}` : 'Tag removed');

    if (OR.inbox.filter === 'untagged' && next) {
      OR.inbox.items = OR.inbox.items.filter(x => x.id !== id);
      OR.inbox.total--;
      orUpdateInboxBadge(OR.inbox.total);
    }
    orRenderInbox();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

function orGoToLead(replyId) {
  OR.leads.search = OR.inbox.items.find(x => x.id === replyId)?.lead_email || '';
  Object.assign(OR.leads, { status: 'all', industry: 'all', city: 'all', list_name: 'all', offset: 0, allMatching: false });
  const root = orRoot('leads');
  root.innerHTML = ''; // re-render shell with the search value
  switchView('or-leads');
}

function orGoToCampaign(id) {
  OR.campaignId = id;
  OR.editorTab = 'stats';
  switchView('or-campaigns');
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. SUPPRESSIONS
// ══════════════════════════════════════════════════════════════════════════════

async function orLoadSuppressions() {
  const root = orRoot('suppressions');
  if (!root.innerHTML) {
    root.innerHTML = `
      <div class="filters-bar">
        <div class="filter-controls or-supp-add">
          <input type="email" class="search-input or-plain-input" id="or-supp-email" placeholder="email@example.com" onkeydown="if(event.key==='Enter')orAddSuppression()">
          <select class="filter-select" id="or-supp-reason">
            <option value="manual">Manual</option>
            <option value="unsubscribe">Unsubscribe</option>
            <option value="bounce">Bounce</option>
            <option value="complaint">Complaint</option>
          </select>
          <button class="btn-primary" onclick="orAddSuppression()">Add</button>
        </div>
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input type="search" class="search-input" id="or-supp-search" placeholder="Filter" oninput="orRenderSuppressions()">
        </div>
      </div>
      <div class="table-wrap" id="or-supp-table"></div>`;
  }
  try {
    const { suppressions } = await api('/api/outreach/suppressions');
    OR.suppressions = suppressions;
    orRenderSuppressions();
  } catch (err) { toast('Failed to load suppressions: ' + err.message, 'error'); }
}

function orRenderSuppressions() {
  const q = (document.getElementById('or-supp-search')?.value || '').trim().toLowerCase();
  const rows = OR.suppressions.filter(s => !q || s.email.toLowerCase().includes(q) || String(s.reason || '').includes(q));
  const wrap = document.getElementById('or-supp-table');
  wrap.innerHTML = rows.length ? `
    <table class="orders-table">
      <thead><tr><th>Email</th><th>Reason</th><th class="col-date">Added</th><th></th></tr></thead>
      <tbody>${rows.map(s => `
        <tr>
          <td class="col-customer">${esc(s.email)}</td>
          <td><span class="status-badge or-reason-${esc(s.reason)}">${esc(s.reason || '—')}</span></td>
          <td class="col-date">${orDate(s.created_at, false)}</td>
          <td class="col-actions"><button class="btn-row-action btn-row-delete" title="Remove" onclick="orRemoveSuppression(${s.id})"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="or-pager"><span class="or-muted">${rows.length} of ${OR.suppressions.length}</span></div>`
    : `<div class="empty-state"><h3>${OR.suppressions.length ? 'No matches' : 'Suppression list is empty'}</h3><p>Emails here are never contacted, in any campaign.</p></div>`;
  orIcons();
}

async function orAddSuppression() {
  const input = document.getElementById('or-supp-email');
  const email = input.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Enter a valid email', 'error');
  try {
    await api('/api/outreach/suppressions', { method: 'POST', body: JSON.stringify({ email, reason: document.getElementById('or-supp-reason').value }) });
    input.value = '';
    toast(`${email} suppressed`);
    orLoadSuppressions();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function orRemoveSuppression(id) {
  const s = OR.suppressions.find(x => x.id === id);
  if (!await orConfirm('Remove from suppressions?', `<p><strong>${esc(s?.email)}</strong> could be contacted again by future campaigns. The lead's status is not changed.</p>`, { okLabel: 'Remove', danger: true })) return;
  try { await api(`/api/outreach/suppressions/${id}`, { method: 'DELETE' }); toast('Removed'); orLoadSuppressions(); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

// Close the outreach modal on Escape / backdrop click
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('or-modal').hidden) orCloseModal();
});
document.getElementById('or-modal')?.addEventListener('click', e => {
  if (e.target.id === 'or-modal') orCloseModal();
});
