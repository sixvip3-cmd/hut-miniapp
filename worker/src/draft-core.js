// Драфт: общий генератор вариантов для приложения и сервера.
// Варианты зависят только от «зерна» драфта, номера пика, числа перевыбросов, уже выбранного
// и бонуса Salary на момент пика — поэтому сервер может повторить их и проверить выбор.
// На каждый пик — 5 случайных вариантов и запасной список (extra): если среди пяти нет ни одной
// карточки с бонусом в звене, приложение подставляет первую подходящую из запасного списка.
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
export const DRAFT_OPTIONS = 5;
export const DRAFT_REROLLS = 3;
export const DRAFT_CAP = 80; // базовый лимит суммарной зарплаты 20 игроков, $M (+ бонусы Salary)
export const DRAFT_SAL_MAX = 40; // больше бонуса Salary в составе не бывает — защита от подмены
export const DRAFTS_PER_DAY = 5;
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
// salBonus: бонус Salary состава на момент пика (расширяет лимит, как в игре)
// → { opts: 5 случайных, extra: запасной список для подстановки «варианта с бонусом» }
export function draftDeal(pool, seed, pickIndex, reroll, picks, salBonus = 0) {
  const key = DRAFT_ORDER[pickIndex];
  const rand = rng((seed ^ Math.imul(pickIndex + 1, 0x9e3779b1) ^ Math.imul(reroll + 1, 0x85ebca6b)) >>> 0);
  if (key === 'COACH') return deal(pool.coaches.map(id => ({ id, w: 1 })), rand, EXTRA_COACHES);

  const byId = poolIndex(pool);
  const taken = new Set(Object.entries(picks).filter(([k]) => k !== 'COACH').map(([, id]) => byId.get(id)?.[4]).filter(Boolean).map(nameKey));
  if (key === 'CAPTAIN') {
    return deal(pool.captains.filter(id => byId.has(id)).map(id => ({ id, w: weight(byId.get(id)[3]) })), rand, 0);
  }
  // Оставляем запас на каждый ещё не выбранный слот — по самой дешёвой карточке этой позиции,
  // поэтому на любом пике есть хотя бы одна карточка, которая укладывается в лимит.
  const cheapest = minSalaries(pool);
  const reserve = DRAFT_ORDER.slice(pickIndex + 1).filter(k => k !== 'COACH' && k !== 'CAPTAIN')
    .reduce((t, k) => t + cheapest(slotPos(k)), 0);
  const sal = Math.max(0, Math.min(Number(salBonus) || 0, DRAFT_SAL_MAX));
  const budget = DRAFT_CAP + sal - salarySpent(pool, picks) - reserve + 1e-6;
  const cands = [];
  for (const p of bySlot(pool, slotPos(key))) {
    if (p.salary > budget || taken.has(p.name)) continue;
    cands.push(p);
  }
  return deal(cands, rand, EXTRA_PLAYERS);
}

// Карточки по позициям, с готовыми весами — раскладываем один раз на пул.
const slotCache = new WeakMap();
function bySlot(pool, slot) {
  let m = slotCache.get(pool);
  if (!m) {
    m = {};
    for (const s of ['LW', 'C', 'RW', 'LD', 'RD', 'STARTER']) {
      m[s] = pool.players.filter(p => accepts(s, p[1])).map(p => ({ id: p[0], salary: p[2], w: weight(p[3]), name: nameKey(p[4]) }));
    }
    m.BACKUP = m.STARTER;
    slotCache.set(pool, m);
  }
  return m[slot];
}

// Для совместимости: только 5 случайных вариантов.
export const draftOptions = (...a) => draftDeal(...a).opts;

function deal(cands, rand, extraCount) {
  const all = sample(cands, rand, DRAFT_OPTIONS + extraCount);
  return { opts: all.slice(0, DRAFT_OPTIONS), extra: all.slice(DRAFT_OPTIONS) };
}

export function salarySpent(pool, picks) {
  const byId = poolIndex(pool);
  let s = 0;
  for (const [k, id] of Object.entries(picks)) if (k !== 'CAPTAIN' && k !== 'COACH') s += byId.get(id)?.[2] || 0;
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
  const out = [];
  while (out.length < n && total > 0) {
    let rem = Math.floor(rand() * total);
    let pos = 0;
    for (let step = top; step; step >>= 1) {
      if (pos + step <= N && tree[pos + step] <= rem) { pos += step; rem -= tree[pos]; }
    }
    out.push(cands[pos].id);
    for (let j = pos + 1; j <= N; j += j & -j) tree[j] -= w[pos];
    total -= w[pos];
    w[pos] = 0;
  }
  return out;
}

const minCache = new WeakMap();
function minSalaries(pool) {
  let f = minCache.get(pool);
  if (!f) {
    const m = {};
    // Не самая дешёвая карточка, а 7-я по дешевизне среди разных игроков: на одну позицию в составе
    // уходит максимум 4 игрока + капитан, так что хотя бы одна карточка в пределах запаса всегда свободна.
    for (const slot of ['LW', 'C', 'RW', 'LD', 'RD', 'STARTER']) {
      const best = new Map();
      for (const p of pool.players) {
        if (!accepts(slot, p[1])) continue;
        const k = nameKey(p[4]);
        if (!best.has(k) || p[2] < best.get(k)) best.set(k, p[2]);
      }
      const sorted = [...best.values()].sort((a, b) => a - b);
      m[slot] = sorted[Math.min(6, sorted.length - 1)];
    }
    m.BACKUP = m.STARTER;
    f = slot => m[slot];
    minCache.set(pool, f);
  }
  return f;
}

const indexCache = new WeakMap();
function poolIndex(pool) {
  let m = indexCache.get(pool);
  if (!m) { m = new Map(pool.players.map(p => [p[0], p])); indexCache.set(pool, m); }
  return m;
}

// Проверка завершённого драфта: каждый выбор — из выпавших вариантов (5 + запасной список),
// игроки не повторяются, перевыбросов не больше разрешённого, зарплата в лимите.
// rerolls: { [pickIndex]: сколько раз перевыбрасывали }, salAt: { [pickIndex]: бонус Salary на момент пика }.
export function verifyDraft(pool, seed, picks, rerolls, salAt = {}) {
  const used = Object.values(rerolls || {}).reduce((t, n) => t + n, 0);
  if (used > DRAFT_REROLLS) return 'too many rerolls';
  const done = {};
  for (let i = 0; i < DRAFT_ORDER.length; i++) {
    const key = DRAFT_ORDER[i];
    const choice = picks[key];
    if (choice == null) return `missing ${key}`;
    const { opts, extra } = draftDeal(pool, seed, i, rerolls?.[i] || 0, done, salAt?.[i] || 0);
    if (!opts.includes(choice) && !extra.includes(choice)) return `bad pick ${key}`;
    done[key] = choice;
  }
  const maxSal = Math.max(0, ...Object.values(salAt || {}).map(v => Math.min(Number(v) || 0, DRAFT_SAL_MAX)));
  if (salarySpent(pool, picks) > DRAFT_CAP + maxSal + 0.05) return 'salary cap';
  return null;
}
