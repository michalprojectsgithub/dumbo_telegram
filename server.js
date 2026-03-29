import "dotenv/config";
import express from "express";
import * as chrono from "chrono-node";
import { pool, query } from "./db.js";

const app = express();
app.use(express.json({ limit: "100kb" }));

const port = Number(process.env.PORT || 3000);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramApiBaseUrl = `https://api.telegram.org/bot${telegramBotToken}`;
const pollingIntervalMs = Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000);
const workerIntervalMs = Number(process.env.REMINDER_WORKER_INTERVAL_MS || 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";
// UTC offset in minutes for the user's local timezone, used when parsing natural language
// dates from Telegram messages. Example: UTC+2 = 120, UTC-5 = -300. Default: 0 (UTC).
const userTimezoneOffsetMinutes = Number(process.env.USER_TIMEZONE_OFFSET_MINUTES || 0);

if (!telegramBotToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

let lastUpdateId = Number(process.env.TELEGRAM_INITIAL_UPDATE_ID || 0);
let pollingInProgress = false;
let workerInProgress = false;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
});

function isValidUserId(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 120;
}

function isValidMessageText(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 2000;
}

function parseScheduledAt(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.slice(0, 1000);
}

// Returns the raw input after stripping "timer " or "/timer " prefix, otherwise null.
function parseTimerPrefix(text) {
  const trimmed = text.trim();
  if (/^\/timer\s+/i.test(trimmed)) return trimmed.replace(/^\/timer\s+/i, "").trim();
  if (/^timer\s+/i.test(trimmed)) return trimmed.replace(/^timer\s+/i, "").trim();
  return null;
}

// Parses a duration + optional label from timer input.
// Supports: 20m, 20 min, 20 minutes, 1h, 2 hours, 90s, 45 sec, 1h30m, 1h 30m, 1d
// Returns { durationSeconds, label } or null if no valid duration found.
function parseTimerInput(rawInput) {
  const trimmed = rawInput.trim();

  // Match one or more adjacent duration segments at the start of the string
  const durationRegex = /^((?:\d+\s*(?:d(?:ays?)?|h(?:(?:ou)?rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\s*)+)/i;
  const durationMatch = trimmed.match(durationRegex);

  if (!durationMatch) return null;

  const durationStr = durationMatch[1].trim();
  const label = trimmed.slice(durationMatch[1].length).trim() || null;

  let totalSeconds = 0;
  const segmentRegex = /(\d+)\s*(d(?:ays?)?|h(?:(?:ou)?rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/gi;
  let seg;

  while ((seg = segmentRegex.exec(durationStr)) !== null) {
    const val = parseInt(seg[1], 10);
    const unit = seg[2][0].toLowerCase(); // first char: d, h, m, s
    if (unit === "d") totalSeconds += val * 86400;
    else if (unit === "h") totalSeconds += val * 3600;
    else if (unit === "m") totalSeconds += val * 60;
    else if (unit === "s") totalSeconds += val;
  }

  if (totalSeconds <= 0) return null;

  return { durationSeconds: totalSeconds, label };
}

// Converts a duration in seconds to a human-readable string like "1 hour 30 minutes".
function formatDuration(seconds) {
  const parts = [];
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (d > 0) parts.push(`${d} day${d !== 1 ? "s" : ""}`);
  if (h > 0) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
  if (m > 0) parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  if (s > 0) parts.push(`${s} second${s !== 1 ? "s" : ""}`);

  return parts.join(" ") || "0 seconds";
}

// Returns the raw task input string if the message is a task command, otherwise null.
// Handles both "task ..." and "/task ..." prefixes (case-insensitive).
function parseTaskPrefix(text) {
  const trimmed = text.trim();
  if (/^\/task\s+/i.test(trimmed)) return trimmed.replace(/^\/task\s+/i, "").trim();
  if (/^task\s+/i.test(trimmed)) return trimmed.replace(/^task\s+/i, "").trim();
  return null;
}

// Extracts an optional due date from natural language input using chrono-node.
// Returns { title, dueAt, dateText } where:
//   dueAt    - parsed Date object or null
//   dateText - the original date phrase the user typed (used in confirmation to avoid timezone confusion)
function extractDueDate(rawInput) {
  // Pass the user's timezone offset so "10:00" is interpreted as local time, not UTC.
  const results = chrono.parse(rawInput, { instant: new Date(), timezone: userTimezoneOffsetMinutes }, { forwardDate: true });

  if (results.length === 0) {
    return { title: rawInput.trim(), dueAt: null, dateText: null };
  }

  const match = results[0];
  const dueAt = match.date();

  const before = rawInput.slice(0, match.index).trimEnd();
  const after = rawInput.slice(match.index + match.text.length).trimStart();

  // Remove trailing connectors left behind after stripping the date phrase
  const raw = `${before} ${after}`.trim().replace(/\s+(at|on|in|by|for)$/i, "").trim();
  const title = raw || rawInput.trim();

  // Preserve the original date text the user typed so we can echo it back exactly
  return { title, dueAt, dateText: match.text };
}

async function telegramRequest(method, payload) {
  const response = await fetch(`${telegramApiBaseUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const rawBody = await response.text();
  let parsedBody;

  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new Error(`Telegram returned invalid JSON (${response.status}): ${rawBody}`);
  }

  if (!response.ok || !parsedBody.ok) {
    const description = parsedBody?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API error: ${description}`);
  }

  return parsedBody.result;
}

async function sendTelegramMessage(chatId, text) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text
  });
}

