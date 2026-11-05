// Обработка апдейтов бота: оплата, команды, рефералы, инлайн-поиск карточек.

import { bot } from './telegram.js';
import { broadcastCallback, cmdBroadcast } from './broadcast.js';
import { cmdUser, cmdUsers, usersCallback } from './users.js';
import { sendDigestNow } from './cron.js';
import {
  extendDays, getUser, hasAccess, isAdmin, recordPayment, referralStats, refBonusDays,
  revokeByCharge, rewardReferrer, stats, touchUser, trialAvailable, trialDays,
} from './db.js';
import { createPayment, payEnabled, sendPayMessage } from './rollypay.js';
import { isLifetime, planById, plansKeyboard, plansText, rub } from './plans.js';

const STORAGE = 'https://cfahmyecewzymggdoebn.supabase.co/storage/v1';
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const date = t => (isLifetime(t) ? 'навсегда' : new Date(t * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }));
const fmt = n => Number(n || 0).toLocaleString('ru-RU');

let cachedUsername = null;
export async function botUsername(env) {
  if (env.BOT_USERNAME) return env.BOT_USERNAME.replace(/^@/, '');
  if (!cachedUsername) cachedUsername = (await bot(env, 'getMe')).username;
  return cachedUsername;
}

export const refLink = async (env, userId) => `https://t.me/${await botUsername(env)}?start=ref_${userId}`;

