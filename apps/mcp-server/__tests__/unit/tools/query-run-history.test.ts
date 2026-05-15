import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createQueryRunHistoryToolRegistration } from '../../../src/tools/query-run-history/manifest.js';
import { queryRunHistoryInputSchema } from '../../../src/tools/query-run-history/schema.js';

/**
 * Unit tests for `coodra__query_run_history` — manifest contract +
 * input schema boundaries + idempotency-key shape + factory
 * construction contract. DB behaviour (project resolve, LEFT JOIN
 * title, status filter, DESC order, limit) is in the integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('query_run_history — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'query-run-history' })).not.toThrow();
  });

  it('name is exactly "query_run_history"', () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('query_run_history');
  });
});

describe('query_run_history — idempotency-key shape', () => {
  it('is readonly + encodes projectSlug + status + limit', () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'proj-a', status: 'in_progress', limit: 5 },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_run_history:proj-a:in_progress:5');
  });

  it("encodes 'any' when status is absent", () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'proj-a', limit: 10 },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.key).toBe('readonly:query_run_history:proj-a:any:10');
  });

  it('different (status, limit) combos yield distinct keys for log correlation', () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(
      { projectSlug: 'p', status: 'completed', limit: 10 },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const b = reg.idempotencyKey(
      { projectSlug: 'p', status: 'failed', limit: 10 },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const c = reg.idempotencyKey(
      { projectSlug: 'p', status: 'completed', limit: 50 },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(b.key).not.toBe(c.key);
  });

  it('truncates to 200 chars', () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'x'.repeat(256), status: 'in_progress', limit: 10 },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing', () => {
    const reg = createQueryRunHistoryToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, { sessionId: 'sess', receivedAt: new Date(0) });
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_run_history:probe:any:10');
  });
});

describe('query_run_history — input schema boundaries', () => {
  it('accepts a minimal valid payload (projectSlug only); limit defaults to 10', () => {
    const parsed = queryRunHistoryInputSchema.safeParse({ projectSlug: 'p' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(10);
      expect(parsed.data.status).toBeUndefined();
    }
  });

  it("accepts each status enum value ('in_progress', 'completed', 'failed')", () => {
    for (const status of ['in_progress', 'completed', 'failed'] as const) {
      expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', status }).success).toBe(true);
    }
  });

  it("rejects an invalid status value (e.g., 'unknown')", () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', status: 'unknown' }).success).toBe(false);
  });

  it('rejects empty projectSlug', () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: '' }).success).toBe(false);
  });

  it('rejects limit < 1', () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', limit: 0 }).success).toBe(false);
  });

  it('rejects limit > 200', () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', limit: 201 }).success).toBe(false);
  });

  it('rejects non-integer limit', () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', limit: 1.5 }).success).toBe(false);
  });

  it('accepts limit boundary values (1 and 200)', () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', limit: 1 }).success).toBe(true);
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', limit: 200 }).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', extra: 1 }).success).toBe(false);
  });
});

describe('query_run_history — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createQueryRunHistoryToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createQueryRunHistoryToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
