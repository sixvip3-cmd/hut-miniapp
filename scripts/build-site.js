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

// ---------- Индекс для инлайн-поиска бота ----------
// data/search/<буква>.json — карточки, у которых какое-то слово имени начинается с этой буквы;
// data/search/top.json — самые дорогие карточки (для пустого запроса).
const players = JSON.parse(fs.readFileSync(path.join(DATA, 'players.json'), 'utf8'));
const prices = JSON.parse(fs.readFileSync(path.join(DATA, 'prices.json'), 'utf8')).prices || {};
const priceOf = p => prices[p.id]?.price || 0;
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const row = p => [p.id, p.name, p.ovr, p.pos, p.card, p.team, p.img, priceOf(p)];

const buckets = {};
for (const p of players) {
  if (!p.img) continue;
  const keys = new Set(norm(p.name).split(/[\s-]+/).filter(Boolean).map(w => (/^[a-z]$/.test(w[0]) ? w[0] : '_')));
  for (const k of keys) (buckets[k] ||= []).push(row(p));
}
const searchDir = path.join(OUT, 'data', 'search');
fs.mkdirSync(searchDir, { recursive: true });
for (const [k, rows] of Object.entries(buckets)) fs.writeFileSync(path.join(searchDir, `${k}.json`), JSON.stringify(rows));
const top = players.filter(p => p.img && priceOf(p)).sort((a, b) => priceOf(b) - priceOf(a)).slice(0, 30).map(row);
fs.writeFileSync(path.join(searchDir, 'top.json'), JSON.stringify(top));

// ---------- Дайджест за последние сутки ----------
const nowSec = Math.floor(Date.now() / 1000);
const dayAgo = nowSec - 24 * 3600;
const newCards = players.filter(p => p.added && p.added > dayAgo).sort((a, b) => b.ovr - a.ovr);
const movers = [];
for (const p of players) {
  const h = prices[p.id]?.history;
  if (!h || h.length < 2) continue;
  const current = h[h.length - 1][1];
  // Цена сутки назад: последняя точка не позже, чем 24 часа назад.
  const before = [...h].reverse().find(([ts]) => ts / 1000 <= dayAgo);
  if (!before || !before[1] || current < 1000) continue;
  const change = Math.round(((current - before[1]) / before[1]) * 1000) / 10;
  if (Math.abs(change) >= 3) movers.push({ name: p.name, ovr: p.ovr, card: p.card, price: current, change });
}
// data/featured.json — «тройка дня» и т.п.: попадает в дайджест только в указанную дату (UTC).
const featuredFile = path.join(DATA, 'featured.json');
const featured = fs.existsSync(featuredFile) ? JSON.parse(fs.readFileSync(featuredFile, 'utf8')) : null;
const digest = {
  generatedAt: new Date().toISOString(),
  featured,
  newCount: newCards.length,
  newCards: newCards.slice(0, 10).map(p => ({ name: p.name, ovr: p.ovr, card: p.card })),
  up: movers.filter(m => m.change > 0).sort((a, b) => b.change - a.change).slice(0, 5),
  down: movers.filter(m => m.change < 0).sort((a, b) => a.change - b.change).slice(0, 5),
};
fs.writeFileSync(path.join(OUT, 'data', 'digest.json'), JSON.stringify(digest));
console.log(`поиск: ${Object.keys(buckets).length} файлов; дайджест: новых ${digest.newCount}, рост ${digest.up.length}, падение ${digest.down.length}`);

// ---------- Характеристики игроков: маленькими файлами по остатку id ----------
// Приложение грузит только нужный файл (~10 КБ) при открытии карточки игрока.
const STAT_CHUNKS = 64;
const statsFile = path.join(DATA, 'stats.json');
if (fs.existsSync(statsFile)) {
  const { order, players: values } = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  const dir = path.join(OUT, 'data', 'stats');
  fs.mkdirSync(dir, { recursive: true });
  const chunks = Array.from({ length: STAT_CHUNKS }, () => ({}));
  for (const [id, v] of Object.entries(values)) chunks[Number(id) % STAT_CHUNKS][id] = v;
  chunks.forEach((c, i) => fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(c)));
  fs.writeFileSync(path.join(dir, 'order.json'), JSON.stringify({ chunks: STAT_CHUNKS, order }));
  fs.rmSync(path.join(OUT, 'data', 'stats.json'), { force: true });
  console.log(`характеристики: ${Object.keys(values).length} игроков в ${STAT_CHUNKS} файлах`);
}
