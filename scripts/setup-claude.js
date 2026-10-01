#!/usr/bin/env node
// Turn Claude Code telemetry on (or off) in your USER settings: ~/.claude/settings.json
//
// Why user settings and not this repo's .claude/settings.json?
// Claude Code deliberately ignores the OpenTelemetry exporter variables in a repository's
// .claude/settings.json, so a repo can't switch telemetry on or redirect it. They have to
// live in your shell or in ~/.claude/settings.json.
//
//   node scripts/setup-claude.js            # add telemetry env (backs up the file first)
//   node scripts/setup-claude.js --remove   # remove exactly the keys this script adds
//   node scripts/setup-claude.js --print    # just print the snippet, change nothing

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TM_PORT || 4318);
const ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${PORT}/v1/metrics`,
  OTEL_METRIC_EXPORT_INTERVAL: '10000', // 10s so the dashboard feels live (default 60s)
};

const mode = process.argv.includes('--remove') ? 'remove' : process.argv.includes('--print') ? 'print' : 'add';

if (mode === 'print') {
  console.log(JSON.stringify({ env: ENV }, null, 2));
  process.exit(0);
}

const dir = path.join(os.homedir(), '.claude');
const file = path.join(dir, 'settings.json');
fs.mkdirSync(dir, { recursive: true });

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  try { settings = raw.trim() ? JSON.parse(raw) : {}; }
  catch {
    console.error(`${file} is not valid JSON. Fix it first, or add this manually:\n`);
    console.error(JSON.stringify({ env: ENV }, null, 2));
    process.exit(1);
  }
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  console.log(`Backup: ${backup}`);
}

settings.env = settings.env || {};
if (mode === 'add') {
  Object.assign(settings.env, ENV);
} else {
  for (const k of Object.keys(ENV)) delete settings.env[k];
  if (!Object.keys(settings.env).length) delete settings.env;
}

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(mode === 'add'
  ? `Telemetry ON -> http://127.0.0.1:${PORT}. Restart Claude Code for it to take effect.`
  : 'Telemetry keys removed. Restart Claude Code for it to take effect.');
