// Собирает приложение в _site/ (его отдаёт Cloudflare Worker): public/ + data/.
// Версия = хэш кода приложения: подставляется в ссылки на файлы и в version.json,
// чтобы Telegram не показывал старую версию из кэша.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(PUBLIC, OUT, { recursive: true });
fs.cpSync(DATA, path.join(OUT, 'data'), { recursive: true });

const hash = crypto.createHash('sha1');
for (const f of fs.readdirSync(PUBLIC).sort()) hash.update(fs.readFileSync(path.join(PUBLIC, f)));
const version = hash.digest('hex').slice(0, 10);

const index = path.join(OUT, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replaceAll('__APP_VERSION__', version));
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ v: version }));

console.log(`_site собран, версия ${version}`);
