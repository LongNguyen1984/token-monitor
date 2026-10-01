// Generic ingest adapter: a simple, tool-agnostic JSON shape any source can POST.
// Use this for GitHub Copilot or anything else that doesn't speak OTLP.
//
// Accepts either a single record or an array. Minimal required field: tokens.
//   { "source": "copilot", "model": "gpt-4o", "type": "output", "tokens": 1234, "costUsd": 0.01 }

export function parseIngest(body) {
  const items = Array.isArray(body) ? body : [body];
  const records = [];
  for (const it of items) {
    const tokens = Number(it.tokens);
    if (!Number.isFinite(tokens)) continue; // skip invalid
    records.push({
      ts: it.ts || new Date().toISOString(),
      source: String(it.source || 'unknown'),
      model: String(it.model || ''),
      type: String(it.type || 'total'),
      tokens,
      costUsd: Number(it.costUsd) || 0,
      meta: it.meta && typeof it.meta === 'object' ? it.meta : {},
    });
  }
  return records;
}
