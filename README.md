# Telegram Reminder Backend (Node + Express + PostgreSQL)

Minimal, production-minded backend for a desktop reminder app that delivers reminders through Telegram even when the desktop app (or PC) is offline.

## Features

- Telegram bot integration using Bot API polling (`getUpdates`)
- Handles `/start` and stores Telegram chat connection
- `POST /reminders` endpoint to schedule reminders
- Worker loop that delivers due reminders via Telegram `sendMessage`
- Reminder status tracking: `pending`, `sent`, `failed`
- Health check endpoint: `GET /health`

## Project Structure

- `package.json`
- `server.js`
- `db.js`
- `sql/init.sql`
- `.env.example`
- `README.md`

## 1) Create a Telegram Bot (BotFather)

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Choose a bot name and username
4. Copy the bot token BotFather gives you
5. Put that token into `TELEGRAM_BOT_TOKEN` in your `.env`

## 2) Setup Environment Variables

Copy `.env.example` to `.env` and fill values:

```env
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/telegram_reminder
DATABASE_SSL=false
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_POLL_INTERVAL_MS=3000
REMINDER_WORKER_INTERVAL_MS=3000
TELEGRAM_INITIAL_UPDATE_ID=0
CORS_ORIGIN=*
```

Notes:

- `DATABASE_URL` is required.
- Set `DATABASE_SSL=true` on hosted databases that require SSL (Railway/Render often do).
- Set `CORS_ORIGIN` to your app origin in production (for local MVP, `*` is fine).

## 3) Install and Run Locally

```bash
npm install
```

Create DB tables:

```bash
psql "$DATABASE_URL" -f sql/init.sql
```

Run server:

```bash
npm start
```

## 4) Connect Telegram User

Send this to your bot in Telegram:

```text
/start your-user-id
```

The backend will:

- Save/update `telegram_connections` with that `user_id` and your Telegram `chat_id`
- Reply:
  - `Connected. I can send you reminders now.`

If `/start` has no argument, backend falls back to Telegram user id as `user_id`.

## 5) API Endpoints

### `GET /health`

Response:

```json
{ "ok": true }
```

### `POST /reminders`

Request body:

```json
{
  "userId": "string",
  "messageText": "string",
  "scheduledAt": "ISO datetime string"
}
```

Validation:

- `userId` required, non-empty string
- `messageText` required, non-empty string (max 2000 chars)
- `scheduledAt` required, valid ISO datetime string

Success response (`201`):

```json
{
  "ok": true,
  "reminder": {
    "id": 1,
    "user_id": "user-123",
    "message_text": "Drink water",
    "scheduled_at": "2026-03-27T20:00:00.000Z",
    "status": "pending",
    "created_at": "2026-03-27T19:58:00.000Z"
  }
}
```

## 6) Test With curl

Health:

```bash
curl http://localhost:3000/health
```

Create reminder:

```bash
curl -X POST http://localhost:3000/reminders \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "your-user-id",
    "messageText": "Reminder from backend",
    "scheduledAt": "2026-03-27T21:00:00.000Z"
  }'
```

## How Polling Works

- Every `TELEGRAM_POLL_INTERVAL_MS`, backend calls Telegram `getUpdates`
- Tracks `lastUpdateId` in memory and uses offset to avoid reprocessing
- Processes `/start` commands and stores Telegram connection
- Sends a confirmation message back to the chat

## How Reminder Scheduling Works

- Desktop app calls `POST /reminders` with `userId`, message, and time
- Reminder is inserted as `status='pending'`
- Every `REMINDER_WORKER_INTERVAL_MS`, worker checks due reminders
- For each due reminder:
  - If connection exists: sends Telegram message and marks `sent`
  - If delivery fails: marks `failed` and stores `error_message`

## 7) Telegram Inbox

Any message a user sends to the bot (that is not `/start`) is stored in the `inbox_messages` table and available via API so your todo app can display it.

### How it works

- User sends any message to the bot
- Backend polls Telegram, looks up `telegram_connections` by `chat_id` to find `user_id`
- Message is saved to `inbox_messages` with `read_at = NULL`
- Todo app pulls inbox via API and marks messages read

### `GET /inbox/:userId`

Returns messages newest-first. Add `?unread=true` to get only unread ones.

```bash
curl http://localhost:3000/inbox/dumbo-189cbdd4
curl http://localhost:3000/inbox/dumbo-189cbdd4?unread=true
```

Response:

```json
{
  "ok": true,
  "messages": [
    {
      "id": 1,
      "user_id": "dumbo-189cbdd4",
      "message_text": "hello from telegram",
      "telegram_message_id": 42,
      "read_at": null,
      "created_at": "2026-03-27T21:00:00.000Z"
    }
  ]
}
```

### `POST /inbox/:messageId/read`

Mark a single message as read:

```bash
curl -X POST http://localhost:3000/inbox/1/read
```

### `POST /inbox/:userId/read-all`

Mark all messages for a user as read:

```bash
curl -X POST http://localhost:3000/inbox/dumbo-189cbdd4/read-all
```

### Run migration for new table

If you already have the DB running from a previous version, run init.sql again — all statements use `CREATE TABLE IF NOT EXISTS` so it is safe to re-run:

```bash
psql "$DATABASE_URL" -f sql/init.sql
```

## Deploy Notes (Railway / Render)

- Set env vars in platform dashboard
- Ensure PostgreSQL is provisioned and `DATABASE_URL` is correct
- Run `sql/init.sql` once against production database
- Use `npm start` as start command

