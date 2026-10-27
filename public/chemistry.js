// Правила сыгранности (line combinations). Всё настраивается здесь.
//
// Каждый тип бонуса считается по своему общему признаку у игроков одной линии:
//   OVR    — одинаковая страна
//   SALARY — одинаковая команда
//   AP     — одинаковая программа карточки (Eras, Icons, Legends Rising...)
// Бонус зависит от того, сколько игроков линии совпадают по признаку.

const CHEMISTRY = {
  baseSalaryCap: 80,  // $M
  baseAp: 20,
  maxAp: 40,
  types: {
    ovr:    { label: 'OVR',    attr: 'nation',  attrLabel: 'страна' },
    salary: { label: 'SALARY', attr: 'team',    attrLabel: 'команда' },
    ap:     { label: 'AP',     attr: 'program', attrLabel: 'программа' },
  },
  // bonuses[тип][размер линии][кол-во совпавших игроков]
  bonuses: {
    ovr:    { 3: { 2: 1, 3: 3 },   2: { 2: 2 } },
    salary: { 3: { 2: 4, 3: 9 },   2: { 2: 5 } },
    ap:     { 3: { 2: 2, 3: 5 },   2: { 2: 3 } },
  },
};

const LINES = [
  { id: 'F1', label: 'Звено 1', group: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'F2', label: 'Звено 2', group: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'F3', label: 'Звено 3', group: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'F4', label: 'Звено 4', group: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'D1', label: 'Защита 1', group: 'D', slots: ['LD', 'RD'] },
  { id: 'D2', label: 'Защита 2', group: 'D', slots: ['LD', 'RD'] },
  { id: 'D3', label: 'Защита 3', group: 'D', slots: ['LD', 'RD'] },
  { id: 'G',  label: 'Вратари',  group: 'G', slots: ['STARTER', 'BACKUP'] },
];

// Наибольшая группа игроков с одинаковым значением признака.
function largestMatch(players, attr) {
  const counts = {};
  let best = { value: null, count: 0 };
  for (const p of players) {
    const v = p[attr];
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > best.count) best = { value: v, count: counts[v] };
  }
  return best;
}

// Бонусы одной линии: { ovr: {value, match, count}, salary: {...}, ap: {...} }
function lineBonuses(line, players) {
  const result = {};
  for (const [type, cfg] of Object.entries(CHEMISTRY.types)) {
    const match = largestMatch(players, cfg.attr);
    const table = CHEMISTRY.bonuses[type][line.slots.length] || {};
    result[type] = { value: table[match.count] || 0, match: match.value, count: match.count };
  }
  return result;
}

// Сводка по всему составу.
function teamSummary(lineup, playersById) {
  let ovrSum = 0, count = 0, salary = 0, apBonus = 0, salaryBonus = 0;
  const lines = {};
  for (const line of LINES) {
    const players = line.slots.map(s => playersById[lineup[`${line.id}-${s}`]]).filter(Boolean);
    const b = lineBonuses(line, players);
    lines[line.id] = b;
    salaryBonus += b.salary.value;
    apBonus += b.ap.value;
    for (const p of players) {
      ovrSum += p.ovr + b.ovr.value;
      salary += p.salary;
      count++;
    }
  }
  return {
    lines,
    count,
    ovr: count ? Math.round(ovrSum / count) : 0,
    salary,
    salaryCap: CHEMISTRY.baseSalaryCap + salaryBonus,
    salaryBonus,
    ap: Math.min(CHEMISTRY.baseAp + apBonus, CHEMISTRY.maxAp),
    apBonus,
  };
}

// Насколько хорошо два игрока сыгрываются: совпавшие признаки.
function pairSynergy(a, b) {
  const reasons = [];
  for (const [type, cfg] of Object.entries(CHEMISTRY.types)) {
    if (a[cfg.attr] && a[cfg.attr] === b[cfg.attr]) reasons.push({ type, label: cfg.label, value: a[cfg.attr] });
  }
  return reasons;
}

function bestPartners(player, allPlayers, limit = 6) {
  return allPlayers
    .filter(p => p.id !== player.id)
    .map(p => ({ player: p, reasons: pairSynergy(player, p) }))
    .filter(x => x.reasons.length)
    .sort((x, y) => y.reasons.length - x.reasons.length || y.player.ovr - x.player.ovr)
    .slice(0, limit);
}
