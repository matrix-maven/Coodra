// ---------------------------------------------------------------------------
// CRITICAL: this import must be FIRST, before anything else. It sets
// COODRA_LOG_DESTINATION=stderr so that when @coodra/shared's
// logger module is subsequently loaded (transitively via env.ts,
// tool-registry.ts, stdio.ts), it resolves its destination to fd 2.
// ES modules hoist imports, so only the order of `import` statements
// matters — no reordering tool should ever move this line.
// ---------------------------------------------------------------------------
import './bootstrap/ensure-stderr-logging.js';

import { randomUUID } from 'node:crypto';

import { AUDIT_QUEUE_KINDS, OutboxWorker } from '@coodra/cli/lib/outbox';
import { ensureGlobalProject, migrateSqlite } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import { env } from './config/env.js';
import type { ContextDeps } from './framework/tool-context.js';
import { ToolRegistry } from './framework/tool-registry.js';
import { createAuthClient } from './lib/auth.js';
import { createContextPackStore } from './lib/context-pack.js';
import { createDbClient } from './lib/db.js';
import { createFeaturePackStore } from './lib/feature-pack.js';
import { createMcpLogger } from './lib/logger.js';
import { createMcpDispatchHandler } from './lib/outbox-dispatch.js';
import { createPolicyClient } from './lib/policy.js';
import { createRunRecorder } from './lib/run-recorder.js';
import { registerAllTools } from './tools/index.js';
import { type HttpTransportHandle, startHttpTransport } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';

const bootLogger = createLogger('mcp-server.boot');

const SERVER_NAME = '@coodra/mcp-server' as const;
const SERVER_VERSION = '0.0.0' as const;

/**
 * Process entrypoint for `@coodra/mcp-server`.
 *
 * S7a scope (walking skeleton + frozen ToolContext):
 *   - stdio transport only (HTTP deferred to S16).
 *   - `ping` tool only (S8–S15 ship the eight real tools).
 *   - Full `ContextDeps` bag wired from `src/lib/*` factories, even
 *     though only `policy` is consumed at call time in S7a. The
 *     remaining lib clients (db, auth, featurePack, contextPack,
 *     runRecorder) exist as stubs that throw
 *     `NotImplementedError` — their bodies fill in across S7b/c.
 *     Wiring them now locks the boot-order contract so S7b/c are
 *     function-body changes, not file additions.
 *
 * Layout invariants locked by this file:
 *   1. `./bootstrap/ensure-stderr-logging.js` is the first import.
 *   2. `env` is read from `./config/env.js` — the one module allowed
 *      to touch `process.env`.
 *   3. Each lib client is constructed via a `createXxx` factory
 *      from `./lib/*`; no module-level singletons cross the
 *      function boundary. This is the user S7a directive.
 *   4. The `ToolRegistry` is constructed once, with the built
 *      `ContextDeps` bag as `options.deps`. Handlers cannot opt out
 *      of policy because they never see an unwrapped call path.
 *   5. Graceful shutdown on SIGINT/SIGTERM — close the transport,
 *      close the DB, flush pino (stderr), exit 0.
 */
