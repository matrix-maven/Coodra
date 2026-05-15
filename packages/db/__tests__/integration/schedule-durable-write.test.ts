import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle, migrateSqlite, scheduleDurableWrite, sqliteSchema } from '../../src/index.js';

/**
 * Locks Module 03.1 S0 — `scheduleDurableWrite` is the only entry into
 * the durable-outbox enqueue path. The five cases below cover the
 * canonical envelope, caller-controlled dedupe, default `runAfter`,
 * arbitrary JSON payloads, and the new lifecycle columns
 * (picked_at / failed_at / last_error) defaulting to NULL.
 *
 * Why sqlite-only here: the helper is a thin Drizzle insert and the
 * pgvector container coverage already lands in
 * `postgres-migrate.test.ts` (the new "migration 0004" assertion).
 * Both dialects share the same Drizzle codepath and the unit-level
 * type test in `tsconfig.typecheck.json` ensures the postgres branch
 * compiles.
 */

let cwd: string;
let handle: DbHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'schedule-durable-write-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  if (handle?.kind === 'sqlite') handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('@coodra/db::scheduleDurableWrite', () => {
  it('inserts a pending row with the canonical envelope on a fresh enqueue', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const before = Date.now();
    const result = await scheduleDurableWrite(handle, {
      queue: 'run_event',
      payload: { kind: 'PreToolUse', toolName: 'Write' },
    });
    const after = Date.now();

    expect(result.enqueued).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await handle.db
      .select()
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.id, result.id));
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (!row) throw new Error('expected row');
    expect(row.queue).toBe('run_event');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(JSON.parse(row.payload)).toEqual({ kind: 'PreToolUse', toolName: 'Write' });

    // runAfter defaults to "now" — accept a 2s window either side to absorb
    // clock skew and the integer-timestamp truncation in the SQLite column.
    const runAfterMs = row.runAfter.getTime();
    expect(runAfterMs).toBeGreaterThanOrEqual(before - 2000);
    expect(runAfterMs).toBeLessThanOrEqual(after + 2000);
  });

  it('is a no-op (enqueued:false) when called twice with the same caller-supplied id', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const id = 'caller-controlled-id-xyz';
    const first = await scheduleDurableWrite(handle, {
      id,
      queue: 'policy_decision',
      payload: { tool: 'Bash', decision: 'allow' },
    });
    const second = await scheduleDurableWrite(handle, {
      id,
      queue: 'policy_decision',
      // Payload differs intentionally — second insert must NOT win and
      // must NOT overwrite the first row's payload.
      payload: { tool: 'Bash', decision: 'deny' },
    });
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.id).toBe(id);

    const rows = await handle.db
      .select({ payload: sqliteSchema.pendingJobs.payload })
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.id, id));
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]?.payload ?? '')).toEqual({ tool: 'Bash', decision: 'allow' });
  });

  it('honours an explicit future runAfter (worker eligibility deferral)', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const futureMs = Date.now() + 60_000;
    const result = await scheduleDurableWrite(handle, {
      queue: 'run_event',
      payload: {},
      runAfter: new Date(futureMs),
    });
    const rows = await handle.db
      .select({ runAfter: sqliteSchema.pendingJobs.runAfter })
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.id, result.id));
    const stored = rows[0]?.runAfter;
    expect(stored).toBeDefined();
    if (!stored) throw new Error('expected runAfter');
    // SQLite stores unix-seconds, so allow 1s rounding error.
    expect(Math.abs(stored.getTime() - futureMs)).toBeLessThanOrEqual(1000);
  });

  it('round-trips an arbitrary JSON-serializable payload (nested + arrays)', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const payload = {
      sessionId: 'http-abcd-1234',
      toolUseId: 'tu-99',
      meta: {
        nested: { depth: 2 },
        list: [1, 'two', false, null],
        unicode: 'résumé · ✅',
      },
    };
    const result = await scheduleDurableWrite(handle, { queue: 'run_event', payload });
    const rows = await handle.db
      .select({ payload: sqliteSchema.pendingJobs.payload })
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.id, result.id));
    expect(JSON.parse(rows[0]?.payload ?? '')).toEqual(payload);
  });

  it('stamps NULL on the new lifecycle columns at enqueue time', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const result = await scheduleDurableWrite(handle, { queue: 'session_open', payload: { sessionId: 'sx' } });
    const rows = await handle.db
      .select({
        pickedAt: sqliteSchema.pendingJobs.pickedAt,
        failedAt: sqliteSchema.pendingJobs.failedAt,
        lastError: sqliteSchema.pendingJobs.lastError,
      })
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.id, result.id));
    expect(rows[0]?.pickedAt).toBeNull();
    expect(rows[0]?.failedAt).toBeNull();
    expect(rows[0]?.lastError).toBeNull();
  });

  it('rejects an empty queue name (programming-bug guard)', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    await expect(scheduleDurableWrite(handle, { queue: '', payload: {} })).rejects.toThrow(/queue is required/);
  });
});
