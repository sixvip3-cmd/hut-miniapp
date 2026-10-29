// Пользователи для админа: /users — список с фильтрами, листанием и поиском,
// /user <id | @username> — профиль (доступ, оплаты, рефералы, активность).
// Кнопки списка и профиля редактируют одно и то же сообщение (callback u…).

import { bot } from './telegram.js';
import { extendDays, isAdmin, now } from './db.js';

const PAGE = 10;
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const date = t => new Date(t * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
const dateTime = t => new Date(t * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ago(t) {
  if (!t) return '—';
  const min = Math.round((now() - t) / 60);
  if (min < 2) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} дн назад` : date(t);
}

// Статус доступа по строке подписки (s_until, s_charge) — те же правила, что в db.hasAccess.
function status(env, u) {
  if (isAdmin(env, u.user_id)) return { icon: '👑', text: 'админ — доступ бесплатно' };
  if (!u.s_until) return { icon: '⚪️', text: 'доступа не было' };
  if (u.s_until <= now()) return { icon: '⛔️', text: `доступ закончился ${date(u.s_until)}` };
  if (u.s_charge === 'trial') return { icon: '🎁', text: `пробный период до ${date(u.s_until)}` };
  if (u.s_charge === 'bonus') return { icon: '➕', text: `бонусные дни до ${date(u.s_until)}` };
  return { icon: '💎', text: `подписка до ${date(u.s_until)}` };
}

const FILTERS = {
  all: { label: 'Все', where: '1 = 1' },
  paid: { label: '💎 Платят', where: "s.until > :now AND s.charge_id NOT IN ('trial', 'bonus')" },
  trial: { label: '🎁 Пробный', where: "s.until > :now AND s.charge_id = 'trial'" },
  expired: { label: '⛔️ Истёк', where: 's.until <= :now' },
  none: { label: '⚪️ Без доступа', where: 's.user_id IS NULL' },
  new: { label: '🆕 За сутки', where: 'u.first_seen > :now - 86400' },
};

const BASE_SQL = `
  SELECT u.*, s.until AS s_until, s.charge_id AS s_charge, b.user_id IS NOT NULL AS blocked,
    (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.user_id AND p.refunded = 0) AS stars
  FROM users u
  LEFT JOIN subscriptions s ON s.user_id = u.user_id
  LEFT JOIN blocked b ON b.user_id = u.user_id`;

const nameOf = u => esc(u.first_name || 'без имени') + (u.username ? ` (@${esc(u.username)})` : '');
const short = u => (u.first_name || u.username || String(u.user_id)).slice(0, 18);

async function listView(env, filter = 'all', page = 0, search = '') {
  const f = FILTERS[filter] || FILTERS.all;
  const t = now();
  let where = f.where.replaceAll(':now', String(t));
  const binds = [];
  if (search) {
    where += ' AND (u.username LIKE ?1 OR u.first_name LIKE ?1 OR CAST(u.user_id AS TEXT) = ?2)';
    binds.push(`%${search.replace(/^@/, '')}%`, search);
  }
  const [rows, count, totals] = await Promise.all([
    env.DB.prepare(`${BASE_SQL} WHERE ${where} ORDER BY u.last_seen DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u LEFT JOIN subscriptions s ON s.user_id = u.user_id WHERE ${where}`).bind(...binds).first(),
    env.DB.prepare(`SELECT ${Object.entries(FILTERS).map(([k, x]) => `SUM(CASE WHEN ${x.where.replaceAll(':now', String(t))} THEN 1 ELSE 0 END) AS "${k}"`).join(', ')}
      FROM users u LEFT JOIN subscriptions s ON s.user_id = u.user_id`).first(),
  ]);
  const users = rows.results || [];
  const pages = Math.max(1, Math.ceil(count.n / PAGE));

  const lines = users.map((u, i) => {
    const st = status(env, u);
    return `${page * PAGE + i + 1}. ${st.icon} <b>${nameOf(u)}</b>${u.stars ? ` · ${u.stars} ⭐` : ''}${u.blocked ? ' · 🚫' : ''}\n     <code>${u.user_id}</code> · был ${ago(u.last_seen)}`;
  });
  const text = [
    `👥 <b>Пользователи</b>${search ? ` · поиск «${esc(search)}»` : ''} · ${f.label}: <b>${count.n}</b>`,
    `Всего ${totals.all || 0} · 💎 ${totals.paid || 0} · 🎁 ${totals.trial || 0} · ⛔️ ${totals.expired || 0} · 🆕 ${totals.new || 0}`,
    '',
    lines.join('\n') || 'Никого не нашли.',
    '',
    `Стр. ${page + 1}/${pages} · нажмите на имя, чтобы открыть профиль`,
  ].join('\n');

  // Короткий поиск помещается в callback_data (до 64 байт).
  const q = search ? `:${search.slice(0, 20)}` : '';
  const userButtons = users.map((u, i) => ({ text: `${page * PAGE + i + 1}. ${short(u)}`, callback_data: `uv:${u.user_id}:${filter}:${page}${q}` }));
  const keyboard = [];
  for (let i = 0; i < userButtons.length; i += 2) keyboard.push(userButtons.slice(i, i + 2));
  const nav = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `ul:${filter}:${page - 1}${q}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: `ul:${filter}:${page}${q}` });
  if (page < pages - 1) nav.push({ text: '▶️', callback_data: `ul:${filter}:${page + 1}${q}` });
  keyboard.push(nav);
  const filters = Object.entries(FILTERS).map(([k, x]) => ({ text: (k === filter ? '• ' : '') + x.label, callback_data: `ul:${k}:0` }));
  keyboard.push(filters.slice(0, 3), filters.slice(3));
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

