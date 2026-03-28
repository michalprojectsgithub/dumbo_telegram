CREATE TABLE IF NOT EXISTS telegram_connections (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  telegram_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders (status, scheduled_at);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  telegram_message_id BIGINT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inbox_messages_unique_msg UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS inbox_messages_user_idx
  ON inbox_messages (user_id, created_at DESC);

-- Optional column added to reminders to link back to a Telegram-created task event.
-- Safe to run on existing DB: ADD COLUMN IF NOT EXISTS is a no-op when column already exists.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS remote_task_event_id BIGINT;

-- Stores the Telegram message_id that triggered a timer/reminder, used for deduplication.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_telegram_message_id BIGINT;

-- Partial unique index: prevents duplicate timers from the same Telegram message.
-- Only enforced when source_telegram_message_id is set (not null).
CREATE UNIQUE INDEX IF NOT EXISTS reminders_source_msg_idx
  ON reminders (source_telegram_message_id)
  WHERE source_telegram_message_id IS NOT NULL;

-- Intake table for tasks created via Telegram bot commands.
-- The desktop app polls this table and imports events as local tasks, then marks them processed.
CREATE TABLE IF NOT EXISTS remote_task_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id BIGINT,
  source TEXT NOT NULL DEFAULT 'telegram',
  event_type TEXT NOT NULL DEFAULT 'task_create',
  raw_input TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  reminder_id BIGINT,
  reminder_scheduled BOOLEAN NOT NULL DEFAULT FALSE,
  processed_by_desktop BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Prevent duplicate processing of the same Telegram message
  CONSTRAINT remote_task_events_unique_msg UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS remote_task_events_user_idx
  ON remote_task_events (user_id, processed_by_desktop, created_at DESC);
