import { AMAZON_CODE_REGEX, AMAZON_KEYWORDS } from "../constants.js";

/**
 * Returns true if the text suggests an Amazon gift card (format or keywords).
 */
export function hasAmazonGiftCard(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return (
    AMAZON_CODE_REGEX.test(text) ||
    AMAZON_KEYWORDS.some((k) => lower.includes(k))
  );
}
