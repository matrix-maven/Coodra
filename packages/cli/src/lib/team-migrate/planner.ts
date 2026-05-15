import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { type PostgresHandle, postgresSchema, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq, sql } from 'drizzle-orm';

import type { MigrationCounts, MigrationPlan, SlugConflict } from './types.js';
import { ZERO_COUNTS } from './types.js';

/**
 * `packages/cli/src/lib/team-migrate/planner.ts` — Module 04 Phase 4.
 *
 * Phase 1 (preflight) + Phase 3 (plan) of the migration pipeline.
 *
 * Outputs a `MigrationPlan` with:
 *   - per-table local row counts (the user sees these in the dry-run
 *     summary before committing to migrate)
 *   - any slug conflicts (local project slug matches an existing cloud
 *     project slug for the same org — needs user resolution)
 *   - a pre-minted `projectIdMap` so the executor can write children
 *     rows in any order without back-filling parent ids.
 *
 * The planner does NOT mutate either DB. It runs read-only against
 * both. The executor consumes the plan and applies the changes.
 */

export interface BuildPlanInput {
  readonly local: SqliteHandle;
  readonly cloud: PostgresHandle;
  readonly clerkUserId: string;
  readonly clerkOrgId: string;
}

export async function buildMigrationPlan(input: BuildPlanInput): Promise<MigrationPlan> {
  if (input.local.kind !== 'sqlite') throw new TypeError('buildMigrationPlan: local must be a SqliteHandle');
  if (input.cloud.kind !== 'postgres') throw new TypeError('buildMigrationPlan: cloud must be a PostgresHandle');

  const counts = await countLocalRows(input.local);
  const conflicts = await detectSlugConflicts(input.local, input.cloud, input.clerkOrgId);
  const projectIdMap = await buildProjectIdMap(input.local, input.cloud, input.clerkOrgId);

  return {
    counts,
    conflicts,
    clerkUserId: input.clerkUserId,
    clerkOrgId: input.clerkOrgId,
    sourceMachine: hostname(),
    projectIdMap,
  };
}

async function countLocalRows(local: SqliteHandle): Promise<MigrationCounts> {
  const s = sqliteSchema;
  // Migration excludes the `__global__` sentinel project (which exists
  // pre-migrate to FK any orphan run_events) and rows attached to it.
  // Excluding here keeps the migration scoped to user data.
  const projectFilter = sql`project_id != '__global__'`;
  const [
    projectsRow,
    runsRow,
    runEventsRow,
    contextPacksRow,
    decisionsRow,
    policiesRow,
    killSwitchesRow,
    featurePacksRow,
    runDiffsRow,
  ] = await Promise.all([
    local.db.select({ n: sql<number>`COUNT(*)` }).from(s.projects).where(sql`id != '__global__'`),
    local.db.select({ n: sql<number>`COUNT(*)` }).from(s.runs).where(projectFilter),
    local.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.runEvents)
      .innerJoin(s.runs, eq(s.runEvents.runId, s.runs.id))
      .where(projectFilter),
    local.db.select({ n: sql<number>`COUNT(*)` }).from(s.contextPacks).where(projectFilter),
    local.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.decisions)
      .innerJoin(s.runs, eq(s.decisions.runId, s.runs.id))
      .where(projectFilter),
    local.db.select({ n: sql<number>`COUNT(*)` }).from(s.policies).where(projectFilter),
    // Kill switches are scoped by `target` for project scope; for v1 we
    // skip them on migrate (per the plan — discard local kill switches
    // by default). Count for telemetry.
    local.db.select({ n: sql<number>`COUNT(*)` }).from(s.killSwitches),
    local.db.select({ n: sql<number>`COUNT(*)` }).from(s.featurePacks),
    local.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.runDiffs)
      .innerJoin(s.runs, eq(s.runDiffs.runId, s.runs.id))
      .where(projectFilter),
  ]);
  return {
    ...ZERO_COUNTS,
    projects: numberFromRow(projectsRow),
    runs: numberFromRow(runsRow),
    runEvents: numberFromRow(runEventsRow),
    contextPacks: numberFromRow(contextPacksRow),
    decisions: numberFromRow(decisionsRow),
    policies: numberFromRow(policiesRow),
    killSwitches: numberFromRow(killSwitchesRow),
    featurePacks: numberFromRow(featurePacksRow),
    runDiffs: numberFromRow(runDiffsRow),
  };
}

