import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { readTeamConfig, upgradeToTeamConfig } from '../../src/lib/team-config.js';
import { buildMigrationPlan, executeMigration, snapshotLocalDb } from '../../src/lib/team-migrate/index.js';

/**
 * Module 04 Phase 4 — end-to-end smoke test for the full team-mode
 * lifecycle as a user would experience it. Skipped without
 * DATABASE_URL so local CI without docker still runs the rest of the
 * integration suite.
 *
 * The flow this test exercises (matching docs/team-setup.md):
 *
 *   1. Admin creates Supabase project (simulated: cloud DB exists).
 *   2. Admin runs `team setup`:
 *        - migratePostgres applies schema
 *        - 14 expected tables present
 *        - team config landed on admin's machine
 *   3. Admin's solo SQLite has accumulated work — seed runs / decisions
 *      / context_packs to simulate days of solo use.
 *   4. Admin runs `team migrate`:
 *        - planner reports correct counts
 *        - executor lands cloud rows with rewritten project_id
 *        - run_id preserved (per §3.4)
 *        - created_by_user_id stamped on the migrated rows
 *        - local SQLite project_ids rewritten
 *        - re-running is a no-op
 *   5. Member B's machine joins:
 *        - team config landed for member B
 *   6. Member A writes a new decision (simulated: INSERT into cloud).
 *   7. Member B's pull-tick brings the new decision into local.
 *      → cross-team-member visibility (Caveat 1) works.
 *
 * Locks the user-visible contract: data flows correctly across the
 * whole lifecycle. If this test passes, a real user running through
 * the same commands against their own Supabase will see the same
 * outcome.
 */

const databaseUrl = process.env.DATABASE_URL;
const isEnabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

let cloud: PostgresHandle;
let adminTmp: string;
let memberTmp: string;
let adminLocal: SqliteHandle;
let memberLocal: SqliteHandle;
let adminConfigHome: string;
let memberConfigHome: string;

const ADMIN_USER = 'user_admin_alice';
const MEMBER_USER = 'user_member_bob';
const ORG_ID = 'org_e2e_acme';
const HOOK_SECRET = 'a'.repeat(64);

