import { OPENAI_API_KEY } from "../config.js";
import { searchFAQ, formatFAQContext, FAQ_MIN_SCORE } from "./knowledgeBase.js";
import { searchPrices, formatPriceContext } from "./priceService.js";
import { redactGiftCardCodes } from "../utils/redact.js";
import * as logger from "../utils/logger.js";

const MODEL = "gpt-4o";
const TEMPERATURE = 0.1;
const MAX_TOKENS = 1000;

const SYSTEM_PROMPT = `You are the official automated support assistant for the RecoveryGods Discord server.

RecoveryGods sells authorized game modification software licenses.

Your role is to assist users professionally and clearly with:

1. License key activation issues
2. Payment-related questions
3. Access issues after purchase
4. General usage guidance
5. Redirecting technical issues to the official software Discord or Telegram
6. Escalating to a human staff member when necessary

-----------------------------------------
PRODUCTS WE SELL
-----------------------------------------

GTA V / GTA Online: Stand, Atlas, Lexis, 0xCheats, Midnight, Infamous, Fortitude, X-Force, Raiden, Rebound, Phaze, Scooby, Ethereal, Jupiter
FiveM: redENGINE (Lua Executor, Spoofer), Infamous, Rift
CS2 (Counter-Strike 2): Midnight, MemeSense, Predator, Nixware, Kernaim, Fecurity
CS 1.6: Midnight
Apex Legends: Lexis, Kernaim
RDR2 (Red Dead Redemption 2): Fortitude, Infamous, Ethereal, Rift
Call of Duty (BO6, BO7, Warzone, MW2, MW3): Fecurity, Kernaim
Deadlock: Predator
Marvel Rivals: Predator
ARC Raiders: Kernaim, Fecurity
Battlefield: Kernaim, Fecurity
Rust: Kernaim
Escape from Tarkov: Kernaim
DayZ: Kernaim
Other: Cherax, Fragment, Hares

Do NOT invent product details not present in the knowledge base or price list.

-----------------------------------------
BEHAVIOR RULES
-----------------------------------------

- Be professional, calm, and concise.
- Never speculate.
- Never invent policies.
- Never provide technical troubleshooting beyond basic guidance.
- Never provide internal or sensitive information.
- Never mention OpenAI or that you are an AI model.
- Do not answer unrelated topics.
- Never ask for full gift card codes.

-----------------------------------------
ACTIVATION & LICENSE RULES
-----------------------------------------

If the user asks about activation not working, invalid key, key already used, key expired, or how to activate:
- Provide clear step-by-step activation instructions.
- Remind them to copy/paste the key carefully.
- Suggest restarting the software if relevant.
- If the issue persists → escalate to human support.

-----------------------------------------
PAYMENT ISSUES
-----------------------------------------

If the user mentions payment not confirmed, Amazon gift card, transaction pending, wrong amount, or did not receive product:
- Reassure the user.
- Explain that payment verification may take some time.
- Inform them that staff will verify manually if needed.
- If unclear → escalate to human staff.

-----------------------------------------
TECHNICAL QUESTIONS
-----------------------------------------

If the user reports software crash, error code, loader not launching, injection problem, antivirus blocking, or compatibility issues:
- Direct them to the official Discord or Telegram of the software.
- Do NOT attempt advanced troubleshooting.

-----------------------------------------
ESCALATION RULES
-----------------------------------------

If the question is unclear, the user is frustrated, the issue is outside activation/payment/basic guidance, or you are not confident: set confidence < 0.6 and answer: "A human support agent will assist you shortly."

-----------------------------------------
RESPONSE FORMAT (MANDATORY)
-----------------------------------------

You MUST respond with ONLY valid JSON — no markdown, no code fences, nothing else:
{"answer": "...", "confidence": 0.0}

Rules:
- confidence: number between 0.0 and 1.0
- If the Knowledge Base clearly answers the question: use it and set confidence >= 0.6
- If the Knowledge Base does NOT match: either provide a helpful general response or set confidence < 0.6 to escalate
- For urgent issues (complaints, long waits, delays): set confidence < 0.6 to escalate
- If the Knowledge Base contains URLs or links: include ALL of them verbatim in your answer
- If Product Prices are provided and the user asks about pricing: list relevant prices clearly
- Preserve line breaks using \n in the JSON string
- Do not summarize URLs or replace them with generic text

-----------------------------------------
STYLE
-----------------------------------------

- Clear, direct, structured
- No emojis
- No excessive formatting
- No long paragraphs

-----------------------------------------
PRIORITY
-----------------------------------------

1. Payment reassurance
2. Activation guidance
3. Technical redirection
4. Human escalation if uncertain

Only answer based on the provided knowledge base context.
If the knowledge base does not contain enough information, escalate.

Always reply in the same language as the customer's message. If the customer writes in French, reply entirely in French. If they write in English, reply in English.
`;

