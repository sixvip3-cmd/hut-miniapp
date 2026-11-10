// Тесты драфта и челленджа: проверка выбора на сервере, пересчёт очков, сборка приложения.
// Запуск: npm test (сначала собирает _site, потом гоняет тесты).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRAFT_OPTIONS, DRAFT_PICKS, DRAFT_RULES, DRAFT_SLOTS, captainSlotFor, checkArrangement, draftDeal, finalOptions, openPicks, slotPosOf, verifyDraft } from '../worker/src/draft-core.js';
import { CHALLENGES, CHALLENGE_SLOTS, ONE_CLUB, challengeAllows, challengeCheck, challengeNow, challengeRules } from '../worker/src/challenge-core.js';
import { captainLink, draftBonus, lineupFromDraftPicks, linkOf, scoreLineup, teamChem } from '../worker/src/score-core.js';
import { expandPlayers } from '../worker/src/game-data.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, '_site');
const read = f => JSON.parse(fs.readFileSync(path.join(SITE, 'data', f), 'utf8'));
const data = {
  draftPool: read('draft-pool.json'),
  combos: read('combos.json'),
  captains: read('captains.json'),
  coaches: read('coaches.json'),
  ...expandPlayers(read('chal-pool.json')),
};
const pool = data.draftPool;
const bonus = draftBonus(data);
const verify = (seed, picks, order, rerolls, rules = DRAFT_RULES) => verifyDraft(pool, seed, picks, order, rerolls, rules, bonus);
const lineupOf = picks => lineupFromDraftPicks(picks, data.byId);

// Драфт так, как его играет приложение: капитан, дальше позиции в выбранном игроком порядке
// (здесь — псевдослучайно по зерну), вариант из четвёрки, иногда перевыброс.
function playDraft(seed, choose = opts => opts[0], rerollAt = [], rules = DRAFT_RULES) {
  const picks = {};
  const rerolls = {};
  const order = [];
  for (let i = 0; i < DRAFT_PICKS; i++) {
    const open = openPicks(pool, picks);
    const key = open[(seed * 31 + i * 17) % open.length];
    if (rerollAt.includes(i)) rerolls[i] = 1;
    const opts = finalOptions(draftDeal(pool, seed, i, rerolls[i] || 0, picks, key, rules), key, seed, i, id => bonus(key, id, picks));
    picks[key] = choose(opts, key);
    order.push(key);
  }
  return { picks, rerolls, order };
}

test('честный драфт проходит проверку сервера', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const { picks, rerolls, order } = playDraft(seed * 7919, opts => opts[seed % opts.length], seed % 3 ? [] : [2, 9, 19]);
    assert.equal(order[0], 'CAPTAIN');
    assert.equal(verify(seed * 7919, picks, order, rerolls), null, `seed ${seed}`);
  }
});

test('капитан сразу в составе: его слот не разыгрывается, пиков 21', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { picks } = playDraft(seed * 31);
    const cap = data.byId[picks.CAPTAIN];
    const slot = captainSlotFor(cap.pos);
    assert.ok(slot && slot.split('-')[1].replace('STARTER', 'G') === cap.pos, `${cap.pos} → ${slot}`);
    assert.equal(picks[slot], undefined, 'слот капитана не разыгрывается');
    assert.equal(Object.keys(picks).length, DRAFT_PICKS);
    const lu = lineupOf(picks);
    assert.equal(Object.values(lu).filter(Boolean).length, 20);
    assert.equal(new Set(Object.values(lu).map(id => data.byId[id].name.toLowerCase())).size, 20, 'игроки не повторяются');
  }
});

test('подменённый пик, чужой порядок и лишние перевыбросы отклоняются', () => {
  const seed = 42;
  const { picks, rerolls, order } = playDraft(seed);
  const key = order[3];
  const best = pool.players.filter(p => p[1] === slotPosOf(key)).sort((a, b) => b[3] - a[3]).find(p => p[0] !== picks[key]);
  assert.match(verify(seed, { ...picks, [key]: best[0] }, order, rerolls), /bad pick/);
  // Карточка из запасного списка, которой нет в показанной четвёрке, тоже не принимается.
  const done = Object.fromEntries(order.slice(0, 3).map(k => [k, picks[k]]));
  const dealt = draftDeal(pool, seed, 3, 0, done, key);
  const shown = finalOptions(dealt, key, seed, 3, id => bonus(key, id, done));
  const hidden = dealt.extra.find(id => !shown.includes(id));
  assert.match(verify(seed, { ...picks, [key]: hidden }, order, rerolls), /bad pick/);
  // Другой порядок — другие варианты: тот же набор пиков с переставленным порядком не проходит.
  const swapped = [order[0], order[2], order[1], ...order.slice(3)];
  assert.notEqual(verify(seed, picks, swapped, rerolls), null);
  assert.match(verify(seed, picks, [...order.slice(1), 'CAPTAIN'], rerolls), /bad order/);
  assert.match(verify(seed, picks, [...order.slice(0, 5), order[4], ...order.slice(6)], rerolls), /bad order/);
  const many = playDraft(99, undefined, [1, 2, 3, 4]);
  assert.equal(verify(99, many.picks, many.order, many.rerolls), 'too many rerolls');
});

