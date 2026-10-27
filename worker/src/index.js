// HUT Builder — Cloudflare Worker.
//
// Приложение открывается только внутри Telegram и только с активной подпиской за звёзды:
//   GET  /                 — загрузчик: проверяет, что открыт в Telegram, и показывает оплату
//   POST /api/session      — проверяет подпись Telegram (initData) и подписку;
//                            есть подписка → ссылка /s/<токен>/, нет → счёт в звёздах
//   GET  /s/<токен>/...    — само приложение и данные (только по действующему токену)
//   POST /telegram/webhook — апдейты бота: оплата, /start, /paysupport, /status, /refund
//   POST /admin/setup      — настройка вебхука, кнопки меню и команд бота (ключ из токена бота)

import { bot, derivedSecret, signSession, validateInitData, verifySession } from './telegram.js';
import { loaderPage } from './loader.js';

const DAY = 24 * 3600;
const SUB_PERIOD = 30 * DAY; // Telegram допускает подписки только на 30 дней
const SESSION_TTL = 12 * 3600;

const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const price = env => Math.max(1, Number(env.PRICE_STARS) || 150);
const admins = env => String(env.ADMIN_IDS || '').split(/[\s,]+/).filter(Boolean).map(Number);
const isAdmin = (env, id) => admins(env).includes(Number(id));

// ---------- База (D1) ----------
async function getSubscription(env, userId) {
  return env.DB.prepare('SELECT user_id, until, charge_id FROM subscriptions WHERE user_id = ?').bind(userId).first();
}

async function hasAccess(env, userId) {
  if (isAdmin(env, userId)) return { until: now() + 365 * DAY, admin: true };
  const sub = await getSubscription(env, userId);
  return sub && sub.until > now() ? sub : null;
}

