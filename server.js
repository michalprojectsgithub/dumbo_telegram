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
const habitWorkerIntervalMs = Number(process.env.HABIT_WORKER_INTERVAL_MS || 60000);
// Fallback timezone offset used only if a user has not set their own via /timezone.
// UTC offset in minutes. UTC+2 = 120, UTC-5 = -300. Default: 0 (UTC).
const defaultTimezoneOffsetMinutes = Number(process.env.USER_TIMEZONE_OFFSET_MINUTES || 0);

if (!telegramBotToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

let lastUpdateId = Number(process.env.TELEGRAM_INITIAL_UPDATE_ID || 0);
let pollingInProgress = false;
let workerInProgress = false;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Converts European date formats (DD.MM or DD.MM.YYYY) to English so chrono-node can parse them.
// e.g. "30.3" → "30 March", "30.3.2026" → "30 March 2026", "5.12.2026" → "5 December 2026"
// The lookbehind/lookahead prevent matching inside version strings like "v1.2.3".
function normalizeEuropeanDates(input) {
  return input.replace(
    /(?<![.\d])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?(?![.\d])/g,
    (original, day, month, year) => {
      const monthNum = parseInt(month, 10);
      const dayNum = parseInt(day, 10);
      if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return original;
      const monthName = MONTH_NAMES[monthNum - 1];
      return year ? `${dayNum} ${monthName} ${year}` : `${dayNum} ${monthName}`;
    }
  );
}

// Extracts an optional due date from natural language input using chrono-node.
// Returns { title, dueAt, dateText, scheduleReminder } where:
//   dueAt            - parsed Date for any date expression (stored as due_at on the task event)
//   dateText         - the date phrase echoed back in confirmation messages (null if no time given)
//   scheduleReminder - true only when the user specified an explicit time (hour),
//                      meaning a reminder should actually be sent
function extractDueDate(rawInput, timezoneOffsetMinutes = 0) {
  // Normalize European dates before parsing so chrono-node understands them.
  const normalized = normalizeEuropeanDates(rawInput);
  // Pass the user's per-user timezone offset so "10:00" is interpreted as their local time.
  const results = chrono.parse(normalized, { instant: new Date(), timezone: timezoneOffsetMinutes }, { forwardDate: true });

  if (results.length === 0) {
    return { title: rawInput.trim(), dueAt: null, dateText: null, scheduleReminder: false };
  }

  const match = results[0];

  // Slice from the normalized string (match indices are relative to it)
  const before = normalized.slice(0, match.index).trimEnd();
  const after = normalized.slice(match.index + match.text.length).trimStart();

  // Remove trailing connectors left behind after stripping the date phrase
  const raw = `${before} ${after}`.trim().replace(/\s+(at|on|in|by|for)$/i, "").trim();
  const title = raw || rawInput.trim();

  // Always store the parsed date so the todo app receives it as due_at.
  // Only schedule a reminder when the user provided an explicit time (hour).
  const scheduleReminder = match.start.isCertain("hour");

  return {
    title,
    dueAt: match.date(),
    dateText: match.text,   // always the phrase the user typed, e.g. "30 March" or "tomorrow at 10:00"
    scheduleReminder
  };
}

// --- Habit reminder helpers ---

// Computes the next UTC fire time for a habit given its schedule and user timezone.
// daysOfWeek: array of integers 0-6 (0=Sun, 1=Mon, ..., 6=Sat)
// timeOfDay: "HH:MM" or "HH:MM:SS" string in the user's local time
// Returns a Date (UTC) for the next occurrence after now, or null if daysOfWeek is empty.
function computeNextFireAt(daysOfWeek, timeOfDay, timezoneOffsetMinutes) {
  if (!daysOfWeek || daysOfWeek.length === 0) return null;
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();

  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    // Shift current time into user's local timezone by treating UTC as local
    const localMs = now.getTime() + timezoneOffsetMinutes * 60 * 1000;
    const localCandidate = new Date(localMs);
    localCandidate.setUTCDate(localCandidate.getUTCDate() + daysAhead);
    localCandidate.setUTCHours(hours, minutes, 0, 0);

    if (daysOfWeek.includes(localCandidate.getUTCDay())) {
      // Convert local candidate back to UTC
      const fireAtUtc = new Date(localCandidate.getTime() - timezoneOffsetMinutes * 60 * 1000);
      if (fireAtUtc > now) return fireAtUtc;
    }
  }

  return null;
}

