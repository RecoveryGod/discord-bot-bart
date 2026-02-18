const rateLimitMap = new Map();

const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_THREAD = 5;

/**
 * Checks if a thread has exceeded the rate limit.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(threadId) {
  const now = Date.now();
  const key = threadId;
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  const limit = rateLimitMap.get(key);
  
  // Reset if window expired
  if (now > limit.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  // Check if limit exceeded
  if (limit.count >= MAX_REQUESTS_PER_THREAD) {
    return false;
  }
  
  // Increment count
  limit.count++;
  return true;
}

/**
 * Gets remaining requests for a thread.
 */
export function getRemainingRequests(threadId) {
  const limit = rateLimitMap.get(threadId);
  if (!limit) return MAX_REQUESTS_PER_THREAD;
  
  const now = Date.now();
  if (now > limit.resetAt) return MAX_REQUESTS_PER_THREAD;
  
  return Math.max(0, MAX_REQUESTS_PER_THREAD - limit.count);
}

/**
 * Cleans up expired entries (optional, for memory management).
 */
export function cleanupExpired() {
  const now = Date.now();
  for (const [key, limit] of rateLimitMap.entries()) {
    if (now > limit.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}

// Cleanup every 10 minutes
setInterval(cleanupExpired, 10 * 60 * 1000);
