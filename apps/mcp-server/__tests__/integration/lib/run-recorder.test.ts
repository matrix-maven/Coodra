import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { ValidationError } from '@coodra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient } from '../../../src/lib/db.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * Integration test for `src/lib/run-recorder.ts` (S7c).
 *
 * Covers:
 *   - Construction contract.
 *   - record() validates args synchronously (before setImmediate).
 *   - record({ runId: 'run_abc' }) inserts a `run_events` row.
 *   - record({ runId: null }) inserts a row with run_id = NULL —
 *     proves the migration-0002 schema widening landed.
 *   - record() dedupes retries on the same idempotencyKey via ON
 *     CONFLICT DO NOTHING.
 *   - ON DELETE SET NULL cascade: deleting a run sets child
 *     run_events.run_id to NULL rather than orphan-blocking.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly runId: string;
  readonly projectId: string;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  const projectId = 'proj_rr';
  const runId = 'run_rr_primary';
  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
    .run(projectId, 'slug-rr', 'org_test', 'rr harness');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, projectId, 'sess_rr', 'claude_code', 'solo', 'in_progress');
  return {
    close: async () => {
      await client.close();
    },
    handle,
    runId,
    projectId,
  };
}

async function waitForInsert(handle: SqliteHandle): Promise<void> {
  // Module 03.1: record() writes to pending_jobs; the destination
  // run_events INSERT lands only after the OutboxWorker drains.
  // The helper ticks an in-process worker until empty.
  await drainOutbox(handle);
}

describe('lib/run-recorder — construction', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createRunRecorder(undefined as unknown as any)).toThrow(TypeError);
  });
  it('rejects missing db handle', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createRunRecorder({} as any)).toThrow(/db must be a DbHandle/);
  });
});

describe('lib/run-recorder — argument validation (synchronous)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('throws ValidationError for invalid phase', async () => {
    const r = createRunRecorder({ db: h.handle });
    // Negative test — casting an invalid literal into the phase slot.
    const badArgs = {
      runId: h.runId,
      toolName: 't',
      phase: 'bad' as 'pre' | 'post',
      sessionId: 's',
      idempotencyKey: { kind: 'readonly' as const, key: 'k' },
      input: {},
    };
    await expect(r.record(badArgs)).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for missing toolName', async () => {
    const r = createRunRecorder({ db: h.handle });
    await expect(
      r.record({
        runId: h.runId,
        toolName: '',
        phase: 'pre',
        sessionId: 's',
        idempotencyKey: { kind: 'readonly', key: 'k' },
        input: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('lib/run-recorder — insert happy paths', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('record({ runId: string }) inserts a run_events row via setImmediate', async () => {
    const r = createRunRecorder({ db: h.handle });
    await r.record({
      runId: h.runId,
      toolName: 'ping',
      phase: 'pre',
      sessionId: 'sess_1',
      idempotencyKey: { kind: 'readonly', key: 'idem_1' },
      input: { echo: 'x' },
    });
    await waitForInsert(h.handle);
    const row = h.handle.raw
      .prepare(`SELECT run_id, tool_name, phase FROM run_events WHERE tool_use_id = ?`)
      .get('idem_1') as { run_id: string; tool_name: string; phase: string } | undefined;
    expect(row?.run_id).toBe(h.runId);
    expect(row?.tool_name).toBe('ping');
    expect(row?.phase).toBe('pre');
  });

  it('record({ runId: null }) inserts a row with run_id = NULL (migration 0002 widening)', async () => {
    const r = createRunRecorder({ db: h.handle });
    await r.record({
      runId: null,
      toolName: 'ping',
      phase: 'pre',
      sessionId: 'sess_null',
      idempotencyKey: { kind: 'readonly', key: 'idem_null' },
      input: {},
    });
    await waitForInsert(h.handle);
    const row = h.handle.raw.prepare(`SELECT run_id FROM run_events WHERE tool_use_id = ?`).get('idem_null') as
      | { run_id: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.run_id).toBeNull();
  });

  it('dedupes retries with the same idempotencyKey via ON CONFLICT DO NOTHING', async () => {
    const r = createRunRecorder({ db: h.handle });
    const args = {
      runId: h.runId,
      toolName: 'ping',
      phase: 'pre' as const,
      sessionId: 'sess_dup',
      idempotencyKey: { kind: 'readonly' as const, key: 'idem_dup' },
      input: {},
    };
    await r.record(args);
    await r.record(args);
    await waitForInsert(h.handle);
    const rows = h.handle.raw.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE tool_use_id = ?`).get('idem_dup') as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});

describe('schema — ON DELETE SET NULL cascade on run_events.run_id (migration 0002)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('deleting the parent runs row sets child run_events.run_id to NULL', async () => {
    const r = createRunRecorder({ db: h.handle });
    await r.record({
      runId: h.runId,
      toolName: 'ping',
      phase: 'pre',
      sessionId: 'sess_cascade',
      idempotencyKey: { kind: 'readonly', key: 'idem_cascade' },
      input: {},
    });
    await waitForInsert(h.handle);
    // Confirm row has a real runId first.
    const before = h.handle.raw.prepare(`SELECT run_id FROM run_events WHERE tool_use_id = ?`).get('idem_cascade') as {
      run_id: string | null;
    };
    expect(before.run_id).toBe(h.runId);
    // Delete the parent runs row — ON DELETE SET NULL should nullify
    // the child's run_id instead of blocking the delete.
    h.handle.raw.prepare(`DELETE FROM runs WHERE id = ?`).run(h.runId);
    const after = h.handle.raw.prepare(`SELECT run_id FROM run_events WHERE tool_use_id = ?`).get('idem_cascade') as {
      run_id: string | null;
    };
    expect(after.run_id).toBeNull();
  });
});
