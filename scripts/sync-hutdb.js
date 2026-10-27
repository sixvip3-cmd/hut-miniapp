// Синхронизация с hutdb.app: игроки, цены маркета, комбинации сыгранности, капитаны.
//
// Открывает страницу /squad-builder в headless-браузере (как обычный посетитель),
// сохраняет данные, которые страница сама загружает, и пишет:
//   data/players.json  — все карточки
//   data/prices.json   — цены (с нашей историей изменений)
//   data/combos.json   — line combos (OVR / SAL / AP)
//   data/captains.json — правила капитанов
//
// Запуск: node scripts/sync-hutdb.js   (нужен playwright + chromium или PW_CHANNEL=chrome)

const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://www.hutdb.app/squad-builder';
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_LIMIT = 30; // точек истории цены на игрока (пишем только изменения)
const MIN_PLAYERS = 3000; // защита: не перезаписываем данные, если загрузилось подозрительно мало
const MIN_COMBOS = 100;

// ---------- Справочники hutdb (из их combo_image_map) ----------
const TEAM_CODES = {
  ANA: ['ANAHEIM DUCKS'], BOS: ['BOSTON BRUINS'], BUF: ['BUFFALO SABRES'], CAR: ['CAROLINA HURRICANES'],
  CBJ: ['COLUMBUS BLUE JACKETS'], CGY: ['CALGARY FLAMES'], CHI: ['CHICAGO BLACKHAWKS'], COL: ['COLORADO AVALANCHE'],
  DAL: ['DALLAS STARS'], DET: ['DETROIT RED WINGS'], EDM: ['EDMONTON OILERS'], FLA: ['FLORIDA PANTHERS'],
  LAK: ['LOS ANGELES KINGS'], MIN: ['MINNESOTA WILD'], MTL: ['MONTREAL CANADIENS'], NJD: ['NEW JERSEY DEVILS'],
  NSH: ['NASHVILLE PREDATORS'], NYI: ['NEW YORK ISLANDERS'], NYR: ['NEW YORK RANGERS'], OTT: ['OTTAWA SENATORS'],
  PHI: ['PHILADELPHIA FLYERS'], PIT: ['PITTSBURGH PENGUINS'], SEA: ['SEATTLE KRAKEN'], SJS: ['SAN JOSE SHARKS'],
  STL: ['ST LOUIS BLUES', 'ST. LOUIS BLUES'], TOR: ['TORONTO MAPLE LEAFS'], UTA: ['UTAH MAMMOTH'],
  VAN: ['VANCOUVER CANUCKS'], VGK: ['VEGAS GOLDEN KNIGHTS'], WPG: ['WINNIPEG JETS'], WSH: ['WASHINGTON CAPITALS'],
  TBL: ['TAMPA BAY LIGHTNING'], HFD: ['HARTFORD WHALERS'], QUE: ['QUEBEC NORDIQUES'],
  NY: ['NEW YORK RANGERS', 'NEW YORK ISLANDERS'],
};
const NATIONS = {
  Austria: 'AUSTRIA', Canada: 'CANADA', Czechia: 'CZECHIA', Finland: 'FINLAND', Germany: 'GERMANY', Latvia: 'LATVIA',
  LATVIA: 'LATVIA', Russia: 'RUSSIA', Slovakia: 'SLOVAKIA', Sweden: 'SWEDEN', Switzerland: 'SWITZERLAND', USA: 'USA',
};
const CARD_PREFIXES = {
  ALUM: 'ALUMNI', BA: 'BASE', BASE: 'BASE', CAP: 'CAPTAINS', CHEL: 'CHEL WEEK', CMG: 'CHECK MY GAME',
  FANT: 'FANTASY HOCKEY', FI: 'FRESH ICE', GB: 'HUT GAME BREAKERS', GM: 'GRUDGE MATCH', HH: 'HUT HEROES',
  HRS: 'HUT RANKED SEASONS', HUTC: 'HUT CHAMPIONS', ICON: 'ICONS', IG: 'IGNITED', LP: 'LAUNCH POINT',
  MARQ: 'MARQUEE', MILE: 'MILESTONES', ODR: 'HUT ODR SZN', PIN: 'PINNACLE', PRO: 'PROTOTYPES',
  RB: 'RECORD BREAKERS', ROOK: 'ROOKIES', SO: 'SUPERSTAR ORIGINS', SOTM: 'STARS OF THE MONTH', SPOT: 'SPOTLIGHT',
  TQ: 'TRADE QUEST', TOTS: 'TEAM OF THE SEASON', TOTW: 'TEAM OF THE WEEK', TRAN: 'TRANSACTIONS',
  TOTY: 'TEAM OF THE YEAR', XP: 'XP',
};
const EXTRA_TEAMS = {
  ORE723578211: ['ÖREBRO HOCKEY', 'OREBRO HOCKEY'], SKE665842716: ['SKELLEFTEÅ', 'SKELLEFTEA', 'SKELLEFTE AIK'],
  BAR561568290: ['BARRIE COLTS'], SAG2060077246: ['SAGINAW SPIRIT'], BOS1675369414: ['BOSTON FLEET'],
  FHC1319618849: ['FRÖLUNDA HC'], MIN331544320: ['MINNESOTA FROST'], MTL933335877: ['MONTREAL VICTOIRE'],
  NY1593607409: ['NEW YORK SIRENS'], OTT594377757: ['OTTAWA CHARGE'], SEA1450460351: ['SEATTLE TORRENT'],
  TOR1508148519: ['TORONTO SCEPTRES'], VAN1737906214: ['VANCOUVER GOLDENEYES'],
};

