const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const STORAGE_KEY = 'hut-lineup-v2';
const PRICE_REFRESH_MS = 60 * 60 * 1000;
const PAGE_SIZE = 60;

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
  const data = JSON.stringify(state.lineup);
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
    tg.CloudStorage.getItem(STORAGE_KEY, (err, value) => {
      if (err || !value) return resolve(fromLocal());
      try { resolve(JSON.parse(value)); } catch { resolve(fromLocal()); }
    });
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

function cardHtml(p, slot) {
  if (!p) return `<div class="plus">+</div><div class="slot">${esc(slot)}</div>`;
  const off = slot && !slotAccepts(slot, p) ? '<span class="offpos">не своя</span>' : '';
  return `
    ${off}
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
function renderSummary(sum) {
  $('#sum-ovr').textContent = sum.ovr;
  const salaryEl = $('#sum-salary');
  salaryEl.textContent = `$${sum.salary.toFixed(1)}M`;
  salaryEl.classList.toggle('over', sum.salary > sum.salaryCap);
  $('#sum-cap').textContent = `кап $${sum.salaryCap}M (+${sum.boost.SAL})`;
  $('#sum-ap').textContent = `${sum.boost.AP}/${CHEMISTRY.maxAp}`;
}

function bonusChips(t) {
  return `
    <span class="chip ovr ${t.OVR ? 'on' : ''}">+${t.OVR} OVR</span>
    <span class="chip salary ${t.SAL ? 'on' : ''}">+$${t.SAL}M</span>
    <span class="chip ap ${t.AP ? 'on' : ''}">+${t.AP} AP</span>`;
}

function renderLineup(sum) {
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
          return `<button class="card ${p ? '' : 'empty'}" style="${cardStyle(p)}" data-slot="${key}">${cardHtml(p, slot)}</button>`;
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
      ${missHtml ? `<p class="hint sub">Не хватает одного игрока (выделено):</p>${missHtml}` : ''}
    </div>`;
  }).join('');
}

function renderTeam() {
  const sum = teamSummary(state.lineup, state.byId, state.combos);
  renderSummary(sum);
  renderLineup(sum);
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

function playerRow(p, extra = '') {
  return `<button class="mrow" data-id="${p.id}">
    <span class="badge" style="${cardStyle(p)}">${p.ovr}</span>
    <span class="info"><b>${flag(p.nation)} ${esc(p.name)}</b><small>${esc(p.pos)} · ${esc(p.card)} · ${esc(p.team)} · $${p.salary.toFixed(1)}M</small></span>
    <span class="price">${fmtPrice(priceOf(p))}${extra}</span>
  </button>`;
}

// ---------- Выбор игрока ----------
function openPicker(key) {
  state.pickerSlot = key;
  const slot = slotOf(key);
  const current = state.byId[state.lineup[key]];
  $('#picker-title').textContent = current ? `${slot}: ${current.name}` : `Слот ${slot}`;
  $('#picker-remove').hidden = !current;
  $('#picker-search').value = '';
  $('#picker-allpos').checked = false;
  renderPickerList();
  $('#picker').hidden = false;
  setTimeout(() => $('#picker-search').focus(), 50);
}

function renderPickerList() {
  const slot = slotOf(state.pickerSlot);
  const q = $('#picker-search').value.trim();
  const allPos = $('#picker-allpos').checked;
  const list = [];
  for (const p of state.players) {
    if ((allPos || slotAccepts(slot, p)) && matchesQuery(p, q)) list.push(p);
    if (list.length >= PAGE_SIZE) break;
  }
  $('#picker-list').innerHTML = list.length
    ? list.map(p => playerRow(p, inLineup(p.id) ? '<small class="flat">в составе</small>' : '')).join('')
    : '<p class="hint">Никого не нашли</p>';
}

function assign(key, id) {
  for (const [k, v] of Object.entries(state.lineup)) if (v === id) delete state.lineup[k];
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
    ${p.abilities.length ? `<div class="chips" style="margin-bottom:8px">${p.abilities.map(([n, ap]) => `<span class="chip">${esc(n.replace(/_/g, ' '))} · ${ap} AP</span>`).join('')}</div>` : ''}
    <div class="section-title">История цены</div>
    ${sparkline(pr?.history)}
    <div class="section-title">Лучше всего сыгрывается с</div>
    ${best.partners.length ? best.partners.map(({ player: q, combos }) => `
      <div class="partner" data-id="${q.id}">
        <span class="badge" style="${cardStyle(q)}">${q.ovr}</span>
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
  const [players, combos, lineup] = await Promise.all([
    fetch('data/players.json').then(r => r.json()),
    fetch('data/combos.json').then(r => r.json()).catch(() => []),
    loadLineup(),
  ]);
  state.players = players;
  state.combos = combos;
  state.byId = Object.fromEntries(players.map(p => [p.id, p]));
  state.lineup = Object.fromEntries(Object.entries(lineup).filter(([, id]) => state.byId[id]));
  await loadPrices();
  renderTeam();
  $('#loading').hidden = true;
  setInterval(loadPrices, PRICE_REFRESH_MS);
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

$('#picker-search').addEventListener('input', renderPickerList);
$('#picker-allpos').addEventListener('change', renderPickerList);
$('#picker-list').addEventListener('click', e => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  assign(state.pickerSlot, Number(row.dataset.id));
  closeSheets();
});
$('#picker-remove').addEventListener('click', () => {
  delete state.lineup[state.pickerSlot];
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
    saveLineup();
    renderTeam();
  };
  if (tg?.initData && tg.isVersionAtLeast?.('6.2')) tg.showConfirm('Очистить весь состав?', doClear);
  else doClear(confirm('Очистить весь состав?'));
});

init();
