import { randomUUID } from 'node:crypto';

import { createDb, migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { describe, expect, it } from 'vitest';

import { runMemoryRollupOnce } from '../../src/memory-rollup-worker.js';

/**
 * COOD-79 — rollup + prune contract.
 *
 * The load-bearing behaviours, in rough order of how expensive they
 * would be to discover in production:
 *
 *   1. **The prune invariant.** A raw row is never deleted until its
 *      day is rolled up. If this regresses, retention silently eats
 *      history the dashboard can never recover.
 *   2. **Cohort generation keying.** A pull after a compaction belongs
 *      to the NEW baseline generation. If generations collapse,
 *      pull-through reads artificially high on exactly the long
 *      sessions this epic exists to fix.
 *   3. **Idempotency.** The pass recomputes rather than accumulates, so
 *      a re-run, a crash mid-pass, or a late outbox delivery all
 *      converge instead of double-counting.
 *   4. **Zero-result searches count as accesses but not as items** —
 *      the asymmetry that makes wiki empty-answer rate measurable.
 */

function openMigrated(): SqliteHandle {
  const handle = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return handle;
}

const DAY_MS = 86_400_000;

/** `daysAgo: 0` is today (excluded from the daily rollup by design). */
async function insertAccess(
  handle: SqliteHandle,
  overrides: Partial<typeof sqliteSchema.memoryAccessEvents.$inferInsert> & { daysAgo?: number } = {},
): Promise<void> {
  const { daysAgo = 1, ...rest } = overrides;
  await handle.db.insert(sqliteSchema.memoryAccessEvents).values({
    id: randomUUID(),
    projectId: null,
    runId: null,
    channel: 'push',
    site: 'session_start_manifest',
    memoryType: 'context_pack',
    triggerType: 'session_start',
    createdAt: new Date(Date.now() - daysAgo * DAY_MS),
    ...rest,
  });
}

/** Cohorts require a real run row (FK), so tests that exercise them seed one. */
async function seedRun(handle: SqliteHandle): Promise<void> {
  await handle.db.insert(sqliteSchema.projects).values({ id: 'proj-1', orgId: 'org-1', slug: 'p1', name: 'P1' });
  await handle.db.insert(sqliteSchema.runs).values({
    id: 'run-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    agentType: 'claude_code',
    mode: 'solo',
  });
}

async function daily(handle: SqliteHandle) {
  return handle.db.select().from(sqliteSchema.memoryAccessDaily);
}
async function cohorts(handle: SqliteHandle) {
  return handle.db.select().from(sqliteSchema.memoryCohorts);
}
async function raw(handle: SqliteHandle) {
  return handle.db.select().from(sqliteSchema.memoryAccessEvents);
}

describe('runMemoryRollupOnce — daily rollup', () => {
  it('aggregates completed days and leaves today alone', async () => {
    const handle = openMigrated();
    try {
      await insertAccess(handle, { daysAgo: 1, bytes: 100, latencyMs: 10, memoryId: 'pack_a' });
      await insertAccess(handle, { daysAgo: 1, bytes: 50, latencyMs: 30, memoryId: 'pack_b' });
      // Today's partial day must not be written: a half-day rollup is
      // indistinguishable from a complete one once stored.
      await insertAccess(handle, { daysAgo: 0, bytes: 999, memoryId: 'pack_today' });

      await runMemoryRollupOnce(handle);

      const rows = await daily(handle);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accessCount).toBe(2);
      expect(rows[0]?.distinctItems).toBe(2);
      expect(rows[0]?.totalBytes).toBe(150);
      expect(rows[0]?.totalLatencyMs).toBe(40);
      expect(rows[0]?.maxLatencyMs).toBe(30);
    } finally {
      handle.close();
    }
  });

  it('counts a zero-result search as an access but not as an item', async () => {
    const handle = openMigrated();
    try {
      // wiki_ask that found nothing: memory_id NULL, result_count 0.
      await insertAccess(handle, {
        daysAgo: 1,
        channel: 'pull',
        site: 'wiki_ask',
        memoryType: 'wiki_page',
        triggerType: 'tool_call',
        memoryId: null,
        resultCount: 0,
      });
      await runMemoryRollupOnce(handle);

      const rows = await daily(handle);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accessCount, 'the ask happened').toBe(1);
      expect(rows[0]?.distinctItems, 'but nothing was returned').toBe(0);
    } finally {
      handle.close();
    }
  });

  it('counts stale-at-access separately from total accesses', async () => {
    const handle = openMigrated();
    try {
      await insertAccess(handle, { daysAgo: 1, memoryId: 'p1', freshnessStatusAtAccess: 'fresh' });
      await insertAccess(handle, { daysAgo: 1, memoryId: 'p2', freshnessStatusAtAccess: 'stale' });
      await insertAccess(handle, { daysAgo: 1, memoryId: 'p3', freshnessStatusAtAccess: null });
      await runMemoryRollupOnce(handle);

      const rows = await daily(handle);
      expect(rows[0]?.accessCount).toBe(3);
      // Only the explicitly-stale one counts; NULL is "unknown", not stale.
      expect(rows[0]?.staleAtAccessCount).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('is idempotent — a second pass recomputes rather than doubling', async () => {
    const handle = openMigrated();
    try {
      await insertAccess(handle, { daysAgo: 1, bytes: 100, memoryId: 'pack_a' });
      await runMemoryRollupOnce(handle);
      await runMemoryRollupOnce(handle);
      await runMemoryRollupOnce(handle);

      const rows = await daily(handle);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accessCount).toBe(1);
      expect(rows[0]?.totalBytes).toBe(100);
    } finally {
      handle.close();
    }
  });
});

describe('runMemoryRollupOnce — cohorts (pull-through)', () => {
  it('pairs a surfaced item with its later pull and times the gap', async () => {
    const handle = openMigrated();
    try {
      await seedRun(handle);
      // Surfaced in the manifest, pulled 5s later — the click-through
      // that makes stage-3 utilization measurable for the first time.
      await insertAccess(handle, {
        daysAgo: 1,
        projectId: 'proj-1',
        runId: 'run-1',
        memoryId: 'pack_a',
        channel: 'push',
      });
      await handle.db.insert(sqliteSchema.memoryAccessEvents).values({
        id: randomUUID(),
        projectId: 'proj-1',
        runId: 'run-1',
        channel: 'pull',
        site: 'read_context_pack',
        memoryType: 'context_pack',
        memoryId: 'pack_a',
        triggerType: 'tool_call',
        createdAt: new Date(Date.now() - DAY_MS + 5000),
      });

      await runMemoryRollupOnce(handle);

      const c = await cohorts(handle);
      expect(c).toHaveLength(1);
      expect(c[0]?.surfacedCount).toBe(1);
      expect(c[0]?.pulledCount).toBe(1);
      expect(c[0]?.timeToFirstPullMs).toBe(5000);
    } finally {
      handle.close();
    }
  });

  it('keys cohorts on baseline_generation so a post-compaction pull is a new cohort', async () => {
    const handle = openMigrated();
    try {
      await seedRun(handle);
      // Same run, same item, surfaced in generation 0 and again in
      // generation 1 after a compaction re-emitted the manifest.
      await insertAccess(handle, {
        daysAgo: 1,
        projectId: 'proj-1',
        runId: 'run-1',
        memoryId: 'pack_a',
        baselineGeneration: 0,
      });
      await insertAccess(handle, {
        daysAgo: 1,
        projectId: 'proj-1',
        runId: 'run-1',
        memoryId: 'pack_a',
        baselineGeneration: 1,
      });
      await insertAccess(handle, {
        daysAgo: 1,
        projectId: 'proj-1',
        runId: 'run-1',
        memoryId: 'pack_a',
        channel: 'pull',
        site: 'read_context_pack',
        triggerType: 'tool_call',
        baselineGeneration: 1,
      });

      await runMemoryRollupOnce(handle);

      const c = await cohorts(handle);
      expect(c, 'one cohort per generation').toHaveLength(2);
      const gen0 = c.find((r) => r.baselineGeneration === 0);
      const gen1 = c.find((r) => r.baselineGeneration === 1);
      // Without the generation key both pulls would land on one row and
      // pull-through would read 100% instead of the honest 50%.
      expect(gen0?.pulledCount, 'gen 0 was surfaced but never pulled').toBe(0);
      expect(gen1?.pulledCount).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('skips rows without a memory_id — nothing to measure pull-through for', async () => {
    const handle = openMigrated();
    try {
      await insertAccess(handle, { daysAgo: 1, memoryId: null, channel: 'pull', site: 'wiki_ask' });
      await runMemoryRollupOnce(handle);
      expect(await cohorts(handle)).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

describe('runMemoryRollupOnce — prune invariant', () => {
  it('does NOT delete raw rows whose day has no rollup', async () => {
    const handle = openMigrated();
    try {
      // 60 days old, well past a 30-day retention — but today's pass is
      // the first ever, and we prune before... no: the pass rolls up
      // first, so to isolate the invariant we prune with retention 0
      // against a day that is deliberately today (never rolled up).
      await insertAccess(handle, { daysAgo: 0, memoryId: 'pack_today' });

      await runMemoryRollupOnce(handle, 0);

      // Today has no rollup row (excluded by design), so the guard must
      // hold the raw row rather than deleting it.
      expect(await daily(handle)).toHaveLength(0);
      expect(await raw(handle), 'raw row must survive an un-rolled-up day').toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('deletes raw rows past retention once their day is rolled up', async () => {
    const handle = openMigrated();
    try {
      await insertAccess(handle, { daysAgo: 60, memoryId: 'pack_old' });
      await insertAccess(handle, { daysAgo: 1, memoryId: 'pack_recent' });

      const result = await runMemoryRollupOnce(handle, 30);

      // Both days rolled up; only the 60-day-old raw row is past retention.
      expect(await daily(handle)).toHaveLength(2);
      expect(result.pruned).toBe(1);
      const remaining = await raw(handle);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.memoryId).toBe('pack_recent');
    } finally {
      handle.close();
    }
  });

  it('keeps the cohort row after its raw events are pruned', async () => {
    const handle = openMigrated();
    try {
      // Dead-memory detection needs months of history; raw rows do not.
      await seedRun(handle);
      await insertAccess(handle, { daysAgo: 60, projectId: 'proj-1', runId: 'run-1', memoryId: 'pack_old' });

      await runMemoryRollupOnce(handle, 30);

      expect(await raw(handle), 'raw pruned').toHaveLength(0);
      const c = await cohorts(handle);
      expect(c, 'cohort survives to answer "never pulled"').toHaveLength(1);
      expect(c[0]?.memoryId).toBe('pack_old');
      expect(c[0]?.surfacedCount).toBe(1);
      expect(c[0]?.pulledCount).toBe(0);
    } finally {
      handle.close();
    }
  });
});
