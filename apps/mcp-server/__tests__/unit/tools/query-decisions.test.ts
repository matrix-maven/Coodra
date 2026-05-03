import type { DbHandle } from '@coodra/contextos-db';
import { assertManifestDescriptionValid } from '@coodra/contextos-shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createQueryDecisionsToolRegistration } from '../../../src/tools/query-decisions/manifest.js';
import { queryDecisionsInputSchema } from '../../../src/tools/query-decisions/schema.js';

/**
 * Unit tests for `contextos__query_decisions` (Slice 4 — 2026-05-03 audit).
 * Manifest contract + input schema boundaries + idempotency-key shape +
 * factory construction contract. DB behaviour (project resolve, INNER
 * JOIN runs, query LIKE filter, runId narrow filter, DESC order, limit)
 * lives in the integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('query_decisions — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'query-decisions' })).not.toThrow();
  });

  it('name is exactly "query_decisions"', () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('query_decisions');
  });
});

describe('query_decisions — idempotency-key shape', () => {
  it('is readonly + encodes projectSlug + query + runId + limit', () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'proj-a', query: 'storage', runId: 'run:p:s:u', limit: 5 },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_decisions:proj-a:storage:run:p:s:u:5');
  });

  it("encodes 'any' when query is absent", () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'proj-a', limit: 10 },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.key).toBe('readonly:query_decisions:proj-a:any:any:10');
  });

  it("encodes 'any' when runId is absent", () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'proj-a', query: 'auth', limit: 10 },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.key).toBe('readonly:query_decisions:proj-a:auth:any:10');
  });

  it('different (query, runId, limit) combos yield distinct keys for log correlation', () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(
      { projectSlug: 'p', query: 'storage', limit: 10 },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const b = reg.idempotencyKey(
      { projectSlug: 'p', query: 'auth', limit: 10 },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const c = reg.idempotencyKey(
      { projectSlug: 'p', query: 'storage', limit: 50 },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(b.key).not.toBe(c.key);
  });

  it('truncates to 200 chars', () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'x'.repeat(256), query: 'y'.repeat(256), limit: 10 },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing', () => {
    const reg = createQueryDecisionsToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, { sessionId: 'sess', receivedAt: new Date(0) });
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_decisions:probe:any:any:10');
  });
});

describe('query_decisions — input schema boundaries', () => {
  it('accepts a minimal valid payload (projectSlug only); limit defaults to 10', () => {
    const parsed = queryDecisionsInputSchema.safeParse({ projectSlug: 'p' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(10);
      expect(parsed.data.query).toBeUndefined();
      expect(parsed.data.runId).toBeUndefined();
    }
  });

  it('accepts an optional query string', () => {
    const parsed = queryDecisionsInputSchema.safeParse({ projectSlug: 'p', query: 'auth' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional runId string', () => {
    const parsed = queryDecisionsInputSchema.safeParse({ projectSlug: 'p', runId: 'run:p:s:u' });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty projectSlug', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: '' }).success).toBe(false);
  });

  it('rejects empty query string (use omit instead)', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', query: '' }).success).toBe(false);
  });

  it('rejects empty runId string (use omit instead)', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', runId: '' }).success).toBe(false);
  });

  it('rejects limit < 1', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', limit: 0 }).success).toBe(false);
  });

  it('rejects limit > 200', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', limit: 201 }).success).toBe(false);
  });

  it('rejects non-integer limit', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', limit: 1.5 }).success).toBe(false);
  });

  it('accepts limit boundary values (1 and 200)', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', limit: 1 }).success).toBe(true);
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', limit: 200 }).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(queryDecisionsInputSchema.safeParse({ projectSlug: 'p', extra: 1 }).success).toBe(false);
  });
});

describe('query_decisions — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createQueryDecisionsToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createQueryDecisionsToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
