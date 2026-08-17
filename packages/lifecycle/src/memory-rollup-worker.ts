import type { DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { sql } from 'drizzle-orm';

/**
 * `packages/lifecycle/src/memory-rollup-worker` — COOD-79.
 *
 * Rolls `memory_access_events` up into the two read models the
 * dashboard (COOD-87) actually queries, then prunes raw rows past the
 * retention window.
 *
 * Why this ships WITH the table rather than after the dashboard:
 * `memory_access_events` is the highest-volume table in the schema —
 * roughly five push rows per prompt plus every pull, carried in a local
 * SQLite file for solo users. Landing the writer without the reaper
 * hands the dashboard an unbounded event table and degrades exactly the
 * long-running projects this epic exists to serve.
 *
 * ## The two rollups, and why one grain cannot serve both
 *
 * `memory_access_daily` — volume and cost, grained on
 * (project, day, channel, site, memory_type). Answers "how much did we
 * surface, at what byte and latency cost, how much of it was stale".
 *
 * **No percentiles.** p50/p95 do not re-aggregate from stored
 * aggregates: the average of daily p95s is not the p95 of the union,
 * and it produces confidently wrong numbers. `total_latency_ms` +
 * `access_count` gives an exact mean and `max_latency_ms` an exact max;
 * both compose across days. Fixed histogram buckets are the upgrade
 * path if real percentiles are ever wanted.
 *
 * `memory_cohorts` — identity and pull-through, grained on
 * (run, baseline_generation, memory_type, memory_id). The daily grain
 * loses `memory_id` and so cannot answer the north-star question:
 * *this manifest entry was shown — was this specific body then pulled?*
 *
 * Keying on `baseline_generation` is load-bearing. After a compaction
 * re-emits the manifest (COOD-84) the next pull belongs to the NEW
 * cohort; without the key, post-compaction pulls would be credited to
 * the original manifest and pull-through would read artificially high
 * on exactly the long sessions this epic exists to fix.
 *
 * ## Prune invariant
 *
 * **A raw row is never deleted until its day is rolled up.** Pruning
 * must not silently erase history from the dashboard, so the DELETE is
 * guarded by an EXISTS against `memory_access_daily` for the same
 * (project, day). A day that failed to roll up simply retains its raw
 * rows until it succeeds — bounded growth, no data loss.
 *
 * Cohort rows outlive raw events on purpose: one row per item per
 * generation is small, and dead-memory detection ("never surfaced
 * again") needs months of history that a 30-day raw window would
 * destroy.
 *
 * ## Transport
 *
 * Started by the mcp-server daemon on the **HTTP transport only**, the
 * same constraint `startStaleRunsSweeper` documents: the stdio
 * transport is a short-lived per-hook subprocess where a `setInterval`
 * never fires a second tick and the boot pass would re-run on every
 * single hook call.
 *
 * v1 is SQLite-only, matching the stale-runs sweeper. Team-mode
 * Postgres rollups would run in the cloud against the synced tables,
 * not from a developer's laptop.
 */

const rollupLogger = createLogger('lifecycle.memory-rollup');

/** Solo default. Team/cloud retention is a separate policy and may be longer. */
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface MemoryRollupWorkerOptions {
  readonly db: DbHandle;
  /** Raw-event retention in days. Default 30. */
  readonly retentionDays?: number;
  /** Run interval in ms. Default 1h. */
  readonly intervalMs?: number;
}

export interface MemoryRollupResult {
  readonly dailyRows: number;
  readonly cohortRows: number;
  readonly pruned: number;
}

export interface MemoryRollupWorkerHandle {
  stop(): Promise<void>;
  /** Trigger an immediate pass (tests + manual triggers). */
  runOnce(): Promise<MemoryRollupResult>;
}

/**
 * Recompute both rollups over every **completed** day present in the
 * raw table, then prune.
 *
 * Recomputing rather than incrementally accumulating keeps the pass
 * idempotent: a crash mid-run, a redelivered outbox row landing late,
 * or a manual re-trigger all converge on the same numbers. Today's
 * partial day is deliberately excluded — a half-day rollup would be
 * indistinguishable from a complete one once written.
 */
export async function runMemoryRollupOnce(
  db: DbHandle,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<MemoryRollupResult> {
  if (db.kind !== 'sqlite') {
    return { dailyRows: 0, cohortRows: 0, pruned: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);

  // Recompute is delete-then-insert, NOT upsert.
  //
  // `project_id` and `run_id` are both nullable, and SQLite (like the
  // SQL standard) treats NULLs as distinct inside a UNIQUE index — so
  // `ON CONFLICT (project_id, day, ...)` never fires for an
  // unattributed row and every pass would append a duplicate. Deleting
  // the slice we are about to recompute is NULL-safe and keeps the pass
  // idempotent for attributed and unattributed rows alike.
  //
  // The DELETEs are scoped to grains that still have raw rows, so
  // rollups for already-pruned days survive — that is what lets cohort
  // history outlive the raw retention window.

  // ---- (a) memory_access_daily -------------------------------------
  //
  // `distinct_items` counts DISTINCT memory_id, which SQLite evaluates
  // ignoring NULLs — so a zero-result search contributes to
  // access_count (it happened) without inflating item counts (there was
  // no item). That asymmetry is intentional: empty-answer rate is
  // access_count minus distinct_items at the wiki_ask site.
  await db.db.run(sql`
    DELETE FROM memory_access_daily
    WHERE day IN (
      SELECT DISTINCT strftime('%Y-%m-%d', created_at, 'unixepoch')
      FROM memory_access_events
      WHERE strftime('%Y-%m-%d', created_at, 'unixepoch') < ${today}
    )
  `);
  const dailyRows = await db.db.run(sql`
    INSERT INTO memory_access_daily (
      id, org_id, project_id, day, channel, site, memory_type, actor_user_id,
      access_count, distinct_items, distinct_runs,
      total_bytes, total_latency_ms, max_latency_ms, stale_at_access_count,
      created_at, updated_at
    )
    SELECT
      lower(hex(randomblob(16))),
      MAX(org_id),
      project_id,
      strftime('%Y-%m-%d', created_at, 'unixepoch') AS day,
      channel,
      site,
      memory_type,
      -- COOD-99: solo mode has no Clerk actor, so NULL folds to the
      -- 'local' sentinel. Keeping NULL would put a NULL in the grain
      -- UNIQUE index, where SQL treats NULLs as distinct -- the COOD-79
      -- trap this worker already recomputes around.
      COALESCE(actor_user_id, 'local'),
      COUNT(*),
      COUNT(DISTINCT memory_id),
      COUNT(DISTINCT run_id),
      COALESCE(SUM(bytes), 0),
      COALESCE(SUM(latency_ms), 0),
      COALESCE(MAX(latency_ms), 0),
      SUM(CASE WHEN freshness_status_at_access IS NOT NULL
                AND freshness_status_at_access <> 'fresh' THEN 1 ELSE 0 END),
      unixepoch(),
      unixepoch()
    FROM memory_access_events
    WHERE strftime('%Y-%m-%d', created_at, 'unixepoch') < ${today}
    GROUP BY project_id, day, channel, site, memory_type, COALESCE(actor_user_id, 'local')
  `);

  // ---- (b) memory_cohorts ------------------------------------------
  //
  // Only rows carrying a memory_id produce cohorts: a zero-result
  // search is a real access event but has no item whose pull-through
  // could be measured.
  //
  // Unlike the daily rollup this is NOT restricted to completed days —
  // a cohort spans whatever window the run spans, and waiting for
  // midnight would hide today's pull-through entirely.
  await db.db.run(sql`
    DELETE FROM memory_cohorts
    WHERE EXISTS (
      SELECT 1 FROM memory_access_events e
      WHERE e.run_id = memory_cohorts.run_id
        AND e.baseline_generation = memory_cohorts.baseline_generation
        AND e.memory_type = memory_cohorts.memory_type
        AND e.memory_id = memory_cohorts.memory_id
    )
  `);
  const cohortRows = await db.db.run(sql`
    INSERT INTO memory_cohorts (
      id, org_id, project_id, run_id, baseline_generation, memory_type, memory_id,
      surfaced_count, pulled_count, first_surfaced_at, first_pulled_at,
      time_to_first_pull_ms, stale_at_access, created_at, updated_at
    )
    SELECT
      lower(hex(randomblob(16))),
      MAX(org_id),
      MAX(project_id),
      run_id,
      baseline_generation,
      memory_type,
      memory_id,
      SUM(CASE WHEN channel = 'push' THEN 1 ELSE 0 END),
      SUM(CASE WHEN channel = 'pull' THEN 1 ELSE 0 END),
      MIN(CASE WHEN channel = 'push' THEN created_at END),
      MIN(CASE WHEN channel = 'pull' THEN created_at END),
      CASE
        WHEN MIN(CASE WHEN channel = 'push' THEN created_at END) IS NOT NULL
         AND MIN(CASE WHEN channel = 'pull' THEN created_at END) IS NOT NULL
        THEN (MIN(CASE WHEN channel = 'pull' THEN created_at END)
              - MIN(CASE WHEN channel = 'push' THEN created_at END)) * 1000
      END,
      MAX(CASE WHEN freshness_status_at_access IS NOT NULL
                AND freshness_status_at_access <> 'fresh' THEN 1 ELSE 0 END),
      unixepoch(),
      unixepoch()
    FROM memory_access_events
    WHERE memory_id IS NOT NULL AND run_id IS NOT NULL
    GROUP BY run_id, baseline_generation, memory_type, memory_id
  `);

  // ---- (c) prune, guarded by the invariant -------------------------
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const pruned = await db.db.run(sql`
    DELETE FROM memory_access_events
    WHERE strftime('%Y-%m-%d', created_at, 'unixepoch') < ${cutoff}
      AND EXISTS (
        SELECT 1 FROM memory_access_daily d
        WHERE d.day = strftime('%Y-%m-%d', memory_access_events.created_at, 'unixepoch')
          AND (d.project_id IS memory_access_events.project_id)
      )
  `);

  const result: MemoryRollupResult = {
    dailyRows: changesOf(dailyRows),
    cohortRows: changesOf(cohortRows),
    pruned: changesOf(pruned),
  };
  if (result.dailyRows > 0 || result.cohortRows > 0 || result.pruned > 0) {
    rollupLogger.info(
      { event: 'memory_rollup_pass', ...result, retentionDays },
      `memory rollup: ${result.dailyRows} daily, ${result.cohortRows} cohort, ${result.pruned} pruned`,
    );
  }
  return result;
}

function changesOf(result: unknown): number {
  return (result as { changes?: number } | undefined)?.changes ?? 0;
}

export function startMemoryRollupWorker(opts: MemoryRollupWorkerOptions): MemoryRollupWorkerHandle {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<MemoryRollupResult> | null = null;
  let stopped = false;

  async function runOnce(): Promise<MemoryRollupResult> {
    try {
      return await runMemoryRollupOnce(opts.db, retentionDays);
    } catch (err) {
      // Swallowed by design, exactly as the stale-runs sweeper does:
      // telemetry maintenance must never take down the host process or
      // interfere with a live session. The next tick retries.
      rollupLogger.warn(
        { event: 'memory_rollup_error', err: err instanceof Error ? err.message : String(err) },
        'memory rollup pass threw; will retry on next interval',
      );
      return { dailyRows: 0, cohortRows: 0, pruned: 0 };
    }
  }

  function tick() {
    if (stopped) return;
    inFlight = runOnce();
    inFlight.finally(() => {
      inFlight = null;
    });
  }

  // One pass on boot — catches whatever accumulated while down.
  inFlight = runOnce();
  inFlight.finally(() => {
    inFlight = null;
  });

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  rollupLogger.info(
    { event: 'memory_rollup_worker_started', retentionDays, intervalMs },
    'memory rollup worker started',
  );

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight.catch(() => {});
    },
    runOnce,
  };
}
