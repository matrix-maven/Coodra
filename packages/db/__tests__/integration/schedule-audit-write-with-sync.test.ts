import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  migrateSqlite,
  type SqliteHandle,
  scheduleAuditWriteWithSync,
  sqliteSchema,
} from '../../src/index.js';

/**
 * Module 04a S2 — `scheduleAuditWriteWithSync` pairs every audit-write
 * enqueue with a `sync_to_cloud` enqueue when the process is in team
 * mode. The five cases below cover:
 *   1. team mode + sync → both jobs land
 *   2. solo mode + sync → only audit job lands (no consumer for sync)
 *   3. team mode + no sync → only audit job lands (caller opted out)
 *   4. payload shape — sync row carries {table, lookup}
 *   5. env-driven mode (CONTEXTOS_MODE=team) → both jobs land without
 *      explicit args.mode
 *
 * Reuses the SQLite-only test scaffold from `schedule-durable-write.test.ts`.
 */

let cwd: string;
let handle: SqliteHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'schedule-audit-with-sync-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  if (handle) handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

afterEach(async () => {
  handle.raw.prepare('DELETE FROM pending_jobs').run();
});

describe('@coodra/contextos-db::scheduleAuditWriteWithSync', () => {
  it('enqueues paired audit + sync_to_cloud rows in team mode', async () => {
    const result = await scheduleAuditWriteWithSync(handle, {
      mode: 'team',
      audit: { queue: 'run_event', payload: { v: 1, rowId: 're_team1' } },
      sync: { table: 'run_events', lookup: { kind: 'id', value: 're_team1' } },
    });
    expect(result.audit.enqueued).toBe(true);
    expect(result.sync).toBeDefined();
    expect(result.sync?.enqueued).toBe(true);

    const all = await handle.db.select().from(sqliteSchema.pendingJobs);
    expect(all).toHaveLength(2);
    const audit = all.find((r) => r.queue === 'run_event');
    const sync = all.find((r) => r.queue === 'sync_to_cloud');
    expect(audit).toBeDefined();
    expect(sync).toBeDefined();
    if (sync === undefined) throw new Error('unreachable: expect(sync).toBeDefined() guards above');
    expect(JSON.parse(sync.payload)).toEqual({
      v: 1,
      table: 'run_events',
      lookup: { kind: 'id', value: 're_team1' },
    });
  });

  it('enqueues only the audit row in solo mode (sync skipped)', async () => {
    const result = await scheduleAuditWriteWithSync(handle, {
      mode: 'solo',
      audit: { queue: 'policy_decision', payload: { v: 1, fake: 'shape' } },
      sync: { table: 'policy_decisions', lookup: { kind: 'idempotency_key', value: 'pd:s1:t1:tn:PreToolUse' } },
    });
    expect(result.audit.enqueued).toBe(true);
    expect(result.sync).toBeUndefined();

    const all = await handle.db.select().from(sqliteSchema.pendingJobs);
    expect(all).toHaveLength(1);
    expect(all[0]?.queue).toBe('policy_decision');
  });

  it('enqueues only the audit row when sync is omitted', async () => {
    const result = await scheduleAuditWriteWithSync(handle, {
      mode: 'team',
      audit: { queue: 'session_close', payload: { v: 1 } },
    });
    expect(result.audit.enqueued).toBe(true);
    expect(result.sync).toBeUndefined();

    const all = await handle.db.select().from(sqliteSchema.pendingJobs);
    expect(all).toHaveLength(1);
    expect(all[0]?.queue).toBe('session_close');
  });

  it('reads CONTEXTOS_MODE from env when args.mode is undefined', async () => {
    const original = process.env.CONTEXTOS_MODE;
    process.env.CONTEXTOS_MODE = 'team';
    try {
      const result = await scheduleAuditWriteWithSync(handle, {
        audit: { queue: 'run_event', payload: { v: 1, rowId: 're_env_team' } },
        sync: { table: 'run_events', lookup: { kind: 'id', value: 're_env_team' } },
      });
      expect(result.sync?.enqueued).toBe(true);
      const all = await handle.db.select().from(sqliteSchema.pendingJobs);
      expect(all).toHaveLength(2);
    } finally {
      if (original === undefined) delete process.env.CONTEXTOS_MODE;
      else process.env.CONTEXTOS_MODE = original;
    }
  });

  it('treats CONTEXTOS_MODE=solo (or unset) as solo', async () => {
    const original = process.env.CONTEXTOS_MODE;
    delete process.env.CONTEXTOS_MODE;
    try {
      const result = await scheduleAuditWriteWithSync(handle, {
        audit: { queue: 'run_event', payload: { v: 1, rowId: 're_env_solo' } },
        sync: { table: 'run_events', lookup: { kind: 'id', value: 're_env_solo' } },
      });
      expect(result.sync).toBeUndefined();
      const all = await handle.db.select().from(sqliteSchema.pendingJobs);
      expect(all.filter((r) => r.queue === 'sync_to_cloud')).toHaveLength(0);
    } finally {
      if (original !== undefined) process.env.CONTEXTOS_MODE = original;
    }
  });

  it('paired enqueue is independent — sync uses a separate pending_jobs.id', async () => {
    const result = await scheduleAuditWriteWithSync(handle, {
      mode: 'team',
      audit: { queue: 'run_event', payload: { v: 1, rowId: 're_separate' } },
      sync: { table: 'run_events', lookup: { kind: 'id', value: 're_separate' } },
    });
    expect(result.audit.id).not.toBe(result.sync?.id);

    // Idempotent enqueue with same audit id is a no-op (checks the
    // helper still threads ScheduleDurableWriteArgs.id correctly).
    const second = await scheduleAuditWriteWithSync(handle, {
      mode: 'team',
      audit: { id: result.audit.id, queue: 'run_event', payload: { v: 1, rowId: 're_separate' } },
      sync: { table: 'run_events', lookup: { kind: 'id', value: 're_separate' } },
    });
    expect(second.audit.enqueued).toBe(false);
    // Sync gets a fresh UUID each call (we don't dedupe sync rows by audit id;
    // the daemon's destination INSERT is idempotent which protects against
    // double-push).
    const audits = await handle.db
      .select()
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.queue, 'run_event'));
    expect(audits).toHaveLength(1);
  });
});
