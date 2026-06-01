import { BATCH_WAIT_MS, BATCH_MAX_WAIT_MS } from "../config.js";
import * as logger from "../utils/logger.js";

/**
 * Per-thread+user debounced batching for rapid-fire user messages.
 *
 * When a user sends multiple short messages in quick succession ("hey", "i bought stand",
 * "and the key isnt working"), this batcher waits BATCH_WAIT_MS (default 3s) for the
 * user to stop typing, then combines their messages into one prompt for the AI.
 *
 * Keyed by `${threadId}:${userId}` so different users in the same thread are isolated.
 * A maxWaitTimer (BATCH_MAX_WAIT_MS, default 15s) prevents indefinite delay if the user
 * keeps typing without pause.
 *
 * Exports:
 *   enqueueMessage(message, processFn) — queue a user message; processFn(combined, lastMessage) fires when timer expires
 *   flushBatch(threadId, userId)       — drop a pending batch for a specific user (no processing)
 *   flushThreadBatches(threadId)       — drop ALL pending batches in a thread (used when staff takes over)
 */

const batches = new Map();

function keyFor(threadId, userId) {
  return `${threadId}:${userId}`;
}

function clearTimers(entry) {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
}

function fire(key) {
  const entry = batches.get(key);
  if (!entry) return;
  clearTimers(entry);
  batches.delete(key);

  const combined = entry.messages.join("\n").trim();
  if (!combined) return;

  logger.info("[batcher] Firing batch — key:", key, "| messages:", entry.messages.length, "| chars:", combined.length);

  // Call the processor outside the map mutation. Caller handles its own errors.
  Promise.resolve()
    .then(() => entry.processFn(combined, entry.lastMessage))
    .catch((err) => {
      logger.error("[batcher] processFn threw:", err?.message);
    });
}

/**
 * Enqueue a user message for debounced processing.
 *
 * @param {import("discord.js").Message} message
 * @param {(content: string, lastMessage: import("discord.js").Message) => Promise<void>} processFn
 */
export function enqueueMessage(message, processFn) {
  const threadId = message.channel.id;
  const userId = message.author.id;
  const key = keyFor(threadId, userId);
  const content = (message.content || "").trim();
  if (!content) return;

  const existing = batches.get(key);
  if (existing) {
    // Append to existing batch and reset only the debounce timer (NOT the maxWait timer)
    existing.messages.push(content);
    existing.lastMessage = message;
    clearTimeout(existing.debounceTimer);
    existing.debounceTimer = setTimeout(() => fire(key), BATCH_WAIT_MS);
    logger.info("[batcher] Appended to batch — key:", key, "| total messages:", existing.messages.length);
    return;
  }

  // New batch — start both timers
  const entry = {
    messages: [content],
    lastMessage: message,
    processFn,
    startedAt: Date.now(),
    debounceTimer: setTimeout(() => fire(key), BATCH_WAIT_MS),
    maxWaitTimer: setTimeout(() => {
      logger.info("[batcher] Max wait reached — key:", key);
      fire(key);
    }, BATCH_MAX_WAIT_MS),
  };
  batches.set(key, entry);
  logger.info("[batcher] New batch started — key:", key);
}

/**
 * Cancel and drop a pending batch for a specific user in a thread.
 * Used when a gift card is detected (payment notification IS the response).
 */
export function flushBatch(threadId, userId) {
  const key = keyFor(threadId, userId);
  const entry = batches.get(key);
  if (!entry) return false;
  clearTimers(entry);
  batches.delete(key);
  logger.info("[batcher] Batch dropped — key:", key);
  return true;
}

/**
 * Cancel and drop ALL pending batches in a thread.
 * Used when staff replies or thread is paused.
 */
export function flushThreadBatches(threadId) {
  let dropped = 0;
  for (const [key, entry] of batches.entries()) {
    if (key.startsWith(`${threadId}:`)) {
      clearTimers(entry);
      batches.delete(key);
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.info("[batcher] Dropped all batches in thread:", threadId, "| count:", dropped);
  }
  return dropped;
}
