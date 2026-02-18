import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { loadConfig, BOT_TOKEN, PAYMENT_CHANNEL_ID, AMAZON_ROLE_ID, TICKET_CHANNEL_ID, OPENAI_API_KEY, STAFF_ROLE_ID } from "./config.js";
import { hasAmazonGiftCard } from "./services/detection.js";
import { sendPaymentNotification } from "./services/notification.js";
import { redactGiftCardCodes } from "./utils/redact.js";
import { checkRateLimit } from "./services/rateLimiter.js";
import { handleAISupport } from "./services/aiService.js";
import { updateStaffActivity, isThreadPaused, pauseThread, resumeThread } from "./services/staffActivity.js";
import * as logger from "./utils/logger.js";

loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("ready", async () => {
  logger.info("Bot prêt, guilds:", client.guilds.cache.size);
  const payment = await client.channels.fetch(PAYMENT_CHANNEL_ID).catch(() => null);
  const tickets = await client.channels.fetch(TICKET_CHANNEL_ID).catch(() => null);
  logger.info(
    "Channel paiement:",
    payment ? PAYMENT_CHANNEL_ID : "introuvable",
    "| Channel tickets:",
    tickets ? TICKET_CHANNEL_ID : "introuvable"
  );
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  if (message.channel.parentId !== TICKET_CHANNEL_ID) return;

  const content = message.content;
  const threadId = message.channel.id;
  const isStaff = STAFF_ROLE_ID && message.member?.roles?.cache?.has(STAFF_ROLE_ID);

  // Handle staff commands: !pause and !resume
  if (isStaff && content) {
    const lowerContent = content.toLowerCase().trim();
    if (lowerContent === "!pause" || lowerContent === "!bot pause") {
      pauseThread(threadId);
      await message.reply("✅ Bot replies paused for this thread. Will auto-resume after 5 minutes of inactivity.");
      // Delete the command message
      try {
        await message.delete();
      } catch (err) {
        logger.error("Failed to delete command message:", err?.message);
      }
      logger.info("Thread paused manually by staff:", threadId, "staff:", message.author.tag);
      return;
    }
    if (lowerContent === "!resume" || lowerContent === "!bot resume") {
      resumeThread(threadId);
      await message.reply("✅ Bot replies resumed for this thread.");
      // Delete the command message
      try {
        await message.delete();
      } catch (err) {
        logger.error("Failed to delete command message:", err?.message);
      }
      logger.info("Thread resumed manually by staff:", threadId, "staff:", message.author.tag);
      return;
    }
  }

  // Detect staff activity: if staff replies, pause bot automatically
  if (isStaff) {
    updateStaffActivity(threadId);
    logger.info("Staff activity detected — thread paused:", threadId, "staff:", message.author.tag);
    return; // Staff replied → bot doesn't process this message
  }

  // Check if thread is paused (bot won't reply)
  if (isThreadPaused(threadId)) {
    return; // Thread paused → bot skips
  }

  if (!content) return;

  // Priority 1: Amazon Gift Card detection (existing behavior)
  if (hasAmazonGiftCard(content)) {
    try {
      const paymentChannel = await message.guild.channels.fetch(PAYMENT_CHANNEL_ID);
      if (!paymentChannel) {
        logger.error("Channel paiement introuvable:", PAYMENT_CHANNEL_ID);
        return;
      }

      const threadLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}`;
      const excerptRedacted = redactGiftCardCodes(content);
      const timestampDiscord = `<t:${Math.floor(Date.now() / 1000)}:F>`;

      logger.info(
        "Amazon gift card détectée — thread:",
        message.channel.id,
        "auteur:",
        message.author.tag
      );

      await sendPaymentNotification({
        paymentChannel,
        threadLink,
        authorTag: message.author.tag,
        excerptRedacted,
        roleId: AMAZON_ROLE_ID,
        timestampDiscord,
      });
    } catch (err) {
      logger.error("Erreur lors de la notification paiement:", err?.message ?? err, "channel:", message.channel?.id, "message:", message.id);
    }
    return;
  }

  // Priority 2: AI Support (new behavior)
  // Skip if OpenAI API key is not configured
  if (!OPENAI_API_KEY) {
    return;
  }

  try {
    // Check rate limit
    if (!checkRateLimit(message.channel.id)) {
      logger.info("Rate limit exceeded for thread:", message.channel.id);
      return;
    }

    // Redact sensitive codes before processing
    const safeContent = redactGiftCardCodes(content);

    // Get AI response
    const aiResult = await handleAISupport(safeContent);

    if (!aiResult) {
      logger.error("AI service returned null for thread:", message.channel.id);
      return;
    }

    const { answer, confidence } = aiResult;

    if (confidence >= 0.6) {
      // Auto-reply
      await message.reply(answer);
      logger.info(
        "AI reply sent — thread:",
        message.channel.id,
        "confidence:",
        confidence.toFixed(2)
      );
    } else {
      // Escalate to human
      await message.reply(
        `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.`
      );
      logger.info(
        "Escalated to human — thread:",
        message.channel.id,
        "confidence:",
        confidence.toFixed(2)
      );
    }
  } catch (err) {
    logger.error("Erreur lors du support IA:", err?.message ?? err, "channel:", message.channel?.id, "message:", message.id);
    // Fallback: escalate to human on error
    try {
      await message.reply(
        `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.`
      );
    } catch (replyErr) {
      logger.error("Failed to send escalation message:", replyErr?.message);
    }
  }
});

client.login(BOT_TOKEN);
