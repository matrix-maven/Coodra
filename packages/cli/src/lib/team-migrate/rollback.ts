import { copyFileSync, existsSync } from 'node:fs';

import { type PostgresHandle, postgresSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq, inArray } from 'drizzle-orm';

/**
 * `packages/cli/src/lib/team-migrate/rollback.ts` — Module 04 Phase 4.
 *
 * Undo a failed (or user-aborted) migration attempt:
 *   1. Read every (table_name, new_id) row from `_migration_map` for
 *      this attempt_id.
 *   2. DELETE the corresponding cloud rows (in reverse FK order so
 *      children clear before parents).
 *   3. UPDATE `_migration_attempts.status = 'rolled_back'`.
 *   4. Restore the local SQLite snapshot file (if present) over the
 *      live data.db so the user's solo state is intact.
 *
 * The `_migration_map` itself is dropped via the cascade FK when the
 * attempt row is later deleted (or kept for audit — operators decide).
 */

const rollbackLogger = createLogger('cli.team-migrate.rollback');

export interface RollbackInput {
  readonly cloud: PostgresHandle;
  readonly attemptId: string;
  readonly localDbPath: string;
  readonly snapshotPath: string;
}

export interface RollbackResult {
  readonly attemptId: string;
  readonly cloudRowsDeleted: number;
  readonly localRestored: boolean;
}

export async function rollbackMigration(input: RollbackInput): Promise<RollbackResult> {
  if (input.cloud.kind !== 'postgres') throw new TypeError('rollbackMigration: cloud must be PostgresHandle');
  rollbackLogger.info({ event: 'rollback_started', attemptId: input.attemptId }, 'beginning migration rollback');

  // Read the map.
  const mapRows = await input.cloud.db
    .select()
    .from(postgresSchema.migrationMap)
    .where(eq(postgresSchema.migrationMap.attemptId, input.attemptId));

  // Delete rows in reverse FK order. children → runs → projects → policies/feature_packs.
  let deleted = 0;
  // Group by table for batched DELETEs.
  const byTable = new Map<string, string[]>();
  for (const r of mapRows) {
    const list = byTable.get(r.tableName) ?? [];
    list.push(r.newId);
    byTable.set(r.tableName, list);
  }

  // FK reality check (verified against the cloud schema 2026-05-09):
  //   run_diffs.run_id    → ON DELETE CASCADE   (auto-cleared when runs delete)
  //   context_packs.run_id → NO ACTION          (must delete explicitly first)
  //   decisions.run_id    → ON DELETE SET NULL  (would orphan, leaks migrated state)
  //   run_events.run_id   → ON DELETE SET NULL  (same)
  //
  // Pre-fix the rollback assumed all four cascade-on-delete and just
  // deleted runs. context_packs blocked the DELETE; decisions +
  // run_events orphaned to NULL run_id, leaking migrated rows in the
  // cloud. The fix is explicit child deletion in dependency order.

  // Delete policies first — they FK projects, deleting projects later
  // would orphan-block.
  const policyIds = byTable.get('policies') ?? [];
  if (policyIds.length > 0) {
    const r = await input.cloud.db
      .delete(postgresSchema.policies)
      .where(inArray(postgresSchema.policies.id, policyIds));
    deleted += policyIds.length;
    void r;
  }

  // Delete dependents of runs explicitly. run_diffs cascades on
  // runs delete, but doing it explicitly here keeps the count
  // accurate and removes any timing surprises.
  const runIds = byTable.get('runs') ?? [];
  if (runIds.length > 0) {
    await input.cloud.db.delete(postgresSchema.runDiffs).where(inArray(postgresSchema.runDiffs.runId, runIds));
    await input.cloud.db.delete(postgresSchema.contextPacks).where(inArray(postgresSchema.contextPacks.runId, runIds));
    await input.cloud.db.delete(postgresSchema.decisions).where(inArray(postgresSchema.decisions.runId, runIds));
    await input.cloud.db.delete(postgresSchema.runEvents).where(inArray(postgresSchema.runEvents.runId, runIds));
    // policy_decisions also FK runs.id with `references … ON DELETE
    // SET NULL` (default action when no clause specified). Same
    // orphan-leak risk; clear them too.
    await input.cloud.db
      .delete(postgresSchema.policyDecisions)
      .where(inArray(postgresSchema.policyDecisions.runId, runIds));
    // Now safe to delete runs.
    await input.cloud.db.delete(postgresSchema.runs).where(inArray(postgresSchema.runs.id, runIds));
    deleted += runIds.length;
  }

  // Delete projects last — runs / policies / context_packs all FK
  // projects. With those gone above, projects DELETE is unblocked.
  const projectIds = byTable.get('projects') ?? [];
  if (projectIds.length > 0) {
    await input.cloud.db.delete(postgresSchema.projects).where(inArray(postgresSchema.projects.id, projectIds));
    deleted += projectIds.length;
  }

  // Mark attempt rolled_back.
  await input.cloud.db
    .update(postgresSchema.migrationAttempts)
    .set({ status: 'rolled_back', completedAt: new Date() })
    .where(eq(postgresSchema.migrationAttempts.id, input.attemptId));

  // Restore local snapshot (if present).
  let localRestored = false;
  if (existsSync(input.snapshotPath)) {
    try {
      copyFileSync(input.snapshotPath, input.localDbPath);
      localRestored = true;
      rollbackLogger.info(
        { event: 'rollback_local_restored', snapshotPath: input.snapshotPath },
        'local SQLite restored from pre-migrate snapshot',
      );
    } catch (err) {
      rollbackLogger.warn(
        {
          event: 'rollback_local_restore_failed',
          snapshotPath: input.snapshotPath,
          err: err instanceof Error ? err.message : String(err),
        },
        'local SQLite restore threw — user must manually copy snapshot back',
      );
    }
  } else {
    rollbackLogger.warn(
      { event: 'rollback_no_snapshot', snapshotPath: input.snapshotPath },
      'snapshot file missing; local SQLite NOT restored',
    );
  }

  rollbackLogger.info(
    { event: 'rollback_completed', attemptId: input.attemptId, deleted, localRestored },
    'rollback complete',
  );

  return { attemptId: input.attemptId, cloudRowsDeleted: deleted, localRestored };
}