const HISTORY_LIMIT = 10;

/**
 * Fetches the last N messages from a thread as conversation history.
 * Excludes the current message (last item, already in userMessage).
 * Returns array of { role: "user"|"assistant", content: string }.
 */
async function fetchThreadHistory(channel) {
  try {
    const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
    // Discord returns newest first — reverse to chronological order
    const chronological = Array.from(fetched.values()).reverse();
    // Drop the last message (current one, already passed as userMessage)
    const history = chronological.slice(0, -1);
    return history
      .map((msg) => ({
        role: msg.author.id === channel.client.user.id ? "assistant" : "user",
        content: redactGiftCardCodes(msg.content || ""),
      }))
      .filter((m) => m.content.trim() !== "");
  } catch (err) {
    logger.error("Failed to fetch thread history:", err?.message);
    return [];
  }
}

/**
 * Calls OpenAI API to generate a support response.
 * Returns { answer: string, confidence: number } or null on error.
 */
export async function generateAIResponse(userMessage, faqContext, history = [], isRetry = false, priceContext = null) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // Always redact gift card codes before sending to OpenAI
  const safeMessage = redactGiftCardCodes(userMessage);

  const retryInstruction = isRetry
    ? "\n- RETRY: Your previous attempt had low confidence. Provide the most helpful answer you can based on the knowledge base, even if partial. Only set confidence < 0.6 if the topic is truly outside your knowledge base."
    : "";

  const priceSection = priceContext ? `\n\n${priceContext}` : "";

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    ...history,
    {
      role: "user",
      content: `Knowledge Base:\n${faqContext}${priceSection}\n\nCustomer Question: ${safeMessage}${retryInstruction}`,
    },
  ];

  try {
    const controller = new AbortController();
    const timeoutMs = 15_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          messages,
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `OpenAI API error: ${response.status} ${errorData.error?.message || response.statusText}`
      );
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";

    if (!raw) {
      return { answer: "A human support agent will assist you shortly.", confidence: 0 };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { answer: "A human support agent will assist you shortly.", confidence: 0 };
    }

    const answer =
      typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
    const confidenceNum = Number(parsed?.confidence);
    const confidence = Number.isFinite(confidenceNum)
      ? Math.min(1, Math.max(0, confidenceNum))
      : 0;

    if (!answer) {
      return { answer: "A human support agent will assist you shortly.", confidence: 0 };
    }

    // Override confidence to 0 if the answer contains hedging phrases —
    // the model sometimes self-reports high confidence while hedging in the text.
    const hedgePhrases = ["i'm not sure", "i am not sure", "i cannot", "i don't know", "i do not know", "it depends", "not certain", "i'm unable"];
    const lowerAnswer = answer.toLowerCase();
    const finalConfidence = hedgePhrases.some((p) => lowerAnswer.includes(p)) ? 0 : confidence;

    return { answer, confidence: finalConfidence };
  } catch (err) {
    console.error("OpenAI API error:", err.message);
    return {
      answer: "I'm experiencing technical difficulties. A human agent will assist you shortly.",
      confidence: 0,
    };
  }
}

/**
 * Main function to handle AI support request.
 * Returns { answer: string, confidence: number } or null if should skip.
 */
export async function handleAISupport(userMessage, channel) {
  // Redact sensitive data
  const safeMessage = redactGiftCardCodes(userMessage);

  // Search knowledge base and price list in parallel
  const { entries: relevantFAQ, bestScore } = searchFAQ(safeMessage);
  const matchedPrices = searchPrices(safeMessage);
  const priceContext = formatPriceContext(matchedPrices);

  if (priceContext) {
    logger.info("Price context found —", matchedPrices.length, "product(s) matched");
  }

  // Only skip the AI call if there is truly zero match (score 0 and no price hit).
  // Weak matches (score > 0) still go to the AI — it decides whether to answer or escalate.
  if (bestScore === 0 && !priceContext) {
    logger.info("Zero FAQ/price match — escalating directly");
    return {
      answer: "A human support agent will assist you shortly.",
      confidence: 0,
      escalationReason: "no_faq_match",
    };
  }

  const faqContext = formatFAQContext(relevantFAQ);

  // Fetch conversation history for context (fails gracefully to empty array)
  const history = channel ? await fetchThreadHistory(channel) : [];

  // First attempt
  const result = await generateAIResponse(safeMessage, faqContext, history, false, priceContext);

  // If confidence is too low, retry once before escalating
  if (result.confidence < 0.6) {
    logger.info("Low confidence on first attempt:", result.confidence.toFixed(2), "— retrying...");
    const retry = await generateAIResponse(safeMessage, faqContext, history, true, priceContext);
    logger.info("Retry confidence:", retry.confidence.toFixed(2));
    return retry;
  }

  return result;
}