function numberFromRow(rows: ReadonlyArray<{ n: number | bigint }>): number {
  const v = rows[0]?.n;
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : 0;
}

async function detectSlugConflicts(
  local: SqliteHandle,
  cloud: PostgresHandle,
  clerkOrgId: string,
): Promise<SlugConflict[]> {
  const localProjects = await local.db
    .select({ id: sqliteSchema.projects.id, slug: sqliteSchema.projects.slug })
    .from(sqliteSchema.projects)
    .where(sql`id != '__global__'`);
  if (localProjects.length === 0) return [];
  const slugs = localProjects.map((p) => p.slug);
  const cloudProjects = await cloud.db
    .select({ id: postgresSchema.projects.id, slug: postgresSchema.projects.slug })
    .from(postgresSchema.projects)
    .where(
      sql`${postgresSchema.projects.orgId} = ${clerkOrgId} AND ${postgresSchema.projects.slug} IN (${sql.join(
        slugs.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  const cloudBySlug = new Map<string, string>();
  for (const p of cloudProjects) cloudBySlug.set(p.slug, p.id);
  const conflicts: SlugConflict[] = [];
  for (const localProj of localProjects) {
    const cloudId = cloudBySlug.get(localProj.slug);
    if (cloudId === undefined) continue;
    // Identity match — local.id === cloud.id under the same org means
    // this project was already migrated by a previous run. Not a
    // conflict, just an idempotent re-run; the planner's projectIdMap
    // will preserve the id and the executor's loops hit ON CONFLICT
    // DO NOTHING. Surfacing this as a conflict would lead to unwanted
    // auto-renames on every re-run.
    if (cloudId === localProj.id) continue;
    conflicts.push({ localProjectId: localProj.id, slug: localProj.slug, cloudProjectId: cloudId });
  }
  return conflicts;
}

async function buildProjectIdMap(
  local: SqliteHandle,
  cloud: PostgresHandle,
  clerkOrgId: string,
): Promise<Record<string, string>> {
  const localRows = await local.db
    .select({ id: sqliteSchema.projects.id })
    .from(sqliteSchema.projects)
    .where(sql`id != '__global__'`);
  // Identity-match check: if a local project's id already exists in
  // cloud under the same org, it has already been migrated — preserve
  // the id so the re-run is a no-op (every loop in the executor sees
  // INSERT … ON CONFLICT DO NOTHING and skips).
  //
  // Without this check, the second `team migrate` mints a fresh uuid
  // for the local id (which post-rewrite IS the cloud id), the
  // executor tries to INSERT a row with a new id but the same slug,
  // and the cloud's UNIQUE (slug) constraint trips. With the check,
  // re-runs are quiet and idempotent.
  const cloudIdsForOrg = await cloud.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.orgId, clerkOrgId));
  const cloudIdSet = new Set(cloudIdsForOrg.map((r) => r.id));
  const map: Record<string, string> = {};
  for (const r of localRows) {
    map[r.id] = cloudIdSet.has(r.id) ? r.id : `proj_${randomUUID()}`;
  }
  return map;
}

/**
 * Apply user-supplied conflict resolutions to the plan. Returns a new
 * plan with conflict rows updated and projectIdMap entries adjusted
 * for skipped projects (deleted from the map → executor skips them).
 */
export function applyConflictResolutions(
  plan: MigrationPlan,
  resolutions: ReadonlyMap<string /* localProjectId */, { resolution: 'rename' | 'skip'; renamedSlug?: string }>,
): MigrationPlan {
  const newConflicts: SlugConflict[] = [];
  const newMap: Record<string, string> = { ...plan.projectIdMap };
  for (const c of plan.conflicts) {
    const r = resolutions.get(c.localProjectId);
    if (r === undefined) {
      newConflicts.push(c);
      continue;
    }
    if (r.resolution === 'skip') {
      // Drop from id-map → executor skips the project entirely.
      delete newMap[c.localProjectId];
      newConflicts.push({ ...c, resolution: 'skip' });
    } else {
      newConflicts.push({
        ...c,
        resolution: 'rename',
        ...(r.renamedSlug !== undefined ? { renamedSlug: r.renamedSlug } : {}),
      });
    }
  }
  return { ...plan, conflicts: newConflicts, projectIdMap: newMap };
}
