import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { loadConfig, BOT_TOKEN, PAYMENT_CHANNEL_ID, AMAZON_ROLE_ID, TICKET_CHANNEL_ID, OPENAI_API_KEY, STAFF_ROLE_ID, TICKET_BOT_ID, CLIENT_ID, GUILD_ID, ANALYTICS_CHANNEL_ID, AUTO_CLOSE_HOURS, TRAINING_CHANNEL_ID, DOCS_EMBED_ON_BOOT, BOT_VERSION } from "./config.js";
import { sendPaymentNotification } from "./services/notification.js";
import { redactGiftCardCodes } from "./utils/redact.js";
import { checkRateLimit } from "./services/rateLimiter.js";
import { handleAISupport } from "./services/aiService.js";
import { updateStaffActivity, isThreadPaused, pauseThread, pauseThreadIndefinitely, resumeThread } from "./services/staffActivity.js";
import { shouldSkipDuplicateReply, recordBotMessage } from "./services/messageDeduplication.js";
import { trackThread, onMessageInThread, getThreadsToPrompt, markAsAsked, stopTracking, startIdleTracking, recordActivity, stopIdleTracking, getThreadsToWarn, getThreadsToClose, markWarningSent } from "./services/threadInactivity.js";
import {
  searchCatalogue,
  startCatalogueRefresh,
  getCatalogueMeta,
  hasCatalogue,
} from "./services/catalogueService.js";
import { appendLearnedEntry } from "./services/knowledgeBase.js";
import { extractCoreQuestion } from "./services/questionExtractor.js";
import {
  recordUserMessage,
  recordBotAnswer,
  getHistory,
  getLastUserQuestion,
  getLastAnswerId,
  clearThread,
} from "./services/conversationLog.js";
import { appendRule, deleteRule, listRules } from "./services/rulesService.js";
import { ensureDocsIndex } from "./services/docsService.js";
import { extractKeywords } from "./utils/keywords.js";
import * as analytics from "./services/analyticsService.js";
import * as logger from "./utils/logger.js";

loadConfig();

const ESCALATION_MESSAGE = `<@&${AMAZON_ROLE_ID}> A human agent will assist you shortly.\n> 💡 Staff: use \`/learn <answer>\` to teach me for next time.`;

// Shown when a customer types a plain message the bot cannot read (no Message Content intent).
const NUDGE_MESSAGE =
  "I can't read messages directly — click the button below or use `/ask <your question>` and I'll answer right away.";

// No privileged intents. Guilds + GuildMessages are non-privileged: the bot still
// receives message events (author, member, roles, timestamps) but NOT their text.
// All content reaches the bot through interactions — slash commands and modals.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

const INACTIVITY_PROMPT_MESSAGE =
  "Could you please specify why you opened this ticket? This will help us assist you.";

/**
 * Extracts the user's custom inquiry from a tickets.bot message.
 * Checks both plain text content and embed fields/description.
 * Returns the inquiry string, or null if not found.
 *
 * DORMANT: automatic ticket triage requires the Message Content intent — without it the
 * ticket bot's embeds arrive empty, so nothing calls this. Kept intact (together with
 * TICKET_BOT_ID) so auto-triage can be restored by re-enabling the intent and re-adding
 * the ticket-bot branch to the messageCreate handler.
 */
// eslint-disable-next-line no-unused-vars
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

/** True when the channel is a thread under the configured ticket channel. */
function isTicketThread(channel) {
  return Boolean(channel?.isThread?.() && channel.parentId === TICKET_CHANNEL_ID);
}

/** True when the interaction author holds the staff role. */
function isStaffInteraction(interaction) {
  return Boolean(STAFF_ROLE_ID && interaction.member?.roles?.cache?.has(STAFF_ROLE_ID));
}

