// Драфт: общий генератор вариантов для приложения и сервера.
// Варианты зависят только от «зерна» драфта, номера пика, выбранной на этот пик позиции, числа
// перевыбросов и уже выбранного — поэтому сервер может повторить их и проверить выбор.
// Позицию для каждого пика (после капитана) игрок выбирает сам; порядок выбора приложение присылает
// серверу (order). В конце игрок может переставить игроков одной позиции между звеньями (checkArrangement).
// На каждый пик — 4 случайных варианта и запасной список (extra): если среди четырёх нет ни одной
// карточки с бонусом в звене, приложение подставляет первую подходящую из запасного списка.
// Те же правила работают и для челленджа недели: в нём варианты берутся только из карточек,
// подходящих под условие недели, и лимит зарплаты свой (challenge-core.js → challengeRules).
// В приложение этот файл попадает как обычный скрипт (scripts/build-site.js убирает export).

export const DRAFT_ORDER = [
  'CAPTAIN',
  'F1-LW', 'F1-C', 'F1-RW', 'D1-LD', 'D1-RD',
  'F2-LW', 'F2-C', 'F2-RW', 'D2-LD', 'D2-RD',
  'F3-LW', 'F3-C', 'F3-RW', 'D3-LD', 'D3-RD',
  'F4-LW', 'F4-C', 'F4-RW',
  'G-STARTER', 'G-BACKUP',
  'COACH',
];
// Капитан — первый пик и сразу встаёт в состав на свою позицию (первый слот этой позиции:
// центр → «Звено 1 · C», вратарь → основной). Этот слот потом не разыгрывается, поэтому пиков 21:
// капитан, ещё 19 игроков и тренер — в любом порядке, который выберет игрок.
export const DRAFT_SLOTS = DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH');
export const DRAFT_PICKS = DRAFT_ORDER.length - 1;
export const slotPosOf = key => (key.split('-')[1] === 'STARTER' || key.split('-')[1] === 'BACKUP' ? 'G' : key.split('-')[1]);
export const captainSlotFor = pos => DRAFT_SLOTS.find(k => slotPosOf(k) === pos) || null;
// Что ещё можно выбрать: пустые слоты (кроме слота капитана) и тренер. До капитана — только капитан.
export function openPicks(pool, picks) {
  if (picks.CAPTAIN == null) return ['CAPTAIN'];
  const p = poolIndex(pool).get(Number(picks.CAPTAIN));
  const capSlot = p ? captainSlotFor(p[1]) : null;
  return [...DRAFT_SLOTS.filter(k => k !== capSlot), 'COACH'].filter(k => picks[k] == null);
}
export const DRAFT_OPTIONS = 4; // вариантов на пик
export const DRAFT_REROLLS = 3;
export const DRAFT_CAP = Infinity; // в обычном драфте лимита зарплаты нет — в любом раунде может выпасть любая карточка
export const DRAFT_SAL_MAX = 40; // больше бонуса Salary в составе не бывает — защита от подмены
export const DRAFTS_PER_DAY = 5;
// Правила обычного драфта: все карточки, без лимита зарплаты (лимит есть только в челлендже).
// rules: { key — имя набора правил (для кэша), cap, salBonus — расширяют ли бонусы Salary лимит,
//          allow(id) — может ли карточка выпасть (null — любая),
// }
export const DRAFT_RULES = { key: 'draft', cap: DRAFT_CAP, salBonus: false, allow: null };
const EXTRA_PLAYERS = 60;
const EXTRA_COACHES = 100; // тренеров мало (~40) — в запасе все, чтобы найти того, у кого что-то сработает

// mulberry32 — маленький детерминированный генератор случайных чисел
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slotPos = key => key.split('-')[1];
const accepts = (slot, pos) => (slot === 'STARTER' || slot === 'BACKUP' ? pos === 'G' : pos === slot);
export const nameKey = name => String(name).trim().toLowerCase();

