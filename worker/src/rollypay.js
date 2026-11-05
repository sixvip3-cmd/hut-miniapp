// Оплата в рублях через RollyPay (СБП, карты): создание платежа, вебхук, выдача и снятие доступа.
//
// Платёж: POST {API}/payments (X-API-Key, X-Nonce) → pay_url. Бот присылает сообщение с кнопкой «Оплатить».
// Вебхук: POST /webhooks/rollypay, подпись X-Signature = hex(HMAC-SHA256(signing_secret, X-Timestamp + "." + тело)).
// Верим последнему событию по payment_id: paid → выдаём доступ (ровно один раз),
// refunded / chargeback → забираем выданное. Поздний paid после expired тоже засчитывается.
//
// Выключатель: ROLLYPAY_ENABLED = "0" прячет оплату везде (например, если Telegram пришлёт предупреждение).

import { bot, hmacHex, safeEqual } from './telegram.js';
import { DAY, getSubscription, now, rewardReferrer } from './db.js';
import { LIFETIME_UNTIL, isLifetime, planById, rub } from './plans.js';

const PENDING_REUSE = 20 * 60; // неоплаченную ссылку на тот же тариф отдаём повторно в течение 20 минут
const date = t => (isLifetime(t) ? 'навсегда' : new Date(t * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }));

export const payEnabled = env => !!env.ROLLYPAY_API_KEY && env.ROLLYPAY_ENABLED !== '0';
const testMode = env => env.ROLLYPAY_TEST === '1';
const apiBase = env => (env.ROLLYPAY_API_BASE || 'https://rollypay.io/api/v1').replace(/\/$/, '');

async function api(env, method, path, body) {
  const res = await fetch(`${apiBase(env)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': env.ROLLYPAY_API_KEY, 'X-Nonce': crypto.randomUUID() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RollyPay ${path}: ${res.status} ${data.message || data.error || ''}`.trim());
  return data;
}

