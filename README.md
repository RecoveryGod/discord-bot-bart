# Discord Bot Bart

Bot Discord (Node.js, discord.js v14) pour un serveur de support : détection des Amazon Gift Cards, support automatisé par IA (FAQ + OpenAI), et gestion des tickets (pause staff, rappel d’inactivité).

---

## Table des matières

- [Fonctionnalités](#fonctionnalités)
- [Stack & structure](#stack--structure)
- [Configuration](#configuration)
- [Lancer le bot](#lancer-le-bot)
- [Flux de traitement des messages](#flux-de-traitement-des-messages)
- [Guide pour agents IA](#guide-pour-agents-ia)

---

## Fonctionnalités

| Fonctionnalité | Description |
|----------------|-------------|
| **Détection Gift Card** | Dans les threads du channel tickets : si un message contient un code ou des mots-clés Amazon, envoi d’une notification dans le channel paiement avec mention du rôle, lien vers le thread, auteur. Les codes ne sont jamais republiés (redaction). |
| **Support IA** | Pour les autres messages (hors gift card) : recherche dans une FAQ locale, appel OpenAI (gpt-4o-mini) avec contexte. Si confiance ≥ 0.6 → réponse auto ; sinon → mention du rôle + « A human agent will assist you shortly ». Rate limit : 5 réponses IA par thread/heure. |
| **Pause staff** | Si un membre avec le rôle staff envoie un message dans un thread, le bot arrête de répondre. Réactivation automatique après 5 min sans message staff. Commandes : `!pause` (pause 5 min), `!mute` (pause sans limite jusqu’à `!resume`), `!resume` (réactive le bot). Les messages de commande sont supprimés après exécution. |
| **Déduplication** | Le bot ne renvoie pas deux fois de suite le même message dans un thread (fenêtre 2 min). |
| **Rappel inactivité** | Si un thread (ticket) est créé et que le créateur n’envoie aucun message pendant 1 minute, le bot envoie : « Could you please specify why you opened this ticket? » Le suivi s’arrête si le créateur ou un staff répond avant. |

---

## Stack & structure

- **Runtime** : Node.js v25
- **Lib** : discord.js v14, ES Modules
- **Config** : dotenv (`.env`)
- **Déploiement** : Docker + docker-compose (voir `DEPLOY.md`)

```
discord-bot-bart/
├── src/
│   ├── index.js              # Point d’entrée : Client Discord, events, orchestration
│   ├── config.js             # Lecture / validation des variables d’environnement
│   ├── constants.js          # Regex et mots-clés pour détection gift card
│   ├── services/
│   │   ├── detection.js       # Détection Amazon Gift Card (regex + keywords)
│   │   ├── notification.js   # Envoi du message dans le channel paiement
│   │   ├── aiService.js      # Appel OpenAI, format JSON answer/confidence
│   │   ├── knowledgeBase.js  # Chargement FAQ, searchFAQ(), formatFAQContext(), seuil score
│   │   ├── rateLimiter.js    # Limite 5 requêtes IA / thread / heure
│   │   ├── staffActivity.js  # Pause bot quand staff répond, 5 min puis reprise
│   │   ├── messageDeduplication.js  # Éviter réponses identiques consécutives
│   │   └── threadInactivity.js     # Rappel « précisez votre demande » après 1 min sans message créateur
│   └── utils/
│       ├── logger.js         # Logs avec préfixe [Bot] et timestamp
│       └── redact.js         # Remplacer les codes gift card par un placeholder (sécurité)
├── data/
│   └── faq.json              # Base de connaissances (question, answer, keywords)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── DEPLOY.md                 # Déploiement VPS (Git + Docker)
└── README.md
```

---

## Configuration

Variables attendues (voir `.env.example`) :

| Variable | Obligatoire | Rôle |
|----------|-------------|------|
| `BOT_TOKEN` | Oui | Token du bot Discord |
| `PAYMENT_CHANNEL_ID` | Oui | Channel où envoyer les notifications gift card |
| `AMAZON_ROLE_ID` | Oui | Rôle à mentionner (gift card + escalade IA) |
| `TICKET_CHANNEL_ID` | Oui | Channel dont les **threads** sont les tickets à surveiller |
| `OPENAI_API_KEY` | Non | Si présent, active le support IA ; sinon uniquement gift card + rappel inactivité |
| `STAFF_ROLE_ID` | Non | Rôle staff : pause auto, commandes !pause / !mute / !resume, exclusion des réponses IA |

---

## Lancer le bot

```bash
npm install
cp .env.example .env   # puis remplir les variables
npm start
```

En Docker : `docker compose up -d --build` (détails dans `DEPLOY.md`).

---

## Flux de traitement des messages

Tout se passe dans les **threads** du channel `TICKET_CHANNEL_ID`. Les messages en dehors de ces threads sont ignorés.

### 1. À la création d’un thread (`threadCreate`)

- Si `parentId === TICKET_CHANNEL_ID` et non archivé → `trackThread(thread.id, thread.ownerId)` (service `threadInactivity`).

### 2. À chaque message (`messageCreate`)

- **Bots** : ignorés.
- **Hors thread ou hors channel tickets** : ignorés.
- **Suivi inactivité** : `onMessageInThread(threadId, authorId, isStaff)` → si créateur ou staff a répondu, arrêt du suivi pour ce thread.
- **Staff** :
  - `!pause` / `!bot pause` → pause le bot pour ce thread (auto-resume après 5 min).
  - `!mute` / `!bot mute` → met le bot en pause sans limite de temps ; seule la commande `!resume` le réactive.
  - `!resume` / `!bot resume` → réactive le bot (annule pause et mute). Message de commande supprimé après chaque commande.
  - Sinon → `updateStaffActivity(threadId)` (pause auto) et fin du traitement.
- **Thread en pause** (`isThreadPaused`) : le bot ne répond pas, fin du traitement.
- **Contenu vide** : ignoré.

Ensuite, pour les messages utilisateur (non staff) avec contenu :

1. **Priorité 1 – Gift Card**  
   Si `hasAmazonGiftCard(content)` :
   - Rédaction des codes (`redactGiftCardCodes`).
   - Envoi d’une notification dans le channel paiement (lien thread, auteur, extrait redacté, mention `AMAZON_ROLE_ID`).
   - Fin.

2. **Priorité 2 – Support IA** (si `OPENAI_API_KEY` est défini)
   - Rate limit : max 5 réponses IA par thread par heure.
   - `searchFAQ(content)` → si meilleur score < seuil (FAQ_MIN_SCORE) → escalade directe (« A human agent will assist you shortly »), pas d’appel OpenAI.
   - Sinon : `handleAISupport(content)` (contexte FAQ + OpenAI, réponse structurée `{ answer, confidence }`).
   - Si `confidence >= 0.6` → envoi de `answer` (avec déduplication).
   - Sinon → envoi de la phrase d’escalade + mention rôle (avec déduplication).

La **déduplication** évite d’envoyer deux fois de suite le même texte dans le même thread (fenêtre 2 min).

### 3. Tâche périodique (au `ready`)

- Toutes les 15 s : `getThreadsToPrompt()` → pour chaque thread éligible (créé depuis > 1 min, créateur n’a pas répondu, pas encore demandé), envoi du message « Could you please specify why you opened this ticket? » puis `markAsAsked(threadId)`.

---

## Guide pour agents IA

Cette section aide un agent IA à s’orienter dans le projet et à modifier le bon endroit.

### Carte des fichiers par responsabilité

| Besoin | Fichier(s) |
|--------|------------|
| Comportement global, ordre des checks, events | `src/index.js` |
| Variables d’environnement, validation | `src/config.js` |
| Détection « message = gift card ? » | `src/services/detection.js`, `src/constants.js` |
| Contenu du message envoyé en cas de gift card | `src/services/notification.js` |
| Rédaction des codes (sécurité) | `src/utils/redact.js`, `src/constants.js` (regex) |
| Support IA : prompt, modèle, confiance | `src/services/aiService.js` |
| FAQ : recherche, score, seuil d’escalade | `src/services/knowledgeBase.js` |
| Données FAQ (questions/réponses/liens) | `data/faq.json` |
| Limite 5 réponses / thread / heure | `src/services/rateLimiter.js` |
| Pause quand staff répond, 5 min, !pause / !mute / !resume | `src/services/staffActivity.js` |
| Éviter deux réponses identiques consécutives | `src/services/messageDeduplication.js` |
| Rappel « précisez votre ticket » après 1 min | `src/services/threadInactivity.js` |
| Logs | `src/utils/logger.js` |

### Règles importantes

- **Sécurité** : ne jamais logger ni renvoyer un code gift card en clair. Toujours passer par `redactGiftCardCodes()` pour tout texte affiché ou envoyé à l’API.
- **Ne pas casser** : la détection gift card et la notification paiement sont le cœur métier ; ne pas modifier la logique dans `detection.js` ni `notification.js` sans intention explicite.
- **Threads uniquement** : le bot ne réagit qu’aux messages dans un thread dont le parent est `TICKET_CHANNEL_ID`.

### Points d’entrée pour des changements courants

- **Changer le message de rappel inactivité** : `src/index.js`, constante `INACTIVITY_PROMPT_MESSAGE`.
- **Changer le délai 1 min** : `src/services/threadInactivity.js`, `INACTIVITY_THRESHOLD`.
- **Changer le délai 5 min de pause staff** : `src/services/staffActivity.js`, `PAUSE_DURATION`.
- **Changer le seuil de confiance IA** : `src/index.js`, comparaison `confidence >= 0.6`.
- **Changer le seuil « FAQ ne matche pas »** : `src/services/knowledgeBase.js`, `FAQ_MIN_SCORE` et export.
- **Modifier le prompt ou le modèle OpenAI** : `src/services/aiService.js` (SYSTEM_PROMPT, modèle, règles dans le message user).

### Intents Discord utilisés

- `Guilds`
- `GuildMessages`
- `MessageContent`  
Aucun intent supplémentaire n’est requis pour les threads du channel configuré.

---

## Licence / usage

Projet privé. Voir le dépôt pour toute précision.
