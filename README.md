# HUT Builder — Telegram Mini App

Сборщик состава HUT (сыгранность Salary / OVR / AP) и маркет с ценами, которые обновляются каждый час.

## Хостинг на GitHub Pages
1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Каждый push в `main` деплоит сайт. Раз в час workflow `.github/workflows/pages.yml` обновляет `data/prices.json` и передеплоивает.
3. Адрес: `https://<user>.github.io/hut-miniapp/`.
4. Источник цен: **Settings → Secrets and variables → Actions → Variables → `PRICE_SOURCE_URL`** (JSON `{ "<id>": цена }`). Без него берётся поле `price` из `data/players.json`.

## Подключение к Telegram
1. @BotFather → `/newbot`.
2. `/mybots` → бот → Bot Settings → Menu Button → Configure → ссылка на Pages.
3. Опционально `/newapp` — прямая ссылка `t.me/<bot>/<app>`.

## Локальный запуск
```bash
node server.js   # http://localhost:3000, цены обновляются раз в час
```
Node 18+, зависимостей нет. С `BOT_TOKEN` и `WEBAPP_URL` сервер сам ставит кнопку меню бота.

## Данные
- `data/players.json` — игроки: `id, name, program, ovr, pos, alt[], salary, ap, team, nation, price`.
- `data/prices.json` — цены + история за 48 часов (`scripts/update-prices.js`).

## Сыгранность
Правила в `public/chemistry.js` (объект `CHEMISTRY`): OVR — по стране, SALARY — по команде, AP — по программе.
