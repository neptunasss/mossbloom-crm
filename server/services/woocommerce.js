const axios = require('axios');

const stores = [
  {
    id: 'bloom_lt',
    name: 'bloom.lt',
    label: 'LT',
    color: '#2ea043',
    url: process.env.BLOOM_LT_URL,
    key: process.env.BLOOM_LT_KEY,
    secret: process.env.BLOOM_LT_SECRET,
  },
  {
    id: 'mossbloom_dk',
    name: 'mossbloom.dk',
    label: 'DK',
    color: '#1f6feb',
    url: process.env.MOSSBLOOM_DK_URL,
    key: process.env.MOSSBLOOM_DK_KEY,
    secret: process.env.MOSSBLOOM_DK_SECRET,
  },
  {
    id: 'mossbloom_de',
    name: 'mossbloom.de',
    label: 'DE',
    color: '#da3633',
    url: process.env.MOSSBLOOM_DE_URL,
    key: process.env.MOSSBLOOM_DE_KEY,
    secret: process.env.MOSSBLOOM_DE_SECRET,
  },
];

function normalizeUrl(raw) {
  const stripped = raw.trim().replace(/\/$/, '');
  return stripped.startsWith('http') ? stripped : `https://${stripped}`;
}

async function fetchOrders(store, page = 1, perPage = 100) {
  const baseUrl = normalizeUrl(store.url);
  const apiUrl = `${baseUrl}/wp-json/wc/v3/orders`;
  console.log(`[WC] Fetching ${store.id} page ${page}: ${apiUrl}`);
  try {
    const res = await axios.get(apiUrl, {
      auth: { username: store.key, password: store.secret },
      params: { per_page: perPage, page, orderby: 'date', order: 'desc' },
      timeout: 20000,
    });
    console.log(`[WC] ${store.id} page ${page}: got ${res.data.length} orders`);
    return res.data;
  } catch (err) {
    console.error(`[WC] ${store.id} page ${page} FAILED: ${err.message}`);
    if (err.response) {
      console.error(`[WC] ${store.id} status=${err.response.status} body=`, JSON.stringify(err.response.data).slice(0, 500));
    }
    throw err;
  }
}

async function fetchAllStoreOrders(store) {
  const orders = [];
  let page = 1;

  while (page <= 10) {
    const batch = await fetchOrders(store, page);
    orders.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return orders;
}

module.exports = { stores, fetchAllStoreOrders };
