# HUT Builder — Telegram Mini App

Сборщик состава NHL HUT: line combos (Salary / OVR / AP), капитаны, тренеры, маркет с ценами.
Данные (игроки, цены, комбинации, капитаны, тренеры) берутся с [hutdb.app](https://www.hutdb.app) и обновляются каждый час.

**Открывается только внутри Telegram и только с подпиской за Telegram Stars** (30 дней, автопродление).

## Бот

- `/start` — приветствие, пробный период (3 дня, один раз), кнопка «Пригласить друга»
- `/status`, `/invite` (реферальная ссылка: +7 дней за друга, оформившего подписку), `/digest`, `/help`, `/terms`, `/paysupport`
- админам (`ADMIN_IDS`, свои команды видны только им в меню): `/users` — все пользователи (фильтры, листание, поиск: `/users имя`), `/user <id | @username>` — профиль (доступ, оплаты, рефералы, активность, кнопки «+3/7/30 дней»), `/stats`, `/refund <user_id>`, `/gift <user_id> <дней>`, `/broadcast` — рассылка всем (ответом на сообщение; предпросмотр и подтверждение; по 40 сообщений в минуту; `/broadcast status`)
- инлайн-режим: `@бот имя игрока` в любом чате — карточка с ценой (включить в @BotFather → `/setinline`)
- по расписанию (каждые 30 мин): напоминание за сутки до конца доступа, сообщение об окончании, ежедневный дайджест в 10:00 МСК
- в приложении: «Поделиться составом» (картинка состава → окно пересылки Telegram) и «Пригласить друга»

Настройки в `wrangler.toml` / Variables: `PRICE_STARS`, `TRIAL_DAYS`, `REF_BONUS_DAYS`, `ADMIN_IDS`, `SUPPORT_CONTACT`, `BOT_USERNAME`.

## Как устроено

```
Telegram ──▶ Cloudflare Worker (worker/src)
              GET  /               загрузчик: «только в Telegram» / экран оплаты ⭐
              POST /api/session    проверка подписи Telegram (initData) + подписки в D1
                                   → ссылка /s/<токен>/ или счёт createInvoiceLink (XTR)
              GET  /s/<токен>/…    приложение и данные — только по действующему токену
              POST /telegram/webhook  pre_checkout_query, successful_payment, возвраты,
                                      /start /status /paysupport /refund
```

- `public/` — приложение (HTML/CSS/JS без сборки).
- `data/` — данные hutdb: `players.json`, `prices.json`, `combos.json`, `captains.json`, `coaches.json`.
- `scripts/sync-hutdb.js` открывает hutdb.app/squad-builder в headless-браузере и сохраняет данные, которые страница загружает сама.
- `scripts/sync-fantasy.js` — вкладка Fantasy: голы игроков карточек Fantasy Hockey в реальных матчах НХЛ (api-web.nhle.com), следующий матч, история OVR → `data/fantasy.json`.
- `scripts/build-site.js` собирает `_site/` (приложение + данные + версия против кэша Telegram).
- `worker/` — сервер: доступ, оплата, бот. `worker/schema.sql` — таблицы D1.
- `.github/workflows/deploy.yml` — каждый час: синк hutdb → сборка → деплой воркера.

## Подключение (один раз)

1. **Cloudflare:** бесплатный аккаунт → *My Profile → API Tokens → Create Token → шаблон «Edit Cloudflare Workers»*, добавить право *D1: Edit*. Скопировать токен и *Account ID* (справа на странице *Workers & Pages*).
2. **GitHub → Settings → Secrets and variables → Actions:**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BOT_TOKEN` (от @BotFather).
   - Variables (по желанию): `PRICE_STARS` (по умолчанию 150), `ADMIN_IDS` (ваш Telegram id — бесплатный доступ и `/refund`), `SUPPORT_CONTACT` (для `/paysupport`), `BOT_USERNAME`.
3. **Actions → Deploy & sync hutdb → Run workflow.** Workflow создаст базу, задеплоит воркер, задаст токен бота и сам настроит вебхук, кнопку меню и команды. Адрес мини-аппа будет в логе шага *Configure bot*.
4. (Рекомендуется) В @BotFather → `/newapp` указать этот же адрес — получится ссылка `t.me/<бот>/<app>`.

## Локально

```bash
npm install
cp .dev.vars.example .dev.vars   # BOT_TOKEN и др.
npx wrangler d1 execute hut-builder --local --file worker/schema.sql
npm run dev                      # http://127.0.0.1:8787
npm run sync                     # свежие данные с hutdb (нужен Chrome/Chromium)
```