// Ссылка на оплату тарифа: новый платёж или ещё не истёкший прежний на тот же тариф.
export async function createPayment(env, userId, planId, botUsername) {
  const plan = planById(planId);
  if (!plan) throw new Error('unknown plan');
  const t = now();
  const pending = await env.DB.prepare(
    `SELECT payment_id, pay_url FROM rub_payments
     WHERE user_id = ? AND plan = ? AND status = 'created' AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId, plan.id, t - PENDING_REUSE).first();
  if (pending) return { plan, payUrl: pending.pay_url, paymentId: pending.payment_id };

  const orderId = `hb_${userId}_${plan.id}_${t}`;
  const back = botUsername ? `https://t.me/${botUsername}` : undefined;
  const p = await api(env, 'POST', '/payments', {
    amount: plan.rub.toFixed(2),
    payment_currency: 'RUB',
    order_id: orderId,
    description: `HUT Builder — ${plan.title}`,
    customer_id: `tg_${userId}`,
    metadata: { uid: userId, plan: plan.id },
    ...(back && { success_redirect_url: `${back}?start=paid`, fail_redirect_url: `${back}?start=buy` }),
    ...(testMode(env) && { test: true }),
  });
  await env.DB.prepare(
    `INSERT INTO rub_payments (payment_id, order_id, user_id, plan, amount_rub, status, test, pay_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
  ).bind(p.payment_id, orderId, userId, plan.id, plan.rub, testMode(env) ? 1 : 0, p.pay_url, t, t).run();
  return { plan, payUrl: p.pay_url, paymentId: p.payment_id };
}

// Сообщение в бота с кнопкой оплаты.
export async function sendPayMessage(env, chatId, plan, payUrl, origin = null) {
  await bot(env, 'sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: [
      `💳 <b>HUT Builder — ${plan.title}</b>`,
      `К оплате: <b>${rub(plan.rub)}</b> — СБП или банковская карта.`,
      '',
      plan.days ? `Доступ на ${plan.days} дней откроется сразу после оплаты.` : 'Доступ навсегда откроется сразу после оплаты.',
      'Ссылка действует 30 минут.',
      ...(origin ? ['', `Оплачивая, вы принимаете <a href="${origin}/terms">пользовательское соглашение</a> и <a href="${origin}/privacy">политику конфиденциальности</a>.`] : []),
    ].join('\n'),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: `💳 Оплатить ${rub(plan.rub)}`, url: payUrl }]] },
  });
}

// ---------- Вебхук ----------
export async function handleWebhook(request, env, origin) {
  const raw = await request.text();
  const ts = request.headers.get('X-Timestamp') || '';
  const sig = (request.headers.get('X-Signature') || '').toLowerCase();
  if (!env.ROLLYPAY_SIGNING_SECRET || !sig || !safeEqual(await hmacHex(env.ROLLYPAY_SIGNING_SECRET, `${ts}.${raw}`), sig)) {
    return new Response('invalid signature', { status: 403 });
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  // Тестовые платежи в боевом режиме доступа не дают.
  if (ev.test && !testMode(env)) return new Response('ok');

  const row = await env.DB.prepare('SELECT * FROM rub_payments WHERE payment_id = ? OR order_id = ?')
    .bind(ev.payment_id || '', ev.order_id || '').first();
  if (!row) {
    console.error('rollypay: неизвестный платёж', ev.payment_id, ev.order_id);
    return new Response('ok');
  }
  const status = String(ev.status || '');
  await env.DB.prepare('UPDATE rub_payments SET status = ?, updated_at = ? WHERE payment_id = ?').bind(status, now(), row.payment_id).run();

  if (status === 'paid') await applyPaid(env, row, ev, origin);
  else if (status === 'refunded' || status === 'chargeback') await revokePaid(env, row, status);
  return new Response('ok');
}

async function applyPaid(env, row, ev, origin) {
  const plan = planById(row.plan);
  if (!plan || String(ev.amount) !== plan.rub.toFixed(2) || (ev.currency && ev.currency !== 'RUB')) {
    console.error('rollypay: сумма не совпадает с тарифом', row.payment_id, ev.amount, ev.currency);
    return;
  }
  // Двойная проверка у RollyPay, что платёж действительно оплачен.
  const p = await api(env, 'GET', `/payments/${encodeURIComponent(row.payment_id)}`).catch(() => null);
  if (!p || p.status !== 'paid') return;

  // Замок от повторной доставки: доступ выдаётся ровно один раз на payment_id.
  const lock = await env.DB.prepare('UPDATE rub_payments SET applied = 1, paid_at = ? WHERE payment_id = ? AND applied = 0')
    .bind(now(), row.payment_id).run();
  if (!lock.meta.changes) return;

  const sub = await getSubscription(env, row.user_id);
  // Остаток пробного периода не переносим, оплаченные и бонусные дни — переносим.
  const base = Math.max(now(), sub && sub.charge_id !== 'trial' ? sub.until : 0);
  const until = plan.days ? (isLifetime(base) ? base : base + plan.days * DAY) : LIFETIME_UNTIL;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (user_id, until, charge_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, charge_id = excluded.charge_id, updated_at = excluded.updated_at`,
    ).bind(row.user_id, until, `rub:${row.payment_id}`, now()),
    env.DB.prepare('UPDATE rub_payments SET until_before = ?, until_after = ? WHERE payment_id = ?').bind(base, until, row.payment_id),
  ]);

  const keyboard = origin ? { inline_keyboard: [[{ text: '🏒 Открыть HUT Builder', web_app: { url: `${origin}/` } }]] } : undefined;
  await bot(env, 'sendMessage', {
    chat_id: row.user_id, parse_mode: 'HTML', reply_markup: keyboard,
    text: `✅ Оплата получена: <b>${plan.title}</b> — ${rub(plan.rub)}.\nДоступ открыт ${isLifetime(until) ? '<b>навсегда</b> 👑' : `до <b>${date(until)}</b>`}. Спасибо!`,
  }).catch(() => {});

  const first = await env.DB.prepare("SELECT COUNT(*) AS n FROM rub_payments WHERE user_id = ? AND applied = 1").bind(row.user_id).first();
  if (first.n === 1) {
    const reward = await rewardReferrer(env, row.user_id);
    if (reward) {
      await bot(env, 'sendMessage', {
        chat_id: reward.referrer, parse_mode: 'HTML', reply_markup: keyboard,
        text: `🎉 Ваш друг оформил подписку — вам добавлено <b>${reward.days} дней</b>. Доступ до ${date(reward.until)}.`,
      }).catch(() => {});
    }
  }
}

// Возврат или чарджбек: забираем ровно то, что выдал этот платёж.
async function revokePaid(env, row, status) {
  const lock = await env.DB.prepare('UPDATE rub_payments SET applied = 0 WHERE payment_id = ? AND applied = 1').bind(row.payment_id).run();
  if (!lock.meta.changes) return;
  const fresh = await env.DB.prepare('SELECT until_before, until_after FROM rub_payments WHERE payment_id = ?').bind(row.payment_id).first();
  const sub = await getSubscription(env, row.user_id);
  if (!sub || !fresh?.until_after) return;
  const t = now();
  const until = sub.until === fresh.until_after
    ? Math.max(t, fresh.until_before)
    : Math.max(t, sub.until - (fresh.until_after - fresh.until_before));
  await env.DB.prepare('UPDATE subscriptions SET until = ?, updated_at = ? WHERE user_id = ?').bind(until, t, row.user_id).run();
  await bot(env, 'sendMessage', {
    chat_id: row.user_id,
    text: status === 'refunded'
      ? 'Платёж за HUT Builder возвращён, доступ по нему закрыт.'
      : 'Банк отозвал платёж за HUT Builder, доступ по нему закрыт. Вопросы — /paysupport.',
  }).catch(() => {});
}