function computeNextMorningBriefAt(timezoneOffsetMinutes) {
  const now = new Date();
  const localMs = now.getTime() + timezoneOffsetMinutes * 60 * 1000;
  const localNow = new Date(localMs);

  const today6am = new Date(localNow);
  today6am.setUTCHours(6, 0, 0, 0);

  const local6amUtc = new Date(today6am.getTime() - timezoneOffsetMinutes * 60 * 1000);
  if (local6amUtc > now) return local6amUtc;

  const tomorrow6am = new Date(today6am.getTime() + 24 * 60 * 60 * 1000);
  return new Date(tomorrow6am.getTime() - timezoneOffsetMinutes * 60 * 1000);
}

async function processHabitReminders() {
  try {
    // Atomically claim due habits to prevent duplicate delivery across server instances
    const { rows } = await query(
      `
        WITH claimed AS (
          SELECT id FROM habit_reminders
          WHERE active = TRUE AND next_fire_at <= NOW()
          ORDER BY next_fire_at ASC
          LIMIT 20
          FOR UPDATE SKIP LOCKED
        )
        UPDATE habit_reminders
        SET last_notified_at = NOW()
        FROM claimed
        WHERE habit_reminders.id = claimed.id
        RETURNING habit_reminders.id, habit_reminders.user_id, habit_reminders.title,
                  habit_reminders.days_of_week, habit_reminders.time_of_day,
                  habit_reminders.timezone_offset_minutes
      `
    );

    for (const habit of rows) {
      const { rows: connRows } = await query(
        "SELECT telegram_chat_id FROM telegram_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [habit.user_id]
      );

      if (connRows[0]?.telegram_chat_id) {
        try {
          await sendTelegramMessage(connRows[0].telegram_chat_id, `🔁 Habit reminder: ${habit.title}`);
          console.log(`[habits] Sent habit id=${habit.id} title="${habit.title}"`);
        } catch (error) {
          console.error(`[habits] Failed to send habit id=${habit.id}:`, error);
        }
      } else {
        console.error(`[habits] No Telegram connection for user_id=${habit.user_id}`);
      }

      // Always advance to the next occurrence regardless of send success
      const nextFireAt = computeNextFireAt(habit.days_of_week, habit.time_of_day, habit.timezone_offset_minutes);
      await query(
        "UPDATE habit_reminders SET next_fire_at = $2 WHERE id = $1",
        [habit.id, nextFireAt]
      );
    }
  } catch (error) {
    console.error("[habits] Worker error:", error);
  }

  await processMorningBriefs();
}