const titleCase = s => s.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
const stemOf = img => img.split('/').pop().replace(/\.\w+$/, '');

// Требование слота комбинации → { type, label, team[] | nation | card | ids[] }
function resolveStem(stem, overrides) {
  const o = overrides.get(stem);
  if (o) {
    if (o.kind === 'team') {
      const kw = (o.team_keywords || []).map(k => String(k).trim().toUpperCase()).filter(Boolean);
      if (kw.length) return { type: 'team', label: titleCase(kw[0]), team: kw };
    }
    if (o.kind === 'nationality' && o.string_value) {
      const v = o.string_value.trim().toUpperCase();
      return { type: 'nation', label: titleCase(v), nation: v };
    }
    if (o.kind === 'card' && o.string_value) {
      const v = o.string_value.trim().toUpperCase();
      return { type: 'card', label: v, card: v };
    }
    if (o.kind === 'player_ids' && o.player_ids?.length) {
      return { type: 'players', label: stem, ids: o.player_ids.map(Number) };
    }
    if (o.kind === 'all_cards') return { type: 'any', label: 'Любая карточка' };
  }
  if (NATIONS[stem]) return { type: 'nation', label: titleCase(NATIONS[stem]), nation: NATIONS[stem] };
  if (/^[A-Z]{2,4}$/.test(stem) && TEAM_CODES[stem]) {
    return { type: 'team', label: titleCase(TEAM_CODES[stem][0]), team: TEAM_CODES[stem] };
  }
  const m = stem.match(/^(\p{L}+)(\d+)$/u);
  if (m) {
    const prefix = m[1];
    if (CARD_PREFIXES[prefix]) return { type: 'card', label: CARD_PREFIXES[prefix], card: CARD_PREFIXES[prefix] };
    if (EXTRA_TEAMS[stem]) return { type: 'team', label: titleCase(EXTRA_TEAMS[stem][0]), team: EXTRA_TEAMS[stem] };
    if (TEAM_CODES[prefix]) return { type: 'team', label: titleCase(TEAM_CODES[prefix][0]), team: TEAM_CODES[prefix] };
  }
  return { type: 'unknown', label: stem };
}

function parseBoost(text) {
  const b = { OVR: 0, SAL: 0, AP: 0 };
  for (const [, n, t] of String(text).matchAll(/\+(\d+)\s+(OVR|SAL|AP)/g)) b[t] += Number(n);
  return b;
}

const CATS = { Forwards: 'F', Defense: 'D', Goalies: 'G' };

