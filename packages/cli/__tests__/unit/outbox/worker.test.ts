import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openLocalDb } from '../../../src/lib/open-local-db.js';
import { type OutboxDispatchHandler, type OutboxJob, OutboxWorker } from '../../../src/lib/outbox/index.js';

/**
 * The OutboxWorker's correctness floor: each row dispatched at most
 * once across one OR many concurrent workers. The lease-race tests
 * (OQ2 add — sign-off 2026-04-27) prove the dedupe contract holds at
 * the lease-expiry edge, not just under sequential load.
 */

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'outbox-worker-test-'));
  dbPath = join(tmp, 'data.db');
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function openMigrated(): Promise<SqliteHandle> {
  const handle = await openLocalDb(dbPath, { loadVecExtension: true });
  migrateSqlite(handle.db);
  return handle;
}

function makeRecorder(): {
  handler: OutboxDispatchHandler;
  calls: OutboxJob[];
} {
  const calls: OutboxJob[] = [];
  const handler: OutboxDispatchHandler = async (job) => {
    calls.push(job);
    return { status: 'success' };
  };
  return { handler, calls };
}

describe('OutboxWorker — single-worker behavior', () => {
  it('claim → dispatch → delete on a successful tick', async () => {
    const handle = await openMigrated();
    const { handler, calls } = makeRecorder();
    const worker = new OutboxWorker({ db: handle, dispatchHandler: handler, tickMs: 60_000 });

    const enq = await scheduleDurableWrite(handle, {
      queue: 'run_event',
      payload: { phase: 'PreToolUse', toolName: 'Write' },
    });
    expect(enq.enqueued).toBe(true);

    await worker.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.queue).toBe('run_event');
    expect(calls[0]?.payload).toEqual({ phase: 'PreToolUse', toolName: 'Write' });
    expect(calls[0]?.attempts).toBe(1);

    const remaining = await handle.db.select().from(sqliteSchema.pendingJobs);
    expect(remaining).toHaveLength(0);

    await worker.stop();
    handle.close();
  });

  it('tick is a no-op when no rows are eligible', async () => {
    const handle = await openMigrated();
    const { handler, calls } = makeRecorder();
    const worker = new OutboxWorker({ db: handle, dispatchHandler: handler, tickMs: 60_000 });

    await worker.tick();
    expect(calls).toHaveLength(0);

    // Future-dated row must NOT be picked up.
    await scheduleDurableWrite(handle, {
      queue: 'run_event',
      payload: {},
      runAfter: new Date(Date.now() + 60_000),
    });
    await worker.tick();
    expect(calls).toHaveLength(0);

    await worker.stop();
    handle.close();
  });

  it('reclaims an orphan status="picked" row whose lease has expired', async () => {
    const handle = await openMigrated();
    const { handler, calls } = makeRecorder();
    const worker = new OutboxWorker({
      db: handle,
      dispatchHandler: handler,
      tickMs: 60_000,
      leaseMs: 30_000,
    });

    const enq = await scheduleDurableWrite(handle, { queue: 'run_event', payload: { v: 1 } });

    // Simulate a worker that pulled the row, started dispatch, was killed.
    const longAgoSec = Math.floor((Date.now() - 60_000) / 1000); // 60s ago, well past lease.
    handle.raw.prepare(`UPDATE pending_jobs SET status='picked', picked_at = ? WHERE id = ?`).run(longAgoSec, enq.id);

    await worker.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ v: 1 });

    await worker.stop();
    handle.close();
  });

  it('transient_failure → row stays pending, attempts++, last_error stamped, run_after advances', async () => {
    const handle = await openMigrated();
    const failing: OutboxDispatchHandler = async () => ({
      status: 'transient_failure',
      error: 'destination busy',
    });
    const worker = new OutboxWorker({ db: handle, dispatchHandler: failing, tickMs: 60_000 });

    const enq = await scheduleDurableWrite(handle, { queue: 'run_event', payload: {} });
    const beforeMs = Date.now();
    await worker.tick();
    const afterMs = Date.now();

    const row = (
      await handle.db.select().from(sqliteSchema.pendingJobs).where(eq(sqliteSchema.pendingJobs.id, enq.id))
    )[0];
    expect(row).toBeDefined();
    if (!row) throw new Error('row missing');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('destination busy');
    // Backoff after attempts=1 is 1000ms; allow 2s grace for SQLite second-truncation + clock skew.
    const runAfterMs = row.runAfter.getTime();
    expect(runAfterMs).toBeGreaterThanOrEqual(beforeMs);
    expect(runAfterMs).toBeLessThanOrEqual(afterMs + 5_000);
    expect(row.failedAt).toBeNull();

    await worker.stop();
    handle.close();
  });

  it('permanent_failure or attempts >= maxAttempts → row marked dead with failed_at + last_error', async () => {
    const handle = await openMigrated();
    const dispatch: OutboxDispatchHandler = async () => ({
      status: 'transient_failure',
      error: 'still busy',
    });
    const worker = new OutboxWorker({
      db: handle,
      dispatchHandler: dispatch,
      tickMs: 60_000,
      maxAttempts: 3, // tighter cap for this test
    });

    const enq = await scheduleDurableWrite(handle, { queue: 'run_event', payload: {} });
    // Pre-bump attempts so the next claim makes attempts=3 (== maxAttempts).
    handle.raw.prepare(`UPDATE pending_jobs SET attempts = 2 WHERE id = ?`).run(enq.id);

    await worker.tick();

    const row = (
      await handle.db.select().from(sqliteSchema.pendingJobs).where(eq(sqliteSchema.pendingJobs.id, enq.id))
    )[0];
    expect(row?.status).toBe('dead');
    expect(row?.attempts).toBe(3);
    expect(row?.failedAt).not.toBeNull();
    expect(row?.lastError).toBe('still busy');

    await worker.stop();
    handle.close();
  });

  it('permanent_failure on the first attempt marks dead immediately', async () => {
    const handle = await openMigrated();
    const dispatch: OutboxDispatchHandler = async () => ({
      status: 'permanent_failure',
      error: 'malformed payload',
    });
    const worker = new OutboxWorker({ db: handle, dispatchHandler: dispatch, tickMs: 60_000 });
    const enq = await scheduleDurableWrite(handle, { queue: 'run_event', payload: {} });

    await worker.tick();

    const row = (
      await handle.db.select().from(sqliteSchema.pendingJobs).where(eq(sqliteSchema.pendingJobs.id, enq.id))
    )[0];
    expect(row?.status).toBe('dead');
    expect(row?.attempts).toBe(1);
    expect(row?.failedAt).not.toBeNull();
    expect(row?.lastError).toBe('malformed payload');

    await worker.stop();
    handle.close();
  });

  it('thrown handler error is treated as transient_failure and stamped to last_error', async () => {
    const handle = await openMigrated();
    const dispatch: OutboxDispatchHandler = async () => {
      throw new Error('handler boom');
    };
    const worker = new OutboxWorker({ db: handle, dispatchHandler: dispatch, tickMs: 60_000 });
    const enq = await scheduleDurableWrite(handle, { queue: 'run_event', payload: {} });

    await worker.tick();

    const row = (
      await handle.db.select().from(sqliteSchema.pendingJobs).where(eq(sqliteSchema.pendingJobs.id, enq.id))
    )[0];
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBe('handler boom');

    await worker.stop();
    handle.close();
  });

  it('start() + kick() drains immediately without waiting for tickMs', async () => {
    const handle = await openMigrated();
    const { handler, calls } = makeRecorder();
    // tickMs intentionally huge — only kick() should drive this dispatch.
    const worker = new OutboxWorker({ db: handle, dispatchHandler: handler, tickMs: 60_000 });

    await scheduleDurableWrite(handle, { queue: 'run_event', payload: {} });
    worker.start();
    worker.kick();

    // Yield enough turns for the setTimeout(_, 0) to fire and the tick to complete.
    for (let i = 0; i < 50 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toHaveLength(1);

    await worker.stop();
    handle.close();
  });

  it('stop() waits for an in-flight dispatch before resolving', async () => {
    const handle = await openMigrated();
    let dispatchResolved = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch: OutboxDispatchHandler = async () => {
      await gate;
      dispatchResolved = true;
      return { status: 'success' };
    };
    const worker = new OutboxWorker({ db: handle, dispatchHandler: dispatch, tickMs: 60_000 });

    await scheduleDurableWrite(handle, { queue: 'run_event', payload: {} });
    const tickPromise = worker.tick();
    // Let the tick reach the dispatchHandler and become in-flight.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopPromise = worker.stop();
    expect(dispatchResolved).toBe(false);
    release();
    await Promise.all([tickPromise, stopPromise]);
    expect(dispatchResolved).toBe(true);

    handle.close();
  });
});

