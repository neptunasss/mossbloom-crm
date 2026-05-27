'use strict';

const axios = require('axios');
const db    = require('../database');

function normalizeUrl(raw) {
  const s = raw.trim().replace(/\/$/, '');
  return s.startsWith('http') ? s : `https://${s}`;
}

// Extract canonical size token from a string (product name or attribute value)
function sizeFromStr(s) {
  let m = s.match(/ø(\d+)\s*cm/i);
  if (m) return `ø${m[1]}cm`;
  m = s.match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (m) return `${m[1]}×${m[2]}cm`;
  // "o80cm" → "ø80cm" (DK attribute format)
  m = s.match(/^o(\d+)\s*cm$/i);
  if (m) return `ø${m[1]}cm`;
  if (/trio/i.test(s)) return 'trio';
  return null;
}

function ltMossType(name) {
  if (/kupstinės|kupstine|kupstin/i.test(name)) return 'ball';
  return 'mix';
}

function dkMossType(name) {
  if (/pude[\s-]?mos|pudemos/i.test(name)) return 'ball';
  if (/trio/i.test(name)) return 'trio';
  return 'mix';
}

// type key as stored in productMap
function productRowType(p) {
  if (p.sku && p.sku.includes('trio')) return 'trio';
  if (p.moss_type === 'mix') return 'mix';
  return 'ball';
}

async function fetchWcProducts(url, key, secret) {
  const apiUrl = `${normalizeUrl(url)}/wp-json/wc/v3/products`;
  const res = await axios.get(apiUrl, {
    auth: { username: key, password: secret },
    params: { per_page: 100, page: 1 },
    timeout: 20000,
  });
  return res.data;
}

async function syncProductNames() {
  const products = db.prepare('SELECT id, sku, name, store, moss_type FROM products').all();

  // Build lookup: "STORE:size:type" → product id
  const productMap = {};
  for (const p of products) {
    const size = sizeFromStr(p.name);
    if (!size) continue;
    const type = productRowType(p);
    productMap[`${p.store}:${size}:${type}`] = p.id;
  }

  const setLt = db.prepare('UPDATE products SET lt_name = ? WHERE id = ?');
  const setDk = db.prepare('UPDATE products SET dk_name = ? WHERE id = ?');

  const ltUrl = process.env.BLOOM_LT_URL;
  const ltKey = process.env.BLOOM_LT_KEY;
  const ltSec = process.env.BLOOM_LT_SECRET;

  const dkUrl = process.env.MOSSBLOOM_DK_URL;
  const dkKey = process.env.MOSSBLOOM_DK_KEY;
  const dkSec = process.env.MOSSBLOOM_DK_SECRET;

  let ltCount = 0;
  let dkCount = 0;

  // ── LT products ───────────────────────────────────────────────────────────────
  if (ltUrl && ltKey && ltSec) {
    try {
      const wcProducts = await fetchWcProducts(ltUrl, ltKey, ltSec);
      console.log(`[product-names] LT: fetched ${wcProducts.length} WC products`);

      for (const p of wcProducts) {
        if (!p.name) continue;
        const type = ltMossType(p.name);

        // Variable products may list sizes in attributes
        const sizeAttr = (p.attributes || []).find(a =>
          /dydis|size|izmeras/i.test(a.name || '') || /pa_dydis|pa_size/i.test(a.slug || '')
        );

        if (sizeAttr && sizeAttr.options?.length) {
          for (const opt of sizeAttr.options) {
            const size = sizeFromStr(opt);
            if (!size) continue;
            const id = productMap[`LT:${size}:${type}`];
            if (id) { setLt.run(p.name, id); ltCount++; }
          }
        } else {
          // Size embedded in product name (simple products)
          const size = sizeFromStr(p.name);
          if (!size) continue;
          const resolvedType = /trio/i.test(p.name) ? 'trio' : type;
          const id = productMap[`LT:${size}:${resolvedType}`];
          if (id) { setLt.run(p.name, id); ltCount++; }
        }
      }
      console.log(`[product-names] LT: matched ${ltCount} products`);
    } catch (err) {
      console.error('[product-names] LT fetch failed:', err.message);
    }
  } else {
    console.log('[product-names] LT: skipped — env vars missing');
  }

  // ── DK products ───────────────────────────────────────────────────────────────
  if (dkUrl && dkKey && dkSec) {
    try {
      const wcProducts = await fetchWcProducts(dkUrl, dkKey, dkSec);
      console.log(`[product-names] DK: fetched ${wcProducts.length} WC products`);

      for (const p of wcProducts) {
        if (!p.name) continue;
        const type = dkMossType(p.name);

        // DK uses pa_stoerrelse attribute for size
        const sizeAttr = (p.attributes || []).find(a =>
          a.slug === 'pa_stoerrelse' ||
          /størrelse|stoerrelse|size/i.test(a.name || '')
        );

        if (sizeAttr && sizeAttr.options?.length) {
          for (const opt of sizeAttr.options) {
            const size = sizeFromStr(opt);
            if (!size) continue;
            const id = productMap[`DK:${size}:${type}`];
            if (id) { setDk.run(p.name, id); dkCount++; }
          }
        } else {
          // Fallback: size from product name
          const size = sizeFromStr(p.name);
          if (!size) continue;
          const id = productMap[`DK:${size}:${type}`];
          if (id) { setDk.run(p.name, id); dkCount++; }
        }
      }
      console.log(`[product-names] DK: matched ${dkCount} products`);
    } catch (err) {
      console.error('[product-names] DK fetch failed:', err.message);
    }
  } else {
    console.log('[product-names] DK: skipped — env vars missing');
  }

  return { lt: ltCount, dk: dkCount };
}

module.exports = { syncProductNames };
