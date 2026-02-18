import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let faqData = null;

function loadFAQ() {
  if (!faqData) {
    try {
      const faqPath = join(__dirname, "../../data/faq.json");
      const fileContent = readFileSync(faqPath, "utf-8");
      faqData = JSON.parse(fileContent);
    } catch (err) {
      console.error("Failed to load FAQ:", err);
      faqData = [];
    }
  }
  return faqData;
}

/**
 * Searches FAQ entries relevant to the query.
 * Returns top matching entries based on keyword matching.
 * Also returns the best score for confidence checking.
 */
export function searchFAQ(query) {
  if (!query || typeof query !== "string") return { entries: [], bestScore: 0 };
  
  const faq = loadFAQ();
  const lowerQuery = query.toLowerCase();
  
  const scored = faq.map((entry) => {
    let score = 0;
    const lowerQuestion = entry.question.toLowerCase();
    const lowerAnswer = entry.answer.toLowerCase();
    
    // Exact keyword match
    entry.keywords?.forEach((keyword) => {
      if (lowerQuery.includes(keyword.toLowerCase())) {
        score += 2;
      }
    });
    
    // Question contains query terms
    const queryWords = lowerQuery.split(/\s+/);
    queryWords.forEach((word) => {
      if (lowerQuestion.includes(word)) score += 1;
      if (lowerAnswer.includes(word)) score += 0.5;
    });
    
    return { ...entry, score };
  });
  
  // Sort by score and get top 3
  const filtered = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  
  const bestScore = filtered.length > 0 ? filtered[0].score : 0;
  const topEntries = filtered.slice(0, 3).map(({ score, ...entry }) => entry);
  
  return { entries: topEntries, bestScore };
}

/**
 * Formats FAQ entries as context for OpenAI.
 */
export function formatFAQContext(entries) {
  if (!entries || entries.length === 0) {
    return "No relevant FAQ entries found.";
  }
  
  return entries
    .map((entry, idx) => {
      return `FAQ Entry ${idx + 1}:
Q: ${entry.question}
A: ${entry.answer}`;
    })
    .join("\n\n");
}

/**
 * Minimum score threshold for FAQ matching.
 * If best score is below this, FAQ is considered not relevant.
 */
export const FAQ_MIN_SCORE = 2;
