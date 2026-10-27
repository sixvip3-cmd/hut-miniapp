// Страница-загрузчик: проверяет, что открыто в Telegram, и показывает оплату звёздами.
// Само приложение отдаётся только после того, как бот подтвердил оплату.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function loaderPage(env, price) {
  const botLink = env.BOT_USERNAME ? `https://t.me/${esc(env.BOT_USERNAME.replace(/^@/, ''))}` : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex">
<title>HUT Builder</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@500;600;700&display=swap">
<style>
  :root { --bg:#06080c; --text:#f4f1ea; --muted:#8d93a1; --gold:#e3bd6a; --green:#4ade80; --red:#f87171;
    --gold-grad:linear-gradient(135deg,#f6dc9a 0%,#e3bd6a 40%,#b8892b 100%); --display:"Oswald","Inter",sans-serif; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; min-height:100%; }
  body { color:var(--text); font:15px/1.45 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased;
    background:radial-gradient(120% 60% at 50% -10%,rgba(227,189,106,.18),transparent 60%),var(--bg); min-height:100vh;
    display:flex; align-items:center; justify-content:center; padding:24px 18px calc(24px + env(safe-area-inset-bottom)); }
  .wrap { width:100%; max-width:420px; text-align:center; }
  .mark { width:72px; height:72px; margin:0 auto 18px; border-radius:20px; display:grid; place-items:center;
    background:var(--gold-grad); color:#1a1205; font:700 30px/1 var(--display); box-shadow:0 14px 40px -10px rgba(227,189,106,.7); }
  .pulse { animation:pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { transform:scale(.94); } }
  h1 { margin:0 0 6px; font:600 28px/1.1 var(--display); letter-spacing:2px; text-transform:uppercase; }
  h1 span { color:var(--gold); }
  p { margin:0 0 18px; color:var(--muted); }
  .card { text-align:left; padding:18px; border-radius:18px; margin:18px 0;
    background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.08); }
  .price { display:flex; align-items:baseline; gap:8px; margin-bottom:14px; }
  .price b { font:600 40px/1 var(--display); background:var(--gold-grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .price span { color:var(--muted); }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  li { display:flex; gap:10px; align-items:flex-start; font-size:14px; }
  li::before { content:"✓"; color:var(--gold); font-weight:700; }
  .btn { display:block; width:100%; border:0; cursor:pointer; padding:17px; border-radius:16px; background:var(--gold-grad); color:#1a1205;
    font:600 17px/1 var(--display); letter-spacing:1.5px; text-transform:uppercase; text-decoration:none; box-shadow:0 12px 30px -10px rgba(227,189,106,.8); }
  .btn:active { transform:scale(.98); }
  .btn[disabled] { opacity:.6; }
  .note { font-size:12px; color:var(--muted); margin-top:12px; }
  .bar { width:150px; height:3px; margin:6px auto 14px; border-radius:3px; background:rgba(255,255,255,.08); overflow:hidden; }
  .bar i { display:block; width:40%; height:100%; background:var(--gold-grad); animation:slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
  .err { color:var(--red); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<div class="wrap">
  <section id="s-loading">
    <div class="mark pulse">H</div>
    <div class="bar"><i></i></div>
    <p id="loading-text">Проверяем доступ…</p>
  </section>

  <section id="s-outside" hidden>
    <div class="mark">H</div>
    <h1>HUT <span>Builder</span></h1>
    <p>Приложение работает только внутри Telegram.</p>
    ${botLink ? `<a class="btn" href="${botLink}">Открыть в Telegram</a>` : ''}
  </section>

  <section id="s-pay" hidden>
    <div class="mark">H</div>
    <h1>HUT <span>Builder</span></h1>
    <p>Конструктор состава NHL HUT</p>
    <div class="card">
      <div class="price"><b>⭐ ${price}</b><span>/ 30 дней</span></div>
      <ul>
        <li>Все 8000+ карточек с картинками и ценами маркета</li>
        <li>Настоящие line combos: OVR, Salary, AP</li>
        <li>Капитаны и тренеры с подсчётом бонусов</li>
        <li>Лучшие партнёры для каждого игрока</li>
        <li>Цены обновляются каждый час</li>
      </ul>
    </div>
    <button class="btn" id="pay">Оплатить ⭐ ${price}</button>
    <div class="note">Оплата звёздами Telegram. Подписка продлевается каждые 30 дней, отменить можно в настройках Telegram.</div>
    <div class="note err" id="pay-error" hidden></div>
  </section>
</div>
<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var show = function (id) {
    ['s-loading', 's-outside', 's-pay'].forEach(function (s) { document.getElementById(s).hidden = s !== id; });
  };
  var invoice = null;

  if (!tg || !tg.initData) { show('s-outside'); return; }
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#06080c'); tg.setBackgroundColor('#06080c'); } catch (e) {}

  function session() {
    return fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData })
    }).then(function (r) { return r.json(); });
  }

  function enter(res) {
    location.replace(res.url + location.hash);
  }

  // После оплаты ждём, пока бот получит подтверждение от Telegram и откроет доступ.
  function waitForPayment(attempt) {
    document.getElementById('loading-text').textContent = 'Бот проверяет оплату…';
    show('s-loading');
    session().then(function (res) {
      if (res.ok) return enter(res);
      if (attempt < 40) return setTimeout(function () { waitForPayment(attempt + 1); }, 1500);
      invoice = res.invoice || invoice;
      show('s-pay');
      fail('Оплата ещё не подтверждена. Если звёзды списались — напишите боту /paysupport.');
    }).catch(function () { setTimeout(function () { waitForPayment(attempt + 1); }, 2000); });
  }

  function fail(text) {
    var el = document.getElementById('pay-error');
    el.textContent = text; el.hidden = false;
  }

  document.getElementById('pay').addEventListener('click', function () {
    if (!invoice) return;
    document.getElementById('pay-error').hidden = true;
    tg.openInvoice(invoice, function (status) {
      if (status === 'paid') waitForPayment(0);
      else if (status === 'failed') fail('Оплата не прошла. Попробуйте ещё раз.');
    });
  });

  session().then(function (res) {
    if (res.ok) return enter(res);
    if (res.error === 'not_telegram') return show('s-outside');
    invoice = res.invoice;
    show('s-pay');
  }).catch(function () {
    document.getElementById('loading-text').textContent = 'Нет связи с сервером. Попробуйте позже.';
  });
})();
</script>
</body>
</html>`;
}
