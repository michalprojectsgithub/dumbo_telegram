CREATE TABLE IF NOT EXISTS telegram_connections (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  telegram_username TEXT,
  timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
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

-- Whether the task was created with an explicit time (and therefore a reminder was/could be scheduled).
ALTER TABLE remote_task_events ADD COLUMN IF NOT EXISTS has_time BOOLEAN NOT NULL DEFAULT FALSE;

-- Links a remote task event to the desktop app's todo ID once the desktop has processed it.
-- Used to deduplicate agenda results between remote_task_events and todos.
ALTER TABLE remote_task_events ADD COLUMN IF NOT EXISTS app_todo_id TEXT;

-- Stores all todos synced from the desktop app.
-- Todos with hasTime=true and a dueAt also get a row in the reminders table for Telegram delivery.
CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  app_todo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  has_time BOOLEAN NOT NULL DEFAULT FALSE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, app_todo_id)
);

CREATE INDEX IF NOT EXISTS todos_user_idx
  ON todos (user_id, completed, due_at);

-- Link reminders back to the todo that created them, so we can cancel/update them when the todo changes.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS app_todo_id TEXT;

CREATE INDEX IF NOT EXISTS reminders_app_todo_idx
  ON reminders (user_id, app_todo_id)
  WHERE app_todo_id IS NOT NULL;

-- Stores repeating habit reminders created by the desktop app.
-- The worker fires next_fire_at, sends a Telegram message, then advances next_fire_at to the next occurrence.
CREATE TABLE IF NOT EXISTS habit_reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- 'daily' = every day, 'weekly' = one specific day, 'custom' = multiple specific days
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('daily', 'weekly', 'custom')),
  -- Array of weekday integers: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  days_of_week INTEGER[] NOT NULL,
  -- Local time of day in HH:MM format (stored as TIME, interpreted in timezone_offset_minutes)
  time_of_day TIME NOT NULL,
  timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  next_fire_at TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS habit_reminders_fire_idx
  ON habit_reminders (next_fire_at)
  WHERE active = TRUE;

-- Next scheduled morning brief delivery (UTC). The habit worker sends it when due
-- and advances to the next day's 6:00 AM local time.
ALTER TABLE telegram_connections ADD COLUMN IF NOT EXISTS next_morning_brief_at TIMESTAMPTZ;
