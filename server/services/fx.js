const axios = require('axios');

const FALLBACK = 7.46; // 1 EUR = 7.46 DKK

let cache = { rate: FALLBACK, fetchedAt: 0 };

async function getDkkPerEur() {
  const ageMs = Date.now() - cache.fetchedAt;
  if (ageMs < 24 * 60 * 60 * 1000) return cache.rate;

  try {
    const res  = await axios.get('https://api.exchangerate-api.com/v4/latest/EUR', { timeout: 5000 });
    const rate = res.data?.rates?.DKK;
    if (rate && typeof rate === 'number' && rate > 0) {
      cache = { rate, fetchedAt: Date.now() };
      console.log(`[FX] EUR/DKK updated: 1 EUR = ${rate.toFixed(4)} DKK`);
      return rate;
    }
  } catch (err) {
    console.error(`[FX] Rate fetch failed, using fallback ${FALLBACK}: ${err.message}`);
  }

  // Don't retry for 24h even on failure
  cache.fetchedAt = Date.now();
  return cache.rate;
}

function toEur(amount, currency, rate) {
  if (currency === 'EUR') return amount;
  if (currency === 'DKK') return amount / rate;
  return amount;
}

module.exports = { getDkkPerEur, toEur, FALLBACK };
