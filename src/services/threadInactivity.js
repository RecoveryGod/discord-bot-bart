/**
 * Tracks new ticket threads and prompts the creator to specify their request
 * if they haven't sent a message within 1 minute.
 */

const trackedThreads = new Map(); // threadId -> { createdAt, ownerId, asked }
const INACTIVITY_THRESHOLD = 60 * 1000; // 1 minute

// Map: threadId → { lastActivityAt: Date, warningSentAt: Date | null }
const idleThreads = new Map();

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
 * Start idle tracking for a thread (called when a ticket is created).
 */
export function startIdleTracking(threadId) {
  idleThreads.set(threadId, {
    lastActivityAt: new Date(),
    warningSentAt: null,
  });
}

/**
 * Record activity in a thread (resets idle clock and clears any pending warning).
 */
export function recordActivity(threadId) {
  const entry = idleThreads.get(threadId);
  if (entry) {
    entry.lastActivityAt = new Date();
    entry.warningSentAt = null;
  }
}

/**
 * Stop idle tracking for a thread (called when thread is archived).
 */
export function stopIdleTracking(threadId) {
  idleThreads.delete(threadId);
}

/**
 * Returns array of threadIds that have been idle for more than `hoursIdle` hours
 * and have not yet been warned.
 */
export function getThreadsToWarn(hoursIdle) {
  const now = Date.now();
  const threshold = hoursIdle * 60 * 60 * 1000;
  const result = [];
  for (const [threadId, data] of idleThreads.entries()) {
    if (data.warningSentAt !== null) continue;
    if (now - data.lastActivityAt.getTime() > threshold) {
      result.push(threadId);
    }
  }
  return result;
}

/**
 * Returns array of threadIds where a warning was sent more than 24 hours ago.
 */
export function getThreadsToClose() {
  const now = Date.now();
  const graceMs = 24 * 60 * 60 * 1000;
  const result = [];
  for (const [threadId, data] of idleThreads.entries()) {
    if (data.warningSentAt !== null && now - data.warningSentAt.getTime() > graceMs) {
      result.push(threadId);
    }
  }
  return result;
}

/**
 * Mark that a warning has been sent for this thread.
 */
export function markWarningSent(threadId) {
  const entry = idleThreads.get(threadId);
  if (entry) {
    entry.warningSentAt = new Date();
  }
}

/**
 * Cleanup old entries (threads tracked for more than 2 hours).
 * Also cleans up idle entries older than 7 days (safety valve).
 */
export function cleanupExpired() {
  const now = Date.now();
  for (const [threadId, data] of trackedThreads.entries()) {
    if (now - data.createdAt > 2 * 60 * 60 * 1000) {
      trackedThreads.delete(threadId);
    }
  }
  // Safety valve: remove idle entries older than 7 days
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  for (const [threadId, data] of idleThreads.entries()) {
    if (now - data.lastActivityAt.getTime() > sevenDays) {
      idleThreads.delete(threadId);
    }
  }
}

setInterval(cleanupExpired, 15 * 60 * 1000);
