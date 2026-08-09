import { type DbHandle, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, eq, gte, ne, notExists, sql } from 'drizzle-orm';

/**
 * `packages/lifecycle/src/abandon-stale-runs.ts` — Phase 4 Fix J
 * (Slice 8 — 2026-05-03 audit §14.3).
 *
 * Moved here from `apps/hooks-bridge` (COOD-62, 2026-08-09) so the
 * native `lifecycle_event` SessionStart path gets the same cleanup.
 * Before the move it was bridge-only, and COOD-53 had already routed
 * every supported agent away from the bridge.
 *
 * Background: pre-Fix-G the bridge had no SessionEnd hook registered
 * in `~/.claude/settings.json` (Slice 2 closed that). When a session
 * terminated without firing SessionEnd, its `runs` row stayed
 * `status='in_progress'` indefinitely. Six such orphans were observed
 * in the demo DB at audit time. With Fix G in place, NEW sessions
 * close cleanly via SessionEnd — but pre-existing orphans persist
 * forever, and edge cases (agent crash, terminal kill, force-quit)
 * still leave runs unfinished.
 *
 * This helper closes the long-tail case via SessionStart-time cleanup:
 * when a new session opens for a project, any prior `in_progress`
 * runs for the SAME project (other session ids) get marked
 * `status='abandoned'` with `ended_at = now()`. The new session's
 * own row is excluded by `session_id != ?` so the bridge's outbox
 * insert (which may be racing) is never clobbered.
 *
 * Recent-activity guard (2026-07-24 QA sweep): the original predicate
 * had NO age or activity check, so opening a second terminal on the
 * same project would insta-abandon the FIRST terminal's live run.
 * A run with any run_event inside the activity window (same 30-min
 * default as the periodic sweeper) is spared — a genuinely orphaned
 * run stops producing events, and the periodic sweeper still reaps
 * it once the window passes.
 *
 * Failure mode: errors are logged at WARN and swallowed. Stale
 * orphans are noise, not load-bearing data — the SessionStart
 * response is more important than this cleanup completing. The
 * caller should `void abandonStaleInProgressRuns(...)` (fire-and-
 * forget) so the handler returns within the §8 latency budget.
 *
 * SQLite-only for v1 (parity with auto-context-pack). Postgres-mode
 * bridges (none ship in v1) would route through the same
 * type-discriminator with `postgresSchema.runs`.
 */

const abandonLogger = createLogger('lifecycle.abandon-stale-runs');

export interface AbandonStaleInProgressRunsInput {
  readonly db: DbHandle;
  readonly projectId: string;
  /** session_id of the run that just opened — exclude it from the sweep. */
  readonly excludeSessionId: string;
  /**
   * Activity window in seconds — a run with any run_event newer than
   * `now - activityWindowSec` is considered LIVE and never abandoned.
   * Default 1800 (30 min), matching the periodic stale-runs sweeper.
   */
  readonly activityWindowSec?: number;
}

export interface AbandonStaleInProgressRunsResult {
  readonly abandoned: number;
}

export async function abandonStaleInProgressRuns(
  input: AbandonStaleInProgressRunsInput,
): Promise<AbandonStaleInProgressRunsResult> {
  if (input.db.kind !== 'sqlite') {
    abandonLogger.warn(
      { event: 'abandon_stale_runs_unsupported_db_kind', kind: input.db.kind },
      'abandon-stale-runs skipped: only sqlite is supported in v1',
    );
    return { abandoned: 0 };
  }
  const runs = sqliteSchema.runs;
  const runEvents = sqliteSchema.runEvents;
  const activityWindowSec = input.activityWindowSec ?? 1800;
  const activityCutoff = new Date((Math.floor(Date.now() / 1000) - activityWindowSec) * 1000);
  // Use raw `unixepoch()` for ended_at so the value lines up with the
  // schema's default-timestamp column type (the runs table stores
  // `started_at` / `ended_at` as `integer mode:'timestamp'`, which
  // round-trips unix-seconds via better-sqlite3).
  const result = await input.db.db
    .update(runs)
    .set({ status: 'abandoned', endedAt: sql`(unixepoch())` })
    .where(
      and(
        eq(runs.projectId, input.projectId),
        eq(runs.status, 'in_progress'),
        ne(runs.sessionId, input.excludeSessionId),
        // Spare LIVE concurrent sessions: recent run_events prove the run
        // is still producing work (see header — 2026-07-24 QA guard).
        notExists(
          input.db.db
            .select({ one: sql`1` })
            .from(runEvents)
            .where(and(eq(runEvents.runId, runs.id), gte(runEvents.createdAt, activityCutoff))),
        ),
      ),
    );
  // better-sqlite3 returns `{ changes, lastInsertRowid }` on .run() — drizzle
  // exposes this as the result. Best-effort count for telemetry; absence
  // of the field shouldn't fail the call.
  const abandoned = (result as { changes?: number } | undefined)?.changes ?? 0;
  if (abandoned > 0) {
    abandonLogger.info(
      {
        event: 'stale_runs_abandoned_at_session_start',
        projectId: input.projectId,
        excludeSessionId: input.excludeSessionId,
        count: abandoned,
      },
      `abandoned ${abandoned} stale in_progress run(s) on SessionStart`,
    );
  }
  return { abandoned };
}
