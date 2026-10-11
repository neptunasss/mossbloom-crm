'use strict';

// PUBLIC — no auth. Linked from every outreach email footer and the
// List-Unsubscribe header. POST handles RFC 8058 one-click unsubscribe.

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const common  = require('../services/outreach-common');

function page(title, text) {
  return `<!doctype html><html lang="lt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f6f4;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{background:#fff;border-radius:10px;padding:32px 40px;max-width:420px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#555}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function unsubscribe(req, res) {
  const leadId = common.verifyLeadToken(req.params.token);
  if (!leadId) {
    return res.status(400).send(page('Nuoroda negaliojanti', 'Ši atsisakymo nuoroda neteisinga arba pasenusi.'));
  }
  const lead = db.prepare('SELECT id, email, status FROM outreach_leads WHERE id = ?').get(leadId);
  if (lead && lead.status !== 'unsubscribed') {
    const cancelled = common.stopLead(lead.id, 'unsubscribed', { suppress: true, reason: 'unsubscribe' });
    common.workerLog('info', `UNSUBSCRIBE: ${lead.email} via link — ${cancelled} pending email(s) cancelled`);
  }
  res.send(page('Atsisakyta', 'Jūs nebegausite daugiau mūsų laiškų.'));
}

router.get('/:token', unsubscribe);
router.post('/:token', unsubscribe);

module.exports = router;