async function handleStartCommand(message) {
  const text = message.text || "";
  const parts = text.trim().split(/\s+/);
  const from = message.from || {};
  const chat = message.chat || {};

  if (!chat.id) {
    return;
  }

  const userIdFromCommand = parts[1]?.trim();
  const resolvedUserId = userIdFromCommand || String(from.id || chat.id);
  const telegramUsername = from.username || null;

  await query(
    `
      INSERT INTO telegram_connections (user_id, telegram_chat_id, telegram_username)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET
        telegram_chat_id = EXCLUDED.telegram_chat_id,
        telegram_username = EXCLUDED.telegram_username
    `,
    [resolvedUserId, String(chat.id), telegramUsername]
  );

  await sendTelegramMessage(chat.id, "Connected. I can send you reminders now.");
}

async function handleTimerCommand(message, rawInput) {
  const chat = message.chat || {};
  const chatId = String(chat.id);
  const telegramMessageId = message.message_id ?? null;

  const parsed = parseTimerInput(rawInput);
  if (!parsed) {
    console.log(`[timer] parse failed for input: "${rawInput}"`);
    await sendTelegramMessage(chatId, "Could not parse timer. Example: timer 20m tea");
    return;
  }

  const { durationSeconds, label } = parsed;

  // Look up user_id for this chat
  const { rows: connRows } = await query(
    "SELECT user_id FROM telegram_connections WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [chatId]
  );

  if (connRows.length === 0) {
    await sendTelegramMessage(chatId, "You are not connected. Please send /start <your-user-id> first.");
    return;
  }

  const userId = connRows[0].user_id;
  const scheduledAt = new Date(Date.now() + durationSeconds * 1000);
  const messageText = label ? `⏰ Timer finished: ${label}` : "⏰ Timer finished.";

  console.log(`[timer] user=${userId} duration=${durationSeconds}s label="${label ?? ""}" scheduledAt=${scheduledAt.toISOString()}`);

  // Insert into existing reminders table — the existing processDueReminders worker delivers it.
  // ON CONFLICT on source_telegram_message_id prevents duplicate timers from duplicate updates.
  const { rows } = await query(
    `
      INSERT INTO reminders (user_id, message_text, scheduled_at, status, source_telegram_message_id)
      VALUES ($1, $2, $3, 'pending', $4)
      ON CONFLICT (source_telegram_message_id)
        WHERE source_telegram_message_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `,
    [userId, messageText, scheduledAt.toISOString(), telegramMessageId]
  );

  if (rows.length === 0) {
    console.log(`[timer] duplicate telegram_message_id=${telegramMessageId}, skipped`);
    return;
  }

  console.log(`[timer] reminder created: id=${rows[0].id}`);

  const durationLabel = formatDuration(durationSeconds);
  const confirmText = label
    ? `Timer set for ${durationLabel}: ${label}`
    : `Timer set for ${durationLabel}.`;

  await sendTelegramMessage(chatId, confirmText);
}