async function main(): Promise<void> {
  bootLogger.info(
    {
      event: 'boot',
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      mode: env.COODRA_MODE,
      logDestination: env.COODRA_LOG_DESTINATION,
      nodeEnv: env.NODE_ENV,
    },
    'starting @coodra/mcp-server',
  );

  // --- Build ContextDeps from the lib factories. -----------------------
  // Each `createXxx` is the ONLY entry point through which its
  // subsystem reaches the ToolContext. A swap (e.g. S7b replacing
  // dev-null policy with the cache-backed evaluator) is a single-
  // line change here.
  const sharedLogger = createMcpLogger('root');
  // Local services always write to local SQLite (system-architecture §1).
  // `mode` is an auth-strategy hint that flows through to the auth
  // chain; it does NOT change the DB routing here. Module 03 S4 closed
  // verification §8.3 by removing the previous COODRA_DB_OVERRIDE_MODE
  // stop-gap — the new createDb({ kind: 'local' }) signature makes the
  // override unnecessary.
  const dbClient = createDbClient({ mode: env.COODRA_MODE });
  const dbHandle = dbClient.asInternalHandle();

  // ---------------------------------------------------------------------
  // Auto-migrate at boot. `migrateSqlite` is idempotent (drizzle tracks
  // state in `__drizzle_migrations` and skips already-applied migrations),
  // so re-running on a warm DB is a no-op by row count.
  //
  // mcp-server is a LOCAL service per system-architecture §1 — it always
  // writes to local SQLite. Postgres migration is owned by cloud-side
  // processes (future Sync Daemon, cloud-api) that hold their own
  // `kind: 'cloud'` handles.
  //
  // Closes verification finding §8.1 — fresh users used to get
  // `SQLITE_ERROR: no such table: projects` on the first tool call.
  // ---------------------------------------------------------------------
  if (dbHandle.kind !== 'sqlite') {
    throw new Error(
      `mcp-server requires a local sqlite handle but createDbClient returned kind='${dbHandle.kind}'. This is a wiring bug.`,
    );
  }
  migrateSqlite(dbHandle.db);
  bootLogger.info({ event: 'migrations_applied', kind: dbHandle.kind }, 'migrations idempotent-applied at boot');

  // F7 closure (verification 2026-04-27): seed the __global__ sentinel
  // project so `check_policy` can audit decisions for unregistered
  // projectSlugs without violating policy_decisions.project_id NOT
  // NULL FK. Idempotent.
  await ensureGlobalProject(dbHandle);

  const auth = createAuthClient(env);
  const policy = createPolicyClient({ db: dbHandle });
  const featurePack = createFeaturePackStore({ db: dbHandle });
  const contextPack = createContextPackStore({
    db: dbHandle,
    ...(env.COODRA_CONTEXT_PACKS_ROOT ? { contextPacksRoot: env.COODRA_CONTEXT_PACKS_ROOT } : {}),
  });
  // Module 03.1: durable-outbox worker. Both the bridge and mcp-server
  // run their own worker (OQ2 — drain ownership). They compete via the
  // atomic claim on `pending_jobs`, so each row is dispatched exactly
  // once across the two services.
  const outboxWorker = new OutboxWorker({
    db: dbHandle,
    dispatchHandler: createMcpDispatchHandler({ db: dbHandle }),
    // Module 04a OQ7: mcp-server worker only claims audit queues.
    queueFilter: AUDIT_QUEUE_KINDS,
  });
  const runRecorder = createRunRecorder({ db: dbHandle, kick: () => outboxWorker.kick() });
  outboxWorker.start();
  bootLogger.info({ event: 'outbox_worker_started' }, 'OutboxWorker started; pending_jobs draining');
  // Module 05 reshape (2026-05-08): no sqliteVec wiring — agent-driven NL
  // assembly replaces the embedding pipeline. See
  // docs/feature-packs/05-agent-driven-nl-assembly/spec.md.
  const deps: ContextDeps = Object.freeze({
    db: dbClient.client,
    logger: sharedLogger,
    auth,
    policy,
    featurePack,
    contextPack,
    runRecorder,
  });

  const registry = new ToolRegistry({ deps });
  registerAllTools(registry, { db: dbHandle, mode: env.COODRA_MODE });

  // ---------------------------------------------------------------------
  // Transport selection (S16). `--transport` CLI flag overrides the env
  // setting `MCP_SERVER_TRANSPORT`; default `both`. The flag is parsed
  // here rather than in `config/env.ts` because env-only parsing would
  // make CLI-driven overrides require a wrapper script.
  // ---------------------------------------------------------------------
  const cliTransport = parseTransportFlag(process.argv.slice(2));
  const transportMode = cliTransport ?? env.MCP_SERVER_TRANSPORT;
  const startStdio = transportMode === 'stdio' || transportMode === 'both';
  const startHttp = transportMode === 'http' || transportMode === 'both';

  bootLogger.info(
    { event: 'transport_selection', transportMode, startStdio, startHttp },
    'transport selection resolved',
  );

  // Hyphen separator (not colon) — get_run_id rejects colon-bearing
  // sessionIds because its runId encoding uses `:` as the separator.
  const stdioSessionId = `stdio-${randomUUID()}`;
  const stdioHandle = startStdio
    ? await startStdioTransport({
        registry,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        sessionId: stdioSessionId,
      })
    : null;

  let httpHandle: HttpTransportHandle | null = null;
  if (startHttp) {
    httpHandle = await startHttpTransport({ registry, serverName: SERVER_NAME, serverVersion: SERVER_VERSION, env });
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    bootLogger.info({ event: 'shutdown_signal', signal }, 'shutting down');

    // Module 03.1: stop the OutboxWorker before closing the DB. The
    // worker.stop() awaits any in-flight dispatch so the last audit
    // row lands. Pending (not-yet-picked) rows stay durable in
    // `pending_jobs` for the next process to drain.
    try {
      await outboxWorker.stop();
      bootLogger.info({ event: 'outbox_worker_stopped' }, 'OutboxWorker stopped');
    } catch (err) {
      bootLogger.error(
        { event: 'shutdown_error', subsystem: 'outbox', err: err instanceof Error ? err.message : String(err) },
        'outbox worker stop threw',
      );
    }

    if (httpHandle) {
      try {
        await httpHandle.close();
      } catch (err) {
        bootLogger.error(
          { event: 'shutdown_error', subsystem: 'http', err: err instanceof Error ? err.message : String(err) },
          'http transport close threw',
        );
      }
    }
    if (stdioHandle) {
      try {
        await stdioHandle.close();
      } catch (err) {
        bootLogger.error(
          { event: 'shutdown_error', subsystem: 'stdio', err: err instanceof Error ? err.message : String(err) },
          'stdio transport close threw',
        );
      }
    }
    try {
      await dbClient.client.close();
    } catch (err) {
      bootLogger.error(
        { event: 'shutdown_error', subsystem: 'db', err: err instanceof Error ? err.message : String(err) },
        'db close threw',
      );
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

/**
 * Parse the `--transport stdio|http|both` CLI flag (S16). Returns
 * `null` if the flag is absent (caller falls back to env). Throws on
 * an unrecognised value so a typo at boot fails loudly instead of
 * silently defaulting.
 */
function parseTransportFlag(argv: ReadonlyArray<string>): 'stdio' | 'http' | 'both' | null {
  const idx = argv.findIndex((a) => a === '--transport' || a === '-t');
  let value: string | undefined;
  if (idx >= 0 && idx + 1 < argv.length) {
    value = argv[idx + 1];
  } else {
    const inline = argv.find((a) => a.startsWith('--transport='));
    if (inline) value = inline.slice('--transport='.length);
  }
  if (value === undefined) return null;
  if (value === 'stdio' || value === 'http' || value === 'both') return value;
  throw new Error(`--transport: unrecognised value '${value}' (expected stdio | http | both)`);
}

main().catch((err: unknown) => {
  // Last-ditch error path. We cannot assume the shared logger has
  // wired up yet (it may have thrown on bad env), so write directly
  // to stderr and exit non-zero. Any handler-level error has already
  // been caught inside `registry.handleCall`; reaching here means
  // startup itself failed.
  const message = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  process.stderr.write(`@coodra/mcp-server: fatal startup error\n${message}\n`);
  process.exit(1);
});
