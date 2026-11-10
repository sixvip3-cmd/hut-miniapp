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

-- Пользователи бота: для статистики, рефералов и дайджеста.
CREATE TABLE IF NOT EXISTS users (
  user_id      INTEGER PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  first_seen   INTEGER,
  last_seen    INTEGER,
  ref_by       INTEGER,             -- кто пригласил
  ref_rewarded INTEGER DEFAULT 0,   -- пригласившему уже начислены +7 дней
  digest       INTEGER DEFAULT 1,   -- получать ежедневный дайджест
  last_digest  TEXT                 -- дата последнего дайджеста (YYYY-MM-DD)
);
CREATE INDEX IF NOT EXISTS users_ref ON users (ref_by);

-- Пробный период: один раз на аккаунт.
CREATE TABLE IF NOT EXISTS trials (
  user_id    INTEGER PRIMARY KEY,
  started_at INTEGER,
  until      INTEGER
);

-- Отправленные уведомления (чтобы не слать дважды): kind = soon | ended, ref = until.
CREATE TABLE IF NOT EXISTS notices (
  user_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  ref     INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (user_id, kind, ref)
);

-- Служебные значения (например, адрес приложения для кнопок в рассылках).
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Рассылки всем пользователям (команда /broadcast для админов).
CREATE TABLE IF NOT EXISTS broadcasts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_chat_id INTEGER NOT NULL,   -- откуда копировать сообщение
  message_id   INTEGER NOT NULL,
  created_at   INTEGER,
  status       TEXT,               -- draft | sending | done | cancelled
  total        INTEGER DEFAULT 0,
  sent         INTEGER DEFAULT 0,
  failed       INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS broadcast_queue (
  broadcast_id INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  PRIMARY KEY (broadcast_id, user_id)
);
-- Пользователи, заблокировавшие бота: им не пишем.
CREATE TABLE IF NOT EXISTS blocked (
  user_id INTEGER PRIMARY KEY,
  at      INTEGER
);

-- Драфт: один ряд — одна попытка (worker/src/draft.js).
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  day         TEXT NOT NULL,          -- дата по Москве (YYYY-MM-DD): лимит в день и таблица дня
  mode        TEXT NOT NULL DEFAULT 'draft', -- draft | challenge (челлендж недели — тот же драфт с условием)
  week        TEXT,                   -- для челленджа: понедельник недели (YYYY-MM-DD)
  seed        INTEGER NOT NULL,
  pool_v      TEXT,                   -- версия пула карточек на момент старта
  status      TEXT NOT NULL,          -- active | done | abandoned
  score       INTEGER,
  breakdown   TEXT,                   -- JSON: из чего сложились очки
  picks       TEXT,                   -- JSON: слот → id
  verified    INTEGER DEFAULT 0,      -- 1 — выбор проверен по вариантам
  created_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS drafts_user ON drafts (user_id, mode, day);
CREATE INDEX IF NOT EXISTS drafts_score ON drafts (status, mode, day, score);

-- Челлендж недели: лучший результат пользователя за неделю (worker/src/challenge.js).
CREATE TABLE IF NOT EXISTS challenge_entries (
  user_id    INTEGER NOT NULL,
  week       TEXT NOT NULL,            -- понедельник недели по Москве (YYYY-MM-DD)
  ch_id      TEXT NOT NULL,
  score      INTEGER NOT NULL,
  breakdown  TEXT,
  picks      TEXT,
  updated_at INTEGER,
  PRIMARY KEY (user_id, week)
);
CREATE INDEX IF NOT EXISTS challenge_week ON challenge_entries (week, score);

-- Одноразовый сброс тестовых таблиц драфта и челленджа при переходе на «капитан в составе,
-- сыгранность с капитаном» (старые результаты посчитаны по другим правилам). Выполняется при деплое,
-- но удаляет только пока нет отметки draft_reset_v2 — на следующих деплоях ничего не трогает.
DELETE FROM drafts WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k = 'draft_reset_v2');
DELETE FROM challenge_entries WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k = 'draft_reset_v2');
INSERT OR IGNORE INTO meta (k, v) VALUES ('draft_reset_v2', 'done');

-- Переход на 4 варианта на пик: незаконченные драфты с пятью вариантами уже не проверить.
-- Один раз помечаем их «expired» (попытку не тратит), законченные результаты не трогаем.
UPDATE drafts SET status = 'expired' WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM meta WHERE k = 'draft_options4');
INSERT OR IGNORE INTO meta (k, v) VALUES ('draft_options4', 'done');
