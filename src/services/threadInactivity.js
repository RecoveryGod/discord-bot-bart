/**
 * Tracks new ticket threads and prompts the creator to specify their request
 * if they haven't sent a message within 1 minute.
 */

const trackedThreads = new Map(); // threadId -> { createdAt, ownerId, asked }
const INACTIVITY_THRESHOLD = 60 * 1000; // 1 minute

/**
 * Start tracking a thread when it is created.
 * @param {string} threadId
 * @param {string} ownerId - User ID of the thread creator
 */
export function trackThread(threadId, ownerId) {
  trackedThreads.set(threadId, {
    createdAt: Date.now(),
    ownerId: ownerId || null,
    asked: false,
  });
}

/**
 * Called when a message is sent in a tracked thread.
 * If the message is from the thread creator or staff → stop tracking.
 */
export function onMessageInThread(threadId, authorId, isStaff) {
  const tracked = trackedThreads.get(threadId);
  if (!tracked) return;

  // Staff replied before bot → stop tracking
  if (isStaff) {
    trackedThreads.delete(threadId);
    return;
  }

  // Creator replied → stop tracking
  if (tracked.ownerId && authorId === tracked.ownerId) {
    trackedThreads.delete(threadId);
    return;
  }

  // If we don't have ownerId, any user message counts as "creator replied"
  if (!tracked.ownerId) {
    trackedThreads.delete(threadId);
  }
}

/**
 * Returns threads that should receive the "please specify your request" prompt.
 */
export function getThreadsToPrompt() {
  const now = Date.now();
  const toPrompt = [];

  for (const [threadId, data] of trackedThreads.entries()) {
    if (data.asked) continue;
    const elapsed = now - data.createdAt;
    if (elapsed >= INACTIVITY_THRESHOLD) {
      toPrompt.push({ threadId, ...data });
    }
  }

  return toPrompt;
}

/**
 * Mark that the bot has sent the prompt for this thread.
 */
export function markAsAsked(threadId) {
  const tracked = trackedThreads.get(threadId);
  if (tracked) {
    tracked.asked = true;
  }
}

/**
 * Stop tracking a thread.
 */
export function stopTracking(threadId) {
  trackedThreads.delete(threadId);
}

/**
 * Cleanup old entries (threads tracked for more than 2 hours).
 */
export function cleanupExpired() {
  const now = Date.now();
  for (const [threadId, data] of trackedThreads.entries()) {
    if (now - data.createdAt > 2 * 60 * 60 * 1000) {
      trackedThreads.delete(threadId);
    }
  }
}

setInterval(cleanupExpired, 15 * 60 * 1000);
