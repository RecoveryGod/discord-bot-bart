import "dotenv/config";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import { loadConfig, BOT_TOKEN, PAYMENT_CHANNEL_ID, AMAZON_ROLE_ID, TICKET_CHANNEL_ID, OPENAI_API_KEY, STAFF_ROLE_ID, TICKET_BOT_ID, CLIENT_ID, GUILD_ID, ANALYTICS_CHANNEL_ID, AUTO_CLOSE_HOURS, TRAINING_CHANNEL_ID, DOCS_EMBED_ON_BOOT, BOT_VERSION } from "./config.js";
import { hasAmazonGiftCard } from "./services/detection.js";
import { sendPaymentNotification } from "./services/notification.js";
import { redactGiftCardCodes } from "./utils/redact.js";
import { checkRateLimit } from "./services/rateLimiter.js";
import { handleAISupport } from "./services/aiService.js";
import { updateStaffActivity, isThreadPaused, pauseThread, pauseThreadIndefinitely, resumeThread } from "./services/staffActivity.js";
import { shouldSkipDuplicateReply, recordBotMessage } from "./services/messageDeduplication.js";
import { trackThread, onMessageInThread, getThreadsToPrompt, markAsAsked, stopTracking, startIdleTracking, recordActivity, stopIdleTracking, getThreadsToWarn, getThreadsToClose, markWarningSent } from "./services/threadInactivity.js";
import { searchPrices } from "./services/priceService.js";
import { appendLearnedEntry } from "./services/knowledgeBase.js";
import { extractCoreQuestion } from "./services/questionExtractor.js";
import { enqueueMessage, flushBatch, flushThreadBatches } from "./services/messageBatcher.js";
import { appendRule, deleteRule, listRules } from "./services/rulesService.js";
import { ensureDocsIndex } from "./services/docsService.js";
import { extractKeywords } from "./utils/keywords.js";
import * as analytics from "./services/analyticsService.js";
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

/**
 * Extracts the user's custom inquiry from a tickets.bot message.
 * Checks both plain text content and embed fields/description.
 * Returns the inquiry string, or null if not found.
 */
function extractTicketBotInquiry(content, embeds = []) {
  const header = "State your inquiry or issue";

  // Helper: extract inquiry from a raw string
  function parseInquiry(text) {
    if (!text) return null;
    const footer = "Powered by tickets.bot";
    const headerIdx = text.indexOf(header);
    if (headerIdx === -1) return null;
    const inquiryStart = headerIdx + header.length;
    const footerIdx = text.indexOf(footer, inquiryStart);
    const raw = footerIdx !== -1
      ? text.slice(inquiryStart, footerIdx)
      : text.slice(inquiryStart);
    return raw.trim() || null;
  }

  // 1. Try plain text content
  const fromContent = parseInquiry(content);
  if (fromContent) return fromContent;

  // 2. Try embed description and field values
  for (const embed of embeds) {
    const fromDesc = parseInquiry(embed.description);
    if (fromDesc) return fromDesc;
    for (const field of (embed.fields ?? [])) {
      // Field name or value may contain the inquiry
      if (field.name?.includes(header)) {
        return field.value?.trim() || null;
      }
      const fromValue = parseInquiry(field.value);
      if (fromValue) return fromValue;
    }
  }

  return null;
}

/**
 * Send a reply to a user message, falling back to channel.send() if the original message
 * was deleted during the batch debounce window (Discord error 10008: Unknown Message).
 */
async function safeReply(message, content) {
  try {
    return await message.reply(content);
  } catch (err) {
    if (err?.code === 10008 || /unknown message/i.test(err?.message || "")) {
      logger.info("safeReply: original message gone — falling back to channel.send()");
      return await message.channel.send(content);
    }
    throw err;
  }
}

/**
 * AI Support processor — called by the message batcher after the debounce window elapses.
 *
 * Receives `content` (possibly combined from multiple rapid-fire user messages) and
 * `message` (the LAST message in the batch, used for .reply() and channel/guild context).
 * Mirrors the original inline AI Support block: rate limit → redact → handleAISupport →
 * reply or escalate.
 */
