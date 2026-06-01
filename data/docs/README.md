# Knowledge Base Documents

Drop markdown files in this folder to expand the bot's knowledge beyond the FAQ.

The bot will chunk each file (~500 chars, 50 overlap), embed each chunk with OpenAI's
`text-embedding-3-small`, and use semantic search to surface relevant passages alongside
FAQ entries when answering customer questions.

## Tips

- One topic per file. Use clear `# Heading` and short paragraphs.
- Include product names verbatim (Stand, Atlas, Midnight, etc.) — the model preserves them.
- The FAQ remains authoritative for exact Q&A pairs. Use docs for guides, policies, and
  longer-form explanations that don't fit the Q&A shape.

## Re-indexing

Embeddings are cached in `data/embeddings.json`, keyed by SHA-256 of each chunk's content.
Edit a file → only changed chunks get re-embedded. Delete a file → stale chunks get pruned
on the next indexing pass.
