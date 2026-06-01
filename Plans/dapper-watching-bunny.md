# Feature: !bad Command — Flag & Correct Bot Replies

## Context

Staff need a way to flag a bot reply as wrong and provide the correct answer in one action — even if the bad reply is several messages up in the thread. The bot should learn from the correction and replace the bad reply with the correct one.

---

## User Flow

1. Staff sees a bad bot reply anywhere in the thread
2. Staff right-clicks the bad bot message → **Reply** (Discord's native reply feature)
3. Staff types: `!bad <correct answer here>`
4. Bot detects the reply-to reference, identifies the bad message and the user question that triggered it
5. Bot:
   - Sends the correct answer to the thread (so the user receives it)
   - Deletes the bad bot reply
   - Saves a new FAQ entry (question = what the user asked, answer = correct answer)
   - Deletes the `!bad` command message
   - Sends a brief staff-only confirmation (auto-deleted after 5s)

---

## Detection Logic

In `messageCreate`, inside the staff command block:

```
isStaff
&& message.content.startsWith('!bad ')
&& message.reference?.messageId          ← Discord "reply" reference
```

Then:
1. Fetch `message.reference.messageId` — verify it's a bot message (`author.id === client.user.id`)
2. Fetch recent thread history → find the user message sent **before** the bad bot reply (first non-bot message before it chronologically)
3. Extract `correctAnswer` from everything after `!bad ` in staff's message
4. Call `appendLearnedEntry(userQuestion, correctAnswer, keywords)` — same path as `!learn`
5. Delete the bad bot message (`badMsg.delete()`)
6. Send `correctAnswer` to the thread channel
7. Delete `message` (the `!bad` command)
8. Send confirmation to thread → auto-delete after 5s

---

## Edge Cases to Handle

- Staff replies to a non-bot message → silently ignore (not a bot reply)
- `!bad` with no answer text → reply with usage hint, auto-delete
- Referenced message already deleted → catch fetch error gracefully
- No user message found before the bad reply → save FAQ with a placeholder question, still delete + send the correct answer
- Staff doesn't have STAFF_ROLE_ID configured → skip (same guard as all staff commands)

---

## Files to Modify

| File | Change |
|------|--------|
| `src/index.js` | Add `!bad` handler inside existing staff command block |

No new files. No new services. No new intents (uses `messageCreate` + `message.reference` which is already available in discord.js with current intents).

---

## Critical Code Path in `src/index.js`

The existing staff command block already handles `!learn`, `!pause`, `!mute`, `!resume`. Add `!bad` as a new branch in the same block.

Keyword extraction logic can be copied directly from the `!learn` block (lines ~363–368) — it's already there.

---

## Verification

1. In a test ticket thread, trigger a bad AI reply
2. Staff right-clicks the bot reply → Reply → types `!bad Here is the correct answer`
3. Verify:
   - Correct answer is posted in the thread
   - Bad bot reply is deleted
   - `!bad` command message is deleted
   - `data/faq.json` has a new entry with the user's question and the correct answer
   - Staff confirmation appears briefly then disappears
