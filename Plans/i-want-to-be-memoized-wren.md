# Teach-the-Bot: Cleaner Corrections, Staff Rules, Docs/RAG, and Message Batching

## Context

The bot currently learns only through rigid commands:

- `!learn <answer>` — saves the previous user message as the FAQ question.
- `!bad <answer>` — replies to a bad bot message, grabs the user question from ~50 messages back.

Four real problems emerged:

1. **`!bad` pollutes the FAQ.** The raw user message — mentions (`<@123>`), emoji, multi-topic rambling — is stored verbatim as the "question". Keyword extraction then pulls garbage words, and future retrieval suffers.
2. **No way to tell the bot *how* to behave.** Staff can teach exact Q&A pairs but cannot express guidance like "never suggest refunds without staff approval" or "always answer Spanish users in Spanish". These belong in the system prompt, not the FAQ.
3. **Keyword-only retrieval is brittle.** The knowledge base ignores anything not hitting a keyword. Longer-form content (product guides, policies, activation walkthroughs) doesn't fit the Q&A shape and would be better served by documentation + semantic search.
4. **Bot replies to every fragment of a multi-message question.** Users often send a thought across 3–5 short messages in rapid succession. The bot currently replies to each fragment in isolation, producing redundant or confused answers. It should wait briefly, batch consecutive messages from the same user, and reply once to the combined intent.

**Desired outcome:** four surgical additions that fix `!bad`, let staff shape behavior in natural language, add a documentation/RAG layer *alongside* the FAQ, and batch rapid-fire user messages — without restructuring existing code.

---

## Approach

Four independent features, landed in order. Each can ship and be verified before the next.

### Feature 1 — LLM-extract the core question in `!bad`

When staff replies `!bad <answer>` to a bad bot reply:

1. Scan back for the user's triggering message (existing behavior).
2. Strip Discord mention tokens (`<@\d+>`, `<@!\d+>`, `<#\d+>`, `<@&\d+>`) with a regex.
3. Redact gift card codes.
4. Call `gpt-4o-mini` with a short prompt: "Extract the core support question from this raw Discord message. Reword/trim only — never invent. Return JSON `{\"question\": \"...\"}`. Empty string if no clear question."
5. Use the cleaned question as the FAQ entry's `question` and as the source text for keyword extraction.
6. **Fallback:** on any failure (API down, JSON parse fail, empty result), keep current raw-message behavior so `!bad` never blocks.

Model: `gpt-4o-mini`, `temperature: 0`, `max_tokens: 80`, `response_format: { type: "json_object" }`.

### Feature 2 — `!rule` command for behavior rules

Staff-defined rules live in `data/rules.json` and get injected into the system prompt on every AI call.

**Commands (staff-only, restricted to `TRAINING_CHANNEL_ID`):**

| Command | Effect |
|---|---|
| `!rule <instruction>` | Append rule; reply with `✅ Rule #N saved`. |
| `!rules` | List all rules with IDs, ephemeral (delete after 30s). |
| `!rule-del <id>` | Remove rule by ID. |

**Rule storage:**
```json
[
  { "id": 1, "rule": "Never suggest refunds without staff approval.", "createdBy": "123456789", "createdAt": "2026-04-23T..." }
]
```

**System-prompt injection** (inside `generateAIResponse`, not on the module-level const):

```
[existing SYSTEM_PROMPT verbatim]
-----------------------------------------
STAFF-DEFINED RULES (override defaults)
-----------------------------------------
1. Never suggest refunds without staff approval.
2. Always answer Spanish users in Spanish.
...

REMINDER: Respond with ONLY the JSON object {"answer": "...", "confidence": 0.0}. No markdown, no prose outside JSON.
```

The final JSON-format reminder is re-stated *after* the rules so staff rules cannot override the JSON response contract.

Cache pattern mirrors `knowledgeBase.js`: `let rulesData = null`, reset to `null` on every write. Cap at 50 rules / 4000 chars; truncate oldest with a log line if exceeded.

### Feature 3 — Documentation/RAG alongside FAQ

Add `data/docs/*.md` for product guides, policies, activation walkthroughs, etc. FAQ remains authoritative for sharp Q&A; docs provide fuzzy semantic coverage.

**Pipeline:**

1. On first use (or on boot if `DOCS_EMBED_ON_BOOT=true`), `ensureDocsIndex()` walks `data/docs/`, chunks each file (~500 chars with 50-char overlap, split on paragraph boundaries when possible), hashes each chunk with SHA-256, and embeds *only new/changed* chunks using `text-embedding-3-small`. Cache persists to `data/embeddings.json`.
2. On each user message, `handleAISupport()` runs `searchDocs(userMessage)` in parallel with `searchFAQ` and `searchPrices`. Embeds the query, scores cosine similarity against cached chunks, returns top 3 above `minScore = 0.35`.
3. Doc chunks pass to OpenAI as a clearly-labeled section in the user message:
   ```
   Knowledge Base (authoritative):
   [FAQ entries]
   [price list]

   Documentation (supporting context, lower priority than FAQ):
   [top 3 doc chunks]

   Customer Question: ...
   ```

