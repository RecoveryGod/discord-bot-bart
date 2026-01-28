/**
 * Sends a payment notification to the given channel.
 * excerptRedacted must never contain the full gift card code.
 */
export async function sendPaymentNotification({
  paymentChannel,
  threadLink,
  authorTag,
  excerptRedacted,
  roleId,
  timestampDiscord,
}) {
  const body = `🚨 **Amazon Gift Card détectée**
<@&${roleId}>
🧵 Ticket : ${threadLink}
👤 Utilisateur : ${authorTag}
⏰ Heure : ${timestampDiscord}
💬 Message :
> ${excerptRedacted}`;

  await paymentChannel.send(body);
}