(isEnabled ? describe : describe.skip)('team-mode end-to-end (Phase G smoke test)', () => {
  beforeAll(async () => {
    cloud = createPostgresDb({ databaseUrl: databaseUrl as string });
    // Wipe the public schema clean so the test starts from zero.
    const tables = await cloud.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    for (const t of tables) {
      await cloud.raw.unsafe(`DROP TABLE IF EXISTS "${t.table_name.replace(/"/g, '""')}" CASCADE`);
    }
    await cloud.raw.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await cloud.raw.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    // Step 2 (admin team setup): migratePostgres applies schema.
    await migratePostgres(cloud.db);
    await ensureGlobalProject(cloud);
  });

  afterAll(async () => {
    if (cloud) await cloud.close();
  });

  beforeEach(() => {
    adminTmp = mkdtempSync(join(tmpdir(), 'e2e-admin-'));
    memberTmp = mkdtempSync(join(tmpdir(), 'e2e-member-'));
    adminConfigHome = mkdtempSync(join(tmpdir(), 'e2e-admin-home-'));
    memberConfigHome = mkdtempSync(join(tmpdir(), 'e2e-member-home-'));
    mkdirSync(adminConfigHome, { recursive: true });
    mkdirSync(memberConfigHome, { recursive: true });
    adminLocal = createSqliteDb({ path: join(adminTmp, 'data.db') });
    memberLocal = createSqliteDb({ path: join(memberTmp, 'data.db') });
    migrateSqlite(adminLocal.db);
    migrateSqlite(memberLocal.db);
  });

  afterEach(async () => {
    if (adminLocal) adminLocal.close();
    if (memberLocal) memberLocal.close();
    rmSync(adminTmp, { recursive: true, force: true });
    rmSync(memberTmp, { recursive: true, force: true });
    rmSync(adminConfigHome, { recursive: true, force: true });
    rmSync(memberConfigHome, { recursive: true, force: true });
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

  it('full lifecycle: admin setup → solo work → migrate → member joins → cross-team visibility', async () => {
    // STEP 2 — Admin runs `team setup`. The cloud schema is already
    // applied (beforeAll). team setup writes the admin's config.
    upgradeToTeamConfig(
      {
        clerkUserId: ADMIN_USER,
        clerkOrgId: ORG_ID,
        clerkOrgSlug: 'acme',
        localHookSecret: HOOK_SECRET,
        joinedAt: Date.now(),
      },
      { homeOverride: adminConfigHome },
    );
    const adminConfig = readTeamConfig({ homeOverride: adminConfigHome });
    expect(adminConfig.mode).toBe('team');
    expect(adminConfig.team?.clerkUserId).toBe(ADMIN_USER);

    // Verify the schema check from team-setup-cmd. Required tables.
    const tables = await cloud.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const present = new Set(tables.map((r) => r.table_name));
    for (const required of [
      'projects',
      'runs',
      'run_events',
      'context_packs',
      'pending_jobs',
      'policies',
      'policy_rules',
      'policy_decisions',
      'feature_packs',
      'decisions',
      'kill_switches',
      'run_diffs',
      '_migration_attempts',
      '_migration_map',
    ]) {
      expect(present.has(required), `${required} should be in cloud schema`).toBe(true);
    }

    // STEP 3 — Admin's solo SQLite has accumulated work. Seed:
    //   - 1 project ('acme-app')
    //   - 1 run with 2 decisions + 1 context pack
    await ensureGlobalProject(adminLocal);
    await ensureProject(adminLocal, { slug: 'acme-app', orgId: '__solo__', name: 'ACME Web App' });
    const localProj = (
      await adminLocal.db.select().from(sqliteSchema.projects).where(eq(sqliteSchema.projects.slug, 'acme-app'))
    )[0]!;
    const localRunId = `run:${localProj.id}:s1:11111111-1111-1111-1111-111111111111`;
    adminLocal.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(localRunId, localProj.id, 's1', 'claude_code', 'solo', 'completed', 1700000000);
    adminLocal.raw
      .prepare(
        `INSERT INTO decisions (id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_1', 'dec:run1:a', localRunId, 'use postgres', 'sqlite-vec does not federate', 1700000010);
    adminLocal.raw
      .prepare(
        `INSERT INTO decisions (id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_2', 'dec:run1:b', localRunId, 'team-mode is opt-in', 'solo first; team only when needed', 1700000020);
    adminLocal.raw
      .prepare(
        `INSERT INTO context_packs (id, run_id, project_id, title, content, content_excerpt, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('cp_1', localRunId, localProj.id, 'session 1 recap', '# Notes', '# Notes', 'agent', 1700000030);

    // STEP 4 — Admin runs `team migrate`.
    const plan = await buildMigrationPlan({
      local: adminLocal,
      cloud,
      clerkUserId: ADMIN_USER,
      clerkOrgId: ORG_ID,
    });
    expect(plan.counts.projects).toBe(1);
    expect(plan.counts.runs).toBe(1);
    expect(plan.counts.decisions).toBe(2);
    expect(plan.counts.contextPacks).toBe(1);
    expect(plan.conflicts).toEqual([]);
    const newProjectId = plan.projectIdMap[localProj.id];
    expect(newProjectId).toBeDefined();

    const snapshot = join(adminTmp, 'data.db.snapshot');
    snapshotLocalDb(join(adminTmp, 'data.db'), snapshot);
    const migrateResult = await executeMigration({ local: adminLocal, cloud, plan, snapshotPath: snapshot });
    if (migrateResult.status !== 'completed') {
      throw new Error(
        `migration did not complete: status=${migrateResult.status} error=${migrateResult.error ?? '(none)'}`,
      );
    }
    expect(migrateResult.status).toBe('completed');

    // Verify cloud has the rows with correct stamping.
    const cloudRuns = await cloud.db.select().from(postgresSchema.runs).where(eq(postgresSchema.runs.id, localRunId));
    expect(cloudRuns).toHaveLength(1);
    expect(cloudRuns[0]?.projectId).toBe(newProjectId as string);
    expect(cloudRuns[0]?.createdByUserId).toBe(ADMIN_USER);

    const cloudDecs = await cloud.db.select().from(postgresSchema.decisions);
    expect(cloudDecs).toHaveLength(2);
    expect(cloudDecs.every((d) => d.createdByUserId === ADMIN_USER)).toBe(true);

    // Verify local rewritten — project_id matches cloud.
    const localProjAfter = adminLocal.raw.prepare('SELECT id FROM projects WHERE slug = ?').get('acme-app') as {
      id: string;
    };
    expect(localProjAfter.id).toBe(newProjectId as string);

    // Verify idempotency: re-run does NOTHING new.
    const cloudRunCountBefore = (await cloud.db.select({ n: sql<number>`COUNT(*)` }).from(postgresSchema.runs))[0]!.n;
    const planAgain = await buildMigrationPlan({
      local: adminLocal,
      cloud,
      clerkUserId: ADMIN_USER,
      clerkOrgId: ORG_ID,
    });
    const r2 = await executeMigration({ local: adminLocal, cloud, plan: planAgain, snapshotPath: snapshot });
    expect(r2.status).toBe('completed');
    const cloudRunCountAfter = (await cloud.db.select({ n: sql<number>`COUNT(*)` }).from(postgresSchema.runs))[0]!.n;
    expect(Number(cloudRunCountAfter)).toBe(Number(cloudRunCountBefore));

    // STEP 5 — Member B's machine joins.
    upgradeToTeamConfig(
      {
        clerkUserId: MEMBER_USER,
        clerkOrgId: ORG_ID,
        clerkOrgSlug: 'acme',
        localHookSecret: HOOK_SECRET,
        joinedAt: Date.now(),
      },
      { homeOverride: memberConfigHome },
    );
    const memberConfig = readTeamConfig({ homeOverride: memberConfigHome });
    expect(memberConfig.mode).toBe('team');
    expect(memberConfig.team?.clerkUserId).toBe(MEMBER_USER);

    // STEP 6 — Member A (admin) writes a NEW decision (simulating ongoing work).
    const newDecisionId = 'dec_3_after_migrate';
    const newDecisionTime = new Date(1800000000 * 1000); // far future, beats local watermark
    await cloud.db.insert(postgresSchema.decisions).values({
      id: newDecisionId,
      idempotencyKey: 'dec:run1:c',
      runId: localRunId,
      description: 'wire team migration UX',
      rationale: 'admins need a clean bootstrap path',
      alternatives: '[]',
      createdByUserId: ADMIN_USER,
      createdAt: newDecisionTime,
    });

    // STEP 7 — Member B's pull-tick brings the new decision in.
    // We exercise the puller's logic directly here (running the
    // standalone team-rows-puller from sync-daemon would create a
    // dependency cycle; the puller's behavior is locked by its own
    // integration test).
    //
    // For the smoke test, simulate the same INSERT-ON-CONFLICT-DO-NOTHING
    // logic the puller uses, scoped to the member's local DB. This
    // verifies the FK relationships work — we have to pull the cloud
    // projects + runs first (member's local has no acme-app yet).
    await ensureGlobalProject(memberLocal);

    const cloudProjects = await cloud.db.select().from(postgresSchema.projects).where(sql`id != '__global__'`);
    for (const p of cloudProjects) {
      memberLocal.raw
        .prepare('INSERT OR IGNORE INTO projects (id, slug, org_id, name, cwd) VALUES (?, ?, ?, ?, ?)')
        .run(p.id, p.slug, p.orgId, p.name, p.cwd ?? null);
    }

    const cloudRunsForMember = await cloud.db.select().from(postgresSchema.runs);
    for (const r of cloudRunsForMember) {
      memberLocal.raw
        .prepare(
          `INSERT OR IGNORE INTO runs
            (id, project_id, session_id, agent_type, mode, status,
             issue_ref, pr_ref, base_sha, created_by_user_id, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.projectId,
          r.sessionId,
          r.agentType,
          r.mode,
          r.status,
          r.issueRef,
          r.prRef,
          r.baseSha,
          r.createdByUserId,
          Math.floor(r.startedAt.getTime() / 1000),
          r.endedAt === null ? null : Math.floor(r.endedAt.getTime() / 1000),
        );
    }

    const cloudDecsForMember = await cloud.db.select().from(postgresSchema.decisions);
    for (const d of cloudDecsForMember) {
      memberLocal.raw
        .prepare(
          `INSERT OR IGNORE INTO decisions
            (id, idempotency_key, run_id, description, rationale, alternatives,
             context, impact, confidence, reversible, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          d.id,
          d.idempotencyKey,
          d.runId,
          d.description,
          d.rationale,
          d.alternatives,
          d.context,
          d.impact,
          d.confidence,
          d.reversible === null ? null : d.reversible ? 1 : 0,
          d.createdByUserId,
          Math.floor(d.createdAt.getTime() / 1000),
        );
    }

    // Verify cross-team-member visibility — Member B sees Member A's NEW decision.
    const memberSeesNewDec = memberLocal.raw
      .prepare('SELECT description, created_by_user_id FROM decisions WHERE id = ?')
      .get(newDecisionId) as { description: string; created_by_user_id: string } | undefined;
    expect(memberSeesNewDec).toBeDefined();
    expect(memberSeesNewDec?.description).toBe('wire team migration UX');
    expect(memberSeesNewDec?.created_by_user_id).toBe(ADMIN_USER);

    // And Member B sees the original migrated rows too.
    const memberAllDecs = memberLocal.raw.prepare('SELECT COUNT(*) as n FROM decisions').get() as { n: number };
    expect(memberAllDecs.n).toBe(3); // 2 migrated + 1 new
  });
});

// Suppress lint warning on writeFileSync (kept available for future
// scenarios that need a synthetic feature-pack on disk).
void writeFileSync;
