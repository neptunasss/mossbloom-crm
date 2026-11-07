'use strict';

// Pre-send MX check. The worker is a single long-lived process, so a Map is
// enough for the 24h per-domain cache; a restart only costs fresh lookups.

const { Resolver } = require('dns').promises;

const CACHE_TTL_MS = 24 * 3600000;
// Only these mean the domain really has no MX. SERVFAIL, timeouts and the like
// say nothing about the domain, so they must never invalidate a lead.
const NO_MX_CODES = new Set(['ENOTFOUND', 'ENODATA']);

const resolver = new Resolver({ timeout: 5000, tries: 2 });
const cache = new Map(); // domain → { hasMx, expires }

// Returns true / false, or null when DNS gave no definite answer (not cached).
async function hasMx(email) {
  const domain = String(email).split('@').pop().trim().toLowerCase();
  if (!domain) return false;

  const hit = cache.get(domain);
  if (hit && hit.expires > Date.now()) return hit.hasMx;

  let result;
  try {
    const records = await resolver.resolveMx(domain);
    // A null MX ("0 .", RFC 7505) declares that the domain takes no mail
    result = records.some(r => r.exchange && r.exchange !== '.');
  } catch (err) {
    if (!NO_MX_CODES.has(err.code)) return null;
    result = false;
  }
  cache.set(domain, { hasMx: result, expires: Date.now() + CACHE_TTL_MS });
  return result;
}

module.exports = { hasMx };
