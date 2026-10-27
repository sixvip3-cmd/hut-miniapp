const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const STORAGE_KEY = 'hut-lineup-v1';
const PRICE_REFRESH_MS = 60 * 60 * 1000;

const FLAGS = { CAN: '🇨🇦', USA: '🇺🇸', SWE: '🇸🇪', FIN: '🇫🇮', RUS: '🇷🇺', CZE: '🇨🇿', SVK: '🇸🇰', GER: '🇩🇪', SUI: '🇨🇭', LAT: '🇱🇻', DEN: '🇩🇰', AUT: '🇦🇹', NOR: '🇳🇴', BLR: '🇧🇾', SLO: '🇸🇮' };
const PROGRAM_COLORS = {
  'Icons': ['#6b5212', '#1a1406'],
  'Legends Rising': ['#8a1f5c', '#1c0d1e'],
  'Eras': ['#7a7f8a', '#24272e'],
  'Heroes': ['#3a3d44', '#111216'],
  'Captains': ['#b3151d', '#3a0709'],
  'TOTW': ['#7a1fa3', '#25082f'],
  'Spotlight': ['#a3211b', '#2e0807'],
  'XP': ['#1d3fa8', '#0a1233'],
  'Crest': ['#2f78c4', '#0e2340'],
};

const state = {
  players: [],
  byId: {},
  prices: { prices: {}, updatedAt: null, nextUpdateAt: null },
  lineup: {},
  chemType: 'salary',
  pickerSlot: null,
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flag = n => FLAGS[n] || '🏳️';
const fmtPrice = v => (v == null ? '—' : v.toLocaleString('ru-RU'));
const haptic = type => tg?.HapticFeedback?.impactOccurred?.(type || 'light');

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 1800);
}

// ---------- Хранение состава ----------
function saveLineup() {
  const data = JSON.stringify(state.lineup);
  try { localStorage.setItem(STORAGE_KEY, data); } catch {}
  tg?.CloudStorage?.setItem(STORAGE_KEY, data, () => {});
}

function loadLineup() {
  return new Promise(resolve => {
    const fromLocal = () => {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
    };
    if (!tg?.CloudStorage || !tg.initData) return resolve(fromLocal());
    tg.CloudStorage.getItem(STORAGE_KEY, (err, value) => {
      if (err || !value) return resolve(fromLocal());
      try { resolve(JSON.parse(value)); } catch { resolve(fromLocal()); }
    });
  });
}

// ---------- Позиции ----------
function slotAccepts(slot, p) {
  if (slot === 'STARTER' || slot === 'BACKUP') return p.pos === 'G';
  return p.pos === slot || (p.alt || []).includes(slot);
}
const slotOf = key => key.split('-')[1];
const inLineup = id => Object.values(state.lineup).includes(id);

// ---------- Карточка ----------
function cardHtml(p, slot) {
  if (!p) {
    return `<div class="plus">+</div><div class="slot">${esc(slot)}</div>`;
  }
  const off = slot && !slotAccepts(slot, p) ? '<span class="offpos">не своя</span>' : '';
  return `
    ${off}
    <div class="top">
      <div><div class="ovr">${p.ovr}</div><div class="pos">${esc(p.pos)}</div></div>
      <div class="flag">${flag(p.nation)}</div>
    </div>
    <div>
      <div class="name">${esc(p.name.split(' ').slice(-1)[0])}</div>
      <div class="meta"><span>${esc(p.team)}</span><span>$${p.salary.toFixed(1)}M</span></div>
    </div>`;
}

function cardStyle(p) {
  const [c1, c2] = PROGRAM_COLORS[p?.program] || ['#2a2f3a', '#14171d'];
  return `--c1:${c1};--c2:${c2}`;
}

// ---------- Вкладка «Команда» ----------
function renderSummary(sum) {
  $('#sum-ovr').textContent = sum.ovr;
  const salaryEl = $('#sum-salary');
  salaryEl.textContent = `$${sum.salary.toFixed(1)}M`;
  salaryEl.classList.toggle('over', sum.salary > sum.salaryCap);
  $('#sum-cap').textContent = `кап $${sum.salaryCap.toFixed(1)}M (+${sum.salaryBonus})`;
  $('#sum-ap').textContent = `${sum.ap}/${CHEMISTRY.maxAp}`;
}

function bonusChips(b) {
  return `
    <span class="chip ovr ${b.ovr.value ? 'on' : ''}">+${b.ovr.value} OVR</span>
    <span class="chip salary ${b.salary.value ? 'on' : ''}">+$${b.salary.value}M</span>
    <span class="chip ap ${b.ap.value ? 'on' : ''}">+${b.ap.value} AP</span>`;
}