test('расстановка: менять можно только игроков одной позиции', () => {
  const { picks } = playDraft(7);
  const lu = lineupOf(picks);
  assert.equal(checkArrangement(pool, picks, lu), null);
  const sw = { ...lu, 'F1-C': lu['F2-C'], 'F2-C': lu['F1-C'] };
  assert.equal(checkArrangement(pool, picks, sw), null);
  assert.match(checkArrangement(pool, picks, { ...lu, 'F1-C': lu['F1-LW'], 'F1-LW': lu['F1-C'] }), /position/);
  assert.match(checkArrangement(pool, picks, { ...lu, 'F1-C': lu['F2-C'] }), /players/);
  const other = pool.players.find(p => p[1] === 'C' && !Object.values(lu).includes(p[0]));
  assert.match(checkArrangement(pool, picks, { ...lu, 'F1-C': other[0] }), /players/);
});

test('сыгранность: капитан + партнёры по звену (клуб +3, страна +2, лига +1), шкала 0–100', () => {
  const cap = { id: 1, team: 'Edmonton Oilers', nation: 'Canada', league: 'NHL', ovr: 90 };
  const l = linkOf({ team: 'EDMONTON OILERS ALUMNI', nation: 'Canada', league: 'NHLAA' }, cap);
  assert.deepEqual([l.club, l.nation, l.league, l.pts, l.kind], [true, true, false, 5, 'g']);
  assert.equal(captainLink({ team: 'Toronto Maple Leafs', nation: 'Sweden', league: 'NHL' }, cap).kind, 'y');
  assert.equal(captainLink({ team: 'Frölunda', nation: 'Sweden', league: 'SHL' }, cap).pts, 0);
  const make = fn => {
    const byId = { 1: cap };
    const lineup = {};
    DRAFT_SLOTS.forEach((k, i) => {
      if (i === 0) { lineup[k] = 1; return; }
      byId[i + 1] = { id: i + 1, ovr: 80, ...fn(i, k) };
      lineup[k] = i + 1;
    });
    return teamChem(lineup, 1, byId);
  };
  const same = { team: 'Edmonton Oilers', nation: 'Canada', league: 'NHL' };
  assert.equal(make(() => same).total, 100);
  assert.equal(make(i => ({ team: `X${i}`, nation: `Y${i}`, league: `Z${i}` })).total, 3); // только сам капитан: (1 + 0) / 2 / 20 // только капитан (половина его части)
  // Звенья сыграны между собой, но не с капитаном: половина от максимума у всех, кроме звена капитана.
  const lines = make((i, k) => ({ team: `T-${k.split('-')[0]}`, nation: `N-${k.split('-')[0]}`, league: 'L' }));
  assert.ok(lines.total > 40 && lines.total < 60, `звенья без капитана: ${lines.total}`);
  assert.equal(lines.links.filter(x => x.kind === 'g').length, lines.links.length - 1); // кроме связи с капитаном в F1
  assert.equal(teamChem({}, null, {}).total, 0);
});

test('перестановка игроков одной позиции меняет сыгранность', () => {
  const cap = { id: 1, pos: 'C', team: 'A', nation: 'X', league: 'L1', ovr: 90 };
  const byId = { 1: cap };
  const lineup = {};
  DRAFT_SLOTS.forEach((k, i) => {
    if (i === 1) { lineup[k] = 1; return; } // капитан — центр первого звена
    byId[i + 100] = { id: i + 100, pos: slotPosOf(k), team: `Z${i}`, nation: `Q${i}`, league: `L${i + 9}`, ovr: 80 };
    lineup[k] = i + 100;
  });
  // Нападающий клуба капитана стоит во втором звене — переставим его к капитану.
  byId[lineup['F2-LW']] = { ...byId[lineup['F2-LW']], team: 'A', nation: 'X', league: 'L1' };
  const before = teamChem(lineup, 1, byId).total;
  const after = teamChem({ ...lineup, 'F1-LW': lineup['F2-LW'], 'F2-LW': lineup['F1-LW'] }, 1, byId).total;
  assert.ok(after > before, `${before} → ${after}`);
});

test('оценка: рейтинг (средний OVR) + сыгранность, каждая до 100, итог — сумма', () => {
  const { picks } = playDraft(2024);
  const lu = lineupOf(picks);
  const sc = scoreLineup(lu, picks.CAPTAIN, null, data);
  const ids = Object.values(lu);
  assert.equal(ids.length, 20);
  const avg = ids.reduce((t, id) => t + data.byId[id].ovr, 0) / ids.length;
  assert.equal(sc.rating, Math.round(avg));
  assert.equal(sc.chem, teamChem(lu, picks.CAPTAIN, data.byId).total);
  assert.equal(sc.total, sc.rating + sc.chem);
  const withCoach = scoreLineup(lu, picks.CAPTAIN, picks.COACH, data);
  assert.ok(withCoach.rating >= sc.rating && withCoach.rating <= 100);
  assert.ok(sc.chem >= 0 && sc.chem <= 100);
});

