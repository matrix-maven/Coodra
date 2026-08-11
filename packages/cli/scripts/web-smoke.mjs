#!/usr/bin/env node
// Cross-platform smoke for the bundled web runtime. Requires a full CLI build
// with dist/runtime/web present.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const cliBin = resolve(cliRoot, 'dist', 'index.js');
const webEntry = resolve(cliRoot, 'dist', 'runtime', 'web', 'apps', 'web-v2', 'server.js');

const MCP_PORT = 39200;
const WEB_PORT = 39201;
const coodraHome = mkdtempSync(join(tmpdir(), 'coodra-web-smoke-home-'));
const projectDir = mkdtempSync(join(tmpdir(), 'coodra-web-smoke-proj-'));

const childEnv = {
  ...process.env,
  COODRA_HOME: coodraHome,
  COODRA_MODE: 'solo',
  CLERK_SECRET_KEY: 'sk_test_replace_me',
  LOG_LEVEL: 'error',
  MCP_SERVER_PORT: String(MCP_PORT),
  COODRA_WEB_PORT: String(WEB_PORT),
  COODRA_REQUIRE_VEC: '1',
  ...(process.env.COODRA_SMOKE_NATIVE_DAEMON === '1' ? {} : { COODRA_DAEMON_MANAGER: 'fallback' }),
};

let failed = false;
const log = (msg) => process.stdout.write(`[web-smoke] ${msg}\n`);

function runCli(args, opts = {}) {
  log(`coodra ${args.join(' ')}`);
  try {
    return execFileSync(process.execPath, [cliBin, ...args], {
      env: childEnv,
      cwd: opts.cwd ?? projectDir,
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 120_000,
    });
  } catch (err) {
    if (opts.allowNonZero) return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    throw err;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
  log(`✓ ${message}`);
}

function probe(port, path) {
  return new Promise((resolveProbe) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 4000 }, (res) => {
      res.resume();
      resolveProbe(res.statusCode ?? 0);
    });
    req.on('error', () => resolveProbe(0));
    req.on('timeout', () => {
      req.destroy();
      resolveProbe(0);
    });
    req.end();
  });
}

async function waitFor(port, path, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    if ((await probe(port, path)) === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function dumpLogs() {
  for (const name of ['mcp-server', 'web']) {
    const p = join(coodraHome, 'logs', `${name}.log`);
    if (existsSync(p)) process.stderr.write(`\n----- ${name}.log -----\n${readFileSync(p, 'utf8')}\n`);
  }
}

async function main() {
  assert(existsSync(cliBin), `built CLI entry exists at ${cliBin}`);
  assert(existsSync(webEntry), `bundled web entry exists at ${webEntry}`);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'coodra-web-smoke-fixture' }));

  runCli(['install']);
  runCli(['init', '--project-slug', 'coodra-web-smoke']);
  runCli(['start', '--no-sync']);

  assert(await waitFor(MCP_PORT, '/healthz'), `mcp-server /healthz 200 on :${MCP_PORT}`);
  assert(await waitFor(WEB_PORT, '/api/healthz'), `web /api/healthz 200 on :${WEB_PORT}`);
  runCli(['status'], { allowNonZero: true });

  log('ALL WEB SMOKE ASSERTIONS PASSED');
}

try {
  await main();
} catch (err) {
  failed = true;
  process.stderr.write(`\n[web-smoke] FAILED: ${err?.message ?? err}\n`);
  dumpLogs();
} finally {
  try {
    runCli(['stop']);
  } catch {
    /* best effort */
  }
  for (const dir of [coodraHome, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

process.exit(failed ? 1 : 0);