// pool: { players: [[id, pos, salary, ovr, name]], captains: [id], coaches: [id] }
// picks: { CAPTAIN: id, 'F1-LW': id, ..., COACH: id } — выбранное до этого пика
// key: позиция, которую игрок выбрал для этого пика ('CAPTAIN' на первом пике)
// rules: DRAFT_RULES или правила челленджа
// → { opts: 4 случайных, extra: запасной список для подстановки «варианта с бонусом» }
export function draftDeal(pool, seed, pickIndex, reroll, picks, key, rules = DRAFT_RULES) {
  const rand = rng((seed ^ Math.imul(pickIndex + 1, 0x9e3779b1) ^ Math.imul(reroll + 1, 0x85ebca6b)) >>> 0);
  if (key === 'COACH') return deal(pool.coaches.map(id => ({ id, w: 1 })), rand, EXTRA_COACHES);

  const byId = poolIndex(pool);
  const taken = new Set(Object.entries(picks).filter(([k]) => k !== 'COACH').map(([, id]) => byId.get(id)?.[4]).filter(Boolean).map(nameKey));
  if (key === 'CAPTAIN') {
    const caps = pool.captains.filter(id => byId.has(id)).map(id => ({ id, w: weight(byId.get(id)[3]), name: nameKey(byId.get(id)[4]) }));
    if (!rules.allow) return deal(caps, rand, 0);
    // Челлендж: капитан стоит в составе, значит должен подходить под условие недели. Сначала карточки
    // капитанов под условие; если их меньше четырёх — добираем подходящими игроками (они станут капитаном).
    const first = sample(caps.filter(c => rules.allow(c.id)), rand, DRAFT_OPTIONS);
    if (first.length >= DRAFT_OPTIONS) return { opts: first, extra: [] };
    const names = new Set(first.map(id => nameKey(byId.get(id)[4])));
    const rest = allowed(pool, rules).filter(p => !names.has(nameKey(p[4]))).map(p => ({ id: p[0], w: weight(p[3]), name: nameKey(p[4]) }));
    return { opts: [...first, ...sample(rest, rand, DRAFT_OPTIONS - first.length)], extra: [] };
  }
  // Оставляем запас на каждый ещё не выбранный слот, поэтому на любом пике есть хотя бы одна карточка,
  // которая укладывается в лимит. Сначала запас с походом (7-я по дешевизне карточка позиции) —
  // так работает обычный драфт. Если с ним не выпадает ничего (узкий пул челленджа, например один клуб),
  // берём точный запас: самые дешёвые свободные игроки на оставшиеся слоты (с одним игроком про запас,
  // а если и так ничего — без него).
  const remaining = openPicks(pool, picks).filter(k => k !== key && k !== 'COACH');
  const cheapest = minSalaries(pool, rules);
  const room = rules.cap - salarySpent(pool, picks) + 1e-6;
  const free = bySlot(pool, slotPos(key), rules).filter(p => !taken.has(p.name));
  const reserves = [
    () => remaining.reduce((t, k) => t + cheapest(slotPos(k)), 0),
    () => exactReserve(pool, rules, remaining, taken, 1),
    () => exactReserve(pool, rules, remaining, taken, 0),
  ];
  for (const reserve of reserves) {
    const budget = room - reserve();
    const cands = free.filter(p => p.salary <= budget);
    if (cands.length) return deal(cands, rand, EXTRA_PLAYERS);
  }
  return deal([], rand, EXTRA_PLAYERS);
}

// Точный запас на оставшиеся слоты: по каждой позиции — сумма самых дешёвых ещё свободных игроков.
// skip — сколько самых дешёвых пропустить (запас на случай, если их возьмут на текущем пике).
function exactReserve(pool, rules, remaining, taken, skip) {
  const need = {};
  for (const k of remaining) { const s = slotPos(k) === 'BACKUP' ? 'STARTER' : slotPos(k); need[s] = (need[s] || 0) + 1; }
  let total = 0;
  for (const [slot, n] of Object.entries(need)) {
    const list = cheapestNames(pool, rules)[slot].filter(([name]) => !taken.has(name));
    const from = list.length >= n + skip ? skip : 0;
    if (list.length < n) return Infinity;
    for (let i = from; i < from + n; i++) total += list[i][1];
  }
  return total;
}

// По позициям: [имя, самая низкая зарплата его карточек], по возрастанию зарплаты.
function cheapestNames(pool, rules) {
  return cached(pool, rules, 'names', () => {
    const r = {};
    for (const slot of ['LW', 'C', 'RW', 'LD', 'RD', 'STARTER']) {
      const best = new Map();
      for (const p of bySlot(pool, slot, rules)) if (!best.has(p.name) || p.salary < best.get(p.name)) best.set(p.name, p.salary);
      r[slot] = [...best].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    }
    return r;
  });
}

