#!/usr/bin/env node
// Start the monitor in the background if it isn't already running.
// Used by the Claude Code SessionStart hook and the VS Code "folderOpen" task.
// Always exits 0 quickly so it never blocks or breaks the calling tool.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TM_PORT || 4318);
const quiet = process.argv.includes('--quiet');
const log = (m) => { if (!quiet) process.stderr.write(m + '\n'); };

function isUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

try {
  if (await isUp()) {
    log(`token-monitor already running on :${PORT}`);
  } else {
    const dataDir = process.env.TM_DATA_DIR || path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const out = fs.openSync(path.join(dataDir, 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    log(`token-monitor started on :${PORT} (pid ${child.pid}) -> http://127.0.0.1:${PORT}/`);
  }
} catch (e) {
  log(`token-monitor: could not start (${e.message})`);
}
process.exit(0);