async function profileView(env, userId, back = 'ul:all:0') {
  const u = await env.DB.prepare(`${BASE_SQL} WHERE u.user_id = ?`).bind(userId).first();
  if (!u) return { text: `Пользователь <code>${esc(userId)}</code> не найден. Он должен хотя бы раз открыть бота.`, reply_markup: { inline_keyboard: [[{ text: '« К списку', callback_data: back }]] } };
  const [pay, trial, refs, refBy] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN refunded = 0 THEN amount END), 0) AS stars,
      SUM(refunded) AS refunds, MAX(created_at) AS last, MIN(created_at) AS first FROM payments WHERE user_id = ?`).bind(userId).first(),
    env.DB.prepare('SELECT started_at, until FROM trials WHERE user_id = ?').bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS invited, SUM(CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.user_id) THEN 1 ELSE 0 END) AS paid
      FROM users u WHERE ref_by = ?`).bind(userId).first(),
    u.ref_by ? env.DB.prepare('SELECT user_id, first_name, username FROM users WHERE user_id = ?').bind(u.ref_by).first() : null,
  ]);
  const st = status(env, u);
  const text = [
    `👤 <b>${esc(u.first_name || 'без имени')}</b>`,
    u.username ? `@${esc(u.username)}` : 'без @username',
    `ID: <code>${u.user_id}</code> · <a href="tg://user?id=${u.user_id}">написать</a>`,
    '',
    `<b>Доступ:</b> ${st.icon} ${st.text}`,
    `<b>Пробный период:</b> ${trial ? `взят ${date(trial.started_at)}` : 'не брал'}`,
    `<b>Оплаты:</b> ${pay.n ? `${pay.n} шт. · <b>${pay.stars} ⭐</b>${pay.refunds ? ` · возвратов: ${pay.refunds}` : ''}\n     первая ${date(pay.first)}, последняя ${date(pay.last)}` : 'не было'}`,
    '',
    `<b>Пригласил:</b> ${refs.invited || 0}${refs.invited ? ` (оплатили ${refs.paid || 0})` : ''}`,
    `<b>Пришёл от:</b> ${refBy ? `${nameOf(refBy)} · <code>${refBy.user_id}</code>` : u.ref_by ? `<code>${u.ref_by}</code>` : 'сам'}`,
    '',
    `<b>Впервые:</b> ${dateTime(u.first_seen)}`,
    `<b>Последний раз:</b> ${dateTime(u.last_seen)} (${ago(u.last_seen)})`,
    `<b>Дайджест:</b> ${u.digest ? 'включён' : 'выключен'}`,
    u.blocked ? '🚫 <b>Заблокировал бота</b> — рассылки ему не приходят' : null,
  ].filter(s => s !== null).join('\n');
  const keyboard = [
    [{ text: '🎁 +3 дня', callback_data: `ug:${userId}:3` }, { text: '🎁 +7 дней', callback_data: `ug:${userId}:7` }, { text: '🎁 +30 дней', callback_data: `ug:${userId}:30` }],
    ...(refBy ? [[{ text: `👤 Кто пригласил: ${short(refBy)}`, callback_data: `uv:${refBy.user_id}` }]] : []),
    [{ text: '« К списку', callback_data: back }],
  ];
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

