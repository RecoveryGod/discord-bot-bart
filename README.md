# Discord Bot Bart

Discord support bot (Node.js, discord.js v14) for the RecoveryGods server. Handles Amazon gift card detection, AI-powered ticket support (FAQ + OpenAI + price lookup), staff controls, and ticket lifecycle management.

---

## Table of contents

- [Features](#features)
- [Stack & structure](#stack--structure)
- [Configuration](#configuration)
- [Running the bot](#running-the-bot)
- [Message flow](#message-flow)
- [Guide for AI agents](#guide-for-ai-agents)

---

## Features

| Feature | Description |
|---------|-------------|
| **Gift Card Detection** | Detects Amazon gift card codes (regex) and keywords in ticket thread messages. Sends a redacted notification to the payment channel with staff mention, thread link, and author. Codes are never republished. |
| **Ticket Bot Inquiry Detection** | When tickets.bot posts a custom inquiry ("State your inquiry or issue") in a new thread, the bot extracts the user's message and immediately routes it through the AI support pipeline. |
| **AI Support** | Searches the local FAQ and product price list. If a match is found, calls OpenAI (gpt-4o-mini) with FAQ context, price context, and conversation history. Confidence ≥ 0.6 → auto-reply. Low confidence → retries once before escalating to staff. Rate limit: 5 AI responses per thread per hour. |
| **Conversation History** | The last 9 messages in a thread are sent to OpenAI as conversation history, giving the AI full context for follow-up questions. |
| **Price Lookup** | Searches `prices.py` for matching products and injects prices into the AI context so it can answer pricing questions directly. |
| **`/price` Slash Command** | Anyone (staff or users) can type `/price <product name>` to instantly look up prices. Returns up to 8 matching products with prices in euros. |
| **Staff Pause System** | A staff reply auto-pauses the bot for 5 minutes. Manual commands: `!pause` (5 min), `!mute` (indefinite), `!resume` (re-enable). Command messages are deleted after execution. |
| **Deduplication** | The bot never sends the same message twice in a row in the same thread (2-minute window). |
| **Inactivity Prompt** | If a ticket is opened and the creator sends no message within 1 minute, the bot asks them to describe their issue. Stops tracking if the creator, staff, or the ticket bot posts first. Skips archived or locked threads. |

---

## Stack & structure

- **Runtime**: Node.js v25
- **Library**: discord.js v14, ES Modules
- **Config**: dotenv (`.env`)
- **Deployment**: Docker + docker-compose (see `DEPLOY.md`)

```
discord-bot-bart/
├── src/
│   ├── index.js                   # Entry point: Discord client, events, orchestration, slash commands
│   ├── config.js                  # Env var loading and validation
│   ├── constants.js               # Gift card regex and keywords
│   ├── services/
│   │   ├── aiService.js           # OpenAI call, FAQ + price context, conversation history, retry logic
│   │   ├── detection.js           # Amazon gift card detection (regex + keywords)
│   │   ├── knowledgeBase.js       # FAQ loading, searchFAQ(), score threshold
│   │   ├── priceService.js        # prices.py parser, searchPrices(), price context formatter
│   │   ├── notification.js        # Payment notification message to staff channel
│   │   ├── rateLimiter.js         # 5 AI requests per thread per hour
│   │   ├── staffActivity.js       # Bot pause on staff reply, !pause / !mute / !resume
│   │   ├── messageDeduplication.js # Prevent identical consecutive bot replies
│   │   └── threadInactivity.js    # "Please describe your issue" prompt after 1 min
│   └── utils/
│       ├── logger.js              # Timestamped logs with [Bot] prefix
│       └── redact.js              # Replace all gift card codes with [REDACTED]
├── data/
│   └── faq.json                   # Knowledge base (question, answer, keywords)
├── prices.py                      # Product price list (SKU → price with product name comments)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── DEPLOY.md                      # VPS deployment guide
└── README.md
```

---

## Configuration

All variables are read from `.env` (copy from `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Discord bot token |
| `PAYMENT_CHANNEL_ID` | Yes | Channel for gift card payment notifications |
| `AMAZON_ROLE_ID` | Yes | Role to mention on gift card detection and AI escalation |
| `TICKET_CHANNEL_ID` | Yes | Channel whose threads are monitored as tickets |
| `OPENAI_API_KEY` | No | Enables AI support; without it only gift card detection and inactivity prompts run |
| `STAFF_ROLE_ID` | No | Staff role: auto-pause, `!pause` / `!mute` / `!resume`, excluded from AI replies |
| `TICKET_BOT_ID` | No | User ID of tickets.bot — enables auto-reply to custom ticket inquiries |
| `CLIENT_ID` | No | Bot application ID — required to register the `/price` slash command |
| `GUILD_ID` | No | Server ID — registers `/price` as a guild command (instant) instead of global (up to 1 hour) |

---

## Running the bot

```bash
npm install
cp .env.example .env   # fill in your values
npm start
```

With Docker:
```bash
docker compose up -d --build
```

See `DEPLOY.md` for full VPS deployment instructions.

---

## Message flow

Everything happens inside **threads** of the `TICKET_CHANNEL_ID` channel. Messages outside these threads are ignored.

### 1. Thread created (`threadCreate`)

- If `parentId === TICKET_CHANNEL_ID` and not archived → track thread for inactivity monitoring.

### 2. Ticket bot message (`messageCreate` — ticket bot only)

If `TICKET_BOT_ID` is set and the message is from the ticket bot:

- Logs full message details (content, embeds, thread info) for diagnostics.
- Extracts the user's inquiry from the `"State your inquiry or issue"` field (plain text or embed).
- If found → stops inactivity tracking, runs the full AI support pipeline.
- If not found (e.g. PayPal auto-message) → silently ignored.

### 3. User message (`messageCreate`)

- **Bots**: ignored (except ticket bot above).
- **Outside ticket threads**: ignored.
- **Inactivity tracker**: updated on every message — stops tracking if creator or staff replied.
- **Staff commands** (staff role only):
  - `!pause` / `!bot pause` → pause bot for 5 minutes.
  - `!mute` / `!bot mute` → pause bot indefinitely until `!resume`.
  - `!resume` / `!bot resume` → re-enable bot. Command message deleted after execution.
  - Any other staff message → auto-pause for 5 minutes, stop processing.
- **Paused thread**: bot skips silently.
- **Empty content**: ignored.

Then for non-staff user messages with content:

1. **Priority 1 — Gift Card**
   If `hasAmazonGiftCard(content)`:
   - Redact all codes.
   - Send payment notification (thread link, author, redacted excerpt, role mention).
   - Stop.

2. **Priority 2 — AI Support** (requires `OPENAI_API_KEY`)
   - Rate limit: max 5 AI calls per thread per hour.
   - Search FAQ + price list simultaneously.
   - If neither FAQ nor prices match → escalate directly (no OpenAI call).
   - Otherwise → call `handleAISupport()`:
     - Fetches last 9 thread messages as conversation history.
     - Calls OpenAI with FAQ context, price context, and history.
     - If `confidence < 0.6` → retry once with a stronger prompt.
     - If `confidence >= 0.6` → send answer (deduplicated).
     - If still `confidence < 0.6` → escalate to staff with role mention (deduplicated).

### 4. Slash command (`interactionCreate`)

- `/price <product>` → searches `prices.py` by keyword, returns up to 8 matching products with prices in euros. Available to everyone.

### 5. Periodic task (on `ready`)

- Every 15 seconds: check for threads created more than 1 minute ago where the creator hasn't replied and the bot hasn't asked yet.
- Skip archived or locked threads (cleans them from tracking).
- Send `"Could you please specify why you opened this ticket?"` with user mention.

---

## Guide for AI agents

### File map by responsibility

| Need | File(s) |
|------|---------|
| Global behavior, event order, slash commands | `src/index.js` |
| Env vars, validation | `src/config.js` |
| Gift card detection | `src/services/detection.js`, `src/constants.js` |
| Payment notification message | `src/services/notification.js` |
| Code redaction (security) | `src/utils/redact.js`, `src/constants.js` |
| AI prompt, model, confidence, retry, history | `src/services/aiService.js` |
| FAQ search, score, escalation threshold | `src/services/knowledgeBase.js` |
| FAQ data | `data/faq.json` |
| Price lookup, parser | `src/services/priceService.js` |
| Price data | `prices.py` |
| Rate limit (5/thread/hour) | `src/services/rateLimiter.js` |
| Staff pause, !pause / !mute / !resume | `src/services/staffActivity.js` |
| Duplicate reply prevention | `src/services/messageDeduplication.js` |
| Inactivity prompt | `src/services/threadInactivity.js` |
| Logs | `src/utils/logger.js` |

### Key rules

- **Security**: never log or resend a gift card code in plain text. Always pass text through `redactGiftCardCodes()` before logging, sending to Discord, or sending to OpenAI.
- **Core flow**: gift card detection and payment notification are the critical business logic — do not modify `detection.js` or `notification.js` without explicit intent.
- **Threads only**: the bot only reacts to messages in a thread whose parent is `TICKET_CHANNEL_ID`.
- **Price gate**: the FAQ early-escape is bypassed if prices match — both must fail to skip the OpenAI call.

### Common change points

- **Inactivity prompt message**: `src/index.js` → `INACTIVITY_PROMPT_MESSAGE`
- **Inactivity delay (1 min)**: `src/services/threadInactivity.js` → `INACTIVITY_THRESHOLD`
- **Staff pause duration (5 min)**: `src/services/staffActivity.js` → `PAUSE_DURATION`
- **AI confidence threshold**: `src/index.js` → `confidence >= 0.6`
- **FAQ minimum score**: `src/services/knowledgeBase.js` → `FAQ_MIN_SCORE`
- **OpenAI model or prompt**: `src/services/aiService.js` → `MODEL`, `SYSTEM_PROMPT`
- **Max AI response tokens**: `src/services/aiService.js` → `MAX_TOKENS`
- **Max conversation history messages**: `src/services/aiService.js` → `HISTORY_LIMIT`
- **Max price results returned**: `src/services/priceService.js` → `.slice(0, 8)`

### Discord intents used

- `Guilds`
- `GuildMessages`
- `MessageContent`

---

## License / usage

Private project. See repository for details.
