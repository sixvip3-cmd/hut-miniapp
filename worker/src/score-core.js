// Очки драфта и челленджа: общий расчёт для приложения и сервера.
// Сервер не доверяет очкам из приложения — пересчитывает их этим же кодом по выбранным карточкам.
// Химия в драфте и челлендже — как в FC: у каждого из 20 игроков 0–3 очка химии по тому, сколько в составе
// игроков его клуба (2 → +1, 4 → +2, 7 → +3) и его страны (2 → +1, 5 → +2, 8 → +3), но не больше 3.
// Химия команды — сумма, максимум 60. Линии между соседями (LW–C, C–RW, LD–RD, вратари) показывают,
// откуда химия: зелёная — один клуб, жёлтая — одна страна, красная — ничего общего.
// Комбинации звеньев HUT (+OVR/+$M/+AP) в очки драфта не идут; капитан и тренер — как раньше.
// В приложение этот файл попадает как обычный скрипт (scripts/build-site.js убирает import/export).

import { LINES, captainStatus, coachStatus, teamSummary } from './chemistry-core.js';
import { DRAFT_ORDER } from './draft-core.js';

const scorePts = b => b.OVR * 3 + b.SAL + b.AP; // OVR в очках считаем ×3

export const LINK_PTS = { g: 3, y: 1, r: 0 }; // вес связи для подсказок (какой сосед полезнее)
export const LINK_SCORE = 2; // очков драфта за одно очко химии
export const CHEM_CLUB = [[7, 3], [4, 2], [2, 1]]; // [игроков клуба в составе, химия]
export const CHEM_NATION = [[8, 3], [5, 2], [2, 1]]; // [игроков страны в составе, химия]
export const CHEM_MAX_PLAYER = 3;
const chemStep = (steps, n) => (steps.find(([need]) => n >= need) || [0, 0])[1];

// Клуб без приписки Alumni: легенда клуба связана с его нынешними игроками.
const clubKey = t => String(t || '').toUpperCase().replace(/\s+ALUMNI$/, '').replace(/^ST LOUIS/, 'ST. LOUIS').trim();
const nationKey = n => String(n || '').trim().toUpperCase();

// Связь двух соседей: 'g' — один клуб, 'y' — одна страна, 'r' — нет связи, null — кого-то нет.
export function linkKind(a, b) {
  if (!a || !b) return null;
  if (clubKey(a.team) === clubKey(b.team)) return 'g';
  if (nationKey(a.nation) === nationKey(b.nation)) return 'y';
  return 'r';
}

// Все связи состава: { links: [{ line, a, b, kind }], byLine: { F1: очки }, total, max, g, y, r }
export function lineupLinks(lineup, byId) {
  const out = { links: [], byLine: {}, total: 0, max: 0, g: 0, y: 0, r: 0 };
  for (const line of LINES) {
    out.byLine[line.id] = 0;
    for (let i = 1; i < line.slots.length; i++) {
      const a = `${line.id}-${line.slots[i - 1]}`;
      const b = `${line.id}-${line.slots[i]}`;
      const kind = linkKind(byId[lineup[a]], byId[lineup[b]]);
      out.max += LINK_PTS.g;
      out.links.push({ line: line.id, a, b, kind });
      if (!kind) continue;
      out[kind]++;
      out.total += LINK_PTS[kind];
      out.byLine[line.id] += LINK_PTS[kind];
    }
  }
  return out;
}

