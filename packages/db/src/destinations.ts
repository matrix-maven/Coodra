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

export interface InsertRunRow {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly mode: string;
  readonly status?: string;
  /**
   * Module 04 Phase 4 — Clerk user id of the human owning the session.
   * NULL on solo mode + pre-Phase-4 rows. Stamped by the bridge from
   * `~/.coodra/config.json::team.clerkUserId` at SessionStart.
   */
  readonly createdByUserId?: string | null;
}

export async function insertRun(db: DbHandle, row: InsertRunRow): Promise<void> {
  const values = { ...row, status: row.status ?? 'in_progress' };
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