async function handleTaskCommand(message, rawInput) {
  const chat = message.chat || {};
  const chatId = String(chat.id);
  const telegramMessageId = message.message_id ?? null;

  // Look up the app user_id for this Telegram chat
  const { rows: connRows } = await query(
    "SELECT user_id FROM telegram_connections WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [chatId]
  );

  if (connRows.length === 0) {
    await sendTelegramMessage(chatId, "You are not connected. Please send /start <your-user-id> first.");
    return;
  }

  const userId = connRows[0].user_id;
  const { title, dueAt, dateText } = extractDueDate(rawInput);

  console.log(`[task] user=${userId} title="${title}" dueAt=${dueAt?.toISOString() ?? "none"}`);

  // Use a transaction so task event + reminder are created atomically
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: eventRows } = await client.query(
      `
        INSERT INTO remote_task_events
          (user_id, telegram_chat_id, telegram_message_id, raw_input, title, due_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING
        RETURNING id
      `,
      [userId, chatId, telegramMessageId, rawInput, title, dueAt ?? null]
    );

    // Conflict means this exact Telegram message was already processed — skip silently
    if (eventRows.length === 0) {
      await client.query("ROLLBACK");
      console.log(`[task] duplicate telegram_message_id=${telegramMessageId}, skipped`);
      return;
    }

    const eventId = eventRows[0].id;
    let reminderId = null;

    if (dueAt) {
      const { rows: reminderRows } = await client.query(
        `
          INSERT INTO reminders (user_id, message_text, scheduled_at, status, remote_task_event_id)
          VALUES ($1, $2, $3, 'pending', $4)
          RETURNING id
        `,
        [userId, `Reminder: ${title}`, dueAt.toISOString(), eventId]
      );

      reminderId = reminderRows[0].id;

      await client.query(
        "UPDATE remote_task_events SET reminder_scheduled = TRUE, reminder_id = $2 WHERE id = $1",
        [eventId, reminderId]
      );

      console.log(`[task] reminder scheduled: id=${reminderId} at ${dueAt.toISOString()}`);
    }

    await client.query("COMMIT");
    console.log(`[task] event created: id=${eventId}`);

    // Send Telegram confirmation — echo the user's original date text to avoid UTC confusion
    let confirmText = `Task created: ${title}`;
    if (dueAt) {
      confirmText += `\nReminder set for: ${dateText}`;
    }
    await sendTelegramMessage(chatId, confirmText);

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function saveInboxMessage(message) {
  const chat = message.chat || {};
  const chatId = String(chat.id);

  // Look up user_id from stored connection using telegram_chat_id.
  // Use the most recently created connection in case there are duplicates.
  const { rows } = await query(
    "SELECT user_id FROM telegram_connections WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [chatId]
  );

  if (rows.length === 0) {
    // No connected user for this chat — silently discard
    return;
  }

  const userId = rows[0].user_id;

  await query(
    `
      INSERT INTO inbox_messages (user_id, telegram_chat_id, message_text, telegram_message_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING
    `,
    [userId, chatId, message.text.slice(0, 4000), message.message_id ?? null]
  );
}

async function processTelegramUpdate(update) {
  const message = update?.message;
  if (!message?.text) {
    return;
  }

  if (message.text.startsWith("/start")) {
    try {
      await handleStartCommand(message);
    } catch (error) {
      console.error("Failed processing /start command:", error);
    }
    return;
  }

  const timerInput = parseTimerPrefix(message.text);
  if (timerInput !== null) {
    try {
      await handleTimerCommand(message, timerInput);
    } catch (error) {
      console.error("Failed processing timer command:", error);
      try {
        await sendTelegramMessage(String(message.chat?.id), "Sorry, failed to set that timer. Please try again.");
      } catch {
        // ignore secondary failure
      }
    }
    return;
  }

  const taskInput = parseTaskPrefix(message.text);
  if (taskInput !== null) {
    try {
      await handleTaskCommand(message, taskInput);
    } catch (error) {
      console.error("Failed processing task command:", error);
      // Best-effort: try to notify the user something went wrong
      try {
        await sendTelegramMessage(String(message.chat?.id), "Sorry, failed to create that task. Please try again.");
      } catch {
        // ignore secondary failure
      }
    }
    return;
  }

  // Any other message goes to the user's inbox
  try {
    await saveInboxMessage(message);
  } catch (error) {
    console.error("Failed saving inbox message:", error);
  }
}

