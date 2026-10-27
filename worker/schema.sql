-- Подписки и платежи (Cloudflare D1). Безопасно запускать повторно.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id    INTEGER PRIMARY KEY,
  until      INTEGER NOT NULL,      -- unix-время окончания доступа
  charge_id  TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS payments (
  charge_id    TEXT PRIMARY KEY,    -- telegram_payment_charge_id (нужен для возврата)
  user_id      INTEGER NOT NULL,
  amount       INTEGER NOT NULL,    -- звёзды
  payload      TEXT,
  is_recurring INTEGER DEFAULT 0,
  expires_at   INTEGER,
  refunded     INTEGER DEFAULT 0,
  created_at   INTEGER
);

CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, created_at);
