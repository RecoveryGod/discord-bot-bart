import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RULES_PATH = join(__dirname, "../../data/rules.json");

const MAX_RULES = 50;
const MAX_CHARS = 4000;

let rulesData = null;
let renderedCache = null; // memoized output of formatRulesForPrompt(); invalidated on write

/**
 * Loads rules from disk (lazy + cached). Returns [] on missing/corrupt file.
 * Cache resets on every write.
 */
export function loadRules() {
  if (rulesData !== null) return rulesData;
  try {
    if (!existsSync(RULES_PATH)) {
      rulesData = [];
      return rulesData;
    }
    const raw = readFileSync(RULES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    rulesData = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.error("[rulesService] Failed to load rules.json — defaulting to []:", err?.message);
    rulesData = [];
  }
  return rulesData;
}

function persist(rules) {
  const tmp = `${RULES_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(rules, null, 2), "utf-8");
  renameSync(tmp, RULES_PATH);
  rulesData = rules; // keep cache in sync (avoid an extra disk read on next access)
  renderedCache = null; // invalidate memoized prompt text
}

function nextId(rules) {
  if (rules.length === 0) return 1;
  return Math.max(...rules.map((r) => r.id || 0)) + 1;
}

/**
 * Append a new rule.
 * Returns the created entry.
 */
export function appendRule(ruleText, createdBy) {
  const clean = String(ruleText || "").trim();
  if (!clean) throw new Error("Rule text is empty");
  const rules = loadRules();
  const entry = {
    id: nextId(rules),
    rule: clean,
    createdBy: String(createdBy || ""),
    createdAt: new Date().toISOString(),
  };
  persist([...rules, entry]);
  return entry;
}

/**
 * Delete a rule by id. Returns true if removed, false if not found.
 */
export function deleteRule(id) {
  const target = Number(id);
  if (!Number.isFinite(target)) return false;
  const rules = loadRules();
  const filtered = rules.filter((r) => r.id !== target);
  if (filtered.length === rules.length) return false;
  persist(filtered);
  return true;
}

/**
 * List all rules (returns a copy).
 */
export function listRules() {
  return [...loadRules()];
}

/**
 * Format rules as a numbered block for system prompt injection.
 * Caps at MAX_RULES entries and MAX_CHARS total length; truncates oldest first with a log line.
 * Returns "" if there are no rules.
 */
export function formatRulesForPrompt() {
  if (renderedCache !== null) return renderedCache;
  const rules = loadRules();
  if (rules.length === 0) {
    renderedCache = "";
    return renderedCache;
  }

  // Take newest MAX_RULES (truncate oldest if over cap)
  let working = rules;
  if (rules.length > MAX_RULES) {
    logger.info("[rulesService] Rule count exceeds cap — truncating oldest. count:", rules.length, "cap:", MAX_RULES);
    working = rules.slice(-MAX_RULES);
  }

  // Render as numbered list
  let rendered = working.map((r, i) => `${i + 1}. ${r.rule}`).join("\n");

  // Char-cap: drop from the top (oldest) until under MAX_CHARS
  while (rendered.length > MAX_CHARS && working.length > 1) {
    working = working.slice(1);
    rendered = working.map((r, i) => `${i + 1}. ${r.rule}`).join("\n");
    logger.info("[rulesService] Prompt section exceeded char cap — dropped oldest rule");
  }
  if (rendered.length > MAX_CHARS) {
    rendered = rendered.slice(0, MAX_CHARS);
  }

  renderedCache = rendered;
  return rendered;
}
