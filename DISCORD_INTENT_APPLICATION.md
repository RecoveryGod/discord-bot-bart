# Discord Privileged Intent Application — Draft Answers

> Rédigé en anglais : l'équipe de review Discord travaille en anglais.
> Chaque réponse est vérifiée contre le code réel. Ne soumets rien que tu n'aies relu.

## Pourquoi cette demande est obligatoire

Depuis le 10 juin 2026, le seuil de review des Privileged Intents n'est plus le
nombre de serveurs mais le nombre d'**utilisateurs uniques atteignables** par l'app,
avec un plafond de **10 000**. Relevé via l'API Discord :

| Serveur | Membres |
|---|---|
| RG DarkSide | 11 235 |
| RG Template | 6 |

Au-dessus du seuil → la demande doit être soumise, les toggles seuls ne suffisent pas.

---

## Détails de l'application

**Que fait ton application ?**

```
EldroMods Support is a private, single-server customer support automation bot.
It operates exclusively inside support ticket threads on our own Discord server.

What it does:

1. TICKET TRIAGE — When a customer opens a support ticket, the bot reads the
   customer's question and attempts to answer it automatically from a curated
   internal knowledge base of frequently asked questions (order status, license
   key activation, payment verification, product availability, pricing).

2. AUTOMATED FIRST-LINE ANSWERS — The bot sends the customer's question to the
   OpenAI API to generate a support reply grounded in our knowledge base. If the
   model reports low confidence, the bot does not answer and instead pings our
   human support team.

3. PRICE LOOKUP — A /price slash command lets customers and staff look up the
   current price of a product from an internal price list.

4. STAFF TRAINING COMMANDS — Support staff can type !learn <answer> or
   !bad <answer> inside a ticket to teach the bot the correct response, which is
   saved to the internal knowledge base for future tickets. Staff can also pause
   or mute the bot in a thread (!pause, !mute, !resume) when they take over.

5. INACTIVITY HANDLING — If a customer opens a ticket and does not describe their
   issue, the bot posts one follow-up prompt. Tickets with no activity are flagged
   for closure.

The bot does not operate in public channels, does not send DMs, does not moderate,
and is not listed publicly. It is installed on one server only.
```

**As-tu une Politique de Confidentialité publique ?**

