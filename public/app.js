const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
try {
  if (tg?.isVersionAtLeast?.('6.1')) {
    tg.setHeaderColor('#06080c');
    tg.setBackgroundColor('#06080c');
  }
  if (tg?.isVersionAtLeast?.('7.10')) tg.setBottomBarColor('#06080c');
} catch {}

// Только внутри Telegram и только своей сессией: сервер подставляет id пользователя сессии,
// а мы сверяем его с пользователем Telegram. Иначе — обратно на загрузчик (проверка подписки).
const SESSION_UID = document.querySelector('meta[name="session-uid"]')?.content;
if (SESSION_UID && (!tg?.initData || String(tg.initDataUnsafe?.user?.id) !== SESSION_UID)) {
  location.replace('/');
}

// Защита от старой версии в кэше Telegram: если на сервере вышла новая — перезагружаемся.
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '';
async function ensureFreshVersion() {
  if (!APP_VERSION || APP_VERSION.startsWith('__')) return; // локальный запуск
  try {
    const { v } = await (await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    if (v && v !== APP_VERSION && sessionStorage.getItem('reloadedFor') !== v) {
      sessionStorage.setItem('reloadedFor', v);
      location.replace(`${location.pathname}?v=${v}${location.hash}`);
    }
  } catch {}
}
ensureFreshVersion();

const STORAGE_KEY = 'hut-lineup-v2';
const PRICE_REFRESH_MS = 60 * 60 * 1000;
const PAGE_SIZE = 60;
// Картинки отдаёт хранилище hutdb.app. Большие карточки — оригиналы 804×1128,
// миниатюры в списках — уменьшенные копии (те же, что на сайте hutdb, они уже в кэше).
const STORAGE = 'https://cfahmyecewzymggdoebn.supabase.co/storage/v1';
const ORIGINAL_BASE = `${STORAGE}/object/public/assets/`;
const THUMB_BASE = `${STORAGE}/render/image/public/assets/`;

const FLAGS = {
  CANADA: '🇨🇦', USA: '🇺🇸', SWEDEN: '🇸🇪', FINLAND: '🇫🇮', RUSSIA: '🇷🇺', CZECHIA: '🇨🇿', SLOVAKIA: '🇸🇰',
  GERMANY: '🇩🇪', SWITZERLAND: '🇨🇭', LATVIA: '🇱🇻', DENMARK: '🇩🇰', AUSTRIA: '🇦🇹', NORWAY: '🇳🇴',
  BELARUS: '🇧🇾', SLOVENIA: '🇸🇮', FRANCE: '🇫🇷', ITALY: '🇮🇹', KAZAKHSTAN: '🇰🇿', UKRAINE: '🇺🇦',
  POLAND: '🇵🇱', HUNGARY: '🇭🇺', JAPAN: '🇯🇵', 'GREAT BRITAIN': '🇬🇧', NETHERLANDS: '🇳🇱', AUSTRALIA: '🇦🇺',
};
const CARD_COLORS = {
  'ICONS': ['#6b5212', '#1a1406'],
  'ALUMNI': ['#5a4a2a', '#1c170e'],
  'BASE': ['#3a3f4a', '#16181d'],
  'ERAS: 2010S': ['#7a7f8a', '#24272e'],
  'CAPTAINS': ['#b3151d', '#3a0709'],
  'TEAM OF THE WEEK': ['#7a1fa3', '#25082f'],
  'SPOTLIGHT': ['#a3211b', '#2e0807'],
  'XP': ['#1d3fa8', '#0a1233'],
  'FOR THE CREST': ['#2f78c4', '#0e2340'],
  'FANTASY HOCKEY': ['#0f7a52', '#06261a'],
  'FRIGHT NIGHT': ['#d4580f', '#2a1003'],
  'LAUNCH POINT': ['#8a1f5c', '#1c0d1e'],
  'NEW WAVE': ['#0f8a8a', '#052626'],
  'CHEL WEEK': ['#2a8a2f', '#0a260c'],
  'TRANSACTIONS': ['#4a5a7a', '#141a26'],
};

const state = {
  players: [],
  byId: {},
  combos: [],
  prices: { prices: {}, updatedAt: null },
  lineup: {},
  captain: null,
  captains: [],
  coach: null,
  coaches: [],
  captainCards: [],
  chemType: 'SAL',
  pickerSlot: null,
  marketLimit: PAGE_SIZE,
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flag = n => FLAGS[String(n).toUpperCase()] || '🏳️';
const fmtPrice = v => (v ? `${v.toLocaleString('ru-RU')}c` : '—');
const haptic = type => {
  try { if (tg?.isVersionAtLeast?.('6.1')) tg.HapticFeedback.impactOccurred(type || 'light'); } catch {}
};
const priceOf = p => state.prices.prices[p.id]?.price || 0;
const surname = name => name.split(' ').slice(1).join(' ') || name;
const titleCase = s => s.toLowerCase().replace(/(^|[\s.-])\p{L}/gu, m => m.toUpperCase());
function imgUrl(p, thumb = false) {
  if (!p?.img) return null;
  const path = p.img.includes('/') ? p.img : `cards/${p.img}`;
  if (!thumb) return ORIGINAL_BASE + path;
  return `${THUMB_BASE}${path}${path.includes('?') ? '&' : '?'}resize=contain&width=200&quality=80`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 60) return `${Math.max(min, 1)} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 1800);
}

// ---------- Хранение состава ----------
// CloudStorage есть только внутри Telegram 6.9+, в браузере и старых клиентах он бросает исключение.
const hasCloud = () => !!(tg?.initData && tg.isVersionAtLeast?.('6.9') && tg.CloudStorage);

function saveLineup() {
  const data = JSON.stringify({ slots: state.lineup, captain: state.captain, coach: state.coach });
  try { localStorage.setItem(STORAGE_KEY, data); } catch {}
  if (hasCloud()) {
    try { tg.CloudStorage.setItem(STORAGE_KEY, data, () => {}); } catch {}
  }
}

function loadLineup() {
  return new Promise(resolve => {
    const fromLocal = () => {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
    };
    if (!hasCloud()) return resolve(fromLocal());
    // Если Telegram не ответил быстро — не ждём, берём локальную копию.
    const timer = setTimeout(() => resolve(fromLocal()), 1500);
    try {
      tg.CloudStorage.getItem(STORAGE_KEY, (err, value) => {
        clearTimeout(timer);
        if (err || !value) return resolve(fromLocal());
        try { resolve(JSON.parse(value)); } catch { resolve(fromLocal()); }
      });
    } catch {
      clearTimeout(timer);
      resolve(fromLocal());
    }
  });
}

// ---------- Позиции ----------
function slotAccepts(slot, p) {
  if (slot === 'STARTER' || slot === 'BACKUP') return p.pos === 'G';
  return p.pos === slot;
}
const slotOf = key => key.split('-')[1];
const inLineup = id => Object.values(state.lineup).includes(id);

// ---------- Карточка ----------
function cardStyle(p) {
  let colors = CARD_COLORS[p?.card?.toUpperCase()];
  if (!colors && p) {
    let h = 0;
    for (const ch of p.card) h = (h * 31 + ch.charCodeAt(0)) % 360;
    colors = [`hsl(${h} 45% 32%)`, `hsl(${h} 45% 10%)`];
  }
  const [c1, c2] = colors || ['#2a2f3a', '#14171d'];
  return `--c1:${c1};--c2:${c2}`;
}

// Картинка карточки поверх запасного варианта (если картинка не загрузится — останется плашка).
function cardImg(p, thumb = false) {
  const url = imgUrl(p, thumb);
  return url ? `<img class="card-img" src="${url}" alt="" loading="lazy" decoding="async" onload="this.classList.add('ok')" onerror="this.remove()">` : '';
}

function cardHtml(p, slot, badges = '') {
  if (!p) return `<div class="plus">+</div><div class="slot">${esc(slot)}</div>`;
  const off = slot && !slotAccepts(slot, p) ? '<span class="offpos">не своя</span>' : '';
  return `
    ${cardImg(p)}
    ${off}${badges}
    <div class="top">
      <div><div class="ovr">${p.ovr}</div><div class="pos">${esc(p.pos)}</div></div>
      <div class="flag">${flag(p.nation)}</div>
    </div>
    <div>
      <div class="cardtype">${esc(p.card)}</div>
      <div class="name">${esc(surname(p.name))}</div>
      <div class="meta"><span>$${p.salary.toFixed(1)}M</span></div>
    </div>`;
}

const reqLabel = r => (r.type === 'nation' ? `${flag(r.nation)} ${r.label}` : r.label);

// ---------- Вкладка «Команда» ----------
const RING = 2 * Math.PI * 44;

function renderSummary(sum) {
  $('#sum-ovr').textContent = sum.ovr || '—';
  // Кольцо OVR: шкала от 60 до 99, чтобы разница между составами была заметна.
  const k = sum.ovr ? Math.min(1, Math.max(0.04, (sum.ovr - 60) / 39)) : 0;
  $('#ovr-arc').style.strokeDashoffset = RING * (1 - k);

  const over = sum.salary > sum.salaryCap;
  $('#sum-salary').textContent = `$${sum.salary.toFixed(1)}M`;
  $('#sum-salary').classList.toggle('over', over);
  $('#sum-cap').textContent = `/ $${sum.salaryCap}M${sum.boost.SAL ? ` (+${sum.boost.SAL})` : ''}`;
  $('#bar-salary').classList.toggle('over', over);
  $('#bar-salary i').style.width = `${Math.min(100, (sum.salary / sum.salaryCap) * 100)}%`;

  $('#sum-ap').textContent = sum.boost.AP;
  $('#bar-ap i').style.width = `${Math.min(100, (sum.boost.AP / CHEMISTRY.maxAp) * 100)}%`;
}

function bonusChips(t) {
  return `
    <span class="chip ovr ${t.OVR ? 'on' : ''}">+${t.OVR} OVR</span>
    <span class="chip salary ${t.SAL ? 'on' : ''}">+$${t.SAL}M</span>
    <span class="chip ap ${t.AP ? 'on' : ''}">+${t.AP} AP</span>`;
}

function renderLineup(sum, cap) {
  $('#lineup').innerHTML = LINES.map(line => `
    <div class="line">
      <div class="line-head">
        <span class="line-title">${line.label}</span>
        <span class="chips">${bonusChips(sum.lines[line.id].total)}</span>
      </div>
      <div class="slots n${line.slots.length}">
        ${line.slots.map(slot => {
          const key = `${line.id}-${slot}`;
          const p = state.byId[state.lineup[key]];
          const isCap = p && p.id === state.captain;
          const mate = p && cap?.contributors.has(p.id);
          const badges = isCap ? '<span class="cap-badge">C</span>' : '';
          return `<button class="card ${p ? '' : 'empty'} ${mate ? 'capmate' : ''}" style="${cardStyle(p)}" data-slot="${key}">${cardHtml(p, slot, badges)}</button>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function boostText(type, v) {
  return type === 'SAL' ? `+$${v}M` : `+${v} ${type}`;
}

function renderChem(sum) {
  const type = state.chemType;
  const color = `var(--${CHEMISTRY.types[type].color})`;
  $('#chem-hint').textContent =
    'Комбинация срабатывает, когда каждое её требование закрыто отдельным игроком линии. Данные о комбинациях — hutdb.app.';

  $('#chem-lines').innerHTML = LINES.map(line => {
    const players = line.slots.map(s => state.byId[state.lineup[`${line.id}-${s}`]]).filter(Boolean);
    const chem = sum.lines[line.id];
    const active = chem.active.filter(a => a.combo.boost[type]);
    const activeHtml = active.map(a => `
      <div class="combo on">
        <span class="combo-boost" style="color:${color}">${boostText(type, a.combo.boost[type])}</span>
        <span class="reqs">${a.combo.reqs.map((r, i) => `<span class="req ok">${esc(reqLabel(r))}<small>${esc(surname(a.players[i].name))}</small></span>`).join('')}</span>
      </div>`).join('');
    const misses = players.length ? nearMisses(line, players, state.combos, type, 2) : [];
    const missHtml = misses.map(m => `
      <div class="combo">
        <span class="combo-boost">${boostText(type, m.combo.boost[type])}</span>
        <span class="reqs">${m.combo.reqs.map(r => `<span class="req ${r === m.missing ? 'need' : 'ok'}">${esc(reqLabel(r))}</span>`).join('')}</span>
      </div>`).join('');
    return `<div class="line">
      <div class="line-head">
        <span class="line-title">${line.label}</span>
        <span class="bonus-big ${chem.total[type] ? '' : 'zero'}" style="${chem.total[type] ? `color:${color}` : ''}">${boostText(type, chem.total[type])}</span>
      </div>
      ${players.length ? '' : '<p class="hint">Линия пустая</p>'}
      ${activeHtml}
      ${(state.coachState?.combos || []).filter(c => c.active && c.lineId === line.id && c.combo.boost[type]).map(c => `
        <div class="combo on">
          <span class="combo-boost" style="color:${color}">${boostText(type, c.combo.boost[type])}</span>
          <span class="reqs"><span class="req ok">Тренер<small>${esc(reqsText(c.combo.reqs))}</small></span></span>
        </div>`).join('')}
      ${missHtml ? `<p class="hint sub">Не хватает одного игрока (выделено):</p>${missHtml}` : ''}
    </div>`;
  }).join('');
}

const lineupPlayers = () =>
  LINES.flatMap(line => line.slots.map(s => state.byId[state.lineup[`${line.id}-${s}`]])).filter(Boolean);

function groupLabel(key, rule) {
  return rule.nations.includes(key) ? `${flag(key)} ${titleCase(key)}` : titleCase(key);
}

function captainBonusText(rule) {
  return [rule.ap && `+${rule.ap} AP`, rule.sal && `+$${rule.sal}M`].filter(Boolean).join(' · ');
}

const coachById = id => state.coaches.find(c => c.id === id);
const reqsText = reqs => {
  const labels = reqs.map(r => r.label);
  return labels.every(l => l === labels[0]) ? `${labels.length}× ${labels[0]}` : labels.join(' + ');
};
const LINE_LABELS = Object.fromEntries(LINES.map(l => [l.id, l.label]));

// Что нужно тренеру, если это не просто его клуб.
function coachSummaryText(coach) {
  const teams = [...new Set(coach.combos.flatMap(c => c.reqs.map(r => r.label)))];
  if (teams.length === 1 && teams[0].toUpperCase() === coach.team.toUpperCase()) return '';
  return teams.slice(0, 3).join(', ') + (teams.length > 3 ? '…' : '');
}

// Плитки «Капитан» и «Тренер» + раскрывающаяся панель с подробностями.
function renderStaff(cap, co) {
  const c = state.byId[state.captain];
  const coach = coachById(state.coach);
  if (state.staffOpen === 'captain' && !c) state.staffOpen = null;
  if (state.staffOpen === 'coach' && !coach) state.staffOpen = null;

  const captainTile = c && cap
    ? `<button class="staff-tile ${state.staffOpen === 'captain' ? 'open' : ''}" data-staff="captain">
        <span class="card" style="${cardStyle(c)}">${cardHtml(c)}</span>
        <span class="staff-info">
          <span class="staff-role">Капитан</span>
          <span class="staff-name">${esc(c.name)}</span>
          <span class="staff-sub ${cap.met ? 'met' : ''}">${cap.met ? `✓ ${captainBonusText(cap.rule)}` : `${cap.count}/${cap.rule.needed} игроков`}</span>
        </span>
      </button>`
    : `<button class="staff-tile" data-staff="captain">
        <span class="card empty"><span class="plus">+</span></span>
        <span class="staff-info"><span class="staff-role">Капитан</span><span class="staff-name">Выбрать</span><span class="staff-sub">до +20 AP</span></span>
      </button>`;

  const coachTile = coach && co
    ? `<button class="staff-tile ${state.staffOpen === 'coach' ? 'open' : ''}" data-staff="coach">
        <span class="card coach-photo">${coachImg(coach)}</span>
        <span class="staff-info">
          <span class="staff-role">Тренер</span>
          <span class="staff-name">${esc(coach.name)}</span>
          <span class="staff-sub ${co.activeCount ? 'met' : ''}">Комбинации ${co.activeCount}/${co.combos.length}</span>
        </span>
      </button>`
    : `<button class="staff-tile" data-staff="coach">
        <span class="card empty coach-photo"><span class="plus">+</span></span>
        <span class="staff-info"><span class="staff-role">Тренер</span><span class="staff-name">Выбрать</span><span class="staff-sub">6 комбинаций</span></span>
      </button>`;

  $('#staff').innerHTML = captainTile + coachTile;

  let detail = '';
  if (state.staffOpen === 'captain') {
    const { rule } = cap;
    const groups = cap.groups.length > 4 && !cap.groups.some(g => g.count)
      ? `<span class="chip">${cap.groups.length} клубов: ${esc(cap.groups.slice(0, 3).map(g => titleCase(g.key)).join(', '))}…</span>`
      : cap.groups.map(g => `<span class="chip ${g.count ? 'ap on' : ''}">${esc(groupLabel(g.key, rule))}${g.count ? ` · ${g.count}` : ''}</span>`).join('');
    detail = `<div class="staff-detail">
      <span class="cap-progress ${cap.met ? 'met' : ''}">Сыгранность капитана: ${cap.count}/${rule.needed} игроков</span>
      <div class="cap-bonus ${cap.met ? 'on' : ''}">${captainBonusText(rule)} ${cap.met ? '— активно' : `— нужно ещё ${rule.needed - cap.count}`}</div>
      <div class="chips">${groups}</div>
      <div class="staff-actions"><button class="primary" data-act="captain-change">Сменить</button><button data-act="captain-remove">Убрать</button></div>
    </div>`;
  } else if (state.staffOpen === 'coach') {
    const rows = co.combos.map(({ combo, active, lineId, matched }) => `
      <div class="combo">
        <span class="chips">${boostChips(combo.boost)}</span>
        <span class="reqs"><span class="req ${active ? 'ok' : ''}">${esc(reqsText(combo.reqs))}<small>${combo.cat === 'F' ? 'звено' : 'защита/вратари'} · ${
          active ? `✓ ${LINE_LABELS[lineId]}` : `${matched}/${combo.reqs.length}${lineId ? ` в «${LINE_LABELS[lineId]}»` : ''}`}</small></span></span>
      </div>`).join('');
    detail = `<div class="staff-detail">
      <span class="cap-progress ${co.activeCount ? 'met' : ''}">${esc(coach.team)} · сработало ${co.activeCount} из ${co.combos.length}</span>
      <div class="chips">${boostChips(co.total) || '<span class="chip">пока без бонусов</span>'}</div>
      ${rows}
      <div class="staff-actions"><button class="primary" data-act="coach-change">Сменить</button><button data-act="coach-remove">Убрать</button></div>
    </div>`;
  }
  $('#staff-detail').innerHTML = detail;
}

function coachImg(coach, thumb = false) {
  const url = !coach.img ? null : thumb
    ? `${THUMB_BASE}${coach.img}?resize=cover&width=200&height=260&quality=80`
    : ORIGINAL_BASE + coach.img;
  return `<span class="coach-fallback">${esc(coach.name)}</span>${url ? `<img class="card-img" src="${url}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}`;
}

function renderTeam() {
  const sum = teamSummary(state.lineup, state.byId, state.combos);
  const captain = state.byId[state.captain];
  const cap = captain ? captainStatus(captain, lineupPlayers(), state.captains) : null;
  if (cap) {
    sum.boost.AP += cap.ap;
    sum.boost.SAL += cap.sal;
    sum.salaryCap += cap.sal;
  }
  const coach = coachById(state.coach);
  const co = coach ? coachStatus(coach, state.lineup, state.byId) : null;
  if (co) {
    sum.boost.AP += co.total.AP;
    sum.boost.SAL += co.total.SAL;
    sum.salaryCap += co.total.SAL;
    let extraOvr = 0;
    for (const [lineId, t] of Object.entries(co.lineTotals)) {
      const lt = sum.lines[lineId].total;
      for (const k of ['OVR', 'SAL', 'AP']) lt[k] += t[k];
      const line = LINES.find(l => l.id === lineId);
      extraOvr += t.OVR * line.slots.filter(s => state.lineup[`${lineId}-${s}`]).length;
    }
    if (sum.count) sum.ovr = Math.round(sum.ovr + extraOvr / sum.count);
  }
  state.coachState = co;
  state.lastSum = sum;
  renderSummary(sum);
  renderStaff(cap, co);
  renderLineup(sum, cap);
  renderChem(sum);
}

// ---------- Поиск ----------
function matchesQuery(p, q) {
  if (!q) return true;
  const hay = p._hay || (p._hay = `${p.name} ${p.team} ${p.nation} ${p.card} ${p.pos} ${p.league}`.toLowerCase());
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function changeHtml(id) {
  const pr = state.prices.prices[id];
  if (!pr?.prev) return '';
  const ch = ((pr.price - pr.prev) / pr.prev) * 100;
  const cls = ch > 0.05 ? 'up' : ch < -0.05 ? 'down' : 'flat';
  return `<small class="${cls}">${ch > 0 ? '+' : ''}${ch.toFixed(1)}%</small>`;
}

// Для капитанских карточек — коротко, что даёт капитан.
function extraInfo(p) {
  if (state.pickerSlot !== 'CAPTAIN' || $('#picker').hidden) return '';
  const rule = captainRuleFor(p, state.captains);
  if (!rule) return '';
  const groups = [...rule.teams, ...rule.nations];
  const what = groups.length > 2 ? `${groups.length} клубов` : groups.map(titleCase).join(', ');
  return `<small class="cap-rule">${rule.needed} игроков из: ${esc(what)} → ${captainBonusText(rule)}</small>`;
}

function playerRow(p, extra = '') {
  return `<button class="mrow" data-id="${p.id}">
    <span class="badge" style="${cardStyle(p)}">${p.ovr}${cardImg(p, true)}</span>
    <span class="info"><b>${flag(p.nation)} ${esc(p.name)}</b><small>${esc(p.pos)} · ${esc(p.card)} · ${esc(p.team)} · $${p.salary.toFixed(1)}M</small>${extraInfo(p)}</span>
    <span class="price">${fmtPrice(priceOf(p))}${extra}</span>
  </button>`;
}

// ---------- Выбор игрока ----------
function openPicker(key) {
  state.pickerSlot = key;
  const isCaptain = key === 'CAPTAIN';
  const isCoach = key === 'COACH';
  const current = isCoach ? coachById(state.coach) : state.byId[isCaptain ? state.captain : state.lineup[key]];
  $('#picker-title').textContent = isCoach ? 'Выбор тренера' : isCaptain
    ? 'Выбор капитана'
    : current ? `${slotOf(key)}: ${current.name}` : `Слот ${slotOf(key)}`;
  $('#picker-remove').hidden = !current;
  $('#picker-allpos').parentElement.hidden = isCaptain || isCoach;
  $('#picker-search').value = '';
  $('#picker-allpos').checked = false;
  $('#picker').hidden = false;
  renderPickerList();
  setTimeout(() => $('#picker-search').focus(), 50);
}

function renderCoachList() {
  const q = $('#picker-search').value.trim().toLowerCase();
  const list = state.coaches
    .filter(c => !q || `${c.name} ${c.team} ${c.nation} ${coachSummaryText(c)}`.toLowerCase().includes(q))
    .map(c => ({ c, st: coachStatus(c, state.lineup, state.byId) }))
    .sort((a, b) => b.st.activeCount - a.st.activeCount || a.c.name.localeCompare(b.c.name));
  $('#picker-list').innerHTML = list.map(({ c, st }) => `
    <button class="mrow" data-coach="${esc(c.id)}">
      <span class="badge coach-thumb">${coachImg(c, true)}</span>
      <span class="info"><b>${esc(c.name)}</b><small>${esc([c.team, coachSummaryText(c)].filter(Boolean).join(' · '))}</small>
        <small class="cap-rule">Сейчас сработает: ${st.activeCount}/${st.combos.length}${st.activeCount ? ` → ${['OVR', 'SAL', 'AP'].filter(t => st.total[t]).map(t => boostText(t, st.total[t])).join(' ')}` : ''}</small></span>
      <span class="price">${c.id === state.coach ? '<small class="flat">выбран</small>' : ''}</span>
    </button>`).join('') || '<p class="hint">Никого не нашли</p>';
}

function renderPickerList() {
  if (state.pickerSlot === 'COACH') return renderCoachList();
  const isCaptain = state.pickerSlot === 'CAPTAIN';
  const q = $('#picker-search').value.trim();
  const allPos = $('#picker-allpos').checked;
  // Игроков, которые уже стоят в составе (любой их карточкой), в списке не показываем.
  const taken = new Set(isCaptain ? [] : lineupPlayers().map(p => p.name.trim().toLowerCase()));
  const fits = isCaptain
    ? () => true
    : p => (allPos || slotAccepts(slotOf(state.pickerSlot), p)) && !taken.has(p.name.trim().toLowerCase());
  const list = [];
  for (const p of isCaptain ? state.captainCards : state.players) {
    if (fits(p) && matchesQuery(p, q)) list.push(p);
    if (list.length >= PAGE_SIZE) break;
  }
  const mark = p => isCaptain
    ? (p.id === state.captain ? '<small class="flat">капитан</small>' : '')
    : (inLineup(p.id) ? '<small class="flat">в составе</small>' : '');
  $('#picker-list').innerHTML = list.length
    ? list.map(p => playerRow(p, mark(p))).join('')
    : '<p class="hint">Никого не нашли</p>';
}

function setCoach(id) {
  state.coach = id;
  saveLineup();
  renderTeam();
  haptic('medium');
}

function setCaptain(id) {
  state.captain = id;
  saveLineup();
  renderTeam();
  haptic('medium');
}

function assign(key, id) {
  const name = state.byId[id].name.trim().toLowerCase();
  for (const [k, v] of Object.entries(state.lineup)) {
    if (v === id || state.byId[v]?.name.trim().toLowerCase() === name) delete state.lineup[k];
  }
  state.lineup[key] = id;
  saveLineup();
  renderTeam();
  haptic('medium');
}

// ---------- Маркет ----------
function renderMarket() {
  const q = $('#market-search').value.trim();
  const sort = $('#market-sort').value;
  const onlyPriced = $('#market-priced').checked;
  const change = p => {
    const pr = state.prices.prices[p.id];
    return pr?.prev ? (pr.price - pr.prev) / pr.prev : null;
  };
  const at = p => new Date(state.prices.prices[p.id]?.at || 0).getTime();
  const sorters = {
    'price-desc': (a, b) => priceOf(b) - priceOf(a),
    'price-asc': (a, b) => (priceOf(a) || Infinity) - (priceOf(b) || Infinity),
    'recent': (a, b) => at(b) - at(a),
    'change-desc': (a, b) => (change(b) ?? -1e9) - (change(a) ?? -1e9),
    'change-asc': (a, b) => (change(a) ?? 1e9) - (change(b) ?? 1e9),
    'ovr-desc': (a, b) => b.ovr - a.ovr,
  };
  const list = state.players.filter(p => (!onlyPriced || priceOf(p)) && matchesQuery(p, q)).sort(sorters[sort]);
  const shown = list.slice(0, state.marketLimit);
  $('#market-list').innerHTML = shown.map(p => playerRow(p, changeHtml(p.id) || `<small class="flat">${timeAgo(state.prices.prices[p.id]?.at)}</small>`)).join('')
    + (list.length > shown.length ? `<button class="btn-ghost" id="market-more">Показать ещё (${list.length - shown.length})</button>` : '')
    || '<p class="hint">Никого не нашли</p>';

  const { updatedAt } = state.prices;
  const t = d => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('#market-updated').textContent = updatedAt
    ? `${list.length} карточек · цены hutdb.app загружены в ${t(updatedAt)}, обновляются каждый час`
    : 'Цены ещё не загружены';
}

function sparkline(history) {
  if (!history || history.length < 2) return '<p class="hint">График появится, когда цена изменится.</p>';
  const w = 300, h = 60, pad = 4;
  const vals = history.map(x => x[1]);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${pad + (i / (vals.length - 1)) * (w - pad * 2)},${h - pad - ((v - min) / span) * (h - pad * 2)}`).join(' ');
  const color = vals.at(-1) >= vals[0] ? 'var(--green)' : 'var(--red)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/></svg>`;
}

function firstFreeSlotFor(p) {
  for (const line of LINES) {
    for (const slot of line.slots) {
      const key = `${line.id}-${slot}`;
      if (!state.lineup[key] && slotAccepts(slot, p)) return key;
    }
  }
  return null;
}

function boostChips(b) {
  return ['OVR', 'SAL', 'AP'].filter(t => b[t]).map(t =>
    `<span class="chip ${t === 'SAL' ? 'salary' : t.toLowerCase()} on">${boostText(t, b[t])}</span>`).join('');
}

function openDetails(id) {
  const p = state.byId[id];
  if (!p) return;
  const pr = state.prices.prices[id];
  const best = bestCombosFor(p, state.players, state.combos, { priceOf });
  $('#details-title').textContent = p.name;
  $('#details-content').innerHTML = `
    <div class="detail-top">
      <div class="card" style="${cardStyle(p)}">${cardHtml(p)}</div>
      <div class="kv">
        <span>Цена</span><b>${fmtPrice(pr?.price)} ${changeHtml(id)}</b>
        ${pr?.at ? `<span>Обновлена</span><b>${timeAgo(pr.at)}${pr.by ? ` · ${esc(pr.by)}` : ''}</b>` : ''}
        <span>Позиция</span><b>${esc(p.pos)}</b>
        <span>Карточка</span><b>${esc(p.card)}</b>
        <span>Команда</span><b>${esc(p.team)}</b>
        <span>Страна</span><b>${flag(p.nation)} ${esc(p.nation)}</b>
        <span>Зарплата</span><b>$${p.salary.toFixed(1)}M</b>
      </div>
    </div>
    ${captainRuleFor(p, state.captains) ? (() => {
      const rule = captainRuleFor(p, state.captains);
      const groups = [...rule.teams, ...rule.nations].map(k => groupLabel(k, rule)).join(', ');
      return `<div class="cap-note"><b>Капитан:</b> ${rule.needed} игроков из ${esc(groups)} → ${captainBonusText(rule)}
        <button class="btn-ghost" id="details-captain">${state.captain === id ? 'Уже капитан' : 'Сделать капитаном'}</button></div>`;
    })() : ''}
    ${p.abilities.length ? `<div class="chips" style="margin-bottom:8px">${p.abilities.map(([n, ap]) => `<span class="chip">${esc(n.replace(/_/g, ' '))} · ${ap} AP</span>`).join('')}</div>` : ''}
    <div class="section-title">История цены</div>
    ${sparkline(pr?.history)}
    <div class="section-title">Лучше всего сыгрывается с</div>
    ${best.partners.length ? best.partners.map(({ player: q, combos }) => `
      <div class="partner" data-id="${q.id}">
        <span class="badge" style="${cardStyle(q)}">${q.ovr}${cardImg(q, true)}</span>
        <span class="info"><b>${flag(q.nation)} ${esc(q.name)}</b><small class="flat">${esc(q.pos)} · ${esc(q.card)} · ${fmtPrice(priceOf(q))}</small></span>
        <span class="chips">${combos.length} комбо</span>
      </div>`).join('') : '<p class="hint">Этот игрок не входит ни в одну комбинацию.</p>'}
    ${best.combos.length ? `<div class="section-title">Комбинации с игроком</div>
      ${best.combos.map(({ combo, options }) => `
        <div class="combo on">
          <span class="chips">${boostChips(combo.boost)}</span>
          <span class="reqs">${options.map(o => `<span class="req">${esc(reqLabel(o.req))}<small>${esc(o.candidates.slice(0, 2).map(c => surname(c.name)).join(', '))}${o.candidates.length > 2 ? '…' : ''}</small></span>`).join('')}</span>
        </div>`).join('')}` : ''}
    <button class="btn-primary" id="details-add">${inLineup(id) ? 'Уже в составе' : 'Добавить в состав'}</button>`;
  const capBtn = $('#details-captain');
  if (capBtn) capBtn.onclick = () => {
    setCaptain(id);
    closeSheets();
    toast(`${p.name} — капитан`);
  };
  $('#details-add').onclick = () => {
    if (inLineup(id)) return;
    const key = firstFreeSlotFor(p);
    if (!key) return toast('Нет свободного слота для этой позиции');
    assign(key, id);
    closeSheets();
    toast(`${p.name} → ${key.replace('-', ' ')}`);
  };
  $('#details').hidden = false;
  $('#details .sheet-body').scrollTop = 0;
}

function closeSheets() {
  $('#picker').hidden = true;
  $('#details').hidden = true;
}

// ---------- Данные ----------
async function loadPrices() {
  try {
    state.prices = await (await fetch(`data/prices.json?t=${Date.now()}`)).json();
  } catch {}
  renderMarket();
}

async function init() {
  const [players, combos, captains, coaches, saved] = await Promise.all([
    fetch('data/players.json').then(r => r.json()),
    fetch('data/combos.json').then(r => r.json()).catch(() => []),
    fetch('data/captains.json').then(r => r.json()).catch(() => []),
    fetch('data/coaches.json').then(r => r.json()).catch(() => []),
    loadLineup(),
  ]);
  state.players = players;
  state.combos = combos;
  state.captains = captains;
  state.coaches = coaches;
  state.coach = coaches.some(c => c.id === saved.coach) ? saved.coach : null;
  state.captainCards = players.filter(p => captainRuleFor(p, captains));
  state.byId = Object.fromEntries(players.map(p => [p.id, p]));
  const slots = saved.slots || saved; // старый формат — просто слоты
  state.lineup = Object.fromEntries(Object.entries(slots).filter(([, id]) => state.byId[id]));
  state.captain = state.byId[saved.captain] ? saved.captain : null;
  await loadPrices();
  renderTeam();
  $('#loading').hidden = true;
  setInterval(loadPrices, PRICE_REFRESH_MS);
  loadMe();
}

// ---------- События ----------
document.querySelector('.tabbar').addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
  window.scrollTo(0, 0);
  haptic();
});

$('#team-mode').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  $('#team-mode').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  $('#lineup').hidden = btn.dataset.mode !== 'lineup';
  $('#chem').hidden = btn.dataset.mode !== 'chem';
});

$('#chem-type').addEventListener('click', e => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  state.chemType = btn.dataset.type;
  $('#chem-type').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  renderTeam();
});

$('#lineup').addEventListener('click', e => {
  const card = e.target.closest('[data-slot]');
  if (card) openPicker(card.dataset.slot);
});

$('#staff').addEventListener('click', e => {
  const tile = e.target.closest('[data-staff]');
  if (!tile) return;
  const kind = tile.dataset.staff;
  const isSet = kind === 'captain' ? state.captain : state.coach;
  if (!isSet) return openPicker(kind === 'captain' ? 'CAPTAIN' : 'COACH');
  state.staffOpen = state.staffOpen === kind ? null : kind;
  haptic();
  renderTeam();
});

$('#staff-detail').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'captain-change') openPicker('CAPTAIN');
  if (act === 'captain-remove') setCaptain(null);
  if (act === 'coach-change') openPicker('COACH');
  if (act === 'coach-remove') setCoach(null);
});

