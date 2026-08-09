import { type DbHandle, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, eq, gte, lt, notExists, sql } from 'drizzle-orm';

/**
 * `packages/lifecycle/src/stale-runs-sweeper.ts` — periodic sweep
 * that cancels `in_progress` runs older than the configured threshold.
 *
 * Moved here from `apps/hooks-bridge` (COOD-62, 2026-08-09). The sweeper
 * needs a LONG-LIVED process. COOD-53 stopped `coodra start` launching
 * the bridge, and nothing in `apps/mcp-server` replaced it — so the
 * sweep simply never ran for any current install and abandoned runs
 * stayed `in_progress` forever. It is now started by the mcp-server
 * daemon, and ONLY on the HTTP transport: the stdio transport is a
 * short-lived per-hook-call subprocess where a `setInterval` would
 * never fire a second tick (and would keep re-running the boot sweep on
 * every single hook call).
 *
 * Why this exists. SessionStart's `abandonStaleInProgressRuns` only
 * fires when a NEW SessionStart hook arrives — it sweeps the same
 * project's prior in_progress rows. But many failure modes leave the
 * row in_progress without a follow-up SessionStart for the same
 * project: laptop sleep mid-session, process crash, dev exits without
 * triggering the Stop hook, direct-MCP smoke tests that never wire
 * the bridge. Without a separate sweeper those rows accumulate and
 * pollute the dashboard / runs list indefinitely.
 *
 * Behaviour:
 *   - Every `intervalMs` (default 15 min) the sweeper UPDATEs every
 *     run with `status='in_progress' AND started_at < (now - thresholdSec)`
 *     AND **no run_event newer than the cutoff** to
 *     `status='cancelled', ended_at=now()`.
 *   - Threshold defaults to 30 min. The recent-activity guard is
 *     load-bearing: the original started_at-only predicate cancelled a
 *     LIVE 40-minute QA session that had written an mcp_call event one
 *     minute earlier (2026-07-24). A long session keeps producing
 *     run_events (hook posts + instrumented MCP calls), so "no events
 *     since the cutoff" is the honest definition of stuck.
 *   - Logs a structured row when any rows are cancelled.
 *
 * Failure mode: if the DB throws, the error is logged + swallowed.
 * The bridge's hot path is unaffected.
 */

const sweeperLogger = createLogger('lifecycle.stale-runs-sweeper');

export interface StaleRunsSweeperOptions {
  readonly db: DbHandle;
  /** Threshold in seconds. Runs older than this with status='in_progress' get cancelled. Default 1800 (30 min). */
  readonly thresholdSec?: number;
  /** Sweep interval in ms. Default 900_000 (15 min). */
  readonly intervalMs?: number;
}

export interface StaleRunsSweeperHandle {
  /** Stop the timer + wait for any in-flight sweep to settle. */
  stop(): Promise<void>;
  /** Trigger an immediate sweep (for tests + manual triggers). */
  sweepOnce(): Promise<{ cancelled: number }>;
}

const DEFAULT_THRESHOLD_SEC = 1800;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export function startStaleRunsSweeper(opts: StaleRunsSweeperOptions): StaleRunsSweeperHandle {
  const thresholdSec = opts.thresholdSec ?? DEFAULT_THRESHOLD_SEC;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<{ cancelled: number }> | null = null;
  let stopped = false;

  async function sweepOnce(): Promise<{ cancelled: number }> {
    if (opts.db.kind !== 'sqlite') {
      // v1 supports SQLite only. Postgres team-mode bridges (none yet)
      // would route through the same `cancelled = update.changes` path.
      return { cancelled: 0 };
    }
    try {
      const cutoff = Math.floor(Date.now() / 1000) - thresholdSec;
      const cutoffDate = new Date(cutoff * 1000);
      const t = sqliteSchema.runs;
      const re = sqliteSchema.runEvents;
      const result = await opts.db.db
        .update(t)
        .set({ status: 'cancelled', endedAt: sql`(unixepoch())` })
        .where(
          and(
            eq(t.status, 'in_progress'),
            lt(t.startedAt, cutoffDate),
            // Spare runs that are still ACTIVE: any run_event since the
            // cutoff proves the session is alive regardless of its age.
            notExists(
              opts.db.db
                .select({ one: sql`1` })
                .from(re)
                .where(and(eq(re.runId, t.id), gte(re.createdAt, cutoffDate))),
            ),
          ),
        );
      const cancelled = (result as { changes?: number } | undefined)?.changes ?? 0;
      if (cancelled > 0) {
        sweeperLogger.info(
          {
            event: 'stale_runs_swept',
            cancelled,
            thresholdSec,
          },
          `cancelled ${cancelled} stuck in_progress run(s) (>${thresholdSec}s old)`,
        );
      }
      return { cancelled };
    } catch (err) {
      sweeperLogger.warn(
        {
          event: 'stale_runs_sweeper_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'stale-runs sweeper threw; will retry on next interval',
      );
      return { cancelled: 0 };
    }
  }

  function tick() {
    if (stopped) return;
    inFlight = sweepOnce();
    inFlight.finally(() => {
      inFlight = null;
    });
  }

  // Fire one immediate sweep on boot — catches whatever stuck rows
  // accumulated while the bridge was down.
  inFlight = sweepOnce();
  inFlight.finally(() => {
    inFlight = null;
  });

  // Then schedule the periodic timer. .unref() so the host process's
  // exit doesn't wait for the next tick.
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  sweeperLogger.info(
    {
      event: 'stale_runs_sweeper_started',
      thresholdSec,
      intervalMs,
    },
    'stale-runs sweeper started',
  );

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight.catch(() => {});
      }
    },
    sweepOnce,
  };
}