// Кэш по пулу и набору правил: раскладка карточек и запас бюджета считаются один раз.
const ruleCache = new WeakMap();
function cached(pool, rules, name, make) {
  let byPool = ruleCache.get(pool);
  if (!byPool) ruleCache.set(pool, (byPool = new Map()));
  const k = `${rules.key}|${name}`;
  if (!byPool.has(k)) byPool.set(k, make());
  return byPool.get(k);
}
const allowed = (pool, rules) => cached(pool, rules, 'players', () => (rules.allow ? pool.players.filter(p => rules.allow(p[0])) : pool.players));

// Карточки по позициям, с готовыми весами — раскладываем один раз на пул и правила.
function bySlot(pool, slot, rules) {
  const m = cached(pool, rules, 'slots', () => {
    const r = {};
    for (const s of ['LW', 'C', 'RW', 'LD', 'RD', 'STARTER']) {
      r[s] = allowed(pool, rules).filter(p => accepts(s, p[1])).map(p => ({ id: p[0], salary: p[2], w: weight(p[3]), name: nameKey(p[4]) }));
    }
    r.BACKUP = r.STARTER;
    return r;
  });
  return m[slot];
}

// Для совместимости: только варианты пика (без запасного списка).
export const draftOptions = (...a) => draftDeal(...a).opts;

function deal(cands, rand, extraCount) {
  const all = sample(cands, rand, DRAFT_OPTIONS + extraCount);
  return { opts: all.slice(0, DRAFT_OPTIONS), extra: all.slice(DRAFT_OPTIONS) };
}

export function salarySpent(pool, picks) {
  const byId = poolIndex(pool);
  let s = 0;
  for (const [k, id] of Object.entries(picks)) if (k !== 'COACH') s += byId.get(id)?.[2] || 0; // капитан — тоже игрок состава
  return Math.round(s * 10) / 10;
}

// Чем выше рейтинг, тем чаще выпадает карточка, но сильные — редкость.
// Веса — целые числа: приложение (на iPhone другой движок JavaScript) и сервер считают одинаково.
// Базовые карточки ниже 80 есть в драфте, но выпадают редко (~1 вариант из 7).
const weight = ovr => {
  const d = ovr - 79;
  return d <= 0 ? 3 : 60 * d + 8 * d * d;
};

// Взвешенная выборка без повторов: дерево Фенвика по целым весам — быстро даже на 8000 карточек.
function sample(cands, rand, n = DRAFT_OPTIONS) {
  const N = cands.length;
  const w = cands.map(c => c.w);
  const tree = new Array(N + 1).fill(0);
  let total = 0;
  for (let i = 0; i < N; i++) {
    total += w[i];
    for (let j = i + 1; j <= N; j += j & -j) tree[j] += w[i];
  }
  let top = 1;
  while (top * 2 <= N) top *= 2;
  // Разные карточки одного игрока (по имени) в одну раздачу не попадают: вытянули — убираем все его карточки.
  const sameName = new Map();
  cands.forEach((c, i) => { if (c.name) (sameName.get(c.name) || sameName.set(c.name, []).get(c.name)).push(i); });
  const drop = i => {
    if (!w[i]) return;
    for (let j = i + 1; j <= N; j += j & -j) tree[j] -= w[i];
    total -= w[i];
    w[i] = 0;
  };
  const out = [];
  while (out.length < n && total > 0) {
    let rem = Math.floor(rand() * total);
    let pos = 0;
    for (let step = top; step; step >>= 1) {
      if (pos + step <= N && tree[pos + step] <= rem) { pos += step; rem -= tree[pos]; }
    }
    out.push(cands[pos].id);
    if (cands[pos].name) for (const i of sameName.get(cands[pos].name)) drop(i);
    else drop(pos);
  }
  return out;
}