// ---------- Загрузка ----------
async function capture() {
  const { chromium } = require('playwright');
  // PW_CHANNEL=chrome — использовать установленный Google Chrome (есть на раннерах GitHub).
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage();
  const bodies = { players: [], combos: [], combo_stem_overrides: [], captain_rules: [] };
  const pending = [];
  page.on('response', res => {
    const m = res.url().match(/\/rest\/v1\/(players|combos|combo_stem_overrides|captain_rules)\?/);
    if (!m || res.status() !== 200) return;
    pending.push(res.json().then(rows => { if (Array.isArray(rows)) bodies[m[1]].push(...rows); }).catch(() => {}));
  });
  try {
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(3000);
    await Promise.all(pending);
  } finally {
    await browser.close();
  }
  return bodies;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data));
}

async function main() {
  const raw = await capture();

  // Игроки: убираем дубли (страница может загрузить пачку дважды).
  const byId = new Map();
  for (const r of raw.players) byId.set(r.id, r);
  if (byId.size < MIN_PLAYERS) throw new Error(`загружено только ${byId.size} игроков — данные не тронуты`);
  if (raw.combos.length < MIN_COMBOS) throw new Error(`загружено только ${raw.combos.length} комбинаций — данные не тронуты`);

  const players = [...byId.values()]
    .map(r => ({
      id: r.id,
      name: r.name,
      ovr: r.overall,
      pos: r.position,
      team: r.bio?.team || r.team || '',
      nation: r.bio?.nationality || r.nationality || '',
      card: r.bio?.card || '',
      league: r.bio?.league || '',
      salary: parseFloat(String(r.bio?.salary || '0').replace(/[^\d.]/g, '')) || 0,
      shoots: r.bio?.shoots || '',
      abilities: (r.abilities || []).map(a => [a.name, a.ap_cost ?? 1]),
      img: (r.image_url || '').replace(/^\/?cards\//, ''), // картинка: storage hutdb, папка cards/
    }))
    .sort((a, b) => b.ovr - a.ovr || a.id - b.id);

  // Комбинации
  const overrides = new Map(raw.combo_stem_overrides.map(o => [o.stem, o]));
  const seen = new Set();
  const combos = [];
  let unknown = 0;
  for (const c of raw.combos) {
    if (seen.has(c.id) || !CATS[c.position_category]) continue;
    seen.add(c.id);
    const reqs = (c.combo_images || []).map(img => resolveStem(stemOf(img), overrides));
    unknown += reqs.filter(r => r.type === 'unknown').length;
    combos.push({ id: c.id, cat: CATS[c.position_category], boost: parseBoost(c.boost), reqs });
  }

  // Цены: дописываем историю только при изменении.
  const pricesFile = path.join(DATA_DIR, 'prices.json');
  const store = readJson(pricesFile, { prices: {} });
  const now = Date.now();
  const prices = {};
  for (const r of byId.values()) {
    const price = r.market?.price;
    if (!price) continue;
    const old = store.prices?.[r.id];
    const entry = old ? { ...old } : { price: null, prev: null, history: [] };
    if (entry.price !== price) {
      entry.prev = entry.price;
      entry.price = price;
      entry.history = [...(entry.history || []), [now, price]].slice(-HISTORY_LIMIT);
    }
    entry.at = r.market.updated_at || null; // когда цену обновили на hutdb
    entry.by = r.market.updated_by_display || null;
    prices[r.id] = entry;
  }

  // Капитаны: клубы/страны, сколько игроков нужно и бонус.
  const upper = s => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  const captains = raw.captain_rules
    .filter(r => r.active !== false && (r.teams?.length || r.nations?.length))
    .map(r => ({
      name: upper(r.name),
      playerId: r.player_id ?? null,
      teams: (r.teams || []).map(upper),
      nations: (r.nations || []).map(upper),
      needed: Number(r.players_needed) || 5,
      ap: Number(r.ap_boost) || 0,
      sal: Number(r.sal_boost) || 0,
      cardTypes: (r.card_types?.length ? r.card_types : ['CAPTAINS']).map(upper),
    }));

  writeJson('players.json', players);
  if (captains.length) writeJson('captains.json', captains);
  writeJson('combos.json', combos);
  writeJson('prices.json', { updatedAt: new Date(now).toISOString(), source: 'hutdb.app', prices });

  console.log(`[hutdb] игроков: ${players.length}, цен: ${Object.keys(prices).length}, комбинаций: ${combos.length}, капитанов: ${captains.length}, нераспознанных требований: ${unknown}`);
}

main().catch(err => {
  console.error('[hutdb] ошибка:', err.message);
  process.exit(1);
});
