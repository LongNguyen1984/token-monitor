// Append-only JSONL store for usage records. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TM_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'usage.jsonl');

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * A normalized usage record.
 * @typedef {Object} UsageRecord
 * @property {string} ts        - ISO timestamp
 * @property {string} source    - "claude-code" | "copilot" | custom
 * @property {string} model     - model identifier, if known
 * @property {string} type      - "input" | "output" | "cacheRead" | "cacheCreation" | "total"
 * @property {number} tokens    - token count
 * @property {number} [costUsd] - optional cost in USD
 * @property {Object} [meta]    - any extra attributes
 */

/** Append one record to disk. */
export function append(record) {
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(DATA_FILE, line);
}

/** Read all records back (small-scale; fine for a personal monitor). */
export function readAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

/** Aggregate totals by source, model and token type. */
export function summarize(records = readAll()) {
  const totals = { tokens: 0, costUsd: 0, records: records.length };
  const bySource = {};
  const byModel = {};
  const byType = {};
  for (const r of records) {
    const t = Number(r.tokens) || 0;
    const c = Number(r.costUsd) || 0;
    totals.tokens += t;
    totals.costUsd += c;
    if (!t) continue; // cost-only records carry no tokens
    bySource[r.source] = (bySource[r.source] || 0) + t;
    if (r.model) byModel[r.model] = (byModel[r.model] || 0) + t;
    if (r.type) byType[r.type] = (byType[r.type] || 0) + t;
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return { totals, bySource, byModel, byType };
}

export { DATA_FILE, DATA_DIR };
