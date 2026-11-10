// Тесты драфта и челленджа: проверка выбора на сервере, пересчёт очков, сборка приложения.
// Запуск: npm test (сначала собирает _site, потом гоняет тесты).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRAFT_ORDER, DRAFT_REROLLS, DRAFT_RULES, draftDeal, verifyDraft } from '../worker/src/draft-core.js';
import { CHALLENGES, CHALLENGE_SLOTS, ONE_CLUB, challengeAllows, challengeCheck, challengeNow, challengeRules } from '../worker/src/challenge-core.js';
import { LINK_SCORE, draftSalAtPicks, lineupLinks, linkKind, scoreLineup, squadChem } from '../worker/src/score-core.js';
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
const LINES_KEYS = () => DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH');
const slotsOnly = picks => Object.fromEntries(DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH').map(k => [k, picks[k]]));

// Драфт так, как его играет приложение: бонус Salary на момент пика, вариант из пятёрки, иногда перевыброс.
function playDraft(seed, choose = opts => opts[0], rerollAt = [], rules = DRAFT_RULES) {
  const picks = {};
  const rerolls = {};
  DRAFT_ORDER.forEach((key, i) => {
    const sal = draftSalAtPicks(picks, data)[i];
    if (rerollAt.includes(i)) rerolls[i] = 1;
    const { opts } = draftDeal(pool, seed, i, rerolls[i] || 0, picks, sal, rules);
    picks[key] = choose(opts, key);
  });
  return { picks, rerolls };
}

test('честный драфт проходит проверку сервера', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const { picks, rerolls } = playDraft(seed * 7919, opts => opts[seed % opts.length], seed % 3 ? [] : [2, 9, 20]);
    assert.equal(verifyDraft(pool, seed * 7919, picks, rerolls, draftSalAtPicks(picks, data)), null, `seed ${seed}`);
  }
});

test('подменённый пик отклоняется', () => {
  const seed = 42;
  const { picks, rerolls } = playDraft(seed);
  const best = pool.players.filter(p => p[1] === 'LW').sort((a, b) => b[3] - a[3])
    .find(p => !draftDeal(pool, seed, 1, 0, { CAPTAIN: picks.CAPTAIN }, 0).opts.includes(p[0]));
  const bad = { ...picks, 'F1-LW': best[0] };
  assert.match(verifyDraft(pool, seed, bad, rerolls, draftSalAtPicks(bad, data)), /bad pick|salary cap/);
});

test('лишние перевыбросы отклоняются', () => {
  const seed = 99;
  const rerollAt = [1, 2, 3, 4];
  const { picks, rerolls } = playDraft(seed, undefined, rerollAt);
  assert.equal(Object.keys(rerolls).length, DRAFT_REROLLS + 1);
  assert.equal(verifyDraft(pool, seed, picks, rerolls, draftSalAtPicks(picks, data)), 'too many rerolls');
});

