import { mkdtempSync, rmSync } from 'node:fs';
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
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTeamRowsPuller } from '../../src/lib/team-rows-puller.js';

/**
 * Module 04 Phase 4 — Caveat 1 fix. End-to-end pull-tick test against a
 * real Postgres + a real SQLite. Locks the contract:
 *
 *   1. Cloud rows newer than local max(created_at) per table land in
 *      local on the next tick.
 *   2. ON CONFLICT DO NOTHING — re-running a tick produces zero
 *      duplicates (idempotent).
 *   3. runs are pulled before dependents — so decision/context_pack
 *      FK lookups succeed in the same tick.
 *   4. created_by_user_id round-trips cleanly (the M04 Phase 4 column).
 *   5. Cloud-empty case → zero-summary, no errors.
 *
 * Skipped when DATABASE_URL is unset so local CI without docker still
 * runs the rest of the integration suite.
 */

const databaseUrl = process.env.DATABASE_URL;
const isEnabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

let tmpDir: string;
let local: SqliteHandle;
let cloud: PostgresHandle;

(isEnabled ? describe : describe.skip)('team-rows-puller (Caveat 1 fix)', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'team-rows-puller-'));
    local = createSqliteDb({ path: join(tmpDir, 'data.db') });
    migrateSqlite(local.db);
    await ensureGlobalProject(local);
  });

  afterEach(async () => {
    if (local) local.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (cloud) {
      await cloud.raw.unsafe('DELETE FROM run_events');
      await cloud.raw.unsafe('DELETE FROM policy_decisions');
      await cloud.raw.unsafe('DELETE FROM decisions');
      await cloud.raw.unsafe('DELETE FROM context_packs');
      // Phase F.1 — features rows must clear too; otherwise prior-test
      // cloud rows leak into the next test's "cloud-empty" assertion.
      await cloud.raw.unsafe('DELETE FROM features');
      // Phase F.2 — same for feature_packs.
      await cloud.raw.unsafe('DELETE FROM feature_packs');
      await cloud.raw.unsafe('DELETE FROM runs');
      await cloud.raw.unsafe(`DELETE FROM projects WHERE id <> '__global__'`);
    }
  });

  /** Mirror a projects row from cloud → local (would normally come from migration tooling). */
  async function mirrorProject(slug: string, orgId: string): Promise<string> {
    await ensureProject(cloud, { slug, orgId, name: slug });
    await ensureProject(local, { slug, orgId, name: slug });
    const row = (
      await cloud.db.select().from(postgresSchema.projects).where(eq(postgresSchema.projects.slug, slug))
    )[0];
    if (row === undefined) throw new Error('mirrorProject: cloud insert vanished');
    // Force local row's id to match cloud (so FK joins work both ways).
    local.raw.prepare('UPDATE projects SET id = ? WHERE slug = ?').run(row.id, slug);
    return row.id;
  }

  it('pulls runs + decisions + context_packs newer than local high-water-mark', async () => {
    const projectId = await mirrorProject('proj-pull-1', 'org-pull');

    // Seed cloud with a run + a decision + a context_pack as if a
    // teammate (alice) had created them.
    await cloud.db.insert(postgresSchema.runs).values({
      id: 'run_alice_1',
      projectId,
      sessionId: 'sess_alice_1',
      agentType: 'claude_code',
      mode: 'team',
      status: 'completed',
      createdByUserId: 'user_alice',
    });
    await cloud.db.insert(postgresSchema.decisions).values({
      id: 'dec_alice_1',
      idempotencyKey: 'dec:run_alice_1:abc',
      runId: 'run_alice_1',
      description: 'use postgres for cross-team sync',
      rationale: 'sqlite-vec does not federate',
      alternatives: '[]',
      createdByUserId: 'user_alice',
    });
    await cloud.db.insert(postgresSchema.contextPacks).values({
      id: 'cp_alice_1',
      runId: 'run_alice_1',
      projectId,
      title: "alice's session recap",
      content: '# Notes\n- decided on postgres sync',
      contentExcerpt: '# Notes',
      source: 'agent',
      createdByUserId: 'user_alice',
    });

    const puller = createTeamRowsPuller({ localDb: local, cloudDb: cloud, intervalMs: 60_000, skipInitialTick: true });
    try {
      // Trigger a single tick (initial tick fires on construction; await it).
      const summary = await puller.tickOnce();
      expect(summary.runs).toBeGreaterThanOrEqual(1);
      expect(summary.decisions).toBe(1);
      expect(summary.contextPacks).toBe(1);

      // Verify the rows landed locally with all fields preserved.
      const localRun = local.raw.prepare('SELECT id, created_by_user_id FROM runs WHERE id = ?').get('run_alice_1') as
        | { id: string; created_by_user_id: string | null }
        | undefined;
      expect(localRun?.created_by_user_id).toBe('user_alice');

      const localDec = local.raw
        .prepare('SELECT id, description, created_by_user_id FROM decisions WHERE id = ?')
        .get('dec_alice_1') as { id: string; description: string; created_by_user_id: string | null } | undefined;
      expect(localDec?.description).toBe('use postgres for cross-team sync');
      expect(localDec?.created_by_user_id).toBe('user_alice');

      const localCp = local.raw
        .prepare('SELECT id, title, created_by_user_id FROM context_packs WHERE id = ?')
        .get('cp_alice_1') as { id: string; title: string; created_by_user_id: string | null } | undefined;
      expect(localCp?.title).toBe("alice's session recap");
      expect(localCp?.created_by_user_id).toBe('user_alice');
    } finally {
      await puller.stop();
    }
  });

  it('is idempotent on re-tick — second tick adds zero rows', async () => {
    const projectId = await mirrorProject('proj-pull-idem', 'org-pull');
    await cloud.db.insert(postgresSchema.runs).values({
      id: 'run_dup_1',
      projectId,
      sessionId: 'sess_dup_1',
      agentType: 'claude_code',
      mode: 'team',
      status: 'completed',
      createdByUserId: 'user_alice',
    });

    const puller = createTeamRowsPuller({ localDb: local, cloudDb: cloud, intervalMs: 60_000, skipInitialTick: true });
    try {
      const first = await puller.tickOnce();
      expect(first.runs).toBeGreaterThanOrEqual(1);

      const second = await puller.tickOnce();
      expect(second.projects).toBe(0);
      expect(second.runs).toBe(0);
      expect(second.decisions).toBe(0);
      expect(second.contextPacks).toBe(0);
      expect(second.runEvents).toBe(0);
    } finally {
      await puller.stop();
    }
  });

  it('pulls projects from cloud — fresh teammate machine inherits the org\'s project list', async () => {
    // Simulate Bob's first sync. Cloud has a project Alice created;
    // Bob's local has only the __global__ sentinel. Pre-fix the puller
    // never pulled projects, so every subsequent runs/decisions row
    // referencing that project hit a local FK violation forever.
    await ensureProject(cloud, { slug: 'alice-project', orgId: 'org-acme', name: 'alice-project' });
    const cloudProject = (
      await cloud.db.select().from(postgresSchema.projects).where(eq(postgresSchema.projects.slug, 'alice-project'))
    )[0];
    if (cloudProject === undefined) throw new Error('seeded project vanished');

    // Bob's local does NOT have this project — only __global__.
    const beforeRows = local.raw.prepare('SELECT id FROM projects').all();
    expect(beforeRows.map((r: any) => r.id)).toEqual(['__global__']);

    // Seed a runs row that references the project so we can confirm the
    // FK chain unblocks once projects pull lands.
    await cloud.db.insert(postgresSchema.runs).values({
      id: 'run_alice_seed',
      projectId: cloudProject.id,
      sessionId: 'sess_alice_seed',
      agentType: 'claude_code',
      mode: 'team',
      status: 'completed',
      createdByUserId: 'user_alice',
    });

    const puller = createTeamRowsPuller({ localDb: local, cloudDb: cloud, intervalMs: 60_000, skipInitialTick: true });
    try {
      const summary = await puller.tickOnce();
      expect(summary.projects).toBeGreaterThanOrEqual(1);
      expect(summary.runs).toBeGreaterThanOrEqual(1);

      // Bob's local now has the project AND the run.
      const localProject = local.raw
        .prepare('SELECT id, slug, org_id FROM projects WHERE slug = ?')
        .get('alice-project') as { id: string; slug: string; org_id: string } | undefined;
      expect(localProject?.id).toBe(cloudProject.id);
      expect(localProject?.org_id).toBe('org-acme');

      const localRun = local.raw
        .prepare('SELECT id, project_id FROM runs WHERE id = ?')
        .get('run_alice_seed') as { id: string; project_id: string } | undefined;
      expect(localRun?.project_id).toBe(cloudProject.id);
    } finally {
      await puller.stop();
    }
  });

  it('skips __global__ + __solo__ rows when pulling projects', async () => {
    // The __global__ sentinel exists everywhere — re-pulling it would
    // break any local-side org-id customisation. Solo-mode projects
    // (org_id = '__solo__') belong to nobody's team and would pollute.
    // Both must be filtered out at pull time.
    await cloud.raw.unsafe(`UPDATE projects SET org_id = '__global__' WHERE id = '__global__'`);
    await ensureProject(cloud, { slug: 'orphan-solo-1', orgId: '__solo__', name: 'orphan-solo-1' });

    const puller = createTeamRowsPuller({ localDb: local, cloudDb: cloud, intervalMs: 60_000, skipInitialTick: true });
    try {
      await puller.tickOnce();
      const localOrphan = local.raw
        .prepare('SELECT id FROM projects WHERE slug = ?')
        .get('orphan-solo-1') as { id: string } | undefined;
      expect(localOrphan).toBeUndefined();
    } finally {
      await puller.stop();
    }
  });

  it('returns zero summary when cloud has no new rows', async () => {
    const puller = createTeamRowsPuller({ localDb: local, cloudDb: cloud, intervalMs: 60_000, skipInitialTick: true });
    try {
      const summary = await puller.tickOnce();
      expect(summary.projects).toBe(0);
      expect(summary.runs).toBe(0);
      expect(summary.decisions).toBe(0);
      expect(summary.contextPacks).toBe(0);
      expect(summary.runEvents).toBe(0);
      // Phase F.1 — features field exists on the summary.
      expect(summary.features).toBe(0);
      // Phase F.2 — feature_packs pull integrated into the same tick.
      expect(summary.featurePacks).toBe(0);
    } finally {
      await puller.stop();
    }
  });
});
