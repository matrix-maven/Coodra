import { and, desc, eq, sql } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/lookup-run` — shared `(projectId, sessionId) → runs.id`
 * resolver used by every component that has to attach a `runs.id` to an
 * audit row but does not own the `runs` table itself.
 *
 * Verification F8 (2026-04-27) surfaced that the hooks-bridge's
 * `scheduleRunEventInsert` was calling its in-file lookupRunId with
 * `projectSlug = undefined` — a hardcoded short-circuit that made every
 * `run_events` row write `run_id IS NULL`. The fix lifts the working
 * MCP-side `selectLatestRun` shape into a shared helper so:
 *
 *   - The bridge's RunRecorder can resolve `runs.id` correctly when the
 *     pre-tool / post-tool / user-prompt handler has projectId in scope.
 *   - The MCP `get_run_id` tool keeps its richer local helper
 *     (`selectLatestRun` returns id + status + startedAt) but can be
 *     refactored to delegate to this when the wider shape is not
 *     needed.
 *
 * Returns the most-recently-started run's id for the (project, session)
 * pair, or `null` on miss or any DB error. The runs table has a unique
 * index on (projectId, sessionId) so there is at most one active row;
 * the `desc(startedAt)` order is defensive against a future relaxation.
 */
export async function lookupRunId(db: DbHandle, projectId: string, sessionId: string): Promise<string | null> {
  try {
    if (db.kind === 'sqlite') {
      const rows = await db.db
        .select({ id: sqliteSchema.runs.id })
        .from(sqliteSchema.runs)
        .where(and(eq(sqliteSchema.runs.projectId, projectId), eq(sqliteSchema.runs.sessionId, sessionId)))
        .orderBy(desc(sqliteSchema.runs.startedAt))
        .limit(1);
      return rows[0]?.id ?? null;
    }
    const rows = await db.db
      .select({ id: postgresSchema.runs.id })
      .from(postgresSchema.runs)
      .where(and(eq(postgresSchema.runs.projectId, projectId), eq(postgresSchema.runs.sessionId, sessionId)))
      .orderBy(desc(postgresSchema.runs.startedAt))
      .limit(1);
    return rows[0]?.id ?? null;
  } catch {
    // Audit-only path — caller writes runId=null when lookup fails. The
    // FK on run_events.run_id is nullable + ON DELETE SET NULL precisely
    // for this case (§4.3).
    return null;
  }
}

/**
 * COOD-83 — resolve a run from `sessionId` ALONE.
 *
 * `lookupRunId` needs a `projectId` because the unique index is
 * `(projectId, sessionId)`. That works for tools whose input carries a
 * `projectSlug` scope argument — which is all of them except
 * `read_context_pack`, whose schema is `.strict()` with exactly one of
 * `packId` / `runId` and no project scope at all.
 *
 * Without this fallback, `read_context_pack` — the single most
 * important pull for measuring manifest pull-through (COOD-83) —
 * would write an unattributed row on every call, and the cohort rollup
 * (which requires `run_id`) would silently never pair a surfaced pack
 * with its own retrieval.
 *
 * A session belongs to one run, so `sessionId` is sufficient identity;
 * the project falls out of the row rather than being an input.
 * `desc(startedAt)` is defensive against a resumed session id.
 */
export async function lookupRunBySessionId(
  db: DbHandle,
  sessionId: string,
): Promise<{ readonly runId: string; readonly projectId: string | null; readonly orgId: string | null } | null> {
  try {
    if (db.kind === 'sqlite') {
      const rows = await db.db
        .select({ id: sqliteSchema.runs.id, projectId: sqliteSchema.runs.projectId, orgId: sqliteSchema.runs.orgId })
        .from(sqliteSchema.runs)
        .where(eq(sqliteSchema.runs.sessionId, sessionId))
        .orderBy(desc(sqliteSchema.runs.startedAt))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { runId: row.id, projectId: row.projectId, orgId: row.orgId };
    }
    const rows = await db.db
      .select({
        id: postgresSchema.runs.id,
        projectId: postgresSchema.runs.projectId,
        orgId: postgresSchema.runs.orgId,
      })
      .from(postgresSchema.runs)
      .where(eq(postgresSchema.runs.sessionId, sessionId))
      .orderBy(desc(postgresSchema.runs.startedAt))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : { runId: row.id, projectId: row.projectId, orgId: row.orgId };
  } catch {
    return null;
  }
}

/**
 * Resolve a run by its own id.
 *
 * Sibling of {@link lookupRunBySessionId} for the case where the caller
 * already holds a canonical `runs.id` — an agent that was handed one by
 * the SessionStart manifest and passed it to an attribution tool — and
 * needs the project/org that hang off it.
 *
 * Returns `null` for an id that names no row, which is what makes this
 * safe to call with an id that arrived from a tool input: a fabricated
 * or stale run cannot be attributed to.
 */
export async function lookupRunById(
  db: DbHandle,
  runId: string,
): Promise<{ readonly runId: string; readonly projectId: string | null; readonly orgId: string | null } | null> {
  try {
    if (db.kind === 'sqlite') {
      const rows = await db.db
        .select({ id: sqliteSchema.runs.id, projectId: sqliteSchema.runs.projectId, orgId: sqliteSchema.runs.orgId })
        .from(sqliteSchema.runs)
        .where(eq(sqliteSchema.runs.id, runId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { runId: row.id, projectId: row.projectId, orgId: row.orgId };
    }
    const rows = await db.db
      .select({
        id: postgresSchema.runs.id,
        projectId: postgresSchema.runs.projectId,
        orgId: postgresSchema.runs.orgId,
      })
      .from(postgresSchema.runs)
      .where(eq(postgresSchema.runs.id, runId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : { runId: row.id, projectId: row.projectId, orgId: row.orgId };
  } catch {
    return null;
  }
}

/**
 * COOD-84 — compaction generations.
 *
 * `bumpRunBaselineGeneration` is called when a compaction happens;
 * `surfacedMemoryIdsForGeneration` reads what Coodra has already
 * injected within a generation, straight from `memory_access_events`.
 *
 * Using the access log as the baseline record rather than a second
 * column is deliberate: "what have we surfaced, and in which
 * generation" is exactly what that table already answers, and a
 * parallel `last_emitted_generation` column would be a second source of
 * truth free to drift from the rows it is supposed to describe.
 */
export async function bumpRunBaselineGeneration(db: DbHandle, runId: string): Promise<number | null> {
  try {
    if (db.kind === 'sqlite') {
      const rows = await db.db
        .update(sqliteSchema.runs)
        .set({ baselineGeneration: sql`${sqliteSchema.runs.baselineGeneration} + 1` })
        .where(eq(sqliteSchema.runs.id, runId))
        .returning({ generation: sqliteSchema.runs.baselineGeneration });
      return rows[0]?.generation ?? null;
    }
    const rows = await db.db
      .update(postgresSchema.runs)
      .set({ baselineGeneration: sql`${postgresSchema.runs.baselineGeneration} + 1` })
      .where(eq(postgresSchema.runs.id, runId))
      .returning({ generation: postgresSchema.runs.baselineGeneration });
    return rows[0]?.generation ?? null;
  } catch {
    return null;
  }
}

export async function getRunBaselineGeneration(db: DbHandle, runId: string): Promise<number> {
  try {
    if (db.kind === 'sqlite') {
      const rows = await db.db
        .select({ generation: sqliteSchema.runs.baselineGeneration })
        .from(sqliteSchema.runs)
        .where(eq(sqliteSchema.runs.id, runId))
        .limit(1);
      return rows[0]?.generation ?? 0;
    }
    const rows = await db.db
      .select({ generation: postgresSchema.runs.baselineGeneration })
      .from(postgresSchema.runs)
      .where(eq(postgresSchema.runs.id, runId))
      .limit(1);
    return rows[0]?.generation ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Memory ids already pushed to this run in this generation.
 *
 * Two jobs. It tells the re-emission check whether the current
 * generation has been seeded at all — an empty set after a compaction
 * bump means the manifest must be re-sent. And it gives prompt-time
 * injection the set to subtract, so an item is never pushed twice into
 * the same window.
 *
 * That second job also closes a long-standing waste: `renderPromptContext`
 * dedups WITHIN one injection but never across turns, so a
 * frequently-matching decision was re-injected on turns 5, 12 and 30 —
 * making the most-often-matched item the most salient, which is not at
 * all the same as the most important.
 */
export async function surfacedMemoryIdsForGeneration(
  db: DbHandle,
  runId: string,
  generation: number,
): Promise<ReadonlySet<string>> {
  try {
    const rows =
      db.kind === 'sqlite'
        ? await db.db
            .select({ memoryId: sqliteSchema.memoryAccessEvents.memoryId })
            .from(sqliteSchema.memoryAccessEvents)
            .where(
              and(
                eq(sqliteSchema.memoryAccessEvents.runId, runId),
                eq(sqliteSchema.memoryAccessEvents.baselineGeneration, generation),
                eq(sqliteSchema.memoryAccessEvents.channel, 'push'),
              ),
            )
        : await db.db
            .select({ memoryId: postgresSchema.memoryAccessEvents.memoryId })
            .from(postgresSchema.memoryAccessEvents)
            .where(
              and(
                eq(postgresSchema.memoryAccessEvents.runId, runId),
                eq(postgresSchema.memoryAccessEvents.baselineGeneration, generation),
                eq(postgresSchema.memoryAccessEvents.channel, 'push'),
              ),
            );
    const ids = new Set<string>();
    for (const row of rows) if (row.memoryId !== null) ids.add(row.memoryId);
    return ids;
  } catch {
    return new Set<string>();
  }
}