async function pollTelegramUpdates() {
  if (pollingInProgress) {
    return;
  }

  pollingInProgress = true;
  try {
    const updates = await telegramRequest("getUpdates", {
      offset: lastUpdateId + 1,
      limit: 50,
      timeout: 0
    });

    for (const update of updates) {
      if (typeof update.update_id === "number") {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
      }
      await processTelegramUpdate(update);
    }
  } catch (error) {
    console.error("Telegram polling error:", error);
  } finally {
    pollingInProgress = false;
  }
}

async function processDueReminders() {
  if (workerInProgress) {
    return;
  }

  workerInProgress = true;
  try {
    // Atomically claim a batch of due reminders by moving them to 'sending'.
    // FOR UPDATE SKIP LOCKED means two concurrent server instances will never
    // claim the same row, eliminating duplicate Telegram message delivery.
    const { rows } = await query(
      `
        WITH claimed AS (
          SELECT id FROM reminders
          WHERE status = 'pending' AND scheduled_at <= NOW()
          ORDER BY scheduled_at ASC
          LIMIT 20
          FOR UPDATE SKIP LOCKED
        )
        UPDATE reminders
        SET status = 'sending'
        FROM claimed
        WHERE reminders.id = claimed.id
        RETURNING reminders.id, reminders.user_id, reminders.message_text
      `
    );

    for (const reminder of rows) {
      // Look up telegram_chat_id for this user
      const { rows: connRows } = await query(
        "SELECT telegram_chat_id FROM telegram_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [reminder.user_id]
      );

      if (!connRows[0]?.telegram_chat_id) {
        await query(
          "UPDATE reminders SET status = 'failed', error_message = $2 WHERE id = $1",
          [reminder.id, "No Telegram connection for user_id"]
        );
        continue;
      }

      try {
        await sendTelegramMessage(connRows[0].telegram_chat_id, reminder.message_text);
        await query(
          "UPDATE reminders SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
          [reminder.id]
        );
      } catch (error) {
        console.error(`Failed to send reminder ${reminder.id}:`, error);
        await query(
          "UPDATE reminders SET status = 'failed', error_message = $2 WHERE id = $1",
          [reminder.id, sanitizeErrorMessage(error)]
        );
      }
    }
  } catch (error) {
    console.error("Reminder worker error:", error);
  } finally {
    workerInProgress = false;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/reminders", async (req, res) => {
  const { userId, messageText, scheduledAt } = req.body || {};

  if (!isValidUserId(userId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid userId. It must be a non-empty string."
    });
  }

  if (!isValidMessageText(messageText)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid messageText. It must be a non-empty string up to 2000 characters."
    });
  }

  const scheduledDate = parseScheduledAt(scheduledAt);
  if (!scheduledDate) {
    return res.status(400).json({
      ok: false,
      error: "Invalid scheduledAt. Use an ISO datetime string."
    });
  }

  try {
    const { rows } = await query(
      `
        INSERT INTO reminders (user_id, message_text, scheduled_at, status)
        VALUES ($1, $2, $3, 'pending')
        RETURNING id, user_id, message_text, scheduled_at, status, created_at
      `,
      [userId.trim(), messageText.trim(), scheduledDate.toISOString()]
    );

    return res.status(201).json({
      ok: true,
      reminder: rows[0]
    });
  } catch (error) {
    console.error("Failed to create reminder:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to create reminder."
    });
  }
});

