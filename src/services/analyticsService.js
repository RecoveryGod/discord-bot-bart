/**
 * In-memory per-ticket analytics tracker.
 * Tracks AI replies, escalations, FAQ hits, and learn events for each ticket thread.
 * Data is flushed (returned and deleted) when a ticket is archived.
 */

const tickets = new Map();

/**
 * Call when threadCreate fires for a ticket.
 */
export function trackTicketOpened(threadId) {
  tickets.set(threadId, {
    openedAt: new Date(),
    aiReplies: [],
    escalated: false,
    faqHits: [],
    learnEvents: 0,
  });
}

/**
 * Call after AI reply is sent. confidence is 0-1 float.
 */
export function trackAIReply(threadId, confidence) {
  const data = tickets.get(threadId);
  if (!data) return;
  data.aiReplies.push({ confidence });
}

/**
 * Call after escalation message is sent. reason is a short string e.g. "low_confidence", "no_faq_match".
 */
export function trackEscalation(threadId, reason) {
  const data = tickets.get(threadId);
  if (!data) return;
  data.escalated = { reason };
}

/**
 * Call when FAQ search returns results. entryQuestion is the top FAQ entry's question string, score is the numeric score.
 */
export function trackFAQHit(threadId, entryQuestion, score) {
  const data = tickets.get(threadId);
  if (!data) return;
  data.faqHits.push({ question: entryQuestion, score });
}

/**
 * Call when !learn command is used.
 */
export function trackLearnEvent(threadId) {
  const data = tickets.get(threadId);
  if (!data) return;
  data.learnEvents += 1;
}

/**
 * Returns the summary data for a thread, then deletes it from memory.
 * Returns null if no data exists for the thread.
 */
export function flushTicketData(threadId) {
  const data = tickets.get(threadId);
  if (!data) return null;
  tickets.delete(threadId);
  return data;
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 */
function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

/**
 * Builds a Discord message summary card for a closed ticket.
 * Returns a plain string (not an embed).
 */
export function buildSummaryCard(threadName, data) {
  const duration = formatDuration(Date.now() - data.openedAt.getTime());
  const aiReplyCount = data.aiReplies.length;
  const faqHitCount = data.faqHits.length;

  const header = `\uD83C\uDFAB **Ticket closed** \u2014 #${threadName}`;
  const stats = `\u23F1 Duration: ${duration}  |  \uD83E\uDD16 AI replies: ${aiReplyCount}  |  \uD83D\uDCDA FAQ hits: ${faqHitCount}`;

  let statusLine;
  if (aiReplyCount === 0 && !data.escalated) {
    statusLine = `\u2139\uFE0F No AI interaction recorded`;
  } else if (data.escalated) {
    statusLine = `\u26A0\uFE0F Escalated to staff (reason: ${data.escalated.reason})`;
  } else {
    const avgConfidence = data.aiReplies.reduce((sum, r) => sum + r.confidence, 0) / aiReplyCount;
    statusLine = `\u2705 Resolved by AI (avg confidence: ${avgConfidence.toFixed(2)})`;
  }

  return `${header}\n${stats}\n${statusLine}`;
}