test('очки считаются по карточкам и не зависят от того, что пришлёт приложение', () => {
  const { picks } = playDraft(2024);
  const sc = scoreLineup(slotsOnly(picks), picks.CAPTAIN, picks.COACH, data);
  assert.equal(sc.total, sc.base + sc.chem + sc.captain + sc.coach);
  const ids = Object.values(slotsOnly(picks));
  const avg = ids.reduce((t, id) => t + data.byId[id].ovr, 0) / ids.length;
  assert.equal(sc.base, Math.round(avg * 4));
  assert.ok(sc.chem >= 0 && sc.captain >= 0 && sc.coach >= 0);
  // Без капитана и тренера их бонусов нет.
  const bare = scoreLineup(slotsOnly(picks), null, null, data);
  assert.equal(bare.captain, 0);
  assert.equal(bare.coach, 0);
  assert.equal(bare.chem, sc.chem);
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

test('челлендж-драфт: каждое условие недели проходимо, варианты только из подходящих карточек', () => {
  // 14 условий, а «Один за всех» — для каждого из 30 клубов.
  const EPOCH = Date.UTC(2026, 10, 2) + 3600e3;
  const seen = new Set();
  for (let n = 0; n < CHALLENGES.length * ONE_CLUB.length; n++) {
    const { ch } = challengeNow(EPOCH + n * 7 * 86400e3);
    if (seen.has(ch.title)) continue;
    seen.add(ch.title);
    const rules = challengeRules(ch, data.byId, data.captains);
    for (const seed of [n * 101 + 7, n * 977 + 3]) {
      const { picks, rerolls } = playDraft(seed, opts => opts[seed % opts.length], [], rules);
      for (const k of CHALLENGE_SLOTS) assert.ok(picks[k] != null, `${ch.title}: нет вариантов на ${k}`);
      assert.equal(verifyDraft(pool, seed, picks, rerolls, draftSalAtPicks(picks, data), rules), null, ch.title);
      assert.equal(challengeCheck(ch, Object.fromEntries(CHALLENGE_SLOTS.map(k => [k, data.byId[picks[k]]]))), null, ch.title);
    }
  }
  assert.equal(seen.size, CHALLENGES.length - 1 + ONE_CLUB.length);
});

test('челлендж-драфт: пик не под условие недели отклоняется', () => {
  const ch = CHALLENGES.find(c => c.id === 'red-machine');
  const rules = challengeRules(ch, data.byId, data.captains);
  const seed = 555;
  const { picks, rerolls } = playDraft(seed, undefined, [], rules);
  const foreign = pool.players.find(p => p[1] === 'LW' && !challengeAllows(ch, data.byId[p[0]]));
  const bad = { ...picks, 'F1-LW': foreign[0] };
  assert.match(verifyDraft(pool, seed, bad, rerolls, draftSalAtPicks(bad, data), rules), /bad pick/);
});

test('у всех карточек есть поля, нужные для сыгранности', () => {
  for (const p of Object.values(data.byId)) {
    assert.equal(typeof p.team, 'string', `team ${p.id}`);
    assert.equal(typeof p.nation, 'string', `nation ${p.id}`);
    assert.equal(typeof p.card, 'string', `card ${p.id}`);
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

test('челлендж-драфт: капитаны — сначала нужные под условие недели', () => {
  const ch = CHALLENGES.find(c => c.id === 'red-machine');
  const rules = challengeRules(ch, data.byId, data.captains);
  const own = pool.captains.filter(id => rules.captainTier(id) === 0); // сами русские
  const useful = pool.captains.filter(id => rules.captainTier(id) <= 1);
  assert.ok(own.length > 0 && own.length < 5);
  for (let seed = 1; seed <= 20; seed++) {
    const { opts } = draftDeal(pool, seed, 0, 0, {}, 0, rules);
    assert.equal(opts.length, 5);
    for (const id of own) assert.ok(opts.includes(id), 'русский капитан всегда в пятёрке');
    assert.equal(opts.filter(id => rules.captainTier(id) <= 1).length, Math.min(5, useful.length));
  }
});

test('линии: клуб — зелёная, страна — жёлтая, иначе красная', () => {
  const a = { team: 'Edmonton Oilers', nation: 'Canada' };
  assert.equal(linkKind(a, { team: 'EDMONTON OILERS ALUMNI', nation: 'USA' }), 'g'); // легенда клуба — тот же клуб
  assert.equal(linkKind(a, { team: 'Toronto Maple Leafs', nation: 'Canada' }), 'y');
  assert.equal(linkKind(a, { team: 'Toronto Maple Leafs', nation: 'Sweden' }), 'r');
  assert.equal(linkKind(a, null), null);
  assert.equal(lineupLinks({}, {}).links.length, 12);
});

test('химия как в FC: клуб 2/4/7 → +1/+2/+3, страна 2/5/8 → +1/+2/+3, не больше 3 у игрока', () => {
  // Синтетический состав: 7 игроков одного клуба (Канада), 8 шведов из разных клубов, остальные — по одному.
  const slots = LINES_KEYS();
  const byId = {};
  const lineup = {};
  slots.forEach((k, i) => {
    const p = i < 7 ? { team: 'Edmonton Oilers', nation: 'Canada' }
      : i < 15 ? { team: `Club ${i}`, nation: 'Sweden' }
        : { team: `Solo ${i}`, nation: `Land ${i}` };
    byId[i + 1] = { id: i + 1, ...p, ovr: 80 };
    lineup[k] = i + 1;
  });
  const C = squadChem(lineup, byId);
  const at = i => C.bySlot[slots[i]];
  assert.deepEqual([at(0).club, at(0).nation, at(0).chem], [3, 2, 3]); // клуб ×7 → +3, Канада ×7 → +2, итог 3
  assert.deepEqual([at(7).club, at(7).nation, at(7).chem], [0, 3, 3]); // швед ×8 → +3
  assert.deepEqual([at(16).club, at(16).nation, at(16).chem], [0, 0, 0]); // никого своего
  assert.equal(C.max, 60);
  assert.equal(C.total, 7 * 3 + 8 * 3);
  // Пороги: 4 игрока клуба → +2, 5 одной страны → +2, 2 → +1
  const four = { ...lineup };
  const byId2 = { ...byId };
  slots.forEach((k, i) => { if (i >= 4 && i < 7) byId2[i + 1] = { ...byId[i + 1], team: `Other ${i}`, nation: `Far ${i}` }; });
  const C2 = squadChem(four, byId2);
  assert.deepEqual([C2.bySlot[slots[0]].club, C2.bySlot[slots[0]].nation], [2, 1]); // клуб ×4 → +2, Канада ×4 → +1
  // Очки: 2 × химия
  const { picks } = playDraft(77);
  const lu = slotsOnly(picks);
  assert.equal(scoreLineup(lu, picks.CAPTAIN, picks.COACH, data).chem, squadChem(lu, data.byId).total * LINK_SCORE);
});

test('обычный драфт без лимита зарплаты: сильные карточки выпадают и в последних пиках', () => {
  let late = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { picks } = playDraft(seed * 13, (opts, key) => (key === 'COACH' ? opts[0] : opts.map(id => data.byId[id]).sort((x, y) => y.ovr - x.ovr)[0].id));
    late = Math.max(late, data.byId[picks['G-BACKUP']].ovr, data.byId[picks['F4-RW']].ovr);
  }
  assert.ok(late >= 88, `лучшая карточка последних пиков — ${late}`);
});
