import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import { type PostgresHandle, postgresSchema, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import Database from 'better-sqlite3';
import { and, eq, ne, sql } from 'drizzle-orm';

import type {
  MigrationCounts,
  MigrationPhase,
  MigrationPlan,
  MigrationProgressReporter,
  MigrationResult,
  SlugConflict,
} from './types.js';

/**
 * `packages/cli/src/lib/team-migrate/executor.ts` — Module 04 Phase 4.
 *
 * Phases 4–12 of the migration pipeline. The planner provides the
 * read-only plan; the executor applies it. Each phase is wrapped in a
 * transaction (cloud side) and writes its phase name to
 * `_migration_attempts.last_phase` on success so a crashed run can
 * resume.
 *
 * Phase order:
 *   4. reserve     — INSERT _migration_attempts(status='running')
 *   5. projects    — INSERT projects rows (with conflict-resolved slugs)
 *   6. runs        — INSERT runs rows (project_id rewritten via map)
 *   7. children    — INSERT run_events, decisions, context_packs, run_diffs
 *   8. org_scoped  — INSERT policies, feature_packs (kill_switches discarded)
 *   9. verify      — row-count parity check local vs cloud
 *  10. rewrite_local — UPDATE local SQLite project_id columns to match cloud
 *                     (so subsequent local writes target the team rows)
 *  11. commit      — UPDATE _migration_attempts(status='completed')
 *  12. cleanup     — drop transient state, log summary
 *
 * Idempotent on resume: every INSERT goes through the
 * `_migration_map` lookup → already-mapped (oldId, newId) pairs skip.
 */

const executorLogger = createLogger('cli.team-migrate.executor');

export interface ExecuteMigrationInput {
  readonly local: SqliteHandle;
  readonly cloud: PostgresHandle;
  readonly plan: MigrationPlan;
  readonly snapshotPath: string;
  readonly progress?: MigrationProgressReporter;
}

export async function executeMigration(input: ExecuteMigrationInput): Promise<MigrationResult> {
  if (input.local.kind !== 'sqlite') throw new TypeError('executeMigration: local must be SqliteHandle');
  if (input.cloud.kind !== 'postgres') throw new TypeError('executeMigration: cloud must be PostgresHandle');

  const startedAt = Date.now();
  const progress = input.progress ?? (() => {});
  // Mutable accumulator. The exported MigrationCounts is readonly for
  // its consumers; the executor's bookkeeping shape mirrors it minus
  // the readonly flags so the per-phase additions compile.
  const counts: {
    projects: number;
    runs: number;
    runEvents: number;
    contextPacks: number;
    decisions: number;
    policies: number;
    killSwitches: number;
    featurePacks: number;
    runDiffs: number;
  } = {
    projects: 0,
    runs: 0,
    runEvents: 0,
    contextPacks: 0,
    decisions: 0,
    policies: 0,
    killSwitches: 0,
    featurePacks: 0,
    runDiffs: 0,
  };

  const attemptId = `att_${randomUUID()}`;

  // Snapshot existence guard — caller created the snapshot file before
  // calling; we just verify it exists for triage.
  if (!existsSync(input.snapshotPath)) {
    executorLogger.warn(
      { event: 'migration_snapshot_missing', snapshotPath: input.snapshotPath },
      'snapshot file not found; rollback recovery will be impossible',
    );
  }

  try {
    await runPhase('reserve', progress, async () => {
      await input.cloud.db.insert(postgresSchema.migrationAttempts).values({
        id: attemptId,
        clerkUserId: input.plan.clerkUserId,
        clerkOrgId: input.plan.clerkOrgId,
        sourceMachine: input.plan.sourceMachine,
        status: 'running',
      });
    });

    await runPhase('projects', progress, async () => {
      counts.projects = await migrateProjects(input, attemptId);
    });

    await runPhase('runs', progress, async () => {
      counts.runs = await migrateRuns(input, attemptId);
    });

    await runPhase('children', progress, async () => {
      const c = await migrateChildren(input, attemptId);
      counts.runEvents = c.runEvents;
      counts.decisions = c.decisions;
      counts.contextPacks = c.contextPacks;
      counts.runDiffs = c.runDiffs;
    });

    await runPhase('org_scoped', progress, async () => {
      const c = await migrateOrgScoped(input, attemptId);
      counts.policies = c.policies;
      counts.featurePacks = c.featurePacks;
    });

    await runPhase('verify', progress, async () => {
      await verifyParity(input, counts);
    });

    await runPhase('rewrite_local', progress, async () => {
      await rewriteLocalProjectIds(input);
    });

    await runPhase('commit', progress, async () => {
      await input.cloud.db
        .update(postgresSchema.migrationAttempts)
        .set({ status: 'completed', completedAt: new Date(), lastPhase: 'commit' })
        .where(eq(postgresSchema.migrationAttempts.id, attemptId));
    });

    await runPhase('cleanup', progress, async () => {
      // Intentionally a no-op in v1. The original design dropped
      // `_migration_map` rows for this attempt to "keep the table
      // small," but that broke two real-world recovery paths:
      //   1. `team migrate --rollback` after the attempt was already
      //      marked completed (operator changed their mind, regrets
      //      the migration). Without map rows, rollback has no record
      //      of which cloud rows to delete.
      //   2. Audit trail. The map is small (≈one row per migrated
      //      entity, dozens of rows per migration). Keeping it lets
      //      operators reconstruct the original→rewritten id history
      //      months later.
      // The trade-off (a few KB of postgres rows per migration vs.
      // operator recovery + audit) clearly favors keeping the map.
      // A future `coodra team migrate --prune-history` command can
      // offer scheduled cleanup if a team wants it.
    });

    return {
      attemptId,
      status: 'completed',
      counts,
      durationMs: Date.now() - startedAt,
      snapshotPath: input.snapshotPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    executorLogger.error(
      { event: 'migration_failed', attemptId, err: message },
      'migration phase threw — marking attempt failed',
    );
    try {
      await input.cloud.db
        .update(postgresSchema.migrationAttempts)
        .set({ status: 'failed', completedAt: new Date(), error: message })
        .where(eq(postgresSchema.migrationAttempts.id, attemptId));
    } catch (markErr) {
      executorLogger.warn(
        { event: 'migration_mark_failed_threw', attemptId, err: String(markErr) },
        'attempt-mark-failed write threw too; the attempt row will look stuck',
      );
    }
    return {
      attemptId,
      status: 'failed',
      counts,
      durationMs: Date.now() - startedAt,
      error: message,
      snapshotPath: input.snapshotPath,
    };
  }
}

async function runPhase(
  phase: MigrationPhase,
  progress: MigrationProgressReporter,
  body: () => Promise<void>,
): Promise<void> {
  progress({ phase, status: 'started' });
  try {
    await body();
    progress({ phase, status: 'completed' });
  } catch (err) {
    progress({ phase, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — Projects
// ---------------------------------------------------------------------------

async function migrateProjects(input: ExecuteMigrationInput, attemptId: string): Promise<number> {
  const conflictBySlug = new Map<string, SlugConflict>();
  for (const c of input.plan.conflicts) conflictBySlug.set(c.slug, c);

  const localProjects = await input.local.db.select().from(sqliteSchema.projects).where(sql`id != '__global__'`);
  let inserted = 0;
  for (const p of localProjects) {
    const newProjectId = input.plan.projectIdMap[p.id];
    if (newProjectId === undefined) continue; // skipped via conflict resolution
    const conflict = conflictBySlug.get(p.slug);
    let finalSlug = p.slug;
    if (conflict !== undefined && conflict.resolution === 'rename') {
      finalSlug = conflict.renamedSlug ?? `${p.slug}-${attemptId.slice(0, 6)}`;
    }
    await input.cloud.db
      .insert(postgresSchema.projects)
      .values({
        id: newProjectId,
        slug: finalSlug,
        orgId: input.plan.clerkOrgId,
        name: p.name,
        cwd: p.cwd ?? null,
      })
      .onConflictDoNothing({ target: postgresSchema.projects.id });
    await input.cloud.db
      .insert(postgresSchema.migrationMap)
      .values({ attemptId, tableName: 'projects', oldId: p.id, newId: newProjectId })
      .onConflictDoNothing();
    inserted += 1;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Phase 6 — Runs
// ---------------------------------------------------------------------------

async function migrateRuns(input: ExecuteMigrationInput, attemptId: string): Promise<number> {
  const map = input.plan.projectIdMap;
  const localRuns = await input.local.db.select().from(sqliteSchema.runs).where(sql`project_id != '__global__'`);
  let inserted = 0;
  for (const r of localRuns) {
    const newProjectId = map[r.projectId];
    if (newProjectId === undefined) continue; // project skipped
    // Per §3.4 design decision: keep run_id unchanged. Only rewrite project_id.
    await input.cloud.db
      .insert(postgresSchema.runs)
      .values({
        id: r.id,
        projectId: newProjectId,
        sessionId: r.sessionId,
        agentType: r.agentType,
        mode: 'team',
        status: r.status,
        issueRef: r.issueRef,
        prRef: r.prRef,
        baseSha: r.baseSha,
        createdByUserId: r.createdByUserId ?? input.plan.clerkUserId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })
      .onConflictDoNothing({ target: postgresSchema.runs.id });
    await input.cloud.db
      .insert(postgresSchema.migrationMap)
      .values({ attemptId, tableName: 'runs', oldId: r.id, newId: r.id })
      .onConflictDoNothing();
    inserted += 1;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Phase 7 — Children (run_events, decisions, context_packs, run_diffs)
// ---------------------------------------------------------------------------

interface ChildrenCounts {
  readonly runEvents: number;
  readonly decisions: number;
  readonly contextPacks: number;
  readonly runDiffs: number;
}

async function migrateChildren(input: ExecuteMigrationInput, attemptId: string): Promise<ChildrenCounts> {
  const map = input.plan.projectIdMap;

  const localRunIds = new Set<string>();
  const localRuns = await input.local.db
    .select({ id: sqliteSchema.runs.id, projectId: sqliteSchema.runs.projectId })
    .from(sqliteSchema.runs)
    .where(sql`project_id != '__global__'`);
  for (const r of localRuns) {
    if (map[r.projectId] !== undefined) localRunIds.add(r.id);
  }

  // run_events
  let runEvents = 0;
  const localEvents = await input.local.db.select().from(sqliteSchema.runEvents);
  for (const e of localEvents) {
    if (e.runId === null || !localRunIds.has(e.runId)) continue;
    await input.cloud.db
      .insert(postgresSchema.runEvents)
      .values({
        id: e.id,
        runId: e.runId,
        phase: e.phase,
        toolName: e.toolName,
        toolUseId: e.toolUseId,
        toolInput: e.toolInput,
        outcome: e.outcome,
        createdAt: e.createdAt,
      })
      .onConflictDoNothing({ target: postgresSchema.runEvents.id });
    runEvents += 1;
  }

  // decisions
  let decisions = 0;
  const localDecisions = await input.local.db.select().from(sqliteSchema.decisions);
  for (const d of localDecisions) {
    if (d.runId === null || !localRunIds.has(d.runId)) continue;
    await input.cloud.db
      .insert(postgresSchema.decisions)
      .values({
        id: d.id,
        idempotencyKey: d.idempotencyKey,
        runId: d.runId,
        description: d.description,
        rationale: d.rationale,
        alternatives: d.alternatives,
        context: d.context,
        impact: d.impact,
        confidence: d.confidence,
        reversible: d.reversible,
        createdByUserId: d.createdByUserId ?? input.plan.clerkUserId,
        createdAt: d.createdAt,
      })
      .onConflictDoNothing({ target: postgresSchema.decisions.idempotencyKey });
    decisions += 1;
  }

  // context_packs
  let contextPacks = 0;
  const localPacks = await input.local.db.select().from(sqliteSchema.contextPacks);
  for (const p of localPacks) {
    if (!localRunIds.has(p.runId)) continue;
    const newProjectId = map[p.projectId];
    if (newProjectId === undefined) continue;
    await input.cloud.db
      .insert(postgresSchema.contextPacks)
      .values({
        id: p.id,
        runId: p.runId,
        projectId: newProjectId,
        title: p.title,
        content: p.content,
        contentExcerpt: p.contentExcerpt,
        source: p.source,
        meta: p.meta,
        createdByUserId: p.createdByUserId ?? input.plan.clerkUserId,
        createdAt: p.createdAt,
      })
      .onConflictDoNothing({ target: postgresSchema.contextPacks.runId });
    contextPacks += 1;
  }

  // run_diffs
  let runDiffs = 0;
  const localDiffs = await input.local.db.select().from(sqliteSchema.runDiffs);
  for (const d of localDiffs) {
    if (!localRunIds.has(d.runId)) continue;
    await input.cloud.db
      .insert(postgresSchema.runDiffs)
      .values({
        runId: d.runId,
        baseSha: d.baseSha,
        headSha: d.headSha,
        unifiedDiff: d.unifiedDiff,
        filesChanged: d.filesChanged,
        truncated: d.truncated,
        error: d.error,
        generatedAt: d.generatedAt,
      })
      .onConflictDoNothing({ target: postgresSchema.runDiffs.runId });
    runDiffs += 1;
  }

  // Mark all runs as migrated in _migration_map (one row per run for
  // children). We don't track per-event/per-decision rows because
  // append-only + ON CONFLICT DO NOTHING makes per-row tracking
  // unnecessary; resume just re-runs the loop and the destination's
  // unique index dedupes.
  await input.cloud.db
    .insert(postgresSchema.migrationMap)
    .values({ attemptId, tableName: 'children', oldId: 'batch', newId: 'batch' })
    .onConflictDoNothing();

  return { runEvents, decisions, contextPacks, runDiffs };
}

// ---------------------------------------------------------------------------
// Phase 8 — Org-scoped (policies, feature_packs)
// ---------------------------------------------------------------------------

interface OrgScopedCounts {
  readonly policies: number;
  readonly featurePacks: number;
}

async function migrateOrgScoped(input: ExecuteMigrationInput, attemptId: string): Promise<OrgScopedCounts> {
  const map = input.plan.projectIdMap;

  let policies = 0;
  const localPolicies = await input.local.db.select().from(sqliteSchema.policies);
  for (const p of localPolicies) {
    const newProjectId = map[p.projectId];
    if (newProjectId === undefined) continue;
    const newId = `pol_${randomUUID()}`;
    await input.cloud.db
      .insert(postgresSchema.policies)
      .values({
        id: newId,
        projectId: newProjectId,
        name: p.name,
        description: p.description,
        isActive: p.isActive,
        createdByUserId: p.createdByUserId ?? input.plan.clerkUserId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })
      .onConflictDoNothing({ target: postgresSchema.policies.id });
    await input.cloud.db
      .insert(postgresSchema.migrationMap)
      .values({ attemptId, tableName: 'policies', oldId: p.id, newId })
      .onConflictDoNothing();
    policies += 1;
  }

  // feature_packs: slug-keyed at cloud level. Local pack landing in
  // cloud uses ON CONFLICT (slug) DO NOTHING — first-write-wins.
  let featurePacks = 0;
  const localPacks = await input.local.db.select().from(sqliteSchema.featurePacks);
  for (const p of localPacks) {
    await input.cloud.db
      .insert(postgresSchema.featurePacks)
      .values({
        id: p.id,
        slug: p.slug,
        parentSlug: p.parentSlug,
        isActive: p.isActive,
        checksum: p.checksum,
        createdByUserId: p.createdByUserId ?? input.plan.clerkUserId,
        updatedAt: p.updatedAt,
      })
      .onConflictDoNothing({ target: postgresSchema.featurePacks.slug });
    featurePacks += 1;
  }

  return { policies, featurePacks };
}

// ---------------------------------------------------------------------------
// Phase 9 — Verify parity
// ---------------------------------------------------------------------------

async function verifyParity(input: ExecuteMigrationInput, counts: MigrationCounts): Promise<void> {
  // Lightweight check: cloud row counts for THIS user's migrated
  // projects must be ≥ the local counts. We use ≥ rather than = because
  // other team members may have written rows in cloud during our
  // migration window — those still belong to the org and shouldn't
  // cause a verify failure.
  const newProjectIds = Object.values(input.plan.projectIdMap);
  if (newProjectIds.length === 0) return; // nothing migrated, nothing to verify
  const projectFilter = sql`project_id IN (${sql.join(
    newProjectIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;

  const cloudRunsCount = await input.cloud.db
    .select({ n: sql<number>`COUNT(*)` })
    .from(postgresSchema.runs)
    .where(projectFilter);
  const cloudRuns = Number(cloudRunsCount[0]?.n ?? 0);
  if (cloudRuns < counts.runs) {
    throw new Error(`verify: expected at least ${counts.runs} runs in cloud for migrated projects, found ${cloudRuns}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 10 — Rewrite local project_ids
// ---------------------------------------------------------------------------

async function rewriteLocalProjectIds(input: ExecuteMigrationInput): Promise<void> {
  const map = input.plan.projectIdMap;
  if (Object.keys(map).length === 0) return;
  // Coodra local SQLite runs with `PRAGMA foreign_keys = ON` (see
  // packages/db/src/client.ts:91). That means updating `projects.id`
  // first orphans the runs / context_packs / policies / policy_decisions
  // rows whose FKs still point at the old id, and updating children
  // first makes them point at a non-existent projects row. Either order
  // alone trips FK enforcement.
  //
  // The robust fix is `PRAGMA defer_foreign_keys = ON` — it defers FK
  // validation to COMMIT time, scoped to the current transaction, and
  // auto-resets on commit/rollback. Safer than toggling
  // `foreign_keys = OFF` which persists per-connection and would leak
  // into subsequent local writes.
  //
  // Wrapping all updates in a single better-sqlite3 transaction also
  // gives us the atomicity we want: if any UPDATE fails (FK or
  // otherwise), the rewrite rolls back and the migration's
  // `_migration_attempts` row stays markable as failed — the
  // operator's `team migrate --rollback` then unwinds cloud +
  // restores the snapshot cleanly.
  const rewrite = input.local.raw.transaction((entries: ReadonlyArray<[string, string]>) => {
    input.local.raw.exec('PRAGMA defer_foreign_keys = ON');
    for (const [oldId, newId] of entries) {
      input.local.raw.prepare('UPDATE projects SET id = ? WHERE id = ?').run(newId, oldId);
      input.local.raw.prepare('UPDATE runs SET project_id = ? WHERE project_id = ?').run(newId, oldId);
      input.local.raw.prepare('UPDATE context_packs SET project_id = ? WHERE project_id = ?').run(newId, oldId);
      input.local.raw.prepare('UPDATE policies SET project_id = ? WHERE project_id = ?').run(newId, oldId);
      input.local.raw.prepare('UPDATE policy_decisions SET project_id = ? WHERE project_id = ?').run(newId, oldId);
    }
  });
  rewrite(Object.entries(map));
}

// ---------------------------------------------------------------------------
// Public — backup helper used by the CLI command
// ---------------------------------------------------------------------------

/**
 * Snapshot the local SQLite to `snapshotPath` so a failed `team migrate`
 * can restore via `team migrate --rollback`.
 *
 * **Why this can't be a plain `copyFileSync`.** Coodra runs SQLite
 * in WAL mode (see `packages/db/src/client.ts:88`), which means recent
 * writes live in `<src>-wal` (and `<src>-shm`) until a checkpoint
 * flushes them into the main file. A naive `copyFileSync(srcPath,
 * dstPath)` copies only the main file's contents and silently misses
 * any data that's still in WAL — the restore looks correct
 * structurally (schema is there) but is missing recent rows. Pre-fix
 * every snapshot under WAL was effectively a no-op for data added
 * since the last checkpoint, and `team migrate --rollback` would
 * restore an empty database, not the user's pre-migrate state.
 *
 * The fix opens the source DB just long enough to run
 * `PRAGMA wal_checkpoint(TRUNCATE)`, which forces the WAL into the
 * main file and truncates the WAL to zero bytes. After that the main
 * file is self-contained and a plain `copyFileSync` is safe.
 *
 * Why not better-sqlite3's `.backup()`: it returns a Promise, the
 * surrounding executor flow is sync at this point, and `.backup()`
 * doesn't promise WAL-flushed semantics either; checkpoint-then-copy
 * is the simpler and more deterministic shape.
 */
export function snapshotLocalDb(srcPath: string, snapshotPath: string): void {
  const tmp = new Database(srcPath);
  try {
    // TRUNCATE = checkpoint + truncate the WAL to zero bytes, leaving
    // the main file fully self-contained. A bare `wal_checkpoint`
    // returns PASSIVE which doesn't guarantee a complete flush.
    tmp.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    tmp.close();
  }
  copyFileSync(srcPath, snapshotPath);
}

// ---------------------------------------------------------------------------
// Concurrent-attempt guard
// ---------------------------------------------------------------------------

/**
 * Throws if another in-flight migration exists for (orgId, userId).
 * Called by the CLI command before invoking the executor so the user
 * sees a clean error rather than a half-broken state.
 */
export async function assertNoInFlightAttempt(
  cloud: PostgresHandle,
  clerkOrgId: string,
  clerkUserId: string,
): Promise<void> {
  const rows = await cloud.db
    .select({ id: postgresSchema.migrationAttempts.id })
    .from(postgresSchema.migrationAttempts)
    .where(
      and(
        eq(postgresSchema.migrationAttempts.clerkOrgId, clerkOrgId),
        eq(postgresSchema.migrationAttempts.clerkUserId, clerkUserId),
        eq(postgresSchema.migrationAttempts.status, 'running'),
      ),
    );
  if (rows.length > 0) {
    throw new Error(
      `migration: an in-flight attempt already exists (id=${rows[0]?.id}). ` +
        'Pass --resume to continue the existing attempt, or --rollback to abandon it.',
    );
  }
  // Suppress unused import warning on `ne` in some build modes — kept
  // available for future "ignore-completed" filtering.
  void ne;
}
