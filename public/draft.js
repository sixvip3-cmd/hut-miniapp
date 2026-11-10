// Вкладка «Драфт»: драфт (команда из случайных карточек) и челлендж недели — на отдельном экране, как в FUT Draft.
//   1. Капитан — первый пик, сразу встаёт в состав на свою позицию.
//   2. Дальше игрок сам выбирает, какую позицию (или тренера) драфтовать: нажимает пустой слот —
//      выпадает 4 варианта (draft-core.js, общий с сервером). Всего 21 пик, 3 перевыброса.
//   3. Когда все выбраны — расстановка: можно менять местами игроков одной позиции между звеньями.
//   4. Оценка — две шкалы по 100: рейтинг команды и сыгранность (score-core.js); итог — сумма (до 200).
// Сыгранность у каждого игрока: половина — с капитаном (клуб +3, страна +2, лига +1),
// половина — с партнёрами по звену (те же правила). Челлендж — тот же драфт по условию недели.

const DRAFT_KEY = 'hut-draft-v3';
const CHAL_KEY = 'hut-chal-draft-v3';
const SLOT_SHORT = key => (key === 'CAPTAIN' ? 'Капитан' : key === 'COACH' ? 'Тренер'
  : `${LINE_LABELS[key.split('-')[0]]} · ${{ STARTER: 'G1', BACKUP: 'G2' }[key.split('-')[1]] || key.split('-')[1]}`);
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
const saveDraftLocal = () => { const { preview, sel, options, optKey, ...d } = state.draft; store.set(keyOf(d.mode), d); };
const loadDraftLocal = mode => store.get(keyOf(mode));
const clearDraftLocal = mode => store.del(keyOf(mode));

// ---------- Состояние драфта ----------
const D = () => state.draft;
const isChal = () => D()?.mode === 'challenge';
const draftData = () => ({ byId: state.byId, combos: state.combos, captains: state.captains, coaches: state.coaches });
const draftRules = () => (isChal() ? challengeRules(D().ch, state.byId) : DRAFT_RULES);
const pickIndex = () => D().order.length;
const allPicked = () => D().order.length >= DRAFT_PICKS;
// Текущий состав: после всех пиков — расстановка игрока, до этого — из пиков (капитан в своём слоте).
const curLineup = () => D().lineup || lineupFromDraftPicks(D().picks, state.byId);
const curCoach = () => D().picks.COACH ?? null;
function draftScoreOf(lineup = curLineup(), coach = curCoach(), captain = D().picks.CAPTAIN) {
  return scoreLineup(lineup, captain ?? null, coach, draftData());
}

// ---------- Старт / продолжение ----------
async function startDraft(fresh = false, mode = 'draft') {
  try {
    const res = await draftApi('draft/start', { fresh, mode });
    const pool = await draftPool(res.poolV);
    if (pool.v !== res.poolV) throw new Error('pool');
    const local = loadDraftLocal(mode);
    state.draft = local?.id === res.id && Array.isArray(local.order) ? local
      : { id: res.id, mode, ch: res.ch || null, week: res.week || null, seed: res.seed, poolV: res.poolV, picks: {}, order: [], rerolls: {}, rerollsLeft: DRAFT_REROLLS, lineup: null };
    state.draft.mode = mode;
    if (res.ch) state.draft.ch = res.ch;
    state.draftResult = null;
    saveDraftLocal();
    if (res.expired) toast(mode === 'challenge' ? 'Прошлая попытка челленджа устарела — не засчитана, попытка не потрачена' : 'База карточек обновилась — прошлый драфт не засчитан, попытка не потрачена');
    openDraftScreen();
    haptic('medium');
    if (!D().order.length) setTimeout(() => D() && openDraftPick('CAPTAIN'), 250);
  } catch (err) {
    const limit = mode === 'challenge' ? 'На сегодня попытки челленджа закончились — приходи завтра' : 'На сегодня драфты закончились — приходи завтра';
    toast(err.message === 'limit' ? limit : 'Не удалось начать, попробуй ещё раз');
  }
}

