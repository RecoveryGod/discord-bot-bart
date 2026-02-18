/**
 * Service to prevent duplicate bot replies in threads.
 * Tracks recent bot messages per thread and prevents identical consecutive replies.
 */

const recentBotMessages = new Map(); // threadId -> { lastMessage: string, timestamp: number }
const DEDUPLICATION_WINDOW = 2 * 60 * 1000; // 2 minutes window

/**
 * Normalizes message content for comparison (removes mentions, extra spaces, etc.)
 */
function normalizeMessage(content) {
  if (!content || typeof content !== "string") return "";
  return content
    .replace(/<@&\d+>/g, "") // Remove role mentions
    .replace(/<@\d+>/g, "") // Remove user mentions
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Checks if the bot should skip replying to avoid duplicate.
 * Returns true if the last bot message in this thread is identical.
 */
export async function shouldSkipDuplicateReply(channel, newMessageContent) {
  if (!channel || !newMessageContent) return false;

  const threadId = channel.id;
  const normalizedNew = normalizeMessage(newMessageContent);

  // Check cached recent message
  const cached = recentBotMessages.get(threadId);
  if (cached) {
    const timeSinceLastMessage = Date.now() - cached.timestamp;
    
    // If within deduplication window and content matches, skip
    if (timeSinceLastMessage < DEDUPLICATION_WINDOW && cached.lastMessage === normalizedNew) {
      return true;
    }
  }

  // Fetch recent messages from Discord to verify
  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessages = Array.from(messages.values()).filter(
      (m) => m.author.id === channel.client.user.id
    );

    if (botMessages.length > 0) {
      const lastBotMessage = botMessages[0];
      const normalizedLast = normalizeMessage(lastBotMessage.content);

      // Update cache
      recentBotMessages.set(threadId, {
        lastMessage: normalizedLast,
        timestamp: Date.now(),
      });

      // Check if identical
      if (normalizedLast === normalizedNew) {
        return true; // Skip duplicate
      }
    }
  } catch (err) {
    // If fetch fails, allow reply (fail-safe)
    console.error("Failed to check duplicate messages:", err?.message);
  }

  // Update cache with new message (will be sent)
  recentBotMessages.set(threadId, {
    lastMessage: normalizedNew,
    timestamp: Date.now(),
  });

  return false; // Allow reply
}

/**
 * Records a bot message that was sent (for tracking).
 */
export function recordBotMessage(threadId, messageContent) {
  if (!threadId || !messageContent) return;
  const normalized = normalizeMessage(messageContent);
  recentBotMessages.set(threadId, {
    lastMessage: normalized,
    timestamp: Date.now(),
  });
}

/**
 * Cleans up old entries to prevent memory leaks.
 */
export function cleanupExpired() {
  const now = Date.now();
  for (const [threadId, data] of recentBotMessages.entries()) {
    if (now - data.timestamp > DEDUPLICATION_WINDOW * 2) {
      recentBotMessages.delete(threadId);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupExpired, 5 * 60 * 1000);
