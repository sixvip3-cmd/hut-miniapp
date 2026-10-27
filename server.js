// HUT Mini App server: статика + API + ежечасное обновление цен.
// Без зависимостей, нужен Node 18+.
//
// ENV:
//   PORT              порт (по умолчанию 3000)
//   PRICE_SOURCE_URL  источник цен (см. scripts/update-prices.js)
//   PRICE_INTERVAL_MS интервал обновления (по умолчанию 1 час)
//   BOT_TOKEN         токен бота — чтобы поставить кнопку «Открыть» в меню чата
//   WEBAPP_URL        публичный https-адрес мини-аппа

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PRICE_INTERVAL_MS = Number(process.env.PRICE_INTERVAL_MS) || 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const { updatePrices: runUpdate, readJson, PLAYERS_FILE, PRICES_FILE } = require('./scripts/update-prices');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function loadPlayers() {
  return readJson(PLAYERS_FILE, []);
}

function loadPrices() {
  return readJson(PRICES_FILE, { updatedAt: null, source: null, prices: {} });
}

async function updatePrices() {
  try {
    await runUpdate();
  } catch (err) {
    console.error('[prices] ошибка обновления:', err.message);
  }
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const root = urlPath.startsWith('/data/') ? __dirname : PUBLIC_DIR;
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root === __dirname ? DATA_DIR : PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/players')) return sendJson(res, loadPlayers());
  if (req.url.startsWith('/api/prices')) {
    const store = loadPrices();
    return sendJson(res, { ...store, nextUpdateAt: new Date(nextUpdateAt).toISOString() });
  }
  serveStatic(req, res);
});

async function setupBotMenu() {
  const { BOT_TOKEN, WEBAPP_URL } = process.env;
  if (!BOT_TOKEN || !WEBAPP_URL) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Открыть HUT', web_app: { url: WEBAPP_URL } } }),
    });
    console.log('[bot] setChatMenuButton:', (await res.json()).ok ? 'ok' : 'failed');
  } catch (err) {
    console.error('[bot] ошибка:', err.message);
  }
}

let nextUpdateAt = Date.now() + PRICE_INTERVAL_MS;

server.listen(PORT, async () => {
  console.log(`HUT Mini App: http://localhost:${PORT}`);
  await updatePrices();
  setInterval(() => {
    nextUpdateAt = Date.now() + PRICE_INTERVAL_MS;
    updatePrices();
  }, PRICE_INTERVAL_MS);
  setupBotMenu();
});