$('#picker-search').addEventListener('input', renderPickerList);
$('#picker-allpos').addEventListener('change', renderPickerList);
$('#picker-list').addEventListener('click', e => {
  const coachRow = e.target.closest('[data-coach]');
  if (coachRow) {
    setCoach(coachRow.dataset.coach);
    return closeSheets();
  }
  const row = e.target.closest('[data-id]');
  if (!row) return;
  if (state.pickerSlot === 'CAPTAIN') setCaptain(Number(row.dataset.id));
  else assign(state.pickerSlot, Number(row.dataset.id));
  closeSheets();
});
$('#picker-remove').addEventListener('click', () => {
  if (state.pickerSlot === 'CAPTAIN') state.captain = null;
  else if (state.pickerSlot === 'COACH') state.coach = null;
  else delete state.lineup[state.pickerSlot];
  saveLineup();
  renderTeam();
  closeSheets();
});

const resetMarket = () => { state.marketLimit = PAGE_SIZE; renderMarket(); };
$('#market-search').addEventListener('input', resetMarket);
$('#market-sort').addEventListener('change', resetMarket);
$('#market-priced').addEventListener('change', resetMarket);
$('#market-list').addEventListener('click', e => {
  if (e.target.id === 'market-more') {
    state.marketLimit += PAGE_SIZE;
    return renderMarket();
  }
  const row = e.target.closest('[data-id]');
  if (row) openDetails(Number(row.dataset.id));
});
$('#details-content').addEventListener('click', e => {
  const row = e.target.closest('.partner[data-id]');
  if (row) openDetails(Number(row.dataset.id));
});

