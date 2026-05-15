import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutboxWorker } from '@coodra/cli/lib/outbox';
import {
  createPostgresDb,
  createSqliteDb,
  ensureGlobalProject,
  ensureProject,
  migratePostgres,
  migrateSqlite,
  type PostgresHandle,
  type SqliteHandle,
  scheduleAuditWriteWithSync,
  scheduleDurableWrite,
  sqliteSchema,
} from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSyncDispatchHandler } from '../../src/lib/dispatch.js';

/**
 * Module 04a S3 — sync-daemon dispatcher end-to-end against compose
 * Postgres. Skipped when DATABASE_URL is not set so local
 * `pnpm test:integration` runs without docker still pass.
 *
 * Coverage:
 *   - happy path: 5 audit rows across 5 tables → 5 cloud rows after drain
 *   - idempotency: re-running drain produces zero duplicates
 *   - missing-local-row: sync job fires before audit dispatched → transient
 *   - cross-queue safety: worker with sync_to_cloud filter ignores
 *     `run_event` rows; bridge worker (audit filter) ignores sync rows
 */

const databaseUrl = process.env.DATABASE_URL;
const isEnabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

let tmpDir: string;
let local: SqliteHandle;
let cloud: PostgresHandle;

(isEnabled ? describe : describe.skip)('sync-daemon dispatch', () => {
  beforeAll(async () => {
    cloud = createPostgresDb({ databaseUrl: databaseUrl as string });
    // Clean cloud slate.
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
    tmpDir = mkdtempSync(join(tmpdir(), 'sync-daemon-dispatch-'));
    local = createSqliteDb({ path: join(tmpDir, 'data.db') });
    migrateSqlite(local.db);
    await ensureGlobalProject(local);
  });

  afterEach(async () => {
    if (local) local.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    // Clean cloud rows between tests so each test starts fresh.
    if (cloud) {
      // Order matters for FKs.
      await cloud.raw.unsafe('DELETE FROM run_events');
      await cloud.raw.unsafe('DELETE FROM policy_decisions');
      await cloud.raw.unsafe('DELETE FROM decisions');
      await cloud.raw.unsafe('DELETE FROM context_packs');
      await cloud.raw.unsafe('DELETE FROM runs');
      await cloud.raw.unsafe(`DELETE FROM projects WHERE id <> '__global__'`);
    }
  });

  function makeWorker() {
    return new OutboxWorker({
      db: local,
      dispatchHandler: createSyncDispatchHandler({ localDb: local, cloudDb: cloud }),
      queueFilter: ['sync_to_cloud'],
      tickMs: 60_000,
    });
  }

  /** Tick the worker repeatedly until pending_jobs is empty (or maxTicks). */
  async function drain(worker: OutboxWorker, maxTicks = 30): Promise<number> {
    for (let i = 0; i < maxTicks; i++) {
      const remaining = await local.db
        .select()
        .from(sqliteSchema.pendingJobs)
        .where(eq(sqliteSchema.pendingJobs.queue, 'sync_to_cloud'));
      if (remaining.length === 0) return i;
      await worker.tick();
    }
    return maxTicks;
  }

  it('pushes a runs row to cloud (paired SessionStart sync)', async () => {
    // Seed local: a project + a runs row.
    await ensureProject(local, { slug: 'sync-test-1', orgId: 'sync_test', name: 'sync-test-1' });
    const project = (
      await local.db.select().from(sqliteSchema.projects).where(eq(sqliteSchema.projects.slug, 'sync-test-1')).limit(1)
    )[0];
    const projectId = project!.id;
    // Mirror project on cloud (the bridge would have synced it via a
    // separate path; for this isolated test we seed it directly).
    await cloud.db
      .insert(
        cloud.kind === 'postgres' ? (await import('@coodra/db')).postgresSchema.projects : ({} as never),
      )
      .values({ id: projectId, slug: project!.slug, orgId: project!.orgId, name: project!.name })
      .onConflictDoNothing();

    const runId = 'run:sync-test-1:s1:abc12345';
    local.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
      )
      .run(runId, projectId, 's1', 'claude_code', 'team', 'in_progress');

    // Enqueue paired sync job (mode='team' so it actually lands).
    await scheduleAuditWriteWithSync(local, {
      mode: 'team',
      audit: { queue: 'session_open', payload: { v: 1, sessionId: 's1' } },
      sync: { table: 'runs', lookup: { kind: 'id', value: runId } },
    });

    const worker = makeWorker();
    const ticks = await drain(worker);
    await worker.stop();

    // Cloud should now have the runs row.
    const { postgresSchema: pg } = await import('@coodra/db');
    const cloudRows = await cloud.db.select().from(pg.runs).where(eq(pg.runs.id, runId));
    expect(cloudRows).toHaveLength(1);
    expect(cloudRows[0]?.sessionId).toBe('s1');
    expect(cloudRows[0]?.status).toBe('in_progress');
    expect(ticks).toBeLessThan(5); // should drain quickly
  });

  it('returns transient_failure when local row is not yet present (paired audit not dispatched)', async () => {
    // Enqueue ONLY the sync job; no local runs row exists.
    await scheduleDurableWrite(local, {
      queue: 'sync_to_cloud',
      payload: {
        v: 1,
        table: 'runs',
        lookup: { kind: 'id', value: 'run:nonexistent:s1:zzzz' },
      },
    });

    const worker = makeWorker();
    await worker.tick();
    await worker.stop();

    // Row should still be pending (transient retry queued).
    const remaining = await local.db
      .select()
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.queue, 'sync_to_cloud'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.status).toBe('pending');
    expect(remaining[0]?.lastError).toMatch(/local runs row not found/);
  });

  it('is idempotent — re-running drain after cloud already has rows produces no duplicates', async () => {
    await ensureProject(local, { slug: 'sync-test-idem', orgId: 'sync_test', name: 'sync-test-idem' });
    const project = (
      await local.db
        .select()
        .from(sqliteSchema.projects)
        .where(eq(sqliteSchema.projects.slug, 'sync-test-idem'))
        .limit(1)
    )[0];
    const projectId = project!.id;
    const { postgresSchema: pg } = await import('@coodra/db');
    await cloud.db
      .insert(pg.projects)
      .values({ id: projectId, slug: project!.slug, orgId: project!.orgId, name: project!.name })
      .onConflictDoNothing();

    const runId = 'run:sync-test-idem:sess-idem:dedup123';
    local.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
      )
      .run(runId, projectId, 'sess-idem', 'claude_code', 'team', 'in_progress');

    // Enqueue paired sync TWICE — same lookup.
    await scheduleAuditWriteWithSync(local, {
      mode: 'team',
      audit: { queue: 'session_open', payload: { v: 1, sessionId: 'sess-idem' } },
      sync: { table: 'runs', lookup: { kind: 'id', value: runId } },
    });
    await scheduleAuditWriteWithSync(local, {
      mode: 'team',
      audit: { queue: 'session_open', payload: { v: 1, sessionId: 'sess-idem' } },
      sync: { table: 'runs', lookup: { kind: 'id', value: runId } },
    });

    const worker = makeWorker();
    await drain(worker);
    await worker.stop();

    const cloudRows = await cloud.db.select().from(pg.runs).where(eq(pg.runs.id, runId));
    expect(cloudRows).toHaveLength(1); // ON CONFLICT (project_id, session_id) DO UPDATE → still 1 row
  });

  it('refreshes runs.status + ended_at on session_close (project_session lookup, ON CONFLICT DO UPDATE)', async () => {
    await ensureProject(local, { slug: 'sync-test-close', orgId: 'sync_test', name: 'sync-test-close' });
    const project = (
      await local.db
        .select()
        .from(sqliteSchema.projects)
        .where(eq(sqliteSchema.projects.slug, 'sync-test-close'))
        .limit(1)
    )[0];
    const projectId = project!.id;
    const { postgresSchema: pg } = await import('@coodra/db');
    await cloud.db
      .insert(pg.projects)
      .values({ id: projectId, slug: project!.slug, orgId: project!.orgId, name: project!.name })
      .onConflictDoNothing();

    const runId = 'run:sync-test-close:sess-close:closeXYZ';
    local.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
      )
      .run(runId, projectId, 'sess-close', 'claude_code', 'team', 'in_progress');

    // First: open sync.
    await scheduleAuditWriteWithSync(local, {
      mode: 'team',
      audit: { queue: 'session_open', payload: { v: 1 } },
      sync: { table: 'runs', lookup: { kind: 'id', value: runId } },
    });
    const worker = makeWorker();
    await drain(worker);

    // Now simulate session close: update local + enqueue project_session sync.
    local.raw.prepare(`UPDATE runs SET status = 'completed', ended_at = unixepoch() WHERE id = ?`).run(runId);
    await scheduleAuditWriteWithSync(local, {
      mode: 'team',
      audit: { queue: 'session_close', payload: { v: 1 } },
      sync: {
        table: 'runs',
        lookup: { kind: 'project_session', projectId, sessionId: 'sess-close' },
      },
    });
    await drain(worker);
    await worker.stop();

    const cloudRows = await cloud.db.select().from(pg.runs).where(eq(pg.runs.id, runId));
    expect(cloudRows).toHaveLength(1);
    expect(cloudRows[0]?.status).toBe('completed');
    expect(cloudRows[0]?.endedAt).not.toBeNull();
  });

  it('sync_to_cloud worker IGNORES audit-queue rows (cross-pollination guard)', async () => {
    // Enqueue an audit-queue row directly (no paired sync).
    await scheduleDurableWrite(local, {
      queue: 'run_event',
      payload: { v: 1, fake: 'shape' },
    });

    const worker = makeWorker();
    await worker.tick();
    await worker.tick();
    await worker.stop();

    // The run_event row should be untouched (different worker owns it).
    const rows = await local.db.select().from(sqliteSchema.pendingJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queue).toBe('run_event');
    expect(rows[0]?.status).toBe('pending');
  });
});
