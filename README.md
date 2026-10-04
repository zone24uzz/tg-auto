# Telegram AI Auto-Responder

An AI assistant for **your own Telegram account**, built on the official
**Telegram Business → Chatbots** feature (Bot API `business_*` updates). It reads the private
chats you share with it, understands text, photos, voice, audio, video, round video notes and
documents, answers routine questions in your style, hands personal questions to you, keeps
edit/delete history, and is fully controlled from an owner-only admin bot.

Two transports:

* **business** (default, official): Telegram Business → Chatbots (Bot API `business_*` updates). Needs Telegram
  Premium and Business Mode for the bot. No account session is ever stored.
* **userbot** (opt-in, `TELEGRAM_TRANSPORT=userbot`): your own account via MTProto with your app's
  `api_id`/`api_hash` (my.telegram.org). Works without Premium, sees all your private chats and knows who is in your
  contacts. You log in once with `/login` in the admin bot by scanning a QR code (Telegram → Settings → Devices →
  Link Desktop Device); a 2FA password, if any, is used once and never stored. The session is encrypted in the DB.
  **Risk:** automating a user account is tolerated but not endorsed by Telegram — keep reply rate limits on.

The bot (TELEGRAM_BOT_TOKEN) always serves the owner-only admin panel. No password storage, no scraping.

---

## 1. Architecture

```
Telegram ──business_* updates──► Update receiver (polling | webhook + secret)
                                   │  update-level idempotency (processed_updates)
                                   ▼
                             Message normalizer ──► PostgreSQL (encrypted content)
                                   │                    ▲
                                   ▼                    │
                         PostgreSQL job queue  ── text queue (fast) / media queue (heavy)
                                   │
                                   ▼
   Rules engine → rate & cost limits → Media processor (image/voice/video/video note/docs)
        → Personal-question classifier (heuristics + LLM) → AI router (primary → fallback)
        → Response policy (leak guard) → delay/typing → Telegram sender (exactly-once claim)
                                   │
                                   └──► Owner Attention queue ──► Admin bot notification

Admin bot (owner only) ──► guard ──► Settings / Rules / Prompts / History / Stats / Privacy
```

| Layer | Where |
|---|---|
| Entry points | `src/main.ts` (bot + HTTP + embedded worker), `src/worker.ts` (standalone worker) |
| Composition root | `src/app/container.ts`, jobs & scheduler in `src/app/jobs.ts` |
| Telegram main bot | `src/telegram/main/` (normalizer, business handlers, connection service, sender) |
| Admin bot | `src/telegram/admin/` (guard, menus, notifications) |
| Pipeline | `src/responder/pipeline.ts`, `reply-sender.ts`, `response-policy.ts`, `delay.ts`, `voice-synth.ts` |
| Rules | `src/rules/` (pure engine + DB service) |
| Classifier | `src/classifiers/` (multilingual heuristics + structured LLM triage) |
| AI | `src/ai/` (provider interface, Gemini/OpenAI/Anthropic/OpenAI-compatible, router, reasoning mapping, pricing) |
| Media | `src/media/` (downloader, ffmpeg, image/audio/video/documents, storage local/S3) |
| Data | `prisma/schema.prisma`, `src/messages/`, `src/conversations/`, `src/owner-attention/` |
| Ops | `src/queues/pg-queue.ts`, `src/workers/`, `src/retention/`, `src/statistics/`, `src/audit/`, `src/privacy/` |

Design decisions:

* **PostgreSQL job queue** (`FOR UPDATE SKIP LOCKED`) instead of Redis/BullMQ: durable, one less
  service, safe with several workers. Text and media run in separate queues with separate
  concurrency, so a long video never delays a text reply.
* **Exactly-once-or-never replies**: a unique `(source message, kind)` row is claimed before
  calling Telegram. Retries, webhook redeliveries and crashes can never produce a duplicate reply;
  an unknown outcome is marked `UNCERTAIN` instead of being resent.
