const pausedThreads = new Map(); // threadId -> { pausedAt: timestamp, lastStaffMessage: timestamp }
const indefinitelyPausedThreads = new Set(); // threadId -> no time limit, only !resume clears
const PAUSE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Pauses bot replies for a thread when staff responds (time-limited: 5 min).
 */
export function pauseBotForThread(threadId) {
  pausedThreads.set(threadId, {
    pausedAt: Date.now(),
    lastStaffMessage: Date.now(),
  });
}

/**
 * Pauses bot replies for a thread with no time limit. Only !resume clears it.
 */
export function pauseThreadIndefinitely(threadId) {
  indefinitelyPausedThreads.add(threadId);
  pausedThreads.set(threadId, {
    pausedAt: Date.now(),
    lastStaffMessage: Date.now(),
  });
}

/**
 * Updates the last staff activity timestamp for a thread.
 */
export function updateStaffActivity(threadId) {
  // Do not override indefinite pause with time-based
  if (indefinitelyPausedThreads.has(threadId)) return;
  const existing = pausedThreads.get(threadId);
  if (existing) {
    existing.lastStaffMessage = Date.now();
  } else {
    pauseBotForThread(threadId);
  }
}

/**
 * Checks if bot replies are paused for a thread.
 * Returns true if indefinitely paused, or if time-based pause not expired.
 */
export function isThreadPaused(threadId) {
  if (indefinitelyPausedThreads.has(threadId)) return true;

  const paused = pausedThreads.get(threadId);
  if (!paused) return false;

  const timeSinceLastStaff = Date.now() - paused.lastStaffMessage;

  if (timeSinceLastStaff > PAUSE_DURATION) {
    pausedThreads.delete(threadId);
    return false;
  }

  return true;
}

/**
 * Manually resume bot replies for a thread (clears both time-based and indefinite).
 */
export function resumeThread(threadId) {
  indefinitelyPausedThreads.delete(threadId);
  pausedThreads.delete(threadId);
}

/**
 * Manually pause bot replies for a thread (5 min auto-resume).
 */
export function pauseThread(threadId) {
  pauseBotForThread(threadId);
}

/**
 * Cleans up expired time-based paused threads (never removes indefinite).
 */
export function cleanupExpired() {
  const now = Date.now();
  for (const [threadId, paused] of pausedThreads.entries()) {
    if (indefinitelyPausedThreads.has(threadId)) continue;
    if (now - paused.lastStaffMessage > PAUSE_DURATION) {
      pausedThreads.delete(threadId);
    }
  }
}

// Cleanup every minute
setInterval(cleanupExpired, 60 * 1000);