// Химия состава: { bySlot: { 'F1-LW': { chem, club, nation, clubN, nationN } }, byLine: { F1: сумма }, total, max, full }
// clubN / nationN — сколько в составе игроков того же клуба / страны (вместе с ним).
export function squadChem(lineup, byId) {
  const slots = LINES.flatMap(line => line.slots.map(s => `${line.id}-${s}`));
  const players = slots.map(k => [k, byId[lineup[k]]]).filter(([, p]) => p);
  const clubs = {};
  const nations = {};
  for (const [, p] of players) {
    clubs[clubKey(p.team)] = (clubs[clubKey(p.team)] || 0) + 1;
    nations[nationKey(p.nation)] = (nations[nationKey(p.nation)] || 0) + 1;
  }
  const out = { bySlot: {}, byLine: {}, total: 0, max: slots.length * CHEM_MAX_PLAYER, full: 0 };
  for (const line of LINES) out.byLine[line.id] = 0;
  for (const [k, p] of players) {
    const clubN = clubs[clubKey(p.team)];
    const nationN = nations[nationKey(p.nation)];
    const club = chemStep(CHEM_CLUB, clubN);
    const nation = chemStep(CHEM_NATION, nationN);
    const chem = Math.min(CHEM_MAX_PLAYER, club + nation);
    out.bySlot[k] = { chem, club, nation, clubN, nationN };
    out.byLine[k.split('-')[0]] += chem;
    out.total += chem;
    if (chem === CHEM_MAX_PLAYER) out.full++;
  }
  return out;
}

// Соседи слота в своей линии (с кем у него будут связи).
export function slotNeighbours(key) {
  const [lineId, slot] = key.split('-');
  const line = LINES.find(l => l.id === lineId);
  if (!line) return [];
  const i = line.slots.indexOf(slot);
  return [line.slots[i - 1], line.slots[i + 1]].filter(Boolean).map(s => `${lineId}-${s}`);
}

// lineup: { 'F1-LW': id, ... } — 20 слотов; captainId, coachId — капитан и тренер (или null)
// data: { byId: { [id]: игрок }, combos, captains, coaches }
// → очки: 4 × средний рейтинг 20 карточек + 2 × химия состава + бонусы капитана и тренера.
export function scoreLineup(lineup, captainId, coachId, data) {
  const players = LINES.flatMap(line => line.slots.map(s => data.byId[lineup[`${line.id}-${s}`]])).filter(Boolean);
  const avg = players.length ? players.reduce((t, p) => t + p.ovr, 0) / players.length : 0;
  const lines = teamSummary(lineup, data.byId, data.combos).boost; // комбинации HUT — только для бонуса Salary
  const squad = squadChem(lineup, data.byId);
  const captain = captainId != null ? data.byId[captainId] : null;
  const cap = captain ? captainStatus(captain, players, data.captains) : null;
  const coach = coachId != null ? data.coaches.find(c => c.id === coachId) : null;
  const co = coach ? coachStatus(coach, lineup, data.byId) : null;
  const part = {
    base: Math.round(avg * 4),
    avgOvr: Math.round(avg * 10) / 10,
    chem: squad.total * LINK_SCORE,
    squad: { total: squad.total, max: squad.max, full: squad.full, byLine: squad.byLine },
    captain: cap ? cap.ap + cap.sal : 0,
    coach: co ? scorePts(co.total) : 0,
    boost: lines,
    capInfo: cap ? { met: cap.met, count: cap.count, needed: cap.rule.needed } : null,
    coachInfo: co ? { active: co.activeCount, of: co.combos.length, total: co.total } : null,
    // бонус Salary всего состава (звенья + капитан + тренер) — в драфте расширяет лимит зарплаты
    salBonus: Math.max(0, lines.SAL + (cap ? cap.sal : 0) + (co ? co.total.SAL : 0)),
  };
  part.total = part.base + part.chem + part.captain + part.coach;
  return part;
}

// Бонус Salary на момент каждого пика драфта (по уже выбранному до него) — сервер считает сам,
// а не берёт из приложения: от него зависит лимит зарплаты, а значит и выпавшие варианты.
export function draftSalAtPicks(picks, data) {
  const out = {};
  const lineup = {};
  let captain = null;
  let coach = null;
  DRAFT_ORDER.forEach((key, i) => {
    out[i] = scoreLineup(lineup, captain, coach, data).salBonus;
    if (key === 'CAPTAIN') captain = picks[key];
    else if (key === 'COACH') coach = picks[key];
    else lineup[key] = picks[key];
  });
  return out;
}
