// Тесты драфта и челленджа: проверка выбора на сервере, пересчёт очков, сборка приложения.
// Запуск: npm test (сначала собирает _site, потом гоняет тесты).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRAFT_ORDER, DRAFT_REROLLS, draftDeal, verifyDraft } from '../worker/src/draft-core.js';
import { CHALLENGES, CHALLENGE_SLOTS, challengeAllows, challengeCheck } from '../worker/src/challenge-core.js';
import { draftSalAtPicks, scoreLineup } from '../worker/src/score-core.js';
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
const slotsOnly = picks => Object.fromEntries(DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH').map(k => [k, picks[k]]));

// Драфт так, как его играет приложение: бонус Salary на момент пика, вариант из пятёрки, иногда перевыброс.
function playDraft(seed, choose = opts => opts[0], rerollAt = []) {
  const picks = {};
  const rerolls = {};
  DRAFT_ORDER.forEach((key, i) => {
    const sal = draftSalAtPicks(picks, data)[i];
    if (rerollAt.includes(i)) rerolls[i] = 1;
    const { opts } = draftDeal(pool, seed, i, rerolls[i] || 0, picks, sal);
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

test('челлендж: состав по условиям проходит, сверх лимита и не на своей позиции — нет', () => {
  const ch = CHALLENGES.find(c => c.id === 'budget');
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
