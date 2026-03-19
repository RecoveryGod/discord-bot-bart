import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { loadConfig, BOT_TOKEN, PAYMENT_CHANNEL_ID, AMAZON_ROLE_ID, TICKET_CHANNEL_ID, OPENAI_API_KEY, STAFF_ROLE_ID } from "./config.js";
import { hasAmazonGiftCard } from "./services/detection.js";
import { sendPaymentNotification } from "./services/notification.js";
import { redactGiftCardCodes } from "./utils/redact.js";
import { checkRateLimit } from "./services/rateLimiter.js";
import { handleAISupport } from "./services/aiService.js";
import { updateStaffActivity, isThreadPaused, pauseThread, pauseThreadIndefinitely, resumeThread } from "./services/staffActivity.js";
import { shouldSkipDuplicateReply, recordBotMessage } from "./services/messageDeduplication.js";
import { trackThread, onMessageInThread, getThreadsToPrompt, markAsAsked } from "./services/threadInactivity.js";
import * as logger from "./utils/logger.js";

loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const INACTIVITY_PROMPT_MESSAGE =
  "Could you please specify why you opened this ticket? This will help us assist you.";

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

  // Check every 15s for threads where creator hasn't replied after 1 min
  setInterval(async () => {
    const toPrompt = getThreadsToPrompt();
    for (const { threadId } of toPrompt) {
      try {
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread && thread.isThread()) {
          // Mention the first human member (user added by ticket bot), not the thread owner (ticket bot)
          let userIdToMention = null;
          try {
            const members = await thread.members.fetch();
            // Pick first non-bot, non-staff human member
            for (const [, m] of members) {
              if (m.user.bot || m.user.id === client.user.id) continue;
              if (STAFF_ROLE_ID) {
                const guildMember = await thread.guild.members.fetch(m.user.id).catch(() => null);
                if (guildMember?.roles?.cache?.has(STAFF_ROLE_ID)) continue;
              }
              userIdToMention = m.user.id;
              break;
            }
          } catch (_) {}
          const message = userIdToMention
            ? `<@${userIdToMention}> ${INACTIVITY_PROMPT_MESSAGE}`
            : INACTIVITY_PROMPT_MESSAGE;
          await thread.send(message);
          markAsAsked(threadId);
          logger.info("Inactivity prompt sent — thread:", threadId);
        }
      } catch (err) {
        logger.error("Failed to send inactivity prompt:", err?.message, "thread:", threadId);
      }
    }
  }, 15_000);
});

client.on("threadCreate", async (thread) => {
  if (thread.parentId !== TICKET_CHANNEL_ID) return;
  if (thread.archived) return;
  // Real ticket owner = first human member (user added by ticket bot), not thread.ownerId (the bot)
  let ticketOwnerId = null;
  try {
    const members = await thread.members.fetch();
    // Pick first non-bot, non-staff human member as ticket owner
    for (const [, m] of members) {
      if (m.user.bot || m.user.id === client.user.id) continue;
      if (STAFF_ROLE_ID) {
        const guildMember = await thread.guild.members.fetch(m.user.id).catch(() => null);
        if (guildMember?.roles?.cache?.has(STAFF_ROLE_ID)) continue;
      }
      ticketOwnerId = m.user.id;
      break;
    }
  } catch (_) {}
  trackThread(thread.id, ticketOwnerId);
  logger.info("New ticket thread tracked:", thread.id, "ticket owner:", ticketOwnerId || "unknown");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  if (message.channel.parentId !== TICKET_CHANNEL_ID) return;

  const content = message.content;
  const threadId = message.channel.id;
  const isStaff = STAFF_ROLE_ID && message.member?.roles?.cache?.has(STAFF_ROLE_ID);

  // Notify inactivity tracker: creator or staff replied → stop tracking
  onMessageInThread(threadId, message.author.id, isStaff);

  // Handle staff commands: !pause, !mute, !resume (accept both "!bot mute" and "!bot-mute")
  if (isStaff && content) {
    const lowerContent = content.toLowerCase().trim();
    const cmd = lowerContent.replace(/-/g, " ").replace(/\s+/g, " ");
    if (cmd === "!pause" || cmd === "!bot pause") {
      pauseThread(threadId);
      await message.reply("✅ Bot replies paused for this thread. Will auto-resume after 5 minutes of inactivity.");
      try {
        await message.delete();
      } catch (err) {
        logger.error("Failed to delete command message:", err?.message);
      }
      logger.info("Thread paused manually by staff:", threadId, "staff:", message.author.tag);
      return;
    }
    if (cmd === "!mute" || cmd === "!bot mute") {
      pauseThreadIndefinitely(threadId);
      await message.reply("✅ Bot is now muted for this thread. No replies until you use **!resume**.");
      try {
        await message.delete();
      } catch (err) {
        logger.error("Failed to delete command message:", err?.message);
      }
      logger.info("Thread muted indefinitely by staff:", threadId, "staff:", message.author.tag);
      return;
    }
    if (cmd === "!resume" || cmd === "!bot resume") {
      resumeThread(threadId);
      await message.reply("✅ Bot replies resumed for this thread.");
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

    // Get AI response (pass channel for conversation history)
    const aiResult = await handleAISupport(safeContent, message.channel);

    if (!aiResult) {
      logger.error("AI service returned null for thread:", message.channel.id);
      return;
    }

    const { answer, confidence } = aiResult;

    if (confidence >= 0.6) {
      // Check for duplicate before replying
      if (await shouldSkipDuplicateReply(message.channel, answer)) {
        logger.info(
          "Skipping duplicate reply — thread:",
          message.channel.id,
          "confidence:",
          confidence.toFixed(2)
        );
        return;
      }
      // Auto-reply
      await message.reply(answer);
      recordBotMessage(message.channel.id, answer);
      logger.info(
        "AI reply sent — thread:",
        message.channel.id,
        "confidence:",
        confidence.toFixed(2)
      );
    } else {
      // Escalate to human
      const escalationMessage = `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.`;
      // Check for duplicate before replying
      if (await shouldSkipDuplicateReply(message.channel, escalationMessage)) {
        logger.info(
          "Skipping duplicate escalation — thread:",
          message.channel.id
        );
        return;
      }
      await message.reply(escalationMessage);
      recordBotMessage(message.channel.id, escalationMessage);
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
      const escalationMessage = `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.`;
      // Check for duplicate before replying
      if (await shouldSkipDuplicateReply(message.channel, escalationMessage)) {
        logger.info(
          "Skipping duplicate fallback escalation — thread:",
          message.channel.id
        );
        return;
      }
      await message.reply(escalationMessage);
      recordBotMessage(message.channel.id, escalationMessage);
    } catch (replyErr) {
      logger.error("Failed to send escalation message:", replyErr?.message);
    }
  }
});

client.login(BOT_TOKEN);
