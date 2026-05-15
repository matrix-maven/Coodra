import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPostgresDb,
  createSqliteDb,
  ensureGlobalProject,
  ensureProject,
  migratePostgres,
  migrateSqlite,
  type PostgresHandle,
  postgresSchema,
  type SqliteHandle,
  sqliteSchema,
} from '@coodra/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMigrationPlan,
  executeMigration,
  rollbackMigration,
  snapshotLocalDb,
} from '../../src/lib/team-migrate/index.js';

/**
 * Module 04 Phase 4 — end-to-end migration test.
 *
 * Locks the contract:
 *   1. Plan counts match seeded local rows.
 *   2. After execute → cloud rows land with rewritten project_ids and
 *      preserved run_ids.
 *   3. Local SQLite rewritten in Phase 10 to use the new project_ids.
 *   4. Re-running migrate is a no-op (idempotent) — second run inserts 0 rows.
 *   5. Slug-conflict detection fires when cloud already has a project.
 *   6. Rollback deletes the migrated cloud rows and restores the
 *      pre-migrate snapshot to the local DB path.
 *
 * Skipped when DATABASE_URL is unset.
 */

const databaseUrl = process.env.DATABASE_URL;
const isEnabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

let tmpDir: string;
let local: SqliteHandle;
let localDbPath: string;
let cloud: PostgresHandle;

