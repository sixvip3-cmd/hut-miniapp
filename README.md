# HUT Builder — Telegram Mini App

Сборщик состава NHL HUT с настоящими line combos (Salary / OVR / AP) и маркет с ценами.
Все данные — с [hutdb.app](https://www.hutdb.app): игроки, цены маркета (их вносит сообщество hutdb) и комбинации.

## Как устроено
- `public/` — само приложение (HTML/CSS/JS, без сборки).
- `data/players.json`, `data/prices.json`, `data/combos.json`, `data/captains.json` — данные hutdb (картинки карточек грузятся из хранилища hutdb).
- `scripts/sync-hutdb.js` открывает hutdb.app/chemistry в headless-браузере и сохраняет данные, которые страница загружает сама.
- `.github/workflows/pages.yml` — каждый час синхронизирует данные и публикует сайт на GitHub Pages.

## GitHub Pages
1. Settings → Pages → Source: **GitHub Actions**.
2. Actions → «Deploy & sync hutdb» → Run workflow.
3. Адрес: `https://<user>.github.io/hut-miniapp/`.

## Telegram
1. @BotFather → `/newbot`.
2. `/mybots` → бот → Bot Settings → Menu Button → Configure → ссылка на Pages.

## Локально
```bash
npm install && npx playwright install chromium
npm run sync     # скачать свежие данные
npm start        # http://localhost:3000, синк раз в час
```
