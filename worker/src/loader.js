// Страница-загрузчик: проверяет, что открыто в Telegram, и показывает тарифы (оплата в рублях через RollyPay).
// Само приложение отдаётся только после того, как сервер получил подтверждение оплаты.

// Логотип встроен в страницу: файлы приложения отдаются только после входа.
// У каждой копии свои id градиентов — иначе копии в скрытых блоках не рисуются.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="72" height="72"><defs><linearGradient id="lg-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d8bff"/><stop offset=".55" stop-color="#1546c4"/><stop offset="1" stop-color="#081e63"/></linearGradient><linearGradient id="lg-ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".65" stop-color="#e6f6ff"/><stop offset="1" stop-color="#a7dbff"/></linearGradient><linearGradient id="lg-sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".75" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="lg-ds" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.5" flood-color="#010c33" flood-opacity=".6"/></filter></defs><rect width="72" height="72" rx="16" fill="url(#lg-bg)"/>
<g filter="url(#lg-ds)">
<g fill="url(#lg-ice)">
<g transform="rotate(-38 32 32)"><rect x="30.2" y="4" width="3.6" height="44" rx="1.6"/><rect x="29.6" y="3.4" width="4.8" height="5.6" rx="1.8" fill="#0a2470" stroke="url(#lg-ice)" stroke-width="1"/><path d="M30.2 46h3.6v1.6c0 2.4 1.2 3.4 3.4 3.4h7.2c1.9 0 2.2 2.5.3 2.9l-8.6 1.6c-3.9.7-5.9-1.6-5.9-5.4z"/></g>
<g transform="rotate(38 32 32)"><rect x="30.2" y="4" width="3.6" height="44" rx="1.6"/><rect x="29.6" y="3.4" width="4.8" height="5.6" rx="1.8" fill="#0a2470" stroke="url(#lg-ice)" stroke-width="1"/><path d="M33.8 46h-3.6v1.6c0 2.4-1.2 3.4-3.4 3.4h-7.2c-1.9 0-2.2 2.5-.3 2.9l8.6 1.6c3.9.7 5.9-1.6 5.9-5.4z"/></g>
</g>
<path d="M32 13l13 4.5v11.5c0 8.8-5.6 15-13 18-7.4-3-13-9.2-13-18V17.5z" fill="#0a2470" stroke="url(#lg-ice)" stroke-width="2.4" stroke-linejoin="round"/>
<g fill="url(#lg-ice)"><rect x="25" y="20" width="4.4" height="17" rx="1.2"/><rect x="34.6" y="20" width="4.4" height="17" rx="1.2"/><rect x="28" y="26.6" width="8" height="3.8" rx="1"/></g></g>
<path d="M3 16C3 8 8 3 16 3H48C56 3 61 8 61 16V26C44 33 20 33 3 26Z" fill="url(#lg-sh)"/><rect x=".75" y=".75" width="62.5" height="62.5" rx="15.3" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.5"/></svg>`;
let logoN = 0;
const logo = () => LOGO_SVG.replaceAll('lg-', `lg${++logoN}-`);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function loaderPage(env) {
  const botLink = env.BOT_USERNAME ? `https://t.me/${esc(env.BOT_USERNAME.replace(/^@/, ''))}` : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#030a1c">
<title>HUT Builder</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@500;600;700&display=swap">
<style>
  :root { --bg:#030a1c; --text:#f3f8ff; --muted:#9db1d1; --gold:#9ad9ff; --green:#4ade80; --red:#f87171; --ink:#04132f;
    --gold-grad:linear-gradient(180deg,rgba(255,255,255,.75) 0%,rgba(255,255,255,0) 52%),linear-gradient(135deg,#e8f7ff 0%,#9ad9ff 45%,#4f8dff 100%);
    --glass:linear-gradient(180deg,rgba(255,255,255,.13),rgba(255,255,255,.04)); --display:"Oswald","Inter",sans-serif; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; min-height:100%; }
  body { color:var(--text); font:15px/1.45 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased;
    background:radial-gradient(90% 55% at 15% -5%,rgba(92,184,255,.3),transparent 60%),radial-gradient(70% 45% at 100% 40%,rgba(59,130,246,.22),transparent 65%),
      linear-gradient(180deg,#051231 0%,#030a1c 60%,#020716 100%); background-attachment:fixed; min-height:100vh;
    display:flex; align-items:center; justify-content:center; padding:24px 18px calc(24px + env(safe-area-inset-bottom)); }
  .wrap { width:100%; max-width:420px; text-align:center; }
  .mark { width:72px; height:72px; margin:0 auto 18px; border-radius:18px; display:grid; place-items:center; box-shadow:0 14px 40px -10px rgba(59,130,246,.9); }
  .mark svg { display:block; }
  .pulse { animation:pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { transform:scale(.94); } }
  h1 { margin:0 0 6px; font:600 28px/1.1 var(--display); letter-spacing:2px; text-transform:uppercase; }
  h1 span { background:linear-gradient(135deg,#fff,#9ad9ff 55%,#4f8dff); -webkit-background-clip:text; background-clip:text; color:transparent; }
  p { margin:0 0 18px; color:var(--muted); }
  .card { text-align:left; padding:18px; border-radius:22px; margin:18px 0; background:var(--glass); border:1px solid rgba(255,255,255,.2);
    backdrop-filter:blur(22px) saturate(180%); -webkit-backdrop-filter:blur(22px) saturate(180%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.38),0 18px 40px -18px rgba(0,8,32,.85); }
  .price { display:flex; align-items:baseline; gap:8px; margin-bottom:14px; }
  .price b { font:600 40px/1 var(--display); background:linear-gradient(135deg,#fff,#9ad9ff); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .price span { color:var(--muted); }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  li { display:flex; gap:10px; align-items:flex-start; font-size:14px; }
  li::before { content:"✓"; color:var(--gold); font-weight:700; }
  .btn { display:block; width:100%; border:0; cursor:pointer; padding:17px; border-radius:16px; background:var(--gold-grad); color:var(--ink);
    font:600 17px/1 var(--display); letter-spacing:1.5px; text-transform:uppercase; text-decoration:none; border-radius:18px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.9),inset 0 -2px 6px rgba(29,78,216,.35),0 12px 30px -10px rgba(59,130,246,.9); }
  .btn:active { transform:scale(.98); }
  .btn[disabled] { opacity:.6; }
  .note { font-size:12px; color:var(--muted); margin-top:12px; }
  .plans { display:grid; gap:8px; margin:0 0 14px; }
  .plan { position:relative; display:flex; align-items:center; gap:12px; width:100%; padding:13px 14px; text-align:left; cursor:pointer;
    border-radius:18px; border:1.5px solid rgba(255,255,255,.16); background:var(--glass); color:var(--text); font:inherit;
    backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); box-shadow:inset 0 1px 0 rgba(255,255,255,.25); }
  .plan.on { border-color:rgba(154,217,255,.8); background:linear-gradient(180deg,rgba(154,217,255,.26),rgba(255,255,255,.05)); box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 10px 24px -12px rgba(59,130,246,.9); }
  .plan i { width:18px; height:18px; flex-shrink:0; border-radius:50%; border:2px solid rgba(255,255,255,.3); }
  .plan.on i { border:5px solid var(--gold); }
  .plan span { flex:1; } .plan span b { display:block; font:600 17px/1.2 var(--display); letter-spacing:.6px; }
  .plan span small { color:var(--muted); font-size:12px; }
  .plan em { font:600 20px/1 var(--display); font-style:normal; color:#e4f5ff; white-space:nowrap; }
  .plan .hit { position:absolute; top:-8px; right:12px; padding:3px 8px; border-radius:999px; background:linear-gradient(135deg,#ff6b6b,#e11d48); color:#fff; font:600 10px/1 var(--display); letter-spacing:1px; }
  .ghost { margin-top:10px; background:transparent !important; color:var(--muted) !important; border:1px solid rgba(255,255,255,.12) !important; box-shadow:none !important; }
  .bar { width:150px; height:3px; margin:6px auto 14px; border-radius:3px; background:rgba(255,255,255,.08); overflow:hidden; }
  .bar i { display:block; width:40%; height:100%; background:var(--gold-grad); animation:slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
  .err { color:var(--red); }
  .legal a { color:var(--gold); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<div class="wrap">
  <section id="s-loading">
    <div class="mark pulse">${logo()}</div>
    <div class="bar"><i></i></div>
    <p id="loading-text">Проверяем доступ…</p>
  </section>

  <section id="s-outside" hidden>
    <div class="mark">${logo()}</div>
    <h1>HUT <span>Builder</span></h1>
    <p>Приложение работает только внутри Telegram.</p>
    ${botLink ? `<a class="btn" href="${botLink}">Открыть в Telegram</a>` : ''}
  </section>

  <section id="s-pay" hidden>
    <div class="mark">${logo()}</div>
    <h1>HUT <span>Builder</span></h1>
    <p>Конструктор состава NHL HUT</p>
    <div class="card">
      <ul>
        <li>Все 8000+ карточек с картинками и ценами маркета</li>
        <li>Настоящие line combos: OVR, Salary, AP</li>
        <li>Капитаны и тренеры с подсчётом бонусов</li>
        <li>Лучшие тройки и пары в 1 тап</li>
        <li>Fantasy: кто забил в НХЛ · цены маркета каждый час</li>
      </ul>
    </div>
    <div class="plans" id="plans"></div>
    <button class="btn" id="trial" hidden></button>
    <button class="btn" id="pay" hidden></button>
    <div class="note" id="pay-note">Оплата в рублях: СБП или банковская карта. Без автопродления — платите только за выбранный срок.</div>
    <div class="note legal">Нажимая «Оплатить», вы принимаете <a href="/terms" data-doc>пользовательское соглашение</a> и <a href="/privacy" data-doc>политику конфиденциальности</a>. Поддержка: <a href="/support" data-doc>контакты</a>.</div>
    <div class="note err" id="pay-error" hidden></div>
  </section>

  <section id="s-wait" hidden>
    <div class="mark pulse">${logo()}</div>
    <h1>Ждём <span>оплату</span></h1>
    <p>Оплатите на открывшейся странице — ссылка также пришла в чат с ботом. Доступ откроется здесь автоматически.</p>
    <div class="bar"><i></i></div>
    <button class="btn" id="check">Я оплатил — проверить</button>
    <button class="btn ghost" id="back">Выбрать другой тариф</button>
    <div class="note err" id="wait-error" hidden></div>
  </section>
</div>
<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var show = function (id) {
    ['s-loading', 's-outside', 's-pay', 's-wait'].forEach(function (s) { document.getElementById(s).hidden = s !== id; });
  };
  var $ = function (id) { return document.getElementById(id); };
  var plans = [], selected = 'y1', payUrl = null, polling = 0;
  var rub = function (n) { return n.toLocaleString('ru-RU') + ' ₽'; };

  if (!tg || !tg.initData) { show('s-outside'); return; }
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#030a1c'); tg.setBackgroundColor('#030a1c'); } catch (e) {}

  function post(path, body) {
    body = body || {}; body.initData = tg.initData;
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function enter(res) { location.replace(res.url + location.hash); }
  function fail(id, text) { var el = $(id); el.textContent = text; el.hidden = !text; }

  function renderPlans() {
    $('plans').innerHTML = plans.map(function (p) {
      return '<button class="plan' + (p.id === selected ? ' on' : '') + '" data-plan="' + p.id + '">' +
        (p.hit ? '<span class="hit">ВЫГОДНО</span>' : '') + '<i></i><span><b>' + p.title + '</b>' +
        (p.note ? '<small>' + p.note + '</small>' : '') + '</span><em>' + rub(p.rub) + '</em></button>';
    }).join('');
    var p = plans.find(function (x) { return x.id === selected; });
    $('pay').textContent = 'Оплатить ' + rub(p.rub);
  }
  $('plans').addEventListener('click', function (e) {
    var b = e.target.closest('[data-plan]');
    if (!b) return;
    selected = b.getAttribute('data-plan'); renderPlans();
    try { tg.HapticFeedback.selectionChanged(); } catch (err) {}
  });

  // Ждём подтверждение оплаты: опрашиваем сервер каждые 3 секунды до 15 минут.
  function poll(n) {
    var id = ++polling;
    (function tick(i) {
      if (id !== polling) return;
      post('/api/session').then(function (res) {
        if (res.ok) return enter(res);
        if (i < 300) setTimeout(function () { tick(i + 1); }, 3000);
      }).catch(function () { setTimeout(function () { tick(i + 1); }, 4000); });
    })(n || 0);
  }

  $('pay').addEventListener('click', function () {
    var btn = this; btn.disabled = true; fail('pay-error', '');
    post('/api/pay', { plan: selected }).then(function (res) {
      btn.disabled = false;
      if (!res.ok) return fail('pay-error', res.error === 'pay_disabled' ? 'Оплата временно недоступна.' : 'Не удалось создать платёж. Попробуйте ещё раз.');
      payUrl = res.url;
      tg.openLink(payUrl);
      show('s-wait'); poll(0);
    }).catch(function () { btn.disabled = false; fail('pay-error', 'Нет связи с сервером. Попробуйте ещё раз.'); });
  });

  $('check').addEventListener('click', function () {
    fail('wait-error', '');
    post('/api/session').then(function (res) {
      if (res.ok) return enter(res);
      fail('wait-error', 'Оплата ещё не пришла. Обычно это занимает до минуты. Если деньги списались, а доступа нет — напишите боту /paysupport.');
    });
  });
  $('back').addEventListener('click', function () { polling++; show('s-pay'); });
  // Документы открываем во внешнем браузере, чтобы не уходить из мини-аппа.
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-doc]');
    if (!a) return;
    e.preventDefault(); tg.openLink(location.origin + a.getAttribute('href'));
  });

  $('trial').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    post('/api/trial').then(function (res) {
      if (res.ok) return enter(res);
      btn.hidden = true;
      fail('pay-error', 'Пробный период уже использован.');
    }).catch(function () { btn.disabled = false; fail('pay-error', 'Нет связи с сервером. Попробуйте ещё раз.'); });
  });

  post('/api/session').then(function (res) {
    if (res.ok) return enter(res);
    if (res.error === 'not_telegram') return show('s-outside');
    plans = res.plans || [];
    if (res.trial) {
      $('trial').textContent = '🎁 ' + res.trialDays + ' дня бесплатно';
      $('trial').hidden = false;
      $('pay').className = 'btn ghost';
    }
    if (res.pay && plans.length) { renderPlans(); $('pay').hidden = false; }
    else {
      $('plans').hidden = true;
      $('pay-note').textContent = 'Оплата временно недоступна.' + (res.support ? ' Вопросы: ' + res.support : '');
    }
    show('s-pay');
  }).catch(function () {
    $('loading-text').textContent = 'Нет связи с сервером. Попробуйте позже.';
  });
})();
</script>
</body>
</html>`;
}
