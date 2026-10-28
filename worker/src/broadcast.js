// Рассылка всем пользователям бота (только для админов).
//
//   1. Админ отправляет боту сообщение (текст, фото, видео — с любым оформлением)
//      и отвечает на него командой /broadcast. Или пишет: /broadcast <текст>.
//   2. Бот показывает, сколько получателей, и кнопки «Отправить всем» / «Отмена».
//   3. Сообщение копируется каждому пользователю (copyMessage) с кнопкой «Открыть HUT Builder».
//      Отправка идёт пачками по BATCH раз в минуту (cron) — так не упираемся в лимиты
//      Telegram и бесплатного тарифа Cloudflare. В конце админ получает отчёт.

import { bot } from './telegram.js';
import { isAdmin, now } from './db.js';
import { getOrigin } from './cron.js';

const BATCH = 40;

const send = (env, chatId, text, extra = {}) =>
  bot(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

const audienceCount = env =>
  env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE user_id NOT IN (SELECT user_id FROM blocked)').first();

// /broadcast — ответом на сообщение или с текстом после команды.
export async function cmdBroadcast(env, msg, args) {
  if (!isAdmin(env, msg.from.id)) return;
  if (args[0] === 'status') return broadcastStatus(env, msg.chat.id);

  let sourceId = msg.reply_to_message?.message_id;
  if (!sourceId) {
    const text = String(msg.text || '').replace(/^\/broadcast(@\S+)?\s*/, '');
    if (!text) {
      return send(env, msg.chat.id, [
        '📣 <b>Рассылка всем пользователям</b>',
        '',
        '1. Отправьте сюда сообщение для рассылки — можно с жирным шрифтом, эмодзи, фото или видео.',
        '2. Ответьте на него командой /broadcast (свайп по сообщению → «Ответить»).',
        '',
        'Или коротко: <code>/broadcast текст сообщения</code>',
        'Статус текущей рассылки: <code>/broadcast status</code>',
      ].join('\n'));
    }
    sourceId = (await bot(env, 'sendMessage', { chat_id: msg.chat.id, text })).message_id;
  }

  const { n } = await audienceCount(env);
  const res = await env.DB.prepare(
    "INSERT INTO broadcasts (from_chat_id, message_id, created_at, status, total, sent, failed) VALUES (?, ?, ?, 'draft', ?, 0, 0)",
  ).bind(msg.chat.id, sourceId, now(), n).run();
  const id = res.meta.last_row_id;
  await send(env, msg.chat.id, `👆 Это сообщение получат <b>${n}</b> польз. Под ним будет кнопка «Открыть HUT Builder».\nОтправить?`, {
    reply_to_message_id: sourceId,
    reply_markup: { inline_keyboard: [[{ text: `✅ Отправить всем (${n})`, callback_data: `bc_ok:${id}` }, { text: '❌ Отмена', callback_data: `bc_no:${id}` }]] },
  });
}

async function broadcastStatus(env, chatId) {
  const b = await env.DB.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1').first();
  if (!b) return send(env, chatId, 'Рассылок ещё не было.');
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM broadcast_queue WHERE broadcast_id = ?').bind(b.id).first();
  const status = { draft: 'ждёт подтверждения', sending: 'идёт отправка', done: 'завершена', cancelled: 'отменена' }[b.status] || b.status;
  return send(env, chatId, `📣 Рассылка #${b.id}: ${status}\nОтправлено: ${b.sent} · не доставлено: ${b.failed} · в очереди: ${left.n} · всего: ${b.total}`);
}

// Кнопки «Отправить всем» / «Отмена».
export async function broadcastCallback(env, cq) {
  const m = /^bc_(ok|no):(\d+)$/.exec(cq.data || '');
  if (!m) return false;
  if (!isAdmin(env, cq.from.id)) return true;
  const id = Number(m[2]);
  const b = await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(id).first();
  const edit = text => bot(env, 'editMessageText', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id, text, parse_mode: 'HTML',
  }).catch(() => {});
  if (!b || b.status !== 'draft') return edit('Эта рассылка уже обработана.'), true;

  if (m[1] === 'no') {
    await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ?").bind(id).run();
    await edit('❌ Рассылка отменена.');
    return true;
  }
  await env.DB.prepare('INSERT OR IGNORE INTO broadcast_queue (broadcast_id, user_id) SELECT ?, user_id FROM users WHERE user_id NOT IN (SELECT user_id FROM blocked)')
    .bind(id).run();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM broadcast_queue WHERE broadcast_id = ?').bind(id).first();
  await env.DB.prepare("UPDATE broadcasts SET status = 'sending', total = ? WHERE id = ?").bind(n, id).run();
  const minutes = Math.max(1, Math.ceil(n / BATCH));
  await edit(`🚀 Рассылка запущена: <b>${n}</b> получателей, примерно ${minutes} мин.\nКогда закончится — пришлю отчёт. Статус: <code>/broadcast status</code>`);
  return true;
}

// Раз в минуту: следующая пачка сообщений.
export async function processBroadcasts(env) {
  const b = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1").first();
  if (!b) return 0;
  const origin = await getOrigin(env);
  const markup = origin ? { inline_keyboard: [[{ text: '🏒 Открыть HUT Builder', web_app: { url: `${origin}/` } }]] } : undefined;
  const batch = await env.DB.prepare('SELECT user_id FROM broadcast_queue WHERE broadcast_id = ? LIMIT ?').bind(b.id, BATCH).all();

  let sent = 0, failed = 0;
  for (const { user_id } of batch.results) {
    try {
      await bot(env, 'copyMessage', { chat_id: user_id, from_chat_id: b.from_chat_id, message_id: b.message_id, reply_markup: markup });
      sent++;
    } catch (err) {
      failed++;
      if (/blocked|deactivated|chat not found|user is deactivated/i.test(err.message)) {
        await env.DB.prepare('INSERT OR IGNORE INTO blocked (user_id, at) VALUES (?, ?)').bind(user_id, now()).run();
      }
    }
    await env.DB.prepare('DELETE FROM broadcast_queue WHERE broadcast_id = ? AND user_id = ?').bind(b.id, user_id).run();
  }
  await env.DB.prepare('UPDATE broadcasts SET sent = sent + ?, failed = failed + ? WHERE id = ?').bind(sent, failed, b.id).run();

  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM broadcast_queue WHERE broadcast_id = ?').bind(b.id).first();
  if (!left.n) {
    await env.DB.prepare("UPDATE broadcasts SET status = 'done' WHERE id = ?").bind(b.id).run();
    const fin = await env.DB.prepare('SELECT sent, failed FROM broadcasts WHERE id = ?').bind(b.id).first();
    await send(env, b.from_chat_id, `✅ Рассылка #${b.id} завершена.\nДоставлено: <b>${fin.sent}</b> · не доставлено: ${fin.failed} (бот заблокирован или аккаунт удалён).`).catch(() => {});
  }
  return sent;
}