function openDraftScreen() {
  $('#draft-screen').hidden = false;
  document.body.classList.add('draft-open');
  renderDraftScreen();
  $('#draft-screen').scrollTop = 0;
}

function closeDraftScreen() {
  state.draft = null;
  $('#ds-pick').hidden = true;
  $('#draft-screen').hidden = true;
  document.body.classList.remove('draft-open');
}

function confirmThen(text, fn) {
  const go = ok => ok && fn();
  if (tg?.showConfirm) tg.showConfirm(text, go); else go(window.confirm(text));
}

// ---------- Экран драфта ----------
const starsHtml = n => `<span class="ds-stars s${n}"><i></i><i></i><i></i></span>`;
function miniCard(key, lineup, team, open) {
  const d = D();
  const id = lineup[key];
  const p = state.byId[id];
  if (!p) {
    return `<button class="ds-card empty${open.includes(key) ? ' open' : ''}" data-slot="${key}" type="button"><span class="ds-plus">+</span><span class="ds-pos">${esc(SLOT_SHORT(key).split(' · ')[1])}</span></button>`;
  }
  const isCap = id === (d.preview ? d.preview.captain : d.picks.CAPTAIN);
  const ghost = d.preview && d.preview.slot === key;
  const pl = team.players[key];
  return `<button class="ds-card${isCap ? ' cap' : ''}${d.sel === key ? ' sel' : ''}${ghost ? ' ghost' : ''}" data-slot="${key}" type="button" style="${cardStyle(p)}">
    ${cardImg(p, true)}<span class="ds-ovr">${p.ovr}<small>${esc(p.pos)}</small></span>
    ${isCap ? '<span class="ds-c">C</span>' : ''}${pl ? starsHtml(pl.stars) : ''}<span class="ds-nm">${esc(p.name.split(' ').slice(-1)[0])}</span></button>`;
}