function shareUrl(link, text) {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

const send = (env, chatId, text, extra = {}) =>
  bot(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

function appKeyboard(origin, text = '🏒 Открыть HUT Builder', more = []) {
  return { inline_keyboard: [[{ text, web_app: { url: `${origin}/` } }], ...more] };
}

// ---------- Команды ----------
// Тарифы с кнопками «buy:<id>» (или сообщение, что оплата временно недоступна).
async function sendPlans(env, chatId, intro = '💳 <b>Тарифы HUT Builder</b> — оплата в рублях, СБП или картой:') {
  if (!payEnabled(env)) {
    return send(env, chatId, `Оплата временно недоступна.${env.SUPPORT_CONTACT ? ` Вопросы: ${esc(env.SUPPORT_CONTACT)}` : ''}`);
  }
  return send(env, chatId, [intro, '', plansText(), '', 'Без автопродления: платите только за выбранный срок.'].join('\n'),
    { reply_markup: plansKeyboard() });
}

async function cmdStart(env, msg, arg, origin) {
  if (arg === 'paid') return cmdStatus(env, msg, origin);
  if (arg === 'buy') return sendPlans(env, msg.chat.id);
  const refBy = /^ref_(\d+)$/.exec(arg || '')?.[1];
  const existed = await getUser(env, msg.from.id);
  await touchUser(env, msg.from, existed ? null : refBy);

  const trial = await trialAvailable(env, msg.from.id);
  const lines = [
    '🏒 <b>HUT Builder</b> — конструктор состава NHL HUT прямо в Telegram.',
    '',
    '• 8000+ карточек с картинками и ценами маркета',
    '• Настоящие line combos: OVR, Salary, AP',
    '• Капитаны и тренеры с подсчётом бонусов',
    '• Лучшие тройки и пары в 1 тап',
    '• Fantasy: кто забил в НХЛ',
    '',
    trial
      ? `🎁 <b>${trialDays(env)} дня бесплатно</b>, дальше — от 99 ₽ в месяц.`
      : 'Доступ — от 99 ₽ в месяц, оплата в рублях. Тарифы: /buy',
  ];
  if (refBy && !existed) lines.push('', '👋 Вас пригласил друг — после оплаты он получит бонус.');
  await send(env, msg.chat.id, lines.join('\n'), {
    reply_markup: appKeyboard(origin, trial ? '🎁 Попробовать бесплатно' : '🏒 Открыть HUT Builder',
      [[{ text: '💳 Тарифы', callback_data: 'plans' }, { text: `👥 Друг: +${refBonusDays(env)} дней`, callback_data: 'invite' }]]),
  });
}

async function cmdStatus(env, msg, origin) {
  const access = await hasAccess(env, msg.from.id);
  let text;
  if (access?.admin) text = '👑 У вас админский доступ без оплаты.';
  else if (access && isLifetime(access.until)) text = '👑 У вас доступ <b>навсегда</b>.';
  else if (access?.trial) text = `🎁 Пробный период до <b>${date(access.until)}</b>.\nДальше — от 99 ₽ в месяц: /buy`;
  else if (access) text = `✅ Доступ активен до <b>${date(access.until)}</b>.\nПродлить заранее (дни добавятся): /buy`;
  else return sendPlans(env, msg.chat.id, 'Доступа сейчас нет. Выберите тариф — оплата в рублях, СБП или картой:');
  await send(env, msg.chat.id, text, { reply_markup: appKeyboard(origin) });
}

// Кнопка тарифа: создаём платёж и присылаем сообщение с кнопкой «Оплатить».
async function buyCallback(env, cq) {
  const plan = planById(cq.data.slice(4));
  if (!plan) return;
  if (!payEnabled(env)) return send(env, cq.from.id, 'Оплата временно недоступна.');
  await touchUser(env, cq.from);
  try {
    const { payUrl } = await createPayment(env, cq.from.id, plan.id, await botUsername(env));
    await sendPayMessage(env, cq.from.id, plan, payUrl);
  } catch (err) {
    console.error('buy', err.message);
    await send(env, cq.from.id, 'Не удалось создать платёж. Попробуйте ещё раз через минуту или напишите /paysupport.');
  }
}

async function cmdInvite(env, chatId, userId) {
  const link = await refLink(env, userId);
  const st = await referralStats(env, userId);
  const days = refBonusDays(env);
  await send(env, chatId, [
    `👥 <b>Приглашайте друзей — получайте +${days} дней</b>`,
    '',
    `За каждого друга, который оформит подписку, вам добавится ${days} дней доступа.`,
    '',
    `Ваша ссылка:\n${link}`,
    '',
    `Приглашено: <b>${st?.invited || 0}</b> · оплатили: <b>${st?.paid || 0}</b>`,
  ].join('\n'), {
    reply_markup: { inline_keyboard: [[{ text: '📤 Отправить другу', url: shareUrl(link, '🏒 HUT Builder — собирай состав NHL HUT с настоящими line combos прямо в Telegram') }]] },
  });
}

async function cmdDigest(env, msg, args = []) {
  if (args[0] === 'test' && isAdmin(env, msg.from.id)) return sendDigestNow(env, msg.chat.id);
  const u = await getUser(env, msg.from.id);
  const on = u ? !u.digest : false;
  await touchUser(env, msg.from);
  await env.DB.prepare('UPDATE users SET digest = ? WHERE user_id = ?').bind(on ? 1 : 0, msg.from.id).run();
  await send(env, msg.chat.id, on
    ? '📰 Ежедневный дайджест <b>включён</b>: новые карточки и самые заметные изменения цен раз в день.'
    : '📰 Дайджест <b>выключен</b>. Включить снова — /digest');
}

async function cmdStats(env, msg) {
  if (!isAdmin(env, msg.from.id)) return;
  const s = await stats(env);
  const row = (label, p) => `${label}: <b>${fmt(p.rub)} ₽</b> (${fmt(p.n)} опл.)`;
  const byPlan = s.plans.map(p => `${planById(p.plan)?.title || p.plan}: ${fmt(p.n)} · ${fmt(p.rub)} ₽`).join('\n');
  await send(env, msg.chat.id, [
    '📊 <b>Статистика HUT Builder</b>',
    '',
    `Активных подписок: <b>${fmt(s.subs)}</b>`,
    `На пробном периоде: <b>${fmt(s.trials)}</b>`,
    `Пользователей: <b>${fmt(s.users)}</b> (+${fmt(s.newDay)} за сутки, +${fmt(s.newWeek)} за неделю)`,
    '',
    row('За сутки', s.s1),
    row('За 7 дней', s.s7),
    row('За 30 дней', s.s30),
    row('Всего', s.all) + (s.refunds ? ` · возвратов: ${fmt(s.refunds)}` : ''),
    `Навсегда: <b>${fmt(s.lifetime)}</b>`,
    byPlan ? `\n<b>По тарифам</b>\n${byPlan}` : '',
    '',
    `Рефералы: приглашено ${fmt(s.refs.invited)}, оплатили ${fmt(s.refs.paid)}`,
  ].join('\n'));
}

async function cmdRefund(env, msg, args) {
  // Только для администраторов: /refund <user_id> — вернуть последний платёж.
  if (!isAdmin(env, msg.from.id)) return;
  const userId = Number(args[0]);
  const r = userId && (await env.DB.prepare(
    'SELECT payment_id, plan, amount_rub, paid_at FROM rub_payments WHERE user_id = ? AND applied = 1 ORDER BY paid_at DESC LIMIT 1',
  ).bind(userId).first());
  if (r) {
    // Рубли возвращаются только из кабинета RollyPay; после возврата придёт вебхук и доступ снимется сам.
    return send(env, msg.chat.id, [
      `Последний платёж ${userId}: ${planById(r.plan)?.title || r.plan} — ${rub(r.amount_rub)}, ${date(r.paid_at)}.`,
      `ID: <code>${esc(r.payment_id)}</code>`,
      '',
      'Возврат делается в кабинете RollyPay → платёж → «Вернуть». Доступ по этому платежу снимется автоматически, пользователь получит сообщение.',
    ].join('\n'));
  }
  const p = userId && (await env.DB.prepare(
    'SELECT charge_id FROM payments WHERE user_id = ? AND refunded = 0 ORDER BY created_at DESC LIMIT 1',
  ).bind(userId).first());
  let text = 'Платёж не найден. Формат: /refund <user_id>';
  if (p) {
    try {
      await bot(env, 'refundStarPayment', { user_id: userId, telegram_payment_charge_id: p.charge_id });
      await revokeByCharge(env, p.charge_id);
      text = `Звёзды возвращены пользователю ${userId}, доступ закрыт.`;
    } catch (err) {
      text = `Не удалось вернуть: ${esc(err.message)}`;
    }
  }
  await send(env, msg.chat.id, text);
}

// /gift <user_id> <дней> — подарить дни доступа (админ).
async function cmdGift(env, msg, args) {
  if (!isAdmin(env, msg.from.id)) return;
  const [userId, days] = args.map(Number);
  if (!userId || !days) return send(env, msg.chat.id, 'Формат: /gift <user_id> <дней>');
  const until = await extendDays(env, userId, days);
  await send(env, msg.chat.id, `Пользователю ${userId} добавлено ${days} дн., доступ до ${date(until)}.`);
  await send(env, userId, `🎁 Вам подарили ${days} дн. доступа к HUT Builder — до ${date(until)}.`).catch(() => {});
}

const HELP = env => [
  '🏒 <b>HUT Builder — команды</b>',
  '',
  '/start — открыть приложение',
  '/status — статус подписки',
  '/buy — тарифы и оплата',
  `/invite — пригласить друга (+${refBonusDays(env)} дней)`,
  '/digest — включить или выключить ежедневный дайджест',
  '/terms — условия подписки',
  '/paysupport — помощь с оплатой',
  '',
  'В любом чате: <code>@бот имя игрока</code> — найти карточку и отправить её другу.',
].join('\n');

const TERMS = env => [
  '📄 <b>Условия подписки HUT Builder</b>',
  '',
  '• Тарифы: 1 месяц — 99 ₽, 3 месяца — 249 ₽, 1 год — 799 ₽, навсегда — 1 990 ₽. Оплата в рублях (СБП или банковская карта) через RollyPay.',
  '• Автопродления нет: доступ действует ровно оплаченный срок. Если продлить заранее, дни добавятся к текущему сроку.',
  '• «Навсегда» — бессрочный доступ к HUT Builder, включая будущие версии NHL, пока сервис работает.',
  trialDays(env) ? `• Пробный период — ${trialDays(env)} дня, один раз на аккаунт.` : '',
  '• Данные о карточках, ценах и комбинациях берутся с hutdb.app и обновляются каждый час; цены маркета вносит сообщество и они могут отличаться от игровых.',
  '• Если приложение не работает так, как описано, напишите /paysupport — разберёмся и при необходимости вернём деньги.',
].filter(Boolean).join('\n');

// ---------- Инлайн-поиск ----------
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const searchKey = word => (/^[a-z]$/.test(word[0]) ? word[0] : '_');

async function loadSearch(env, origin, key) {
  const res = await env.ASSETS.fetch(new Request(`${origin}/data/search/${key}.json`));
  return res.ok ? res.json() : [];
}

async function inlineQuery(env, q, origin) {
  const words = norm(q.query).split(/\s+/).filter(Boolean);
  // Пустой запрос — самые дорогие карточки; иначе ищем по первой букве первого слова.
  let rows = await loadSearch(env, origin, words.length ? searchKey(words[0]) : 'top');
  if (words.length) {
    rows = rows.filter(r => {
      const name = norm(r[1]);
      const parts = name.split(/[\s-]+/);
      return words.every(w => parts.some(p => p.startsWith(w)) || norm(`${r[4]} ${r[5]}`).includes(w));
    }).sort((a, b) => b[2] - a[2] || (b[7] || 0) - (a[7] || 0));
  }
  const username = await botUsername(env);
  const results = rows.slice(0, 20).map(([id, name, ovr, pos, card, team, img, priceC]) => {
    const path = `cards/${img}`; // вратари — cards/goalies/…
    const caption = [
      `🏒 <b>${esc(name)}</b> — ${ovr} OVR · ${esc(pos)}`,
      `🃏 ${esc(card)} · ${esc(team)}`,
      priceC ? `💰 ${fmt(priceC)} монет (маркет hutdb)` : '💰 цены на маркете пока нет',
      '',
      `Собери состав с ним в @${username}`,
    ].join('\n');
    return {
      type: 'photo',
      id: String(id),
      photo_url: `${STORAGE}/object/public/assets/${path}`,
      thumbnail_url: `${STORAGE}/render/image/public/assets/${path}${path.includes('?') ? '&' : '?'}resize=contain&width=200&quality=80`,
      title: `${name} · ${ovr}`,
      description: `${card} · ${priceC ? `${fmt(priceC)}c` : 'без цены'}`,
      caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🏒 Открыть HUT Builder', url: `https://t.me/${username}?start=card` }]] },
    };
  });
  await bot(env, 'answerInlineQuery', {
    inline_query_id: q.id,
    results,
    cache_time: 600,
    button: { text: '🏒 Собрать состав в HUT Builder', start_parameter: 'inline' },
  });
}

// ---------- Апдейты ----------
export async function handleUpdate(update, env, origin) {
  if (update.pre_checkout_query) {
    // Оплата звёздами больше не принимается (старые счета). Продления уже оформленных подписок
    // приходят без pre_checkout_query и обрабатываются ниже как successful_payment.
    await bot(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id, ok: false,
      error_message: 'Оплата звёздами больше не принимается. Тарифы в рублях — команда /buy в боте.',
    });
    return;
  }

  if (update.inline_query) return inlineQuery(env, update.inline_query, origin);

  if (update.callback_query) {
    const cq = update.callback_query;
    await bot(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (await broadcastCallback(env, cq)) return;
    if (await usersCallback(env, cq)) return;
    if (cq.data === 'invite') await cmdInvite(env, cq.from.id, cq.from.id);
    if (cq.data?.startsWith('buy:')) await buyCallback(env, cq);
    if (cq.data === 'plans') await sendPlans(env, cq.from.id);
    return;
  }

  const msg = update.message;
  if (!msg?.from) return;

  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    await touchUser(env, msg.from);
    const res = await recordPayment(env, msg.from.id, sp);
    if (!res) return;
    const renewal = sp.is_recurring && !sp.is_first_recurring;
    await send(env, msg.chat.id, renewal
      ? `🔄 Подписка продлена до <b>${date(res.until)}</b>. Спасибо!`
      : `✅ Оплата получена. Доступ открыт до <b>${date(res.until)}</b>.`,
    { reply_markup: appKeyboard(origin) });
    if (res.first) {
      const reward = await rewardReferrer(env, msg.from.id);
      if (reward) {
        await send(env, reward.referrer,
          `🎉 Ваш друг оформил подписку — вам добавлено <b>${reward.days} дней</b>. Доступ до ${date(reward.until)}.`,
          { reply_markup: appKeyboard(origin) }).catch(() => {});
      }
    }
    return;
  }

  if (msg.refunded_payment) {
    await revokeByCharge(env, msg.refunded_payment.telegram_payment_charge_id);
    return;
  }

  if (msg.chat.type !== 'private') return;
  const [rawCmd, ...args] = String(msg.text || '').trim().split(/\s+/);
  const cmd = rawCmd.replace(/@.*$/, '');
  switch (cmd) {
    case '/start': return cmdStart(env, msg, args[0], origin);
    case '/status': return cmdStatus(env, msg, origin);
    case '/buy': return sendPlans(env, msg.chat.id);
    case '/invite': return cmdInvite(env, msg.chat.id, msg.from.id);
    case '/digest': return cmdDigest(env, msg, args);
    case '/help': return send(env, msg.chat.id, HELP(env));
    case '/terms': return send(env, msg.chat.id, TERMS(env));
    case '/paysupport':
      return send(env, msg.chat.id,
        `Вопросы по оплате: ${esc(env.SUPPORT_CONTACT || 'напишите сюда, мы ответим')}.\nУкажите дату и сумму платежа — проверим и при необходимости вернём деньги.`);
    case '/stats': return cmdStats(env, msg);
    case '/refund': return cmdRefund(env, msg, args);
    case '/gift': return cmdGift(env, msg, args);
    case '/broadcast': return cmdBroadcast(env, msg, args);
    case '/users': return cmdUsers(env, msg, args);
    case '/user': return cmdUser(env, msg, args);
    default:
      if (rawCmd.startsWith('/')) return send(env, msg.chat.id, HELP(env));
  }
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'Открыть HUT Builder' },
  { command: 'status', description: 'Статус подписки' },
  { command: 'buy', description: 'Тарифы и оплата в рублях' },
  { command: 'invite', description: 'Пригласить друга (+дни доступа)' },
  { command: 'digest', description: 'Ежедневный дайджест: вкл/выкл' },
  { command: 'help', description: 'Все команды' },
  { command: 'terms', description: 'Условия подписки' },
  { command: 'paysupport', description: 'Помощь с оплатой' },
];

// Меню команд, которое видят только админы (в своём чате с ботом).
export const ADMIN_COMMANDS = [
  ...BOT_COMMANDS,
  { command: 'users', description: '👑 Все пользователи' },
  { command: 'user', description: '👑 Профиль: /user id или @username' },
  { command: 'stats', description: '👑 Статистика' },
  { command: 'broadcast', description: '👑 Рассылка всем' },
  { command: 'gift', description: '👑 Подарить дни: /gift id дней' },
  { command: 'refund', description: '👑 Возврат: /refund id' },
];

