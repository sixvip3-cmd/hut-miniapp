// Челлендж недели на сервере: таблица и отправка состава.
//   GET  /s/<токен>/api/challenge/board  → { ch, week, endsAt, top, me, players }
//   POST /s/<токен>/api/challenge/submit { week, picks } → { score, best, place }
// Сервер сам проверяет условия (challenge-core.js) по полной базе карточек, капитана и тренера
// и сам считает очки (score-core.js) — очкам из приложения не доверяем.

import { CHALLENGE_SLOTS, challengeCheck, challengeNow } from './challenge-core.js';
import { captainRuleFor } from './chemistry-core.js';
import { scoreLineup } from './score-core.js';
import { gameData } from './game-data.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleChallenge(request, env, uid, path) {
  if (path === '/api/challenge/board') return board(env, uid);
  if (path === '/api/challenge/submit' && request.method === 'POST') return submit(request, env, uid);
  return json({ error: 'not_found' }, 404);
}

const nameOf = r => r.first_name || (r.username ? `@${r.username}` : `Игрок ${String(r.user_id).slice(-3)}`);

export async function challengeTop(env, week, limit = 10) {
  const rows = await env.DB.prepare(
    `SELECT e.user_id, e.score, u.first_name, u.username FROM challenge_entries e LEFT JOIN users u ON u.user_id = e.user_id
     WHERE e.week = ? ORDER BY e.score DESC, e.updated_at ASC LIMIT ?`).bind(week, limit).all();
  return rows.results || [];
}

async function board(env, uid) {
  const { week, ch, endsAt } = challengeNow();
  const [top, mine, count] = await Promise.all([
    challengeTop(env, week),
    env.DB.prepare(`SELECT score, (SELECT COUNT(*) FROM challenge_entries WHERE week = ?1 AND score > m.score) + 1 AS place
      FROM challenge_entries m WHERE week = ?1 AND user_id = ?2`).bind(week, uid).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM challenge_entries WHERE week = ?').bind(week).first(),
  ]);
  return json({
    ch, week, endsAt,
    top: top.map((r, i) => ({ place: i + 1, name: nameOf(r), score: r.score, me: r.user_id === uid })),
    me: mine ? { place: mine.place, score: mine.score } : null,
    players: count.n,
  });
}

async function submit(request, env, uid) {
  const body = await request.json().catch(() => null);
  const { week, ch } = challengeNow();
  if (!body?.picks || body.week !== week) return json({ error: 'week_over', message: 'Неделя челленджа закончилась — обнови приложение' }, 409);
  const data = await gameData(env);
  const lineup = {};
  for (const k of CHALLENGE_SLOTS) {
    const p = data.byId[Number(body.picks[k])];
    if (p) lineup[k] = p;
  }
  const err = challengeCheck(ch, lineup);
  if (err) return json({ error: 'invalid', message: err }, 422);
  // Капитан — любая карточка капитана, тренер — любой из базы (как в приложении); выдуманные не принимаем.
  const captainId = body.picks.CAPTAIN == null ? null : Number(body.picks.CAPTAIN);
  const coachId = body.picks.COACH == null ? null : String(body.picks.COACH);
  if (captainId != null && !captainRuleFor(data.byId[captainId], data.captains)) return json({ error: 'invalid', message: 'Неизвестный капитан' }, 422);
  if (coachId != null && !data.coaches.some(c => c.id === coachId)) return json({ error: 'invalid', message: 'Неизвестный тренер' }, 422);
  // Очки как в драфте: 4 × средний рейтинг + бонусы сыгранности, капитана и тренера — считает сервер.
  const ids = Object.fromEntries(CHALLENGE_SLOTS.map(k => [k, lineup[k].id]));
  const sc = scoreLineup(ids, captainId, coachId, data);
  const score = sc.total;
  const breakdown = JSON.stringify({ base: sc.base, avgOvr: sc.avgOvr, chem: sc.chem, captain: sc.captain, coach: sc.coach });
  const picks = JSON.stringify({ ...ids, CAPTAIN: captainId, COACH: coachId });
  // Храним лучший результат недели.
  await env.DB.prepare(
    `INSERT INTO challenge_entries (user_id, week, ch_id, score, breakdown, picks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, week) DO UPDATE SET score = excluded.score, breakdown = excluded.breakdown, picks = excluded.picks, updated_at = excluded.updated_at
     WHERE excluded.score > challenge_entries.score`,
  ).bind(uid, week, ch.id, score, breakdown, picks, Math.floor(Date.now() / 1000)).run();
  const best = await env.DB.prepare('SELECT score FROM challenge_entries WHERE user_id = ? AND week = ?').bind(uid, week).first();
  const place = await env.DB.prepare('SELECT COUNT(*) + 1 AS n FROM challenge_entries WHERE week = ? AND score > ?').bind(week, best.score).first();
  return json({ score, best: best.score, place: place.n, improved: score >= best.score });
}
