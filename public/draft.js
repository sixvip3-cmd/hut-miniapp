// Вкладка «Драфт»: собираешь команду из случайных карточек на том же экране, что и обычный состав.
// Порядок пиков: капитан → 20 игроков → тренер; на каждый пик 5 вариантов (draft-core.js, общий с сервером).
// Пока идёт драфт, сохранённый состав пользователя отложен (state.savedLineup) и вернётся при выходе.

const DRAFT_KEY = 'hut-draft-v1';
const POS_RU = { LW: 'левый нападающий', C: 'центральный', RW: 'правый нападающий', LD: 'левый защитник', RD: 'правый защитник', STARTER: 'основной вратарь', BACKUP: 'запасной вратарь' };
const DRAFT_LABEL = key => (key === 'CAPTAIN' ? 'Капитан' : key === 'COACH' ? 'Тренер' : `${LINE_LABELS[key.split('-')[0]]} · ${POS_RU[slotOf(key)]}`);
const DRAFT_SHORT = key => (key === 'CAPTAIN' ? 'Капитан' : key === 'COACH' ? 'Тренер' : `${LINE_LABELS[key.split('-')[0]]} · ${slotOf(key) === 'STARTER' ? 'G1' : slotOf(key) === 'BACKUP' ? 'G2' : slotOf(key)}`);
state.draftPeriod = 'day';

