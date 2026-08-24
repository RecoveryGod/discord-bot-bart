/**
 * In-memory per-thread conversation log.
 *
 * Without the Message Content privileged intent the bot cannot read message history
 * back from Discord, so it records its own exchanges here instead. This feeds:
 *   - conversational context for the AI (replaces fetchThreadHistory)
 *   - the "last customer question" used by /learn and /bad
 *   - the id of the last bot answer, so /bad can delete it
 *
 * State is lost on restart, same as every other in-memory service in this bot.
 */

const threads = new Map(); // threadId -> { turns: [{role, content}], lastAnswerId, updatedAt }

const MAX_TURNS = 10; // keep the last N turns per thread (user + assistant combined)
const MAX_THREADS = 500; // hard ceiling so a busy server can't grow this unbounded
const TTL_MS = 24 * 60 * 60 * 1000;

function touch(threadId) {
  let entry = threads.get(threadId);
  if (!entry) {
    // Evict the oldest thread if we're at capacity
    if (threads.size >= MAX_THREADS) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, e] of threads) {
        if (e.updatedAt < oldestAt) {
          oldestAt = e.updatedAt;
          oldestId = id;
        }
      }
      if (oldestId) threads.delete(oldestId);
    }
    entry = { turns: [], lastAnswerId: null, updatedAt: Date.now() };
    threads.set(threadId, entry);
  }
  entry.updatedAt = Date.now();
  return entry;
}

function push(threadId, role, content) {
  const text = String(content || "").trim();
  if (!text) return;
  const entry = touch(threadId);
  entry.turns.push({ role, content: text });
  if (entry.turns.length > MAX_TURNS) {
    entry.turns = entry.turns.slice(-MAX_TURNS);
  }
}

/** Record a question asked by the customer. */
export function recordUserMessage(threadId, content) {
  push(threadId, "user", content);
}

/**
 * Record an answer the bot sent. `messageId` lets /bad find and delete it later.
 */
export function recordBotAnswer(threadId, content, messageId = null) {
  push(threadId, "assistant", content);
  if (messageId) touch(threadId).lastAnswerId = messageId;
}

/**
 * Conversation history for the AI, excluding the turn currently being answered.
 * Returns [{ role, content }] in chronological order.
 */
export function getHistory(threadId) {
  const entry = threads.get(threadId);
  if (!entry) return [];
  return entry.turns.slice(0, -1).map((t) => ({ ...t }));
}

/** The most recent customer question in this thread, or null. */
export function getLastUserQuestion(threadId) {
  const entry = threads.get(threadId);
  if (!entry) return null;
  for (let i = entry.turns.length - 1; i >= 0; i--) {
    if (entry.turns[i].role === "user") return entry.turns[i].content;
  }
  return null;
}

/** Message id of the last answer the bot sent in this thread, or null. */
export function getLastAnswerId(threadId) {
  return threads.get(threadId)?.lastAnswerId ?? null;
}

/** Forget a thread entirely (called when a ticket is archived). */
export function clearThread(threadId) {
  threads.delete(threadId);
}

function cleanupExpired() {
  const now = Date.now();
  for (const [id, entry] of threads) {
    if (now - entry.updatedAt > TTL_MS) threads.delete(id);
  }
}

setInterval(cleanupExpired, 60 * 60 * 1000);
