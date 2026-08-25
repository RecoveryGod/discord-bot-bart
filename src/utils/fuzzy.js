/**
 * Shared fuzzy-matching helpers for product name search.
 * Extracted from priceService.js so the catalogue search scores identically.
 */

/** lowercase, strip dashes/underscores/dots, collapse spaces, trim. */
export function normalize(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/[-_.–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Standard Levenshtein distance (DP). No external deps. */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** Query words worth matching on (drops 1-2 letter noise). */
export function queryWords(query) {
  return normalize(query).split(/\s+/).filter((w) => w.length > 2);
}

/**
 * Relevance of `haystack` for the given query words.
 * +2 per exact word hit, +0.5 per fuzzy token hit (Levenshtein <= 2).
 */
export function scoreMatch(haystack, words) {
  const normalized = normalize(haystack);
  const nameWords = normalized.split(/\s+/);
  let score = 0;
  for (const word of words) {
    if (normalized.includes(word)) score += 2;
  }
  for (const token of words) {
    if (token.length <= 3) continue;
    for (const nameWord of nameWords) {
      if (nameWord.length <= 3) continue;
      if (levenshtein(token, nameWord) <= 2) {
        score += 0.5;
        break;
      }
    }
  }
  return score;
}