document.querySelectorAll('.sheet').forEach(sheet => sheet.addEventListener('click', e => {
  if (e.target === sheet || e.target.closest('[data-close]')) closeSheets();
}));

$('#clear-lineup').addEventListener('click', () => {
  const doClear = ok => {
    if (!ok) return;
    state.lineup = {};
    state.captain = null;
    state.coach = null;
    saveLineup();
    renderTeam();
  };
  if (tg?.initData && tg.isVersionAtLeast?.('6.2')) tg.showConfirm('Очистить весь состав?', doClear);
  else doClear(confirm('Очистить весь состав?'));
});

// ---------- Подписка и приглашения ----------
async function loadMe() {
  try {
    const res = await fetch('api/me', { cache: 'no-store' });
    if (!res.ok) return;
    state.me = await res.json();
  } catch {
    return; // локальный запуск без сервера
  }
  const me = state.me;
  const tag = $('#sub-tag');
  if (me.admin) tag.textContent = 'ADMIN';
  else if (me.until) {
    const d = new Date(me.until * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    tag.textContent = me.trial ? `ТРИАЛ ДО ${d}` : `ДО ${d}`;
    tag.classList.toggle('trial', me.trial);
  }
  $('#invite-bonus').textContent = me.refBonusDays ? `+${me.refBonusDays} дней за друга` : '';
}

function invite() {
  const me = state.me;
  if (!me?.refLink) return toast('Ссылка появится в версии из Telegram');
  const text = '🏒 HUT Builder — собирай состав NHL HUT с настоящими line combos прямо в Telegram';
  const url = `https://t.me/share/url?url=${encodeURIComponent(me.refLink)}&text=${encodeURIComponent(text)}`;
  try { tg.openTelegramLink(url); } catch { window.open(url, '_blank'); }
}

// ---------- Картинка состава ----------
const loadImage = src => new Promise(resolve => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function renderLineupImage() {
  const W = 1080, PAD = 50, GAP = 14, CW = 180, CH = Math.round(CW * 1128 / 804), LABEL = 40, ROW = LABEL + CH + 26;
  const HEADER = 250, H = HEADER + ROW * 4 + 90;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  await Promise.all([document.fonts.load('600 40px Oswald'), document.fonts.load('600 20px Inter')]).catch(() => {});

  // фон
  ctx.fillStyle = '#06080c'; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -80, 40, W / 2, -80, 900);
  glow.addColorStop(0, 'rgba(227,189,106,.28)'); glow.addColorStop(1, 'rgba(227,189,106,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  const gold = ctx.createLinearGradient(0, 0, W, 0);
  gold.addColorStop(0, '#f6dc9a'); gold.addColorStop(.5, '#e3bd6a'); gold.addColorStop(1, '#b8892b');

  // шапка
  const sum = state.lastSum || { ovr: 0, salary: 0, salaryCap: CHEMISTRY.baseSalaryCap, boost: { AP: 0 } };
  ctx.fillStyle = '#f4f1ea'; ctx.font = '600 44px Oswald'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('HUT', PAD, 92);
  ctx.fillStyle = gold; ctx.fillText('BUILDER', PAD + ctx.measureText('HUT ').width, 92);
  ctx.fillStyle = '#8d93a1'; ctx.font = '500 22px Inter';
  const capName = state.byId[state.captain]?.name, coachName = coachById(state.coach)?.name;
  ctx.fillText([capName && `Капитан: ${capName}`, coachName && `Тренер: ${coachName}`].filter(Boolean).join('   ·   ') || 'Мой состав NHL HUT', PAD, 130);
  const stats = [['OVR', String(sum.ovr || '—')], ['ЗАРПЛАТА', `$${sum.salary.toFixed(1)}M / $${sum.salaryCap}M`], ['AP', `${sum.boost.AP} / ${CHEMISTRY.maxAp}`]];
  let sx = PAD;
  for (const [label, value] of stats) {
    ctx.fillStyle = '#8d93a1'; ctx.font = '600 20px Oswald'; ctx.fillText(label, sx, 182);
    ctx.fillStyle = label === 'OVR' ? gold : '#f4f1ea'; ctx.font = '600 44px Oswald'; ctx.fillText(value, sx, 228);
    sx += Math.max(ctx.measureText(value).width, 120) + 60;
  }

  // карточки
  const images = new Map();
  await Promise.all(Object.values(state.lineup).map(async id => {
    const p = state.byId[id];
    const src = p?.img && `${THUMB_BASE}cards/${p.img}${p.img.includes('?') ? '&' : '?'}resize=contain&width=400&quality=85`;
    if (src) images.set(id, await loadImage(src));
  }));

  const drawLine = (line, x, y) => {
    const t = state.lastSum?.lines[line.id]?.total || { OVR: 0, SAL: 0, AP: 0 };
    ctx.fillStyle = gold; ctx.fillRect(x, y + 8, 5, 24);
    ctx.fillStyle = '#f4f1ea'; ctx.font = '600 26px Oswald'; ctx.fillText(line.label.toUpperCase(), x + 16, y + 30);
    const bonus = [t.OVR && `+${t.OVR} OVR`, t.SAL && `+$${t.SAL}M`, t.AP && `+${t.AP} AP`].filter(Boolean).join('  ');
    if (bonus) {
      ctx.fillStyle = '#4ade80'; ctx.font = '600 22px Oswald';
      ctx.fillText(bonus, x + 16 + ctx.measureText(line.label.toUpperCase()).width + 70, y + 30);
    }
    line.slots.forEach((slot, i) => {
      const cx = x + i * (CW + GAP), cy = y + LABEL;
      const p = state.byId[state.lineup[`${line.id}-${slot}`]];
      const img = p && images.get(p.id);
      roundRect(ctx, cx, cy, CW, CH, 12);
      if (img) {
        ctx.save(); ctx.clip(); ctx.drawImage(img, cx, cy, CW, CH); ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill();
        ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(227,189,106,.35)'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = p ? '#f4f1ea' : '#5d6370'; ctx.font = '600 22px Oswald'; ctx.textAlign = 'center';
        ctx.fillText(p ? `${p.ovr} ${surname(p.name)}` : slot, cx + CW / 2, cy + CH / 2);
        ctx.textAlign = 'left';
      }
    });
  };
  const leftX = PAD, rightX = W - PAD - (CW * 2 + GAP);
  LINES.filter(l => l.cat === 'F').forEach((l, i) => drawLine(l, leftX, HEADER + i * ROW));
  LINES.filter(l => l.cat !== 'F').forEach((l, i) => drawLine(l, rightX, HEADER + i * ROW));

  ctx.fillStyle = '#5d6370'; ctx.font = '500 22px Inter';
  const username = state.me?.refLink?.match(/t\.me\/([^?]+)/)?.[1];
  ctx.fillText(username ? `Собери свой состав — @${username}` : 'HUT Builder — Telegram Mini App', PAD, H - 40);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function shareLineup() {
  const btn = $('#share-lineup');
  if (!Object.keys(state.lineup).length) return toast('Сначала добавьте игроков в состав');
  btn.disabled = true;
  toast('Готовлю картинку…');
  try {
    const blob = await renderLineupImage();
    const sum = state.lastSum;
    const form = new FormData();
    form.append('photo', blob, 'lineup.png');
    form.append('summary', `🏒 Мой состав в HUT Builder: ${sum.ovr} OVR · зарплата $${sum.salary.toFixed(1)}M · ${sum.boost.AP} AP`);
    const res = await (await fetch('api/share', { method: 'POST', body: form })).json();
    if (!res.ok) throw new Error(res.error);
    haptic('medium');
    if (res.preparedId && tg?.isVersionAtLeast?.('8.0')) {
      tg.shareMessage(res.preparedId, ok => ok && toast('Отправлено!'));
    } else {
      toast('Картинка в чате с ботом — перешлите её друзьям');
    }
  } catch {
    toast('Не получилось поделиться, попробуйте ещё раз');
  } finally {
    btn.disabled = false;
  }
}

$('#share-lineup').addEventListener('click', shareLineup);
$('#invite').addEventListener('click', invite);

init();
