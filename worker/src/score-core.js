// Оценка драфта и челленджа: общий расчёт для приложения и сервера.
// Сервер не доверяет цифрам из приложения — пересчитывает их этим же кодом по выбранным карточкам.
//
// Две шкалы, у каждой максимум 100:
//   Рейтинг — средний OVR 20 игроков (с прибавкой OVR от сработавших комбинаций тренера в их звене).
//   Сыгранность — как в FIFA: связи игрока с партнёрами по звену и с капитаном (клуб +3, страна +2,
//     лига +1 → 4+ сильная, 1–3 частичная, 0 нет) дают ему 0–10; сумма по 20 игрокам, 170+ = 100.
// Итог для таблицы — сумма шкал (до 200).
// В приложение этот файл попадает как обычный скрипт (scripts/build-site.js убирает import/export).

import { LINES, coachStatus } from './chemistry-core.js';
import { captainSlotFor } from './draft-core.js';

export const LINK = { club: 3, nation: 2, league: 1 };
export const LINK_MAX = LINK.club + LINK.nation + LINK.league; // 6

// Клуб без приписки Alumni: легенда клуба связана с его нынешними игроками.
const clubKey = t => String(t || '').toUpperCase().replace(/\s+ALUMNI$/, '').replace(/^ST LOUIS/, 'ST. LOUIS').trim();
const nationKey = n => String(n || '').trim().toUpperCase();
const leagueKey = l => String(l || '').trim().toUpperCase();
export const SLOT_KEYS = LINES.flatMap(line => line.slots.map(s => `${line.id}-${s}`));

// Связь двух игроков: { club, nation, league, pts 0…6, kind: 'g' ≥4 | 'y' 1…3 | 'r' 0 }
export function linkOf(a, b) {
  if (!a || !b) return null;
  const club = clubKey(a.team) === clubKey(b.team);
  const nation = nationKey(a.nation) === nationKey(b.nation);
  const league = leagueKey(a.league) === leagueKey(b.league);
  const pts = (club ? LINK.club : 0) + (nation ? LINK.nation : 0) + (league ? LINK.league : 0);
  return { club, nation, league, pts, kind: pts >= 4 ? 'g' : pts > 0 ? 'y' : 'r' };
}
// Совместимость: связь с капитаном (без капитана — нули).
export const captainLink = (p, cap) => linkOf(p, cap) || { club: false, nation: false, league: false, pts: 0, kind: 'r' };

// Партнёры слота по звену: LW–C–RW (у центра двое), пара защитников, пара вратарей.
export function slotNeighbours(key) {
  const [lineId, slot] = key.split('-');
  const line = LINES.find(l => l.id === lineId);
  if (!line) return [];
  const i = line.slots.indexOf(slot);
  return [line.slots[i - 1], line.slots[i + 1]].filter(Boolean).map(s => `${lineId}-${s}`);
}

// Сыгранность — как в FIFA. Связь двух игроков: сильная (зелёная) = 2, частичная (жёлтая) = 1, нет (красная) = 0.
// У каждого игрока — связи с партнёрами по звену и с капитаном (капитан — как «лояльность/менеджер» в FIFA).
// Средняя сила связей → сыгранность игрока 0–10 (как в FIFA: почти всё жёлтое уже даёт 9 из 10).
// Сыгранность команды — сумма по 20 игрокам, CHEM_FULL и больше = 100 (как в FIFA сумма 11 игроков упирается в 100).
export const LINK_VALUE = { g: 2, y: 1, r: 0 };
export const CHEM_FULL = 170; // в среднем 8,5 из 10 на игрока → 100
export function playerChem(avg) {
  if (avg >= 1.5) return 10;
  if (avg >= 1) return 9;
  if (avg >= 0.6) return 7;
  if (avg >= 0.3) return 5;
  if (avg > 0) return 3;
  return 1;
}
const starsOf = pts => (pts >= 9 ? 3 : pts >= 6 ? 2 : pts >= 3 ? 1 : 0);

