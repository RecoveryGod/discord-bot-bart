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

Copy `.env.example` to `.env`. Required vars: `BOT_TOKEN`, `PAYMENT_CHANNEL_ID`, `AMAZON_ROLE_ID`, `TICKET_CHANNEL_ID`. Optional but needed for full functionality: `OPENAI_API_KEY` (AI replies), `STAFF_ROLE_ID` (staff detection), `TICKET_BOT_ID` (auto-reply to ticket inquiries), `CLIENT_ID` + `GUILD_ID` (slash command registration).

## Architecture

Single-process Discord bot. All bot logic lives in `src/index.js` — it is the only event handler. Services are stateless utility modules imported by index.js.

### Message flow for ticket threads

1. **Ticket opened** → `threadCreate` → starts inactivity tracking
2. **Ticket bot message** → `messageCreate` → `extractTicketBotInquiry()` pulls user's question from embed → AI support path
3. **User message in ticket** → `messageCreate`:
   - Amazon gift card detected → notify payment channel → stop
   - Otherwise → `handleAISupport()` → reply or escalate

### AI support pipeline (`src/services/aiService.js`)

`handleAISupport()` → `searchFAQ()` + `searchPrices()` in parallel → if no match at all, escalate immediately → otherwise call OpenAI (`gpt-4o`, temperature 0.1, max 1000 tokens) → if confidence < 0.6, retry once → if still < 0.6, escalate to human.

Confidence is self-reported by the model as JSON: `{"answer": "...", "confidence": 0.85}`.

### Knowledge base (`data/faq.json` + `src/services/knowledgeBase.js`)

FAQ is loaded lazily and cached in-memory (`faqData`). Matching is keyword-based: +2 per keyword hit, +1/+0.5 per query word matching question/answer. Top 5 entries by score are passed as context. `FAQ_MIN_SCORE = 2`.

**Staff learning:** when staff types `!learn <answer>` in a ticket thread, the bot saves a new entry to `data/faq.json` via `appendLearnedEntry()` and resets the in-memory cache (`faqData = null`). The learned entry is immediately searchable.

### Product prices (`prices.py` + `src/services/priceService.js`)

Prices are parsed from `prices.py` — a Python dict with line format `"SKU": price,  # Product Name`. The price service word-matches product names against the user query. `/price` slash command uses this directly.

### Staff controls (in-thread commands, staff role only)

| Command | Effect |
|---------|--------|
| `!pause` | Bot silent for 5 min (auto-resumes) |
| `!mute` | Bot silent until `!resume` |
| `!resume` | Re-enables bot |
| `!learn <answer>` | Saves Q&A to knowledge base, sends answer to customer |

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
