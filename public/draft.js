// Вкладка «Драфт»: драфт (команда из случайных карточек) и челлендж недели.
// Оба режима идут на обычном экране сборки состава. Сохранённый состав пользователя на это время
// откладывается (state.savedLineup) и возвращается при выходе.
//   Драфт: капитан → 20 игроков → тренер; на пик 5 вариантов (draft-core.js, общий с сервером),
//          среди них всегда есть хотя бы один «с бонусом». Лимита зарплаты нет, 3 перевыброса.
//   Химия — связи соседей, как в драфте FIFA (score-core.js): зелёная — один клуб, жёлтая — одна страна.
//   Варианты — лентой; удержание карточки показывает её связи в составе до выбора.
//   Челлендж: тот же драфт (state.draft.mode = 'challenge'), но варианты только из карточек под условие
//          недели и лимит зарплаты недели (challenge-core.js → challengeRules). В зачёт — лучшая попытка недели.

const DRAFT_KEY = 'hut-draft-v1';
const CHAL_KEY = 'hut-chal-draft-v1';
const POS_RU = { LW: 'левый нападающий', C: 'центральный', RW: 'правый нападающий', LD: 'левый защитник', RD: 'правый защитник', STARTER: 'основной вратарь', BACKUP: 'запасной вратарь' };
const DRAFT_LABEL = key => (key === 'CAPTAIN' ? 'Капитан' : key === 'COACH' ? 'Тренер' : `${LINE_LABELS[key.split('-')[0]]} · ${POS_RU[slotOf(key)]}`);
const DRAFT_SHORT = key => (key === 'CAPTAIN' ? 'Капитан' : key === 'COACH' ? 'Тренер' : `${LINE_LABELS[key.split('-')[0]]} · ${slotOf(key) === 'STARTER' ? 'G1' : slotOf(key) === 'BACKUP' ? 'G2' : slotOf(key)}`);
state.draftPeriod = 'day';

