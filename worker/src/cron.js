// Задачи по расписанию (каждые 30 минут): напоминания о подписке и ежедневный дайджест.
// На бесплатном тарифе Cloudflare у одного запуска ограничено число внешних запросов,
// поэтому за раз отправляем не больше MAX_SENDS сообщений — остальное уйдёт следующими запусками.

import { bot } from './telegram.js';
import { DAY, isAdmin, markNotice, now, price } from './db.js';

const MAX_SENDS = 35;
const DIGEST_HOUR_UTC = 7; // 10:00 по Москве
const RENEWAL_GRACE = 2 * 3600; // ждём автопродление Telegram перед сообщением «доступ закончился»

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const date = t => new Date(t * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
const fmt = n => Number(n || 0).toLocaleString('ru-RU');

export async function getOrigin(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first();
  return row?.v || null;
}

export async function saveOrigin(env, origin) {
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('origin', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(origin).run();
}

function keyboard(origin, text) {
  return origin ? { inline_keyboard: [[{ text, web_app: { url: `${origin}/` } }]] } : undefined;
}

async function send(env, chatId, text, reply_markup) {
  try {
    await bot(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
    return true;
  } catch (err) {
    // Пользователь заблокировал бота — дальше не пишем ему дайджест.
    if (/blocked|deactivated|chat not found/i.test(err.message)) {
      await env.DB.prepare('UPDATE users SET digest = 0 WHERE user_id = ?').bind(chatId).run();
    }
    return false;
  }
}

// ---------- Напоминания ----------
async function reminders(env, origin, budget) {
  let sent = 0;
  const t = now();

  // За сутки до окончания.
  const soon = await env.DB.prepare(
    'SELECT user_id, until, charge_id FROM subscriptions WHERE until > ? AND until <= ? ORDER BY until LIMIT 100',
  ).bind(t, t + DAY).all();
  for (const s of soon.results) {
    if (sent >= budget) return sent;
    if (isAdmin(env, s.user_id) || !(await markNotice(env, s.user_id, 'soon', s.until))) continue;
    const paid = s.charge_id && s.charge_id !== 'trial' && s.charge_id !== 'bonus';
    const text = s.charge_id === 'trial'
      ? `🎁 Пробный период HUT Builder заканчивается <b>${date(s.until)}</b>.\nОформите подписку за ⭐ ${price(env)}, чтобы не потерять доступ.`
      : paid
        ? `🔔 <b>${date(s.until)}</b> подписка HUT Builder продлится автоматически за ⭐ ${price(env)}.\nЕсли вы отменяли автопродление — оформите подписку заново в приложении.`
        : `🔔 Доступ к HUT Builder заканчивается <b>${date(s.until)}</b>.\nПродлить можно в приложении за ⭐ ${price(env)}.`;
    if (await send(env, s.user_id, text, keyboard(origin, paid ? '🏒 Открыть HUT Builder' : `⭐ Оформить за ${price(env)}`))) sent++;
  }

  // Доступ закончился (и автопродления не было).
  const ended = await env.DB.prepare(
    'SELECT user_id, until, charge_id FROM subscriptions WHERE until <= ? AND until > ? ORDER BY until LIMIT 100',
  ).bind(t - RENEWAL_GRACE, t - 3 * DAY).all();
  for (const s of ended.results) {
    if (sent >= budget) return sent;
    if (isAdmin(env, s.user_id) || !(await markNotice(env, s.user_id, 'ended', s.until))) continue;
    const text = s.charge_id === 'trial'
      ? `Пробный период HUT Builder закончился. Понравилось? Подписка — ⭐ ${price(env)} за 30 дней.`
      : `Доступ к HUT Builder закончился. Вернуть его можно в приложении за ⭐ ${price(env)}.`;
    if (await send(env, s.user_id, text, keyboard(origin, `⭐ Оформить за ${price(env)}`))) sent++;
  }
  return sent;
}

// ---------- Дайджест ----------
function digestText(d, today) {
  const lines = [`📰 <b>HUT Builder — дайджест за ${date(now())}</b>`];
  const f = d.featured?.date === today ? d.featured : null;
  if (f) lines.push('', `<b>${esc(f.title)}</b>`, ...(f.lines || []).map(esc));
  if (d.newCount) {
    lines.push('', `🆕 <b>Новые карточки: ${d.newCount}</b>`);
    for (const c of d.newCards.slice(0, 6)) lines.push(`• ${esc(c.name)} — ${c.ovr} · ${esc(c.card)}`);
    if (d.newCount > 6) lines.push(`…и ещё ${d.newCount - 6}`);
  }
  const mover = m => `• ${esc(m.name)} ${m.ovr} · ${esc(m.card)} — ${fmt(m.price)}c (${m.change > 0 ? '+' : ''}${m.change}%)`;
  if (d.up.length) lines.push('', '📈 <b>Подорожали</b>', ...d.up.slice(0, 5).map(mover));
  if (d.down.length) lines.push('', '📉 <b>Подешевели</b>', ...d.down.slice(0, 5).map(mover));
  lines.push('', 'Отключить дайджест: /digest');
  return lines.join('\n');
}

async function digest(env, origin, budget) {
  const t = now();
  const today = new Date(t * 1000).toISOString().slice(0, 10);
  if (new Date(t * 1000).getUTCHours() < DIGEST_HOUR_UTC || budget <= 0) return 0;

  const res = await env.ASSETS.fetch(new Request('https://assets.local/data/digest.json'));
  if (!res.ok) return 0;
  const d = await res.json();
  if (!d.newCount && !d.up.length && !d.down.length && d.featured?.date !== today) return 0;
  const text = digestText(d, today);

  // Только тем, у кого есть доступ и включён дайджест.
  const rows = await env.DB.prepare(
    `SELECT u.user_id FROM users u JOIN subscriptions s ON s.user_id = u.user_id
     WHERE u.digest = 1 AND s.until > ? AND (u.last_digest IS NULL OR u.last_digest != ?) LIMIT ?`,
  ).bind(t, today, budget).all();
  let sent = 0;
  for (const r of rows.results) {
    await env.DB.prepare('UPDATE users SET last_digest = ? WHERE user_id = ?').bind(today, r.user_id).run();
    if (await send(env, r.user_id, text, keyboard(origin, '🏒 Открыть HUT Builder'))) sent++;
  }
  return sent;
}

export async function runScheduled(env) {
  const origin = await getOrigin(env);
  const sentReminders = await reminders(env, origin, MAX_SENDS);
  const sentDigest = await digest(env, origin, MAX_SENDS - sentReminders);
  console.log(`[cron] напоминаний: ${sentReminders}, дайджестов: ${sentDigest}`);
  return { reminders: sentReminders, digest: sentDigest };
}
