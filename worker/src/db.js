// Работа с базой D1: подписки, пробный период, пользователи, рефералы, статистика.

export const DAY = 24 * 3600;
export const SUB_PERIOD = 30 * DAY; // Telegram допускает подписки за звёзды только на 30 дней
export const now = () => Math.floor(Date.now() / 1000);

export const price = env => Math.max(1, Number(env.PRICE_STARS) || 150);
export const trialDays = env => Math.max(0, Number(env.TRIAL_DAYS ?? 3));
export const refBonusDays = env => Math.max(0, Number(env.REF_BONUS_DAYS ?? 7));
export const adminIds = env => String(env.ADMIN_IDS || '').split(/[\s,]+/).filter(Boolean).map(Number);
export const isAdmin = (env, id) => adminIds(env).includes(Number(id));

// ---------- Пользователи ----------
export async function touchUser(env, user, refBy = null) {
  const t = now();
  const ref = refBy && Number(refBy) !== Number(user.id) ? Number(refBy) : null;
  // Пригласившего запоминаем только для нового пользователя.
  await env.DB.prepare(
    `INSERT INTO users (user_id, username, first_name, first_seen, last_seen, ref_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_seen = excluded.last_seen`,
  ).bind(user.id, user.username || null, user.first_name || null, t, t, ref).run();
}

export const getUser = (env, userId) => env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();

// ---------- Подписки ----------
export const getSubscription = (env, userId) =>
  env.DB.prepare('SELECT user_id, until, charge_id FROM subscriptions WHERE user_id = ?').bind(userId).first();

export async function hasAccess(env, userId) {
  if (isAdmin(env, userId)) return { until: now() + 365 * DAY, admin: true };
  const sub = await getSubscription(env, userId);
  return sub && sub.until > now() ? { ...sub, trial: sub.charge_id === 'trial' } : null;
}

async function setUntil(env, userId, until, chargeId) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, until, charge_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, charge_id = excluded.charge_id, updated_at = excluded.updated_at`,
  ).bind(userId, until, chargeId, now()).run();
}

// Продлить доступ на N дней от текущего окончания (или от сейчас), не меняя тип подписки.
export async function extendDays(env, userId, days) {
  const sub = await getSubscription(env, userId);
  const until = Math.max(now(), sub?.until || 0) + days * DAY;
  await setUntil(env, userId, until, sub?.charge_id || 'bonus');
  return until;
}

// ---------- Пробный период ----------
export async function trialAvailable(env, userId) {
  if (!trialDays(env)) return false;
  const used = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM trials WHERE user_id = ?1) + (SELECT COUNT(*) FROM payments WHERE user_id = ?1) AS n',
  ).bind(userId).first();
  return !used?.n;
}

export async function startTrial(env, userId) {
  if (!(await trialAvailable(env, userId))) return null;
  const until = now() + trialDays(env) * DAY;
  const res = await env.DB.prepare('INSERT OR IGNORE INTO trials (user_id, started_at, until) VALUES (?, ?, ?)')
    .bind(userId, now(), until).run();
  if (!res.meta.changes) return null;
  await setUntil(env, userId, until, 'trial');
  return until;
}

// ---------- Платежи ----------
// Записывает платёж один раз (повторная доставка апдейта ничего не задвоит) и продлевает доступ.
// Возвращает { until, first } или null, если платёж уже был учтён.
export async function recordPayment(env, userId, sp) {
  const prev = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND refunded = 0').bind(userId).first();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO payments (charge_id, user_id, amount, payload, is_recurring, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sp.telegram_payment_charge_id, userId, sp.total_amount, sp.invoice_payload, sp.is_recurring ? 1 : 0,
    sp.subscription_expiration_date || null, now()).run();
  if (!inserted.meta.changes) return null;

  const current = await getSubscription(env, userId);
  // Остаток пробного периода не переносим, бонусные дни — переносим.
  const carried = current && current.charge_id !== 'trial' ? current.until : 0;
  const base = Math.max(now(), carried);
  const until = Math.max(sp.subscription_expiration_date || 0, base + (sp.subscription_expiration_date ? 0 : SUB_PERIOD));
  await setUntil(env, userId, until, sp.telegram_payment_charge_id);
  return { until, first: !prev?.n };
}

export async function revokeByCharge(env, chargeId) {
  const p = await env.DB.prepare('SELECT user_id FROM payments WHERE charge_id = ?').bind(chargeId).first();
  if (!p) return null;
  await env.DB.prepare('UPDATE payments SET refunded = 1 WHERE charge_id = ?').bind(chargeId).run();
  await env.DB.prepare('UPDATE subscriptions SET until = ?, updated_at = ? WHERE user_id = ?').bind(now(), now(), p.user_id).run();
  return p.user_id;
}

// ---------- Рефералы ----------
// После первой оплаты приглашённого — пригласившему +N дней (один раз за каждого друга).
export async function rewardReferrer(env, userId) {
  const days = refBonusDays(env);
  if (!days) return null;
  const u = await getUser(env, userId);
  if (!u?.ref_by || u.ref_rewarded) return null;
  const res = await env.DB.prepare('UPDATE users SET ref_rewarded = 1 WHERE user_id = ? AND ref_rewarded = 0').bind(userId).run();
  if (!res.meta.changes) return null;
  const until = await extendDays(env, u.ref_by, days);
  return { referrer: u.ref_by, until, days };
}

export async function referralStats(env, userId) {
  return env.DB.prepare(
    'SELECT COUNT(*) AS invited, COALESCE(SUM(ref_rewarded), 0) AS paid FROM users WHERE ref_by = ?',
  ).bind(userId).first();
}

// ---------- Уведомления (без повторов) ----------
export async function markNotice(env, userId, kind, ref) {
  const res = await env.DB.prepare('INSERT OR IGNORE INTO notices (user_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)')
    .bind(userId, kind, ref, now()).run();
  return res.meta.changes > 0;
}

// ---------- Статистика для /stats ----------
export async function stats(env) {
  const t = now();
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();
  const [subs, trials, users, newDay, newWeek, s1, s7, s30, all, refs] = await Promise.all([
    q("SELECT COUNT(*) AS n FROM subscriptions WHERE until > ? AND charge_id != 'trial'", t),
    q("SELECT COUNT(*) AS n FROM subscriptions WHERE until > ? AND charge_id = 'trial'", t),
    q('SELECT COUNT(*) AS n FROM users'),
    q('SELECT COUNT(*) AS n FROM users WHERE first_seen > ?', t - DAY),
    q('SELECT COUNT(*) AS n FROM users WHERE first_seen > ?', t - 7 * DAY),
    q('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS stars FROM payments WHERE refunded = 0 AND created_at > ?', t - DAY),
    q('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS stars FROM payments WHERE refunded = 0 AND created_at > ?', t - 7 * DAY),
    q('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS stars FROM payments WHERE refunded = 0 AND created_at > ?', t - 30 * DAY),
    q('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS stars, SUM(refunded) AS refunds FROM payments'),
    q('SELECT COUNT(*) AS invited, COALESCE(SUM(ref_rewarded), 0) AS paid FROM users WHERE ref_by IS NOT NULL'),
  ]);
  return { subs: subs.n, trials: trials.n, users: users.n, newDay: newDay.n, newWeek: newWeek.n, s1, s7, s30, all, refs };
}