function renderLineup(sum) {
  $('#lineup').innerHTML = LINES.map(line => `
    <div class="line">
      <div class="line-head">
        <span class="line-title">${line.label}</span>
        <span class="chips">${bonusChips(sum.lines[line.id])}</span>
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

function renderChem(sum) {
  const type = state.chemType;
  const cfg = CHEMISTRY.types[type];
  const unit = v => (type === 'salary' ? `+$${v}M` : `+${v} ${cfg.label}`);
  $('#chem-hint').textContent = `${cfg.label}-бонус даёт совпадение по признаку «${cfg.attrLabel}» у игроков одной линии.`;

  const tiers = CHEMISTRY.bonuses[type];
  const tierText = `Звено (3): 2 совпадения ${unit(tiers[3][2])}, 3 совпадения ${unit(tiers[3][3])} · Пара (2): ${unit(tiers[2][2])}`;

  $('#chem-lines').innerHTML = LINES.map(line => {
    const b = sum.lines[line.id][type];
    const rows = line.slots.map(slot => {
      const p = state.byId[state.lineup[`${line.id}-${slot}`]];
      if (!p) return `<div class="chem-row"><span class="who" style="color:var(--hint)">${slot} — пусто</span></div>`;
      const v = p[cfg.attr];
      const match = b.count >= 2 && v === b.match;
      return `<div class="chem-row">
        <span class="who">${flag(p.nation)} ${esc(p.name)}</span>
        <span class="attr ${match ? 'match' : ''}">${esc(v)}</span>
      </div>`;
    }).join('');
    return `<div class="line">
      <div class="line-head">
        <span class="line-title">${line.label}</span>
        <span class="bonus-big ${b.value ? '' : 'zero'}" style="color:${b.value ? `var(--${type === 'ovr' ? 'cyan' : type === 'ap' ? 'purple' : 'green'})` : ''}">${unit(b.value)}</span>
      </div>${rows}</div>`;
  }).join('') + `<div class="tiers">${tierText}</div>`;
}

function renderTeam() {
  const sum = teamSummary(state.lineup, state.byId);
  renderSummary(sum);
  renderLineup(sum);
  renderChem(sum);
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
}

function matchesQuery(p, q) {
  if (!q) return true;
  const hay = `${p.name} ${p.team} ${p.nation} ${p.program} ${p.pos}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function marketRow(p, extra = '') {
  const pr = state.prices.prices[p.id];
  const price = pr?.price ?? p.price;
  return `<button class="mrow" data-id="${esc(p.id)}">
    <span class="badge" style="${cardStyle(p)}">${p.ovr}</span>
    <span class="info"><b>${flag(p.nation)} ${esc(p.name)}</b><small>${esc(p.pos)} · ${esc(p.team)} · ${esc(p.program)} · $${p.salary.toFixed(1)}M</small></span>
    <span class="price">${fmtPrice(price)}${extra}</span>
  </button>`;
}

function renderPickerList() {
  const slot = slotOf(state.pickerSlot);
  const q = $('#picker-search').value.trim();
  const allPos = $('#picker-allpos').checked;
  const list = state.players
    .filter(p => (allPos || slotAccepts(slot, p)) && matchesQuery(p, q))
    .sort((a, b) => b.ovr - a.ovr)
    .slice(0, 100);
  $('#picker-list').innerHTML = list.length
    ? list.map(p => marketRow(p, inLineup(p.id) ? '<small class="flat">в составе</small>' : '')).join('')
    : '<p class="hint">Никого не нашли</p>';
}

function assign(key, id) {
  // Один игрок — один слот: убираем его со старого места.
  for (const [k, v] of Object.entries(state.lineup)) if (v === id) delete state.lineup[k];
  state.lineup[key] = id;
  saveLineup();
  renderTeam();
  haptic('medium');
}

// ---------- Маркет ----------
function priceChange(id) {
  const pr = state.prices.prices[id];
  if (!pr || pr.prev == null || !pr.prev) return null;
  return ((pr.price - pr.prev) / pr.prev) * 100;
}

function changeHtml(ch) {
  if (ch == null) return '<small class="flat">—</small>';
  const cls = ch > 0.05 ? 'up' : ch < -0.05 ? 'down' : 'flat';
  return `<small class="${cls}">${ch > 0 ? '+' : ''}${ch.toFixed(1)}%</small>`;
}

function renderMarket() {
  const q = $('#market-search').value.trim();
  const sort = $('#market-sort').value;
  const priceOf = p => state.prices.prices[p.id]?.price ?? p.price ?? 0;
  const sorters = {
    'price-desc': (a, b) => priceOf(b) - priceOf(a),
    'price-asc': (a, b) => priceOf(a) - priceOf(b),
    'change-desc': (a, b) => (priceChange(b.id) ?? -1e9) - (priceChange(a.id) ?? -1e9),
    'change-asc': (a, b) => (priceChange(a.id) ?? 1e9) - (priceChange(b.id) ?? 1e9),
    'ovr-desc': (a, b) => b.ovr - a.ovr,
  };
  const list = state.players.filter(p => matchesQuery(p, q)).sort(sorters[sort]);
  $('#market-list').innerHTML = list.map(p => marketRow(p, changeHtml(priceChange(p.id)))).join('')
    || '<p class="hint">Никого не нашли</p>';

  const { updatedAt } = state.prices;
  const nextUpdateAt = updatedAt && new Date(updatedAt).getTime() + PRICE_REFRESH_MS;
  const t = d => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('#market-updated').textContent = updatedAt
    ? `Обновлено в ${t(updatedAt)}${nextUpdateAt ? ` · следующее в ${t(nextUpdateAt)}` : ''}`
    : 'Цены ещё не загружены';
}

function sparkline(history) {
  if (!history || history.length < 2) return '<p class="hint">История цен появится после нескольких обновлений.</p>';
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

function openDetails(id) {
  const p = state.byId[id];
  if (!p) return;
  const pr = state.prices.prices[id];
  const partners = bestPartners(p, state.players);
  $('#details-title').textContent = p.name;
  $('#details-content').innerHTML = `
    <div class="detail-top">
      <div class="card" style="${cardStyle(p)}">${cardHtml(p)}</div>
      <div class="kv">
        <span>Цена</span><b>${fmtPrice(pr?.price ?? p.price)} ${changeHtml(priceChange(id))}</b>
        <span>Позиция</span><b>${esc(p.pos)}${p.alt?.length ? ` (${esc(p.alt.join(', '))})` : ''}</b>
        <span>Команда</span><b>${esc(p.team)}</b>
        <span>Страна</span><b>${flag(p.nation)} ${esc(p.nation)}</b>
        <span>Программа</span><b>${esc(p.program)}</b>
        <span>Зарплата</span><b>$${p.salary.toFixed(1)}M · ${p.ap} AP</b>
      </div>
    </div>
    <div class="section-title">Цена за последние часы</div>
    ${sparkline(pr?.history)}
    <div class="section-title">Лучше всего сыгрывается с</div>
    ${partners.length ? partners.map(({ player: q, reasons }) => `
      <div class="partner" data-id="${esc(q.id)}">
        <span class="badge" style="${cardStyle(q)}">${q.ovr}</span>
        <span class="info"><b>${flag(q.nation)} ${esc(q.name)}</b><small class="flat">${esc(q.pos)} · ${esc(q.team)}</small></span>
        <span class="chips">${reasons.map(r => `<span class="chip ${r.type} on">${r.label}: ${esc(r.value)}</span>`).join('')}</span>
      </div>`).join('') : '<p class="hint">Пока не с кем — загрузите больше игроков.</p>'}
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
}

function closeSheets() {
  $('#picker').hidden = true;
  $('#details').hidden = true;
}

// ---------- Данные ----------
async function loadPrices() {
  try {
    // Относительные пути: работает и с server.js, и на GitHub Pages.
    state.prices = await (await fetch(`data/prices.json?t=${Date.now()}`)).json();
  } catch {
    // цен нет — показываем price из players.json
  }
  renderMarket();
}

async function init() {
  const [players, lineup] = await Promise.all([
    fetch('data/players.json').then(r => r.json()),
    loadLineup(),
  ]);
  state.players = players;
  state.byId = Object.fromEntries(players.map(p => [p.id, p]));
  state.lineup = Object.fromEntries(Object.entries(lineup).filter(([, id]) => state.byId[id]));
  renderTeam();
  await loadPrices();
  setInterval(loadPrices, PRICE_REFRESH_MS);
}

// ---------- События ----------
document.querySelector('.tabbar').addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
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
  assign(state.pickerSlot, row.dataset.id);
  closeSheets();
});
$('#picker-remove').addEventListener('click', () => {
  delete state.lineup[state.pickerSlot];
  saveLineup();
  renderTeam();
  closeSheets();
});

$('#market-search').addEventListener('input', renderMarket);
$('#market-sort').addEventListener('change', renderMarket);
$('#market-list').addEventListener('click', e => {
  const row = e.target.closest('[data-id]');
  if (row) openDetails(row.dataset.id);
});
$('#details-content').addEventListener('click', e => {
  const row = e.target.closest('.partner[data-id]');
  if (row) openDetails(row.dataset.id);
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
  if (tg?.showConfirm && tg.initData) tg.showConfirm('Очистить весь состав?', doClear);
  else doClear(confirm('Очистить весь состав?'));
});

init();