test('челлендж: состав по условиям проходит, сверх лимита (если он задан) и не на своей позиции — нет', () => {
  const ch = CHALLENGES.find(c => c.id === 'current');
  const players = Object.values(data.byId).sort((a, b) => a.salary - b.salary || b.ovr - a.ovr);
  const used = new Set();
  const lineup = {};
  for (const k of CHALLENGE_SLOTS) {
    const slot = k.split('-')[1];
    const pos = slot === 'STARTER' || slot === 'BACKUP' ? 'G' : slot;
    const p = players.find(p => p.pos === pos && challengeAllows(ch, p) && !used.has(p.name.trim().toLowerCase()));
    used.add(p.name.trim().toLowerCase());
    lineup[k] = p;
  }
  assert.equal(challengeCheck(ch, lineup), null);
  const spent = CHALLENGE_SLOTS.reduce((t, k) => t + lineup[k].salary, 0);
  assert.match(challengeCheck({ ...ch, cap: spent - 1 }, lineup), /больше лимита/);
  assert.match(challengeCheck(ch, { ...lineup, 'F1-C': lineup['F1-LW'] }), /не своя позиция/);
});

test('челлендж-драфт: каждое условие проходимо, капитан и игроки — только подходящие', () => {
  // 14 условий, а «Один за всех» — для каждого из 30 клубов.
  const EPOCH = Date.UTC(2026, 10, 2) + 3600e3;
  const seen = new Set();
  for (let n = 0; n < CHALLENGES.length * ONE_CLUB.length; n++) {
    const { ch } = challengeNow(EPOCH + n * 7 * 86400e3);
    if (seen.has(ch.title)) continue;
    seen.add(ch.title);
    const rules = challengeRules(ch, data.byId);
    const capOpts = draftDeal(pool, n + 1, 0, 0, {}, 'CAPTAIN', rules).opts;
    assert.equal(capOpts.length, DRAFT_OPTIONS, `${ch.title}: вариантов капитана`);
    assert.ok(capOpts.every(id => rules.allow(id)), `${ch.title}: капитан не под условие`);
    for (const seed of [n * 101 + 7, n * 977 + 3]) {
      const { picks, rerolls, order } = playDraft(seed, opts => opts[seed % opts.length], [], rules);
      assert.equal(verify(seed, picks, order, rerolls, rules), null, ch.title);
      const lu = lineupOf(picks);
      assert.equal(challengeCheck(ch, Object.fromEntries(CHALLENGE_SLOTS.map(k => [k, data.byId[lu[k]]]))), null, ch.title);
    }
  }
  assert.equal(seen.size, CHALLENGES.length - 1 + ONE_CLUB.length);
});

test('челлендж-драфт: пик не под условие недели отклоняется', () => {
  const ch = CHALLENGES.find(c => c.id === 'red-machine');
  const rules = challengeRules(ch, data.byId);
  const seed = 555;
  const { picks, rerolls, order } = playDraft(seed, undefined, [], rules);
  const key = order.find(k => k.endsWith('-LW'));
  const foreign = pool.players.find(p => p[1] === 'LW' && !challengeAllows(ch, data.byId[p[0]]));
  assert.match(verify(seed, { ...picks, [key]: foreign[0] }, order, rerolls, rules), /bad pick/);
});

test('у всех карточек есть поля, нужные для сыгранности', () => {
  for (const p of Object.values(data.byId)) {
    assert.equal(typeof p.team, 'string', `team ${p.id}`);
    assert.equal(typeof p.nation, 'string', `nation ${p.id}`);
    assert.equal(typeof p.league, 'string', `league ${p.id}`);
  }
});

test('скрипты приложения собираются без конфликтов имён', () => {
  // Все обычные скрипты страницы делят одну глобальную область: повторное объявление — ошибка загрузки.
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script src="([^"?:]+\.js)\?/g)].map(m => m[1]);
  assert.ok(files.includes('score-core.js') && files.includes('chemistry.js'));
  const code = files.map(f => fs.readFileSync(path.join(SITE, f), 'utf8')).join('\n;\n');
  assert.doesNotMatch(code, /^\s*(import|export)\s/m);
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'app-bundle.js' }));
});

test('обычный драфт без лимита зарплаты: сильные карточки выпадают и в последних пиках', () => {
  let late = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { picks } = playDraft(seed * 13, (opts, key) => (key === 'COACH' ? opts[0] : opts.map(id => data.byId[id]).sort((x, y) => y.ovr - x.ovr)[0].id));
    late = Math.max(late, data.byId[picks['G-BACKUP']].ovr, data.byId[picks['F4-RW']].ovr);
  }
  assert.ok(late >= 88, `лучшая карточка последних пиков — ${late}`);
});