**Failure isolation:** `searchDocs` catches every error and returns `[]`. If embeddings API is down, the FAQ path continues working unchanged.

### Feature 4 — Message batching (debounce rapid-fire user messages)

Users frequently send one thought across multiple short messages:

> "hey"
> "i bought stand yesterday"
> "and the key isnt working"
> "can u help?"

Currently the bot answers each fragment in isolation. Instead: wait briefly, batch consecutive messages from the same user in the same thread, then process them as one combined message.

**Mechanism:**

1. New module `src/services/messageBatcher.js` maintains an in-memory `Map<string, BatchEntry>` keyed by `${threadId}:${userId}`. Entry shape:
   ```js
   { messages: string[], lastMessage: Message, debounceTimer, maxWaitTimer, startedAt: number }
   ```
2. New user message hits the AI Support path → call `enqueueMessage(message, processFn)`:
   - If a batch exists for `${threadId}:${userId}`: append `message.content` to `messages`, update `lastMessage`, reset `debounceTimer`.
   - Otherwise: create a new entry with `messages: [content]`, `startedAt: Date.now()`, schedule `debounceTimer` to fire after `BATCH_WAIT_MS` (default 3000ms), and schedule `maxWaitTimer` for `BATCH_MAX_WAIT_MS` (default 15000ms) as a hard ceiling.
3. When either timer fires: clear both timers, delete the map entry, join `messages` with `\n`, and call `processFn(combinedContent, lastMessage)`. `processFn` is the existing AI Support logic (rate limit → redact → `handleAISupport` → reply via `lastMessage.reply(...)`).
4. `flushBatch(threadId, userId)` — exported helper used to cancel/drop a pending batch (e.g., when staff replies, when thread is paused, or when an Amazon gift card arrives).

**Integration in `src/index.js`:**

- The current AI Support block at [src/index.js:575-643](src/index.js) is wrapped in a function `processAISupport(content, message)` (same body, no behavior change).
- Replace the inline call with `enqueueMessage(message, processAISupport)`. The handler returns immediately; the batcher fires the work later.
- **Amazon gift card path stays immediate** (security-sensitive). Before the gift card block returns, call `flushBatch(threadId, message.author.id)` to drop any pending text batch — the payment notification IS the response.
- **Staff replies** already `return` at line 532 — also call `flushBatch` for the *user's* pending batch (if any) since staff is taking over.
- **Thread pause** check (line 535): if paused, call `flushBatch` and return.

**Visual feedback (optional, nice-to-have):**

While a batch is pending, call `message.channel.sendTyping()` once per message arrival. Discord shows the typing indicator for ~10 seconds — natural cue that the bot is "thinking" rather than ignoring.

**Failure isolation:** if the batcher itself throws (e.g., timer cleanup error), log and fall through to the original inline path so messages still get answered.

---

## Files

### New

| Path | Purpose |
|---|---|
| `src/services/questionExtractor.js` | Exports `extractCoreQuestion(rawText)` — LLM extractor for `!bad`. Uses the same `fetch` pattern as `aiService.js`. |
| `src/services/rulesService.js` | Exports `loadRules()`, `appendRule(rule, createdBy)`, `deleteRule(id)`, `listRules()`, `formatRulesForPrompt()`. Mirrors `knowledgeBase.js` cache pattern. |
| `src/services/docsService.js` | Exports `ensureDocsIndex()`, `searchDocs(query, topK=3, minScore=0.35)`, `formatDocsContext(chunks)`. Chunking, hashing, embedding, cosine similarity, atomic cache writes. |
| `src/services/messageBatcher.js` | Exports `enqueueMessage(message, processFn)`, `flushBatch(threadId, userId)`. Per-user/thread debounced batching with hard ceiling. |
| `data/rules.json` | Initial `[]`. |
| `data/embeddings.json` | Initial `{}`; generated on first index. |
| `data/docs/README.md` | Placeholder seed markdown so the docs folder has a file. |

### Modified

**[src/config.js:26](src/config.js)** — add
```js
export const TRAINING_CHANNEL_ID = process.env.TRAINING_CHANNEL_ID?.trim() ?? "";
export const DOCS_EMBED_ON_BOOT = process.env.DOCS_EMBED_ON_BOOT === "true";
export const BATCH_WAIT_MS = parseInt(process.env.BATCH_WAIT_MS ?? "3000", 10);
export const BATCH_MAX_WAIT_MS = parseInt(process.env.BATCH_MAX_WAIT_MS ?? "15000", 10);
```

