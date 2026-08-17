import { and, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/destinations` — pure async helpers that perform
 * the destination-table INSERT/UPDATE for the durable audit outbox
 * (Module 03.1). The OutboxWorker's dispatch handler routes by
 * `pending_jobs.queue` into one of these and lets the caller surface
 * the outcome.
 *
 * Each helper:
 *   - Uses `ON CONFLICT DO NOTHING` (or `WHERE status != 'completed'`
 *     for `closeRun`) so dispatch retries are idempotent at the
 *     destination, even when the worker times-out mid-write and
 *     reclaims the row.
 *   - Throws on transport failure (DB busy, FK violation). The
 *     dispatcher catches and maps to `transient_failure` /
 *     `permanent_failure` — the helper does not encode policy.
 *   - Mirrors the shapes that previously lived inline in
 *     `apps/{hooks-bridge,mcp-server}/src/lib/run-recorder.ts` so
 *     refactors are byte-equivalent at the destination level.
 */

export interface InsertRunEventRow {
  readonly id: string;
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly runId: string | null;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: string;
  readonly outcome: string | null;
}

export async function insertRunEvent(db: DbHandle, row: InsertRunEventRow): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db.insert(sqliteSchema.runEvents).values(row).onConflictDoNothing({ target: sqliteSchema.runEvents.id });
    return;
  }
  await db.db.insert(postgresSchema.runEvents).values(row).onConflictDoNothing({ target: postgresSchema.runEvents.id });
}

/**
 * COOD-78 — one surfacing of a Coodra memory item to an agent.
 *
 * `runId` is nullable by design: COOD-80's attribution chain
 * (projectSlug → projectId → `lookupRunId(db, projectId, sessionId)`)
 * writes NULL and increments a counter on a miss rather than guessing,
 * so attribution loss is observable instead of silent. `memoryId` is
 * nullable too — a search that returned nothing is still a real access
 * event and is what makes empty/low-signal answer rates measurable.
 */
export interface InsertMemoryAccessEventRow {
  readonly id: string;
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly runId: string | null;
  readonly sessionId?: string | null;
  readonly actorUserId?: string | null;
  readonly agentType?: string | null;
  readonly runEventId?: string | null;
  readonly channel: string;
  readonly site: string;
  readonly memoryType: string;
  readonly memoryId?: string | null;
  readonly position?: number | null;
  readonly bytes?: number | null;
  readonly latencyMs?: number | null;
  readonly triggerType: string;
  readonly queryHash?: string | null;
  readonly triggerTextHash?: string | null;
  readonly resultCount?: number | null;
  readonly freshnessStatusAtAccess?: string | null;
  readonly baselineGeneration?: number;
}

export async function insertMemoryAccessEvent(db: DbHandle, row: InsertMemoryAccessEventRow): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .insert(sqliteSchema.memoryAccessEvents)
      .values(row)
      .onConflictDoNothing({ target: sqliteSchema.memoryAccessEvents.id });
    return;
  }
  await db.db
    .insert(postgresSchema.memoryAccessEvents)
    .values(row)
    .onConflictDoNothing({ target: postgresSchema.memoryAccessEvents.id });
}

export interface InsertRunRow {
  readonly id: string;
  readonly orgId?: string | null;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly mode: string;
  readonly status?: string;
  readonly activeCapabilitiesJson?: string | null;
  /**
   * Module 04 Phase 4 — Clerk user id of the human owning the session.
   * NULL on solo mode + pre-Phase-4 rows. Stamped by the bridge from
   * `~/.coodra/config.json::team.clerkUserId` at SessionStart.
   */
  readonly createdByUserId?: string | null;
}

export async function insertRun(db: DbHandle, row: InsertRunRow): Promise<void> {
  const values = {
    ...row,
    status: row.status ?? 'in_progress',
    activeCapabilitiesJson: row.activeCapabilitiesJson ?? '[]',
  };
  if (db.kind === 'sqlite') {
    await db.db
      .insert(sqliteSchema.runs)
      .values(values)
      .onConflictDoNothing({ target: [sqliteSchema.runs.projectId, sqliteSchema.runs.sessionId] });
    return;
  }
  await db.db
    .insert(postgresSchema.runs)
    .values(values)
    .onConflictDoNothing({ target: [postgresSchema.runs.projectId, postgresSchema.runs.sessionId] });
}

export interface CloseRunArgs {
  readonly projectId: string;
  readonly sessionId: string;
  /** Defaults to `new Date()`. Exposed for test injection. */
  readonly endedAt?: Date;
}

export async function closeRun(db: DbHandle, args: CloseRunArgs): Promise<void> {
  const endedAt = args.endedAt ?? new Date();
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.runs)
      .set({ status: 'completed', endedAt })
      .where(and(eq(sqliteSchema.runs.projectId, args.projectId), eq(sqliteSchema.runs.sessionId, args.sessionId)));
    return;
  }
  await db.db
    .update(postgresSchema.runs)
    .set({ status: 'completed', endedAt })
    .where(and(eq(postgresSchema.runs.projectId, args.projectId), eq(postgresSchema.runs.sessionId, args.sessionId)));
}
