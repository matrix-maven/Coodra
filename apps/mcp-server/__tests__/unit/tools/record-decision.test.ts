import { createHash } from 'node:crypto';

import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createRecordDecisionToolRegistration } from '../../../src/tools/record-decision/manifest.js';
import { recordDecisionInputSchema } from '../../../src/tools/record-decision/schema.js';

/**
 * Unit tests for `coodra__record_decision` — manifest contract +
 * input schema boundaries + idempotency-key shape + factory
 * construction contract. DB behaviour (insert + dedupe +
 * run_not_found soft-failure) is in the integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('record_decision — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createRecordDecisionToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'record-decision' })).not.toThrow();
  });

  it('name is exactly "record_decision"', () => {
    const reg = createRecordDecisionToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('record_decision');
  });
});

describe('record_decision — idempotency-key shape', () => {
  it('is mutating + encodes runId + sha256(description) prefix', () => {
    const reg = createRecordDecisionToolRegistration({ db: fakeDb });
    const description = 'pick cockatiel over opossum for retries';
    const hash = createHash('sha256').update(description).digest('hex').slice(0, 32);

    const key = reg.idempotencyKey(
      { runId: 'run_123', description, rationale: 'built-in jitter + typed breakers' },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );

    expect(key.kind).toBe('mutating');
    expect(key.key).toBe(`dec:run_123:${hash}`);
  });

  it('matches the handler key — identical description collides, different description does not', () => {
    const reg = createRecordDecisionToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(
      { runId: 'run_123', description: 'same body', rationale: 'r1' },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    const b = reg.idempotencyKey(
      { runId: 'run_123', description: 'same body', rationale: 'r2-different' },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    const c = reg.idempotencyKey(
      { runId: 'run_123', description: 'different body', rationale: 'r1' },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    // Same description → same key (rationale is NOT part of dedupe).
    expect(a.key).toBe(b.key);
    // Different description → different key.
    expect(a.key).not.toBe(c.key);
  });

  it('truncates to 200 chars', () => {
    const reg = createRecordDecisionToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { runId: 'r'.repeat(512), description: 'd'.repeat(2048), rationale: 'x' },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing (used by __probe__ registration sweep)', () => {
    const reg = createRecordDecisionToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, { sessionId: 'sess', receivedAt: new Date(0) });
    expect(key.kind).toBe('mutating');
    expect(typeof key.key).toBe('string');
  });
});

describe('record_decision — input schema boundaries', () => {
  it('accepts a minimal valid payload', () => {
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'run_1',
        description: 'd',
        rationale: 'r',
      }).success,
    ).toBe(true);
  });

  it('accepts an alternatives array of up to 10 strings', () => {
    const alts = Array.from({ length: 10 }, (_, i) => `alt-${i}`);
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'run_1',
        description: 'd',
        rationale: 'r',
        alternatives: alts,
      }).success,
    ).toBe(true);
  });

  it('rejects alternatives array of 11+ items', () => {
    const alts = Array.from({ length: 11 }, (_, i) => `alt-${i}`);
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'run_1',
        description: 'd',
        rationale: 'r',
        alternatives: alts,
      }).success,
    ).toBe(false);
  });

  it('rejects alternative string > 512 chars', () => {
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'run_1',
        description: 'd',
        rationale: 'r',
        alternatives: ['x'.repeat(513)],
      }).success,
    ).toBe(false);
  });

  it('rejects empty runId', () => {
    expect(recordDecisionInputSchema.safeParse({ runId: '', description: 'd', rationale: 'r' }).success).toBe(false);
  });

  it('rejects empty description', () => {
    expect(recordDecisionInputSchema.safeParse({ runId: 'r1', description: '', rationale: 'r' }).success).toBe(false);
  });

  it('rejects empty rationale', () => {
    expect(recordDecisionInputSchema.safeParse({ runId: 'r1', description: 'd', rationale: '' }).success).toBe(false);
  });

  it('rejects description > 2048 chars', () => {
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'r1',
        description: 'd'.repeat(2049),
        rationale: 'r',
      }).success,
    ).toBe(false);
  });

  it('rejects rationale > 8192 chars', () => {
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'r1',
        description: 'd',
        rationale: 'r'.repeat(8193),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      recordDecisionInputSchema.safeParse({
        runId: 'r1',
        description: 'd',
        rationale: 'r',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('record_decision — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createRecordDecisionToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createRecordDecisionToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
