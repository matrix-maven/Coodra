import { type PostgresHandle, postgresSchema, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { createLogger, type Logger } from '@coodra/shared';
import { gt, sql } from 'drizzle-orm';

/**
 * `apps/sync-daemon/src/lib/kill-switch-puller.ts` — M04 S8a
 *
 * Cloud → local poller for `kill_switches`. Extends M04a OQ-1
 * explicitly (M04a was push-only; M04 starts bidirectional sync).
 *
 * Algorithm (per spec §10):
 *   - Every `intervalMs` (default 5000), SELECT every cloud row
 *     whose `paused_at > local_max(paused_at)`.
 *   - Upsert each into local SQLite by id (insert or update; never
 *     delete — resumed rows are soft-flipped via `resumed_at`).
 *   - Track + log a `sync_daemon_kill_switches_pulled` event with
 *     count per tick.
 *
 * Conflict semantics:
 *   - id is the conflict target. Cloud values win on every field
 *     that mutates (resumed_at, resumed_by_session_id, expires_at).
 *   - Immutable fields (scope/target/mode/reason/paused_*) are set
 *     on insert and ignored on update.
 *
 * Failure posture:
 *   - Cloud unreachable → log WARN, retry on next interval. Local
 *     pause/resume continues to work against local SQLite.
 *   - Local insert throws → log WARN per row, continue. Next tick
 *     re-tries (rows are upsert by id; idempotent).
 *
 * Local pauses with `--no-sync` (set `paused_by_session_id` prefix
 * `local-only:`) are filtered on the PUSH side (the dispatch
 * handler skips them via the outbox-job filter), so they never
 * reach cloud. The puller pulls everything cloud has — locally-
 * paused-locally-only rows naturally don't conflict with cloud.
 */

export interface KillSwitchPullerDeps {
  readonly localDb: SqliteHandle;
  readonly cloudDb: PostgresHandle;
  readonly intervalMs?: number;
  readonly logger?: Logger;
}

export interface KillSwitchPullerHandle {
  readonly stop: () => Promise<void>;
  readonly tickOnce: () => Promise<{ readonly pulled: number; readonly upserted: number }>;
}

export function createKillSwitchPuller(deps: KillSwitchPullerDeps): KillSwitchPullerHandle {
  if (deps.localDb.kind !== 'sqlite') {
    throw new TypeError('createKillSwitchPuller: localDb must be a SqliteHandle');
  }
  if (deps.cloudDb.kind !== 'postgres') {
    throw new TypeError('createKillSwitchPuller: cloudDb must be a PostgresHandle');
  }
  const log = deps.logger ?? createLogger('sync-daemon.kill-switch-puller');
  const intervalMs = deps.intervalMs ?? 5_000;
  const localDb = deps.localDb;
  const cloudDb = deps.cloudDb;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function tickOnce(): Promise<{ pulled: number; upserted: number }> {
    // 1. Find local high-water-mark.
    const lt = sqliteSchema.killSwitches;
    const ct = postgresSchema.killSwitches;
    const maxRow = (await localDb.db.select({ maxPausedAt: sql<Date | null>`MAX(${lt.pausedAt})` }).from(lt))[0];
    const since = maxRow?.maxPausedAt ?? new Date(0);

    // 2. Pull cloud rows newer than local max.
    let cloudRows: (typeof ct.$inferSelect)[];
    try {
      cloudRows = await cloudDb.db.select().from(ct).where(gt(ct.pausedAt, since));
    } catch (err) {
      log.warn(
        { event: 'sync_daemon_kill_switches_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT threw — will retry next tick',
      );
      return { pulled: 0, upserted: 0 };
    }

    if (cloudRows.length === 0) {
      log.debug({ event: 'sync_daemon_kill_switches_pulled', count: 0 }, 'no new kill_switches in cloud');
      return { pulled: 0, upserted: 0 };
    }

    // 3. Upsert each into local. Use raw SQL upsert because
    // better-sqlite3 + drizzle's `.onConflictDoUpdate` requires the
    // conflict target wired through the schema; a single INSERT OR
    // REPLACE is simpler and equivalent for this table (no triggers).
    let upserted = 0;
    for (const row of cloudRows) {
      try {
        const stmt = localDb.raw.prepare(`
          INSERT INTO kill_switches
            (id, scope, target, mode, reason, paused_at, paused_by_session_id,
             expires_at, resumed_at, resumed_by_session_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            resumed_at = excluded.resumed_at,
            resumed_by_session_id = excluded.resumed_by_session_id,
            expires_at = excluded.expires_at
        `);
        stmt.run(
          row.id,
          row.scope,
          row.target,
          row.mode,
          row.reason,
          Math.floor(row.pausedAt.getTime() / 1000),
          row.pausedBySessionId,
          row.expiresAt === null ? null : Math.floor(row.expiresAt.getTime() / 1000),
          row.resumedAt === null ? null : Math.floor(row.resumedAt.getTime() / 1000),
          row.resumedBySessionId,
        );
        upserted += 1;
      } catch (err) {
        log.warn(
          {
            event: 'sync_daemon_kill_switches_upsert_failed',
            killSwitchId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local kill_switches upsert threw — will re-pull next tick',
        );
      }
    }

    log.info(
      { event: 'sync_daemon_kill_switches_pulled', count: cloudRows.length, upserted },
      `pulled ${cloudRows.length} kill_switches row(s) from cloud (${upserted} upserted locally)`,
    );
    return { pulled: cloudRows.length, upserted };
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tickOnce()
        .catch((err) => {
          log.warn(
            { event: 'sync_daemon_kill_switches_tick_threw', err: err instanceof Error ? err.message : String(err) },
            'tickOnce threw — will retry next interval',
          );
        })
        .finally(() => scheduleNext());
    }, intervalMs);
  }

  // Kick off the first tick immediately so a fresh boot doesn't wait
  // intervalMs to surface state.
  void tickOnce()
    .catch((err) => {
      log.warn(
        {
          event: 'sync_daemon_kill_switches_initial_tick_threw',
          err: err instanceof Error ? err.message : String(err),
        },
        'initial tickOnce threw',
      );
    })
    .finally(() => scheduleNext());

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    tickOnce,
  };
}
