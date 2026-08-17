import { describe, expect, it } from 'vitest';

import { readLookup } from '../../src/lib/dispatch.js';

/**
 * COOD-98 — grain lookups for the memory rollups.
 *
 * Every other sync lookup uses `kind: 'id'`, which works because those
 * rows are append-only. The rollups are not: `runMemoryRollupOnce`
 * recomputes by delete-then-insert and mints a fresh
 * `lower(hex(randomblob(16)))` each pass, so an id captured at enqueue
 * is routinely gone by dispatch while a different row holds the same
 * grain. Only the grain survives a recompute.
 *
 * A malformed lookup must return null so the dispatcher fails the job
 * PERMANENTLY. Retrying a payload that can never parse just occupies the
 * outbox forever.
 */

const DAILY = {
  kind: 'memory_daily_grain',
  projectId: 'proj_1',
  day: '2026-08-16',
  channel: 'pull',
  site: 'read_context_pack',
  memoryType: 'context_pack',
  actorUserId: 'user_alice',
};

const COHORT = {
  kind: 'memory_cohort_grain',
  runId: 'run_1',
  baselineGeneration: 2,
  memoryType: 'context_pack',
  memoryId: 'cp_1',
};

describe('readLookup — existing kinds still parse', () => {
  it('accepts id, idempotency_key and project_session', () => {
    expect(readLookup({ kind: 'id', value: 'x' })).toEqual({ kind: 'id', value: 'x' });
    expect(readLookup({ kind: 'idempotency_key', value: 'k' })).toEqual({ kind: 'idempotency_key', value: 'k' });
    expect(readLookup({ kind: 'project_session', projectId: 'p', sessionId: 's' })).toEqual({
      kind: 'project_session',
      projectId: 'p',
      sessionId: 's',
    });
  });
});

describe('readLookup — memory_daily_grain', () => {
  it('parses a complete grain', () => {
    expect(readLookup(DAILY)).toEqual(DAILY);
  });

  it('requires the actor — the field that stops two seats colliding', () => {
    const { actorUserId: _dropped, ...withoutActor } = DAILY;
    expect(readLookup(withoutActor)).toBeNull();
  });

  it.each(['projectId', 'day', 'channel', 'site', 'memoryType'])('rejects a grain missing %s', (field) => {
    const partial: Record<string, unknown> = { ...DAILY };
    delete partial[field];
    expect(readLookup(partial)).toBeNull();
  });

  it('rejects a non-string field rather than coercing it', () => {
    expect(readLookup({ ...DAILY, day: 20260816 })).toBeNull();
  });
});

describe('readLookup — memory_cohort_grain', () => {
  it('parses a complete grain', () => {
    expect(readLookup(COHORT)).toEqual(COHORT);
  });

  it('accepts generation 0, which is falsy but valid', () => {
    // The pre-compaction baseline. A truthiness check here would reject
    // every cohort from the first generation of every run.
    expect(readLookup({ ...COHORT, baselineGeneration: 0 })).toEqual({ ...COHORT, baselineGeneration: 0 });
  });

  it('requires a numeric generation', () => {
    expect(readLookup({ ...COHORT, baselineGeneration: '2' })).toBeNull();
  });

  it.each(['runId', 'memoryType', 'memoryId'])('rejects a grain missing %s', (field) => {
    const partial: Record<string, unknown> = { ...COHORT };
    delete partial[field];
    expect(readLookup(partial)).toBeNull();
  });
});

describe('readLookup — junk', () => {
  it('rejects non-objects and unknown kinds', () => {
    expect(readLookup(null)).toBeNull();
    expect(readLookup('memory_daily_grain')).toBeNull();
    expect(readLookup([DAILY])).toBeNull();
    expect(readLookup({ kind: 'not_a_kind', value: 'x' })).toBeNull();
  });
});