function minSalaries(pool, rules) {
  return cached(pool, rules, 'min', () => {
    const m = {};
    // Не самая дешёвая карточка, а 7-я по дешевизне среди разных игроков: на одну позицию в составе
    // уходит максимум 4 игрока + капитан, так что хотя бы одна карточка в пределах запаса всегда свободна.
    for (const slot of ['LW', 'C', 'RW', 'LD', 'RD', 'STARTER']) {
      const best = new Map();
      for (const p of allowed(pool, rules)) {
        if (!accepts(slot, p[1])) continue;
        const k = nameKey(p[4]);
        if (!best.has(k) || p[2] < best.get(k)) best.set(k, p[2]);
      }
      const sorted = [...best.values()].sort((a, b) => a - b);
      m[slot] = sorted.length ? sorted[Math.min(6, sorted.length - 1)] : 0;
    }
    m.BACKUP = m.STARTER;
    return slot => m[slot];
  });
}

const indexCache = new WeakMap();
function poolIndex(pool) {
  let m = indexCache.get(pool);
  if (!m) { m = new Map(pool.players.map(p => [p[0], p])); indexCache.set(pool, m); }
  return m;
}

// Пятёрка, которую видит игрок: если среди пяти нет ни одного варианта «с бонусом» (hasBonus),
// один вариант заменяется первым подходящим из запасного списка. Общий код для приложения и сервера.
export function finalOptions(dealt, key, seed, pickIndex, hasBonus) {
  const options = dealt.opts.slice();
  if (hasBonus && key !== 'CAPTAIN' && options.length && !options.some(id => hasBonus(id))) {
    const bonus = dealt.extra.find(id => hasBonus(id));
    if (bonus != null) options[(seed + pickIndex) % options.length] = bonus;
  }
  return options;
}

// Проверка завершённого драфта: каждый выбор — из выпавших вариантов (5 + запасной список),
// игроки не повторяются, перевыбросов не больше разрешённого, зарплата в лимите.
// rerolls: { [pickIndex]: сколько раз перевыбрасывали }, salAt: { [pickIndex]: бонус Salary на момент пика }.
// Проверка завершённого драфта: order — позиции в том порядке, в котором игрок их выбирал
// (первой — 'CAPTAIN', дальше каждый свободный слот и тренер ровно по разу). Каждый выбор — только из
// той четвёрки, которую видел игрок (hasBonus — тот же признак «варианта с бонусом», что в приложении).
export function verifyDraft(pool, seed, picks, order, rerolls, rules = DRAFT_RULES, hasBonus = null) {
  const used = Object.values(rerolls || {}).reduce((t, n) => t + n, 0);
  if (used > DRAFT_REROLLS) return 'too many rerolls';
  if (!Array.isArray(order) || order.length !== DRAFT_PICKS || order[0] !== 'CAPTAIN') return 'bad order';
  const done = {};
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (!openPicks(pool, done).includes(key)) return `bad order ${key}`;
    const choice = picks[key];
    if (choice == null) return `missing ${key}`;
    const dealt = draftDeal(pool, seed, i, rerolls?.[i] || 0, done, key, rules);
    const allowedIds = hasBonus ? finalOptions(dealt, key, seed, i, id => hasBonus(key, id, done)) : [...dealt.opts, ...dealt.extra];
    if (!allowedIds.includes(choice)) return `bad pick ${key}`;
    done[key] = choice;
  }
  if (salarySpent(pool, picks) > rules.cap + 0.05) return 'salary cap';
  return null;
}

// Итоговая расстановка: те же 20 игроков (капитан и 19 выбранных), каждый — в слоте своей позиции.
// Менять местами можно только игроков одной позиции (например, центров разных звеньев).
export function checkArrangement(pool, picks, arrangement) {
  const byId = poolIndex(pool);
  const picked = [picks.CAPTAIN, ...Object.entries(picks).filter(([k]) => k !== 'CAPTAIN' && k !== 'COACH').map(([, id]) => id)].map(Number).sort((a, b) => a - b);
  const placed = DRAFT_SLOTS.map(k => Number(arrangement?.[k])).sort((a, b) => a - b);
  if (picked.length !== DRAFT_SLOTS.length || picked.join() !== placed.join()) return 'arrangement players';
  for (const k of DRAFT_SLOTS) if (byId.get(Number(arrangement[k]))?.[1] !== slotPosOf(k)) return `arrangement position ${k}`;
  return null;
}