async function processMorningBriefs() {
  try {
    const { rows: users } = await query(
      `
        SELECT user_id, telegram_chat_id, timezone_offset_minutes
        FROM telegram_connections
        WHERE next_morning_brief_at IS NOT NULL AND next_morning_brief_at <= NOW()
      `
    );

    for (const user of users) {
      const tzOffset = user.timezone_offset_minutes ?? 0;
      const now = new Date();
      const localNow = new Date(now.getTime() + tzOffset * 60 * 1000);
      const userId = user.user_id;
      const chatId = user.telegram_chat_id;

      const localDayStart = new Date(localNow);
      localDayStart.setUTCHours(0, 0, 0, 0);
      const localDayEnd = new Date(localNow);
      localDayEnd.setUTCHours(23, 59, 59, 999);
      const utcDayStart = new Date(localDayStart.getTime() - tzOffset * 60 * 1000);
      const utcDayEnd = new Date(localDayEnd.getTime() - tzOffset * 60 * 1000);

      const utcYesterdayStart = new Date(utcDayStart.getTime() - 24 * 60 * 60 * 1000);
      const utcYesterdayEnd = new Date(utcDayEnd.getTime() - 24 * 60 * 60 * 1000);

      const { rows: todayTasks } = await query(
        `
          SELECT title, due_at, has_time FROM todos
          WHERE user_id = $1 AND completed = FALSE AND due_at >= $2 AND due_at <= $3
          UNION ALL
          SELECT title, due_at, has_time FROM remote_task_events
          WHERE user_id = $1 AND due_at >= $2 AND due_at <= $3 AND processed_by_desktop = FALSE
          ORDER BY has_time DESC, due_at ASC
        `,
        [userId, utcDayStart.toISOString(), utcDayEnd.toISOString()]
      );

      const { rows: carriedOver } = await query(
        `
          SELECT title, due_at, has_time FROM todos
          WHERE user_id = $1 AND completed = FALSE AND due_at >= $2 AND due_at <= $3
          ORDER BY has_time DESC, due_at ASC
        `,
        [userId, utcYesterdayStart.toISOString(), utcYesterdayEnd.toISOString()]
      );

      const localDayOfWeek = localNow.getUTCDay();
      const { rows: todayHabits } = await query(
        `
          SELECT title, time_of_day FROM habit_reminders
          WHERE user_id = $1 AND active = TRUE AND $2 = ANY(days_of_week)
          ORDER BY time_of_day ASC
        `,
        [userId, localDayOfWeek]
      );

      // Advance to tomorrow's 6 AM regardless of whether we send
      const nextBrief = computeNextMorningBriefAt(tzOffset);
      await query("UPDATE telegram_connections SET next_morning_brief_at = $2 WHERE user_id = $1", [userId, nextBrief.toISOString()]);

      if (todayTasks.length === 0 && carriedOver.length === 0 && todayHabits.length === 0) continue;

      const lines = ["Morning brief\n"];

      if (todayTasks.length > 0) {
        lines.push("Today's tasks:");
        for (const t of todayTasks) {
          if (t.has_time && t.due_at) {
            const localTime = new Date(new Date(t.due_at).getTime() + tzOffset * 60 * 1000);
            const h = localTime.getUTCHours();
            const m = String(localTime.getUTCMinutes()).padStart(2, "0");
            lines.push(`- ${h}:${m} ${t.title}`);
          } else {
            lines.push(`- ${t.title}`);
          }
        }
      }

      if (carriedOver.length > 0) {
        if (todayTasks.length > 0) lines.push("");
        lines.push("Carried over from yesterday:");
        for (const t of carriedOver) {
          lines.push(`- ${t.title}`);
        }
      }

      if (todayHabits.length > 0) {
        if (todayTasks.length > 0 || carriedOver.length > 0) lines.push("");
        lines.push("Today's habits:");
        for (const h of todayHabits) {
          const [hh, mm] = String(h.time_of_day).split(":");
          const hour = parseInt(hh, 10);
          const min = mm || "00";
          lines.push(`- ${hour}:${min} ${h.title}`);
        }
      }

      try {
        await sendTelegramMessage(chatId, lines.join("\n"));
        console.log(`[brief] Sent morning brief to user=${userId}`);
      } catch (error) {
        console.error(`[brief] Failed to send to user=${userId}:`, error);
      }
    }
  } catch (error) {
    console.error("[brief] Worker error:", error);
  }
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

  const nextBrief = computeNextMorningBriefAt(defaultTimezoneOffsetMinutes);

  await query(
    `
      INSERT INTO telegram_connections (user_id, telegram_chat_id, telegram_username, next_morning_brief_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id)
      DO UPDATE SET
        telegram_chat_id = EXCLUDED.telegram_chat_id,
        telegram_username = EXCLUDED.telegram_username,
        next_morning_brief_at = COALESCE(telegram_connections.next_morning_brief_at, EXCLUDED.next_morning_brief_at)
    `,
    [resolvedUserId, String(chat.id), telegramUsername, nextBrief.toISOString()]
  );

  await sendTelegramMessage(
    chat.id,
    "Connected. I can send you reminders now.\n\n" +
    "Set your timezone so task times are correct:\n" +
    "  /timezone GMT+2\n" +
    "  /timezone Europe/Prague\n" +
    "  /timezone +2\n\n" +
    "Commands:\n" +
    "  task <text> [time]   — create a task\n" +
    "  timer <duration> [label]   — set a timer\n" +
    "  agenda   — show today's tasks\n" +
    "  /timezone <offset>   — set your timezone"
  );
}

// Parses timezone input into a UTC offset in minutes.
// Accepts: +2, -5, +5.5, GMT+2, UTC+2, UTC-5, UTC+5:30, CET, EST, Europe/Prague, etc.
// Returns offset in minutes or null if unparseable.
function parseTimezoneInput(raw) {
  const text = raw.trim();

  // Named IANA timezone (e.g. "Europe/Prague", "America/New_York")
  if (/^[A-Za-z_]+\/[A-Za-z_]+/.test(text)) {
    try {
      // Get UTC offset by formatting a date in that timezone and reading the offset
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: text,
        timeZoneName: "shortOffset"
      }).formatToParts(now);
      const offsetStr = parts.find(p => p.type === "timeZoneName")?.value || "";
      // offsetStr is like "GMT+2", "GMT-5", "GMT+5:30", "GMT"
      return parseGmtOffsetString(offsetStr);
    } catch {
      return null; // invalid IANA name
    }
  }

  // GMT+2, UTC+2, UTC-5, UTC+5:30, GMT, UTC
  if (/^(GMT|UTC)/i.test(text)) {
    return parseGmtOffsetString(text);
  }

  // Plain numeric: +2, -5, +5.5, 120, -300
  const numMatch = text.match(/^([+-]?\d+(?:[.:]\d+)?)$/);
  if (numMatch) {
    return numericToOffsetMinutes(numMatch[1]);
  }

  // Common abbreviations mapped to fixed offsets
  const abbreviations = {
    UTC: 0, GMT: 0,
    WET: 0, CET: 60, CEST: 120, EET: 120, EEST: 180,
    MSK: 180, IST: 330, CST: -360, EST: -300, EDT: -240,
    PST: -480, PDT: -420, MST: -420, MDT: -360
  };
  const upper = text.toUpperCase();
  if (Object.hasOwn(abbreviations, upper)) {
    return abbreviations[upper];
  }

  return null;
}

