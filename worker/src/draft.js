// Драфт и челлендж недели на сервере: старт (лимит в день), проверка результата, таблица лидеров драфта.
//   POST /s/<токен>/api/draft/start   { fresh?, mode? } → { id, seed, poolV, left, ch?, week? }
//        mode: 'draft' (по умолчанию) или 'challenge'; продолжает незаконченную попытку этого режима, если она есть
//   POST /s/<токен>/api/draft/finish  { id, picks, order, rerolls, lineup } → { score, breakdown, place, left, best? }
//        order — позиции в порядке выбора; lineup — итоговая расстановка (после перестановок игроков одной позиции)
//   POST /s/<токен>/api/draft/save    { id, progress } — сохранить незаконченную попытку (пики, порядок,
//        перевыбросы, расстановку): в Telegram память приложения стирается при выходе, а так попытка
//        продолжится с того же места и на другом устройстве. Сервер ей не доверяет — finish проверяет всё заново.
//   GET  /s/<токен>/api/draft/board?period=day|week|all → { top, me, left }
// Челлендж — тот же драфт (21 пик по 1 из 4), но варианты только из карточек под условие недели.
// Лучшая попытка недели идёт в таблицу челленджа (challenge_entries).
// Варианты пиков сервер повторяет тем же генератором (draft-core.js) по пулу карточек из сборки,
// рейтинг и сыгранность считает сам (score-core.js); итог = рейтинг + сыгранность (до 200).

import { DRAFT_CAP, DRAFT_RULES, DRAFTS_PER_DAY, DRAFT_SLOTS, checkArrangement, verifyDraft } from './draft-core.js';
import { CHALLENGE_PER_DAY, CHALLENGE_SLOTS, challengeCheck, challengeNow, challengeRules } from './challenge-core.js';
import { draftBonus, scoreLineup } from './score-core.js';
import { gameData } from './game-data.js';
import { draftRewardsOn, firstDraftGiftDays, giftFirstDraft, isAdmin, now } from './db.js';
import { bot } from './telegram.js';

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
const modeOf = m => (m === 'challenge' ? 'challenge' : 'draft');
const perDay = mode => (mode === 'challenge' ? CHALLENGE_PER_DAY : DRAFTS_PER_DAY);
// Челлендж недели, которая начинается в понедельник week (YYYY-MM-DD).
const challengeOfWeek = week => challengeNow(Date.parse(week) + 12 * 3600e3);

// Попыткой считается законченная или брошенная. «expired» — начатая до обновления базы карточек
// (или челлендж прошлой недели): проверить её уже нельзя, поэтому она не засчитывается и попытку не тратит.
async function usedToday(env, uid, mode) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE user_id = ? AND day = ? AND mode = ? AND status IN ('done', 'abandoned')")
    .bind(uid, dayOf(now()), mode).first();
  return r.n;
}
export const leftToday = async (env, uid, mode = 'draft') =>
  (isAdmin(env, uid) ? 99 : Math.max(0, perDay(mode) - await usedToday(env, uid, mode)));

