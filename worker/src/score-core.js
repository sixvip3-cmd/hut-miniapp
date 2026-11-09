// Очки драфта и челленджа: общий расчёт для приложения и сервера.
// Сервер не доверяет очкам из приложения — пересчитывает их этим же кодом по выбранным карточкам.
// В приложение этот файл попадает как обычный скрипт (scripts/build-site.js убирает import/export).

import { LINES, captainStatus, coachStatus, teamSummary } from './chemistry-core.js';
import { DRAFT_ORDER } from './draft-core.js';

const scorePts = b => b.OVR * 3 + b.SAL + b.AP; // OVR в очках считаем ×3

// lineup: { 'F1-LW': id, ... } — 20 слотов; captainId, coachId — капитан и тренер (или null)
// data: { byId: { [id]: игрок }, combos, captains, coaches }
// → очки: 4 × средний рейтинг 20 карточек + бонусы сыгранности звеньев, капитана и тренера.
export function scoreLineup(lineup, captainId, coachId, data) {
  const players = LINES.flatMap(line => line.slots.map(s => data.byId[lineup[`${line.id}-${s}`]])).filter(Boolean);
  const avg = players.length ? players.reduce((t, p) => t + p.ovr, 0) / players.length : 0;
  const lines = teamSummary(lineup, data.byId, data.combos).boost;
  const captain = captainId != null ? data.byId[captainId] : null;
  const cap = captain ? captainStatus(captain, players, data.captains) : null;
  const coach = coachId != null ? data.coaches.find(c => c.id === coachId) : null;
  const co = coach ? coachStatus(coach, lineup, data.byId) : null;
  const part = {
    base: Math.round(avg * 4),
    avgOvr: Math.round(avg * 10) / 10,
    chem: scorePts(lines),
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
