// IMPORTANT: stderr-logging bootstrap MUST run before any other import
// that transitively reaches the shared logger.
import './bootstrap/ensure-stderr-logging.js';

import { OutboxWorker } from '@coodra/cli/lib/outbox';
import { createDb, migrateSqlite, type PostgresHandle, type SqliteHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import { env } from './config/env.js';
import { createSyncDispatchHandler } from './lib/dispatch.js';
import { createKillSwitchPuller } from './lib/kill-switch-puller.js';
import { createTeamRowsPuller } from './lib/team-rows-puller.js';

/**
 * `apps/sync-daemon/src/index.ts` — boot entry.
 *
 * 1. Open local SQLite handle (the audit-row source of truth).
 * 2. Open cloud Postgres handle from `DATABASE_URL`.
 * 3. Construct an OutboxWorker filtered to `sync_to_cloud` rows. The
 *    worker drains rows that the bridge + mcp-server enqueue alongside
 *    each audit write (M04a S2 paired-job pattern).
 * 4. Start the worker. Block on SIGTERM/SIGINT for graceful shutdown:
 *    stop the worker (await in-flight dispatch) then close both
 *    handles.
 *
 * The sync-daemon idempotently applies LOCAL SQLite migrations at boot
 * (F10, 2026-07-04). It used to rely on the bridge + mcp-server migrating
 * first; on a daemon-first boot against a fresh COODRA_HOME that left it
 * warning `no such table: runs/decisions/...` on every tick until another
 * service migrated. `migrateSqlite` is idempotent (drizzle tracks state),
 * so applying here converges the daemon regardless of boot order. Cloud
 * Postgres migrations are still run out-of-band by `coodra cloud-migrate`
 * (M04a S1) before the daemon starts.
 */

const bootLogger = createLogger('sync-daemon.boot');

async function main(): Promise<void> {
  // (1) Local SQLite handle.
  const localDbHandle = createDb({ kind: 'local' });
  if (localDbHandle.kind !== 'sqlite') {
    throw new Error(
      `sync-daemon requires a local sqlite handle but createDb returned kind='${localDbHandle.kind}'. This is a wiring bug.`,
    );
  }
  const localDb: SqliteHandle = localDbHandle;
  bootLogger.info({ event: 'local_db_opened', kind: localDb.kind }, 'local sqlite handle opened');

  // F10 (2026-07-04): idempotently ensure the local schema exists so a
  // daemon-first boot against a fresh COODRA_HOME doesn't spin warning
  // "no such table" until another service migrates. No-op on a warm DB.
  try {
    migrateSqlite(localDb.db);
    bootLogger.info({ event: 'local_migrations_applied' }, 'local sqlite migrations idempotent-applied at boot');
  } catch (err) {
    // Non-fatal: a concurrent migrator (mcp-server booting at the same
    // instant) may hold the write lock. The pullers retry every tick, and
    // the next boot re-applies. Log and continue rather than crash-loop.
    bootLogger.warn(
      { event: 'local_migrations_failed', err: err instanceof Error ? err.message : String(err) },
      'local sqlite migration at boot failed; pullers will retry as schema becomes available',
    );
  }

  // (2) Cloud Postgres handle.
  const cloudDbHandle = createDb({ kind: 'cloud', postgres: { databaseUrl: env.DATABASE_URL } });
  if (cloudDbHandle.kind !== 'postgres') {
    throw new Error(
      `sync-daemon requires a cloud postgres handle but createDb returned kind='${cloudDbHandle.kind}'. This is a wiring bug.`,
    );
  }
  const cloudDb: PostgresHandle = cloudDbHandle;
  bootLogger.info({ event: 'cloud_db_opened', kind: cloudDb.kind }, 'cloud postgres handle opened');

  // (3) Worker filtered to sync_to_cloud queue. M04a OQ7: each worker
  // filters by queue type so bridge/MCP audit-write rows can never be
  // claimed here, and our sync rows can never be claimed by them.
  const worker = new OutboxWorker({
    db: localDb,
    dispatchHandler: createSyncDispatchHandler({ localDb, cloudDb }),
    queueFilter: ['sync_to_cloud'],
    tickMs: env.COODRA_SYNC_TICK_MS,
    leaseMs: env.COODRA_SYNC_LEASE_MS,
  });

  worker.start();
  bootLogger.info(
    {
      event: 'sync_worker_started',
      tickMs: env.COODRA_SYNC_TICK_MS,
      leaseMs: env.COODRA_SYNC_LEASE_MS,
    },
    'sync-daemon: OutboxWorker started; sync_to_cloud queue draining',
  );

  // (4) M04 S8a — kill_switches cloud → local poller (extends M04a OQ-1
  // from one-way push to bidirectional sync). Polls cloud every 5s
  // (configurable via COODRA_SYNC_TICK_MS); upserts new rows into
  // local SQLite by id; never deletes (resumed rows are soft-flipped).
  const killSwitchPuller = createKillSwitchPuller({
    localDb,
    cloudDb,
    intervalMs: env.COODRA_SYNC_TICK_MS,
  });
  bootLogger.info(
    { event: 'kill_switch_puller_started', intervalMs: env.COODRA_SYNC_TICK_MS },
    'sync-daemon: kill_switches cloud → local poller started (M04 S8a)',
  );

  // (4b) Module 04 Phase 4 — bidirectional sync for the append-only
  // tables that drive cross-team-member visibility (Caveat 1 fix from
  // the team-mode plan). Without this, member A's decision is invisible
  // to member B's local MCP server, and the M05 SessionStart recent-
  // decisions injection silently misses the org-wide history.
  const teamRowsPuller = createTeamRowsPuller({
    localDb,
    cloudDb,
    intervalMs: env.COODRA_SYNC_TICK_MS,
  });
  bootLogger.info(
    { event: 'team_rows_puller_started', intervalMs: env.COODRA_SYNC_TICK_MS },
    'sync-daemon: runs/decisions/context_packs/run_events cloud → local poller started (M04 Phase 4 / Caveat 1)',
  );

  // (5) Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLogger.info({ event: 'shutdown_begin', signal }, 'received shutdown signal; stopping worker + closing handles');
    await worker.stop();
    bootLogger.info({ event: 'sync_worker_stopped' }, 'OutboxWorker stopped');
    await killSwitchPuller.stop();
    bootLogger.info({ event: 'kill_switch_puller_stopped' }, 'kill_switches puller stopped');
    await teamRowsPuller.stop();
    bootLogger.info({ event: 'team_rows_puller_stopped' }, 'team-rows puller stopped');
    localDb.close();
    await cloudDb.close();
    bootLogger.info({ event: 'shutdown_complete' }, 'shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  bootLogger.error(
    { event: 'boot_failed', err: err instanceof Error ? err.message : String(err) },
    'sync-daemon boot failed',
  );
  process.exit(1);
});
