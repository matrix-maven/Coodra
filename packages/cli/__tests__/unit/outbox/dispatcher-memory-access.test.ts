import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openLocalDb } from '../../../src/lib/open-local-db.js';
import type { MemoryAccessPayloadV1 } from '../../../src/lib/outbox/dispatcher.js';
import { createOutboxDispatchHandler } from '../../../src/lib/outbox/dispatcher.js';
import type { OutboxJob } from '../../../src/lib/outbox/index.js';

/**
 * COOD-78 — `memory_access` queue dispatch.
 *
 * The contract this story ships: a memory surfacing enqueued through
 * the durable outbox lands in `memory_access_events`, and lands there
 * *without* the caller having had to resolve a run id inline.
 *
 * Two behaviours are load-bearing and easy to regress:
 *
 *   1. A run-resolution miss must still write the row with
 *      `run_id = NULL`. COOD-80's attribution chain deliberately
 *      declines to guess; if dispatch dropped those rows instead,
 *      utilization metrics would silently under-report exactly the
 *      sessions where attribution is hardest.
 *   2. A search that returned nothing must still write a row
 *      (`memory_id = NULL`, `result_count = 0`). That row is the only
 *      evidence of wiki empty-answer rate and "recipe never invoked".
 */

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memory-access-dispatch-'));
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

function job(payload: MemoryAccessPayloadV1, id = 'job-1'): OutboxJob {
  return { id, queue: 'memory_access', payload, attempt: 1 } as unknown as OutboxJob;
}

function basePayload(overrides: Partial<MemoryAccessPayloadV1> = {}): MemoryAccessPayloadV1 {
  return {
    v: 1,
    rowId: 'mae-1',
    resolution: { kind: 'pre_resolved', runId: null },
    channel: 'push',
    site: 'session_start_manifest',
    memoryType: 'context_pack',
    triggerType: 'session_start',
    ...overrides,
  };
}

async function rows(handle: SqliteHandle) {
  return handle.db.select().from(sqliteSchema.memoryAccessEvents);
}

describe('outbox dispatch — memory_access (COOD-78)', () => {
  it('writes a push row with the full metadata set', async () => {
    const handle = await openMigrated();
    try {
      const dispatch = createOutboxDispatchHandler({ db: handle });
      const outcome = await dispatch(
        job(
          basePayload({
            memoryId: 'pack_abc',
            position: 3,
            bytes: 512,
            latencyMs: 12,
            sessionId: 'sess-1',
            agentType: 'claude_code',
            queryHash: 'deadbeef',
            resultCount: 5,
            freshnessStatusAtAccess: 'fresh',
            baselineGeneration: 2,
          }),
        ),
      );
      expect(outcome.status).toBe('success');

      const all = await rows(handle);
      expect(all).toHaveLength(1);
      const row = all[0];
      expect(row?.channel).toBe('push');
      expect(row?.site).toBe('session_start_manifest');
      expect(row?.memoryType).toBe('context_pack');
      expect(row?.memoryId).toBe('pack_abc');
      expect(row?.position).toBe(3);
      expect(row?.bytes).toBe(512);
      expect(row?.latencyMs).toBe(12);
      expect(row?.agentType).toBe('claude_code');
      expect(row?.freshnessStatusAtAccess).toBe('fresh');
      expect(row?.baselineGeneration).toBe(2);
    } finally {
      handle.close();
    }
  });

  it('records the row with run_id NULL when attribution missed', async () => {
    const handle = await openMigrated();
    try {
      const dispatch = createOutboxDispatchHandler({ db: handle });
      // `session_lookup` against a project/session pair that has no
      // `runs` row — the shape COOD-80 produces on an attribution miss.
      const outcome = await dispatch(
        job(
          basePayload({
            resolution: { kind: 'session_lookup', sessionId: 'sess-unknown', projectId: 'proj-unknown' },
            channel: 'pull',
            site: 'read_context_pack',
            triggerType: 'tool_call',
            memoryId: 'pack_orphan',
          }),
        ),
      );
      expect(outcome.status).toBe('success');

      const all = await rows(handle);
      expect(all, 'an unattributed surfacing must still be recorded').toHaveLength(1);
      expect(all[0]?.runId).toBeNull();
      expect(all[0]?.memoryId).toBe('pack_orphan');
    } finally {
      handle.close();
    }
  });

  it('records an empty search result (memory_id NULL, result_count 0)', async () => {
    const handle = await openMigrated();
    try {
      const dispatch = createOutboxDispatchHandler({ db: handle });
      const outcome = await dispatch(
        job(
          basePayload({
            channel: 'pull',
            site: 'wiki_ask',
            memoryType: 'wiki_page',
            triggerType: 'tool_call',
            memoryId: null,
            resultCount: 0,
            queryHash: 'abc123',
          }),
        ),
      );
      expect(outcome.status).toBe('success');

      const all = await rows(handle);
      expect(all).toHaveLength(1);
      expect(all[0]?.memoryId, 'a zero-result search is still an access event').toBeNull();
      expect(all[0]?.resultCount).toBe(0);
      expect(all[0]?.queryHash).toBe('abc123');
    } finally {
      handle.close();
    }
  });

  it('is idempotent on rowId — a redelivered job does not duplicate', async () => {
    const handle = await openMigrated();
    try {
      const dispatch = createOutboxDispatchHandler({ db: handle });
      const payload = basePayload({ memoryId: 'pack_dupe' });
      await dispatch(job(payload, 'job-a'));
      // Same rowId, different job id — the worker reclaiming a lease
      // that timed out mid-write must not double-count utilization.
      const second = await dispatch(job(payload, 'job-b'));
      expect(second.status).toBe('success');

      const all = await handle.db
        .select()
        .from(sqliteSchema.memoryAccessEvents)
        .where(eq(sqliteSchema.memoryAccessEvents.memoryId, 'pack_dupe'));
      expect(all).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('rejects a payload missing required fields permanently, not transiently', async () => {
    const handle = await openMigrated();
    try {
      const dispatch = createOutboxDispatchHandler({ db: handle });
      const { channel: _dropped, ...withoutChannel } = basePayload();
      const outcome = await dispatch(job(withoutChannel as unknown as MemoryAccessPayloadV1));
      // Permanent, not transient: retrying a structurally invalid
      // payload can never succeed, and burning the backoff budget on it
      // would delay the valid rows behind it.
      expect(outcome.status).toBe('permanent_failure');
      expect(await rows(handle)).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('rejects an unknown channel value', async () => {
    const handle = await openMigrated();
    try {
      const dispatch = createOutboxDispatchHandler({ db: handle });
      const outcome = await dispatch(
        job(basePayload({ channel: 'shoved' as unknown as MemoryAccessPayloadV1['channel'] })),
      );
      expect(outcome.status).toBe('permanent_failure');
      expect(await rows(handle)).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});
