/**
 * Shared keyword extraction used by !learn and !bad to derive FAQ search keywords
 * from a user message or staff-provided answer. Lowercases, strips punctuation,
 * filters short words and common stopwords, and caps the result.
 */

const STOP_WORDS = new Set([
  "the", "and", "for", "not", "you", "are", "this", "that", "with", "have",
  "was", "but", "from", "can", "will", "just", "all", "one", "out", "get",
  "how", "why", "what", "when", "where", "who", "its", "has", "had", "him",
  "she", "been", "being", "there", "their", "them", "than", "then", "into",
  "your", "my", "me", "we", "he", "it", "is", "do", "did", "does", "an",
  "a", "i", "or", "at", "by", "be", "to", "of", "in", "on", "up", "if",
  "so", "as", "no", "any",
]);

/**
 * @param {string} text - Source text to extract keywords from
 * @param {number} [max=6] - Maximum number of keywords to return
 * @returns {string[]}
 */
export function extractKeywords(text, max = 6) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, max);
}