* **Debounce + bursts**: messages sent in quick succession are answered once, together.
* **Per-chat lease**: only one worker answers a chat at a time.
* **Layered prompts**: immutable safety core → owner instructions (editable, versioned) →
  style/length → summary (labelled untrusted) → history → current user content.

## 2. Features

* Text, photos (vision), voice + audio (speech-to-text), videos and round video notes
  (audio transcript + sampled frames, never every frame), documents (PDF, DOCX, XLSX, CSV, TXT/MD/JSON),
  captions, replies, forwards (origin stored), stickers, combined text + media, multi-message bursts.
* Personal / sensitive question detection (`NORMAL, PERSONAL, SENSITIVE, REQUIRES_OWNER, BUSINESS, SPAM, UNKNOWN`)
  with a configurable threshold; uncertain → owner by default. Conversation context is considered.
* Owner Attention queue + admin notification with **💬 Reply / 🤖 Let AI reply / 🚫 Ignore / 👤 Always manual**.
  If you answer in Telegram yourself, the item closes automatically.
* Reply modes `ALL_ALLOWED, NEW_CHATS_ONLY, NON_CONTACTS_ONLY, ALLOWLIST_ONLY, CUSTOM`; per user/username/chat/tag
  rules `AUTO, MANUAL, IGNORE, VIP, BLOCK` (user id is the primary key).
* Edit tracking with full version history; deletion tracking for business chats; admin notifications.
* Providers: Gemini, OpenAI, Anthropic, any OpenAI-compatible endpoint; per-task models
  (reply, fallback, media, transcription, classifier, TTS); reasoning effort mapped per provider
  and omitted when unsupported; fallback chain + safe fallback message.
* Temporary provider quota/rate limits (HTTP 429) do not produce a fallback answer immediately: the
  message is retried every minute for up to 10 minutes, then the safe fallback + owner queue is used.
* Separate waiting texts: personal questions ("Bu shaxsiy savol ekan…") vs. questions that need the
  owner's decision such as exact prices or deadlines ("Bu savolga … o‘zi aniq javob beradi…").
* Voice replies (`text | voice | adaptive`) via Gemini or OpenAI TTS → OGG/Opus voice note.
* Rate limits (per user per minute, AI replies per user per hour, global AI requests per minute),
  daily AI cost cap, token & cost tracking per call.
* Retention cleanup (messages, media, AI logs, temp files), privacy overview, per-user data deletion,
  AES-256-GCM encryption of message content at rest, audit log of every admin change, sanitized logs.

## 3. Telegram / API limitations (read this)

1. **Telegram Premium is required** to connect a chatbot to your account (Telegram Business feature).
2. **Business Mode** must be enabled for the bot in @BotFather (Bot Settings → Business Mode).
   The bot then has to be added in Telegram → Settings → Telegram Business → Chatbots, where you
   choose which chats it can access and grant the **reply** permission.
3. Only **private chats** are delivered to business bots — no groups/channels.
4. A business bot can only reply in chats that were **active in the last 24 hours**.
5. The bot sees only messages that arrive **after** it was connected. Deleted-message notifications
   show the original text only if the system stored the message when it arrived; older messages are
   reported as "original not available". Nothing is recovered from other chats or devices.
6. Deletion events (`deleted_business_messages`) contain only ids — never the text — which is why
   messages are stored on arrival (encrypted, retention-limited).
7. The Bot API does **not** tell bots who is in your contact list. `NON_CONTACTS_ONLY` therefore treats
   users tagged `contact` as contacts; Telegram's own Chatbots recipient settings ("exclude contacts")
   are the precise way to do this.
8. Gemini free-tier keys have low per-minute quotas; bursts of messages (each message = classification +
   reply, plus vision/transcription for media) can hit HTTP 429. The system retries later and falls back
   safely, but a paid tier (or lower `WORKER_CONCURRENCY_*` / `GLOBAL_AI_REQUESTS_PER_MINUTE`) is
   recommended for busy accounts. In live tests on 2026-10-04 `gemini-3.5-transcribe` returned empty
   transcripts, so speech-to-text defaults to `gemini-3.8-flash` with the reply models as fallback.
