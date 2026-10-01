// Turn OTLP payloads (already in OTLP/JSON shape) into normalized usage records.
//
// Claude Code  -> METRICS  claude_code.token.usage (Sum; attrs: type, model)
//                          claude_code.cost.usage  (Sum; USD)
// Copilot Chat -> TRACES   spans with gen_ai.operation.name = "chat"
//                          attrs: gen_ai.usage.input_tokens / output_tokens /
//                                 cache_read.input_tokens / cache_creation.input_tokens
//
// Why spans for Copilot and not its gen_ai.client.token.usage histogram?
// One chat span == one model call, so every request is counted exactly once with no
// delta/cumulative bookkeeping, and spans also carry cache-token counts.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.js';

const TEMPORALITY_CUMULATIVE = 2;
const STATE_FILE = path.join(DATA_DIR, 'cumulative-state.json');

// Last value seen for each cumulative series, persisted so a server restart
// doesn't re-count everything the exporter has accumulated so far.
let cumulativeState = {};
try { cumulativeState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(cumulativeState)); } catch { /* non-fatal */ }
}

function attrsToObject(attributes = []) {
  const o = {};
  for (const a of attributes) {
    const v = a.value || {};
    if (v.stringValue !== undefined) o[a.key] = v.stringValue;
    else if (v.intValue !== undefined) o[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) o[a.key] = Number(v.doubleValue);
    else if (v.boolValue !== undefined) o[a.key] = v.boolValue;
  }
  return o;
}

// OTLP timestamps are unix nanoseconds, encoded as a decimal string, a number,
// or (some older JS serializers) a {low, high} long object.
function nanosToIso(n) {
  try {
    if (n === undefined || n === null || n === '' || n === '0') return new Date().toISOString();
    let big;
    if (typeof n === 'object' && 'low' in n) big = (BigInt(n.high >>> 0) << 32n) | BigInt(n.low >>> 0);
    else if (typeof n === 'number') big = BigInt(Math.trunc(n));
    else big = BigInt(String(n));
    return new Date(Number(big / 1000000n)).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function dpValue(dp) {
  if (dp.asInt !== undefined) return Number(dp.asInt);
  if (dp.asDouble !== undefined) return Number(dp.asDouble);
  return 0;
}

/** Convert a cumulative reading to the increment since the previous reading. */
function toDelta(seriesKey, value) {
  const prev = cumulativeState[seriesKey];
  cumulativeState[seriesKey] = value;
  if (prev === undefined || value < prev) return value; // first sighting, or counter reset
  return value - prev;
}

function sourceFromResource(resAttrs, fallback) {
  const svc = String(resAttrs['service.name'] || '');
  if (svc.startsWith('copilot')) return 'copilot';
  if (svc.startsWith('claude')) return 'claude-code';
  return svc || fallback;
}

// ---------------------------------------------------------------- metrics
export function parseOtlpMetrics(body) {
  const records = [];
  let touchedState = false;

  for (const rm of body?.resourceMetrics || []) {
    const resAttrs = attrsToObject(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics || []) {
      for (const metric of sm.metrics || []) {
        const isToken = metric.name === 'claude_code.token.usage';
        const isCost = metric.name === 'claude_code.cost.usage';
        if (!isToken && !isCost) continue; // other metrics (incl. Copilot's histogram) are ignored

        const container = metric.sum || metric.gauge || {};
        const cumulative = Number(container.aggregationTemporality) === TEMPORALITY_CUMULATIVE
          || container.aggregationTemporality === 'AGGREGATION_TEMPORALITY_CUMULATIVE';

        for (const dp of container.dataPoints || []) {
          const attrs = attrsToObject(dp.attributes);
          let value = dpValue(dp);
          if (cumulative) {
            const key = [metric.name, JSON.stringify(dp.startTimeUnixNano ?? ''),
              ...Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`)].join('|');
            value = toDelta(key, value);
            touchedState = true;
          }
          if (!value) continue;

          const base = {
            ts: nanosToIso(dp.timeUnixNano),
            source: sourceFromResource(resAttrs, 'claude-code'),
            model: String(attrs.model || ''),
            meta: { session_id: attrs['session.id'], query_source: attrs.query_source },
          };
          records.push(isToken
            ? { ...base, type: String(attrs.type || 'total'), tokens: value }
            : { ...base, type: 'cost', tokens: 0, costUsd: value });
        }
      }
    }
  }
  if (touchedState) saveState();
  return records;
}

// ---------------------------------------------------------------- traces
export function parseOtlpTraces(body) {
  const records = [];
  for (const rs of body?.resourceSpans || []) {
    const resAttrs = attrsToObject(rs.resource?.attributes);
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        const a = attrsToObject(span.attributes);
        // Only individual model calls. invoke_agent spans aggregate their children,
        // so counting them too would double-count.
        if (a['gen_ai.operation.name'] !== 'chat') continue;
        if (a['gen_ai.usage.input_tokens'] === undefined && a['gen_ai.usage.output_tokens'] === undefined) continue;

        const cacheRead = Number(a['gen_ai.usage.cache_read.input_tokens']) || 0;
        const cacheCreation = Number(a['gen_ai.usage.cache_creation.input_tokens']) || 0;
        // Per the OTel GenAI conventions, input_tokens INCLUDES cached tokens.
        // Split them out so "input" means the same thing as Claude Code's input type.
        const input = Math.max(0, (Number(a['gen_ai.usage.input_tokens']) || 0) - cacheRead - cacheCreation);
        const output = Number(a['gen_ai.usage.output_tokens']) || 0;

        const base = {
          ts: nanosToIso(span.endTimeUnixNano || span.startTimeUnixNano),
          source: sourceFromResource(resAttrs, 'copilot'),
          model: String(a['gen_ai.response.model'] || a['gen_ai.request.model'] || ''),
          meta: { trace_id: span.traceId, span_id: span.spanId, provider: a['gen_ai.provider.name'] },
        };
        for (const [type, tokens] of [['input', input], ['output', output], ['cacheRead', cacheRead], ['cacheCreation', cacheCreation]]) {
          if (tokens) records.push({ ...base, type, tokens });
        }
      }
    }
  }
  return records;
}