/** Ephemeral reply helper — keeps command noise out of the customer's ticket. */
function ephemeral(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// Single source of truth for what customers are told they can do — shown in the ticket
// welcome message and again by /help. Staff-only commands are deliberately absent.
const CUSTOMER_HELP =
  "**Ask me anything**\n" +
  "Click the button below, or type `/ask <your question>`\n" +
  "*Example: `/ask my license key is not working`*\n\n" +
  "**Other commands**\n" +
  "`/price <product>` — check a product's price\n" +
  "`/help` — show this list again";

/** The "Ask a question" button that opens the question modal. */
function buildAskButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ask_open")
      .setLabel("Ask a question")
      .setEmoji("❓")
      .setStyle(ButtonStyle.Primary)
  );
}

/** The welcome message posted when a ticket opens, with the "ask a question" button. */
function buildWelcomeMessage() {
  return {
    content:
      "👋 **Welcome!** I can answer most questions instantly.\n\n" +
      CUSTOMER_HELP +
      "\n\nIf I can't answer, a human agent takes over automatically.",
    components: [buildAskButton()],
  };
}

/**
 * AI Support runner — the single entry point for every customer question.
 *
 * Reached from /ask and from the modal opened by the welcome button. Both carry the
 * question text in the interaction payload, so no message content intent is needed.
 * Guards run before deferring so refusals stay ephemeral; the answer itself is public
 * in the thread so staff can see what the bot told the customer.
 */
async function runAISupport(interaction, question) {
  const threadId = interaction.channelId;

  if (!isTicketThread(interaction.channel)) {
    return ephemeral(interaction, "This command only works inside a support ticket.");
  }
  if (!OPENAI_API_KEY) {
    return ephemeral(interaction, "AI support is not configured. A human agent will assist you.");
  }
  if (isThreadPaused(threadId)) {
    return ephemeral(interaction, "A human agent is handling this ticket — they will reply shortly.");
  }
  if (!checkRateLimit(threadId)) {
    return ephemeral(interaction, "Too many requests. Please wait a moment before asking again.");
  }

  await interaction.deferReply();

  const safeQuestion = redactGiftCardCodes(question);
  recordUserMessage(threadId, safeQuestion);
  stopTracking(threadId); // customer described their issue → no inactivity prompt needed
  recordActivity(threadId);

  try {
    const aiResult = await handleAISupport(safeQuestion, { history: getHistory(threadId) });

    const { answer, confidence, escalationReason } = aiResult ?? {};
    const usable = aiResult && confidence >= 0.6;
    const reply = usable ? answer : ESCALATION_MESSAGE;

    const sent = await interaction.editReply(reply);
    recordBotAnswer(threadId, reply, sent?.id ?? null);

    if (usable) {
      analytics.trackAIReply(threadId, confidence);
    } else {
      analytics.trackEscalation(threadId, escalationReason || (aiResult ? "low_confidence" : "ai_null"));
    }

    logger.info(
      "AI reply sent — thread:", threadId,
      "| confidence:", aiResult ? confidence.toFixed(2) : "n/a",
      "| asked by:", interaction.user.tag
    );
  } catch (err) {
    logger.error("AI support error:", err?.message ?? err, "| thread:", threadId);
    try {
      await interaction.editReply(ESCALATION_MESSAGE);
      recordBotAnswer(threadId, ESCALATION_MESSAGE);
    } catch (replyErr) {
      logger.error("Failed to send escalation message:", replyErr?.message);
    }
  }
}