9. The cloud Bot API downloads files up to **20 MB**. Larger media is answered gracefully (configurable).
   A self-hosted Bot API server (`TELEGRAM_API_ROOT`) raises the limit.
10. Typing indicators are shown as the account; replies may display a small "via bot"/bot label to you,
   depending on the Telegram client.
11. Interactive admin actions use inline keyboards; a manual reply is typed as the next message in the
    admin chat (Telegram bots cannot open a compose box in another chat).

## 4. Database (summary)

`admins`, `admin_states`, `telegram_connections`, `users`, `chats`, `messages`, `message_versions`,
`media`, `ai_responses`, `conversation_summaries`, `usage_stats`, `user_rules`, `settings`, `prompts`,
`owner_attention`, `audit_logs`, `system_events`, `processed_updates`, `jobs`.
Key constraints: `messages(chat_id, telegram_message_id)` unique (duplicate delivery),
`ai_responses(source_message_id, kind)` unique (no duplicate replies), `message_versions(message_id, version)`
unique, `jobs.dedupe_key` unique, `processed_updates(bot_kind, update_id)` primary key.
Message text, captions, versions, transcripts, media descriptions, summaries and AI reply texts are
encrypted with `DATA_ENCRYPTION_KEY` (`enc:v1:` prefix).

## 5. Setup

### Prerequisites
* Node.js ≥ 22.12, PostgreSQL ≥ 14 (or Docker), ffmpeg + ffprobe on PATH (voice/video).
* A bot from @BotFather with **Business Mode ON**, a Telegram Premium account, an AI API key.

### Configure
```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_USER_ID, GEMINI_API_KEY (or another provider),
# DATA_ENCRYPTION_KEY (node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
```
Don't know your user id? Send `/start` to the bot, then `npm run whoami`.

### Connect the bot to your account
Telegram → Settings → Telegram Business → Chatbots → pick the bot → choose chats → allow replies.
The admin bot confirms: "🟢 Telegram Business ulandi…". Only a connection made by
`ADMIN_TELEGRAM_USER_ID` is accepted; others are ignored and logged.

## 6. Local development

```bash
npm install
npm run db:local            # terminal 1: embedded PostgreSQL on :54329 (no Docker needed)
npx prisma migrate deploy   # terminal 2: create tables
npm run dev                 # bot (polling) + embedded worker, hot reload
```
Open the bot in Telegram and send `/start` (from the admin account) for the panel.

Quality gates:
```bash
npm run typecheck
npm run lint
npm test                      # unit + admin + media + AI + DB integration tests (local PostgreSQL via pg_ctl)
npx tsx scripts/ai-smoke.ts   # optional: live check of the Gemini key
npx tsx scripts/e2e-live.ts   # optional: full pipeline with REAL AI and a FAKE Telegram server
                              # (text, personal question, prompt injection, image, document, voice, video note)
```

Notes:
* A project `.env` **overrides** variables inherited from your shell (a global `TELEGRAM_BOT_TOKEN` of
  another bot must not hijack this project). Docker/production use real environment variables only.
* Local PostgreSQL uses the binaries of the `@embedded-postgres/*` dev dependency and is started with
  `pg_ctl`, which also works from a Windows administrator account.
* If port 8080 is taken on your machine, set `PORT` in `.env` (health endpoints: `/healthz`, `/readyz`).

## 7. Production deployment

### Docker Compose (VPS)
```bash
cp .env.example .env   # set NODE_ENV=production, POSTGRES_PASSWORD, DATA_ENCRYPTION_KEY, tokens …
docker compose up -d --build          # postgres → migrate (one-shot) → app
docker compose logs -f app
```
* Polling mode works out of the box. For webhooks put the app behind HTTPS (Caddy/Nginx/Cloudflare),
  set `TELEGRAM_UPDATE_MODE=webhook`, `TELEGRAM_WEBHOOK_URL=https://your.domain`, a random
  `TELEGRAM_WEBHOOK_SECRET`; the app registers `/telegram/main` itself.
