// Награды драфта и челленджа (запускается из cron каждые 30 минут, каждую награду выдаёт один раз):
//   после окончания недели — №1 драфта недели и №1 челленджа недели получают 30 дней доступа;
//   после окончания месяца — №1 драфта месяца получает 365 дней.
// Неделя и месяц — по Москве. При равных очках выигрывает тот, кто набрал их раньше.

import { bot } from './telegram.js';
import { adminIds, extendDays } from './db.js';
import { challengeNow } from './challenge-core.js';
import { challengeTop } from './challenge.js';

const DAY = 86400e3;
const MSK = 3 * 3600e3;
const date = t => new Date(t * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

async function once(env, key) {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES (?, 'done')").bind(key).run();
  return res.meta.changes > 0;
}

async function draftWinner(env, fromDay, toDay) {
  return env.DB.prepare(
    `SELECT d.user_id, MAX(d.score) AS best, MIN(d.finished_at) AS at, u.first_name, u.username FROM drafts d
     LEFT JOIN users u ON u.user_id = d.user_id
     WHERE d.status = 'done' AND d.mode = 'draft' AND d.day >= ? AND d.day < ? GROUP BY d.user_id ORDER BY best DESC, at ASC LIMIT 1`,
  ).bind(fromDay, toDay).first();
}

const nameOf = r => r.first_name || (r.username ? `@${r.username}` : String(r.user_id));
const send = (env, chatId, text) => bot(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch(() => {});

async function grant(env, winner, days, text) {
  const until = await extendDays(env, winner.user_id, days);
  await send(env, winner.user_id, `${text}\nДоступ продлён до <b>${date(until)}</b>. 🏆`);
}

export async function runRewards(env) {
  const nowMs = Date.now();
  const { week } = challengeNow(nowMs);
  const prevWeek = new Date(Date.parse(week) - 7 * DAY).toISOString().slice(0, 10);
  const summary = [];

  if (await once(env, `reward:week:${prevWeek}`)) {
    const w = await draftWinner(env, prevWeek, week);
    if (w) {
      await grant(env, w, 30, `🥇 Вы — №1 драфта за неделю с ${prevWeek.split('-').reverse().join('.')}: <b>${w.best}</b> очков! Награда — 30 дней HUT Builder.`);
      summary.push(`Драфт недели: ${nameOf(w)} — ${w.best} (+30 дней)`);
    }
    const prevCh = challengeNow(Date.parse(prevWeek) + DAY);
    const [c] = await challengeTop(env, prevWeek, 1);
    if (c) {
      await grant(env, c, 30, `🥇 Вы выиграли челлендж «${prevCh.ch.title}»: <b>${c.score}</b> очков! Награда — 30 дней HUT Builder.`);
      summary.push(`Челлендж «${prevCh.ch.title}»: ${nameOf(c)} — ${c.score} (+30 дней)`);
    }
  }

  // Прошлый месяц по Москве
  const msk = new Date(nowMs + MSK);
  const thisMonth = `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth() - 1, 1));
  const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  if (await once(env, `reward:month:${prevMonth}`)) {
    const w = await draftWinner(env, `${prevMonth}-01`, `${thisMonth}-01`);
    if (w) {
      await grant(env, w, 365, `👑 Вы — №1 драфта за месяц: <b>${w.best}</b> очков! Награда — год HUT Builder.`);
      summary.push(`Драфт месяца ${prevMonth}: ${nameOf(w)} — ${w.best} (+365 дней)`);
    }
  }

  if (summary.length) {
    for (const id of adminIds(env)) await send(env, id, ['🏆 <b>Награды выданы</b>', '', ...summary].join('\n'));
  }
  return summary;
}