client.on("ready", async () => {
  logger.info(`Bot v${BOT_VERSION} prêt, guilds:`, client.guilds.cache.size);

  // Load the catalogue from disk, refresh it now, then keep it fresh in the background.
  startCatalogueRefresh();

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
      const STRING = 3;
      const INTEGER = 4;
      const commands = [
        // --- Customer commands ---
        {
          name: "ask",
          description: "Ask a support question and get an answer right away",
          options: [
            {
              name: "question",
              description: "Describe your issue or question",
              type: STRING,
              required: true,
            },
          ],
        },
        {
          name: "price",
          description: "Look up the price of a product",
          options: [
            {
              name: "product",
              description: "Product name to search (e.g. Stand GTA, 2take1 Lifetime)",
              type: STRING,
              required: true,
            },
          ],
        },
        {
          name: "payment",
          description: "Submit a gift card code for manual verification by staff",
          options: [
            {
              name: "code",
              description: "Your gift card code — only staff will see it",
              type: STRING,
              required: true,
            },
          ],
        },
        {
          name: "help",
          description: "Show what I can help you with",
        },
        {
          name: "version",
          description: "Show the current running version of the bot",
        },
        // --- Staff commands (role-checked at runtime) ---
        {
          name: "learn",
          description: "[Staff] Teach the bot the answer to the customer's last question",
          options: [
            { name: "answer", description: "The correct answer to send and save", type: STRING, required: true },
          ],
        },
        {
          name: "bad",
          description: "[Staff] Delete the bot's last answer and replace it with the correct one",
          options: [
            { name: "answer", description: "The correct answer to send and save", type: STRING, required: true },
          ],
        },
        { name: "pause", description: "[Staff] Pause bot replies in this ticket for 5 minutes" },
        { name: "mute", description: "[Staff] Mute the bot in this ticket until /resume" },
        { name: "resume", description: "[Staff] Resume bot replies in this ticket" },
        {
          name: "rule",
          description: "[Staff] Add a behaviour rule applied to every AI reply",
          options: [
            { name: "instruction", description: "e.g. Always reply in Spanish when the user writes Spanish", type: STRING, required: true },
          ],
        },
        {
          name: "stock",
          description: "[Staff] Check how many keys are left for a product",
          options: [
            { name: "product", description: "Product name to look up", type: STRING, required: true },
          ],
        },
        { name: "rules", description: "[Staff] List all behaviour rules" },
        {
          name: "rule-del",
          description: "[Staff] Delete a behaviour rule by id",
          options: [
            { name: "id", description: "Rule id (get it with /rules)", type: INTEGER, required: true },
          ],
        },
      ];
      const route = GUILD_ID
        ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
        : Routes.applicationCommands(CLIENT_ID);
      await rest.put(route, { body: commands });
      logger.info(commands.length, "slash commands registered —", GUILD_ID ? `guild ${GUILD_ID}` : "global");
    } catch (err) {
      logger.error("Failed to register slash commands:", err?.message);
    }
  } else {
    logger.info("CLIENT_ID not set — slash commands not registered");
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
  // The ticket owner can no longer be resolved at creation time — listing thread members
  // requires the Server Members intent. onMessageInThread() already treats a null owner as
  // "any human message counts as the customer replying", which is the behaviour we want.
  trackThread(thread.id, null);
  startIdleTracking(thread.id);
  analytics.trackTicketOpened(thread.id);

  // Post the welcome message with the "Ask a question" button. This is now the customer's
  // way in: the bot cannot read their messages, so they must reach it via an interaction.
  try {
    await thread.send(buildWelcomeMessage());
  } catch (err) {
    logger.error("Failed to post welcome message — thread:", thread.id, "|", err?.message);
  }

  logger.info("New ticket thread tracked:", thread.id);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // --- Welcome button → open the question modal ---
    if (interaction.isButton() && interaction.customId === "ask_open") {
      const input = new TextInputBuilder()
        .setCustomId("ask_input")
        .setLabel("What do you need help with?")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Order, license activation, payment, product question…")
        .setRequired(true)
        .setMaxLength(1000);

      const modal = new ModalBuilder()
        .setCustomId("ask_modal")
        .setTitle("Ask a question")
        .addComponents(new ActionRowBuilder().addComponents(input));

      await interaction.showModal(modal);
      return;
    }

    // --- Modal submitted → same AI path as /ask ---
    if (interaction.isModalSubmit() && interaction.customId === "ask_modal") {
      await runAISupport(interaction, interaction.fields.getTextInputValue("ask_input"));
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    const threadId = interaction.channelId;

    // ================= Customer commands =================

    if (name === "help") {
      return interaction.reply({
        content: CUSTOMER_HELP,
        components: [buildAskButton()],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (name === "version") {
      return ephemeral(interaction, `🤖 Bot version: **v${BOT_VERSION}**`);
    }

    if (name === "ask") {
      logger.info("/ask by:", interaction.user.tag, "| thread:", threadId);
      return runAISupport(interaction, interaction.options.getString("question"));
    }

    if (name === "price") {
      const query = interaction.options.getString("product");
      logger.info("/price by:", interaction.user.tag, "| query:", query);
      await interaction.deferReply();

      if (!hasCatalogue()) {
        return interaction.editReply("The product catalogue is temporarily unavailable. A human agent will help you shortly.");
      }

      const results = searchCatalogue(query);
      if (results.length === 0) {
        return interaction.editReply(
          `No products found matching **${query}**. Try a different name (e.g. \`Stand GTA\`, \`MemeSense CS2\`, \`Kernaim\`).`
        );
      }
      // Customers see prices only — stock is staff-only, via /stock.
      const lines = results.map((p) => `• **${p.name}** — €${p.price.toFixed(2)}`);
      await interaction.editReply(`**Price results for "${query}":**\n${lines.join("\n")}`);
      logger.info("/price reply sent —", results.length, "result(s)");
      return;
    }

    if (name === "payment") {
      if (!isTicketThread(interaction.channel)) {
        return ephemeral(interaction, "Please use this inside your support ticket.");
      }
      const code = interaction.options.getString("code");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // The code goes into the thread, not into the notification: notification.js
      // requires the excerpt it receives to stay redacted. Staff read the code here.
      const posted = await interaction.channel
        .send(`💳 Payment submitted by <@${interaction.user.id}>:\n\`\`\`\n${code}\n\`\`\``)
        .catch((err) => {
          logger.error("/payment: failed to post code in thread:", err?.message);
          return null;
        });

      if (!posted) {
        return interaction.editReply("Could not submit your payment. Please post the code in this ticket and staff will handle it.");
      }

      try {
        const paymentChannel = await interaction.guild.channels.fetch(PAYMENT_CHANNEL_ID);
        if (paymentChannel) {
          await sendPaymentNotification({
            paymentChannel,
            threadLink: `https://discord.com/channels/${interaction.guildId}/${threadId}`,
            authorTag: interaction.user.tag,
            excerptRedacted: redactGiftCardCodes(code),
            roleId: AMAZON_ROLE_ID,
            timestampDiscord: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          });
        } else {
          logger.error("/payment: payment channel not found:", PAYMENT_CHANNEL_ID);
        }
      } catch (err) {
        logger.error("/payment: notification failed:", err?.message);
      }

      recordActivity(threadId);
      stopTracking(threadId);
      await interaction.editReply("✅ Sent to staff for manual verification. Please wait — they will confirm shortly.");
      logger.info("/payment submitted — thread:", threadId, "| user:", interaction.user.tag);
      return;
    }

    // ================= Staff commands =================

    const STAFF_COMMANDS = ["learn", "bad", "stock", "pause", "mute", "resume", "rule", "rules", "rule-del"];
    if (STAFF_COMMANDS.includes(name) && !isStaffInteraction(interaction)) {
      return ephemeral(interaction, "This command is restricted to support staff.");
    }

    if (name === "stock") {
      const query = interaction.options.getString("product");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!hasCatalogue()) {
        const meta = getCatalogueMeta();
        return interaction.editReply(`Catalogue unavailable${meta.lastError ? ` — last error: ${meta.lastError}` : ""}.`);
      }

      const results = searchCatalogue(query);
      if (results.length === 0) {
        return interaction.editReply(`No products found matching **${query}**.`);
      }

      const lines = results.map((p) =>
        `• **${p.name}** — €${p.price.toFixed(2)} · ${p.stock > 0 ? `**${p.stock}** key(s)` : "**out of stock**"}`
      );
      const meta = getCatalogueMeta();
      await interaction.editReply(
        `**Stock for "${query}":**\n${lines.join("\n")}\n\n*Catalogue generated ${meta.generatedAt ?? "?"}*`
      );
      logger.info("/stock by:", interaction.user.tag, "| query:", query, "|", results.length, "result(s)");
      return;
    }

    if (name === "learn" || name === "bad") {
      if (!isTicketThread(interaction.channel)) {
        return ephemeral(interaction, "Use this inside a ticket thread.");
      }
      const answer = interaction.options.getString("answer");
      const lastQuestion = getLastUserQuestion(threadId);

      if (!lastQuestion) {
        return ephemeral(
          interaction,
          "No customer question recorded in this ticket yet — the customer must ask via the button or `/ask` first."
        );
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // /bad additionally removes the bot's last (incorrect) answer, and cleans up the
      // question with the LLM so mentions and rambling don't pollute FAQ keywords.
      let questionForFAQ = lastQuestion;
      if (name === "bad") {
        const badId = getLastAnswerId(threadId);
        if (badId) {
          try {
            const badMsg = await interaction.channel.messages.fetch(badId);
            await badMsg.delete();
          } catch (err) {
            logger.info("/bad: could not delete previous answer:", err?.message);
          }
        }
        try {
          const extracted = await extractCoreQuestion(lastQuestion);
          if (extracted) questionForFAQ = extracted;
        } catch (err) {
          logger.error("/bad: extractCoreQuestion failed:", err?.message);
        }
      }

      const keywords = extractKeywords(questionForFAQ);
      try {
        appendLearnedEntry(questionForFAQ, answer, keywords);
      } catch (err) {
        logger.error(`/${name}: failed to save entry:`, err?.message);
        return interaction.editReply("Failed to save to knowledge base. Check bot logs.");
      }

      analytics.trackLearnEvent(threadId);

      const sent = await interaction.channel.send(answer).catch((err) => {
        logger.error(`/${name}: failed to send answer:`, err?.message);
        return null;
      });
      recordBotAnswer(threadId, answer, sent?.id ?? null);

      await interaction.editReply(
        `✅ Saved to knowledge base.\nQuestion: \`${questionForFAQ.slice(0, 120)}\`\nKeywords: \`${keywords.join(", ") || "none"}\``
      );
      logger.info(`/${name} saved — thread:`, threadId, "| by:", interaction.user.tag, "| keywords:", keywords.join(", "));
      return;
    }

    if (name === "pause" || name === "mute" || name === "resume") {
      if (!isTicketThread(interaction.channel)) {
        return ephemeral(interaction, "Use this inside a ticket thread.");
      }
      if (name === "pause") {
        pauseThread(threadId);
        logger.info("Thread paused by staff:", threadId, "|", interaction.user.tag);
        return ephemeral(interaction, "✅ Bot paused for this ticket. Auto-resumes after 5 minutes.");
      }
      if (name === "mute") {
        pauseThreadIndefinitely(threadId);
        logger.info("Thread muted by staff:", threadId, "|", interaction.user.tag);
        return ephemeral(interaction, "✅ Bot muted for this ticket until you use **/resume**.");
      }
      resumeThread(threadId);
      logger.info("Thread resumed by staff:", threadId, "|", interaction.user.tag);
      return ephemeral(interaction, "✅ Bot replies resumed for this ticket.");
    }

    if (name === "rule" || name === "rules" || name === "rule-del") {
      if (!TRAINING_CHANNEL_ID) {
        return ephemeral(interaction, "TRAINING_CHANNEL_ID is not configured — rule commands are disabled.");
      }
      if (interaction.channelId !== TRAINING_CHANNEL_ID) {
        return ephemeral(interaction, `Rule commands only work in <#${TRAINING_CHANNEL_ID}>.`);
      }

      if (name === "rule") {
        const instruction = interaction.options.getString("instruction");
        try {
          const entry = appendRule(instruction, interaction.user.id);
          logger.info("/rule added #", entry.id, "by", interaction.user.tag);
          return ephemeral(interaction, `✅ Rule #${entry.id} saved: ${entry.rule}`);
        } catch (err) {
          logger.error("/rule failed:", err?.message);
          return ephemeral(interaction, "Failed to save rule. Check bot logs.");
        }
      }

      if (name === "rules") {
        const rules = listRules();
        if (rules.length === 0) {
          return ephemeral(interaction, "📋 No staff rules defined yet. Use `/rule` to add one.");
        }
        const lines = rules.map((r) => `**#${r.id}** ${r.rule}`).join("\n");
        return ephemeral(interaction, `📋 **Staff rules (${rules.length}):**\n${lines}`.slice(0, 1900));
      }

      const id = interaction.options.getInteger("id");
      try {
        const removed = deleteRule(id);
        if (removed) logger.info("/rule-del removed #", id, "by", interaction.user.tag);
        return ephemeral(interaction, removed ? `✅ Rule #${id} removed.` : `⚠️ Rule #${id} not found.`);
      } catch (err) {
        logger.error("/rule-del failed:", err?.message);
        return ephemeral(interaction, "Failed to delete rule. Check bot logs.");
      }
    }
  } catch (err) {
    logger.error("interactionCreate error:", err?.message ?? err, "| command:", interaction.commandName ?? interaction.customId);
    // Surface something to the user rather than leaving the interaction hanging
    try {
      if (interaction.deferred) await interaction.editReply("Something went wrong. A human agent will assist you.");
      else if (!interaction.replied) await ephemeral(interaction, "Something went wrong. Please try again.");
    } catch (_) {}
  }
});

// Message events still arrive without the Message Content intent: the text is empty, but
// author, member and roles are present. That is enough to keep inactivity tracking and the
// staff auto-pause working. Everything text-based moved to slash commands and the modal.
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!isTicketThread(message.channel)) return;

  const threadId = message.channel.id;
  const isStaff = STAFF_ROLE_ID && message.member?.roles?.cache?.has(STAFF_ROLE_ID);

  onMessageInThread(threadId, message.author.id, isStaff);
  recordActivity(threadId);

  // Staff replied → pause the bot so it never talks over a human agent
  if (isStaff) {
    updateStaffActivity(threadId);
    logger.info("Staff activity detected — thread paused:", threadId, "| staff:", message.author.tag);
    return;
  }

  // A customer typed a normal message. The bot cannot read it, so rather than leaving them
  // in silence, point them at the button. shouldSkipDuplicateReply caps this at one nudge
  // per thread per 2-minute window so it never turns into spam.
  if (isThreadPaused(threadId)) return;

  try {
    if (await shouldSkipDuplicateReply(message.channel, NUDGE_MESSAGE)) return;
    await message.channel.send({ ...buildWelcomeMessage(), content: NUDGE_MESSAGE });
    recordBotMessage(threadId, NUDGE_MESSAGE);
    logger.info("Ask-nudge sent — thread:", threadId, "| user:", message.author.tag);
  } catch (err) {
    logger.error("Failed to send ask-nudge — thread:", threadId, "|", err?.message);
  }
});

client.on('threadUpdate', async (oldThread, newThread) => {
  if (newThread.parentId !== TICKET_CHANNEL_ID) return;
  // Only act when a ticket thread gets archived
  if (!newThread.archived || oldThread.archived) return;

  // Stop idle tracking and drop the conversation log for this thread
  stopIdleTracking(newThread.id);
  clearThread(newThread.id);

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
