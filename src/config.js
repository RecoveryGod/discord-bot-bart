const REQUIRED = [
  "BOT_TOKEN",
  "PAYMENT_CHANNEL_ID",
  "AMAZON_ROLE_ID",
  "TICKET_CHANNEL_ID",
];

function validate() {
  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(", ")}. Check .env and .env.example.`
    );
  }
}

export const BOT_TOKEN = process.env.BOT_TOKEN?.trim() ?? "";
export const PAYMENT_CHANNEL_ID = process.env.PAYMENT_CHANNEL_ID?.trim() ?? "";
export const AMAZON_ROLE_ID = process.env.AMAZON_ROLE_ID?.trim() ?? "";
export const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID?.trim() ?? "";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
export const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID?.trim() ?? "";

export function loadConfig() {
  validate();
  return {
    BOT_TOKEN,
    PAYMENT_CHANNEL_ID,
    AMAZON_ROLE_ID,
    TICKET_CHANNEL_ID,
  };
}