const sendView = (env, chatId, view) =>
  bot(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...view });

async function editView(env, cq, view) {
  try {
    await bot(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML', disable_web_page_preview: true, ...view,
    });
  } catch (err) {
    if (!/not modified/.test(err.message)) throw err;
  }
}

// /users [поиск]
export async function cmdUsers(env, msg, args) {
  if (!isAdmin(env, msg.from.id)) return;
  return sendView(env, msg.chat.id, await listView(env, 'all', 0, args.join(' ').trim()));
}

// /user <id | @username>
export async function cmdUser(env, msg, args) {
  if (!isAdmin(env, msg.from.id)) return;
  const q = (args[0] || '').replace(/^@/, '');
  if (!q) return sendView(env, msg.chat.id, { text: 'Формат: <code>/user 123456789</code> или <code>/user @username</code>\nСписок всех: /users' });
  const row = /^\d+$/.test(q)
    ? { user_id: Number(q) }
    : await env.DB.prepare('SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)').bind(q).first();
  if (!row) return sendView(env, msg.chat.id, await listView(env, 'all', 0, q));
  return sendView(env, msg.chat.id, await profileView(env, row.user_id));
}

// Кнопки: ul:<фильтр>:<стр>[:поиск] — список, uv:<id>[:фильтр:стр[:поиск]] — профиль, ug:<id>:<дней> — подарить дни.
export async function usersCallback(env, cq) {
  const m = /^u([lvg]):(.*)$/.exec(cq.data || '');
  if (!m) return false;
  if (!isAdmin(env, cq.from.id) || !cq.message) return true;
  const [kind, rest] = [m[1], m[2].split(':')];
  if (kind === 'l') {
    const [filter, page, ...search] = rest;
    await editView(env, cq, await listView(env, filter, Number(page) || 0, search.join(':')));
  } else if (kind === 'v') {
    const [id, filter, page, ...search] = rest;
    const back = filter ? `ul:${filter}:${page}${search.length ? ':' + search.join(':') : ''}` : 'ul:all:0';
    await editView(env, cq, await profileView(env, Number(id), back));
  } else {
    const [id, days] = rest.map(Number);
    if (!id || !days) return true;
    const until = await extendDays(env, id, days);
    await bot(env, 'sendMessage', { chat_id: id, text: `🎁 Вам подарили ${days} дн. доступа к HUT Builder — до ${date(until)}.` }).catch(() => {});
    await bot(env, 'sendMessage', { chat_id: cq.message.chat.id, text: `✅ Пользователю ${id} добавлено ${days} дн., доступ до ${date(until)}.` });
    await editView(env, cq, await profileView(env, id));
  }
  return true;
}