export const activeRun = (env, uid, mode) =>
  env.DB.prepare("SELECT * FROM drafts WHERE user_id = ? AND mode = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(uid, mode).first();

const expire = (env, id) => env.DB.prepare("UPDATE drafts SET status = 'expired', finished_at = ? WHERE id = ?").bind(now(), id).run();

export async function handleDraft(request, env, uid, path) {
  if (path === '/api/draft/start' && request.method === 'POST') return start(request, env, uid);
  if (path === '/api/draft/finish' && request.method === 'POST') return finish(request, env, uid);
  if (path === '/api/draft/save' && request.method === 'POST') return save(request, env, uid);
  if (path === '/api/draft/board') return board(request, env, uid);
  return json({ error: 'not_found' }, 404);
}

async function start(request, env, uid) {
  const body = await request.json().catch(() => ({}));
  const mode = modeOf(body.mode);
  const t = now();
  const { draftPool: pool } = await gameData(env);
  const { week, ch } = challengeNow(t * 1000);
  let active = await activeRun(env, uid, mode);
  // База карточек обновилась после старта или неделя челленджа сменилась: варианты уже не повторить.
  let expired = false;
  if (active && (active.pool_v !== pool.v || (mode === 'challenge' && active.week !== week))) {
    await expire(env, active.id);
    active = null;
    expired = true;
  }
  const extra = mode === 'challenge' ? { ch, week } : {};
  if (active && !body.fresh) {
    let progress = null;
    try { progress = active.picks ? JSON.parse(active.picks) : null; } catch {}
    return json({ id: active.id, seed: active.seed, poolV: active.pool_v, mode, ...extra, resumed: true, progress, left: await leftToday(env, uid, mode) });
  }
  // Брошенная попытка засчитывается как сыгранная — иначе можно перезапускать до удачных вариантов.
  if (active) await env.DB.prepare("UPDATE drafts SET status = 'abandoned', finished_at = ? WHERE id = ?").bind(t, active.id).run();
  const left = await leftToday(env, uid, mode);
  if (left <= 0) return json({ error: 'limit', left: 0 }, 429);
  const id = crypto.randomUUID();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  await env.DB.prepare("INSERT INTO drafts (id, user_id, day, mode, week, seed, pool_v, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)")
    .bind(id, uid, dayOf(t), mode, mode === 'challenge' ? week : null, seed, pool.v, t).run();
  return json({ id, seed, poolV: pool.v, mode, ...extra, resumed: false, expired, left: left - 1 });
}

// Прогресс незаконченной попытки хранится в колонке picks (у законченной там итоговый выбор).
async function save(request, env, uid) {
  const body = await request.json().catch(() => null);
  const p = body?.progress;
  if (!body?.id || !p || typeof p !== 'object' || !Array.isArray(p.order)) return json({ error: 'bad_request' }, 400);
  const progress = JSON.stringify({
    picks: p.picks && typeof p.picks === 'object' ? p.picks : {},
    order: p.order.map(String).slice(0, 30),
    rerolls: p.rerolls && typeof p.rerolls === 'object' ? p.rerolls : {},
    rerollsLeft: Number(p.rerollsLeft) || 0,
    lineup: p.lineup && typeof p.lineup === 'object' ? p.lineup : null,
  });
  if (progress.length > 8000) return json({ error: 'too_big' }, 413);
  const r = await env.DB.prepare("UPDATE drafts SET picks = ? WHERE id = ? AND user_id = ? AND status = 'active'").bind(progress, body.id, uid).run();
  return json({ ok: (r.meta?.changes ?? 1) > 0 });
}

async function finish(request, env, uid) {
  const body = await request.json().catch(() => null);
  if (!body?.id || typeof body.picks !== 'object') return json({ error: 'bad_request' }, 400);
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').bind(body.id, uid).first();
  if (!d) return json({ error: 'not_found' }, 404);
  const mode = modeOf(d.mode);
  if (d.status === 'done') return json({ score: d.score, already: true });
  if (d.status === 'expired') return json({ error: mode === 'challenge' && d.week !== challengeNow().week ? 'week_over' : 'pool_changed', left: await leftToday(env, uid, mode) }, 409);
  if (d.status !== 'active') return json({ error: 'abandoned' }, 409);

  const data = await gameData(env);
  // Пики в порядке выбора: первым капитан, дальше позиции, которые выбирал игрок.
  const order = Array.isArray(body.order) ? body.order.map(String).slice(0, 30) : [];
  const picks = {};
  for (const k of order) picks[k] = k === 'COACH' ? String(body.picks[k] ?? '') : Number(body.picks[k]);
  // Результат принимаем только проверенным: каждый выбор — из выпавших вариантов того же пула.
  if (data.draftPool.v !== d.pool_v) {
    await expire(env, d.id);
    return json({ error: 'pool_changed', left: await leftToday(env, uid, mode) }, 409);
  }
  let rules = DRAFT_RULES;
  let ch = null;
  if (mode === 'challenge') {
    // Неделя челленджа закончилась, пока шла попытка: в зачёт уже не идёт, попытку не тратит.
    if (d.week !== challengeNow().week) {
      await expire(env, d.id);
      return json({ error: 'week_over', left: await leftToday(env, uid, mode) }, 409);
    }
    ch = challengeOfWeek(d.week).ch;
    rules = challengeRules(ch, data.byId);
  }
  const err = verifyDraft(data.draftPool, d.seed, picks, order, body.rerolls || {}, rules, draftBonus(data));
  if (err) return json({ error: 'invalid', reason: err }, 422);
  // Итоговая расстановка: те же игроки, каждый на своей позиции (перестановки — только внутри позиции).
  const lineup = Object.fromEntries(DRAFT_SLOTS.map(k => [k, Number(body.lineup?.[k])]));
  const arrErr = checkArrangement(data.draftPool, picks, lineup);
  if (arrErr) return json({ error: 'invalid', reason: arrErr }, 422);
  if (ch) {
    const chErr = challengeCheck(ch, Object.fromEntries(CHALLENGE_SLOTS.map(k => [k, data.byId[lineup[k]]])));
    if (chErr) return json({ error: 'invalid', reason: chErr }, 422);
  }

  // Рейтинг и сыгранность сервер считает сам — тем же кодом, что приложение (score-core.js).
  const sc = scoreLineup(lineup, picks.CAPTAIN, picks.COACH, data);
  const score = sc.total;
  const breakdown = { rating: sc.rating, ovr: sc.ovr, chem: sc.chem, total: sc.total, avgOvr: sc.avgOvr, coachOvr: sc.coachOvr,
    cap: Number.isFinite(rules.cap) ? rules.cap : null };
  const saved = { ...picks, lineup, order };
  await env.DB.prepare("UPDATE drafts SET status = 'done', score = ?, breakdown = ?, picks = ?, verified = 1, finished_at = ? WHERE id = ?")
    .bind(score, JSON.stringify(breakdown), JSON.stringify(saved), now(), d.id).run();
  const left = await leftToday(env, uid, mode);
  // Месяц подписки за первый завершённый драфт (один раз на аккаунт).
  const gift = await giftFirstDraft(env, uid).catch(() => null);
  if (gift) {
    const till = new Date(gift.until * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    await bot(env, 'sendMessage', { chat_id: uid, parse_mode: 'HTML',
      text: `🎁 <b>Спасибо за первый драфт!</b>\nДарим ${gift.days} дней подписки — доступ продлён до <b>${till}</b>.` }).catch(() => {});
  }

  if (mode === 'challenge') {
    // В таблицу челленджа — лучшая попытка недели.
    await env.DB.prepare(
      `INSERT INTO challenge_entries (user_id, week, ch_id, score, breakdown, picks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, week) DO UPDATE SET score = excluded.score, breakdown = excluded.breakdown, picks = excluded.picks, updated_at = excluded.updated_at
       WHERE excluded.score > challenge_entries.score`,
    ).bind(uid, d.week, ch.id, score, JSON.stringify(breakdown), JSON.stringify(saved), now()).run();
    const best = (await env.DB.prepare('SELECT score FROM challenge_entries WHERE user_id = ? AND week = ?').bind(uid, d.week).first()).score;
    const place = await env.DB.prepare('SELECT COUNT(*) + 1 AS n FROM challenge_entries WHERE week = ? AND score > ?').bind(d.week, best).first();
    return json({ score, breakdown, best, place: place.n, left, gift });
  }
  const place = await env.DB.prepare(
    `SELECT COUNT(*) + 1 AS n FROM (SELECT user_id, MAX(score) AS best FROM drafts WHERE status = 'done' AND mode = 'draft' AND day = ? GROUP BY user_id)
     WHERE best > ?`).bind(d.day, score).first();
  return json({ score, breakdown, place: place.n, left, gift });
}

async function board(request, env, uid) {
  const period = new URL(request.url).searchParams.get('period') || 'day';
  const t = now();
  const where = period === 'all' ? '1 = 1' : period === 'week' ? 'day >= ?' : 'day = ?';
  const arg = period === 'all' ? [] : [period === 'week' ? weekStart(t) : dayOf(t)];
  const best = `SELECT user_id, MAX(score) AS best FROM drafts WHERE status = 'done' AND mode = 'draft' AND ${where} GROUP BY user_id`;
  const [top, mine, count] = await Promise.all([
    env.DB.prepare(`SELECT b.user_id, b.best, u.first_name, u.username FROM (${best}) b LEFT JOIN users u ON u.user_id = b.user_id
      ORDER BY b.best DESC LIMIT 10`).bind(...arg).all(),
    env.DB.prepare(`SELECT best, (SELECT COUNT(*) FROM (${best}) WHERE best > m.best) + 1 AS place FROM (${best}) m WHERE user_id = ?`)
      .bind(...arg, ...arg, uid).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${best})`).bind(...arg).first(),
  ]);
  const name = r => r.first_name || (r.username ? `@${r.username}` : `Игрок ${String(r.user_id).slice(-3)}`);
  const today = await env.DB.prepare("SELECT MAX(score) AS best, COUNT(*) AS n FROM drafts WHERE user_id = ? AND day = ? AND mode = 'draft' AND status = 'done'")
    .bind(uid, dayOf(t)).first();
  const active = await activeRun(env, uid, 'draft');
  return json({
    period,
    top: (top.results || []).map((r, i) => ({ place: i + 1, name: name(r), score: r.best, me: r.user_id === uid })),
    me: mine ? { place: mine.place, score: mine.best } : null,
    players: count.n,
    today: { best: today.best || 0, played: today.n },
    left: await leftToday(env, uid, 'draft'),
    active: !!active,
    activePick: active ? (() => { try { return JSON.parse(active.picks || '{}').order?.length || 0; } catch { return 0; } })() : 0,
    cap: Number.isFinite(DRAFT_CAP) ? DRAFT_CAP : null,
    rewards: draftRewardsOn(env),
    // Подарок за первый драфт ещё не получен — показываем плашку на вкладке.
    firstGift: firstDraftGiftDays(env) && !(await env.DB.prepare('SELECT 1 FROM meta WHERE k = ?').bind(`gift_first_draft:${uid}`).first())
      ? firstDraftGiftDays(env) : 0,
  });
}
