// Открыть приложение в обычном браузере, без Telegram — только для локальной проверки.
//
//   npm run dev            (в одном терминале: воркер на http://127.0.0.1:8787)
//   npm run dev:open       (в другом: http://127.0.0.1:8790/dev)
//
// Что делает: на порту 8790 стоит прокси к `wrangler dev`. Страница /dev подписывает данные
// тестового пользователя локальным BOT_TOKEN из .dev.vars (как это делает Telegram) и открывает
// приложение. Тестовому пользователю выдаётся подписка в локальной базе. Вызовы Bot API
// (счёт, отправка картинки) отвечает заглушка — укажите в .dev.vars
// TELEGRAM_API_BASE=http://127.0.0.1:8790. На настоящий сервер всё это не влияет:
// без настоящего токена бота подпись не пройдёт.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8790);
const TARGET = process.env.TARGET || 'http://127.0.0.1:8787';
const USER = { id: Number(process.env.DEV_USER_ID || 1001), first_name: 'Тестер', username: 'tester' };

const vars = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8')
  .split('\n').filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const TOKEN = vars.BOT_TOKEN;
if (!TOKEN) throw new Error('Нет BOT_TOKEN в .dev.vars');

// Тестовому пользователю — подписка на 30 дней в локальной базе.
try {
  const until = Math.floor(Date.now() / 1000) + 30 * 86400;
  execSync(`npx wrangler d1 execute hut-builder --local --command "INSERT OR REPLACE INTO subscriptions (user_id, until, charge_id) VALUES (${USER.id}, ${until}, 'dev')"`,
    { cwd: ROOT, stdio: 'ignore' });
} catch {
  console.warn('Не удалось выдать подписку — сначала: npx wrangler d1 execute hut-builder --local --file worker/schema.sql');
}

function initData() {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'dev', user: JSON.stringify(USER) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

// Заглушка Bot API: всем методам — успех.
function botApi(method, res) {
  const results = {
    getMe: { id: 1, is_bot: true, username: vars.BOT_USERNAME || 'hut_dev_bot', supports_inline_queries: true },
    createInvoiceLink: 'https://t.me/$dev-invoice',
    sendPhoto: { message_id: 1, photo: [{ file_id: 'dev' }] },
    savePreparedInlineMessage: { id: 'dev' },
    sendMessage: { message_id: 1 },
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: results[method] ?? true }));
}

http.createServer((req, res) => {
  const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
  if (m) return req.resume().on('end', () => botApi(m[1], res));
  if (req.url === '/dev' || req.url === '/dev/') {
    const hash = `tgWebAppData=${encodeURIComponent(initData())}&tgWebAppVersion=8.0&tgWebAppPlatform=ios&tgWebAppThemeParams=%7B%7D`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>HUT Builder — dev</title>
<script>sessionStorage.clear(); location.replace('/#${hash}');</script>`);
  }
  const url = new URL(req.url, TARGET);
  const headers = { ...req.headers, host: url.host };
  const up = http.request(url, { method: req.method, headers }, r => {
    const h = { ...r.headers };
    if (h.location) h.location = h.location.replace(TARGET, ''); // абсолютные редиректы воркера → относительные
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('Воркер не запущен: npm run dev'); });
  req.pipe(up);
}).listen(PORT, () => console.log(`Откройте http://127.0.0.1:${PORT}/dev (пользователь ${USER.id})`));
