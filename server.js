import "dotenv/config";
import express from "express";
import { pool, query } from "./db.js";

const app = express();
app.use(express.json({ limit: "100kb" }));

const port = Number(process.env.PORT || 3000);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramApiBaseUrl = `https://api.telegram.org/bot${telegramBotToken}`;
const pollingIntervalMs = Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000);
const workerIntervalMs = Number(process.env.REMINDER_WORKER_INTERVAL_MS || 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";

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

async function processTelegramUpdate(update) {
  const message = update?.message;
  if (!message?.text) {
    return;
  }

  if (!message.text.startsWith("/start")) {
    return;
  }

  try {
    await handleStartCommand(message);
  } catch (error) {
    console.error("Failed processing /start command:", error);
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
    const { rows } = await query(
      `
        SELECT
          r.id,
          r.user_id,
          r.message_text,
          tc.telegram_chat_id
        FROM reminders r
        LEFT JOIN telegram_connections tc ON tc.user_id = r.user_id
        WHERE r.status = 'pending' AND r.scheduled_at <= NOW()
        ORDER BY r.scheduled_at ASC
        LIMIT 20
      `
    );

    for (const reminder of rows) {
      if (!reminder.telegram_chat_id) {
        await query(
          `
            UPDATE reminders
            SET status = 'failed', error_message = $2
            WHERE id = $1
          `,
          [reminder.id, "No Telegram connection for user_id"]
        );
        continue;
      }

      try {
        await sendTelegramMessage(reminder.telegram_chat_id, reminder.message_text);
        await query(
          `
            UPDATE reminders
            SET status = 'sent', sent_at = NOW(), error_message = NULL
            WHERE id = $1
          `,
          [reminder.id]
        );
      } catch (error) {
        console.error(`Failed to send reminder ${reminder.id}:`, error);
        await query(
          `
            UPDATE reminders
            SET status = 'failed', error_message = $2
            WHERE id = $1
          `,
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