> ⚠️ À VÉRIFIER — réponds "Oui" **uniquement** si une politique de confidentialité est
> réellement en ligne et accessible publiquement (ex. https://eldromods.com/privacy).
> Si elle n'existe pas, il faut la publier avant de soumettre. Elle doit mentionner :
> les messages des tickets sont traités par l'API OpenAI, les paires question/réponse
> validées par le staff sont conservées sur nos serveurs, la durée de conservation,
> et un contact pour demander la suppression.

---

## Privileged Gateway Intents demandés

- [x] **Server Members Intent**
- [ ] Presence Intent — *non demandé, le bot n'utilise aucune donnée de présence*
- [x] **Message Content Intent**

---

## Server Members Intent

**Pourquoi as-tu besoin du Guild Members Intent ?**

```
We need it for two ticket-handling features:

1. IDENTIFYING THE CUSTOMER IN A TICKET THREAD
   Our tickets are threads created by a third-party ticket bot. The thread owner is
   the ticket bot, not the customer. To know which human actually opened the ticket,
   we list the thread's members and select the first non-bot member. This uses the
   "List Thread Members" endpoint, which Discord restricts to applications with the
   Guild Members intent enabled.

   We use this to @mention the correct customer when a ticket has been idle and we
   need to ask them to describe their issue, and again before a ticket is
   auto-closed for inactivity. Without it we cannot tell who to notify, and
   customers get closed tickets with no warning.

2. DISTINGUISHING STAFF FROM CUSTOMERS
   We fetch a message author's guild member object to read their roles and check
   whether they hold our support staff role. This drives core behaviour:
   - the bot must never auto-reply on top of a human agent, so it pauses itself
     for 5 minutes whenever a staff member speaks in a ticket;
   - the training commands (!learn, !bad, !rule, !pause, !mute, !resume) are
     restricted to staff and must be ignored when a customer types them.

We do not build a member cache, we do not scrape or enumerate the server's member
list, we do not track joins or leaves, and we do not store member data. Lookups are
per-ticket and the results are used immediately and discarded.
```

**Conserves-tu des données d'API hors plateforme (Server Members) ?**

```
Non / No
```

> Vérifié : aucune donnée de membre n'est écrite sur disque. Les rôles sont lus en
> mémoire pour un test staff/non-staff puis jetés.

---

## Message Content Intent

**Pourquoi as-tu besoin du Message Content Intent ?**

```
The bot's entire purpose is reading the text of support requests, so message content
is essential rather than incidental.

1. UNDERSTANDING THE SUPPORT REQUEST
   We read the customer's message inside a ticket thread to match it against our
   internal FAQ and generate an answer. Without message content there is nothing to
   answer.

2. READING THE TICKET FORM
   Our ticket bot posts the customer's stated issue inside an embed. We parse that
   embed to extract the question and start working on it immediately.

3. STAFF COMMANDS
   Staff type text commands inside tickets (!learn, !bad, !pause, !mute, !resume) to
   correct the bot or take over a conversation. These are plain messages and require
   message content to detect.

4. PAYMENT VERIFICATION ROUTING
   When a customer posts a gift card payment in a ticket, we detect it and notify our
   payment verification team so a human can process it. Codes are redacted before
   being logged or sent anywhere.

Scope limits: the bot only reads messages inside ticket threads under one specific
support channel, on one server. It ignores every other channel, ignores DMs, and
ignores other bots except our own ticket bot.
```

**Les utilisateurs peuvent-ils choisir de ne pas faire suivre leurs données de Message Content ?**

```
Non / No
```

> ⚠️ Réponse honnête : aucun mécanisme d'opt-out n'existe dans le code aujourd'hui.
> Le seul contrôle utilisateur est de ne pas ouvrir de ticket. Si tu veux répondre
> "Oui", il faut d'abord implémenter un vrai opt-out (ex. une commande qui exclut
> l'utilisateur du traitement IA et passe directement au staff humain).
> Je peux l'implémenter si tu veux — c'est un ajout raisonnable.

**Stockes-tu des données de contenu de message hors plateforme ?**

```
Oui / Yes
```

Explication à fournir :

```
Two forms of off-platform handling, both limited:

1. PROCESSING (transient) — The text of a support question is sent to the OpenAI API
   to generate a reply. We are an API customer; this data is not used by OpenAI to
   train their models. Gift card codes are redacted before transmission. We do not
   retain these requests ourselves.

2. STORAGE (deliberate, staff-curated) — When a support agent uses !learn or !bad to
   correct the bot, the customer's question and the agent's approved answer are saved
   as a FAQ entry in a JSON file on our own private server, so the bot answers
   correctly next time. This is a deliberate staff action on individual entries, not
   bulk logging. No user IDs, usernames, or message IDs are stored with the entry —
   only the question text and the staff-written answer.

We do not log or archive general message traffic. Per-ticket counters (number of
replies, whether it escalated) are kept in memory only and discarded when the ticket
closes.
```

**Les données de contenu de message seront-elles utilisées pour du machine learning ou pour entraîner une IA ?**

```
Non / No
```

> Réponse correcte et conforme. Developer Policy clause #21 : "Do not use message
> content obtained through the APIs to train machine learning or AI models (including
> large language models) unless express permission is granted by Discord."
> Le bot fait de l'**inférence**, pas de l'entraînement — aucun poids de modèle n'est
> modifié. Répondre "Oui" reviendrait à déclarer une violation de cette clause.
>
> Si un champ de texte libre est disponible, ou dans la réponse au Message Content
> Intent, ajoute cette précision pour être transparent sur l'usage d'OpenAI :

```
We do not train, fine-tune, or otherwise improve any machine learning or AI model
using Discord message content, in line with Developer Policy #21.

For transparency about how AI is involved: support questions are sent to OpenAI's
API at request time to generate a single reply (inference only). No model weights are
created or modified, and as an API customer our data is not used by OpenAI for model
training. Staff-approved question/answer pairs are stored as plain text and retrieved
by keyword and similarity search to give the model relevant context — this is a
lookup table, not training data, and deleting an entry removes its effect
immediately.
```

---

## Captures d'écran / vidéos à fournir

Discord exige des preuves visuelles **par intent**. À capturer sur ton serveur :

**Pour Message Content Intent**
1. Un ticket où un client pose une question et le bot répond avec l'info FAQ
2. Un ticket où le bot escalade (faible confiance) et ping le staff
3. Un agent tapant `!learn <réponse>` et le bot confirmant l'apprentissage

**Pour Server Members Intent**
4. Un ticket inactif où le bot @mentionne le bon client pour lui demander de préciser
   — c'est la preuve directe de l'usage de `List Thread Members`
5. Un agent tapant `!pause` et le bot confirmant — montre le contrôle par rôle staff
6. Un non-staff tapant la même commande et le bot l'ignorant — montre le test de rôle

Héberge-les sur un lien public stable (Imgur, Streamable, YouTube non répertorié).
Discord rejette régulièrement les demandes sans preuve visuelle.

---

## À faire avant de soumettre

- [ ] Publier une politique de confidentialité si elle n'existe pas
- [ ] Capturer les 6 preuves visuelles ci-dessus
- [ ] Décider pour l'opt-out : répondre "Non" honnêtement, ou l'implémenter d'abord
- [ ] Ajouter `GatewayIntentBits.GuildMembers` dans `src/index.js` une fois approuvé
      (actuellement absent — la mention d'inactivité échoue en silence)
