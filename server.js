// HUT Mini App: локальный сервер (статика) + ежечасная синхронизация с hutdb.app.
// На GitHub Pages сервер не нужен — там синхронизацию делает GitHub Actions.
//
// ENV:
//   PORT              порт (по умолчанию 3000)
//   SYNC_INTERVAL_MS  интервал синхронизации (по умолчанию 1 час; 0 — выключить)
//   BOT_TOKEN         токен бота — чтобы поставить кнопку «Открыть» в меню чата
//   WEBAPP_URL        публичный https-адрес мини-аппа

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const SYNC_INTERVAL_MS = process.env.SYNC_INTERVAL_MS != null ? Number(process.env.SYNC_INTERVAL_MS) : 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sync() {
  execFile(process.execPath, [path.join(__dirname, 'scripts', 'sync-hutdb.js')], (err, stdout, stderr) => {
    process.stdout.write(stdout);
    if (err) process.stderr.write(stderr || `${err.message}\n`);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const isData = urlPath.startsWith('/data/');
  const root = isData ? DATA_DIR : PUBLIC_DIR;
  const file = path.join(root, isData ? urlPath.slice('/data/'.length) : urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': isData ? 'no-cache' : 'public, max-age=300',
    });
    res.end(buf);
  });
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

server.listen(PORT, () => {
  console.log(`HUT Mini App: http://localhost:${PORT}`);
  if (SYNC_INTERVAL_MS > 0) {
    sync();
    setInterval(sync, SYNC_INTERVAL_MS);
  }
  setupBotMenu();
});
