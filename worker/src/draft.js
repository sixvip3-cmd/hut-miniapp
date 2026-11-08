// Драфт на сервере: старт (лимит в день), проверка результата, таблица лидеров.
//   POST /s/<токен>/api/draft/start   { fresh? } → { id, seed, poolV, left } (продолжает незаконченный, если он есть)
//   POST /s/<токен>/api/draft/finish  { id, picks, rerolls, score, breakdown } → { score, place }
//   GET  /s/<токен>/api/draft/board?period=day|week|all → { top, me, left }
// Варианты пиков сервер повторяет тем же генератором (draft-core.js) по пулу карточек из сборки.

import { DRAFT_CAP, DRAFT_ORDER, DRAFTS_PER_DAY, rawAvgOvr, verifyDraft } from './draft-core.js';
import { isAdmin, now } from './db.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// День и неделя — по Москве (UTC+3).
const msk = t => new Date((t + 3 * 3600) * 1000);
const dayOf = t => msk(t).toISOString().slice(0, 10);
function weekStart(t) {
  const d = msk(t);
  const back = (d.getUTCDay() + 6) % 7; // понедельник
  return new Date(d.getTime() - back * 86400e3).toISOString().slice(0, 10);
}

let poolCache = null;
async function loadPool(env) {
  if (poolCache && poolCache.at > Date.now() - 10 * 60e3) return poolCache.pool;
  const res = await env.ASSETS.fetch(new Request('https://assets.local/data/draft-pool.json'));
  const pool = await res.json();
  poolCache = { pool, at: Date.now() };
  return pool;
}

async function usedToday(env, uid) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE user_id = ? AND day = ? AND status != 'active'")
    .bind(uid, dayOf(now())).first();
  return r.n;
}
const leftToday = async (env, uid) => (isAdmin(env, uid) ? 99 : Math.max(0, DRAFTS_PER_DAY - await usedToday(env, uid)));

export async function handleDraft(request, env, uid, path) {
  if (path === '/api/draft/start' && request.method === 'POST') return start(request, env, uid);
  if (path === '/api/draft/finish' && request.method === 'POST') return finish(request, env, uid);
  if (path === '/api/draft/board') return board(request, env, uid);
  return json({ error: 'not_found' }, 404);
}

async function start(request, env, uid) {
  const { fresh } = await request.json().catch(() => ({}));
  const t = now();
  const active = await env.DB.prepare("SELECT id, seed, pool_v FROM drafts WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .bind(uid).first();
  if (active && !fresh) return json({ id: active.id, seed: active.seed, poolV: active.pool_v, resumed: true, left: await leftToday(env, uid) });
  // Брошенный драфт засчитывается как сыгранный — иначе можно перезапускать до удачных вариантов.
  if (active) await env.DB.prepare("UPDATE drafts SET status = 'abandoned', finished_at = ? WHERE id = ?").bind(t, active.id).run();
  const left = await leftToday(env, uid);
  if (left <= 0) return json({ error: 'limit', left: 0 }, 429);
  const pool = await loadPool(env);
  const id = crypto.randomUUID();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  await env.DB.prepare("INSERT INTO drafts (id, user_id, day, seed, pool_v, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
    .bind(id, uid, dayOf(t), seed, pool.v, t).run();
  return json({ id, seed, poolV: pool.v, resumed: false, left: left - 1 });
}

async function finish(request, env, uid) {
  const body = await request.json().catch(() => null);
  if (!body?.id || typeof body.picks !== 'object') return json({ error: 'bad_request' }, 400);
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').bind(body.id, uid).first();
  if (!d) return json({ error: 'not_found' }, 404);
  if (d.status === 'done') return json({ score: d.score, already: true });
  if (d.status !== 'active') return json({ error: 'abandoned' }, 409);

  const picks = {};
  for (const k of DRAFT_ORDER) picks[k] = k === 'COACH' ? String(body.picks[k] ?? '') : Number(body.picks[k]);
  const pool = await loadPool(env);
  let verified = 0;
  if (pool.v === d.pool_v) {
    const err = verifyDraft(pool, d.seed, picks, body.rerolls || {}, body.salAt || {});
    if (err) return json({ error: 'invalid', reason: err }, 422);
    verified = 1;
  }
  // Очки: 4 × средний рейтинг карточек (сервер пересчитывает сам) + бонусы сыгранности, капитана и тренера.
  const base = Math.round(rawAvgOvr(pool, picks) * 4);
  const b = body.breakdown || {};
  const clamp = (v, max) => Math.max(0, Math.min(Math.round(Number(v) || 0), max));
  const chem = clamp(b.chem, 160), captain = clamp(b.captain, 40), coach = clamp(b.coach, 60);
  const score = (verified ? base : Math.min(base, Math.round(Number(b.base) || base))) + chem + captain + coach;
  const breakdown = { base, avgOvr: Math.round(rawAvgOvr(pool, picks) * 10) / 10, chem, captain, coach, boost: b.boost || null, cap: DRAFT_CAP };
  await env.DB.prepare("UPDATE drafts SET status = 'done', score = ?, breakdown = ?, picks = ?, verified = ?, finished_at = ? WHERE id = ?")
    .bind(score, JSON.stringify(breakdown), JSON.stringify(picks), verified, now(), d.id).run();
  const place = await env.DB.prepare(
    `SELECT COUNT(*) + 1 AS n FROM (SELECT user_id, MAX(score) AS best FROM drafts WHERE status = 'done' AND day = ? GROUP BY user_id)
     WHERE best > ?`).bind(d.day, score).first();
  return json({ score, breakdown, place: place.n, left: await leftToday(env, uid) });
}

async function board(request, env, uid) {
  const period = new URL(request.url).searchParams.get('period') || 'day';
  const t = now();
  const where = period === 'all' ? '1 = 1' : period === 'week' ? 'day >= ?' : 'day = ?';
  const arg = period === 'all' ? [] : [period === 'week' ? weekStart(t) : dayOf(t)];
  const best = `SELECT user_id, MAX(score) AS best FROM drafts WHERE status = 'done' AND ${where} GROUP BY user_id`;
  const [top, mine, count] = await Promise.all([
    env.DB.prepare(`SELECT b.user_id, b.best, u.first_name, u.username FROM (${best}) b LEFT JOIN users u ON u.user_id = b.user_id
      ORDER BY b.best DESC LIMIT 10`).bind(...arg).all(),
    env.DB.prepare(`SELECT best, (SELECT COUNT(*) FROM (${best}) WHERE best > m.best) + 1 AS place FROM (${best}) m WHERE user_id = ?`)
      .bind(...arg, ...arg, uid).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${best})`).bind(...arg).first(),
  ]);
  const name = r => r.first_name || (r.username ? `@${r.username}` : `Игрок ${String(r.user_id).slice(-3)}`);
  const today = await env.DB.prepare("SELECT MAX(score) AS best, COUNT(*) AS n FROM drafts WHERE user_id = ? AND day = ? AND status = 'done'")
    .bind(uid, dayOf(t)).first();
  const active = await env.DB.prepare("SELECT id FROM drafts WHERE user_id = ? AND status = 'active' LIMIT 1").bind(uid).first();
  return json({
    period,
    top: (top.results || []).map((r, i) => ({ place: i + 1, name: name(r), score: r.best, me: r.user_id === uid })),
    me: mine ? { place: mine.place, score: mine.best } : null,
    players: count.n,
    today: { best: today.best || 0, played: today.n },
    left: await leftToday(env, uid),
    active: !!active,
  });
}
