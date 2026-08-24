# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the bot locally
node src/index.js

# Install dependencies
npm ci

# Run in Docker (production-equivalent)
docker-compose up --build

# Run with live reload during development (not in package.json — use node directly)
node --watch src/index.js
```

No test suite or linter is configured. There is no build step — this is plain ESM Node.js.

## Environment

Copy `.env.example` to `.env`. Required vars: `BOT_TOKEN`, `PAYMENT_CHANNEL_ID`, `AMAZON_ROLE_ID`, `TICKET_CHANNEL_ID`. Optional but needed for full functionality: `OPENAI_API_KEY` (AI replies), `STAFF_ROLE_ID` (staff detection), `CLIENT_ID` + `GUILD_ID` (slash command registration — **required**, the bot is driven entirely by slash commands). `TICKET_BOT_ID` is currently unused (see "No privileged intents").

## Architecture

Single-process Discord bot. All bot logic lives in `src/index.js` — it is the only event handler. Services are stateless utility modules imported by index.js.

### No privileged intents

The bot runs with `Guilds` + `GuildMessages` only — **no `MessageContent`, no `GuildMembers`**.
It therefore cannot read message text. Every piece of user input arrives through an
interaction (slash command or modal). Do not add content-reading logic to `messageCreate`;
it will silently receive empty strings.

Two functions are deliberately kept but dormant, so auto-triage can be restored if the
intents are ever approved: `extractTicketBotInquiry()` in `index.js` and
`fetchThreadHistory()` in `aiService.js`.

### Message flow for ticket threads

1. **Ticket opened** → `threadCreate` → inactivity tracking + welcome message with an
   "Ask a question" button
2. **Customer asks** → `/ask <question>`, or the button → modal → both call `runAISupport()`
3. **Customer types a plain message** → `messageCreate` → bot can't read it → posts a nudge
   pointing at the button (capped at one per 2 min by `messageDeduplication.js`)
4. **Customer submits payment** → `/payment <code>` → posts the code in the thread and
   notifies the payment channel with a *redacted* excerpt
5. **Staff replies** → `messageCreate` sees the author's role → auto-pauses the bot

### Conversation memory (`src/services/conversationLog.js`)

Because history can't be read back from Discord, the bot records its own exchanges in
memory per thread. This feeds AI context, and supplies the "last customer question" that
`/learn` and `/bad` operate on. Lost on restart, like all other state here.

### AI support pipeline (`src/services/aiService.js`)

`handleAISupport()` → `searchFAQ()` + `searchPrices()` in parallel → if no match at all, escalate immediately → otherwise call OpenAI (`gpt-4o`, temperature 0.1, max 1000 tokens) → if confidence < 0.6, retry once → if still < 0.6, escalate to human.

Confidence is self-reported by the model as JSON: `{"answer": "...", "confidence": 0.85}`.

### Knowledge base (`data/faq.json` + `src/services/knowledgeBase.js`)

FAQ is loaded lazily and cached in-memory (`faqData`). Matching is keyword-based: +2 per keyword hit, +1/+0.5 per query word matching question/answer. Top 5 entries by score are passed as context. `FAQ_MIN_SCORE = 2`.

**Staff learning:** when staff runs `/learn <answer>` in a ticket thread, the bot saves a new entry to `data/faq.json` via `appendLearnedEntry()` and resets the in-memory cache (`faqData = null`). The learned entry is immediately searchable.

### Product prices (`prices.py` + `src/services/priceService.js`)

Prices are parsed from `prices.py` — a Python dict with line format `"SKU": price,  # Product Name`. The price service word-matches product names against the user query. `/price` slash command uses this directly.

### Commands (all slash commands — the `!`-prefixed versions are gone)

Customer-facing:

| Command | Effect |
|---------|--------|
| `/ask <question>` | AI support answer (also reachable via the welcome button) |
| `/price <product>` | Price lookup |
| `/payment <code>` | Submit a gift card for manual verification |
| `/version` | Running bot version |

Staff only (checked at runtime against `STAFF_ROLE_ID`):

| Command | Effect |
|---------|--------|
| `/pause` | Bot silent for 5 min (auto-resumes) |
| `/mute` | Bot silent until `/resume` |
| `/resume` | Re-enables bot |
| `/learn <answer>` | Saves Q&A to knowledge base, sends answer to customer |
| `/bad <answer>` | Deletes the bot's last answer, saves the correction instead |
| `/rule`, `/rules`, `/rule-del <id>` | Behaviour rules — restricted to `TRAINING_CHANNEL_ID` |

`/learn` and `/bad` read the customer's last question from `conversationLog.js`, so the
customer must have asked via `/ask` or the button first.

When staff sends any message in a thread, bot auto-pauses for 5 minutes (`staffActivity.js`).

### Key design decisions

- **All state is in-memory** — paused threads, deduplication cache, inactivity tracking are lost on restart.
- **`data/faq.json` is the only persistent write target** — written by `!learn`, read on every restart.
- **Deduplication** (`src/services/messageDeduplication.js`) — prevents the bot from sending the same reply twice in quick succession to the same thread.
- **Rate limiter** (`src/services/rateLimiter.js`) — per-thread, prevents spam.
- **Gift card codes are redacted** before being sent to OpenAI (`src/utils/redact.js`).

## Deployment

Push to `main` → GitHub Actions SSH into the VPS → `git pull` → `docker-compose down && docker-compose up -d --build`. The Dockerfile copies `src/`, `data/`, and `prices.py`. To update product prices or FAQ, edit those files and push.

`data/faq.json` inside the container is writable (bot learns from staff at runtime), but it resets on each `docker-compose up --build` unless the file is volume-mounted or the learned entries are committed first.
