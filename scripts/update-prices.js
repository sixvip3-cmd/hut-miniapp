// Обновление цен: data/prices.json.
// Запускается сервером раз в час и GitHub Actions по расписанию: node scripts/update-prices.js
//
// PRICE_SOURCE_URL — URL, отдающий JSON { "<playerId>": <price>, ... }.
// Без него берётся поле price из data/players.json.

const fs = require('fs');
const path = require('path');

const PLAYERS_FILE = path.join(__dirname, '..', 'data', 'players.json');
const PRICES_FILE = path.join(__dirname, '..', 'data', 'prices.json');
const HISTORY_LIMIT = 48; // точек истории на игрока (48 часов)

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchSourcePrices(players) {
  if (process.env.PRICE_SOURCE_URL) {
    const res = await fetch(process.env.PRICE_SOURCE_URL);
    if (!res.ok) throw new Error(`price source responded ${res.status}`);
    return { source: 'PRICE_SOURCE_URL', map: await res.json() };
  }
  const map = {};
  for (const p of players) if (p.price != null) map[p.id] = p.price;
  return { source: 'players.json', map };
}

// prices.json: { updatedAt, source, prices: { id: { price, prev, history: [[ts, price], ...] } } }
async function updatePrices() {
  const players = readJson(PLAYERS_FILE, []);
  const store = readJson(PRICES_FILE, { updatedAt: null, source: null, prices: {} });
  const now = Date.now();
  const { source, map } = await fetchSourcePrices(players);
  for (const [id, price] of Object.entries(map)) {
    if (typeof price !== 'number') continue;
    const entry = store.prices[id] || { price: null, prev: null, history: [] };
    entry.prev = entry.price;
    entry.price = price;
    entry.history.push([now, price]);
    if (entry.history.length > HISTORY_LIMIT) entry.history.splice(0, entry.history.length - HISTORY_LIMIT);
    store.prices[id] = entry;
  }
  store.updatedAt = new Date(now).toISOString();
  store.source = source;
  fs.writeFileSync(PRICES_FILE, JSON.stringify(store));
  console.log(`[prices] обновлено ${Object.keys(map).length} цен из ${source}`);
}

module.exports = { updatePrices, readJson, PLAYERS_FILE, PRICES_FILE };

if (require.main === module) {
  updatePrices().catch(err => {
    console.error('[prices] ошибка обновления:', err.message);
    process.exit(1);
  });
}
