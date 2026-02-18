import { OPENAI_API_KEY } from "../config.js";
import { searchFAQ, formatFAQContext, FAQ_MIN_SCORE } from "./knowledgeBase.js";
import { redactGiftCardCodes } from "../utils/redact.js";

const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.3;
const MAX_TOKENS = 500;

const SYSTEM_PROMPT = `You are the official automated support assistant for the RecoveryGods Discord server.

RecoveryGods provides authorized game modification software approved by the respective game publishers.

Your role is to assist users professionally and clearly with:

1. License key activation issues
2. Payment-related questions
3. Access issues after purchase
4. General usage guidance
5. Redirecting technical issues to the official software Discord or Telegram
6. Escalating to a human staff member when necessary

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

-----------------------------------------
ACTIVATION & LICENSE RULES
-----------------------------------------

If the user asks about:

• Activation not working  
• Invalid key  
• Key already used  
• Key expired  
• How to activate  

You must:
- Provide clear step-by-step activation instructions.
- Remind them to copy/paste the key carefully.
- Suggest restarting the software if relevant.
- If the issue persists → escalate to human support.

-----------------------------------------
PAYMENT ISSUES
-----------------------------------------

If the user mentions:

• Payment not confirmed  
• Amazon gift card payment  
• Transaction pending  
• Wrong amount  
• Did not receive product  

You must:
- Reassure the user.
- Explain that payment verification may take some time.
- Inform them that staff will verify manually if needed.
- Never ask for full gift card codes.
- Never request sensitive payment details.
- If unclear → escalate to human staff.

-----------------------------------------
TECHNICAL QUESTIONS
-----------------------------------------

If the user reports:

• Software crash  
• Error code  
• Loader not launching  
• Injection problem  
• Antivirus blocking  
• Compatibility issues  

You must:
- Politely inform them that technical troubleshooting is handled by the official software team.
- Direct them to the official Discord or Telegram of the software.
- Do NOT attempt advanced troubleshooting.
- Keep it short and clear.

Example:
"For technical issues, please contact the official software support team directly via their Discord or Telegram. They will assist you faster."

-----------------------------------------
ESCALATION RULES
-----------------------------------------

If:
- The question is unclear
- The user is frustrated
- The issue does not match activation/payment/basic guidance
- You are not confident

You must say:

"A human support agent will assist you shortly."

-----------------------------------------
STYLE
-----------------------------------------

- Clear
- Direct
- Structured
- No emojis
- No excessive formatting
- No long paragraphs
- Maximum clarity

-----------------------------------------
PRIORITY
-----------------------------------------

1. Payment reassurance
2. Activation guidance
3. Technical redirection
4. Human escalation if uncertain

Only answer based on the provided knowledge base context.
If the knowledge base does not contain enough information, escalate.
`;

/**
 * Calls OpenAI API to generate a support response.
 * Returns { answer: string, confidence: number } or null on error.
 */
export async function generateAIResponse(userMessage, faqContext) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // Always redact gift card codes before sending to OpenAI
  const safeMessage = redactGiftCardCodes(userMessage);

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: `Knowledge Base:\n${faqContext}\n\nCustomer Question: ${safeMessage}\n\nReturn ONLY valid JSON (no markdown, no code fences) with this shape:\n{"answer":"...", "confidence": 0.0}\n\nRules:\n- If the Knowledge Base matches the question: use it and set confidence >= 0.6\n- If the Knowledge Base does NOT match: provide a helpful general response OR escalate to human\n- For urgent issues (waiting times, complaints, delays): escalate to human with confidence < 0.6\n- confidence: number between 0 and 1\n- if unsure or Knowledge Base doesn't match: set confidence < 0.6 and answer: "A human support agent will assist you shortly."\n- never ask for full gift card codes\n- CRITICAL: If the Knowledge Base contains URLs or links, you MUST include ALL of them in your answer verbatim\n- Preserve line breaks using \\n in the JSON string\n- Do not summarize URLs or replace them with generic text\n`,
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

    return { answer, confidence };
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
export async function handleAISupport(userMessage) {
  // Redact sensitive data
  const safeMessage = redactGiftCardCodes(userMessage);

  // Search knowledge base
  const { entries: relevantFAQ, bestScore } = searchFAQ(safeMessage);
  
  // If FAQ score is too low, escalate directly without calling OpenAI
  if (bestScore < FAQ_MIN_SCORE) {
    return {
      answer: "A human support agent will assist you shortly.",
      confidence: 0,
    };
  }

  const faqContext = formatFAQContext(relevantFAQ);

  // Generate AI response
  const result = await generateAIResponse(safeMessage, faqContext);

  return result;
}
