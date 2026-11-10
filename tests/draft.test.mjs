// Тесты драфта и челленджа: проверка выбора на сервере, пересчёт очков, сборка приложения.
// Запуск: npm test (сначала собирает _site, потом гоняет тесты).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRAFT_PICKS, DRAFT_REROLLS, DRAFT_RULES, DRAFT_SLOTS, captainSlotFor, draftDeal, draftOrder, finalOptions, verifyDraft } from '../worker/src/draft-core.js';
import { CHALLENGES, CHALLENGE_SLOTS, ONE_CLUB, challengeAllows, challengeCheck, challengeNow, challengeRules } from '../worker/src/challenge-core.js';
import { CHEM_PER_PLAYER, captainChem, captainLink, draftBonus, scoreLineup } from '../worker/src/score-core.js';
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
const verify = (seed, picks, rerolls, rules = DRAFT_RULES) => verifyDraft(pool, seed, picks, rerolls, {}, rules, bonus);
// Состав из пиков: 19 разыгранных слотов + капитан в своём слоте.
const lineupOf = picks => {
  const capSlot = captainSlotFor(data.byId[picks.CAPTAIN].pos);
  return Object.fromEntries(DRAFT_SLOTS.map(k => [k, k === capSlot ? picks.CAPTAIN : picks[k]]));
};

// Драфт так, как его играет приложение: порядок пиков зависит от капитана, вариант из пятёрки, иногда перевыброс.
function playDraft(seed, choose = opts => opts[0], rerollAt = [], rules = DRAFT_RULES) {
  const picks = {};
  const rerolls = {};
  for (let i = 0; i < DRAFT_PICKS; i++) {
    const key = draftOrder(pool, picks.CAPTAIN)[i];
    if (rerollAt.includes(i)) rerolls[i] = 1;
    const opts = finalOptions(draftDeal(pool, seed, i, rerolls[i] || 0, picks, 0, rules), key, seed, i, id => bonus(key, id, picks));
    picks[key] = choose(opts, key);
  }
  return { picks, rerolls };
}

test('честный драфт проходит проверку сервера', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const { picks, rerolls } = playDraft(seed * 7919, opts => opts[seed % opts.length], seed % 3 ? [] : [2, 9, 19]);
    assert.equal(verify(seed * 7919, picks, rerolls), null, `seed ${seed}`);
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

test('подменённый пик и лишние перевыбросы отклоняются', () => {
  const seed = 42;
  const { picks, rerolls } = playDraft(seed);
  const key = draftOrder(pool, picks.CAPTAIN)[3];
  const pos = key.split('-')[1] === 'STARTER' || key.split('-')[1] === 'BACKUP' ? 'G' : key.split('-')[1];
  const best = pool.players.filter(p => p[1] === pos).sort((a, b) => b[3] - a[3]).find(p => p[0] !== picks[key]);
  assert.match(verify(seed, { ...picks, [key]: best[0] }, rerolls), /bad pick/);
  // Карточка из запасного списка, которой нет в показанной пятёрке, тоже не принимается.
  const done = Object.fromEntries(draftOrder(pool, picks.CAPTAIN).slice(0, 3).map(k => [k, picks[k]]));
  const dealt = draftDeal(pool, seed, 3, 0, done, 0);
  const shown = finalOptions(dealt, key, seed, 3, id => bonus(key, id, done));
  const hidden = dealt.extra.find(id => !shown.includes(id));
  assert.match(verify(seed, { ...picks, [key]: hidden }, rerolls), /bad pick/);
  const many = playDraft(99, undefined, [1, 2, 3, 4]);
  assert.equal(verify(99, many.picks, many.rerolls), 'too many rerolls');
  const { CAPTAIN, ...noCap } = picks;
  assert.match(verify(seed, noCap, rerolls), /CAPTAIN/);
});

test('сыгранность с капитаном: клуб +3, страна +2, лига +1, шкала 0–100', () => {
  const cap = { id: 1, team: 'Edmonton Oilers', nation: 'Canada', league: 'NHL', ovr: 90 };
  assert.deepEqual(captainLink({ team: 'EDMONTON OILERS ALUMNI', nation: 'Canada', league: 'NHLAA' }, cap), { club: true, nation: true, league: false, pts: 5 });
  assert.equal(captainLink({ team: 'Toronto Maple Leafs', nation: 'Sweden', league: 'NHL' }, cap).pts, 1);
  assert.equal(captainLink({ team: 'Frölunda', nation: 'Sweden', league: 'SHL' }, cap).pts, 0);
  const make = fn => {
    const byId = { 1: cap };
    const lineup = {};
    DRAFT_SLOTS.forEach((k, i) => {
      if (i === 0) { lineup[k] = 1; return; }
      byId[i + 1] = { id: i + 1, ovr: 80, ...fn(i) };
      lineup[k] = i + 1;
    });
    return captainChem(lineup, 1, byId);
  };
  assert.equal(make(() => ({ team: 'Edmonton Oilers', nation: 'Canada', league: 'NHL' })).total, 100);
  assert.equal(make(() => ({ team: 'X', nation: 'Y', league: 'Z' })).total, 0);
  const half = make(i => (i <= 10 ? { team: 'Edmonton Oilers', nation: 'Canada', league: 'NHL' } : { team: 'X', nation: 'Y', league: 'Z' }));
  assert.equal(half.raw, 10 * CHEM_PER_PLAYER);
  assert.equal(half.total, Math.round((10 * 6 * 100) / (19 * 6)));
  assert.equal(half.full, 10);
  assert.equal(captainChem({}, null, {}).total, 0);
});

test('очки: 4 × средний OVR + сыгранность + тренер, из присланных приложением цифр ничего не берётся', () => {
  const { picks } = playDraft(2024);
  const lu = lineupOf(picks);
  const sc = scoreLineup(lu, picks.CAPTAIN, picks.COACH, data);
  const ids = Object.values(lu);
  const avg = ids.reduce((t, id) => t + data.byId[id].ovr, 0) / ids.length;
  assert.equal(sc.base, Math.round(avg * 4));
  assert.equal(sc.chem, captainChem(lu, picks.CAPTAIN, data.byId).total);
  assert.equal(sc.total, sc.base + sc.chem + sc.coach);
  assert.equal(sc.captain, 0);
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
    const capOpts = draftDeal(pool, n + 1, 0, 0, {}, 0, rules).opts;
    assert.equal(capOpts.length, 5, `${ch.title}: вариантов капитана`);
    assert.ok(capOpts.every(id => rules.allow(id)), `${ch.title}: капитан не под условие`);
    for (const seed of [n * 101 + 7, n * 977 + 3]) {
      const { picks, rerolls } = playDraft(seed, opts => opts[seed % opts.length], [], rules);
      assert.equal(verify(seed, picks, rerolls, rules), null, ch.title);
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
  const { picks, rerolls } = playDraft(seed, undefined, [], rules);
  const key = draftOrder(pool, picks.CAPTAIN).find(k => k.endsWith('-LW'));
  const foreign = pool.players.find(p => p[1] === 'LW' && !challengeAllows(ch, data.byId[p[0]]));
  assert.match(verify(seed, { ...picks, [key]: foreign[0] }, rerolls, rules), /bad pick/);
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