async function draftApi(path, body) {
  const res = await fetch(`api/${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || String(res.status)), { data });
  return data;
}

// Пул карточек драфта. Если на сервере уже новая версия (база обновилась, пока приложение открыто) —
// перечитываем файл, иначе варианты в приложении и на сервере не совпадут.
async function draftPool(v) {
  if (!state.draftPool || (v && state.draftPool.v !== v)) {
    state.draftPool = await (await fetch(`data/draft-pool.json${v ? `?v=${v}` : ''}`, v ? { cache: 'reload' } : {})).json();
  }
  return state.draftPool;
}

const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};
const keyOf = mode => (mode === 'challenge' ? CHAL_KEY : DRAFT_KEY);
const saveDraftLocal = () => store.set(keyOf(state.draft.mode), state.draft);
const loadDraftLocal = mode => store.get(keyOf(mode));
const clearDraftLocal = mode => store.del(keyOf(mode));
const isChal = () => state.draft?.mode === 'challenge';
// Правила генератора вариантов: обычный драфт или челлендж недели (только подходящие карточки, свой лимит).
const draftRules = () => (isChal() ? challengeRules(state.draft.ch, state.byId, state.captains) : DRAFT_RULES);

// ---------- Очки (драфт и челлендж) ----------
// Считаются общим кодом с сервером (score-core.js): что видит игрок, то и засчитает сервер.
const draftScore = () => scoreLineup(state.lineup, state.captain, state.coach,
  { byId: state.byId, combos: state.combos, captains: state.captains, coaches: state.coaches });

const lineupSalary = () => Math.round(DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH')
  .reduce((t, k) => t + (state.byId[state.lineup[k]]?.salary || 0), 0) * 10) / 10;
// Бонус Salary состава сейчас (звенья + капитан + тренер) — в драфте расширяет лимит, как в игре.
const draftSalBonus = () => draftScore().salBonus; // так же считает сервер (score-core.js)
const draftCap = () => (isChal() ? state.draft.ch.cap : DRAFT_CAP + (state.draft?.salAt?.[state.draft.pick] ?? draftSalBonus()));

// ---------- Вход и выход: драфт и челлендж идут на экране состава ----------
function enterBuildMode(lineup, captain, coach, mode) {
  state.savedLineup = { lineup: state.lineup, captain: state.captain, coach: state.coach };
  state.lineup = { ...lineup };
  state.captain = captain ?? null;
  state.coach = coach ?? null;
  state.staffOpen = null;
  document.body.classList.add('draft-mode');
  document.body.classList.toggle('challenge-mode', mode === 'challenge');
  $('#picker-search').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-team'));
  $('#team-mode [data-mode="lineup"]').click();
  window.scrollTo(0, 0);
  renderTeam();
}

function exitBuildMode() {
  const saved = state.savedLineup || { lineup: {}, captain: null, coach: null };
  state.draft = null;
  state.lineup = saved.lineup; state.captain = saved.captain; state.coach = saved.coach;
  state.savedLineup = null;
  document.body.classList.remove('draft-mode', 'challenge-mode');
  $('#draft-bar').hidden = true;
  $('#picker-search').hidden = false; // в драфте поиск прятали
  closeSheets();
  renderTeam();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-draft'));
  window.scrollTo(0, 0);
}

function confirmThen(text, fn) {
  const go = ok => ok && fn();
  if (tg?.showConfirm) tg.showConfirm(text, go); else go(window.confirm(text));
}

// ---------- Драфт и челлендж ----------
async function startDraft(fresh = false, mode = 'draft') {
  try {
    const res = await draftApi('draft/start', { fresh, mode });
    const pool = await draftPool(res.poolV);
    if (pool.v !== res.poolV) throw new Error('pool');
    const local = loadDraftLocal(mode);
    state.draft = local?.id === res.id ? local
      : { id: res.id, mode, ch: res.ch || null, week: res.week || null, seed: res.seed, poolV: res.poolV, pick: 0, picks: {}, rerolls: {}, salAt: {}, rerollsLeft: DRAFT_REROLLS };
    state.draft.mode = mode;
    if (res.ch) state.draft.ch = res.ch;
    state.draft.salAt ||= {};
    state.draftResult = null; // прошлый результат уже показан — при выходе вернёмся на главную вкладки
    saveDraftLocal();
    if (res.expired) toast(mode === 'challenge' ? 'Прошлая попытка челленджа устарела — не засчитана, попытка не потрачена' : 'База карточек обновилась — прошлый драфт не засчитан, попытка не потрачена');
    const p = state.draft.picks;
    enterBuildMode(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'CAPTAIN' && k !== 'COACH')), p.CAPTAIN, p.COACH, mode);
    haptic('medium');
    if (state.draft.pick >= DRAFT_ORDER.length) return finishDraft();
    setTimeout(openDraftPicker, 300);
  } catch (err) {
    const limit = mode === 'challenge' ? 'На сегодня попытки челленджа закончились — приходи завтра' : 'На сегодня драфты закончились — приходи завтра';
    toast(err.message === 'limit' ? limit : 'Не удалось начать, попробуй ещё раз');
  }
}

function decorateDraftTeam() {
  document.querySelectorAll('#lineup .card.now, #lineup .card.ghost, #staff .staff-tile.now, #staff .staff-tile.ghost')
    .forEach(e => e.classList.remove('now', 'ghost'));
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  const sc = draftScore();
  const spent = lineupSalary();
  const money = isChal()
    ? `💰 <b class="${spent > d.ch.cap ? 'over' : ''}">$${spent.toFixed(1)}M</b> / $${d.ch.cap}M`
    : `💰 <b>$${spent.toFixed(1)}M</b>`;
  $('#draft-bar').hidden = false;
  $('#draft-bar').innerHTML = `
    <div class="dbar"><button class="dx" data-draft="leave" aria-label="Выйти">✕</button>
      <div class="dt"><b>Пик ${Math.min(d.pick + 1, DRAFT_ORDER.length)} / ${DRAFT_ORDER.length}</b><small>${isChal() ? `${esc(d.ch.title)} · ` : ''}${key ? esc(DRAFT_LABEL(key)) : 'Готово'}</small></div>
      <div class="dsc"><b>${sc.total}</b><small>очков</small></div></div>
    ${isChal() ? `<div class="rules">${d.ch.rules.map(r => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
    <div class="dprog"><i style="width:${(d.pick / DRAFT_ORDER.length) * 100}%"></i></div>
    <div class="dmeta"><span>${money}</span><span>🔗 <b>${sc.links.total}</b>/${sc.links.max}</span>
      <span>🔄 <b>${d.rerollsLeft}</b></span>
      ${key ? '<button class="dnext" data-draft="open">Выбрать ›</button>' : ''}</div>`;
  const mark = (k, cls) => {
    if (k === 'CAPTAIN' || k === 'COACH') document.querySelector(`#staff [data-staff="${k === 'CAPTAIN' ? 'captain' : 'coach'}"]`)?.classList.add(cls);
    else if (k) document.querySelector(`#lineup [data-slot="${k}"]`)?.classList.add(cls);
  };
  mark(key, state.draftPreview ? 'ghost' : 'now');
  document.querySelectorAll('#staff .staff-tile').forEach(t => {
    const n = t.querySelector('.staff-name');
    if (n && n.textContent.trim() === 'Выбрать') n.textContent = t.dataset.staff === 'coach' ? 'Последний пик' : 'Первый пик';
  });
  drawDraftLinks();
}

// Связи соседей поверх состава: зелёная — один клуб, жёлтая — одна страна, красная — нет связи.
function drawDraftLinks() {
  const L = lineupLinks(state.lineup, state.byId);
  const pv = state.draftPreview?.key;
  const title = { g: 'Один клуб · +3', y: 'Одна страна · +1', r: 'Нет связи' };
  for (const line of LINES) {
    const el = document.querySelector(`#lineup .line[data-line="${line.id}"]`);
    if (!el) continue;
    const slots = el.querySelector('.slots');
    slots.classList.add('linked');
    L.links.filter(l => l.line === line.id).forEach((l, i) => {
      const bar = document.createElement('span');
      bar.className = `dlink n${line.slots.length} i${i}${l.kind ? ` ${l.kind}` : ''}${pv && l.kind && (l.a === pv || l.b === pv) ? ' pv' : ''}`;
      bar.title = title[l.kind] || 'Связь появится, когда оба слота заполнены';
      slots.append(bar);
    });
    const chips = el.querySelector('.line-head .chips');
    if (chips) chips.innerHTML = `<span class="lchem${L.byLine[line.id] ? ' on' : ''}">химия +${L.byLine[line.id]}</span>`;
  }
}

// Верх экрана в драфте: средний OVR карточек, зарплата (лимит — только в челлендже), химия связей вместо AP.
function decorateDraftSummary() {
  const sc = draftScore();
  const ovr = Math.round(sc.avgOvr) || 0;
  $('#sum-ovr').textContent = ovr || '—';
  $('#ovr-arc').style.strokeDashoffset = RING * (1 - (ovr ? Math.min(1, Math.max(0.04, (ovr - 60) / 39)) : 0));
  const spent = lineupSalary();
  if (isChal()) {
    const cap = state.draft.ch.cap;
    const over = spent > cap;
    $('#sum-cap').textContent = `/ $${cap}M`;
    $('#sum-salary').classList.toggle('over', over);
    $('#bar-salary').classList.toggle('over', over);
    $('#bar-salary i').style.width = `${Math.min(100, (spent / cap) * 100)}%`;
  } else {
    $('#sum-cap').textContent = '· без лимита';
    $('#sum-salary').classList.remove('over');
    $('#bar-salary').style.visibility = 'hidden';
  }
  $('#ap-label').textContent = 'Химия связей';
  $('#sum-ap').textContent = sc.links.total;
  $('#ap-max').textContent = `/ ${sc.links.max}`;
  $('#bar-ap i').style.width = `${Math.min(100, (sc.links.total / sc.links.max) * 100)}%`;
}

$('#draft-bar').addEventListener('click', e => {
  const act = e.target.closest('[data-draft]')?.dataset.draft;
  if (act === 'leave') {
    confirmThen(isChal() ? 'Выйти из челленджа? Попытка сохранится — продолжишь с того же пика.' : 'Выйти из драфта? Он сохранится — продолжишь с того же пика.',
      () => { exitBuildMode(); renderDraftHome(); });
  }
  if (act === 'open') openDraftPicker();
});

function draftSlotTap(key) {
  const now = DRAFT_ORDER[state.draft.pick];
  if (key === now) return openDraftPicker();
  toast(now ? `Сейчас пик: ${DRAFT_SHORT(now)}` : 'Пики закончились');
}

// Даёт ли вариант бонус: игрок — зелёная или жёлтая связь с соседом либо +1 к капитану; тренер — хоть одна комбинация.
function draftHasBonus(key, id) {
  if (key === 'CAPTAIN') return true;
  if (key === 'COACH') { const c = coachById(id); return !!c && coachStatus(c, state.lineup, state.byId).activeCount > 0; }
  const p = state.byId[id];
  if (!p) return false;
  const cap = state.byId[state.captain];
  const rule = cap && captainRuleFor(cap, state.captains);
  if (rule && captainMatch(p, rule) && !captainStatus(cap, lineupPlayers(), state.captains).met) return true;
  return slotNeighbours(key).some(k => ['g', 'y'].includes(linkKind(p, state.byId[state.lineup[k]])));
}

function dealDraft() {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  if (d.salAt[d.pick] == null) { d.salAt[d.pick] = draftSalBonus(); saveDraftLocal(); }
  const { opts, extra } = draftDeal(state.draftPool, d.seed, d.pick, d.rerolls[d.pick] || 0, d.picks, d.salAt[d.pick], draftRules());
  const options = opts.slice();
  // В каждой пятёрке хотя бы один вариант с бонусом — берём первый подходящий из запасного списка.
  if (key !== 'CAPTAIN' && options.length && !options.some(id => draftHasBonus(key, id))) {
    const bonus = extra.find(id => draftHasBonus(key, id));
    if (bonus != null) options[(d.seed + d.pick) % options.length] = bonus;
  }
  d.options = options;
}

function openDraftPicker() {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  if (!key || !state.draftPool) return;
  dealDraft();
  openPicker(key);
}

// Меню выбора в драфте: 5 карточек лентой. У каждой — связи с соседями по звену и бонус капитана.
// Нажатие — выбор, удержание — превью связей в составе (startDraftPreview).
function renderDraftOptions() {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  $('#picker').classList.add('dpick');
  $('#picker-title').textContent = `Пик ${d.pick + 1} · ${DRAFT_SHORT(key)}`;
  ['#picker-remove', '#picker-accent', '#picker-search'].forEach(s => { $(s).hidden = true; });
  $('#picker-allpos').parentElement.hidden = true;
  const chip = (cls, t) => `<i class="${cls}">${t}</i>`;
  // Рейтинг под картинкой — запасной вариант: виден, только если картинки нет или она не загрузилась.
  const img = p => `<span class="dimg" style="${cardStyle(p)}">${cardImg(p, true)}<span class="dovr">${p.ovr}<small>${esc(p.pos)}</small></span></span>`;
  let cards = '';
  if (key === 'COACH') {
    cards = d.options.map(id => coachById(id)).filter(Boolean).map(c => {
      const st = coachStatus(c, state.lineup, state.byId);
      const t = st.total;
      return `<button class="dopt" type="button" data-coach="${esc(c.id)}"><span class="dimg coach-thumb">${coachImg(c, true)}</span>
        <b class="dn">${esc(c.name)}</b><small class="dt2">${esc(c.team || '')}</small>
        <span class="dchips">${chip(st.activeCount ? 'g' : 'z', `${st.activeCount}/${st.combos.length} комб.`)}${t.OVR ? chip('o', `+${t.OVR} OVR`) : ''}${t.SAL ? chip('s', `+$${t.SAL}M`) : ''}${t.AP ? chip('a', `+${t.AP} AP`) : ''}</span></button>`;
    }).join('');
  } else if (key === 'CAPTAIN') {
    cards = d.options.map(id => state.byId[id]).filter(Boolean).map(p => {
      const r = captainRuleFor(p, state.captains);
      return `<button class="dopt" type="button" data-id="${p.id}">${img(p)}<b class="dn">${esc(p.name)}</b>
        <small class="dt2">${flag(p.nation)} ${esc(p.team)}</small>
        <span class="dchips">${r ? chip('cap', `👑 ${esc(captainBonusText(r).replace(/<[^>]+>/g, ''))} · нужно ${r.needed}`) : ''}</span></button>`;
    }).join('');
  } else {
    const cap = state.byId[state.captain];
    const rule = cap && captainRuleFor(cap, state.captains);
    const have = rule ? captainStatus(cap, lineupPlayers(), state.captains).count : 0;
    const mates = slotNeighbours(key).map(k => state.byId[state.lineup[k]]).filter(Boolean);
    const word = { g: 'клуб', y: 'страна', r: 'нет связи' };
    cards = d.options.map(id => state.byId[id]).filter(Boolean).map(p => {
      const links = mates.length ? mates.map(m => { const k = linkKind(p, m); return chip(k, `${word[k]} · ${esc(surname(m.name))}`); }).join('') : chip('z', 'соседей пока нет');
      const capTxt = rule && captainMatch(p, rule) && have < rule.needed ? chip('cap', `👑 +1 к капитану · ${have + 1}/${rule.needed}`) : '';
      return `<button class="dopt" type="button" data-id="${p.id}">${img(p)}<b class="dn">${esc(p.name)}</b>
        <small class="dt2">${flag(p.nation)} ${esc(p.team)} · $${p.salary}M</small><span class="dchips">${links}${capTxt}</span></button>`;
    }).join('');
  }
  const money = isChal() && key !== 'CAPTAIN' && key !== 'COACH' ? ` · осталось <b>$${(draftCap() - lineupSalary()).toFixed(1)}M</b>` : '';
  $('#picker-list').innerHTML = `<div class="dpick-head"><span>Выбери <b>1 из 5</b>${money}</span><span>зажми — покажем связи</span></div>
    <div class="dopts">${cards || '<p class="hint">Нет подходящих карточек</p>'}</div>
    ${d.rerollsLeft > 0 ? `<button class="dskip" data-reroll>🔄 Перевыбросить варианты · осталось ${d.rerollsLeft}</button>` : ''}`;
}

// ---------- Удержание карточки: превью связей до выбора ----------
let dHold = null;
function startDraftPreview(opt) {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  const id = key === 'COACH' ? opt.dataset.coach : Number(opt.dataset.id);
  const before = draftScore();
  state.draftPreview = { key, saved: { lineup: state.lineup, captain: state.captain, coach: state.coach } };
  state.lineup = { ...state.lineup };
  if (key === 'CAPTAIN') state.captain = id;
  else if (key === 'COACH') state.coach = id;
  else state.lineup[key] = id;
  const after = draftScore();
  const name = key === 'COACH' ? coachById(id)?.name : state.byId[id]?.name;
  const diff = after.links.total - before.links.total;
  $('#picker').classList.add('peek');
  const head = $('#picker-list .dpick-head');
  if (head) {
    head.innerHTML = `<span><b>${esc(name || '')}</b> · химия ${before.links.total} → <b class="${diff > 0 ? 'up' : ''}">${after.links.total}</b>${diff > 0 ? ` (+${diff})` : ''}
      · очки ${before.total} → <b>${after.total}</b></span><span>отпусти — вернёмся</span>`;
  }
  renderTeam();
  const target = key === 'CAPTAIN' || key === 'COACH'
    ? document.querySelector(`#staff [data-staff="${key === 'CAPTAIN' ? 'captain' : 'coach'}"]`)
    : document.querySelector(`#lineup [data-slot="${key}"]`);
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  haptic('light');
}

function endDraftPreview() {
  const pv = state.draftPreview;
  if (!pv) return;
  state.lineup = pv.saved.lineup;
  state.captain = pv.saved.captain;
  state.coach = pv.saved.coach;
  state.draftPreview = null;
  $('#picker').classList.remove('peek');
  renderTeam();
  renderDraftOptions();
}

function releaseDraftHold() {
  if (!dHold) return;
  clearTimeout(dHold.timer);
  dHold.opt.classList.remove('held');
  if (dHold.on) {
    state.draftSuppressClick = true; // отпускание после превью — не выбор
    setTimeout(() => { state.draftSuppressClick = false; }, 400);
    endDraftPreview();
  }
  dHold = null;
}

$('#picker-list').addEventListener('pointerdown', e => {
  if (!state.draft) return;
  const opt = e.target.closest('.dopt');
  if (!opt) return;
  opt.classList.add('held');
  dHold = { opt, x: e.clientX, y: e.clientY, on: false, timer: setTimeout(() => { dHold.on = true; startDraftPreview(opt); }, 320) };
});
$('#picker-list').addEventListener('pointermove', e => {
  // Палец поехал — это прокрутка ленты, а не удержание.
  if (dHold && !dHold.on && (Math.abs(e.clientX - dHold.x) > 8 || Math.abs(e.clientY - dHold.y) > 8)) {
    clearTimeout(dHold.timer);
    dHold.opt.classList.remove('held');
    dHold = null;
  }
});
window.addEventListener('pointerup', releaseDraftHold);
window.addEventListener('pointercancel', releaseDraftHold);
$('#picker-list').addEventListener('contextmenu', e => { if (state.draft) e.preventDefault(); });

function draftChoose(e) {
  const d = state.draft;
  if (state.draftSuppressClick || state.draftPreview) { state.draftSuppressClick = false; return; }
  if (e.target.closest('[data-reroll]')) {
    if (d.rerollsLeft <= 0) return;
    d.rerolls[d.pick] = (d.rerolls[d.pick] || 0) + 1;
    d.rerollsLeft--;
    saveDraftLocal();
    haptic();
    dealDraft();
    renderDraftOptions();
    renderTeam();
    return;
  }
  const key = DRAFT_ORDER[d.pick];
  const row = e.target.closest(key === 'COACH' ? '[data-coach]' : '[data-id]');
  if (!row) return;
  const id = key === 'COACH' ? row.dataset.coach : Number(row.dataset.id);
  if (!d.options.includes(id)) return;
  d.picks[key] = id;
  if (key === 'CAPTAIN') state.captain = id;
  else if (key === 'COACH') state.coach = id;
  else state.lineup[key] = id;
  d.pick++;
  saveDraftLocal();
  closeSheets();
  renderTeam();
  haptic('medium');
  if (d.pick >= DRAFT_ORDER.length) return finishDraft();
  setTimeout(openDraftPicker, 380);
}

async function finishDraft() {
  const d = state.draft;
  const sc = draftScore();
  try {
    const res = await draftApi('draft/finish', { id: d.id, picks: d.picks, rerolls: d.rerolls });
    // Показываем очки, которые засчитал сервер (он пересчитывает их сам).
    const b = res.breakdown || {};
    state.draftResult = { ...sc, ...(res.already ? {} : { base: b.base, avgOvr: b.avgOvr, chem: b.chem, captain: b.captain, coach: b.coach }),
      total: res.score, place: res.place, best: res.best, left: res.left, mode: d.mode, ch: d.ch, picks: { ...d.picks } };
    clearDraftLocal(d.mode);
    exitBuildMode();
    renderDraftResult();
    haptic('heavy');
  } catch (err) {
    const code = err.data?.error;
    if (['pool_changed', 'week_over', 'invalid', 'abandoned'].includes(code)) {
      // Результат не принят, и повторять бессмысленно — выходим.
      clearDraftLocal(d.mode);
      exitBuildMode();
      renderDraftHome();
      return toast({
        pool_changed: 'Пока шла попытка, обновилась база карточек — не засчитана, попытка не потрачена',
        week_over: 'Неделя челленджа закончилась — попытка не засчитана и не потрачена',
      }[code] || 'Попытка не прошла проверку на сервере и не засчитана');
    }
    toast('Не удалось сохранить результат — проверь связь и попробуй ещё раз');
  }
}

function draftCardsGrid(picks) {
  return `<div class="dgrid">${DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH').map(k => {
    const p = state.byId[picks[k]];
    return `<div class="dmini" style="${p ? cardStyle(p) : ''}">${p ? cardImg(p, true) : ''}</div>`;
  }).join('')}</div>`;
}

function renderDraftResult() {
  const r = state.draftResult;
  const cap = state.byId[r.picks.CAPTAIN];
  const coach = coachById(r.picks.COACH);
  const pct = Math.min(1, r.total / 520);
  const chips = b => ['OVR', 'SAL', 'AP'].filter(t => b?.[t]).map(t => `<i class="${t === 'OVR' ? 'c' : t === 'SAL' ? 's' : 'a'}">${boostText(t, b[t])}</i>`).join('');
  $('#draft-home').innerHTML = `
    <section class="glass dres"><div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="tr"/>
      <circle cx="60" cy="60" r="52" class="vl" stroke-dasharray="327" stroke-dashoffset="${(327 * (1 - pct)).toFixed(0)}"/></svg><b>${r.total}</b><small>ОЧКОВ</small></div>
      <div class="place">${r.mode === 'challenge'
        ? `<b>#${r.place}</b> в челлендже<br><span class="muted">«${esc(r.ch?.title || '')}» · лучший за неделю: ${r.best ?? r.total}<br>попыток сегодня: ${r.left > 50 ? '∞' : r.left}</span>`
        : `<b>#${r.place}</b> за сегодня<br><span class="muted">драфтов осталось: ${r.left > 50 ? '∞' : r.left}</span>`}</div></section>
    <section class="glass staffres">
      <div class="sr"><span class="badge" style="${cap ? cardStyle(cap) : ''}">${cap ? cardImg(cap, true) : ''}</span><div><small>КАПИТАН</small><b>${esc(cap?.name || '—')}</b>
        <span class="${r.capInfo?.met ? 'ok' : 'muted'}">${r.capInfo ? `${Math.min(r.capInfo.count, r.capInfo.needed)}/${r.capInfo.needed} игроков` : ''}${r.captain ? ` · +${r.captain}` : ''}</span></div></div>
      <div class="sr"><span class="badge coach-thumb">${coach ? coachImg(coach, true) : ''}</span><div><small>ТРЕНЕР</small><b>${esc(coach?.name || '—')}</b>
        <span class="${r.coachInfo?.active ? 'ok' : 'muted'}">${r.coachInfo ? `${r.coachInfo.active}/${r.coachInfo.of} комбинаций` : ''}</span></div></div></section>
    <section class="glass brk"><div class="dk">ИЗ ЧЕГО СЛОЖИЛОСЬ</div>
      <div class="br"><span>Средний OVR карточек</span><em>${r.avgOvr}</em><b>${r.base}</b></div>
      <div class="br"><span>Химия связей</span><em class="chipline">${r.links ? `<i class="lk g">${r.links.g} клуб</i><i class="lk y">${r.links.y} страна</i> ${r.links.total}/${r.links.max}` : '—'}</em><b>+${r.chem}</b></div>
      <div class="br"><span>Капитан</span><em>${r.captain ? `+${r.captain}` : 'бонус не собран'}</em><b>+${r.captain}</b></div>
      <div class="br"><span>Тренер</span><em class="chipline">${chips(r.coachInfo?.total) || '—'}</em><b>+${r.coach}</b></div>
      <div class="br tot"><span>Итого</span><em></em><b>${r.total}</b></div></section>
    ${draftCardsGrid(r.picks)}
    <div class="two"><button class="btn-primary" data-draft-act="share">📤 Поделиться</button><button class="ghostbtn" data-draft-act="home">К таблице</button></div>
    ${r.left > 0 ? `<button class="ghostbtn wide" data-draft-act="${r.mode === 'challenge' ? 'chal-new' : 'new'}">${r.mode === 'challenge' ? 'Ещё попытка' : 'Ещё драфт'} · осталось ${r.left > 50 ? '∞' : r.left} сегодня</button>` : ''}`;
  window.scrollTo(0, 0);
}

const untilText = t => {
  const s = Math.max(0, t - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d ? `${d}д ${h}ч` : `${h}ч ${Math.floor((s % 3600) / 60)}м`;
};

// ---------- Главная вкладки ----------
async function renderDraftHome() {
  if (state.draft) return;
  if (state.draftResult && !state.draftResultShown) { state.draftResultShown = true; return renderDraftResult(); }
  const el = $('#draft-home');
  let b, c;
  try { [b, c] = await Promise.all([draftApi(`draft/board?period=${state.draftPeriod}`), draftApi('challenge/board')]); }
  catch { el.innerHTML = '<p class="hint">Нет связи с сервером. Попробуй позже.</p>'; return; }
  draftPool().catch(() => {});
  const local = loadDraftLocal('draft');
  const resumePick = b.active && local ? local.pick : 0;
  const chLocal = loadDraftLocal('challenge');
  const chResume = c.active && chLocal?.week === c.week ? chLocal.pick : 0;
  const chLeft = c.left > 50 ? '∞' : c.left;
  const medal = i => ['🥇', '🥈', '🥉'][i] || String(i + 1);
  const row = (r, i) => `<div class="lrow${r.me ? ' me' : ''}"><span class="pl">${medal(i)}</span><span class="nm">${esc(r.name)}${r.me ? ' <i>вы</i>' : ''}</span><b>${r.score}</b></div>`;
  const left = b.left > 50 ? '∞' : b.left;
  el.innerHTML = `
    <section class="ddraft glass"><div class="dk">ДРАФТ</div>
      <h2>Собери команду из случайных карточек</h2>
      <p class="dsub">Как обычная сборка состава, но на каждый пик — 5 случайных вариантов</p>
      <div class="steps"><div class="st"><span class="ic">👑</span><b>Капитан</b><small>пик 1</small></div><i class="ar">→</i>
        <div class="st"><span class="ic">🏒</span><b>20 игроков</b><small>пики 2–21</small></div><i class="ar">→</i>
        <div class="st"><span class="ic">📋</span><b>Тренер</b><small>пик 22</small></div></div>
      <div class="rules"><span>🃏 все ${state.draftPool ? state.draftPool.players.length.toLocaleString('ru-RU') : '8 000+'} карточек базы</span><span>🎴 1 из 5 на пик</span><span>✨ всегда есть вариант с бонусом</span><span>🔄 ${DRAFT_REROLLS} перевыброса</span><span>💸 без лимита зарплаты</span><span>🔗 химия: клуб +3 · страна +1</span></div>
      ${b.active ? `<div class="resume"><div><b>Незаконченный драфт</b><small>${resumePick ? `пик ${resumePick + 1} из ${DRAFT_ORDER.length}` : 'можно продолжить'}</small></div>
        <button class="ghostbtn sm" data-draft-act="resume">Продолжить</button></div>` : ''}
      <div class="meta3"><div><b>${b.today.best || '—'}</b><small>лучший сегодня</small></div><div><b>${b.me && state.draftPeriod === 'day' ? `#${b.me.place}` : '—'}</b><small>место за день</small></div>
        <div><b>${left}</b><small>драфтов осталось</small></div></div>
      <button class="btn-primary" data-draft-act="new" ${b.left <= 0 ? 'disabled' : ''}>${b.left <= 0 ? 'Драфты на сегодня закончились' : b.active ? 'Начать новый драфт' : 'Начать драфт'}</button>
      <p class="hint dscore-hint">Очки: 4 × средний OVR карточек + 2 × химия связей + бонусы капитана и тренера.<br>🏆 №1 недели — месяц доступа, №1 месяца — год.</p></section>

    <section class="dchal glass"><div class="dk">ЧЕЛЛЕНДЖ НЕДЕЛИ <span class="dk-r">${untilText(c.endsAt)}</span></div>
      <h2>${esc(c.ch.title)}</h2>
      <p class="dsub">Драфт по условию недели: на каждый пик 1 из 5 карточек, подходящих под условие</p>
      <div class="rules">${c.ch.rules.map(r => `<span>${esc(r)}</span>`).join('')}<span>🎴 1 из 5 на пик</span><span>🔗 химия связей</span></div>
      ${c.active ? `<div class="resume"><div><b>Незаконченная попытка</b><small>${chResume ? `пик ${chResume + 1} из ${DRAFT_ORDER.length}` : 'можно продолжить'}</small></div>
        <button class="ghostbtn sm" data-draft-act="chal-resume">Продолжить</button></div>` : ''}
      <div class="chalfoot"><span>${c.me ? `Ваш лучший: <b>${c.me.score}</b> · <b>#${c.me.place}</b> из ${c.players}` : `Участников: ${c.players}`}</span><span class="prize">🎁 месяц доступа</span></div>
      ${c.top.length ? `<div class="chaltop">${c.top.slice(0, 3).map(row).join('')}</div>` : ''}
      <button class="ghostbtn wide" data-draft-act="chal-new" ${c.left <= 0 ? 'disabled' : ''}>${c.left <= 0 ? 'Попытки на сегодня закончились'
        : `${c.active ? 'Начать новую попытку' : c.me ? 'Улучшить результат' : 'Начать челлендж'} · осталось ${chLeft} сегодня`}</button></section>

    <section class="glass dlead"><div class="dk">ЛИДЕРЫ ДРАФТА</div>
      <div class="segmented small" id="draft-period">${[['day', 'День'], ['week', 'Неделя'], ['all', 'Всё время']].map(([k, t]) => `<button data-period="${k}" class="${k === state.draftPeriod ? 'active' : ''}">${t}</button>`).join('')}</div>
      ${b.top.map(row).join('') || '<p class="hint">Пока никто не сыграл — будь первым!</p>'}
      ${b.me && !b.top.some(r => r.me) ? `<div class="sep">…</div><div class="lrow me"><span class="pl">${b.me.place}</span><span class="nm">Вы</span><b>${b.me.score}</b></div>` : ''}
      <p class="hint" style="margin:8px 0 0">Игроков в таблице: ${b.players}</p></section>`;
}

$('#draft-home').addEventListener('click', e => {
  const period = e.target.closest('[data-period]')?.dataset.period;
  if (period) { state.draftPeriod = period; haptic(); return renderDraftHome(); }
  const act = e.target.closest('[data-draft-act]')?.dataset.draftAct;
  if (!act) return;
  if (act === 'resume') return startDraft(false);
  if (act === 'chal-resume') return startDraft(false, 'challenge');
  if (act === 'chal-new') {
    if (e.target.closest('.dchal')?.querySelector('.resume')) {
      return confirmThen('Начать новую попытку? Незаконченная будет засчитана как сыгранная.', () => startDraft(true, 'challenge'));
    }
    return startDraft(true, 'challenge');
  }
  if (act === 'new') {
    if (e.target.closest('.ddraft')?.querySelector('.resume')) {
      return confirmThen('Начать новый драфт? Незаконченный будет засчитан как сыгранный.', () => startDraft(true));
    }
    return startDraft(true);
  }
  if (act === 'home') { state.draftResult = null; return renderDraftHome(); }
  if (act === 'share') {
    const r = state.draftResult;
    const link = state.me?.refLink || '';
    const text = r.mode === 'challenge'
      ? `🏒 Набрал ${r.total} очков в челлендже «${r.ch?.title || ''}» HUT Builder (#${r.place}). Побьёшь?`
      : `🏒 Набрал ${r.total} очков в драфте HUT Builder (#${r.place} за сегодня). Побьёшь?`;
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  }
});
