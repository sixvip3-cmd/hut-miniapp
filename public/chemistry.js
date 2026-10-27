// Сыгранность (line combos) по правилам hutdb.app / NHL HUT.
//
// Комбинация = набор требований (клуб / страна / тип карточки), по одному на игрока линии,
// и бонус: +OVR, +SAL (к салари-капу, $M) или +AP. Комбинация активна, если каждое
// требование закрыто отдельным игроком этой линии (один и тот же игрок — разными
// карточками — не считается дважды). Бонусы всех активных комбинаций линии складываются.
// Звенья нападения используют комбинации Forwards, пары защиты — Defense, вратари — Goalies.

const CHEMISTRY = {
  baseSalaryCap: 80, // $M, как в игре и на hutdb
  maxAp: 40,
  types: {
    SAL: { label: 'SALARY', color: 'green' },
    OVR: { label: 'OVR', color: 'cyan' },
    AP: { label: 'AP', color: 'purple' },
  },
};

const LINES = [
  { id: 'F1', label: 'Звено 1', cat: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'F2', label: 'Звено 2', cat: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'F3', label: 'Звено 3', cat: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'F4', label: 'Звено 4', cat: 'F', slots: ['LW', 'C', 'RW'] },
  { id: 'D1', label: 'Защита 1', cat: 'D', slots: ['LD', 'RD'] },
  { id: 'D2', label: 'Защита 2', cat: 'D', slots: ['LD', 'RD'] },
  { id: 'D3', label: 'Защита 3', cat: 'D', slots: ['LD', 'RD'] },
  { id: 'G', label: 'Вратари', cat: 'G', slots: ['STARTER', 'BACKUP'] },
];

function playerCat(p) {
  if (p.pos === 'G') return 'G';
  if (p.pos === 'LD' || p.pos === 'RD') return 'D';
  return 'F';
}

// Проверка требования слота комбинации.
function reqMatches(req, p) {
  switch (req.type) {
    case 'team': {
      const t = p.team.toUpperCase();
      return req.team.some(k => t.includes(k));
    }
    case 'nation': return p.nation.trim().toUpperCase() === req.nation;
    case 'card': return p.card.trim().toUpperCase().includes(req.card);
    case 'players': return req.ids.includes(p.id);
    case 'any': return true;
    default: return false;
  }
}

const sameName = (a, b) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

// Распределение игроков по требованиям (перебор с возвратом). Возвращает массив игроков
// в порядке требований или null.
function assignCombo(combo, players) {
  const used = new Array(players.length).fill(false);
  const picked = [];
  const step = i => {
    if (i === combo.reqs.length) return true;
    for (let j = 0; j < players.length; j++) {
      const p = players[j];
      if (used[j] || picked.some(q => sameName(q, p)) || !reqMatches(combo.reqs[i], p)) continue;
      used[j] = true;
      picked.push(p);
      if (step(i + 1)) return true;
      used[j] = false;
      picked.pop();
    }
    return false;
  };
  return step(0) ? picked.slice() : null;
}

const emptyBoost = () => ({ OVR: 0, SAL: 0, AP: 0 });

// Активные комбинации линии и сумма бонусов.
function lineChemistry(line, players, combos) {
  const total = emptyBoost();
  const active = [];
  if (players.length) {
    for (const c of combos) {
      if (c.cat !== line.cat || c.reqs.length > players.length) continue;
      const who = assignCombo(c, players);
      if (!who) continue;
      active.push({ combo: c, players: who });
      total.OVR += c.boost.OVR;
      total.SAL += c.boost.SAL;
      total.AP += c.boost.AP;
    }
  }
  return { total, active };
}

// Комбинации, которым не хватает ровно одного игрока: что можно добрать в линию.
function nearMisses(line, players, combos, type, limit = 3) {
  const result = [];
  for (const c of combos) {
    if (c.cat !== line.cat || !c.boost[type]) continue;
    // Пробуем убрать каждое требование: если остальные закрываются — не хватает именно его.
    for (let i = 0; i < c.reqs.length; i++) {
      const rest = { reqs: c.reqs.filter((_, k) => k !== i) };
      if (rest.reqs.length > players.length) continue;
      if (assignCombo(rest, players) && !assignCombo(c, players)) {
        result.push({ combo: c, missing: c.reqs[i] });
        break;
      }
    }
  }
  return result.sort((a, b) => b.combo.boost[type] - a.combo.boost[type]).slice(0, limit);
}

function teamSummary(lineup, playersById, combos) {
  let ovrSum = 0, count = 0, salary = 0;
  const boost = emptyBoost();
  const lines = {};
  for (const line of LINES) {
    const players = line.slots.map(s => playersById[lineup[`${line.id}-${s}`]]).filter(Boolean);
    const chem = lineChemistry(line, players, combos);
    lines[line.id] = chem;
    boost.SAL += chem.total.SAL;
    boost.AP += chem.total.AP;
    boost.OVR += chem.total.OVR;
    for (const p of players) {
      ovrSum += p.ovr + chem.total.OVR;
      salary += p.salary;
      count++;
    }
  }
  return {
    lines,
    count,
    ovr: count ? Math.round(ovrSum / count) : 0,
    salary,
    salaryCap: CHEMISTRY.baseSalaryCap + boost.SAL,
    boost,
  };
}

// Лучшие комбинации и партнёры для игрока.
// partners: игроки, вместе с которыми он закрывает самые сильные комбинации.
function bestCombosFor(player, allPlayers, combos, { limitCombos = 5, limitPartners = 8, priceOf } = {}) {
  const cat = playerCat(player);
  const pool = allPlayers.filter(p => p.id !== player.id && playerCat(p) === cat && !sameName(p, player));
  const byReq = new Map();
  const candidatesFor = req => {
    const key = JSON.stringify(req);
    if (!byReq.has(key)) {
      byReq.set(key, pool.filter(p => reqMatches(req, p)).sort((a, b) => b.ovr - a.ovr));
    }
    return byReq.get(key);
  };
  const weight = b => b.OVR * 3 + b.SAL + b.AP; // OVR ценнее всего

  const fits = [];
  const partners = new Map();
  for (const c of combos) {
    if (c.cat !== cat) continue;
    const slot = c.reqs.findIndex(r => reqMatches(r, player));
    if (slot === -1) continue;
    const others = c.reqs.filter((_, i) => i !== slot);
    const options = others.map(r => ({ req: r, candidates: candidatesFor(r) }));
    if (options.some(o => !o.candidates.length)) continue;
    fits.push({ combo: c, options });
    for (const o of options) {
      for (const q of o.candidates.slice(0, 40)) {
        const e = partners.get(q.id) || { player: q, score: 0, combos: [] };
        e.score += weight(c.boost);
        e.combos.push(c);
        partners.set(q.id, e);
      }
    }
  }
  fits.sort((a, b) => weight(b.combo.boost) - weight(a.combo.boost));
  const hasPrice = p => (priceOf ? priceOf(p) > 0 : true);
  const topPartners = [...partners.values()]
    .sort((a, b) => b.score - a.score || hasPrice(b.player) - hasPrice(a.player) || b.player.ovr - a.player.ovr)
    .slice(0, limitPartners);
  return { combos: fits.slice(0, limitCombos), partners: topPartners };
}
