import { and, desc, eq } from 'drizzle-orm';

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
