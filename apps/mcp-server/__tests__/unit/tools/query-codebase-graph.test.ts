import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createQueryCodebaseGraphToolRegistration } from '../../../src/tools/query-codebase-graph/manifest.js';
import {
  queryCodebaseGraphInputSchema,
  queryCodebaseGraphOutputSchema,
} from '../../../src/tools/query-codebase-graph/schema.js';

/**
 * Unit tests for `coodra__query_codebase_graph` — manifest
 * contract + input schema boundaries + output schema (three branches
 * + observability primitives) + idempotency-key shape + factory
 * construction contract. DB + graphify behaviour
 * (getIndexStatus-before-expand ordering, per-slug cache, two
 * soft-failure distinct remediations) is in the integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('query_codebase_graph — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createQueryCodebaseGraphToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'query-codebase-graph' })).not.toThrow();
  });

  it('name is exactly "query_codebase_graph"', () => {
    const reg = createQueryCodebaseGraphToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('query_codebase_graph');
  });
});

describe('query_codebase_graph — idempotency-key shape', () => {
  it('is readonly + encodes projectSlug + query prefix', () => {
    const reg = createQueryCodebaseGraphToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'proj-a', query: 'getFeaturePack' },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_codebase_graph:proj-a:getFeaturePack');
  });

  it('different (slug, query) combos yield distinct keys', () => {
    const reg = createQueryCodebaseGraphToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey({ projectSlug: 'p', query: 'foo' }, { sessionId: 's', receivedAt: new Date(0) });
    const b = reg.idempotencyKey({ projectSlug: 'p', query: 'bar' }, { sessionId: 's', receivedAt: new Date(0) });
    const c = reg.idempotencyKey({ projectSlug: 'q', query: 'foo' }, { sessionId: 's', receivedAt: new Date(0) });
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it('truncates query prefix to 60 chars and total key to 200', () => {
    const reg = createQueryCodebaseGraphToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'x'.repeat(128), query: 'y'.repeat(500) },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing', () => {
    const reg = createQueryCodebaseGraphToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, { sessionId: 'sess', receivedAt: new Date(0) });
    expect(key.kind).toBe('readonly');
    expect(key.key).toBe('readonly:query_codebase_graph:probe:');
  });
});

describe('query_codebase_graph — input schema boundaries', () => {
  it('accepts a minimal valid payload', () => {
    expect(queryCodebaseGraphInputSchema.safeParse({ projectSlug: 'p', query: 'x' }).success).toBe(true);
  });

  it('rejects empty projectSlug', () => {
    expect(queryCodebaseGraphInputSchema.safeParse({ projectSlug: '', query: 'x' }).success).toBe(false);
  });

  it('rejects empty query (agents must supply a non-trivial symbol name at M02)', () => {
    expect(queryCodebaseGraphInputSchema.safeParse({ projectSlug: 'p', query: '' }).success).toBe(false);
  });

  it('rejects query > 2048 chars', () => {
    expect(queryCodebaseGraphInputSchema.safeParse({ projectSlug: 'p', query: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(queryCodebaseGraphInputSchema.safeParse({ projectSlug: 'p', query: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('query_codebase_graph — output schema branches', () => {
  it('rejects the success branch with the legacy `notice` field (M05 reshape removed it)', () => {
    // Pre-M05 the success branch carried a `notice: 'query_filtering_deferred_to_m05'`
    // string. The 2026-05-08 reshape (see schema.ts docblock) removed it
    // — agents now do their own filtering against `nodes` + `edges`. The
    // schema is `.strict()`, so a stale caller passing `notice` should
    // be rejected so the agent surfaces the breaking change explicitly
    // rather than silently dropping the field.
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: true,
      nodes: [],
      edges: [],
      indexed: true,
      notice: 'query_filtering_deferred_to_m05',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the success branch without notice (forward-compat for M05 typed filtering)', () => {
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: true,
      nodes: [{ id: 'n1' }],
      edges: [{ from: 'n1', to: 'n2' }],
      indexed: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects success with indexed: false (indexed is locked true on success branch)', () => {
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: true,
      nodes: [],
      edges: [],
      indexed: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts project_not_found soft-failure', () => {
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: false,
      error: 'project_not_found',
      howToFix: 'run coodra init',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts codebase_graph_not_indexed soft-failure', () => {
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: false,
      error: 'codebase_graph_not_indexed',
      howToFix: 'run graphify scan',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown soft-failure error code', () => {
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: false,
      error: 'something_else',
      howToFix: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown notice string', () => {
    const parsed = queryCodebaseGraphOutputSchema.safeParse({
      ok: true,
      nodes: [],
      edges: [],
      indexed: true,
      notice: 'custom_notice',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('query_codebase_graph — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createQueryCodebaseGraphToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createQueryCodebaseGraphToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