describe('OutboxWorker — concurrent workers (OQ2 lease-race regression)', () => {
  it('two workers tick simultaneously: a single pending row dispatches exactly once', async () => {
    const handleA = await openMigrated();
    const handleB = await openLocalDb(dbPath, { loadVecExtension: true });

    const callsA = vi.fn(async (_job: OutboxJob) => ({ status: 'success' }) as const);
    const callsB = vi.fn(async (_job: OutboxJob) => ({ status: 'success' }) as const);

    const workerA = new OutboxWorker({ db: handleA, dispatchHandler: callsA, tickMs: 60_000 });
    const workerB = new OutboxWorker({ db: handleB, dispatchHandler: callsB, tickMs: 60_000 });

    await scheduleDurableWrite(handleA, { id: 'race-pending', queue: 'run_event', payload: {} });

    // Fire both ticks together — exactly one must claim.
    await Promise.all([workerA.tick(), workerB.tick()]);

    expect(callsA.mock.calls.length + callsB.mock.calls.length).toBe(1);

    const rows = await handleA.db.select().from(sqliteSchema.pendingJobs);
    expect(rows).toHaveLength(0);

    await workerA.stop();
    await workerB.stop();
    handleA.close();
    handleB.close();
  });

  it('two workers tick simultaneously at the lease-expiry edge: orphan reclaim dispatches exactly once', async () => {
    const handleA = await openMigrated();
    const handleB = await openLocalDb(dbPath, { loadVecExtension: true });

    const callsA = vi.fn(async (_job: OutboxJob) => ({ status: 'success' }) as const);
    const callsB = vi.fn(async (_job: OutboxJob) => ({ status: 'success' }) as const);

    const leaseMs = 30_000;
    const workerA = new OutboxWorker({ db: handleA, dispatchHandler: callsA, tickMs: 60_000, leaseMs });
    const workerB = new OutboxWorker({ db: handleB, dispatchHandler: callsB, tickMs: 60_000, leaseMs });

    const enq = await scheduleDurableWrite(handleA, {
      id: 'race-orphan',
      queue: 'run_event',
      payload: {},
    });

    // Simulate a prior worker that picked this row and was killed mid-dispatch.
    // picked_at is well past the lease window so both workers see it as orphan.
    const expiredSec = Math.floor((Date.now() - leaseMs - 5_000) / 1000);
    handleA.raw.prepare(`UPDATE pending_jobs SET status='picked', picked_at = ? WHERE id = ?`).run(expiredSec, enq.id);

    await Promise.all([workerA.tick(), workerB.tick()]);

    expect(callsA.mock.calls.length + callsB.mock.calls.length).toBe(1);

    const rows = await handleA.db.select().from(sqliteSchema.pendingJobs);
    expect(rows).toHaveLength(0);

    await workerA.stop();
    await workerB.stop();
    handleA.close();
    handleB.close();
  });

  it('idempotency-storm: 10 workers race for 1 row across many ticks — exactly one dispatch', async () => {
    // Mirrors the F14 idempotency-storm pattern (apps/mcp-server tests).
    // Stress the atomic claim under many simultaneous workers.
    const handles: SqliteHandle[] = [];
    for (let i = 0; i < 10; i += 1) {
      handles.push(i === 0 ? await openMigrated() : await openLocalDb(dbPath, { loadVecExtension: true }));
    }
    const seed = handles[0];
    if (!seed) throw new Error('seed handle missing');

    const dispatches = handles.map(() => vi.fn(async (_job: OutboxJob) => ({ status: 'success' }) as const));
    const workers = handles.map(
      (h, i) =>
        new OutboxWorker({
          db: h,
          dispatchHandler: dispatches[i] as OutboxDispatchHandler,
          tickMs: 60_000,
        }),
    );

    await scheduleDurableWrite(seed, {
      id: 'race-storm',
      queue: 'run_event',
      payload: { storm: true },
    });

    await Promise.all(workers.map((w) => w.tick()));

    const totalCalls = dispatches.reduce((sum, fn) => sum + fn.mock.calls.length, 0);
    expect(totalCalls).toBe(1);

    const rows = await seed.db.select().from(sqliteSchema.pendingJobs);
    expect(rows).toHaveLength(0);

    for (const w of workers) await w.stop();
    for (const h of handles) h.close();
  });
});