// Записывает платёж один раз (повторная доставка апдейта ничего не задвоит) и продлевает доступ.
async function recordPayment(env, userId, sp) {
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO payments (charge_id, user_id, amount, payload, is_recurring, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sp.telegram_payment_charge_id, userId, sp.total_amount, sp.invoice_payload, sp.is_recurring ? 1 : 0,
    sp.subscription_expiration_date || null, now()).run();
  if (!inserted.meta.changes) return null;

  const current = await getSubscription(env, userId);
  const base = Math.max(now(), current?.until || 0);
  const until = sp.subscription_expiration_date || base + SUB_PERIOD;
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, until, charge_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, charge_id = excluded.charge_id, updated_at = excluded.updated_at`,
  ).bind(userId, until, sp.telegram_payment_charge_id, now()).run();
  return until;
}

async function revokeByCharge(env, chargeId) {
  const p = await env.DB.prepare('SELECT user_id FROM payments WHERE charge_id = ?').bind(chargeId).first();
  if (!p) return null;
  await env.DB.prepare('UPDATE payments SET refunded = 1 WHERE charge_id = ?').bind(chargeId).run();
  await env.DB.prepare('UPDATE subscriptions SET until = ?, updated_at = ? WHERE user_id = ?').bind(now(), now(), p.user_id).run();
  return p.user_id;
}

// ---------- Счёт ----------
function invoiceParams(env, userId) {
  return {
    title: env.PRODUCT_TITLE || 'HUT Builder Premium',
    description: env.PRODUCT_DESCRIPTION || 'Доступ к HUT Builder на 30 дней: состав, сыгранность, капитаны, тренеры и маркет.',
    payload: `sub:${userId}`,
    currency: 'XTR',
    prices: [{ label: 'Подписка на 30 дней', amount: price(env) }],
    subscription_period: SUB_PERIOD,
  };
}

// ---------- /api/session ----------
async function handleSession(request, env) {
  const { initData } = await request.json().catch(() => ({}));
  const user = await validateInitData(initData, env);
  if (!user) return json({ error: 'not_telegram' }, 401);

  const access = await hasAccess(env, user.id);
  if (access) {
    const exp = Math.min(now() + SESSION_TTL, access.until);
    const token = await signSession(env, { uid: user.id, exp });
    return json({ ok: true, url: `/s/${token}/`, until: access.until });
  }
  const invoice = await bot(env, 'createInvoiceLink', invoiceParams(env, user.id));
  return json({ ok: false, invoice, price: price(env) });
}

// ---------- Приложение по токену ----------
async function handleApp(request, env, url) {
  const m = url.pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
  const session = m && (await verifySession(env, m[1]));
  if (!session) return Response.redirect(`${url.origin}/`, 302);
  if (!m[2]) return Response.redirect(`${url.origin}/s/${m[1]}/${url.search}`, 302);

  const assetUrl = new URL(m[2], url.origin); // '/' → index.html (так раздаёт ASSETS)
  assetUrl.search = url.search;
  const res = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', /\.(html|json)$/.test(assetUrl.pathname) || m[2] === '/' ? 'private, no-cache' : 'private, max-age=86400');
  headers.set('X-Robots-Tag', 'noindex');

  // В приложение передаём id пользователя сессии: оно сверит его с Telegram.
  if ((headers.get('Content-Type') || '').includes('text/html')) {
    return new HTMLRewriter()
      .on('head', { element: el => el.append(`<meta name="session-uid" content="${Number(session.uid)}">`, { html: true }) })
      .transform(new Response(res.body, { status: res.status, headers }));
  }
  return new Response(res.body, { status: res.status, headers });
}

// ---------- Бот ----------
async function handleUpdate(update, env, origin) {
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const ok = q.currency === 'XTR' && q.total_amount === price(env) && q.invoice_payload === `sub:${q.from.id}`;
    await bot(env, 'answerPreCheckoutQuery', ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'Счёт устарел. Откройте приложение заново и оплатите ещё раз.' });
    return;
  }

  const msg = update.message;
  if (!msg?.from) return;
  const chatId = msg.chat.id;
  const appButton = text => ({ inline_keyboard: [[{ text, web_app: { url: `${origin}/` } }]] });

  if (msg.successful_payment) {
    const until = await recordPayment(env, msg.from.id, msg.successful_payment);
    if (until) {
      const date = new Date(until * 1000).toLocaleDateString('ru-RU');
      await bot(env, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Оплата получена. Доступ открыт до ${date}.\nПодписка продлевается автоматически, отменить можно в настройках Telegram.`,
        reply_markup: appButton('Открыть HUT Builder'),
      });
    }
    return;
  }

  if (msg.refunded_payment) {
    await revokeByCharge(env, msg.refunded_payment.telegram_payment_charge_id);
    return;
  }

  const [cmd, ...args] = String(msg.text || '').trim().split(/\s+/);
  switch (cmd.replace(/@.*$/, '')) {
    case '/start':
      await bot(env, 'sendMessage', {
        chat_id: chatId,
        text: `🏒 HUT Builder — сборка состава, сыгранность, капитаны, тренеры и цены маркета.\n\nПодписка: ⭐ ${price(env)} на 30 дней.`,
        reply_markup: appButton('Открыть'),
      });
      break;
    case '/status': {
      const access = await hasAccess(env, msg.from.id);
      await bot(env, 'sendMessage', {
        chat_id: chatId,
        text: access
          ? `✅ Доступ активен до ${new Date(access.until * 1000).toLocaleDateString('ru-RU')}.`
          : `Подписки нет. Откройте приложение, чтобы оформить её за ⭐ ${price(env)}.`,
      });
      break;
    }
    case '/paysupport':
      await bot(env, 'sendMessage', {
        chat_id: chatId,
        text: `Вопросы по оплате: ${env.SUPPORT_CONTACT || 'напишите сюда, мы ответим'}.\nУкажите дату платежа — проверим и при необходимости вернём звёзды.`,
      });
      break;
    case '/refund': {
      // Только для администраторов: /refund <user_id> — вернуть последний платёж.
      if (!isAdmin(env, msg.from.id)) break;
      const userId = Number(args[0]);
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
          text = `Не удалось вернуть: ${err.message}`;
        }
      }
      await bot(env, 'sendMessage', { chat_id: chatId, text });
      break;
    }
  }
}

async function handleSetup(env, origin) {
  await bot(env, 'setWebhook', {
    url: `${origin}/telegram/webhook`,
    secret_token: await derivedSecret(env, 'webhook'),
    allowed_updates: ['message', 'pre_checkout_query'],
    drop_pending_updates: false,
  });
  await bot(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'HUT Builder', web_app: { url: `${origin}/` } } });
  await bot(env, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть HUT Builder' },
      { command: 'status', description: 'Статус подписки' },
      { command: 'paysupport', description: 'Помощь с оплатой' },
    ],
  });
  const me = await bot(env, 'getMe');
  return json({ ok: true, bot: me.username, app: `${origin}/` });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/' || pathname === '/index.html') {
        return new Response(loaderPage(env, price(env)), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
        });
      }
      if (pathname === '/api/session' && request.method === 'POST') return handleSession(request, env);
      if (pathname.startsWith('/s/')) return handleApp(request, env, url);

      if (pathname === '/telegram/webhook' && request.method === 'POST') {
        const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (secret !== (await derivedSecret(env, 'webhook'))) return new Response('forbidden', { status: 403 });
        await handleUpdate(await request.json(), env, url.origin);
        return new Response('ok');
      }
      if (pathname === '/admin/setup' && request.method === 'POST') {
        if (request.headers.get('X-Setup-Key') !== (await derivedSecret(env, 'setup'))) return new Response('forbidden', { status: 403 });
        return handleSetup(env, url.origin);
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error', message: err.message }, 500);
    }
  },
};