async function processAISupport(content, message) {
  if (!OPENAI_API_KEY) return;
  if (!content) return;

  try {
    if (!checkRateLimit(message.channel.id)) {
      logger.info("Rate limit exceeded for thread:", message.channel.id);
      return;
    }

    const safeContent = redactGiftCardCodes(content);
    const aiResult = await handleAISupport(safeContent, message.channel);

    if (!aiResult) {
      logger.error("AI service returned null for thread:", message.channel.id);
      return;
    }

    const { answer, confidence, escalationReason } = aiResult;

    if (confidence >= 0.6) {
      if (await shouldSkipDuplicateReply(message.channel, answer)) {
        logger.info("Skipping duplicate reply — thread:", message.channel.id, "confidence:", confidence.toFixed(2));
        return;
      }
      await safeReply(message, answer);
      recordBotMessage(message.channel.id, answer);
      analytics.trackAIReply(message.channel.id, confidence);
      logger.info("AI reply sent — thread:", message.channel.id, "confidence:", confidence.toFixed(2));
    } else {
      const escalationMessage = `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.\n> 💡 Staff: reply \`!learn <answer>\` to teach me for next time.`;
      if (await shouldSkipDuplicateReply(message.channel, escalationMessage)) {
        logger.info("Skipping duplicate escalation — thread:", message.channel.id);
        return;
      }
      await safeReply(message, escalationMessage);
      recordBotMessage(message.channel.id, escalationMessage);
      analytics.trackEscalation(message.channel.id, escalationReason || 'low_confidence');
      logger.info("Escalated to human — thread:", message.channel.id, "confidence:", confidence.toFixed(2));
    }
  } catch (err) {
    logger.error("AI support error:", err?.message ?? err, "channel:", message.channel?.id, "message:", message.id);
    try {
      const escalationMessage = `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.\n> 💡 Staff: reply \`!learn <answer>\` to teach me for next time.`;
      if (await shouldSkipDuplicateReply(message.channel, escalationMessage)) {
        logger.info("Skipping duplicate fallback escalation — thread:", message.channel.id);
        return;
      }
      await safeReply(message, escalationMessage);
      recordBotMessage(message.channel.id, escalationMessage);
    } catch (replyErr) {
      logger.error("Failed to send escalation message:", replyErr?.message);
    }
  }
}

