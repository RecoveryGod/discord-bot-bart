import { OPENAI_API_KEY } from "../config.js";
import { redactGiftCardCodes } from "../utils/redact.js";
import * as logger from "../utils/logger.js";

const MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `You extract the core support question from a raw customer Discord message.

Rules:
- Remove greetings, pings, multi-topic rambling, filler words, and emoji.
- Reword/trim ONLY using the user's own words. Never invent content.
- Preserve product names verbatim (Stand, Atlas, Lexis, Midnight, redENGINE, etc.).
- Keep the question concise and clear — one sentence if possible.
- If no clear support question exists in the message, return an empty string.

Respond with ONLY valid JSON in this exact shape:
{"question": "..."}`;

/**
 * Strips Discord mention tokens (user, channel, role) and custom emoji from a string.
 * Leaves normal text/unicode emoji intact.
 */
function stripMentions(text) {
  return text
    .replace(/<@!?\d+>/g, "")     // user mentions
    .replace(/<#\d+>/g, "")        // channel mentions
    .replace(/<@&\d+>/g, "")       // role mentions
    .replace(/<a?:\w+:\d+>/g, "")  // custom emoji
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Uses gpt-4o-mini to extract the clean core question from a raw user message.
 * Returns the cleaned question string, or null on any failure (caller falls back).
 *
 * @param {string} rawText - Raw user message content
 * @returns {Promise<string | null>}
 */
export async function extractCoreQuestion(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  if (!OPENAI_API_KEY) return null;

  const stripped = stripMentions(rawText);
  if (!stripped) return null;

  const safeInput = redactGiftCardCodes(stripped);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: 80,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: safeInput },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      logger.error("[questionExtractor] OpenAI error:", response.status);
      return null;
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const question = typeof parsed?.question === "string" ? parsed.question.trim() : "";
    return question || null;
  } catch (err) {
    logger.error("[questionExtractor] Extraction failed:", err?.message);
    return null;
  }
}