// Parses "GMT+2", "GMT-5", "GMT+5:30", "UTC+2", "GMT" into minutes.
function parseGmtOffsetString(str) {
  const clean = str.replace(/^(GMT|UTC)/i, "").trim();
  if (!clean || clean === "") return 0; // plain "GMT" or "UTC"
  return numericToOffsetMinutes(clean);
}

// Converts "+2", "-5", "+5:30", "+5.5", "120" into offset minutes.
function numericToOffsetMinutes(str) {
  // Handle HH:MM format like +5:30
  const colonMatch = str.match(/^([+-]?\d+):(\d+)$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1], 10);
    const mins = parseInt(colonMatch[2], 10);
    return hours * 60 + (hours < 0 ? -mins : mins);
  }

  const value = parseFloat(str);
  if (Number.isNaN(value)) return null;

  // Values -18 to +18 treated as hours; outside that as minutes
  const offsetMinutes = Math.abs(value) <= 18
    ? Math.round(value * 60)
    : Math.round(value);

  if (offsetMinutes < -840 || offsetMinutes > 840) return null;
  return offsetMinutes;
}

async function handleTimezoneCommand(message, rawInput) {
  const chat = message.chat || {};
  const chatId = String(chat.id);

  const offset = parseTimezoneInput(rawInput);
  if (offset === null) {
    await sendTelegramMessage(
      chatId,
      "Could not parse that timezone.\n\n" +
      "Accepted formats:\n" +
      "  /timezone +2\n" +
      "  /timezone GMT+2\n" +
      "  /timezone UTC+2\n" +
      "  /timezone Europe/Prague\n" +
      "  /timezone America/New_York\n" +
      "  /timezone CET\n\n" +
      "Find your timezone name at: worldtimeserver.com"
    );
    return;
  }

  const { rows } = await query(
    "SELECT user_id FROM telegram_connections WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [chatId]
  );

  if (rows.length === 0) {
    await sendTelegramMessage(chatId, "You are not connected. Please send /start <your-user-id> first.");
    return;
  }

  const nextBrief = computeNextMorningBriefAt(offset);

  await query(
    "UPDATE telegram_connections SET timezone_offset_minutes = $1, next_morning_brief_at = $3 WHERE user_id = $2",
    [offset, rows[0].user_id, nextBrief.toISOString()]
  );

  const sign = offset >= 0 ? "+" : "";
  const hours = (offset / 60).toFixed(1).replace(".0", "");
  await sendTelegramMessage(chatId, `Timezone set to UTC${sign}${hours}. Task times will now be interpreted in your local time.`);
  console.log(`[timezone] user=${rows[0].user_id} set timezone_offset_minutes=${offset}`);
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

  // Look up the app user_id and timezone for this Telegram chat
  const { rows: connRows } = await query(
    "SELECT user_id, timezone_offset_minutes FROM telegram_connections WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [chatId]
  );

  if (connRows.length === 0) {
    await sendTelegramMessage(chatId, "You are not connected. Please send /start <your-user-id> first.");
    return;
  }

  const userId = connRows[0].user_id;
  const timezoneOffset = connRows[0].timezone_offset_minutes ?? defaultTimezoneOffsetMinutes;
  const { title, dueAt, dateText, scheduleReminder } = extractDueDate(rawInput, timezoneOffset);

  console.log(`[task] user=${userId} title="${title}" dueAt=${dueAt?.toISOString() ?? "none"}`);

  // Use a transaction so task event + reminder are created atomically
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: eventRows } = await client.query(
      `
        INSERT INTO remote_task_events
          (user_id, telegram_chat_id, telegram_message_id, raw_input, title, due_at, has_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING
        RETURNING id
      `,
      [userId, chatId, telegramMessageId, rawInput, title, dueAt ?? null, scheduleReminder]
    );

    // Conflict means this exact Telegram message was already processed — skip silently
    if (eventRows.length === 0) {
      await client.query("ROLLBACK");
      console.log(`[task] duplicate telegram_message_id=${telegramMessageId}, skipped`);
      return;
    }

    const eventId = eventRows[0].id;
    let reminderId = null;

    if (dueAt && scheduleReminder) {
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
    if (scheduleReminder && dateText) {
      confirmText += `\nReminder set for: ${dateText}`;
    } else if (dateText) {
      confirmText += `\nDue: ${dateText}`;
    }
    await sendTelegramMessage(chatId, confirmText);

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function handleAgendaCommand(message) {
  const chat = message.chat || {};
  const chatId = String(chat.id);

  const { rows: connRows } = await query(
    "SELECT user_id, timezone_offset_minutes FROM telegram_connections WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [chatId]
  );

  if (connRows.length === 0) {
    await sendTelegramMessage(chatId, "You are not connected. Please send /start <your-user-id> first.");
    return;
  }

  const userId = connRows[0].user_id;
  const tzOffset = connRows[0].timezone_offset_minutes ?? 0;

  // Compute today's start and end in UTC relative to the user's local timezone
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffset * 60 * 1000);

  const localDayStart = new Date(localNow);
  localDayStart.setUTCHours(0, 0, 0, 0);
  const localDayEnd = new Date(localNow);
  localDayEnd.setUTCHours(23, 59, 59, 999);

  const utcDayStart = new Date(localDayStart.getTime() - tzOffset * 60 * 1000);
  const utcDayEnd = new Date(localDayEnd.getTime() - tzOffset * 60 * 1000);

  const { rows: todos } = await query(
    `
      SELECT title, due_at, has_time
      FROM todos
      WHERE user_id = $1
        AND completed = FALSE
        AND due_at >= $2
        AND due_at <= $3

      UNION ALL

      SELECT title, due_at, has_time
      FROM remote_task_events
      WHERE user_id = $1
        AND due_at >= $2
        AND due_at <= $3
        AND processed_by_desktop = FALSE

      ORDER BY has_time DESC, due_at ASC
    `,
    [userId, utcDayStart.toISOString(), utcDayEnd.toISOString()]
  );

  if (todos.length === 0) {
    await sendTelegramMessage(chatId, "📅 No tasks due today.");
    return;
  }

  const dayName = localNow.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const dateStr = localNow.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

  const lines = [`📅 Today's agenda — ${dayName}, ${dateStr}\n`];

  for (const todo of todos) {
    if (todo.has_time && todo.due_at) {
      const localTime = new Date(new Date(todo.due_at).getTime() + tzOffset * 60 * 1000);
      const h = localTime.getUTCHours();
      const m = String(localTime.getUTCMinutes()).padStart(2, "0");
      lines.push(`• ${h}:${m} ${todo.title}`);
    } else {
      lines.push(`• ${todo.title}`);
    }
  }

  lines.push(`\n${todos.length} task${todos.length !== 1 ? "s" : ""} today`);
  await sendTelegramMessage(chatId, lines.join("\n"));
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

  if (/^\/timezone\s+/i.test(message.text)) {
    const tzInput = message.text.replace(/^\/timezone\s+/i, "").trim();
    try {
      await handleTimezoneCommand(message, tzInput);
    } catch (error) {
      console.error("Failed processing /timezone command:", error);
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

  if (/^\/?(agenda)$/i.test(message.text.trim())) {
    try {
      await handleAgendaCommand(message);
    } catch (error) {
      console.error("Failed processing agenda command:", error);
      try {
        await sendTelegramMessage(String(message.chat?.id), "Sorry, failed to load the agenda. Please try again.");
      } catch {}
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
    // Clean up sent reminders older than 1 day to keep the DB lean.
    const { rowCount: deleted } = await query(
      `DELETE FROM reminders
       WHERE status = 'sent'
         AND sent_at < NOW() - INTERVAL '1 day'`
    );
    if (deleted > 0) {
      console.log(`[cleanup] deleted ${deleted} old sent reminder(s)`);
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
        DELETE FROM inbox_messages
        WHERE id IN (
          SELECT id FROM inbox_messages
          WHERE user_id = $1
            ${unreadOnly ? "AND read_at IS NULL" : ""}
          ORDER BY created_at DESC
          LIMIT 100
        )
        RETURNING id, user_id, message_text, telegram_message_id, read_at, created_at
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
          id, user_id, source, event_type, raw_input, title, due_at, has_time,
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
// Moves the event into the todos table (using the desktop's appTodoId) and deletes the source row.
app.post("/remote-task-events/:id/mark-processed", async (req, res) => {
  const eventId = Number(req.params.id);
  const appTodoId = typeof req.body?.appTodoId === "string" && req.body.appTodoId.trim().length > 0
    ? req.body.appTodoId.trim()
    : null;

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid event id." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT user_id, title, due_at, has_time FROM remote_task_events WHERE id = $1",
      [eventId]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Event not found or already processed." });
    }

    const event = rows[0];
    const todoId = appTodoId || `rte_${eventId}`;

    await client.query(
      `
        INSERT INTO todos (app_todo_id, user_id, title, due_at, has_time, completed)
        VALUES ($1, $2, $3, $4, $5, FALSE)
        ON CONFLICT (user_id, app_todo_id) DO UPDATE SET
          title    = EXCLUDED.title,
          due_at   = EXCLUDED.due_at,
          has_time = EXCLUDED.has_time,
          updated_at = NOW()
      `,
      [todoId, event.user_id, event.title, event.due_at, event.has_time]
    );

    await client.query("DELETE FROM remote_task_events WHERE id = $1", [eventId]);

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to mark event as processed:", error);
    return res.status(500).json({ ok: false, error: "Failed to mark event as processed." });
  } finally {
    client.release();
  }
});

// Keeps the reminders table in sync with a todo's current state.
// - Creates a pending reminder when the todo has an explicit time and is not completed.
// - Deletes any pending reminder when the todo is completed, has no date, or has no time.
async function syncReminderForTodo(client, userId, appTodoId, title, dueAt, hasTime, completed) {
  const { rows: existing } = await client.query(
    `SELECT id, status FROM reminders
     WHERE user_id = $1 AND app_todo_id = $2
     LIMIT 1`,
    [userId, appTodoId]
  );

  const shouldHaveReminder = hasTime && dueAt && !completed;

  if (!shouldHaveReminder) {
    if (existing.length > 0) {
      await client.query("DELETE FROM reminders WHERE id = $1", [existing[0].id]);
    }
    return;
  }

  // Already sent or failed — don't re-create.
  if (existing.length > 0 && (existing[0].status === 'sent' || existing[0].status === 'failed')) {
    return;
  }

  if (existing.length > 0) {
    await client.query(
      "UPDATE reminders SET message_text = $2, scheduled_at = $3 WHERE id = $1",
      [existing[0].id, `Reminder: ${title}`, dueAt]
    );
  } else {
    await client.query(
      `INSERT INTO reminders (user_id, message_text, scheduled_at, status, app_todo_id)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [userId, `Reminder: ${title}`, dueAt, appTodoId]
    );
  }
}

function isValidTimeOfDay(value) {
  return typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value);
}

function isValidDaysOfWeek(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every(d => Number.isInteger(d) && d >= 0 && d <= 6);
}

// POST /habit-reminders — create a repeating habit reminder
app.post("/habit-reminders", async (req, res) => {
  const { userId, title, scheduleType, daysOfWeek, timeOfDay, timezoneOffsetMinutes } = req.body || {};

  if (!isValidUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid userId." });
  if (!isValidMessageText(title)) return res.status(400).json({ ok: false, error: "Invalid title." });
  if (!["daily", "weekly", "custom"].includes(scheduleType)) {
    return res.status(400).json({ ok: false, error: "scheduleType must be 'daily', 'weekly', or 'custom'." });
  }
  if (!isValidDaysOfWeek(daysOfWeek)) {
    return res.status(400).json({ ok: false, error: "daysOfWeek must be a non-empty array of integers 0–6." });
  }
  if (!isValidTimeOfDay(timeOfDay)) {
    return res.status(400).json({ ok: false, error: "timeOfDay must be in HH:MM format." });
  }

  const tzOffset = Number.isInteger(timezoneOffsetMinutes) ? timezoneOffsetMinutes : 0;
  const nextFireAt = computeNextFireAt(daysOfWeek, timeOfDay, tzOffset);

  try {
    const { rows } = await query(
      `
        INSERT INTO habit_reminders
          (user_id, title, schedule_type, days_of_week, time_of_day, timezone_offset_minutes, next_fire_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, user_id, title, schedule_type, days_of_week, time_of_day,
                  timezone_offset_minutes, active, next_fire_at, last_notified_at, created_at
      `,
      [userId.trim(), title.trim(), scheduleType, daysOfWeek, timeOfDay, tzOffset, nextFireAt]
    );
    return res.status(201).json({ ok: true, habit: rows[0] });
  } catch (error) {
    console.error("Failed to create habit:", error);
    return res.status(500).json({ ok: false, error: "Failed to create habit reminder." });
  }
});

// GET /habit-reminders?userId=... — list all habits for a user
app.get("/habit-reminders", async (req, res) => {
  const userId = req.query.userId?.trim();
  if (!isValidUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid or missing userId." });

  try {
    const { rows } = await query(
      `
        SELECT id, user_id, title, schedule_type, days_of_week, time_of_day,
               timezone_offset_minutes, active, next_fire_at, last_notified_at, created_at
        FROM habit_reminders
        WHERE user_id = $1
        ORDER BY created_at DESC
      `,
      [userId]
    );
    return res.json({ ok: true, habits: rows });
  } catch (error) {
    console.error("Failed to fetch habits:", error);
    return res.status(500).json({ ok: false, error: "Failed to fetch habit reminders." });
  }
});

// PATCH /habit-reminders/:id — update title, schedule, or active status
app.patch("/habit-reminders/:id", async (req, res) => {
  const habitId = Number(req.params.id);
  if (!Number.isInteger(habitId) || habitId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid habit id." });
  }

  const { title, scheduleType, daysOfWeek, timeOfDay, timezoneOffsetMinutes, active } = req.body || {};
  const sets = [];
  const values = [];
  let idx = 1;

  if (title !== undefined) {
    if (!isValidMessageText(title)) return res.status(400).json({ ok: false, error: "Invalid title." });
    sets.push(`title = $${idx++}`); values.push(title.trim());
  }
  if (scheduleType !== undefined) {
    if (!["daily", "weekly", "custom"].includes(scheduleType)) {
      return res.status(400).json({ ok: false, error: "Invalid scheduleType." });
    }
    sets.push(`schedule_type = $${idx++}`); values.push(scheduleType);
  }
  if (daysOfWeek !== undefined) {
    if (!isValidDaysOfWeek(daysOfWeek)) return res.status(400).json({ ok: false, error: "Invalid daysOfWeek." });
    sets.push(`days_of_week = $${idx++}`); values.push(daysOfWeek);
  }
  if (timeOfDay !== undefined) {
    if (!isValidTimeOfDay(timeOfDay)) return res.status(400).json({ ok: false, error: "timeOfDay must be HH:MM." });
    sets.push(`time_of_day = $${idx++}`); values.push(timeOfDay);
  }
  if (timezoneOffsetMinutes !== undefined) {
    sets.push(`timezone_offset_minutes = $${idx++}`); values.push(Number(timezoneOffsetMinutes));
  }
  if (active !== undefined) {
    sets.push(`active = $${idx++}`); values.push(Boolean(active));
  }

  if (sets.length === 0) return res.status(400).json({ ok: false, error: "No fields to update." });

  try {
    const { rows: existing } = await query("SELECT * FROM habit_reminders WHERE id = $1", [habitId]);
    if (existing.length === 0) return res.status(404).json({ ok: false, error: "Habit not found." });

    const current = existing[0];
    const scheduleChanged = daysOfWeek !== undefined || timeOfDay !== undefined || timezoneOffsetMinutes !== undefined;
    const reactivating = active === true && !current.active;

    if (scheduleChanged || reactivating) {
      const newDays = daysOfWeek ?? current.days_of_week;
      const newTime = timeOfDay ?? current.time_of_day;
      const newTz = timezoneOffsetMinutes ?? current.timezone_offset_minutes;
      sets.push(`next_fire_at = $${idx++}`);
      values.push(computeNextFireAt(newDays, newTime, newTz));
    }

    values.push(habitId);
    const { rows } = await query(
      `UPDATE habit_reminders SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    return res.json({ ok: true, habit: rows[0] });
  } catch (error) {
    console.error("Failed to update habit:", error);
    return res.status(500).json({ ok: false, error: "Failed to update habit reminder." });
  }
});

// DELETE /habit-reminders/:id — permanently remove a habit
app.delete("/habit-reminders/:id", async (req, res) => {
  const habitId = Number(req.params.id);
  if (!Number.isInteger(habitId) || habitId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid habit id." });
  }

  try {
    const { rowCount } = await query("DELETE FROM habit_reminders WHERE id = $1", [habitId]);
    if (rowCount === 0) return res.status(404).json({ ok: false, error: "Habit not found." });
    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete habit:", error);
    return res.status(500).json({ ok: false, error: "Failed to delete habit reminder." });
  }
});

// POST /todos — create or update (upsert) a todo by userId + appTodoId.
// The desktop app calls this whenever a todo is created or changed.
// Automatically manages a Telegram reminder if the todo has an explicit date+time.
app.post("/todos", async (req, res) => {
  const { userId, appTodoId, title, dueAt, hasTime, completed } = req.body || {};

  if (!isValidUserId(userId)) {
    return res.status(400).json({ ok: false, error: "Invalid userId." });
  }
  if (typeof appTodoId !== "string" || appTodoId.trim().length === 0) {
    return res.status(400).json({ ok: false, error: "Invalid appTodoId." });
  }
  if (!isValidMessageText(title)) {
    return res.status(400).json({ ok: false, error: "Invalid title." });
  }

  const parsedDueAt = dueAt ? parseScheduledAt(dueAt) : null;
  if (dueAt && !parsedDueAt) {
    return res.status(400).json({ ok: false, error: "Invalid dueAt. Use an ISO datetime string." });
  }

  const isHasTime = Boolean(hasTime);
  const isCompleted = Boolean(completed);
  const completedAt = isCompleted ? new Date() : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
        INSERT INTO todos (app_todo_id, user_id, title, due_at, has_time, completed, completed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, app_todo_id) DO UPDATE SET
          title        = EXCLUDED.title,
          due_at       = EXCLUDED.due_at,
          has_time     = EXCLUDED.has_time,
          completed    = EXCLUDED.completed,
          completed_at = CASE
            WHEN EXCLUDED.completed AND NOT todos.completed THEN NOW()
            WHEN NOT EXCLUDED.completed THEN NULL
            ELSE todos.completed_at
          END,
          updated_at   = NOW()
        RETURNING *
      `,
      [appTodoId.trim(), userId.trim(), title.trim(), parsedDueAt, isHasTime, isCompleted, completedAt]
    );

    await syncReminderForTodo(client, userId.trim(), appTodoId.trim(), title.trim(), parsedDueAt, isHasTime, isCompleted);

    await client.query("COMMIT");
    return res.status(201).json({ ok: true, todo: rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to upsert todo:", error);
    return res.status(500).json({ ok: false, error: "Failed to save todo." });
  } finally {
    client.release();
  }
});

// GET /todos?userId=...&completed=false|true — list todos for a user.
app.get("/todos", async (req, res) => {
  const userId = req.query.userId?.trim();
  if (!isValidUserId(userId)) {
    return res.status(400).json({ ok: false, error: "Invalid or missing userId." });
  }

  const completedParam = req.query.completed;
  let filter = "";
  if (completedParam === "false") filter = "AND completed = FALSE";
  if (completedParam === "true") filter = "AND completed = TRUE";

  try {
    const { rows } = await query(
      `
        SELECT id, app_todo_id, user_id, title, due_at, has_time,
               completed, completed_at, created_at, updated_at
        FROM todos
        WHERE user_id = $1 ${filter}
        ORDER BY due_at ASC NULLS LAST, created_at DESC
        LIMIT 500
      `,
      [userId]
    );
    return res.json({ ok: true, todos: rows });
  } catch (error) {
    console.error("Failed to fetch todos:", error);
    return res.status(500).json({ ok: false, error: "Failed to fetch todos." });
  }
});

// DELETE /todos/:appTodoId?userId=... — delete a todo and cancel its pending reminder.
app.delete("/todos/:appTodoId", async (req, res) => {
  const appTodoId = req.params.appTodoId?.trim();
  const userId = req.query.userId?.trim();

  if (!appTodoId) return res.status(400).json({ ok: false, error: "Invalid appTodoId." });
  if (!isValidUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid userId." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Remove any pending reminder first
    await client.query(
      "DELETE FROM reminders WHERE user_id = $1 AND app_todo_id = $2 AND status IN ('pending', 'sending')",
      [userId, appTodoId]
    );

    const { rowCount } = await client.query(
      "DELETE FROM todos WHERE user_id = $1 AND app_todo_id = $2",
      [userId, appTodoId]
    );

    await client.query("COMMIT");

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Todo not found." });
    }
    return res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to delete todo:", error);
    return res.status(500).json({ ok: false, error: "Failed to delete todo." });
  } finally {
    client.release();
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
  console.log(`Running habit worker every ${habitWorkerIntervalMs}ms`);
});

setInterval(() => {
  void pollTelegramUpdates();
}, pollingIntervalMs);

setInterval(() => {
  void processDueReminders();
}, workerIntervalMs);

setInterval(() => {
  void processHabitReminders();
}, habitWorkerIntervalMs);

void pollTelegramUpdates();
void processDueReminders();
void processHabitReminders();

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
