const pausedThreads = new Map(); // threadId -> { pausedAt: timestamp, lastStaffMessage: timestamp }
const PAUSE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Pauses bot replies for a thread when staff responds.
 */
export function pauseBotForThread(threadId) {
  pausedThreads.set(threadId, {
    pausedAt: Date.now(),
    lastStaffMessage: Date.now(),
  });
}

/**
 * Updates the last staff activity timestamp for a thread.
 */
export function updateStaffActivity(threadId) {
  const existing = pausedThreads.get(threadId);
  if (existing) {
    existing.lastStaffMessage = Date.now();
  } else {
    pauseBotForThread(threadId);
  }
}

/**
 * Checks if bot replies are paused for a thread.
 * Returns false if paused duration expired (auto-resume).
 */
export function isThreadPaused(threadId) {
  const paused = pausedThreads.get(threadId);
  if (!paused) return false;
  
  const timeSinceLastStaff = Date.now() - paused.lastStaffMessage;
  
  // If more than 5 min without staff reply → auto-resume
  if (timeSinceLastStaff > PAUSE_DURATION) {
    pausedThreads.delete(threadId);
    return false;
  }
  
  return true;
}

/**
 * Manually resume bot replies for a thread.
 */
export function resumeThread(threadId) {
  pausedThreads.delete(threadId);
}

/**
 * Manually pause bot replies for a thread.
 */
export function pauseThread(threadId) {
  pauseBotForThread(threadId);
}

/**
 * Cleans up expired paused threads.
 */
export function cleanupExpired() {
  const now = Date.now();
  for (const [threadId, paused] of pausedThreads.entries()) {
    if (now - paused.lastStaffMessage > PAUSE_DURATION) {
      pausedThreads.delete(threadId);
    }
  }
}

// Cleanup every minute
setInterval(cleanupExpired, 60 * 1000);