async function draftApi(path, body) {
  const res = await fetch(`api/draft/${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || String(res.status)), { data });
  return data;
}

async function draftPool() {
  if (!state.draftPool) state.draftPool = await (await fetch('data/draft-pool.json')).json();
  return state.draftPool;
}

const saveDraftLocal = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft)); } catch {} };
const loadDraftLocal = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } };
const clearDraftLocal = () => { try { localStorage.removeItem(DRAFT_KEY); } catch {} };

// ---------- Очки ----------
// 4 × средний рейтинг 20 карточек + бонусы: сыгранность звеньев, капитан, тренер (OVR считаем ×3).
function draftScore() {
  const ids = DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH').map(k => state.lineup[k]).filter(Boolean);
  const avg = ids.length ? ids.reduce((t, id) => t + state.byId[id].ovr, 0) / ids.length : 0;
  const lines = teamSummary(state.lineup, state.byId, state.combos).boost;
  const captain = state.byId[state.captain];
  const cap = captain ? captainStatus(captain, lineupPlayers(), state.captains) : null;
  const coach = coachById(state.coach);
  const co = coach ? coachStatus(coach, state.lineup, state.byId) : null;
  const pts = b => b.OVR * 3 + b.SAL + b.AP;
  const part = {
    base: Math.round(avg * 4),
    avgOvr: Math.round(avg * 10) / 10,
    chem: pts(lines),
    captain: cap ? cap.ap + cap.sal : 0,
    coach: co ? pts(co.total) : 0,
    boost: lines,
    capInfo: cap ? { met: cap.met, count: cap.count, needed: cap.rule.needed } : null,
    coachInfo: co ? { active: co.activeCount, of: co.combos.length, total: co.total } : null,
  };
  part.total = part.base + part.chem + part.captain + part.coach;
  return part;
}

const draftSalary = () => Math.round(DRAFT_ORDER.filter(k => k !== 'CAPTAIN' && k !== 'COACH')
  .reduce((t, k) => t + (state.byId[state.lineup[k]]?.salary || 0), 0) * 10) / 10;

// ---------- Вход и выход из режима драфта ----------
function enterDraftMode() {
  const d = state.draft;
  state.savedLineup = { lineup: state.lineup, captain: state.captain, coach: state.coach };
  state.lineup = Object.fromEntries(Object.entries(d.picks).filter(([k]) => k !== 'CAPTAIN' && k !== 'COACH'));
  state.captain = d.picks.CAPTAIN ?? null;
  state.coach = d.picks.COACH ?? null;
  state.staffOpen = null;
  document.body.classList.add('draft-mode');
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-team'));
  $('#team-mode [data-mode="lineup"]').click();
  window.scrollTo(0, 0);
  renderTeam();
}

function exitDraftMode() {
  const saved = state.savedLineup || { lineup: {}, captain: null, coach: null };
  state.draft = null;
  state.lineup = saved.lineup; state.captain = saved.captain; state.coach = saved.coach;
  state.savedLineup = null;
  document.body.classList.remove('draft-mode');
  closeSheets();
  renderTeam();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-draft'));
  window.scrollTo(0, 0);
}

async function startDraft(fresh = false) {
  try {
    const [res, pool] = await Promise.all([draftApi('start', { fresh }), draftPool()]);
    const local = loadDraftLocal();
    state.draft = local?.id === res.id ? local : { id: res.id, seed: res.seed, poolV: res.poolV, pick: 0, picks: {}, rerolls: {}, rerollsLeft: DRAFT_REROLLS };
    if (pool.v !== res.poolV) state.draft.stalePool = true;
    saveDraftLocal();
    enterDraftMode();
    haptic('medium');
    setTimeout(openDraftPicker, 300);
  } catch (err) {
    toast(err.message === 'limit' ? 'На сегодня драфты закончились — приходи завтра' : 'Не удалось начать драфт, попробуй ещё раз');
  }
}

function leaveDraft() {
  const go = ok => { if (ok) { exitDraftMode(); renderDraftHome(); } };
  const text = 'Выйти из драфта? Он сохранится — продолжишь с того же пика.';
  if (tg?.showConfirm) tg.showConfirm(text, go); else go(window.confirm(text));
}

// ---------- Экран состава в драфте ----------
function decorateDraftTeam() {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  const sc = draftScore();
  const spent = draftSalary();
  $('#draft-bar').hidden = false;
  $('#draft-bar').innerHTML = `
    <div class="dbar"><button class="dx" data-draft="leave" aria-label="Выйти">✕</button>
      <div class="dt"><b>Пик ${Math.min(d.pick + 1, DRAFT_ORDER.length)} / ${DRAFT_ORDER.length}</b><small>${key ? esc(DRAFT_LABEL(key)) : 'Готово'}</small></div>
      <div class="dsc"><b>${sc.total}</b><small>очков</small></div></div>
    <div class="dprog"><i style="width:${(d.pick / DRAFT_ORDER.length) * 100}%"></i></div>
    <div class="dmeta"><span>💰 <b>$${spent.toFixed(1)}M</b> / $${DRAFT_CAP}M</span><span>🔄 перевыбросов: <b>${d.rerollsLeft}</b></span>
      ${key ? '<button class="dnext" data-draft="open">Выбрать ›</button>' : ''}</div>`;
  document.querySelectorAll('#lineup .card.now, #staff .staff-tile.now').forEach(e => e.classList.remove('now'));
  if (key === 'CAPTAIN' || key === 'COACH') document.querySelector(`#staff [data-staff="${key === 'CAPTAIN' ? 'captain' : 'coach'}"]`)?.classList.add('now');
  else if (key) document.querySelector(`#lineup [data-slot="${key}"]`)?.classList.add('now');
  document.querySelectorAll('#staff .staff-tile').forEach(t => {
    const n = t.querySelector('.staff-name');
    if (n && n.textContent.trim() === 'Выбрать') n.textContent = t.dataset.staff === 'coach' ? 'Последний пик' : 'Первый пик';
  });
}

$('#draft-bar').addEventListener('click', e => {
  const act = e.target.closest('[data-draft]')?.dataset.draft;
  if (act === 'leave') leaveDraft();
  if (act === 'open') openDraftPicker();
});

function draftSlotTap(key) {
  const now = DRAFT_ORDER[state.draft.pick];
  if (key === now) return openDraftPicker();
  toast(now ? `Сейчас пик: ${DRAFT_SHORT(now)}` : 'Драфт завершён');
}

function openDraftPicker() {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  if (!key || !state.draftPool) return;
  d.options = draftOptions(state.draftPool, d.seed, d.pick, d.rerolls[d.pick] || 0, d.picks);
  openPicker(key);
}

// ---------- Меню выбора: 5 вариантов ----------
function renderDraftOptions() {
  const d = state.draft;
  const key = DRAFT_ORDER[d.pick];
  $('#picker-title').textContent = `Пик ${d.pick + 1} · ${DRAFT_SHORT(key)}`;
  ['#picker-remove', '#picker-accent'].forEach(s => { $(s).hidden = true; });
  $('#picker-search').hidden = true;
  $('#picker-allpos').parentElement.hidden = true;
  const chip = (cls, t, v) => `<i class="${cls}${v ? '' : ' z'}">${t}</i>`;
  let rows = '';
  let head = '';
  if (key === 'COACH') {
    head = 'Выбери <b>1 из 5</b> · сколько его комбинаций сработает в составе';
    rows = d.options.map(id => coachById(id)).filter(Boolean).map(c => {
      const st = coachStatus(c, state.lineup, state.byId);
      return `<button class="mrow" data-coach="${esc(c.id)}"><span class="badge coach-thumb">${coachImg(c, true)}</span>
        <span class="info"><b>${esc(c.name)}</b><small>${esc([c.team, coachSummaryText(c)].filter(Boolean).join(' · '))}</small>
        <span class="dsyn"><span class="lbl">сработает:</span><i class="o${st.activeCount ? '' : ' z'}">${st.activeCount}/${st.combos.length}</i>
          ${chip('o', `+${st.total.OVR} OVR`, st.total.OVR)}${chip('s', `+$${st.total.SAL}M`, st.total.SAL)}${chip('a', `+${st.total.AP} AP`, st.total.AP)}</span></span></button>`;
    }).join('');
  } else if (key === 'CAPTAIN') {
    head = 'Выбери <b>1 из 5</b> · дальше подбирай игроков под его бонус';
    rows = d.options.map(id => state.byId[id]).filter(Boolean).map(p => {
      const r = captainRuleFor(p, state.captains);
      return playerRow(p, '').replace('</span>\n    <span class="price">', `${r ? `<span class="capbig">👑 ${esc(captainBonusText(r).replace(/<[^>]+>/g, ''))} · нужно ${r.needed} игроков</span>` : ''}</span>\n    <span class="price">`);
    }).join('');
  } else {
    const budget = DRAFT_CAP - draftSalary();
    head = `<span>Выбери <b>1 из 5</b> · осталось <b>$${budget.toFixed(1)}M</b></span>`;
    const best = bestForSlot(key, () => true);
    const cap = state.byId[state.captain];
    const rule = cap && captainRuleFor(cap, state.captains);
    const have = rule ? captainStatus(cap, lineupPlayers(), state.captains).count : 0;
    rows = d.options.map(id => state.byId[id]).filter(Boolean).map(p => {
      const delta = best.others.length ? synergyFor(p, best.line, best.others, best.base, best.combos).delta : { OVR: 0, SAL: 0, AP: 0 };
      const capHit = rule && captainMatch(p, rule);
      const capTxt = capHit ? (have >= rule.needed ? '<span class="cap">👑 клуб капитана</span>' : `<span class="cap">👑 +1 к капитану · станет ${have + 1}/${rule.needed}</span>`) : '';
      return playerRow(p, '').replace('</span>\n    <span class="price">', `<span class="dsyn"><span class="lbl">в звене:</span>${chip('o', `+${delta.OVR} OVR`, delta.OVR)}${chip('s', `+$${delta.SAL}M`, delta.SAL)}${chip('a', `+${delta.AP} AP`, delta.AP)}${capTxt}</span></span>\n    <span class="price">`);
    }).join('');
  }
  $('#picker-list').innerHTML = `<div class="dpick-head">${head}</div>${rows || '<p class="hint">Нет подходящих карточек</p>'}
    ${d.rerollsLeft > 0 ? `<button class="dskip" data-reroll>🔄 Перевыбросить варианты · осталось ${d.rerollsLeft}</button>` : ''}`;
}

function draftChoose(e) {
  const d = state.draft;
  if (e.target.closest('[data-reroll]')) {
    if (d.rerollsLeft <= 0) return;
    d.rerolls[d.pick] = (d.rerolls[d.pick] || 0) + 1;
    d.rerollsLeft--;
    saveDraftLocal();
    haptic();
    d.options = draftOptions(state.draftPool, d.seed, d.pick, d.rerolls[d.pick], d.picks);
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

// ---------- Результат ----------
async function finishDraft() {
  const d = state.draft;
  const sc = draftScore();
  try {
    const res = await draftApi('finish', { id: d.id, picks: d.picks, rerolls: d.rerolls, breakdown: sc });
    state.draftResult = { ...sc, total: res.score, base: res.breakdown?.base ?? sc.base, place: res.place, left: res.left, picks: { ...d.picks } };
    clearDraftLocal();
    exitDraftMode();
    state.draftResultShown = true;
    renderDraftResult();
    haptic('heavy');
  } catch (err) {
    toast('Не удалось сохранить результат — проверь связь и нажми «Выбрать ›» ещё раз');
    d.pick = DRAFT_ORDER.length;
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
      <div class="place"><b>#${r.place}</b> за сегодня<br><span class="muted">драфтов осталось: ${r.left}</span></div></section>
    <section class="glass staffres">
      <div class="sr"><span class="badge" style="${cap ? cardStyle(cap) : ''}">${cap ? cardImg(cap, true) : ''}</span><div><small>КАПИТАН</small><b>${esc(cap?.name || '—')}</b>
        <span class="${r.capInfo?.met ? 'ok' : 'muted'}">${r.capInfo ? `${Math.min(r.capInfo.count, r.capInfo.needed)}/${r.capInfo.needed} игроков` : ''}${r.captain ? ` · +${r.captain}` : ''}</span></div></div>
      <div class="sr"><span class="badge coach-thumb">${coach ? coachImg(coach, true) : ''}</span><div><small>ТРЕНЕР</small><b>${esc(coach?.name || '—')}</b>
        <span class="${r.coachInfo?.active ? 'ok' : 'muted'}">${r.coachInfo ? `${r.coachInfo.active}/${r.coachInfo.of} комбинаций` : ''}</span></div></div></section>
    <section class="glass brk"><div class="dk">ИЗ ЧЕГО СЛОЖИЛОСЬ</div>
      <div class="br"><span>Средний OVR карточек</span><em>${r.avgOvr}</em><b>${r.base}</b></div>
      <div class="br"><span>Сыгранность звеньев</span><em class="chipline">${chips(r.boost) || '—'}</em><b>+${r.chem}</b></div>
      <div class="br"><span>Капитан</span><em>${r.captain ? `+${r.captain}` : 'бонус не собран'}</em><b>+${r.captain}</b></div>
      <div class="br"><span>Тренер</span><em class="chipline">${chips(r.coachInfo?.total) || '—'}</em><b>+${r.coach}</b></div>
      <div class="br tot"><span>Итого</span><em></em><b>${r.total}</b></div></section>
    ${draftCardsGrid(r.picks)}
    <div class="two"><button class="btn-primary" data-draft-act="share">📤 Поделиться</button><button class="ghostbtn" data-draft-act="home">К таблице</button></div>
    ${r.left > 0 ? `<button class="ghostbtn wide" data-draft-act="new">Ещё драфт · осталось ${r.left} сегодня</button>` : ''}`;
  window.scrollTo(0, 0);
}

// ---------- Главная вкладки ----------
async function renderDraftHome() {
  if (state.draft) return;
  if (state.draftResult && !state.draftResultShown) { state.draftResultShown = true; return renderDraftResult(); }
  const el = $('#draft-home');
  let b;
  try { b = await draftApi(`board?period=${state.draftPeriod}`); } catch { el.innerHTML = '<p class="hint">Нет связи с сервером. Попробуй позже.</p>'; return; }
  draftPool().catch(() => {});
  const local = loadDraftLocal();
  const resumePick = b.active && local ? local.pick : 0;
  const medal = i => ['🥇', '🥈', '🥉'][i] || String(i + 1);
  const rows = b.top.map((r, i) => `<div class="lrow${r.me ? ' me' : ''}"><span class="pl">${medal(i)}</span><span class="nm">${esc(r.name)}${r.me ? ' <i>вы</i>' : ''}</span><b>${r.score}</b></div>`).join('');
  el.innerHTML = `
    <section class="ddraft glass"><div class="dk">ДРАФТ</div>
      <h2>Собери команду из случайных карточек</h2>
      <p class="dsub">Как обычная сборка состава, но на каждый пик — 5 случайных вариантов</p>
      <div class="steps"><div class="st"><span class="ic">👑</span><b>Капитан</b><small>пик 1</small></div><i class="ar">→</i>
        <div class="st"><span class="ic">🏒</span><b>20 игроков</b><small>пики 2–21</small></div><i class="ar">→</i>
        <div class="st"><span class="ic">📋</span><b>Тренер</b><small>пик 22</small></div></div>
      <div class="rules"><span>🎴 1 из 5 на пик</span><span>🔄 ${DRAFT_REROLLS} перевыброса</span><span>💰 лимит $${DRAFT_CAP}M</span><span>📊 видно OVR · Salary · AP</span></div>
      ${b.active ? `<div class="resume"><div><b>Незаконченный драфт</b><small>${resumePick ? `пик ${resumePick + 1} из ${DRAFT_ORDER.length}` : 'можно продолжить'}</small></div>
        <button class="ghostbtn sm" data-draft-act="resume">Продолжить</button></div>` : ''}
      <div class="meta3"><div><b>${b.today.best || '—'}</b><small>лучший сегодня</small></div><div><b>${b.me && state.draftPeriod === 'day' ? `#${b.me.place}` : '—'}</b><small>место за день</small></div>
        <div><b>${b.left > 50 ? '∞' : b.left}</b><small>драфтов осталось</small></div></div>
      <button class="btn-primary" data-draft-act="new" ${b.left <= 0 && !b.active ? 'disabled' : ''}>${b.left <= 0 && !b.active ? 'Драфты на сегодня закончились' : b.active ? 'Начать новый драфт' : 'Начать драфт'}</button>
      <p class="hint dscore-hint">Очки: 4 × средний OVR карточек + бонусы сыгранности, капитана и тренера.</p></section>
    <section class="glass dlead"><div class="dk">ЛИДЕРЫ</div>
      <div class="segmented small" id="draft-period">${[['day', 'День'], ['week', 'Неделя'], ['all', 'Всё время']].map(([k, t]) => `<button data-period="${k}" class="${k === state.draftPeriod ? 'active' : ''}">${t}</button>`).join('')}</div>
      ${rows || '<p class="hint">Пока никто не сыграл — будь первым!</p>'}
      ${b.me && !b.top.some(r => r.me) ? `<div class="sep">…</div><div class="lrow me"><span class="pl">${b.me.place}</span><span class="nm">Вы</span><b>${b.me.score}</b></div>` : ''}
      <p class="hint" style="margin:8px 0 0">Игроков в таблице: ${b.players}</p></section>`;
}

$('#draft-home').addEventListener('click', e => {
  const period = e.target.closest('[data-period]')?.dataset.period;
  if (period) { state.draftPeriod = period; haptic(); return renderDraftHome(); }
  const act = e.target.closest('[data-draft-act]')?.dataset.draftAct;
  if (!act) return;
  if (act === 'resume') return startDraft(false);
  if (act === 'new') {
    const go = ok => ok && startDraft(true);
    if (loadDraftLocal() || e.target.closest('.ddraft')?.querySelector('.resume')) {
      const text = 'Начать новый драфт? Незаконченный будет засчитан как сыгранный.';
      return tg?.showConfirm ? tg.showConfirm(text, go) : go(window.confirm(text));
    }
    return startDraft(true);
  }
  if (act === 'home') { state.draftResult = null; return renderDraftHome(); }
  if (act === 'share') {
    const r = state.draftResult;
    const username = state.me?.refLink?.match(/t\.me\/([^?]+)/)?.[1];
    const link = state.me?.refLink || (username ? `https://t.me/${username}` : '');
    const text = `🏒 Набрал ${r.total} очков в драфте HUT Builder (#${r.place} за сегодня). Побьёшь?`;
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  }
});