describe('OutboxWorker — queue filter (Module 04a OQ7)', () => {
  it('only claims rows whose queue is in the filter', async () => {
    const handle = await openMigrated();
    const { handler, calls } = makeRecorder();
    const worker = new OutboxWorker({
      db: handle,
      dispatchHandler: handler,
      queueFilter: ['run_event', 'policy_decision'],
      tickMs: 60_000,
    });

    await scheduleDurableWrite(handle, { queue: 'run_event', payload: { v: 1 } });
    await scheduleDurableWrite(handle, { queue: 'sync_to_cloud', payload: { v: 1 } });

    await worker.tick();
    await worker.tick();
    await worker.tick();

    // Only the run_event row dispatches; the sync_to_cloud row remains pending.
    expect(calls.map((c) => c.queue)).toEqual(['run_event']);

    const remaining = await handle.db.select().from(sqliteSchema.pendingJobs);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.queue).toBe('sync_to_cloud');
    expect(remaining[0]?.status).toBe('pending');

    await worker.stop();
    handle.close();
  });

  it('leaves wrong-queue rows untouched when filter excludes them', async () => {
    const handle = await openMigrated();
    const { handler, calls } = makeRecorder();

    await scheduleDurableWrite(handle, { queue: 'sync_to_cloud', payload: { v: 1 } });
    const worker = new OutboxWorker({
      db: handle,
      dispatchHandler: handler,
      queueFilter: ['run_event'],
      tickMs: 60_000,
    });

    await worker.tick();
    await worker.tick();

    // The dispatch handler is never called: SQL filter excluded the row
    // and the row stays pending for whichever worker DOES claim it (the
    // sync-daemon's worker, in production).
    expect(calls).toHaveLength(0);
    const rows = await handle.db.select().from(sqliteSchema.pendingJobs);
    expect(rows[0]?.queue).toBe('sync_to_cloud');
    expect(rows[0]?.status).toBe('pending');

    await worker.stop();
    handle.close();
  });

  it('throws on construction when queueFilter is empty array', async () => {
    const handle = await openMigrated();
    const { handler } = makeRecorder();
    expect(() => new OutboxWorker({ db: handle, dispatchHandler: handler, queueFilter: [] })).toThrow(
      /queueFilter must contain at least one queue kind/,
    );
    handle.close();
  });
});