function renderDraftScreen() {
  const d = D();
  if (!d) return;
  const lineup = d.preview ? d.preview.lineup : curLineup();
  const coach = d.preview ? d.preview.coach : curCoach();
  const captain = d.preview ? d.preview.captain : d.picks.CAPTAIN;
  const sc = draftScoreOf(lineup, coach, captain);
  const team = sc.team;
  const arrange = allPicked();
  const open = d.order.length && !arrange ? openPicks(state.draftPool, d.picks) : [];
  const lines = LINES.map(line => {
    const keys = line.slots.map(s => `${line.id}-${s}`);
    const links = team.links.filter(l => l.a.startsWith(`${line.id}-`));
    const filled = keys.filter(k => team.players[k]).length;
    const chem = filled ? Math.round((keys.reduce((t, k) => t + (team.players[k]?.chem || 0), 0) / filled) * 100) : 0;
    return `<div class="ds-line"><div class="ds-lh"><span>${esc(line.label.replace('Звено ', 'Звено\u00a0'))}</span><em class="${chem >= 67 ? 'g' : chem >= 34 ? 'y' : 'r'}">${filled ? `⚗ ${chem}` : ''}</em></div>
      <div class="ds-slots n${keys.length}">${keys.map(k => miniCard(k, lineup, team, open)).join('')}
        ${links.map((l, i) => `<span class="ds-link n${keys.length} i${i}${l.kind ? ` ${l.kind}` : ''}"></span>`).join('')}</div></div>`;
  }).join('');
  const cap = state.byId[captain];
  const coachObj = coach ? coachById(coach) : null;
  const coachOpen = open.includes('COACH');
  const step = !d.order.length ? 'Выбери капитана'
    : arrange ? 'Расстановка: нажми игрока, потом другого той же позиции'
    : `Пик ${pickIndex() + 1} из ${DRAFT_PICKS} · нажми пустую позицию или тренера`;
  $('#draft-screen').innerHTML = `
    <header class="ds-top">
      <button class="ds-x" data-ds="leave" type="button" aria-label="Выйти">✕</button>
      <div class="ds-ttl"><b>${isChal() ? esc(d.ch.title) : 'Драфт'} <em class="test-badge">ТЕСТ</em></b><small>${esc(step)}</small></div>
      <span class="ds-rr" title="Перевыбросы">🔄 ${d.rerollsLeft}</span>
    </header>
    <div class="ds-meters">
      <div class="ds-m"><span>Рейтинг</span><b>${sc.rating || '—'}<small>/100</small></b><div class="ds-bar r"><i style="width:${sc.rating}%"></i></div></div>
      <div class="ds-m"><span>Сыгранность</span><b>${sc.chem}<small>/100</small></b><div class="ds-bar c"><i style="width:${sc.chem}%"></i></div></div>
      <div class="ds-tot"><b>${sc.total}</b><small>из 200</small></div>
    </div>
    ${isChal() ? `<div class="ds-rules">${d.ch.rules.map(r => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
    <div class="ds-rink">${lines}</div>
    <div class="ds-staff">
      <div class="ds-st">${cap ? `<span class="ds-sti" style="${cardStyle(cap)}">${cardImg(cap, true)}</span>` : '<span class="ds-sti empty">👑</span>'}
        <div><small>Капитан</small><b>${cap ? esc(cap.name) : '—'}</b><em>${cap ? `в составе · ${esc(SLOT_SHORT(team.capSlot || captainSlotFor(cap.pos)))}` : 'первый пик'}</em></div></div>
      <button class="ds-st${coachOpen ? ' open' : ''}" data-ds="coach" type="button">${coachObj ? `<span class="ds-sti coach-thumb">${coachImg(coachObj, true)}</span>` : '<span class="ds-sti empty">📋</span>'}
        <div><small>Тренер</small><b>${coachObj ? esc(coachObj.name) : coachOpen ? 'Выбрать' : '—'}</b><em>${coachObj ? `комбинации ${sc.coachInfo?.active || 0}/${sc.coachInfo?.of || 0}${sc.coachOvr ? ` · +${sc.coachOvr} OVR` : ''}` : 'в любой момент'}</em></div></button>
    </div>
    <div class="ds-foot">
      ${arrange
        ? `<button class="btn-primary" data-ds="finish" type="button">Завершить драфт · ${sc.total} из 200</button>
           <p class="hint">Меняются местами игроки одной позиции (например, центры разных звеньев). Сыгранность пересчитывается сразу.</p>`
        : `<p class="hint">🎴 1 из ${DRAFT_OPTIONS} на пик · связи: <i class="lk g"></i>сильная <i class="lk y"></i>частичная <i class="lk r"></i>нет · ●●● — сыгранность игрока · 100 = почти все связаны</p>`}
    </div>`;
}

// Нажатия на экране драфта: выбор позиции, тренер, перестановки, выход, завершение.
$('#draft-screen').addEventListener('click', e => {
  const d = D();
  if (!d) return;
  const act = e.target.closest('[data-ds]')?.dataset.ds;
  if (act === 'leave') {
    return confirmThen(isChal() ? 'Выйти из челленджа? Попытка сохранится — продолжишь с того же места.' : 'Выйти из драфта? Он сохранится — продолжишь с того же места.',
      () => { closeDraftScreen(); renderDraftHome(); });
  }
  if (act === 'finish') return finishDraft();
  if (act === 'coach') {
    if (!d.order.length) return openDraftPick('CAPTAIN');
    if (!allPicked() && d.picks.COACH == null) return openDraftPick('COACH');
    return;
  }
  const slot = e.target.closest('[data-slot]')?.dataset.slot;
  if (!slot) return;
  if (!d.order.length) return openDraftPick('CAPTAIN');
  if (!allPicked()) {
    if (openPicks(state.draftPool, d.picks).includes(slot)) return openDraftPick(slot);
    return toast('Позиция уже занята — выбери пустую');
  }
  arrangeTap(slot);
});

// Расстановка: выбрать игрока, затем другого той же позиции — поменять местами.
function arrangeTap(slot) {
  const d = D();
  if (!d.sel) { d.sel = slot; haptic(); return renderDraftScreen(); }
  if (d.sel === slot) { d.sel = null; return renderDraftScreen(); }
  if (slotPosOf(d.sel) !== slotPosOf(slot)) { d.sel = slot; toast('Меняются местами только игроки одной позиции'); return renderDraftScreen(); }
  const before = draftScoreOf().chem;
  const lu = { ...curLineup() };
  [lu[d.sel], lu[slot]] = [lu[slot], lu[d.sel]];
  d.lineup = lu;
  d.sel = null;
  saveDraftLocal();
  const after = draftScoreOf().chem;
  haptic('medium');
  toast(after === before ? 'Поменяли местами · сыгранность не изменилась' : `Сыгранность ${before} → ${after}`);
  renderDraftScreen();
}

// ---------- Выбор карточки на позицию ----------
function dealFor(key) {
  const d = D();
  const idx = pickIndex();
  const dealt = draftDeal(state.draftPool, d.seed, idx, d.rerolls[idx] || 0, d.picks, key, draftRules());
  const bonus = draftBonus(draftData());
  // В каждой четвёрке хотя бы один вариант с бонусом (draft-core.js → finalOptions, сервер считает так же).
  d.options = finalOptions(dealt, key, d.seed, idx, id => bonus(key, id, d.picks));
  d.optKey = key;
}

function openDraftPick(key) {
  if (!state.draftPool) return;
  dealFor(key);
  $('#ds-pick').hidden = false;
  renderDraftPick();
}
const closeDraftPick = () => { $('#ds-pick').hidden = true; if (D()) D().preview = null; };

// Как изменится состав, если поставить вариант id на позицию key.
function withOption(key, id) {
  const picks = { ...D().picks, [key]: id };
  return { lineup: lineupFromDraftPicks(picks, state.byId), coach: picks.COACH ?? null, captain: picks.CAPTAIN,
    slot: key === 'CAPTAIN' ? captainSlotFor(state.byId[id]?.pos) : key };
}

function renderDraftPick() {
  const d = D();
  const key = d.optKey;
  const now = draftScoreOf();
  const chip = (cls, t) => `<i class="${cls}">${t}</i>`;
  const cards = d.options.map(id => {
    const w = withOption(key, id);
    const sc = draftScoreOf(w.lineup, w.coach, w.captain);
    const dc = sc.chem - now.chem;
    const pl = sc.team.players[w.slot];
    const dots = pl ? `${'●'.repeat(pl.stars)}${'○'.repeat(3 - pl.stars)} ` : '';
    const head = `<span class="dchips">${chip(pl ? ['r', 'y', 'y', 'g'][pl.stars] : dc > 0 ? 'g' : 'z', `${dots}сыгр. ${dc > 0 ? '+' : ''}${dc}`)}${chip('o', `рейт. ${sc.rating}`)}</span>`;
    if (key === 'COACH') {
      const c = coachById(id);
      if (!c) return '';
      const st = coachStatus(c, curLineup(), state.byId);
      return `<button class="ds-opt" type="button" data-opt="${esc(c.id)}"><span class="ds-oi coach-thumb">${coachImg(c, true)}</span>
        <span class="ds-ob"><b class="dn">${esc(c.name)}</b><small class="dt2">${esc(c.team || '')}</small>
        <span class="dchips">${chip(st.activeCount ? 'g' : 'z', `комбинации ${st.activeCount}/${st.combos.length}`)}${st.total.OVR ? chip('o', `+${st.total.OVR} OVR`) : ''}</span></span></button>`;
    }
    const p = state.byId[id];
    if (!p) return '';
    let links;
    if (key === 'CAPTAIN') {
      links = chip('cap', `👑 встанет: ${esc(SLOT_SHORT(w.slot))}`);
    } else {
      const capL = captainLink(p, state.byId[d.picks.CAPTAIN]);
      const what = [capL.club && 'клуб', capL.nation && 'страна', capL.league && 'лига'].filter(Boolean).join(' · ');
      links = chip(capL.kind, `👑 ${what || 'нет связи'}`)
        + slotNeighbours(key).map(n => {
          const m = state.byId[curLineup()[n]];
          const l = linkOf(p, m);
          return l ? chip(l.kind, `🔗 ${esc(m.name.split(' ').slice(-1)[0])} ${l.pts ? `+${l.pts}` : '0'}`) : '';
        }).join('');
    }
    return `<button class="ds-opt" type="button" data-opt="${p.id}"><span class="ds-oi" style="${cardStyle(p)}">${cardImg(p, true)}<span class="dovr">${p.ovr}<small>${esc(p.pos)}</small></span></span>
      <span class="ds-ob"><b class="dn">${esc(p.name)}</b><small class="dt2">${flag(p.nation)} ${esc(p.team)}</small>${head}<span class="dchips">${links}</span></span></button>`;
  }).join('');
  $('#ds-pick').innerHTML = `<div class="ds-sheet">
    <div class="ds-sh-head"><div><b>${esc(SLOT_SHORT(key))}</b><small>${key === 'CAPTAIN' ? 'капитан сразу встанет в состав' : `выбери 1 из ${d.options.length} · зажми — покажем в составе`}</small></div>
      ${d.order.length ? '<button class="close" type="button" data-pick="close" aria-label="Закрыть">✕</button>' : ''}</div>
    <div class="ds-pv" hidden></div>
    <div class="ds-opts">${cards || '<p class="hint">Нет подходящих карточек</p>'}</div>
    ${d.rerollsLeft > 0 ? `<button class="dskip" type="button" data-pick="reroll">🔄 Перевыбросить · осталось ${d.rerollsLeft}</button>` : ''}
  </div>`;
}

function chooseOption(id) {
  const d = D();
  const key = d.optKey;
  if (!d.options.some(o => String(o) === String(id))) return;
  d.picks[key] = key === 'COACH' ? String(id) : Number(id);
  d.order.push(key);
  if (allPicked()) d.lineup = lineupFromDraftPicks(d.picks, state.byId); // дальше — расстановка
  saveDraftLocal();
  closeDraftPick();
  haptic('medium');
  renderDraftScreen();
  if (allPicked()) toast('Все выбраны — можно переставить игроков');
}

// Удержание варианта — превью в составе (без выбора); нажатие — выбор.
let dsHold = null;
function startPickPreview(opt) {
  const d = D();
  const key = d.optKey;
  const id = key === 'COACH' ? opt.dataset.opt : Number(opt.dataset.opt);
  const before = draftScoreOf();
  d.preview = { key, ...withOption(key, id) };
  const after = draftScoreOf(d.preview.lineup, d.preview.coach, d.preview.captain);
  $('#ds-pick').classList.add('peek');
  const pv = $('#ds-pick .ds-pv');
  pv.hidden = false;
  pv.innerHTML = `Рейтинг ${before.rating || '—'} → <b>${after.rating}</b> · сыгранность ${before.chem} → <b class="${after.chem > before.chem ? 'up' : ''}">${after.chem}</b>`;
  renderDraftScreen();
  document.querySelector(`#draft-screen [data-slot="${d.preview.slot}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  haptic('light');
}
function endPickPreview() {
  const d = D();
  if (!d?.preview) return;
  d.preview = null;
  $('#ds-pick').classList.remove('peek');
  const pv = $('#ds-pick .ds-pv');
  if (pv) pv.hidden = true;
  renderDraftScreen();
}
$('#ds-pick').addEventListener('pointerdown', e => {
  const opt = e.target.closest('.ds-opt');
  if (!opt) return;
  opt.classList.add('held');
  const h = { opt, x: e.clientX, y: e.clientY, on: false };
  h.timer = setTimeout(() => { h.on = true; startPickPreview(opt); }, 320);
  dsHold = h;
});
$('#ds-pick').addEventListener('pointermove', e => {
  if (dsHold && !dsHold.on && (Math.abs(e.clientX - dsHold.x) > 8 || Math.abs(e.clientY - dsHold.y) > 8)) {
    clearTimeout(dsHold.timer); dsHold.opt.classList.remove('held'); dsHold = null;
  }
});
function releasePickHold() {
  if (!dsHold) return;
  clearTimeout(dsHold.timer);
  dsHold.opt.classList.remove('held');
  if (dsHold.on) { state.dsSuppress = true; setTimeout(() => { state.dsSuppress = false; }, 400); endPickPreview(); }
  dsHold = null;
}
window.addEventListener('pointerup', releasePickHold);
window.addEventListener('pointercancel', releasePickHold);
$('#ds-pick').addEventListener('contextmenu', e => e.preventDefault());
$('#ds-pick').addEventListener('click', e => {
  const d = D();
  if (!d) return;
  if (e.target === $('#ds-pick') || e.target.closest('[data-pick="close"]')) {
    if (!d.order.length) return toast('Сначала выбери капитана');
    return closeDraftPick();
  }
  if (e.target.closest('[data-pick="reroll"]')) {
    if (d.rerollsLeft <= 0) return;
    const idx = pickIndex();
    d.rerolls[idx] = (d.rerolls[idx] || 0) + 1;
    d.rerollsLeft--;
    saveDraftLocal();
    haptic();
    dealFor(d.optKey);
    renderDraftPick();
    return renderDraftScreen();
  }
  if (state.dsSuppress || d.preview) { state.dsSuppress = false; return; }
  const opt = e.target.closest('.ds-opt');
  if (opt) chooseOption(opt.dataset.opt);
});

// ---------- Завершение ----------
async function finishDraft() {
  const d = D();
  const sc = draftScoreOf();
  const btn = $('#draft-screen [data-ds="finish"]');
  if (btn) btn.disabled = true;
  try {
    const res = await draftApi('draft/finish', { id: d.id, picks: d.picks, order: d.order, rerolls: d.rerolls, lineup: curLineup() });
    const b = res.breakdown || {};
    state.draftResult = { rating: b.rating ?? sc.rating, chem: b.chem ?? sc.chem, total: res.score, avgOvr: b.avgOvr ?? sc.avgOvr,
      coachOvr: b.coachOvr ?? sc.coachOvr, coachInfo: sc.coachInfo, place: res.place, best: res.best, left: res.left,
      mode: d.mode, ch: d.ch, picks: { ...d.picks }, lineup: curLineup() };
    clearDraftLocal(d.mode);
    closeDraftScreen();
    state.draftResultShown = true;
    renderDraftResult();
    haptic('heavy');
  } catch (err) {
    if (btn) btn.disabled = false;
    const code = err.data?.error;
    if (['pool_changed', 'week_over', 'invalid', 'abandoned', 'not_found'].includes(code)) {
      clearDraftLocal(d.mode);
      closeDraftScreen();
      renderDraftHome();
      return toast({
        pool_changed: 'Пока шла попытка, обновилась база карточек — не засчитана, попытка не потрачена',
        week_over: 'Неделя челленджа закончилась — попытка не засчитана и не потрачена',
      }[code] || 'Попытка не прошла проверку на сервере и не засчитана');
    }
    toast('Не удалось сохранить результат — проверь связь и попробуй ещё раз');
  }
}

// ---------- Результат ----------
function renderDraftResult() {
  const r = state.draftResult;
  const cap = state.byId[r.picks.CAPTAIN];
  const coach = r.picks.COACH ? coachById(r.picks.COACH) : null;
  const ring = (v, cls, label) => `<div class="dr-ring ${cls}"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="tr"/>
    <circle cx="60" cy="60" r="52" class="vl" stroke-dasharray="327" stroke-dashoffset="${(327 * (1 - Math.min(1, v / 100))).toFixed(0)}"/></svg><b>${v}</b><small>${label}</small></div>`;
  $('#draft-home').innerHTML = `
    <section class="glass dres2">
      <div class="dk">${r.mode === 'challenge' ? `ЧЕЛЛЕНДЖ · ${esc(r.ch?.title || '')}` : 'ДРАФТ ЗАВЕРШЁН'}</div>
      <div class="dr-rings">${ring(r.rating, 'r', 'РЕЙТИНГ')}${ring(r.chem, 'c', 'СЫГРАННОСТЬ')}</div>
      <div class="dr-tot"><b>${r.total}</b><small>из 200</small></div>
      <div class="place">${r.mode === 'challenge'
        ? `<b>#${r.place}</b> в челлендже · лучший за неделю: ${r.best ?? r.total} · попыток сегодня: ${r.left > 50 ? '∞' : r.left}`
        : `<b>#${r.place}</b> за сегодня · драфтов осталось: ${r.left > 50 ? '∞' : r.left}`}</div></section>
    <section class="glass staffres">
      <div class="sr"><span class="badge" style="${cap ? cardStyle(cap) : ''}">${cap ? cardImg(cap, true) : ''}</span><div><small>КАПИТАН</small><b>${esc(cap?.name || '—')}</b>
        <span class="ok">в составе</span></div></div>
      <div class="sr"><span class="badge coach-thumb">${coach ? coachImg(coach, true) : ''}</span><div><small>ТРЕНЕР</small><b>${esc(coach?.name || '—')}</b>
        <span class="${r.coachInfo?.active ? 'ok' : 'muted'}">${r.coachInfo ? `${r.coachInfo.active}/${r.coachInfo.of} комбинаций${r.coachOvr ? ` · +${r.coachOvr} OVR` : ''}` : ''}</span></div></div></section>
    <section class="glass brk"><div class="dk">ИЗ ЧЕГО СЛОЖИЛОСЬ</div>
      <div class="br"><span>Рейтинг команды</span><em>средний OVR ${r.avgOvr}${r.coachOvr ? ' + тренер' : ''}</em><b>${r.rating}</b></div>
      <div class="br"><span>Сыгранность</span><em>с капитаном + в звеньях</em><b>${r.chem}</b></div>
      <div class="br tot"><span>Итог</span><em>из 200</em><b>${r.total}</b></div></section>
    <div class="dgrid">${DRAFT_SLOTS.map(k => { const p = state.byId[r.lineup[k]]; return `<div class="dmini" style="${p ? cardStyle(p) : ''}">${p ? cardImg(p, true) : ''}</div>`; }).join('')}</div>
    <div class="two"><button class="btn-primary" data-draft-act="share">📤 Поделиться</button><button class="ghostbtn" data-draft-act="home">К таблице</button></div>
    ${r.left > 0 ? `<button class="ghostbtn wide" data-draft-act="${r.mode === 'challenge' ? 'chal-new' : 'new'}">${r.mode === 'challenge' ? 'Ещё попытка' : 'Ещё драфт'} · осталось ${r.left > 50 ? '∞' : r.left} сегодня</button>` : ''}`;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-draft'));
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
  const el = $('#draft-home');
  let b, c;
  try { [b, c] = await Promise.all([draftApi(`draft/board?period=${state.draftPeriod}`), draftApi('challenge/board')]); }
  catch { el.innerHTML = '<p class="hint">Нет связи с сервером. Попробуй позже.</p>'; return; }
  draftPool().catch(() => {});
  const local = loadDraftLocal('draft');
  const resumePick = b.active && local ? local.order?.length || 0 : 0;
  const chLocal = loadDraftLocal('challenge');
  const chResume = c.active && chLocal?.week === c.week ? chLocal.order?.length || 0 : 0;
  const chLeft = c.left > 50 ? '∞' : c.left;
  const medal = i => ['🥇', '🥈', '🥉'][i] || String(i + 1);
  const row = (r, i) => `<div class="lrow${r.me ? ' me' : ''}"><span class="pl">${medal(i)}</span><span class="nm">${esc(r.name)}${r.me ? ' <i>вы</i>' : ''}</span><b>${r.score}</b></div>`;
  const left = b.left > 50 ? '∞' : b.left;
  el.innerHTML = `
    ${b.rewards ? '' : `<div class="dtest"><b>ТЕСТ</b><span>Драфт и челлендж в тестовом режиме: правила и оценка ещё могут меняться, таблицы — обнуляться. Наград пока нет.</span></div>`}
    <section class="ddraft glass"><div class="dk">ДРАФТ</div>
      <h2>Собери команду из случайных карточек</h2>
      <p class="dsub">Сам выбираешь позицию — на неё выпадает 4 случайных карточки. В конце расставь игроков для лучшей сыгранности</p>
      <div class="steps"><div class="st"><span class="ic">👑</span><b>Капитан</b><small>сразу в состав</small></div><i class="ar">→</i>
        <div class="st"><span class="ic">🏒</span><b>19 + тренер</b><small>в любом порядке</small></div><i class="ar">→</i>
        <div class="st"><span class="ic">🔀</span><b>Расстановка</b><small>меняй местами</small></div></div>
      <div class="rules"><span>🎴 1 из ${DRAFT_OPTIONS} на пик</span><span>🧭 позицию выбираешь сам</span><span>🔄 ${DRAFT_REROLLS} перевыброса</span><span>💸 без лимита зарплаты</span><span>⚗️ сыгранность: капитан + звено</span></div>
      ${b.active ? `<div class="resume"><div><b>Незаконченный драфт</b><small>${resumePick ? `пик ${Math.min(resumePick + 1, DRAFT_PICKS)} из ${DRAFT_PICKS}` : 'можно продолжить'}</small></div>
        <button class="ghostbtn sm" data-draft-act="resume">Продолжить</button></div>` : ''}
      <div class="meta3"><div><b>${b.today.best || '—'}</b><small>лучший сегодня</small></div><div><b>${b.me && state.draftPeriod === 'day' ? `#${b.me.place}` : '—'}</b><small>место за день</small></div>
        <div><b>${left}</b><small>драфтов осталось</small></div></div>
      <button class="btn-primary" data-draft-act="new" ${b.left <= 0 ? 'disabled' : ''}>${b.left <= 0 ? 'Драфты на сегодня закончились' : b.active ? 'Начать новый драфт' : 'Начать драфт'}</button>
      <p class="hint dscore-hint">Оценка: рейтинг команды (до 100) + сыгранность (до 100) = итог до 200.${b.rewards ? '<br>🏆 №1 недели — месяц доступа, №1 месяца — год.' : ''}</p></section>

    <section class="dchal glass"><div class="dk">ЧЕЛЛЕНДЖ НЕДЕЛИ <span class="dk-r">${untilText(c.endsAt)}</span></div>
      <h2>${esc(c.ch.title)}</h2>
      <p class="dsub">Тот же драфт, но только из карточек, подходящих под условие недели</p>
      <div class="rules">${c.ch.rules.map(r => `<span>${esc(r)}</span>`).join('')}<span>🎴 1 из ${DRAFT_OPTIONS} на пик</span></div>
      ${c.active ? `<div class="resume"><div><b>Незаконченная попытка</b><small>${chResume ? `пик ${Math.min(chResume + 1, DRAFT_PICKS)} из ${DRAFT_PICKS}` : 'можно продолжить'}</small></div>
        <button class="ghostbtn sm" data-draft-act="chal-resume">Продолжить</button></div>` : ''}
      <div class="chalfoot"><span>${c.me ? `Ваш лучший: <b>${c.me.score}</b> · <b>#${c.me.place}</b> из ${c.players}` : `Участников: ${c.players}`}</span>${c.rewards ? '<span class="prize">🎁 месяц доступа</span>' : ''}</div>
      ${c.top.length ? `<div class="chaltop">${c.top.slice(0, 3).map(row).join('')}</div>` : ''}
      <button class="ghostbtn wide" data-draft-act="chal-new" ${c.left <= 0 ? 'disabled' : ''}>${c.left <= 0 ? 'Попытки на сегодня закончились'
        : `${c.active ? 'Начать новую попытку' : c.me ? 'Улучшить результат' : 'Начать челлендж'} · осталось ${chLeft} сегодня`}</button></section>

    <section class="glass dlead"><div class="dk">ЛИДЕРЫ ДРАФТА · ИТОГ ИЗ 200</div>
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
    const what = `рейтинг ${r.rating}, сыгранность ${r.chem} — ${r.total} из 200`;
    const text = r.mode === 'challenge'
      ? `🏒 Челлендж «${r.ch?.title || ''}» в HUT Builder: ${what} (#${r.place}). Побьёшь?`
      : `🏒 Драфт в HUT Builder: ${what} (#${r.place} за сегодня). Побьёшь?`;
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  }
});
