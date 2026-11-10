// Челлендж недели на сервере: таблица недели.
//   GET  /s/<токен>/api/challenge/board  → { ch, week, endsAt, top, me, players, left, active }
// Сами попытки челленджа — это драфт в режиме 'challenge' (worker/src/draft.js): старт, проверка
// каждого пика, подсчёт очков. Лучшая попытка недели сохраняется в challenge_entries.

import { challengeNow } from './challenge-core.js';
import { activeRun, leftToday } from './draft.js';
import { draftRewardsOn } from './db.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleChallenge(request, env, uid, path) {
  if (path === '/api/challenge/board') return board(env, uid);
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
  const [top, mine, count, left, active] = await Promise.all([
    challengeTop(env, week),
    env.DB.prepare(`SELECT score, (SELECT COUNT(*) FROM challenge_entries WHERE week = ?1 AND score > m.score) + 1 AS place
      FROM challenge_entries m WHERE week = ?1 AND user_id = ?2`).bind(week, uid).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM challenge_entries WHERE week = ?').bind(week).first(),
    leftToday(env, uid, 'challenge'),
    activeRun(env, uid, 'challenge'),
  ]);
  return json({
    ch, week, endsAt,
    top: top.map((r, i) => ({ place: i + 1, name: nameOf(r), score: r.score, me: r.user_id === uid })),
    me: mine ? { place: mine.place, score: mine.score } : null,
    players: count.n,
    left,
    active: !!active && active.week === week,
    rewards: draftRewardsOn(env),
  });
}
