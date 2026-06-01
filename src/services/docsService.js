import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, extname, relative } from "path";
import { createHash } from "crypto";
import { OPENAI_API_KEY } from "../config.js";
import * as logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DOCS_DIR = join(__dirname, "../../data/docs");
const CACHE_PATH = join(__dirname, "../../data/embeddings.json");

const MODEL = "text-embedding-3-small";
const CACHE_VERSION = 1;
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
const SIMILARITY_THRESHOLD = 0.35;
const DEFAULT_TOP_K = 3;
const EMBED_TIMEOUT_MS = 15_000;
const INDEX_REFRESH_MS = 60_000; // skip filesystem walk if last build is fresher than this
const QUERY_CACHE_MAX = 100;     // LRU cap for query-embedding cache

let indexState = null; // in-memory mirror of the cache file
let indexingPromise = null; // dedupe concurrent ensureDocsIndex calls
let lastIndexBuiltAt = 0; // ms timestamp of last successful index walk

// Simple LRU for query embeddings (Map maintains insertion order; re-insert on hit promotes)
const queryEmbedCache = new Map();

// -------------------- File walking --------------------

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (stat.isFile() && extname(name).toLowerCase() === ".md") {
      out.push(full);
    }
  }
  return out;
}

// -------------------- Chunking --------------------

/**
 * Splits a doc into ~CHUNK_SIZE chunks with CHUNK_OVERLAP overlap.
 * Prefers paragraph boundaries (\n\n), falls back to sentence/whitespace.
 */
function chunkText(text) {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  // First split on blank lines (paragraphs), then merge short paragraphs up to CHUNK_SIZE.
  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if (!current) {
      current = p;
    } else if ((current.length + 2 + p.length) <= CHUNK_SIZE) {
      current = `${current}\n\n${p}`;
    } else {
      chunks.push(current);
      current = p;
    }

    // Hard-split paragraphs longer than CHUNK_SIZE
    while (current.length > CHUNK_SIZE) {
      const slice = current.slice(0, CHUNK_SIZE);
      // Try to break at last whitespace for cleaner chunks
      const breakAt = slice.lastIndexOf(" ");
      const cutAt = breakAt > CHUNK_SIZE * 0.6 ? breakAt : CHUNK_SIZE;
      chunks.push(current.slice(0, cutAt).trim());
      current = current.slice(Math.max(0, cutAt - CHUNK_OVERLAP)).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function sha256(s) {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

// -------------------- Cache I/O --------------------

function emptyState() {
  return { version: CACHE_VERSION, model: MODEL, chunks: {} };
}

function loadCache() {
  if (indexState) return indexState;
  try {
    if (!existsSync(CACHE_PATH)) {
      indexState = emptyState();
      return indexState;
    }
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== CACHE_VERSION || parsed.model !== MODEL) {
      logger.info("[docsService] Cache version/model mismatch — rebuilding fresh");
      indexState = emptyState();
      return indexState;
    }
    indexState = { version: CACHE_VERSION, model: MODEL, chunks: parsed.chunks || {} };
  } catch (err) {
    logger.error("[docsService] Failed to load embeddings cache — starting fresh:", err?.message);
    indexState = emptyState();
  }
  return indexState;
}

function saveCache(state) {
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  renameSync(tmp, CACHE_PATH);
  indexState = state;
}

// -------------------- Embeddings --------------------

async function embedOne(text) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, input: text }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Embeddings API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("Embeddings response missing vector");
    return vec;
  } finally {
    clearTimeout(timeout);
  }
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// -------------------- Public API --------------------

/**
 * Walk data/docs/, chunk each file, embed new/changed chunks only, prune stale chunks.
 * Idempotent — safe to call repeatedly. Concurrent calls are deduplicated.
 * Skips the filesystem walk entirely if it was successfully run within INDEX_REFRESH_MS.
 *
 * @param {boolean} [force=false] - bypass the freshness check and force a re-walk
 */