// Returns inbox messages for a user, newest first.
// Optional query param: ?unread=true to return only unread messages.
app.get("/inbox/:userId", async (req, res) => {
  const userId = req.params.userId?.trim();

  if (!isValidUserId(userId)) {
    return res.status(400).json({ ok: false, error: "Invalid userId." });
  }

  const unreadOnly = req.query.unread === "true";

  try {
    const { rows } = await query(
      `
        SELECT id, user_id, message_text, telegram_message_id, read_at, created_at
        FROM inbox_messages
        WHERE user_id = $1
          ${unreadOnly ? "AND read_at IS NULL" : ""}
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [userId]
    );

    return res.json({ ok: true, messages: rows });
  } catch (error) {
    console.error("Failed to fetch inbox:", error);
    return res.status(500).json({ ok: false, error: "Failed to fetch inbox." });
  }
});

// Mark a single inbox message as read.
app.post("/inbox/:messageId/read", async (req, res) => {
  const messageId = Number(req.params.messageId);

  if (!Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid messageId." });
  }

  try {
    const { rowCount } = await query(
      `
        UPDATE inbox_messages
        SET read_at = NOW()
        WHERE id = $1 AND read_at IS NULL
      `,
      [messageId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Message not found or already read." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to mark message as read:", error);
    return res.status(500).json({ ok: false, error: "Failed to mark message as read." });
  }
});

// Mark all inbox messages as read for a user.
app.post("/inbox/:userId/read-all", async (req, res) => {
  const userId = req.params.userId?.trim();

  if (!isValidUserId(userId)) {
    return res.status(400).json({ ok: false, error: "Invalid userId." });
  }

  try {
    const { rowCount } = await query(
      `
        UPDATE inbox_messages
        SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL
      `,
      [userId]
    );

    return res.json({ ok: true, markedRead: rowCount });
  } catch (error) {
    console.error("Failed to mark all messages as read:", error);
    return res.status(500).json({ ok: false, error: "Failed to mark all messages as read." });
  }
});

// Returns Telegram-created task events for a user.
// Optional query param: ?processed=false (default) or ?processed=true or omit for all.
app.get("/remote-task-events", async (req, res) => {
  const userId = req.query.userId?.trim();

  if (!isValidUserId(userId)) {
    return res.status(400).json({ ok: false, error: "Invalid or missing userId query param." });
  }

  const processedParam = req.query.processed;
  const conditions = ["user_id = $1"];
  if (processedParam === "false") conditions.push("processed_by_desktop = FALSE");
  if (processedParam === "true") conditions.push("processed_by_desktop = TRUE");

  try {
    const { rows } = await query(
      `
        SELECT
          id, user_id, source, event_type, raw_input, title, due_at,
          reminder_id, reminder_scheduled,
          processed_by_desktop, processed_at, created_at
        FROM remote_task_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [userId]
    );

    return res.json({ ok: true, events: rows });
  } catch (error) {
    console.error("Failed to fetch remote task events:", error);
    return res.status(500).json({ ok: false, error: "Failed to fetch remote task events." });
  }
});

// Desktop app calls this after importing a remote task event into local storage.
app.post("/remote-task-events/:id/mark-processed", async (req, res) => {
  const eventId = Number(req.params.id);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid event id." });
  }

  try {
    const { rowCount } = await query(
      `
        UPDATE remote_task_events
        SET processed_by_desktop = TRUE, processed_at = NOW()
        WHERE id = $1 AND processed_by_desktop = FALSE
      `,
      [eventId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Event not found or already processed." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to mark event as processed:", error);
    return res.status(500).json({ ok: false, error: "Failed to mark event as processed." });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON body."
    });
  }

  console.error("Unhandled server error:", error);
  return res.status(500).json({ ok: false, error: "Internal server error." });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(`Polling Telegram every ${pollingIntervalMs}ms`);
  console.log(`Running reminder worker every ${workerIntervalMs}ms`);
});

setInterval(() => {
  void pollTelegramUpdates();
}, pollingIntervalMs);

setInterval(() => {
  void processDueReminders();
}, workerIntervalMs);

void pollTelegramUpdates();
void processDueReminders();

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
