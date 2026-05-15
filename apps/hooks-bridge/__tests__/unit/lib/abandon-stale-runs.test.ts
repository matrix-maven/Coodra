import { createDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { abandonStaleInProgressRuns } from '../../../src/lib/abandon-stale-runs.js';

/**
 * Slice 8 (2026-05-03 audit §14.3) — fire-and-forget orphan-run
 * cleanup invoked from the SessionStart handler. Locks the contract:
 *
 *   1. Sets status='abandoned' AND ended_at on prior in_progress runs
 *      for the same project.
 *   2. Excludes the new session_id so the just-arriving outbox insert
 *      is never clobbered.
 *   3. Other projects' in_progress runs are untouched.
 *   4. Already-completed / failed / abandoned runs are untouched.
 *   5. Returns { abandoned: N } so the caller has a count for telemetry.
 *
 * Real :memory: SQLite + migrations. No mocks for the thing under test
 * per `01-development-discipline.md` §1.1.
 */

interface SeedRunInput {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly status: 'in_progress' | 'completed' | 'failed' | 'abandoned';
  readonly endedAtSec?: number;
}

function seedRun(handle: ReturnType<typeof createDb>, row: SeedRunInput): void {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.projectId, row.sessionId, 'claude_code', 'solo', row.status, 1000, row.endedAtSec ?? null);
}

describe('abandonStaleInProgressRuns — Slice 8', () => {
  it('flips prior in_progress runs to abandoned + sets ended_at', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    const projectId = '00000000-0000-0000-0000-000000000001';
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run(projectId, 'p1', '__solo__', 'p1');
    seedRun(db, { id: 'run_old_a', projectId, sessionId: 'sess_old_a', status: 'in_progress' });
    seedRun(db, { id: 'run_old_b', projectId, sessionId: 'sess_old_b', status: 'in_progress' });
    seedRun(db, { id: 'run_new', projectId, sessionId: 'sess_new', status: 'in_progress' });

    const result = await abandonStaleInProgressRuns({
      db,
      projectId,
      excludeSessionId: 'sess_new',
    });
    expect(result.abandoned).toBe(2);

    const rows = (await db.db
      .select({ id: sqliteSchema.runs.id, status: sqliteSchema.runs.status, endedAt: sqliteSchema.runs.endedAt })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.projectId, projectId))) as Array<{
      id: string;
      status: string;
      endedAt: Date | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get('run_old_a')?.status).toBe('abandoned');
    expect(byId.get('run_old_a')?.endedAt).not.toBeNull();
    expect(byId.get('run_old_b')?.status).toBe('abandoned');
    expect(byId.get('run_old_b')?.endedAt).not.toBeNull();
    // The new session's run is preserved.
    expect(byId.get('run_new')?.status).toBe('in_progress');
    expect(byId.get('run_new')?.endedAt).toBeNull();
  });

  it('leaves other projects untouched', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    const projectA = '00000000-0000-0000-0000-00000000000a';
    const projectB = '00000000-0000-0000-0000-00000000000b';
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run(projectA, 'pA', '__solo__', 'pA');
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run(projectB, 'pB', '__solo__', 'pB');
    seedRun(db, { id: 'run_a_old', projectId: projectA, sessionId: 'a_old', status: 'in_progress' });
    seedRun(db, { id: 'run_b_old', projectId: projectB, sessionId: 'b_old', status: 'in_progress' });

    const result = await abandonStaleInProgressRuns({
      db,
      projectId: projectA,
      excludeSessionId: 'a_new',
    });
    expect(result.abandoned).toBe(1);

    const rowB = (await db.db
      .select({ status: sqliteSchema.runs.status })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, 'run_b_old'))
      .limit(1)) as Array<{ status: string }>;
    expect(rowB[0]?.status).toBe('in_progress');
  });

  it('does not touch runs already completed/failed/abandoned', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    const projectId = '00000000-0000-0000-0000-000000000002';
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run(projectId, 'p2', '__solo__', 'p2');
    seedRun(db, { id: 'run_done', projectId, sessionId: 'done', status: 'completed', endedAtSec: 1100 });
    seedRun(db, { id: 'run_fail', projectId, sessionId: 'fail', status: 'failed', endedAtSec: 1200 });
    seedRun(db, { id: 'run_abnd', projectId, sessionId: 'abnd', status: 'abandoned', endedAtSec: 1300 });
    seedRun(db, { id: 'run_open', projectId, sessionId: 'open', status: 'in_progress' });

    const result = await abandonStaleInProgressRuns({
      db,
      projectId,
      excludeSessionId: 'sess_brand_new',
    });
    expect(result.abandoned).toBe(1);

    const rows = (await db.db
      .select({ id: sqliteSchema.runs.id, status: sqliteSchema.runs.status, endedAt: sqliteSchema.runs.endedAt })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.projectId, projectId))) as Array<{
      id: string;
      status: string;
      endedAt: Date | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get('run_done')?.status).toBe('completed');
    expect(byId.get('run_done')?.endedAt?.getTime()).toBe(1100 * 1000);
    expect(byId.get('run_fail')?.status).toBe('failed');
    expect(byId.get('run_abnd')?.status).toBe('abandoned');
    expect(byId.get('run_open')?.status).toBe('abandoned'); // the only one flipped
  });

  it('returns abandoned:0 when there are no orphans', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    const projectId = '00000000-0000-0000-0000-000000000003';
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run(projectId, 'p3', '__solo__', 'p3');

    const result = await abandonStaleInProgressRuns({
      db,
      projectId,
      excludeSessionId: 'whatever',
    });
    expect(result.abandoned).toBe(0);
  });
});
