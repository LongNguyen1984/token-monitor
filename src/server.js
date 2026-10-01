#!/usr/bin/env node
// Local token-usage monitor. Zero dependencies — Node 18+ only.
//
// Endpoints (standard OTLP/HTTP paths, so tools only need the base URL):
//   POST /v1/metrics   OTLP metrics  (Claude Code)        JSON or protobuf, gzip ok
//   POST /v1/traces    OTLP traces   (GitHub Copilot)     JSON or protobuf, gzip ok
//   POST /v1/logs      OTLP logs     accepted and ignored (so exporters don't error)
//   POST /ingest       Generic JSON records (scripts, other tools)
//   GET  /api/summary  Aggregated totals
//   GET  /api/records  Raw records (?limit=)
//   GET  /api/health   Liveness check
//   GET  /             Dashboard
//
// Data stays on this machine in ./data/usage.jsonl.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { append, readAll, summarize, filterRecords, facets } from './store.js';
import { parseOtlpMetrics, parseOtlpTraces } from './adapters/otlp.js';
import { parseIngest } from './adapters/ingest.js';
import { decodeMetricsRequest, decodeTraceRequest } from './otlp-proto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const HOST = process.env.TM_HOST || '127.0.0.1'; // localhost only by default
const PORT = Number(process.env.TM_PORT || 4318); // 4318 = conventional OTLP/HTTP port
const MAX_BODY = 50 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      const enc = (req.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf);
        else if (enc === 'deflate') buf = zlib.inflateSync(buf);
      } catch (e) { return reject(new Error('bad compressed body')); }
      resolve(buf);
    });
    req.on('error', reject);
  });
}

const isProtobuf = (req) => (req.headers['content-type'] || '').includes('protobuf');

function json(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** OTLP success response: an empty Export*ServiceResponse in the request's encoding. */
function otlpOk(req, res) {
  if (isProtobuf(req)) {
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': 0 });
    return res.end();
  }
  return json(res, 200, {});
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function store(label, records) {
  records.forEach(append);
  if (records.length) console.log(`[${label}] +${records.length} records`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    if (req.method === 'POST' && pathname === '/v1/metrics') {
      const buf = await readBody(req);
      const body = isProtobuf(req) ? decodeMetricsRequest(buf) : JSON.parse(buf.toString('utf8') || '{}');
      store('metrics', parseOtlpMetrics(body));
      return otlpOk(req, res);
    }

    if (req.method === 'POST' && pathname === '/v1/traces') {
      const buf = await readBody(req);
      const body = isProtobuf(req) ? decodeTraceRequest(buf) : JSON.parse(buf.toString('utf8') || '{}');
      store('traces', parseOtlpTraces(body));
      return otlpOk(req, res);
    }

    if (req.method === 'POST' && pathname === '/v1/logs') {
      await readBody(req); // drain; logs/events aren't needed for token totals
      return otlpOk(req, res);
    }

    if (req.method === 'POST' && pathname === '/ingest') {
      const buf = await readBody(req);
      const records = parseIngest(JSON.parse(buf.toString('utf8') || '{}'));
      store('ingest', records);
      return json(res, 200, { accepted: records.length });
    }

    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });

    if (req.method === 'GET' && pathname === '/api/summary') {
      const opts = {
        source: url.searchParams.get('source') || undefined,
        model:  url.searchParams.get('model')  || undefined,
        type:   url.searchParams.get('type')   || undefined,
        from:   url.searchParams.get('from')   || undefined,
        to:     url.searchParams.get('to')     || undefined,
      };
      const filtered = filterRecords(opts);
      const result = summarize(filtered);
      result.facets = facets(filtered);
      return json(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/records') {
      const opts = {
        source: url.searchParams.get('source') || undefined,
        model:  url.searchParams.get('model')  || undefined,
        type:   url.searchParams.get('type')   || undefined,
        from:   url.searchParams.get('from')   || undefined,
        to:     url.searchParams.get('to')     || undefined,
      };
      const limit  = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const all = filterRecords(opts);
      const total = all.length;
      const page = all.slice(offset, offset + limit).reverse();
      return json(res, 200, { records: page, total, limit, offset });
    }
    if (req.method === 'GET') return serveStatic(res, pathname);

    res.writeHead(405); res.end('Method not allowed');
  } catch (err) {
    console.error(`[error] ${req.method} ${pathname}: ${err.message}`);
    json(res, 400, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is the monitor already running? Set TM_PORT to use another port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  AI Token Monitor  ->  http://${HOST}:${PORT}/`);
  console.log(`  OTLP base URL       http://${HOST}:${PORT}   (Claude Code metrics, Copilot traces)`);
  console.log(`  Generic ingest      POST http://${HOST}:${PORT}/ingest\n`);
});