// { total 0–100, sum, players: { slot: { pts 0–10, chem 0…1, stars 0–3, avg } }, links: [{ a, b, pts, kind }], capSlot, byLine }
export function teamChem(lineup, captainId, byId) {
  const cap = captainId != null ? byId[captainId] : null;
  const capSlot = cap ? SLOT_KEYS.find(k => lineup[k] === captainId) || null : null;
  const out = { total: 0, sum: 0, players: {}, links: [], capSlot, byLine: {} };
  for (const line of LINES) {
    out.byLine[line.id] = 0;
    for (let i = 1; i < line.slots.length; i++) {
      const a = `${line.id}-${line.slots[i - 1]}`;
      const b = `${line.id}-${line.slots[i]}`;
      const l = linkOf(byId[lineup[a]], byId[lineup[b]]);
      out.links.push({ a, b, pts: l ? l.pts : null, kind: l ? l.kind : null });
    }
  }
  for (const k of SLOT_KEYS) {
    const p = byId[lineup[k]];
    if (!p) continue;
    // Связи игрока: партнёры по звену (только уже стоящие) + капитан (у самого капитана — сильная).
    const vals = slotNeighbours(k).map(n => byId[lineup[n]]).filter(Boolean).map(m => LINK_VALUE[linkOf(p, m).kind]);
    if (cap) vals.push(k === capSlot ? 2 : LINK_VALUE[captainLink(p, cap).kind]);
    const avg = vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : 0;
    const pts = playerChem(avg);
    out.players[k] = { pts, chem: pts / 10, stars: starsOf(pts), avg };
    out.byLine[k.split('-')[0]] += pts;
    out.sum += pts;
  }
  out.total = Math.min(100, Math.round((out.sum * 100) / CHEM_FULL));
  return out;
}

// lineup: { 'F1-LW': id, ... } — 20 слотов (капитан среди них); captainId, coachId (или null)
// data: { byId, combos, captains, coaches }
// → { rating 0–100, chem 0–100, total (до 200), avgOvr, players, coachInfo, ... }
export function scoreLineup(lineup, captainId, coachId, data) {
  const coach = coachId != null ? data.coaches.find(c => c.id === coachId) : null;
  const co = coach ? coachStatus(coach, lineup, data.byId) : null;
  let ovrSum = 0;
  let rawSum = 0;
  let n = 0;
  for (const k of SLOT_KEYS) {
    const p = data.byId[lineup[k]];
    if (!p) continue;
    const boost = co?.lineTotals?.[k.split('-')[0]]?.OVR || 0; // комбинации тренера в звене игрока
    ovrSum += p.ovr + boost;
    rawSum += p.ovr;
    n++;
  }
  const chem = teamChem(lineup, captainId, data.byId);
  const avg = n ? ovrSum / n : 0;
  const rating = n ? Math.min(100, Math.round(avg)) : 0;
  return {
    rating,
    chem: chem.total,
    total: rating + chem.total,
    avgOvr: n ? Math.round((rawSum / n) * 10) / 10 : 0,
    players: n,
    squad: { total: chem.total, max: 100 },
    team: chem,
    coachOvr: co ? co.total.OVR : 0,
    coachInfo: co ? { active: co.activeCount, of: co.combos.length, total: co.total } : null,
  };
}

// Состав из пиков драфта: выбранные слоты + капитан в своём слоте.
export function lineupFromDraftPicks(picks, byId) {
  const lu = Object.fromEntries(Object.entries(picks).filter(([k]) => k !== 'CAPTAIN' && k !== 'COACH'));
  if (picks.CAPTAIN != null && byId[picks.CAPTAIN]) lu[captainSlotFor(byId[picks.CAPTAIN].pos)] = picks.CAPTAIN;
  return lu;
}

// «Вариант с бонусом» (одинаково в приложении и на сервере): игрок связан с капитаном или с уже
// стоящим партнёром по звену; тренер — у него сработает хоть одна комбинация в собранном составе.
export function draftBonus(data) {
  return (key, id, picks) => {
    if (key === 'CAPTAIN') return true;
    const lineup = lineupFromDraftPicks(picks, data.byId);
    if (key === 'COACH') {
      const c = data.coaches.find(x => x.id === id);
      return !!c && coachStatus(c, lineup, data.byId).activeCount > 0;
    }
    const p = data.byId[id];
    if (captainLink(p, data.byId[picks.CAPTAIN]).pts > 0) return true;
    return slotNeighbours(key).some(n => (linkOf(p, data.byId[lineup[n]])?.pts || 0) > 0);
  };
}
