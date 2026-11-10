// Очки драфта и челленджа: общий расчёт для приложения и сервера.
// Сервер не доверяет очкам из приложения — пересчитывает их этим же кодом по выбранным карточкам.
//
// Сыгранность — с капитаном. Капитан стоит в составе как обычный игрок, а каждый из остальных 19 игроков
// получает очки за совпадения с ним: тот же клуб +3, та же страна +2, та же лига +1 (до 6 у игрока).
// Сумма переводится в шкалу 0–100: 100 — у всех 19 игроков клуб, страна и лига капитана.
// Комбинации звеньев HUT (+OVR/+$M/+AP) и бонус капитана в очки драфта не идут; бонус тренера — как раньше.
// В приложение этот файл попадает как обычный скрипт (scripts/build-site.js убирает import/export).

import { LINES, coachStatus } from './chemistry-core.js';
import { captainSlotFor } from './draft-core.js';

const scorePts = b => b.OVR * 3 + b.SAL + b.AP; // OVR в очках считаем ×3

export const CAPTAIN_LINK = { club: 3, nation: 2, league: 1 };
export const CHEM_PER_PLAYER = CAPTAIN_LINK.club + CAPTAIN_LINK.nation + CAPTAIN_LINK.league; // 6
export const CHEM_MAX = 100;

// Клуб без приписки Alumni: легенда клуба связана с его нынешними игроками.
const clubKey = t => String(t || '').toUpperCase().replace(/\s+ALUMNI$/, '').replace(/^ST LOUIS/, 'ST. LOUIS').trim();
const nationKey = n => String(n || '').trim().toUpperCase();
const leagueKey = l => String(l || '').trim().toUpperCase();
const SLOT_KEYS = LINES.flatMap(line => line.slots.map(s => `${line.id}-${s}`));

// Совпадения игрока с капитаном: { club, nation, league, pts } (pts — 0…6)
export function captainLink(p, cap) {
  if (!p || !cap) return { club: false, nation: false, league: false, pts: 0 };
  const club = clubKey(p.team) === clubKey(cap.team);
  const nation = nationKey(p.nation) === nationKey(cap.nation);
  const league = leagueKey(p.league) === leagueKey(cap.league);
  return { club, nation, league, pts: (club ? CAPTAIN_LINK.club : 0) + (nation ? CAPTAIN_LINK.nation : 0) + (league ? CAPTAIN_LINK.league : 0) };
}

// Сыгранность состава с капитаном:
// { total: 0–100, raw, rawMax, bySlot: { 'F1-LW': { club, nation, league, pts } }, byLine: { F1: очки }, full, capSlot }
export function captainChem(lineup, captainId, byId) {
  const cap = captainId != null ? byId[captainId] : null;
  const capSlot = cap ? SLOT_KEYS.find(k => lineup[k] === captainId) || null : null;
  const rawMax = (SLOT_KEYS.length - 1) * CHEM_PER_PLAYER; // 19 игроков × 6
  const out = { total: 0, raw: 0, rawMax, max: CHEM_MAX, bySlot: {}, byLine: {}, full: 0, capSlot };
  for (const line of LINES) out.byLine[line.id] = 0;
  if (!cap) return out;
  for (const k of SLOT_KEYS) {
    const p = byId[lineup[k]];
    if (!p || k === capSlot) continue;
    const l = captainLink(p, cap);
    out.bySlot[k] = l;
    out.raw += l.pts;
    out.byLine[k.split('-')[0]] += l.pts;
    if (l.pts === CHEM_PER_PLAYER) out.full++;
  }
  out.total = Math.round((out.raw * CHEM_MAX) / rawMax);
  return out;
}

// Состав из пиков драфта: разыгранные слоты + капитан в своём слоте.
export function lineupFromDraftPicks(picks, byId) {
  const lu = Object.fromEntries(Object.entries(picks).filter(([k]) => k !== 'CAPTAIN' && k !== 'COACH'));
  if (picks.CAPTAIN != null && byId[picks.CAPTAIN]) lu[captainSlotFor(byId[picks.CAPTAIN].pos)] = picks.CAPTAIN;
  return lu;
}

// «Вариант с бонусом» (одинаково в приложении и на сервере): игрок совпадает с капитаном по клубу, стране
// или лиге; тренер — у него сработает хоть одна комбинация в уже собранном составе.
export function draftBonus(data) {
  return (key, id, picks) => {
    if (key === 'CAPTAIN') return true;
    if (key === 'COACH') {
      const c = data.coaches.find(x => x.id === id);
      return !!c && coachStatus(c, lineupFromDraftPicks(picks, data.byId), data.byId).activeCount > 0;
    }
    return captainLink(data.byId[id], data.byId[picks.CAPTAIN]).pts > 0;
  };
}

// lineup: { 'F1-LW': id, ... } — 20 слотов (капитан среди них); captainId, coachId — капитан и тренер (или null)
// data: { byId: { [id]: игрок }, combos, captains, coaches }
// → очки: 4 × средний рейтинг 20 карточек + сыгранность с капитаном (0–100) + бонус тренера.
export function scoreLineup(lineup, captainId, coachId, data) {
  const players = SLOT_KEYS.map(k => data.byId[lineup[k]]).filter(Boolean);
  const avg = players.length ? players.reduce((t, p) => t + p.ovr, 0) / players.length : 0;
  const chem = captainChem(lineup, captainId, data.byId);
  const coach = coachId != null ? data.coaches.find(c => c.id === coachId) : null;
  const co = coach ? coachStatus(coach, lineup, data.byId) : null;
  const part = {
    base: Math.round(avg * 4),
    avgOvr: Math.round(avg * 10) / 10,
    players: players.length,
    chem: chem.total,
    squad: { total: chem.total, max: CHEM_MAX, full: chem.full, byLine: chem.byLine },
    captain: 0,
    coach: co ? scorePts(co.total) : 0,
    coachInfo: co ? { active: co.activeCount, of: co.combos.length, total: co.total } : null,
  };
  part.total = part.base + part.chem + part.coach;
  return part;
}
