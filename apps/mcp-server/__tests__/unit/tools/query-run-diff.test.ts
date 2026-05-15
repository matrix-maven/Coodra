import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createQueryRunDiffToolRegistration } from '../../../src/tools/query-run-diff/manifest.js';
import { queryRunDiffInputSchema } from '../../../src/tools/query-run-diff/schema.js';

/**
 * Unit tests for `coodra__query_run_diff` (Module 06) — manifest
 * contract + input schema boundaries + idempotency-key shape + factory
 * construction. DB behaviour (run-not-found, analysis-pending, error-
 * code routing, success-branch shape) lives in the integration suite
 * at `__tests__/integration/tools/query-run-diff.test.ts` so the unit
 * suite stays free of `ContextDeps`-shaped fixtures.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;
const fakeCtx = { sessionId: 'sess_test', receivedAt: new Date(0) };

describe('query_run_diff — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createQueryRunDiffToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'query-run-diff' })).not.toThrow();
  });

  it('name is exactly "query_run_diff"', () => {
    const reg = createQueryRunDiffToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('query_run_diff');
  });
});

describe('query_run_diff — idempotency-key shape', () => {
  it('is readonly + encodes runId', () => {
    const reg = createQueryRunDiffToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey({ runId: 'run_x' }, fakeCtx);
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_run_diff:run_x');
  });

  it('truncates to 200 chars', () => {
    const reg = createQueryRunDiffToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey({ runId: 'r'.repeat(256) }, fakeCtx);
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing', () => {
    const reg = createQueryRunDiffToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, fakeCtx);
    expect(key.kind).toBe('readonly');
    expect(key.key).toContain('readonly:query_run_diff:probe');
  });
});

describe('query_run_diff — input schema boundaries', () => {
  it('rejects empty runId', () => {
    expect(() => queryRunDiffInputSchema.parse({ runId: '' })).toThrow();
  });

  it('rejects an over-long runId (>256 chars)', () => {
    expect(() => queryRunDiffInputSchema.parse({ runId: 'r'.repeat(257) })).toThrow();
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() => queryRunDiffInputSchema.parse({ runId: 'run_a', extra: 'no' })).toThrow();
  });

  it('accepts a normal runId', () => {
    expect(queryRunDiffInputSchema.parse({ runId: 'run_a' })).toEqual({ runId: 'run_a' });
  });
});

describe('query_run_diff — factory construction', () => {
  it('throws on missing deps', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing the type-error branch
    expect(() => createQueryRunDiffToolRegistration(undefined as any)).toThrow();
  });

  it('throws on db that is not a DbHandle', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing the type-error branch
    expect(() => createQueryRunDiffToolRegistration({ db: {} as any })).toThrow();
  });
});