**[src/services/aiService.js:2](src/services/aiService.js)** — add imports for `formatRulesForPrompt`, `searchDocs`, `formatDocsContext`.

**[src/services/aiService.js:164-188](src/services/aiService.js)** — inside `generateAIResponse`:
- Build `systemContent` dynamically: `SYSTEM_PROMPT + (rulesBlock ? ... : "") + JSON_REMINDER`. Do NOT mutate the const.
- Accept a new `docsContext` parameter (default `null`); add a `docsSection` to the user-message content after `priceSection`.

**[src/services/aiService.js:267-308](src/services/aiService.js)** — inside `handleAISupport`:
- Add `searchDocs(safeMessage)` to the `Promise.all` alongside existing parallel calls.
- Thread `formatDocsContext(docs)` through to `generateAIResponse`.

**[src/index.js:398-488](src/index.js)** — in `!bad` handler, between fetching `userQuestion` (~line 447) and computing keywords (~line 450):
```js
let cleanedQuestion = userQuestion;
if (userQuestion) {
  const extracted = await extractCoreQuestion(userQuestion);
  if (extracted) cleanedQuestion = extracted;
}
```
Use `cleanedQuestion` as the `sourceText` for keyword extraction and as `questionForFAQ` passed to `appendLearnedEntry`. Leave the no-question fallback branch untouched.

**[src/index.js:~489](src/index.js)** — after the `!bad` block, add staff-command handlers gated on `message.channel.id === TRAINING_CHANNEL_ID && isStaff`: `!rule <text>`, `!rules`, `!rule-del <id>`. Match existing `!learn`/`!bad` ergonomics (auto-delete invoking message, ephemeral confirmations).

**[src/index.js](src/index.js) `Ready` handler** — if `DOCS_EMBED_ON_BOOT`, call `ensureDocsIndex()` with try/catch; log success/failure.

**[src/index.js:575-643](src/index.js) AI Support block** — extract the body into a local `async function processAISupport(content, message) { ... }` (no behavior change inside). Replace the inline call site with `enqueueMessage(message, processAISupport)` so the handler returns immediately and the batcher fires the work later.

**[src/index.js:532](src/index.js) staff-reply early-return** — before returning, call `flushBatch(threadId, /* userId of the original user whose batch may be pending */)`. The simplest version flushes ALL pending batches in the thread on staff activity since staff is taking over the conversation.

**[src/index.js:535-537](src/index.js) paused-thread early-return** — call `flushBatch` for the message author before returning.

**[src/index.js:541-573](src/index.js) Amazon gift card block** — before sending the payment notification (or right after, before `return`), call `flushBatch(threadId, message.author.id)` so any pending text batch is dropped.

### Reused (do NOT modify)

- `appendLearnedEntry(question, answer, keywords)` from [src/services/knowledgeBase.js:95](src/services/knowledgeBase.js) — called as-is with cleaned question.
- `redactGiftCardCodes()` from [src/utils/redact.js](src/utils/redact.js) — applied before every OpenAI call.
- `fetch` pattern from [src/services/aiService.js:197-213](src/services/aiService.js) — mirror, don't introduce the `openai` package.

---

## Env Vars

Add to `.env.example`:

```
# Optional: channel where staff can use !rule commands
TRAINING_CHANNEL_ID=

# Optional: embed docs on bot startup (default: false, lazy on first query)
DOCS_EMBED_ON_BOOT=false

# Optional: batching debounce window before bot replies (ms, default 3000)
BATCH_WAIT_MS=3000

# Optional: hard ceiling on batch wait time (ms, default 15000)
BATCH_MAX_WAIT_MS=15000
```

None added to `REQUIRED` in `src/config.js` — bot still boots without any of them.

## Dependencies

**None.** Use Node built-ins (`fs`, `path`, `crypto`, `url`) + existing `fetch`. No new npm packages.

---

## Failure Modes & Fallbacks

