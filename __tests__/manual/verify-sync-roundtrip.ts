/**
 * Module 04a — Sync roundtrip harness.
 *
 * The single load-bearing AC for M04a:
 *   A write to local SQLite must appear in cloud Postgres within the
 *   sync window (5–30s, OQ2-locked at 30s catchup poll), with
 *   idempotency holding under cloud unreachability + recovery.
 *
 * What this harness does:
 *   1. Ensures cloud Postgres has the canonical schema (runs `cloud-migrate`).
 *   2. Seeds the test project + __global__ on cloud (FK target for runs).
 *   3. Boots bridge (team mode) + sync-daemon as subprocesses against
 *      a tmp COODRA_HOME. Both share the same local SQLite.
 *   4. Fires SessionStart + 5 PreToolUse + 1 PostToolUse + Stop hooks
 *      at the bridge.
 *   5. Polls cloud for the expected rows: 1 runs row (status='completed',
 *      canonical 4-segment id), 5 policy_decisions rows (one per F14
 *      idempotency_key), 1 run_events row.
 *   6. Disconnect variant: kills sync-daemon, fires 5 more
 *      PreToolUse hooks at bridge (rows accumulate locally + in
 *      pending_jobs sync_to_cloud queue), restarts sync-daemon,
 *      asserts all 5 backlog rows land within sync_window.
 *
 * Run:
 *   DATABASE_URL='postgres://...' pnpm build && pnpm exec tsx \
 *     __tests__/manual/verify-sync-roundtrip.ts
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
const SYNC_BIN = resolve(ROOT, 'apps/sync-daemon/dist/index.js');
const CLI_BIN = resolve(ROOT, 'packages/cli/dist/index.js');

const HOME_ROOT = '/tmp/coodra-verify-sync-roundtrip';
const BRIDGE_PORT = 3221;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const PROJECT_SLUG = 'sync-roundtrip-test';
const PROJECT_ID = 'proj_sync_roundtrip';
const SYNC_WINDOW_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

const SECRET = randomBytes(32).toString('hex');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || databaseUrl.length === 0) {
  console.error('verify-sync-roundtrip: DATABASE_URL is required');
  process.exit(2);
}

function commonEnv(home: string, mode: 'team'): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    COODRA_HOME: home,
    COODRA_LOG_DESTINATION: 'stderr',
    COODRA_MODE: mode,
    DATABASE_URL: databaseUrl as string,
    LOCAL_HOOK_SECRET: SECRET,
    CLERK_SECRET_KEY: 'sk_test_replace_me',
    CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
  };
}

function bridgeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...commonEnv(home, 'team'),
    HOOKS_BRIDGE_HOST: '127.0.0.1',
    HOOKS_BRIDGE_PORT: String(BRIDGE_PORT),
  };
}

function syncEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...commonEnv(home, 'team'),
    COODRA_SYNC_TICK_MS: '1000',
  };
}

function spawnDaemon(name: string, bin: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn('node', [bin], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => process.stderr.write(`[${name} stdout] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${name} stderr] ${d}`));
  return child;
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function gracefulStop(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 5_000);
  });
}

async function postHook(eventName: string, body: Record<string, unknown>): Promise<void> {
  // Only PreToolUse / PostToolUse / UserPromptSubmit carry tool fields.
  // SessionStart / Stop must NOT include them or the Zod parse fails-open.
  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse';
  const payload: Record<string, unknown> = {
    hook_event_name: eventName,
    session_id: SESSION_ID,
    cwd: '/tmp',
    ...(isToolEvent
      ? {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/sync-roundtrip-test.ts' },
        }
      : {}),
    ...body,
  };
  const res = await fetch(`${BRIDGE_URL}/v1/hooks/claude-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Hook-Secret': SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bridge ${eventName} returned ${res.status}: ${text}`);
  }
}

const SESSION_ID = `sync-roundtrip-${Date.now()}`;

async function pollCloud<T>(
  query: string,
  predicate: (rows: T[]) => boolean,
  timeoutMs = SYNC_WINDOW_MS,
): Promise<T[]> {
  const start = Date.now();
  let lastRows: T[] = [];
  while (Date.now() - start < timeoutMs) {
    const out = execFileSync('psql', [databaseUrl as string, '-A', '-t', '-F', '|', '-c', query], {
      encoding: 'utf8',
    });
    const lines = out
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    lastRows = lines as unknown as T[];
    if (predicate(lastRows)) return lastRows;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`pollCloud timeout after ${timeoutMs}ms (last rows: ${JSON.stringify(lastRows).slice(0, 200)})`);
}

async function execCloudSql(sql: string): Promise<string> {
  return execFileSync('psql', [databaseUrl as string, '-A', '-t', '-F', '|', '-c', sql], { encoding: 'utf8' });
}

async function main(): Promise<void> {
  // Clean tmp home.
  rmSync(HOME_ROOT, { recursive: true, force: true });
  mkdirSync(HOME_ROOT, { recursive: true });

  // (1) Cloud schema migration (idempotent).
  console.log('==> Step 1: cloud-migrate');
  execFileSync('node', [CLI_BIN, 'cloud-migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl as string },
    stdio: 'inherit',
  });

  // (2) Seed project rows on cloud (FK target for runs).
  console.log('==> Step 2: seed cloud projects');
  await execCloudSql(`
    INSERT INTO projects (id, slug, org_id, name)
      VALUES ('${PROJECT_ID}', '${PROJECT_SLUG}', 'sync_test', '${PROJECT_SLUG}')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO projects (id, slug, org_id, name)
      VALUES ('__global__', '__global__', '__global__', 'Global Policy Rules')
      ON CONFLICT (id) DO NOTHING;
    -- Clean prior test rows from this session id.
    DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE session_id = '${SESSION_ID}');
    DELETE FROM policy_decisions WHERE session_id = '${SESSION_ID}';
    DELETE FROM runs WHERE session_id = '${SESSION_ID}';
  `);

  // (3) Boot bridge + sync-daemon. Both share COODRA_HOME so they
  //     write to the same local SQLite.
  console.log('==> Step 3: spawn bridge + sync-daemon');
  const bridge = spawnDaemon('bridge', BRIDGE_BIN, bridgeEnv(HOME_ROOT));
  const ready = await waitForHealth(`${BRIDGE_URL}/healthz`);
  if (!ready) throw new Error('bridge did not become healthy');
  let syncDaemon: ChildProcess = spawnDaemon('sync', SYNC_BIN, syncEnv(HOME_ROOT));
  await new Promise((r) => setTimeout(r, 1_500)); // sync-daemon has no /healthz; let it boot.

  // Seed local project rows so the bridge can resolve project_id.
  // (The bridge's projectSlugResolver reads .coodra.json; without
  // one in cwd the bridge falls back to __global__. For this harness
  // we let it use __global__ — the assertions key on session_id, not
  // project_slug.)

  // (4) Fire happy-path hooks.
  console.log('==> Step 4: fire SessionStart + 5 PreToolUse + 1 PostToolUse + Stop');
  await postHook('SessionStart', {});
  for (let i = 0; i < 5; i++) {
    await postHook('PreToolUse', { tool_use_id: `tu-pre-${i}` });
  }
  await postHook('PostToolUse', { tool_use_id: 'tu-post-1' });
  await postHook('Stop', {});

  // (5) Poll cloud — expect 1 runs (canonical id), 5 policy_decisions,
  //     1 run_events.
  console.log('==> Step 5: poll cloud for expected rows');

  const runs = await pollCloud<string>(
    `SELECT id, status FROM runs WHERE session_id = '${SESSION_ID}'`,
    (rows) => rows.length === 1 && rows[0]?.endsWith('|completed') === true,
  );
  console.log(`PASS runs row: ${runs[0]}`);
  const firstRun = runs[0];
  if (firstRun === undefined) throw new Error('expected one run row');
  const runId = firstRun.split('|')[0] ?? '';
  if (!/^run:[^:]+:[^:]+:[0-9a-f-]{36}$/.test(runId)) {
    throw new Error(`runs.id is not canonical 4-segment shape: ${runId}`);
  }
  console.log(`PASS canonical 4-segment runId: ${runId}`);

  const decisions = await pollCloud<string>(
    `SELECT count(*) FROM policy_decisions WHERE session_id = '${SESSION_ID}'`,
    (rows) => rows[0] === '5',
  );
  console.log(`PASS policy_decisions count: ${decisions[0]}`);

  const events = await pollCloud<string>(
    `SELECT count(*) FROM run_events WHERE run_id = '${runId}'`,
    (rows) => Number(rows[0]) >= 1,
  );
  console.log(`PASS run_events count: ${events[0]}`);

  // (6) Disconnect-and-recover: kill sync-daemon, fire 5 more
  //     PreToolUse hooks (rows accumulate in local pending_jobs as
  //     sync_to_cloud), restart sync-daemon, assert backlog drains.
  console.log('==> Step 6: disconnect sync-daemon, fire 5 more PreToolUse, reconnect');
  await gracefulStop(syncDaemon);

  for (let i = 5; i < 10; i++) {
    await postHook('PreToolUse', { tool_use_id: `tu-pre-${i}` });
  }

  // Restart sync-daemon.
  syncDaemon = spawnDaemon('sync', SYNC_BIN, syncEnv(HOME_ROOT));

  await pollCloud<string>(
    `SELECT count(*) FROM policy_decisions WHERE session_id = '${SESSION_ID}'`,
    (rows) => rows[0] === '10',
  );
  console.log('PASS reconnect: 5 backlog rows drained → cloud has 10 policy_decisions for session');

  // (7) Cleanup.
  console.log('==> Step 7: cleanup');
  await gracefulStop(syncDaemon);
  await gracefulStop(bridge);

  console.log('\nALL PASS — sync roundtrip works under happy path AND disconnect/reconnect');
}

main().catch((err: unknown) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
