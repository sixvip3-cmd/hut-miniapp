// HUT Builder — Cloudflare Worker.
//
// Приложение открывается только внутри Telegram и только с доступом (подписка за звёзды,
// пробный период или бонусные дни):
//   GET  /                     — загрузчик: «только в Telegram», экран оплаты и пробного периода
//   POST /api/session          — проверка подписи Telegram (initData) и доступа;
//                                есть доступ → ссылка /s/<токен>/, нет → счёт в звёздах
//   POST /api/trial            — включить пробный период (один раз на аккаунт)
//   GET  /s/<токен>/...        — приложение и данные (только по действующему токену)
//   GET  /s/<токен>/api/me     — подписка и реферальная ссылка для приложения
//   POST /s/<токен>/api/share  — картинка состава → готовое сообщение для пересылки
//   POST /telegram/webhook     — апдейты бота (worker/src/bot.js)
//   POST /admin/setup          — вебхук, кнопка меню, команды (ключ из токена бота)
//   cron каждые 30 минут       — напоминания и дайджест (worker/src/cron.js)
//   cron каждую минуту         — очередная пачка рассылки /broadcast (worker/src/broadcast.js)

import { bot, derivedSecret, signSession, validateInitData, verifySession } from './telegram.js';
import { loaderPage } from './loader.js';
import { BOT_COMMANDS, botUsername, handleUpdate, refLink } from './bot.js';
import { runScheduled, saveOrigin } from './cron.js';
import { processBroadcasts } from './broadcast.js';
import {
  hasAccess, now, price, referralStats, refBonusDays, SUB_PERIOD, startTrial, touchUser, trialAvailable, trialDays,
} from './db.js';

const SESSION_TTL = 12 * 3600;
const MAX_SHARE_BYTES = 8 * 1024 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

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

async function sessionResponse(env, userId, access) {
  const exp = Math.min(now() + SESSION_TTL, access.until);
  const token = await signSession(env, { uid: userId, exp });
  return json({ ok: true, url: `/s/${token}/`, until: access.until, trial: !!access.trial });
}

// ---------- Загрузчик ----------
async function handleSession(request, env) {
  const { initData } = await request.json().catch(() => ({}));
  const user = await validateInitData(initData, env);
  if (!user) return json({ error: 'not_telegram' }, 401);
  await touchUser(env, user);

  const access = await hasAccess(env, user.id);
  if (access) return sessionResponse(env, user.id, access);
  const [invoice, trial] = await Promise.all([
    bot(env, 'createInvoiceLink', invoiceParams(env, user.id)),
    trialAvailable(env, user.id),
  ]);
  return json({ ok: false, invoice, price: price(env), trial, trialDays: trialDays(env) });
}

async function handleTrial(request, env) {
  const { initData } = await request.json().catch(() => ({}));
  const user = await validateInitData(initData, env);
  if (!user) return json({ error: 'not_telegram' }, 401);
  const until = await startTrial(env, user.id);
  if (!until) return json({ error: 'trial_used' }, 409);
  return sessionResponse(env, user.id, { until, trial: true });
}

// ---------- Приложение по токену ----------
async function handleApp(request, env, url) {
  const m = url.pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
  const session = m && (await verifySession(env, m[1]));
  if (!session) {
    return m?.[2]?.startsWith('/api/') ? json({ error: 'session_expired' }, 401) : Response.redirect(`${url.origin}/`, 302);
  }
  if (!m[2]) return Response.redirect(`${url.origin}/s/${m[1]}/${url.search}`, 302);
  if (m[2] === '/api/me') return handleMe(env, session.uid);
  if (m[2] === '/api/share' && request.method === 'POST') return handleShare(request, env, session.uid, url.origin);

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

async function handleMe(env, uid) {
  const [access, refs, link] = await Promise.all([hasAccess(env, uid), referralStats(env, uid), refLink(env, uid)]);
  return json({
    until: access?.until || 0,
    trial: !!access?.trial,
    admin: !!access?.admin,
    price: price(env),
    refLink: link,
    refBonusDays: refBonusDays(env),
    invited: refs?.invited || 0,
    paidInvites: refs?.paid || 0,
  });
}

// Картинка состава: отправляем её пользователю в чат с ботом (копия остаётся у него)
// и готовим сообщение, которое приложение откроет в окне «Поделиться» (Bot API 8.0+).
async function handleShare(request, env, uid, origin) {
  const form = await request.formData().catch(() => null);
  const photo = form?.get('photo');
  if (!photo || typeof photo === 'string' || photo.size > MAX_SHARE_BYTES) return json({ error: 'bad_image' }, 400);
  const summary = String(form.get('summary') || '').slice(0, 300);
  const username = await botUsername(env);
  const caption = `${summary}\n\nСобери свой состав в @${username}`.trim();
  const markup = { inline_keyboard: [[{ text: '🏒 Собрать свой состав', url: `https://t.me/${username}?start=share` }]] };

  const tgForm = new FormData();
  tgForm.append('chat_id', String(uid));
  tgForm.append('photo', photo, 'lineup.png');
  tgForm.append('caption', caption);
  tgForm.append('reply_markup', JSON.stringify(markup));
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const sent = await (await fetch(`${base}/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: tgForm })).json();
  if (!sent.ok) return json({ error: 'send_failed', message: sent.description }, 502);

  const fileId = sent.result.photo.at(-1).file_id;
  let preparedId = null;
  try {
    const prepared = await bot(env, 'savePreparedInlineMessage', {
      user_id: uid,
      result: { type: 'photo', id: `lineup-${uid}-${now()}`, photo_file_id: fileId, caption, reply_markup: markup },
      allow_user_chats: true, allow_bot_chats: true, allow_group_chats: true, allow_channel_chats: true,
    });
    preparedId = prepared.id;
  } catch (err) {
    console.error('savePreparedInlineMessage', err.message);
  }
  return json({ ok: true, preparedId, origin });
}

// ---------- Настройка бота ----------
async function handleSetup(env, origin) {
  await saveOrigin(env, origin);
  await bot(env, 'setWebhook', {
    url: `${origin}/telegram/webhook`,
    secret_token: await derivedSecret(env, 'webhook'),
    allowed_updates: ['message', 'pre_checkout_query', 'inline_query', 'callback_query'],
    drop_pending_updates: false,
  });
  await bot(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'HUT Builder', web_app: { url: `${origin}/` } } });
  await bot(env, 'setMyCommands', { commands: BOT_COMMANDS });
  await bot(env, 'setMyShortDescription', {
    short_description: 'Конструктор состава NHL HUT: line combos, капитаны, тренеры и цены маркета. Подписка за ⭐',
  }).catch(() => {});
  const me = await bot(env, 'getMe');
  return json({ ok: true, bot: me.username, inline: !!me.supports_inline_queries, app: `${origin}/` });
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
      if (pathname === '/api/trial' && request.method === 'POST') return handleTrial(request, env);
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

  async scheduled(event, env, ctx) {
    // раз в минуту — очередная пачка рассылки, раз в 30 минут — напоминания и дайджест
    ctx.waitUntil(event.cron === '*/30 * * * *' ? runScheduled(env) : processBroadcasts(env));
  },
};