| Scenario | Behavior |
|---|---|
| `!bad` extractor: OpenAI down / timeout | `extractCoreQuestion` returns `null`; raw-message path used (current behavior). |
| `!bad` extractor: empty or invalid JSON | Treat as failure; raw-message path used. |
| `rules.json` missing/corrupt | `loadRules()` returns `[]`; `formatRulesForPrompt()` returns `""`; prompt unchanged. Log once. |
| Too many rules / prompt too long | Cap at 50 rules / 4000 chars; oldest truncated with log line. |
| Docs embedding API down (indexing) | `ensureDocsIndex` logs and returns; `searchDocs` returns `[]`; FAQ path unaffected. |
| Docs embedding API down (query) | `searchDocs` catches, returns `[]`; FAQ answers alone. |
| Markdown file deleted | Stale hashes pruned on next `ensureDocsIndex()` run. |
| Concurrent JSON writes | Single-process bot + `renameSync` atomic writes. No locking needed. |
| Bot restarts with pending batches | In-memory only — batches are lost. Acceptable: users will simply not get a reply to that fragment; the next message starts a fresh batch. |
| Batcher itself throws | Try/catch around `enqueueMessage`; on error fall back to the inline AI path so the message still gets answered. |
| User sends 20+ messages rapidly | `BATCH_MAX_WAIT_MS` (15s) forces processing regardless of debounce resets — bot never goes silent forever. |
| Staff takes over mid-batch | `flushBatch` cancels the pending timer; user does not get a stale bot reply after staff has already replied. |

---

## Order of Implementation

1. **Feature 1 (`!bad` extractor)** — isolated, smallest blast radius. Ship + verify.
2. **Feature 4 (message batching)** — high user-visible value, isolated from prompt changes. Ship + verify reply quality on rapid-fire messages.
3. **Feature 2 (`!rule`)** — touches the system prompt (load-bearing). Ship + verify rules change answers.
4. **Feature 3 (Docs/RAG)** — largest. Batches with Feature 2's prompt edits. Lands last.

---

## Verification

Manual testing in Discord (no test suite exists).

### Feature 1 — `!bad` extractor

1. In a test ticket thread, as a user: send a polluted message like `"hey <@999999> um so like my key thing uhh Stand activation wont work???"`.
2. Wait for bot's (bad) reply.
3. As staff, reply to bot with `!bad The correct activation steps are X, Y, Z.`
4. Open `data/faq.json` — new entry's `question` should be a clean sentence (e.g., `"Why is Stand activation not working?"`) with **no** `<@...>` tokens and no filler. `keywords` should be derived from the cleaned question.
5. Temporarily unset `OPENAI_API_KEY`; repeat — entry still saves with the raw-message question (confirms fallback).

### Feature 2 — `!rule`

1. Set `TRAINING_CHANNEL_ID` to a staff-only channel.
2. In that channel, as staff: `!rule When a user writes in Spanish, always reply in Spanish.` → `✅ Rule #1 saved`.
3. `!rules` → numbered list with IDs.
4. In a real ticket thread, as a user, ask in Spanish → bot replies in Spanish.
5. `!rule-del 1` → rule removed, next AI call no longer has it (check logs).
6. `!rule` from a non-training channel OR as non-staff → ignored.
7. Confirm the bot still returns valid JSON (grep logs for parse failures).

### Feature 3 — Docs/RAG

1. Create `data/docs/activation.md` with a paragraph covering something NOT in FAQ (e.g., "HWID reset takes up to 24 hours").
2. Start the bot. Confirm `data/embeddings.json` populated with chunks.
3. As a user: `"how long does hwid reset take?"` → bot answers from the doc.
4. Edit the paragraph slightly, restart → only the changed chunk re-embedded (compare hash keys before/after).
5. Delete the doc file, restart → stale hashes pruned from `embeddings.json`.
6. Ask a FAQ-covered question → FAQ still wins (answer cites FAQ content).
7. Break `OPENAI_API_KEY` → bot still boots, `searchDocs` returns `[]`, FAQ path keeps working.

### Feature 4 — Message batching

1. In a test ticket thread, as a user, send four messages in quick succession (<3s apart):
   - `"hey"`
   - `"i bought stand yesterday"`
   - `"and the key isnt working"`
   - `"can u help?"`
2. Confirm bot replies **once**, ~3 seconds after the last message, addressing the combined intent (activation help for Stand).
3. Send a single isolated message and wait 5s → bot replies once after the 3s debounce window.
4. Send 20+ rapid messages without pause → bot should fire at the `BATCH_MAX_WAIT_MS` ceiling (~15s), never go silent forever.
5. Mid-batch, have staff reply in the thread → confirm bot does NOT also reply after the debounce (batch flushed).
6. Mid-batch, have user send an Amazon gift card code → confirm payment notification fires immediately AND no separate AI reply follows.
7. Mid-batch, `!pause` from staff → confirm batch is dropped, no reply when timer would have fired.
8. Two different users post simultaneously in the same thread → confirm batches are independent (each user gets their own debounced reply).

---

## Out of Scope

- Changing how `!learn` works (it already extracts the previous user message cleanly in-thread).
- Replacing the FAQ with docs-only (explicitly rejected — keep both).
- Conversational @bot mentions in tickets (rejected — `!rule` command only, in a dedicated channel).
- Adding a test suite or linter.
- Volume-mounting `data/faq.json` in Docker (pre-existing concern, separate cleanup).
