import { createDb, migrateSqlite } from '@coodra/db';
import { describe, expect, it } from 'vitest';

import { captureBaseSha } from '../../../src/lib/capture-base-sha.js';

/**
 * Module 06 — Slice 1. captureBaseSha contract:
 *
 *   1. UPDATE runs.base_sha when git rev-parse succeeds.
 *   2. Skip the UPDATE entirely on git failure (no_base_sha).
 *   3. Idempotent: a second call for the same (projectId, sessionId)
 *      with a different SHA is a no-op (the runs row's base_sha is
 *      already populated; WHERE base_sha IS NULL filters us out).
 *   4. Retry up to 3 times when the runs row hasn't landed yet.
 *
 * Real :memory: SQLite + migrations. The git subprocess is injected
 * via `gitRevParseHead` so the test never spawns a real `git`.
 */

interface SeedInput {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
}

function seedRun(handle: ReturnType<typeof createDb>, row: SeedInput): void {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.projectId, row.sessionId, 'claude_code', 'solo', 'in_progress', 1000);
}

function selectBaseSha(handle: ReturnType<typeof createDb>, runId: string): string | null {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  const row = handle.raw.prepare('SELECT base_sha FROM runs WHERE id = ?').get(runId) as
    | { base_sha: string | null }
    | undefined;
  return row?.base_sha ?? null;
}

describe('captureBaseSha — Module 06 Slice 1', () => {
  it('persists the SHA when git rev-parse succeeds', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run('proj_1', 'p1', '__solo__', 'p1');
    seedRun(db, { id: 'run_1', projectId: 'proj_1', sessionId: 'sess_a' });

    const sha = 'a'.repeat(40);
    const result = await captureBaseSha({
      cwd: '/tmp/somewhere',
      db,
      projectId: 'proj_1',
      sessionId: 'sess_a',
      gitRevParseHead: async () => sha,
    });

    expect(result.captured).toBe(true);
    expect(result.baseSha).toBe(sha);
    expect(selectBaseSha(db, 'run_1')).toBe(sha);
  });

  it("skips the UPDATE when git fails (returns reason='not_a_git_repo')", async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run('proj_1', 'p1', '__solo__', 'p1');
    seedRun(db, { id: 'run_1', projectId: 'proj_1', sessionId: 'sess_a' });

    const result = await captureBaseSha({
      cwd: '/tmp/not-a-git-repo',
      db,
      projectId: 'proj_1',
      sessionId: 'sess_a',
      gitRevParseHead: async () => null,
    });

    expect(result.captured).toBe(false);
    expect(result.reason).toBe('not_a_git_repo');
    expect(selectBaseSha(db, 'run_1')).toBeNull();
  });

  it('does not stomp an existing base_sha (idempotent on second fire)', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run('proj_1', 'p1', '__solo__', 'p1');
    seedRun(db, { id: 'run_1', projectId: 'proj_1', sessionId: 'sess_a' });

    const firstSha = 'b'.repeat(40);
    const secondSha = 'c'.repeat(40);

    const first = await captureBaseSha({
      cwd: '/tmp/wherever',
      db,
      projectId: 'proj_1',
      sessionId: 'sess_a',
      gitRevParseHead: async () => firstSha,
    });
    expect(first.captured).toBe(true);
    expect(selectBaseSha(db, 'run_1')).toBe(firstSha);

    const second = await captureBaseSha({
      cwd: '/tmp/wherever',
      db,
      projectId: 'proj_1',
      sessionId: 'sess_a',
      gitRevParseHead: async () => secondSha,
    });
    // The UPDATE matched 0 rows because the first call already set base_sha.
    expect(second.captured).toBe(false);
    expect(second.reason).toBe('runs_row_not_found');
    // First SHA is preserved.
    expect(selectBaseSha(db, 'run_1')).toBe(firstSha);
  });

  it('returns runs_row_not_found when no runs row matches (after retries)', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    db.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run('proj_1', 'p1', '__solo__', 'p1');
    // No runs row seeded.

    const result = await captureBaseSha({
      cwd: '/tmp/wherever',
      db,
      projectId: 'proj_1',
      sessionId: 'sess_missing',
      gitRevParseHead: async () => 'd'.repeat(40),
    });

    expect(result.captured).toBe(false);
    expect(result.reason).toBe('runs_row_not_found');
    // baseSha is set in the result (we got it from git), but no row was UPDATEd.
    expect(result.baseSha).toBe('d'.repeat(40));
  });
});
