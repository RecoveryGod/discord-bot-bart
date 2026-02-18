import { AMAZON_CODE_REGEX } from "../constants.js";

const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Replaces Amazon gift card code patterns with a placeholder.
 * Never republish full codes in notifications or logs.
 */
export function redactGiftCardCodes(text) {
  if (!text || typeof text !== "string") return "";
  return text.replace(AMAZON_CODE_REGEX, REDACTION_PLACEHOLDER);
}