client.on("ready", async () => {
  logger.info(`Bot v${BOT_VERSION} prêt, guilds:`, client.guilds.cache.size);

  // Optionally pre-warm the docs embedding index on boot (otherwise lazy on first query)
  if (DOCS_EMBED_ON_BOOT) {
    ensureDocsIndex().catch((err) => {
      logger.error("[ready] ensureDocsIndex failed at boot:", err?.message);
    });
  }

  const payment = await client.channels.fetch(PAYMENT_CHANNEL_ID).catch(() => null);
  const tickets = await client.channels.fetch(TICKET_CHANNEL_ID).catch(() => null);
  logger.info(
    "Channel paiement:",
    payment ? PAYMENT_CHANNEL_ID : "introuvable",
    "| Channel tickets:",
    tickets ? TICKET_CHANNEL_ID : "introuvable"
  );

  // Register /price slash command
  if (CLIENT_ID) {
    try {
      const rest = new REST().setToken(BOT_TOKEN);
      const commands = [
        {
          name: "price",
          description: "Look up the price of a product",
          options: [
            {
              name: "product",
              description: "Product name to search (e.g. Stand GTA, 2take1 Lifetime)",
              type: 3, // STRING
              required: true,
            },
          ],
        },
        {
          name: "version",
          description: "Show the current running version of the bot",
        },
      ];
      const route = GUILD_ID
        ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
        : Routes.applicationCommands(CLIENT_ID);
      await rest.put(route, { body: commands });
      logger.info("/price command registered —", GUILD_ID ? `guild ${GUILD_ID}` : "global");
    } catch (err) {
      logger.error("Failed to register /price command:", err?.message);
    }
  } else {
    logger.info("CLIENT_ID not set — /price slash command not registered");
  }

  // Check every 15s for threads where creator hasn't replied after 1 min
  setInterval(async () => {
    const toPrompt = getThreadsToPrompt();
    for (const { threadId } of toPrompt) {
      try {
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (!thread || !thread.isThread()) continue;
        if (thread.archived || thread.locked) {
          stopTracking(threadId);
          continue;
        }
        if (thread.isThread()) {
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

    // Auto-close idle tickets
    for (const threadId of getThreadsToWarn(AUTO_CLOSE_HOURS)) {
      try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || thread.archived || thread.locked) {
          stopIdleTracking(threadId);
          continue;
        }
        await thread.send(`⚠️ This ticket has been inactive for ${AUTO_CLOSE_HOURS} hours. It will be automatically closed in 24 hours unless you reply.`);
        markWarningSent(threadId);
      } catch (err) {
        logger.error(`Auto-close warning failed for ${threadId}: ${err.message}`);
      }
    }

    for (const threadId of getThreadsToClose()) {
      try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || thread.archived) {
          stopIdleTracking(threadId);
          continue;
        }
        await thread.send('🔒 This ticket has been closed due to inactivity.');
        await thread.setArchived(true);
        stopIdleTracking(threadId);
      } catch (err) {
        logger.error(`Auto-close failed for ${threadId}: ${err.message}`);
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
  startIdleTracking(thread.id);
  analytics.trackTicketOpened(thread.id);
  logger.info("New ticket thread tracked:", thread.id, "ticket owner:", ticketOwnerId || "unknown");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "version") {
    await interaction.reply({ content: `🤖 Bot version: **v${BOT_VERSION}**`, ephemeral: true });
    return;
  }

  if (interaction.commandName !== "price") return;

  const query = interaction.options.getString("product");
  logger.info("/price command used by:", interaction.user.tag, "| query:", query);

  await interaction.deferReply();

  const results = searchPrices(query);

  if (results.length === 0) {
    await interaction.editReply(`No products found matching **${query}**. Try a different name (e.g. \`Stand GTA\`, \`2take1 Lifetime\`, \`Kernaim CS2\`).`);
    return;
  }

  const lines = results.map((p) => `• **${p.name}** — €${p.price.toFixed(2)}`);
  const response = `**Price results for "${query}":**\n${lines.join("\n")}`;
  await interaction.editReply(response);
  logger.info("/price reply sent —", results.length, "result(s) for query:", query);
});

client.on("messageCreate", async (message) => {
  // Handle ticket bot messages: detect custom inquiry and route to AI support
  if (TICKET_BOT_ID && message.author.id === TICKET_BOT_ID) {
    logger.info(
      "[TicketBot] Message received — author:", message.author.id,
      "| isThread:", message.channel.isThread(),
      "| parentId:", message.channel.parentId,
      "| expectedParent:", TICKET_CHANNEL_ID,
      "| hasContent:", !!message.content,
      "| embedCount:", message.embeds?.length ?? 0
    );

    if (message.content) {
      logger.info("[TicketBot] Content (first 300 chars):", JSON.stringify(message.content.slice(0, 300)));
    }
    for (const [i, embed] of (message.embeds ?? []).entries()) {
      logger.info(
        `[TicketBot] Embed[${i}] title:`, embed.title,
        "| description:", JSON.stringify(embed.description?.slice(0, 200)),
        "| fields:", JSON.stringify((embed.fields ?? []).map(f => ({ name: f.name, value: f.value?.slice(0, 100) })))
      );
    }

    if (!message.channel.isThread() || message.channel.parentId !== TICKET_CHANNEL_ID) {
      logger.info("[TicketBot] Skipping — not a ticket thread.");
      return;
    }
    if (!OPENAI_API_KEY) {
      logger.info("[TicketBot] Skipping — OPENAI_API_KEY not configured.");
      return;
    }

    const inquiry = extractTicketBotInquiry(message.content, message.embeds ?? []);
    if (!inquiry) {
      logger.info("[TicketBot] No inquiry found — likely a PayPal or non-inquiry message. Skipping.");
      return;
    }

    const threadId = message.channel.id;
    stopTracking(threadId);
    logger.info("[TicketBot] Inquiry extracted — thread:", threadId, "| inquiry:", inquiry.slice(0, 100));

    try {
      if (!checkRateLimit(threadId)) {
        logger.info("[TicketBot] Rate limit exceeded — thread:", threadId);
        return;
      }

      const safeInquiry = redactGiftCardCodes(inquiry);
      logger.info("[TicketBot] Calling AI support — thread:", threadId);

      const aiResult = await handleAISupport(safeInquiry, message.channel);
      if (!aiResult) {
        logger.error("[TicketBot] AI returned null — thread:", threadId);
        return;
      }

      const { answer, confidence, escalationReason } = aiResult;
      logger.info("[TicketBot] AI response — thread:", threadId, "| confidence:", confidence.toFixed(2), "| answer:", answer.slice(0, 100));

      const reply = confidence >= 0.6
        ? answer
        : `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.\n> 💡 Staff: reply \`!learn <answer>\` to teach me for next time.`;

      if (await shouldSkipDuplicateReply(message.channel, reply)) {
        logger.info("[TicketBot] Duplicate reply skipped — thread:", threadId);
        return;
      }

      await message.channel.send(reply);
      recordBotMessage(threadId, reply);

      if (confidence >= 0.6) {
        analytics.trackAIReply(threadId, confidence);
      } else {
        analytics.trackEscalation(threadId, escalationReason || 'low_confidence');
      }

      logger.info("[TicketBot] Reply sent — thread:", threadId, "| confidence:", confidence.toFixed(2));
    } catch (err) {
      logger.error("[TicketBot] Error handling inquiry:", err?.message, "| thread:", message.channel.id);
    }
    return;
  }

  if (message.author.bot) return;

  // Training-channel commands for staff: !rule, !rules, !rule-del
  // These run BEFORE the ticket-thread gate because the training channel is a normal channel,
  // not a ticket thread.
  if (
    TRAINING_CHANNEL_ID &&
    message.channel.id === TRAINING_CHANNEL_ID &&
    STAFF_ROLE_ID &&
    message.member?.roles?.cache?.has(STAFF_ROLE_ID) &&
    message.content
  ) {
    const text = message.content.trim();
    const lower = text.toLowerCase();

    // !rule <instruction>
    // The trailing space already excludes "!rule-del" and "!rules" (no space after "rule").
    if (lower.startsWith("!rule ")) {
      const ruleText = text.slice("!rule".length).trim();
      if (!ruleText) {
        const hint = await message.reply("Usage: `!rule <instruction>` — e.g. `!rule Always reply in Spanish when the user writes in Spanish.`");
        setTimeout(() => hint.delete().catch(() => {}), 8000);
        return;
      }
      try {
        const entry = appendRule(ruleText, message.author.id);
        try { await message.delete(); } catch (_) {}
        const confirm = await message.channel.send(`✅ Rule #${entry.id} saved: ${entry.rule}`);
        setTimeout(() => confirm.delete().catch(() => {}), 8000);
        logger.info("[!rule] Added rule #", entry.id, "by", message.author.tag);
      } catch (err) {
        logger.error("[!rule] Failed to save rule:", err?.message);
        await message.reply("Failed to save rule. Check bot logs.");
      }
      return;
    }

    // !rules — list all rules
    if (lower === "!rules") {
      try { await message.delete(); } catch (_) {}
      const rules = listRules();
      if (rules.length === 0) {
        const reply = await message.channel.send("📋 No staff rules defined yet. Use `!rule <instruction>` to add one.");
        setTimeout(() => reply.delete().catch(() => {}), 30000);
        return;
      }
      const lines = rules.map((r) => `**#${r.id}** ${r.rule}`).join("\n");
      const reply = await message.channel.send(`📋 **Staff rules (${rules.length}):**\n${lines}`);
      setTimeout(() => reply.delete().catch(() => {}), 30000);
      return;
    }

    // !rule-del <id>  (require exact token or trailing space to avoid matching "!rule-delete-everything")
    if (lower === "!rule-del" || lower.startsWith("!rule-del ")) {
      const idStr = text.slice("!rule-del".length).trim();
      const id = Number(idStr);
      if (!Number.isFinite(id) || id <= 0) {
        const hint = await message.reply("Usage: `!rule-del <id>` — get IDs with `!rules`.");
        setTimeout(() => hint.delete().catch(() => {}), 8000);
        return;
      }
      try {
        const removed = deleteRule(id);
        try { await message.delete(); } catch (_) {}
        const reply = await message.channel.send(removed ? `✅ Rule #${id} removed.` : `⚠️ Rule #${id} not found.`);
        setTimeout(() => reply.delete().catch(() => {}), 8000);
        if (removed) logger.info("[!rule-del] Removed rule #", id, "by", message.author.tag);
      } catch (err) {
        logger.error("[!rule-del] Failed to delete:", err?.message);
        await message.reply("Failed to delete rule. Check bot logs.");
      }
      return;
    }
  }

  if (!message.channel.isThread()) return;
  if (message.channel.parentId !== TICKET_CHANNEL_ID) return;

  const content = message.content;
  const threadId = message.channel.id;
  const isStaff = STAFF_ROLE_ID && message.member?.roles?.cache?.has(STAFF_ROLE_ID);

  // Notify inactivity tracker: creator or staff replied → stop tracking
  onMessageInThread(threadId, message.author.id, isStaff);
  recordActivity(message.channelId);

  // Handle staff commands: !pause, !mute, !resume (accept both "!bot mute" and "!bot-mute")
  if (isStaff && content) {
    // !version — report running bot version
    if (content.trim().toLowerCase() === "!version") {
      await message.reply(`🤖 Bot version: **v${BOT_VERSION}**`);
      return;
    }

    // !learn command: staff teaches the bot a new Q&A answer
    if (content.trim().toLowerCase().startsWith("!learn ")) {
      const learnedAnswer = content.trim().slice("!learn ".length).trim();
      if (!learnedAnswer) {
        await message.reply("Usage: `!learn <your answer here>`");
        return;
      }

      // Find the last non-bot, non-staff user message in this thread
      let userQuestion = null;
      try {
        const fetched = await message.channel.messages.fetch({ limit: 20 });
        const msgs = Array.from(fetched.values()).reverse();
        for (const m of msgs) {
          if (m.author.bot) continue;
          if (m.id === message.id) continue;
          const memberData = await message.guild.members.fetch(m.author.id).catch(() => null);
          const isMemberStaff = STAFF_ROLE_ID && memberData?.roles?.cache?.has(STAFF_ROLE_ID);
          if (!isMemberStaff) {
            userQuestion = redactGiftCardCodes(m.content || "");
            break;
          }
        }
      } catch (err) {
        logger.error("!learn: failed to fetch thread history:", err?.message);
      }

      if (!userQuestion) {
        await message.reply("Could not find the original customer question in this thread.");
        return;
      }

      const keywords = extractKeywords(userQuestion);

      try {
        appendLearnedEntry(userQuestion, learnedAnswer, keywords);
      } catch (err) {
        logger.error("!learn: failed to save entry:", err?.message);
        await message.reply("Failed to save to knowledge base. Check bot logs.");
        return;
      }

      analytics.trackLearnEvent(message.channelId);

      // Send the learned answer to the customer
      await message.channel.send(learnedAnswer);

      // Confirm to staff, then auto-delete the confirmation after 6 seconds
      const confirm = await message.reply(
        `✅ Saved to knowledge base.\nKeywords extracted: \`${keywords.length > 0 ? keywords.join(", ") : "none"}\``
      );
      setTimeout(() => confirm.delete().catch(() => {}), 6000);

      // Delete the !learn command to keep the thread clean
      try { await message.delete(); } catch (_) {}

      logger.info("!learn: new entry saved — thread:", threadId, "| question:", userQuestion.slice(0, 80), "| keywords:", keywords.join(", "));
      return;
    }

    // !bad command: staff replies to a bad bot message to correct it
    // Usage: right-click a bot message → Reply → type "!bad <correct answer>"
    if (content.trim().toLowerCase().startsWith("!bad")) {
      const correctAnswer = content.trim().slice("!bad".length).trim();

      if (!message.reference?.messageId) {
        const hint = await message.reply("Usage: reply directly to the bad bot message and type `!bad <correct answer>`.");
        setTimeout(() => hint.delete().catch(() => {}), 6000);
        try { await message.delete(); } catch (_) {}
        return;
      }

      if (!correctAnswer) {
        const hint = await message.reply("Usage: `!bad <correct answer>` — include the correct answer after `!bad`.");
        setTimeout(() => hint.delete().catch(() => {}), 6000);
        try { await message.delete(); } catch (_) {}
        return;
      }

      // Fetch the referenced (bad) message
      let badMsg = null;
      try {
        badMsg = await message.channel.messages.fetch(message.reference.messageId);
      } catch (err) {
        logger.error("!bad: failed to fetch referenced message:", err?.message);
      }

      if (!badMsg || badMsg.author.id !== client.user.id) {
        const hint = await message.reply("Could not find the bot message you replied to. Make sure you reply directly to a bot message.");
        setTimeout(() => hint.delete().catch(() => {}), 6000);
        try { await message.delete(); } catch (_) {}
        return;
      }

      // Find the user message that triggered the bad bot reply
      // Look for the first non-bot message sent before the bad bot reply
      let userQuestion = null;
      try {
        const fetched = await message.channel.messages.fetch({ limit: 50, before: badMsg.id });
        const msgs = Array.from(fetched.values()); // newest first
        for (const m of msgs) {
          if (m.author.bot) continue;
          const memberData = await message.guild.members.fetch(m.author.id).catch(() => null);
          const isMemberStaff = STAFF_ROLE_ID && memberData?.roles?.cache?.has(STAFF_ROLE_ID);
          if (!isMemberStaff) {
            userQuestion = redactGiftCardCodes(m.content || "");
            break;
          }
        }
      } catch (err) {
        logger.error("!bad: failed to fetch thread history:", err?.message);
      }

      // LLM-extract the core question so mentions/multi-topic rambling don't pollute the FAQ.
      // Falls back to the raw message on any failure so !bad never blocks on OpenAI.
      let cleanedQuestion = userQuestion;
      if (userQuestion) {
        try {
          const extracted = await extractCoreQuestion(userQuestion);
          if (extracted) cleanedQuestion = extracted;
        } catch (err) {
          logger.error("!bad: extractCoreQuestion failed:", err?.message);
        }
      }

      const keywords = extractKeywords(cleanedQuestion || correctAnswer);
      const questionForFAQ = cleanedQuestion || "Correction provided by staff";

      try {
        appendLearnedEntry(questionForFAQ, correctAnswer, keywords);
      } catch (err) {
        logger.error("!bad: failed to save entry:", err?.message);
        await message.reply("Failed to save to knowledge base. Check bot logs.");
        return;
      }

      analytics.trackLearnEvent(message.channelId);

      // Delete the bad bot reply
      try { await badMsg.delete(); } catch (_) {}

      // Send the correct answer to the thread
      await message.channel.send(correctAnswer);

      // Delete the !bad command
      try { await message.delete(); } catch (_) {}

      // Brief staff confirmation
      const confirm = await message.channel.send(
        `✅ Bad reply removed and correct answer saved to knowledge base.\nKeywords: \`${keywords.length > 0 ? keywords.join(", ") : "none"}\``
      );
      setTimeout(() => confirm.delete().catch(() => {}), 5000);

      logger.info("!bad: bad reply corrected — thread:", threadId, "| question:", questionForFAQ.slice(0, 80), "| keywords:", keywords.join(", "));
      return;
    }

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
    flushThreadBatches(threadId); // staff is taking over — drop any pending batched replies
    logger.info("Staff activity detected — thread paused:", threadId, "staff:", message.author.tag);
    return; // Staff replied → bot doesn't process this message
  }

  // Check if thread is paused (bot won't reply)
  if (isThreadPaused(threadId)) {
    flushBatch(threadId, message.author.id);
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
    // Drop any pending text batch for this user — the payment notification IS the response.
    flushBatch(threadId, message.author.id);
    return;
  }

  // Priority 2: AI Support — debounced via messageBatcher.
  // Rapid-fire user messages from the SAME user in the SAME thread are batched and processed
  // once after BATCH_WAIT_MS of silence (or BATCH_MAX_WAIT_MS hard ceiling).
  if (!OPENAI_API_KEY) {
    return;
  }

  try {
    enqueueMessage(message, processAISupport);
  } catch (err) {
    logger.error("messageBatcher.enqueueMessage threw — falling back to direct processing:", err?.message);
    // Defensive fallback: if the batcher itself fails, process inline so the user still gets a reply.
    await processAISupport(content, message);
  }
});

client.on('threadUpdate', async (oldThread, newThread) => {
  if (newThread.parentId !== TICKET_CHANNEL_ID) return;
  // Only act when a ticket thread gets archived
  if (!newThread.archived || oldThread.archived) return;

  // Stop idle tracking for this thread
  stopIdleTracking(newThread.id);

  if (!ANALYTICS_CHANNEL_ID) return;

  const data = analytics.flushTicketData(newThread.id);
  if (!data) return; // thread opened before bot started, no data

  try {
    const analyticsChannel = await client.channels.fetch(ANALYTICS_CHANNEL_ID);
    if (!analyticsChannel) return;
    const card = analytics.buildSummaryCard(newThread.name, data);
    await analyticsChannel.send(card);
  } catch (err) {
    logger.error(`Analytics card failed: ${err.message}`);
  }
});

client.login(BOT_TOKEN);
