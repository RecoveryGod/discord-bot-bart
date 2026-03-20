import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let priceData = null;

/**
 * Parses prices.py and returns array of { sku, price, name }.
 * Line format: "22011": 23.5,  # Cherax – License Key - Standard
 */
function loadPrices() {
  if (!priceData) {
    try {
      const filePath = join(__dirname, "../../prices.py");
      const content = readFileSync(filePath, "utf-8");
      const lineRegex = /^\s*"([\w-]+)":\s*([\d.]+),\s*#\s*(.+)$/;
      priceData = [];
      for (const line of content.split("\n")) {
        const match = line.match(lineRegex);
        if (match) {
          priceData.push({
            sku: match[1],
            price: parseFloat(match[2]),
            name: match[3].trim(),
          });
        }
      }
      logger.info(`[PriceService] Loaded ${priceData.length} products from prices.py`);
    } catch (err) {
      logger.error("[PriceService] Failed to load prices.py:", err?.message);
      priceData = [];
    }
  }
  return priceData;
}

/**
 * Searches products by name keywords from the user query.
 * Returns up to 8 matching products sorted by relevance.
 */
export function searchPrices(query) {
  if (!query || typeof query !== "string") return [];
  const products = loadPrices();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];

  const scored = products.map((product) => {
    const lowerName = product.name.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (lowerName.includes(word)) score += 2;
    }
    return { ...product, score };
  });

  return scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...p }) => p);
}

/**
 * Formats matched products as a price context string for the AI.
 */
export function formatPriceContext(products) {
  if (!products || products.length === 0) return null;
  const lines = products.map((p) => `- ${p.name}: €${p.price.toFixed(2)}`);
  return `Product Prices:\n${lines.join("\n")}`;
}
