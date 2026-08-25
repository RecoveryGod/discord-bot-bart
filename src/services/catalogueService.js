import { readFileSync, writeFileSync, renameSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  ELDRO_CATALOGUE_URL,
  ELDRO_CATALOGUE_TOKEN,
  CATALOGUE_REFRESH_MS,
} from "../config.js";
import { queryWords, scoreMatch } from "../utils/fuzzy.js";
import * as logger from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, "../../data/catalogue-cache.json");

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 8;

let catalogue = null;   // { generated_at, currency, groups: [...] }
let items = [];         // flattened, each item carries its group's context
let lastRefreshAt = null;
let lastError = null;

/**
 * Flattens groups into searchable items. Each item keeps the parent's name,
 * URL, categories and description so a single match can answer "what is it",
 * "how much" and "where do I buy it".
 */
function flatten(payload) {
  const flat = [];
  for (const group of payload?.groups ?? []) {
    for (const item of group.items ?? []) {
      flat.push({
        id: item.id,
        name: item.name,
        price: item.price,
        stock: item.stock,
        availability: item.availability,
        group: group.name,
        url: group.url,
        categories: group.categories ?? [],
        description: group.short_description ?? "",
      });
    }
  }
  return flat;
}

function adopt(payload, source) {
  catalogue = payload;
  items = flatten(payload);
  lastRefreshAt = Date.now();
  logger.info(
    `[Catalogue] ${items.length} articles chargés (${source}) — généré le ${payload.generated_at ?? "?"}`
  );
}

/** Persist so a restart during an API outage still has a catalogue to serve. */
function persist(payload) {
  try {
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf-8");
    renameSync(tmp, CACHE_PATH);
  } catch (err) {
    logger.error("[Catalogue] Écriture du cache disque échouée:", err?.message);
  }
}

function loadFromDisk() {
  try {
    const payload = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (Array.isArray(payload?.groups)) {
      adopt(payload, "cache disque");
      return true;
    }
  } catch (_) {
    // No cache yet, or unreadable — not an error worth logging on first boot.
  }
  return false;
}

/**
 * Fetches the catalogue. On failure the previous copy is kept: a slightly stale
 * price beats a silent bot.
 */
export async function refreshCatalogue() {
  if (!ELDRO_CATALOGUE_URL || !ELDRO_CATALOGUE_TOKEN) {
    logger.info("[Catalogue] ELDRO_CATALOGUE_URL/TOKEN absents — catalogue désactivé");
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(ELDRO_CATALOGUE_URL, {
      signal: controller.signal,
      headers: { "X-Eldro-Token": ELDRO_CATALOGUE_TOKEN, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.groups)) {
      throw new Error("réponse sans tableau 'groups'");
    }
    adopt(payload, "API");
    persist(payload);
    lastError = null;
    return true;
  } catch (err) {
    lastError = err?.message ?? String(err);
    logger.error("[Catalogue] Rafraîchissement échoué:", lastError, catalogue ? "— on garde la copie précédente" : "— aucune copie disponible");
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Loads from disk immediately (so the bot is useful within milliseconds of boot),
 * fires a refresh, then keeps refreshing in the background.
 */
export function startCatalogueRefresh() {
  loadFromDisk();
  refreshCatalogue();
  const timer = setInterval(refreshCatalogue, CATALOGUE_REFRESH_MS);
  timer.unref?.();
  return timer;
}

/** True once a catalogue is available from any source. */
export function hasCatalogue() {
  return items.length > 0;
}

export function getCatalogueMeta() {
  return {
    generatedAt: catalogue?.generated_at ?? null,
    currency: catalogue?.currency ?? "EUR",
    itemCount: items.length,
    lastRefreshAt,
    lastError,
  };
}

/**
 * Searches products by name. Matches on the item name, its parent group and its
 * categories, so "cs2" or "memesense" both find the same products.
 */
export function searchCatalogue(query, limit = MAX_RESULTS) {
  const words = queryWords(query);
  if (words.length === 0 || items.length === 0) return [];

  return items
    .map((item) => ({
      item,
      score:
        scoreMatch(item.name, words) +
        scoreMatch(item.group, words) * 0.5 +
        scoreMatch(item.categories.join(" "), words) * 0.5,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Catalogue context for the AI. Prices and descriptions only — stock is
 * commercial information and stays behind the staff /stock command.
 */
export function formatCatalogueContext(matches) {
  if (!matches || matches.length === 0) return null;

  const byGroup = new Map();
  for (const item of matches) {
    if (!byGroup.has(item.group)) {
      byGroup.set(item.group, { url: item.url, description: item.description, lines: [] });
    }
    byGroup.get(item.group).lines.push(`  - ${item.name}: €${item.price.toFixed(2)}`);
  }

  const blocks = [];
  for (const [group, data] of byGroup) {
    let block = `${group}`;
    if (data.description) block += `\n  ${data.description.slice(0, 400)}`;
    if (data.url) block += `\n  ${data.url}`;
    block += `\n${data.lines.join("\n")}`;
    blocks.push(block);
  }

  const meta = getCatalogueMeta();
  return `Live catalogue (as of ${meta.generatedAt ?? "unknown"}, currency ${meta.currency}):\n${blocks.join("\n\n")}`;
}