* Heavy media in a separate container: set `WORKER_MODE=separate` and
  `docker compose --profile separate-worker up -d`.
* Health: `GET /healthz` (liveness), `GET /readyz` (database).
* Back up the `pgdata` volume **and** `DATA_ENCRYPTION_KEY` (without the key, stored content is unreadable).

### Render (free tier) — step by step
1. **Database (Neon, free, no expiry):** create a project at neon.tech (region: Europe/Frankfurt) and copy the
   **direct** connection string (host without `-pooler`, ends with `?sslmode=require`). Render's own free
   PostgreSQL is deleted after 30 days, so it is not used.
2. **Code on GitHub:** push this repository to a private GitHub repo.
3. **Secrets file:** `npx tsx scripts/make-render-env.ts "<neon connection string>"` writes `data/render.env`
   (git-ignored) with the secret variables copied from your `.env`.
4. **Render:** New → **Blueprint** → pick the repo (it reads `render.yaml`: Docker, free plan, Frankfurt,
   `/healthz`). Environment → **Add from .env** → paste `data/render.env` → deploy. Delete `data/render.env`.
   The container applies migrations on start; `TELEGRAM_WEBHOOK_URL` defaults to Render's public URL.
5. **Stop the local bot** before the Render instance starts — two running copies would both answer your
   contacts (and fight over the bot's webhook/polling).
6. **Log in:** open `https://<service>.onrender.com/healthz` (should say `ok`), then send `/login` to the bot
   in Telegram and scan the QR code (Settings → Devices → Link Desktop Device).
7. **Keep it awake:** at cron-job.org (free) create a job `GET https://<service>.onrender.com/healthz` every
   10 minutes. A sleeping free instance cannot hold the userbot connection. For no sleep at all use the
   Starter plan instead.
8. If MTProto cannot connect on the host, set `MTPROTO_PORT=80` (and/or `MTPROTO_OBFUSCATED=false`) in Render.

Free-tier limits: 512 MB RAM (fine for text, photos and voice; long videos are heavy), 750 instance hours
per month (one always-on service), logs in the Render dashboard.

### Platform-as-a-service
Any Node host with PostgreSQL works: build with `npm ci && npm run build`, run
`npx prisma migrate deploy` on release, start `node dist/main.js` (and optionally `node dist/worker.js`).
Install ffmpeg on the host for voice/video.

## 8. Security notes

* Admin bot: every message and callback re-checks `ADMIN_TELEGRAM_USER_ID` and private chat; others
  get nothing but "Bu shaxsiy bot.". Destructive actions require confirmation; all changes are audited.
* Webhooks: constant-time secret-token check, 1 MB body limit, no information in error responses.
* Prompt injection: user content never enters system instructions; immutable safety core; heuristic
  injection flag adds a guard; output policy blocks replies containing secrets, the admin id,
  system-prompt fragments or a per-process canary.
* Files: never executed; magic-byte MIME validation; zip-bomb and macro checks for DOCX/XLSX;
  random temp names (no user-controlled paths); ffmpeg spawned without a shell; temp files deleted.
* Secrets only in env; logger redaction + pattern scrubbing; `.env` is git-ignored.
* Data minimisation: raw media deleted after processing by default; retention cleanup daily.

## 9. Admin bot

`/start` or `/menu` (owner only): Auto Reply ON/OFF & pause, Reply Rules, Users, Allowlist, Blocklist,
Ignore List, AI Model, Reasoning Effort, System Prompt (versions/restore/reset), Response Style,
Response Length, Personal Questions, Image/Voice/Video/Video Note/File Analysis, Owner Attention,
Message History (filters + detail with versions), Edited/Deleted Messages, Statistics, Advanced
Settings, Logs, Privacy. Also `/status`, `/pause`, `/resume`, `/privacy`, `/cancel`, `/help`.
