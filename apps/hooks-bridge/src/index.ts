// IMPORTANT: stderr-logging bootstrap MUST run before any other import
// that transitively reaches the shared logger. Keep this as the first
// import in the file.
import './bootstrap/ensure-stderr-logging.js';

import { AUDIT_QUEUE_KINDS, OutboxWorker } from '@coodra/contextos-cli/lib/outbox';
import { ensureGlobalProject, migrateSqlite } from '@coodra/contextos-db';
import { createPolicyClient } from '@coodra/contextos-policy';
import { createLogger } from '@coodra/contextos-shared';
import { serve } from '@hono/node-server';

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createPostToolUseHandler } from './handlers/post-tool-use.js';
import { createPreToolUseHandler } from './handlers/pre-tool-use.js';
import { createSessionEndHandler } from './handlers/session-end.js';
import { createSessionStartHandler } from './handlers/session-start.js';
import { createUserPromptSubmitHandler } from './handlers/user-prompt-submit.js';
import { createHooksBridgeDbClient, resolveSqlitePathFromEnv } from './lib/db.js';
import { composeDispatch } from './lib/dispatch.js';
import { createKillSwitchEvaluator } from './lib/kill-switch-evaluator.js';
import { createBridgeDispatchHandler } from './lib/outbox-dispatch.js';
import { createProjectSlugResolver } from './lib/resolve-project-slug.js';
import { createRunRecorder } from './lib/run-recorder.js';

/**
 * `apps/hooks-bridge/src/index.ts` — boot entry.
 *
 * 1. ensure-stderr-logging (already imported above)
 * 2. parse env (already imported above; throws ValidationError on bad config)
 * 3. open local SQLite handle
 * 4. auto-migrate (idempotent — drizzle tracks state)
 * 5. build Hono app with auth middleware bound to the live env
 * 6. start the listener on env.HOOKS_BRIDGE_HOST:HOOKS_BRIDGE_PORT
 * 7. wire SIGTERM/SIGINT graceful-shutdown that closes the listener
 *    and the DB handle in that order
 */

const bootLogger = createLogger('hooks-bridge.boot');

async function main(): Promise<void> {
  // (3) Open DB.
  const sqlitePath = resolveSqlitePathFromEnv(env);
  const dbClient = createHooksBridgeDbClient({
    mode: env.CONTEXTOS_MODE,
    ...(sqlitePath !== undefined ? { sqlitePath } : {}),
  });

  // (4) Auto-migrate idempotently. Hooks Bridge is a local service per
  // §1, so the handle is always sqlite. Defensive guard catches any
  // future wiring bug before we try to migrate Postgres locally.
  if (dbClient.handle.kind !== 'sqlite') {
    throw new Error(
      `hooks-bridge requires a local sqlite handle but createDb returned kind='${dbClient.handle.kind}'. This is a wiring bug.`,
    );
  }
  migrateSqlite(dbClient.handle.db);
  bootLogger.info({ event: 'migrations_applied', kind: dbClient.handle.kind }, 'migrations idempotent-applied at boot');

  // F7 closure (verification 2026-04-27): seed the __global__ sentinel
  // project so the bridge can audit decisions for unregistered cwds
  // (no .contextos.json) without violating policy_decisions.project_id
  // NOT NULL FK. Idempotent.
  await ensureGlobalProject(dbClient.handle);

  // (4b) Build dispatch chain.
  const policy = createPolicyClient({ db: dbClient.handle });
  const projectSlugResolver = createProjectSlugResolver();

  // (4c) Wire the durable-outbox worker. Module 03.1: every audit
  // write enqueues into pending_jobs via scheduleDurableWrite; the
  // worker drains the queue to its destination tables. The worker
  // is started AFTER the recorder is constructed so the kick()
  // back-channel is ready before the first hook fires.
  const outboxWorker = new OutboxWorker({
    db: dbClient.handle,
    dispatchHandler: createBridgeDispatchHandler({ db: dbClient.handle }),
    // Module 04a OQ7: bridge worker only claims audit queues. Stray
    // `sync_to_cloud` rows are owned by the sync-daemon (M04a S3).
    queueFilter: AUDIT_QUEUE_KINDS,
  });
  const runRecorder = createRunRecorder({
    db: dbClient.handle,
    kick: () => outboxWorker.kick(),
    // M04 Phase 2 S1 (F3 root-cause fix): mode passed so the
    // recorder's defensive implicit session_open uses the right
    // value. Falls back to 'solo' if env.CONTEXTOS_MODE is undefined.
    mode: env.CONTEXTOS_MODE ?? 'solo',
  });
  outboxWorker.start();
  bootLogger.info({ event: 'outbox_worker_started' }, 'OutboxWorker started; pending_jobs draining');
  // Module 08b S2 (2026-05-03): kill-switch evaluator wired BEFORE the
  // policy chain in pre-tool-use. 5s in-process cache so pause/resume
  // feels instantaneous to the operator (the policy client's own 60s
  // cache stays in place for the policy-rule path that runs after).
  const killSwitchEvaluator = createKillSwitchEvaluator({ db: dbClient.handle });
  const preToolUse = createPreToolUseHandler({
    policy,
    projectSlugResolver,
    db: dbClient.handle,
    runRecorder,
    killSwitchEvaluator,
  });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: dbClient.handle });
  const sessionStart = createSessionStartHandler({
    runRecorder,
    projectSlugResolver,
    db: dbClient.handle,
    mode: env.CONTEXTOS_MODE,
  });
  const sessionEnd = createSessionEndHandler({ runRecorder, projectSlugResolver, db: dbClient.handle });
  const userPromptSubmit = createUserPromptSubmitHandler({ runRecorder, projectSlugResolver, db: dbClient.handle });
  const dispatch = composeDispatch({ preToolUse, postToolUse, sessionStart, sessionEnd, userPromptSubmit });

  // (5) Build the app.
  const { hono, serverStartedAt } = buildApp({
    env,
    ...(env.LOCAL_HOOK_SECRET !== undefined ? { localHookSecret: env.LOCAL_HOOK_SECRET } : {}),
    dispatch,
  });

  // (6) Start the listener.
  const server = serve({
    fetch: hono.fetch,
    hostname: env.HOOKS_BRIDGE_HOST,
    port: env.HOOKS_BRIDGE_PORT,
  });
  bootLogger.info(
    {
      event: 'listener_started',
      host: env.HOOKS_BRIDGE_HOST,
      port: env.HOOKS_BRIDGE_PORT,
      mode: env.CONTEXTOS_MODE,
      startedAt: serverStartedAt.toISOString(),
    },
    `hooks-bridge listening on http://${env.HOOKS_BRIDGE_HOST}:${env.HOOKS_BRIDGE_PORT}`,
  );

  // (7) Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLogger.info({ event: 'shutdown_begin', signal }, 'received shutdown signal; closing listener + outbox + db');
    // Close listener first so no new requests start while we drain.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // Stop the outbox worker — awaits any in-flight dispatch so the
    // last audit row lands at the destination before we close the
    // DB. New rows already in pending_jobs (not yet picked) stay
    // durable for the next process to drain.
    await outboxWorker.stop();
    bootLogger.info({ event: 'outbox_worker_stopped' }, 'OutboxWorker stopped');
    await dbClient.close();
    bootLogger.info({ event: 'shutdown_complete' }, 'shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  bootLogger.error(
    { event: 'boot_failed', err: err instanceof Error ? err.message : String(err) },
    'hooks-bridge boot failed',
  );
  process.exit(1);
});
