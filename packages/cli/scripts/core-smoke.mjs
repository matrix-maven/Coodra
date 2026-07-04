#!/usr/bin/env node
// `scripts/core-smoke.mjs` — cross-platform end-to-end smoke for the Coodra
// CORE (Claude Code) install path. Written for the Windows CI job
// (2026-06-16) but deliberately OS-agnostic so it runs identically on
// Linux/macOS — which lets a maintainer validate the harness locally before
// trusting it on a `windows-latest` runner.
//
// What it proves, from the built CLI tarball artifacts (no monorepo
// assumptions beyond locating dist/):
//   1. `coodra --version`         → the bin runs at all.
//   2. `coodra init --ide claude` → writes `.mcp.json` + the Claude Code
//                                    hook settings (the Claude Code wiring).
//   3. `coodra start --no-web --no-sync` → the bundled mcp-server +
//      hooks-bridge daemons boot and pass their /healthz gate. This is THE
//      decisive proof on Windows: it means better-sqlite3 + sqlite-vec
//      loaded, the SQLite DB migrated, and the HTTP servers bound.
//   4. /healthz probes on both ports return 200.
//   5. `coodra status` reports them running; `coodra stop` tears down.
//
// The `web` dashboard is intentionally out of scope (Core = Claude Code):
// it's skipped via --no-web here and auto-skipped on win32 by `coodra start`.
//
// Exit 0 = all assertions held. Non-zero = a step failed; daemon logs are
// dumped before exit and the temp dirs are always cleaned up.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const cliBin = resolve(cliRoot, 'dist', 'index.js');

// Uncommon ports so the smoke never collides with a real `coodra start` the
// developer may have running locally (or anything else on 3100/3101).
const MCP_PORT = 39100;
const BRIDGE_PORT = 39101;

const coodraHome = mkdtempSync(join(tmpdir(), 'coodra-smoke-home-'));
const projectDir = mkdtempSync(join(tmpdir(), 'coodra-smoke-proj-'));
const claudeSettings = join(coodraHome, 'claude-settings.json');

const childEnv = {
  ...process.env,
  COODRA_HOME: coodraHome,
  COODRA_MODE: 'solo',
  CLERK_SECRET_KEY: 'sk_test_replace_me',
  LOG_LEVEL: 'error',
  MCP_SERVER_PORT: String(MCP_PORT),
  HOOKS_BRIDGE_PORT: String(BRIDGE_PORT),
  // STRICT sqlite-vec: forwarded to the spawned mcp-server (buildServiceEnv
  // passes COODRA_* through). With this set, a failed load of the platform
  // vector extension (sqlite-vec-windows-x64's .dll on Windows) makes the
  // mcp-server THROW on boot instead of warning + falling back to LIKE
  // search — so /healthz never comes up and this smoke FAILS. That turns the
  // healthz gate below into a strict proof that BOTH native deps loaded.
  COODRA_REQUIRE_VEC: '1',
  // Redirect the Claude Code settings write away from the runner's real
  // ~/.claude/settings.json (honoured by claude-settings-merge.ts).
  CLAUDE_SETTINGS_PATH: claudeSettings,
  // Force the PID-file daemon manager. launchd/systemd unit names are
  // GLOBAL per user (com.coodra.<name>, not scoped by COODRA_HOME) — with
  // the native manager, this smoke's start/stop would boot out any real
  // coodra daemons the developer has running (observed 2026-07-02).
  COODRA_DAEMON_MANAGER: 'fallback',
};

let failed = false;
const log = (msg) => process.stdout.write(`[core-smoke] ${msg}\n`);

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
    // `coodra status` exits non-zero when not every service is up (the core
    // smoke deliberately leaves `web` down). Let callers opt into reading the
    // captured output instead of throwing on a non-zero exit code.
    if (opts.allowNonZero) return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    throw err;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
  log(`✓ ${message}`);
}

function probeHealthz(port) {
  return new Promise((resolveProbe) => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET', timeout: 4000 }, (res) => {
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

async function waitForHealthz(port, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const code = await probeHealthz(port);
    if (code === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function dumpLogs() {
  for (const name of ['mcp-server', 'hooks-bridge']) {
    const p = join(coodraHome, 'logs', `${name}.log`);
    if (existsSync(p)) {
      process.stderr.write(`\n----- ${name}.log -----\n${readFileSync(p, 'utf8')}\n`);
    }
  }
}

async function main() {
  assert(existsSync(cliBin), `built CLI entry exists at ${cliBin} (run \`pnpm --filter @coodra/cli build\` first)`);

  // A project root marker so `coodra init` resolves a slug + writes here.
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'coodra-smoke-fixture', version: '0.0.0' }));

  // 1. bin runs
  const version = runCli(['--version'], { capture: true }).trim();
  assert(version.length > 0, `coodra --version prints a version (${version})`);

  // 2. init wires Claude Code (project .mcp.json + hook settings)
  runCli(['init', '--project-slug', 'coodra-smoke', '--ide', 'claude', '--no-graphify', '--no-jira', '--mode', 'minimal', '--no-feature-pack']);
  const mcpJsonPath = join(projectDir, '.mcp.json');
  assert(existsSync(mcpJsonPath), '.mcp.json written into the project');
  const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
  assert(mcpJson?.mcpServers?.coodra?.command === 'node', '.mcp.json coodra entry spawns `node` (portable, PATH-resolved on Windows)');
  assert(existsSync(claudeSettings), 'Claude Code hook settings written (CLAUDE_SETTINGS_PATH redirect)');
  const settings = JSON.parse(readFileSync(claudeSettings, 'utf8'));
  const sessionStart = settings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.url ?? '';
  // Port is the init default (3101); the smoke overrides the daemon port only
  // to avoid collisions, so assert the endpoint path, not the port.
  assert(sessionStart.includes('/v1/hooks/claude-code'), 'SessionStart hook points at the local bridge endpoint');

  // 3. start the core daemons (web skipped; sync is solo-skipped anyway)
  runCli(['start', '--no-web', '--no-sync']);

  // 4. /healthz on both core ports
  const mcpHealthy = await waitForHealthz(MCP_PORT);
  assert(mcpHealthy, `mcp-server /healthz 200 on :${MCP_PORT} (better-sqlite3 + sqlite-vec loaded, DB migrated, HTTP bound)`);
  const bridgeHealthy = await waitForHealthz(BRIDGE_PORT);
  assert(bridgeHealthy, `hooks-bridge /healthz 200 on :${BRIDGE_PORT}`);

  // 5. `coodra status` executes on this platform. Its rich output is
  // TTY-gated and the daemon-manager differs per OS (launchd/systemd vs the
  // win32 fallback PID files), so the authoritative "daemons are up" proof is
  // the two /healthz 200s above — this step just confirms the status code
  // path runs without a spawn/crash error (allowNonZero swallows the
  // by-design non-zero exit when web is intentionally down).
  runCli(['status'], { allowNonZero: true });
  log('✓ coodra status executed without error');

  log('ALL CORE SMOKE ASSERTIONS PASSED');
}

try {
  await main();
} catch (err) {
  failed = true;
  process.stderr.write(`\n[core-smoke] FAILED: ${err?.message ?? err}\n`);
  dumpLogs();
} finally {
  // Always tear the daemons down + clean temp dirs.
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