(isEnabled ? describe : describe.skip)('team-migrate end-to-end', () => {
  beforeAll(async () => {
    cloud = createPostgresDb({ databaseUrl: databaseUrl as string });
    const tables = await cloud.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    for (const t of tables) {
      await cloud.raw.unsafe(`DROP TABLE IF EXISTS "${t.table_name.replace(/"/g, '""')}" CASCADE`);
    }
    await cloud.raw.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await cloud.raw.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await migratePostgres(cloud.db);
    await ensureGlobalProject(cloud);
  });

  afterAll(async () => {
    if (cloud) await cloud.close();
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'team-migrate-'));
    localDbPath = join(tmpDir, 'data.db');
    local = createSqliteDb({ path: localDbPath });
    migrateSqlite(local.db);
    await ensureGlobalProject(local);
  });

  afterEach(async () => {
    if (local) local.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (cloud) {
      await cloud.raw.unsafe('DELETE FROM _migration_map');
      await cloud.raw.unsafe('DELETE FROM _migration_attempts');
      await cloud.raw.unsafe('DELETE FROM run_events');
      await cloud.raw.unsafe('DELETE FROM policy_decisions');
      await cloud.raw.unsafe('DELETE FROM decisions');
      await cloud.raw.unsafe('DELETE FROM context_packs');
      await cloud.raw.unsafe('DELETE FROM run_diffs');
      await cloud.raw.unsafe('DELETE FROM runs');
      await cloud.raw.unsafe('DELETE FROM policies');
      await cloud.raw.unsafe('DELETE FROM feature_packs');
      await cloud.raw.unsafe(`DELETE FROM projects WHERE id <> '__global__'`);
    }
  });

  /** Seed a complete local solo state: one project + one run + one decision + one pack. */
  async function seedLocalSolo(): Promise<{ projectId: string; runId: string }> {
    await ensureProject(local, { slug: 'solo-proj-1', orgId: '__solo__', name: 'solo proj 1' });
    const project = (
      await local.db.select().from(sqliteSchema.projects).where(eq(sqliteSchema.projects.slug, 'solo-proj-1'))
    )[0];
    const projectId = project!.id;
    const runId = `run:${projectId}:s1:abcdefab-1234-5678-9012-abcdefabcdef`;
    local.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, projectId, 's1', 'claude_code', 'solo', 'completed', 1700000000);
    local.raw
      .prepare(
        `INSERT INTO decisions (id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_1', 'dec:run1:abc', runId, 'use postgres for cloud', 'sqlite-vec does not federate', 1700000010);
    local.raw
      .prepare(
        `INSERT INTO context_packs (id, run_id, project_id, title, content, content_excerpt, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('cp_1', runId, projectId, 'session 1 recap', '# Notes', '# Notes', 'agent', 1700000020);
    return { projectId, runId };
  }

  it('migrate: plan reports correct counts; execute lands rewritten projects with preserved run_ids', async () => {
    const { projectId: oldProjectId, runId } = await seedLocalSolo();

    const plan = await buildMigrationPlan({
      local,
      cloud,
      clerkUserId: 'user_alice',
      clerkOrgId: 'org_acme',
    });
    expect(plan.counts.projects).toBe(1);
    expect(plan.counts.runs).toBe(1);
    expect(plan.counts.decisions).toBe(1);
    expect(plan.counts.contextPacks).toBe(1);
    expect(plan.conflicts).toEqual([]);
    expect(plan.projectIdMap[oldProjectId]).toBeDefined();
    const newProjectId = plan.projectIdMap[oldProjectId] as string;

    const snapshotPath = join(tmpDir, 'data.db.snapshot');
    snapshotLocalDb(localDbPath, snapshotPath);
    expect(statSync(snapshotPath).size).toBeGreaterThan(0);

    const result = await executeMigration({ local, cloud, plan, snapshotPath });
    expect(result.status).toBe('completed');
    expect(result.counts.projects).toBe(1);
    expect(result.counts.runs).toBe(1);

    // Cloud has the rewritten project_id but the same run_id.
    const cloudRun = await cloud.db.select().from(postgresSchema.runs).where(eq(postgresSchema.runs.id, runId));
    expect(cloudRun).toHaveLength(1);
    expect(cloudRun[0]?.projectId).toBe(newProjectId);
    expect(cloudRun[0]?.createdByUserId).toBe('user_alice'); // backfilled

    const cloudDec = await cloud.db
      .select()
      .from(postgresSchema.decisions)
      .where(eq(postgresSchema.decisions.id, 'dec_1'));
    expect(cloudDec).toHaveLength(1);
    expect(cloudDec[0]?.createdByUserId).toBe('user_alice');

    const cloudCp = await cloud.db
      .select()
      .from(postgresSchema.contextPacks)
      .where(eq(postgresSchema.contextPacks.id, 'cp_1'));
    expect(cloudCp).toHaveLength(1);
    expect(cloudCp[0]?.projectId).toBe(newProjectId);

    // Local rewritten — project_id now matches cloud.
    const localProject = local.raw.prepare('SELECT id FROM projects WHERE slug = ?').get('solo-proj-1') as {
      id: string;
    };
    expect(localProject.id).toBe(newProjectId);
    const localRun = local.raw.prepare('SELECT project_id FROM runs WHERE id = ?').get(runId) as { project_id: string };
    expect(localRun.project_id).toBe(newProjectId);
  });

  it('migrate: re-running on already-migrated state is idempotent (cloud-side no-op)', async () => {
    await seedLocalSolo();

    const plan1 = await buildMigrationPlan({
      local,
      cloud,
      clerkUserId: 'user_bob',
      clerkOrgId: 'org_bob_inc',
    });
    const snapshotPath = join(tmpDir, 'data.db.snapshot');
    snapshotLocalDb(localDbPath, snapshotPath);
    const r1 = await executeMigration({ local, cloud, plan: plan1, snapshotPath });
    expect(r1.status).toBe('completed');

    // Pre-migration cloud row count.
    const cloudRunsBefore = (await cloud.db.select({ n: sql<number>`COUNT(*)` }).from(postgresSchema.runs))[0]!.n;

    // Build a NEW plan against the post-rewrite local. Since the local
    // project_ids now match cloud, the plan should detect existing rows
    // and the second execute should land 0 incremental cloud rows
    // (ON CONFLICT DO NOTHING dedupes).
    const plan2 = await buildMigrationPlan({
      local,
      cloud,
      clerkUserId: 'user_bob',
      clerkOrgId: 'org_bob_inc',
    });
    const r2 = await executeMigration({ local, cloud, plan: plan2, snapshotPath });
    expect(r2.status).toBe('completed');

    const cloudRunsAfter = (await cloud.db.select({ n: sql<number>`COUNT(*)` }).from(postgresSchema.runs))[0]!.n;
    expect(Number(cloudRunsAfter)).toBe(Number(cloudRunsBefore));
  });

  it('migrate: detects slug conflicts when cloud already has a project with the same slug', async () => {
    await seedLocalSolo();
    // Pre-seed cloud with the same slug for the same org.
    await ensureProject(cloud, { slug: 'solo-proj-1', orgId: 'org_acme', name: 'pre-existing' });

    const plan = await buildMigrationPlan({
      local,
      cloud,
      clerkUserId: 'user_alice',
      clerkOrgId: 'org_acme',
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.slug).toBe('solo-proj-1');
  });

  it('rollback: deletes migrated cloud rows and restores the local snapshot', async () => {
    const { projectId: oldProjectId } = await seedLocalSolo();

    const plan = await buildMigrationPlan({
      local,
      cloud,
      clerkUserId: 'user_carol',
      clerkOrgId: 'org_rollback',
    });
    const snapshotPath = join(tmpDir, 'data.db.snapshot');
    snapshotLocalDb(localDbPath, snapshotPath);
    const result = await executeMigration({ local, cloud, plan, snapshotPath });
    expect(result.status).toBe('completed');

    // Re-open status as 'running' so rollbackMigration treats it as in-flight
    // (the executor flipped to 'completed' on success). Rollback works on
    // any attempt id — the status string is informational for the operator.
    await cloud.db
      .update(postgresSchema.migrationAttempts)
      .set({ status: 'running' })
      .where(eq(postgresSchema.migrationAttempts.id, result.attemptId));

    // Capture cloud row count baseline before rollback.
    const cloudProjectsBefore = (await cloud.db.select({ n: sql<number>`COUNT(*)` }).from(postgresSchema.projects))[0]!
      .n;

    // Close local handle so rollback can overwrite the file.
    local.close();
    const rb = await rollbackMigration({
      cloud,
      attemptId: result.attemptId,
      localDbPath,
      snapshotPath,
    });
    expect(rb.cloudRowsDeleted).toBeGreaterThan(0);
    expect(rb.localRestored).toBe(true);

    // Re-open local; the snapshot should have the OLD project_id.
    local = createSqliteDb({ path: localDbPath });
    const localProj = local.raw.prepare('SELECT id FROM projects WHERE slug = ?').get('solo-proj-1') as { id: string };
    expect(localProj.id).toBe(oldProjectId);

    // Cloud projects table no longer carries the migrated row.
    const cloudProjectsAfter = (await cloud.db.select({ n: sql<number>`COUNT(*)` }).from(postgresSchema.projects))[0]!
      .n;
    expect(Number(cloudProjectsAfter)).toBeLessThan(Number(cloudProjectsBefore));
  });
});
