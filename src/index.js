import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { loadConfig, BOT_TOKEN, PAYMENT_CHANNEL_ID, AMAZON_ROLE_ID, TICKET_CHANNEL_ID } from "./config.js";
import { hasAmazonGiftCard } from "./services/detection.js";
import { sendPaymentNotification } from "./services/notification.js";
import { redactGiftCardCodes } from "./utils/redact.js";
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
  if (!content) return;

  if (!hasAmazonGiftCard(content)) return;

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
});

client.login(BOT_TOKEN);
