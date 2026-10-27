// Работа с Telegram: проверка подписи мини-аппа, вызовы Bot API, подписанные сессии.

const enc = new TextEncoder();

async function hmacKey(raw) {
  return crypto.subtle.importKey('raw', typeof raw === 'string' ? enc.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(key, data) {
  const k = await hmacKey(key);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

// Сравнение строк за постоянное время.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Секреты, производные от токена бота: отдельные ключи не нужно хранить.
export async function derivedSecret(env, purpose) {
  return toHex(await hmac(env.BOT_TOKEN, purpose));
}

// Проверка Telegram.WebApp.initData (HMAC-SHA256, ключ = HMAC("WebAppData", bot_token)).
// Возвращает пользователя или null.
export async function validateInitData(initData, env, maxAgeSec = 24 * 3600) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac('WebAppData', env.BOT_TOKEN);
  const expected = toHex(await hmac(secret, checkString));
  if (!safeEqual(expected, hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

// ---------- Сессии: короткоживущий подписанный токен в пути /s/<token>/ ----------
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function signSession(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(await derivedSecret(env, 'session'), body));
  return `${body}.${sig}`;
}

export async function verifySession(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = b64url(await hmac(await derivedSecret(env, 'session'), body));
  if (!safeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

// ---------- Bot API ----------
export async function bot(env, method, params = {}) {
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}