export async function ensureDocsIndex(force = false) {
  if (indexingPromise) return indexingPromise;
  if (!force && lastIndexBuiltAt && (Date.now() - lastIndexBuiltAt) < INDEX_REFRESH_MS) {
    return; // recently built — skip filesystem walk
  }
  indexingPromise = (async () => {
    try {
      if (!existsSync(DOCS_DIR)) {
        mkdirSync(DOCS_DIR, { recursive: true });
      }
      const state = loadCache();
      const files = listMarkdownFiles(DOCS_DIR);
      const seenHashes = new Set();

      let newCount = 0;
      let reusedCount = 0;

      for (const file of files) {
        let text = "";
        try {
          text = readFileSync(file, "utf-8");
        } catch (err) {
          logger.error("[docsService] Failed to read", file, err?.message);
          continue;
        }
        const rel = relative(DOCS_DIR, file);
        const chunks = chunkText(text);
        for (let i = 0; i < chunks.length; i++) {
          const content = chunks[i];
          const hash = sha256(content);
          seenHashes.add(hash);
          if (state.chunks[hash]) {
            // metadata refresh in case file/index changed
            state.chunks[hash].file = rel;
            state.chunks[hash].chunkIndex = i;
            reusedCount++;
            continue;
          }
          try {
            const embedding = await embedOne(content);
            state.chunks[hash] = { file: rel, chunkIndex: i, content, embedding };
            newCount++;
          } catch (err) {
            logger.error("[docsService] Failed to embed chunk", `${rel}#${i}:`, err?.message);
          }
        }
      }

      // Prune chunks no longer present in any file
      let prunedCount = 0;
      for (const hash of Object.keys(state.chunks)) {
        if (!seenHashes.has(hash)) {
          delete state.chunks[hash];
          prunedCount++;
        }
      }

      saveCache(state);
      lastIndexBuiltAt = Date.now();
      logger.info("[docsService] Index ready —",
        "files:", files.length,
        "| chunks total:", Object.keys(state.chunks).length,
        "| new:", newCount,
        "| reused:", reusedCount,
        "| pruned:", prunedCount
      );
    } catch (err) {
      logger.error("[docsService] ensureDocsIndex failed:", err?.message);
    }
  })();

  try {
    await indexingPromise;
  } finally {
    indexingPromise = null;
  }
}

/**
 * Semantic search over indexed doc chunks.
 * Embeds the query, returns top-K chunks above SIMILARITY_THRESHOLD.
 *
 * @param {string} query
 * @param {number} [topK=3]
 * @param {number} [minScore=SIMILARITY_THRESHOLD]
 * @returns {Promise<Array<{file:string, chunkIndex:number, content:string, score:number}>>}
 */
export async function searchDocs(query, topK = DEFAULT_TOP_K, minScore = SIMILARITY_THRESHOLD) {
  if (!query || typeof query !== "string") return [];
  if (!OPENAI_API_KEY) return [];

  try {
    await ensureDocsIndex();
  } catch (err) {
    logger.error("[docsService] searchDocs: ensureDocsIndex failed:", err?.message);
    return [];
  }

  const state = loadCache();
  const chunks = Object.values(state.chunks);
  if (chunks.length === 0) return [];

  // LRU cache for query embeddings — re-insert on hit to mark as recently used.
  const cacheKey = query.trim();
  let queryVec = queryEmbedCache.get(cacheKey);
  if (queryVec) {
    queryEmbedCache.delete(cacheKey);
    queryEmbedCache.set(cacheKey, queryVec);
  } else {
    try {
      queryVec = await embedOne(query);
    } catch (err) {
      logger.error("[docsService] searchDocs: failed to embed query:", err?.message);
      return [];
    }
    queryEmbedCache.set(cacheKey, queryVec);
    if (queryEmbedCache.size > QUERY_CACHE_MAX) {
      const oldest = queryEmbedCache.keys().next().value;
      queryEmbedCache.delete(oldest);
    }
  }

  const scored = chunks
    .map((c) => ({
      file: c.file,
      chunkIndex: c.chunkIndex,
      content: c.content,
      score: cosineSim(queryVec, c.embedding),
    }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length > 0) {
    logger.info("[docsService] Matched", scored.length, "chunks — top score:", scored[0].score.toFixed(3));
  }
  return scored;
}

/**
 * Format doc chunks as a context block for OpenAI.
 * Returns "" if no chunks.
 */
export function formatDocsContext(chunks) {
  if (!chunks || chunks.length === 0) return "";
  return chunks
    .map((c, i) => `Doc Chunk ${i + 1} (${c.file}):\n${c.content}`)
    .join("\n\n");
}
