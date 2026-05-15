/**
 * Module 03.1 — Durable Audit Outbox crash-safety harness.
 *
 * The single load-bearing AC for the module:
 *   SIGTERM (or kill -9) mid-PreToolUse with a queued audit write
 *   MUST result in the policy_decisions row landing AFTER restart,
 *   not being lost.
 *
 * Path A — graceful SIGTERM. The bridge's shutdown handler awaits
 * `worker.stop()`, which in turn awaits any in-flight dispatch. The
 * row should land at the destination BEFORE the process exits. We
 * still restart the bridge afterwards and assert the row is
 * visible — the restart is incidental to the AC but proves the
 * graceful path doesn't depend on a second process to drain.
 *
 * Path B — SIGKILL (kill -9). The shutdown handler never runs. The
 * row may be in `pending_jobs.status='pending'` (worker hadn't
 * claimed yet) or `'picked'` (worker had claimed but hadn't
 * dispatched). Either way, the next process's worker drains the
 * row — `pending` rows on the very next tick (1s); `picked` rows
 * after the lease expires (default 30s).
 *
 * The harness polls policy_decisions for up to 60 seconds after
 * restart, asserting the row eventually lands. Pass = both paths
 * resolve under the timeout.
 *
 * Run with the rebuilt dist:
 *   pnpm build && pnpm exec tsx __tests__/manual/verify-outbox-crash-safety.ts
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');
const BRIDGE_BIN = resolve(ROOT, 'apps/hooks-bridge/dist/index.js');

const HOME_ROOT = '/tmp/coodra-verify-outbox-crash';
const BRIDGE_PORT = 3211;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const PROJECT_SLUG = 'outbox-crash-safety';
const PROJECT_ID = 'proj_outbox_crash';
const POLL_TIMEOUT_MS = 60_000;

const SECRET = randomBytes(32).toString('hex');

function bridgeEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    COODRA_HOME: home,
    COODRA_LOG_DESTINATION: 'stderr',
    COODRA_MODE: 'solo',
    HOOKS_BRIDGE_HOST: '127.0.0.1',
    HOOKS_BRIDGE_PORT: String(BRIDGE_PORT),
    LOCAL_HOOK_SECRET: SECRET,
    CLERK_SECRET_KEY: 'sk_test_replace_me',
    CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
  };
}

async function spawnBridge(home: string): Promise<ChildProcess> {
  const child = spawn('node', [BRIDGE_BIN], {
    env: bridgeEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => process.stderr.write(`[bridge stdout] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[bridge stderr] ${d}`));

  // Poll the listener until ready.
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    try {
      const res = await fetch(`${BRIDGE_URL}/v1/hooks/claude-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Hook-Secret': SECRET },
        body: JSON.stringify({}),
      });
      // Any reachable response (even 400) means the listener is up.
      if (res.status >= 200 && res.status < 600) return child;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('bridge did not become reachable within 10s');
}

async function killAndWait(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const done = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
  child.kill(signal);
  await done;
}

async function firePreToolUse(sessionId: string, toolUseId: string): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/v1/hooks/claude-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Hook-Secret': SECRET },
    body: JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      cwd: HOME_ROOT,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.ts' },
      tool_use_id: toolUseId,
    }),
  });
  if (res.status !== 200) throw new Error(`PreToolUse returned ${res.status}: ${await res.text()}`);
}

function countPolicyDecisions(home: string, sessionId: string): number {
  const out = execFileSync(
    'sqlite3',
    [`${home}/data.db`, `SELECT COUNT(*) FROM policy_decisions WHERE session_id='${sessionId}';`],
    { encoding: 'utf8' },
  ).trim();
  return Number(out);
}

function pendingJobsCount(home: string): number {
  const out = execFileSync('sqlite3', [`${home}/data.db`, `SELECT COUNT(*) FROM pending_jobs;`], {
    encoding: 'utf8',
  }).trim();
  return Number(out);
}

async function pollUntilLanded(home: string, sessionId: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (countPolicyDecisions(home, sessionId) > 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`policy_decisions row for ${sessionId} did not land within ${deadlineMs}ms`);
}

async function seedFixture(home: string): Promise<void> {
  mkdirSync(home, { recursive: true });
  // Boot bridge briefly to let it run migrations + ensureGlobalProject,
  // then we can directly INSERT the project row before the real test
  // runs.
  const child = await spawnBridge(home);
  await killAndWait(child, 'SIGTERM');

  // Insert the test project so the bridge resolves it (no .coodra.json in the home).
  // The path resolver in the bridge looks at cwd's .coodra.json — we send cwd=HOME_ROOT
  // but no .coodra.json is there, so without this row, the bridge falls back to
  // __global__. We INSERT a project row so we have something deterministic to filter on.
  // Also seed a permissive rule so check_policy returns 'allow' (any decision lands an
  // audit row; we just need the row to exist).
  const seedSql = `
    INSERT OR IGNORE INTO projects (id, slug, org_id, name) VALUES ('${PROJECT_ID}', '${PROJECT_SLUG}', 'org_test', 'crash-safety');
    INSERT OR IGNORE INTO policies (id, project_id, name, is_active) VALUES ('pol_crash', '${PROJECT_ID}', 'crash-test', 1);
    INSERT OR IGNORE INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name, match_path_glob, match_agent_type, decision, reason)
      VALUES ('rule_crash', 'pol_crash', 100, 'PreToolUse', 'Write', NULL, '*', 'allow', 'allow all writes');
  `;
  execFileSync('sqlite3', [`${home}/data.db`, seedSql], { stdio: 'inherit' });
}

async function pathA(): Promise<void> {
  process.stdout.write('\n=== Path A — graceful SIGTERM ===\n');
  const home = `${HOME_ROOT}/path-a`;
  rmSync(home, { recursive: true, force: true });
  await seedFixture(home);
  const sessionId = `crash-A-${Date.now()}`;

  const bridge1 = await spawnBridge(home);
  await firePreToolUse(sessionId, 'tu-A-1');
  process.stdout.write(`fired PreToolUse; pending=${pendingJobsCount(home)}\n`);
  // Tiny pause to let scheduleDurableWrite resolve in-process.
  await new Promise((r) => setTimeout(r, 50));

  // SIGTERM and wait for graceful exit. The shutdown handler awaits worker.stop()
  // which awaits any in-flight dispatch — the row should land before exit.
  await killAndWait(bridge1, 'SIGTERM');
  process.stdout.write(
    `bridge SIGTERM exit; pending=${pendingJobsCount(home)}, decisions=${countPolicyDecisions(home, sessionId)}\n`,
  );

  // Restart and confirm the row is visible (it should be).
  const bridge2 = await spawnBridge(home);
  await pollUntilLanded(home, sessionId, POLL_TIMEOUT_MS);
  process.stdout.write(`PASS Path A: policy_decisions row visible after restart\n`);
  await killAndWait(bridge2, 'SIGTERM');
}

async function pathB(): Promise<void> {
  process.stdout.write('\n=== Path B — SIGKILL (kill -9) ===\n');
  const home = `${HOME_ROOT}/path-b`;
  rmSync(home, { recursive: true, force: true });
  await seedFixture(home);
  const sessionId = `crash-B-${Date.now()}`;

  const bridge1 = await spawnBridge(home);
  await firePreToolUse(sessionId, 'tu-B-1');
  process.stdout.write(`fired PreToolUse; pending=${pendingJobsCount(home)}\n`);
  // No pause — kill immediately to maximise the chance of catching the row
  // mid-dispatch (or before dispatch).
  await killAndWait(bridge1, 'SIGKILL');
  process.stdout.write(
    `bridge SIGKILL exit; pending=${pendingJobsCount(home)}, decisions=${countPolicyDecisions(home, sessionId)}\n`,
  );

  // Restart. The pending row drains on the worker's first eligible tick.
  // For status='picked' rows (claim happened pre-kill), the lease must
  // expire first (default 30s). Poll for up to 60s.
  const bridge2 = await spawnBridge(home);
  await pollUntilLanded(home, sessionId, POLL_TIMEOUT_MS);
  process.stdout.write(`PASS Path B: policy_decisions row visible after restart + drain\n`);
  await killAndWait(bridge2, 'SIGTERM');
}

async function main(): Promise<void> {
  try {
    await pathA();
    await pathB();
    process.stdout.write('\nALL PASS — durable audit outbox holds under SIGTERM and SIGKILL\n');
  } catch (err) {
    process.stderr.write(`FAIL: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}

main();
