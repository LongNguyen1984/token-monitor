#!/usr/bin/env node
// Send sample data to a running monitor, in every format it accepts,
// so you can check the dashboard without spending real tokens.
//   node scripts/demo.js

import { enc } from '../src/otlp-proto.js';

const BASE = `http://127.0.0.1:${process.env.TM_PORT || 4318}`;
const nowNs = () => (BigInt(Date.now()) * 1000000n).toString();

async function post(path, body, contentType) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': contentType }, body });
  console.log(`${path.padEnd(12)} ${contentType.padEnd(24)} -> ${res.status}`);
}

// 1) Claude Code style: OTLP/JSON metrics (delta)
const claudeMetrics = {
  resourceMetrics: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
    scopeMetrics: [{
      metrics: [
        {
          name: 'claude_code.token.usage', unit: 'tokens',
          sum: {
            aggregationTemporality: 1, isMonotonic: true,
            dataPoints: [
              ['input', 1200], ['output', 850], ['cacheRead', 15000], ['cacheCreation', 3000],
            ].map(([type, v]) => ({
              timeUnixNano: nowNs(), asInt: String(v),
              attributes: [
                { key: 'type', value: { stringValue: type } },
                { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
              ],
            })),
          },
        },
        {
          name: 'claude_code.cost.usage', unit: 'USD',
          sum: { aggregationTemporality: 1, dataPoints: [{
            timeUnixNano: nowNs(), asDouble: 0.0421,
            attributes: [{ key: 'model', value: { stringValue: 'claude-sonnet-5' } }],
          }] },
        },
      ],
    }],
  }],
};
await post('/v1/metrics', JSON.stringify(claudeMetrics), 'application/json');

// 2) Copilot style: OTLP/protobuf trace with one "chat" span
const span = Buffer.concat([
  enc.len(1, Buffer.alloc(16, 1)), enc.len(2, Buffer.alloc(8, 2)),
  enc.str(5, 'chat gpt-5'),
  enc.f64(7, nowNs()), enc.f64(8, nowNs()),
  enc.kv(9, 'gen_ai.operation.name', 'chat'),
  enc.kv(9, 'gen_ai.request.model', 'gpt-5'),
  enc.kv(9, 'gen_ai.usage.input_tokens', 4000),
  enc.kv(9, 'gen_ai.usage.output_tokens', 600),
  enc.kv(9, 'gen_ai.usage.cache_read.input_tokens', 2500),
]);
const traceReq = enc.len(1, Buffer.concat([
  enc.len(1, enc.kv(1, 'service.name', 'copilot-chat')),       // Resource
  enc.len(2, enc.len(2, span)),                                // ScopeSpans { spans }
]));
await post('/v1/traces', traceReq, 'application/x-protobuf');

// 3) Generic ingest
await post('/ingest', JSON.stringify({ source: 'my-script', model: 'custom', type: 'output', tokens: 321 }), 'application/json');

const s = await (await fetch(BASE + '/api/summary')).json();
console.log('\nSummary:', JSON.stringify(s, null, 2));
