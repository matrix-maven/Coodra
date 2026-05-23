import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createSeedFeaturePacksFromGraphToolRegistration } from '../../../src/tools/seed-feature-packs-from-graph/manifest.js';
import { seedFeaturePacksFromGraphInputSchema } from '../../../src/tools/seed-feature-packs-from-graph/schema.js';

/**
 * Unit tests for `coodra__seed_feature_packs_from_graph` (Module 09 / G2).
 * Manifest contract + idempotency-key shape + input-schema boundaries +
 * factory-construction contract. The DB behaviour (project resolve, draft
 * pack upsert, idempotent re-seed, status preservation) lives in the
 * integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

const minimalInput = {
  projectSlug: 'proj-a',
  communities: [{ communityId: 'c1', label: 'Auth Layer' }],
};

describe('seed_feature_packs_from_graph — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'seed-feature-packs-from-graph' })).not.toThrow();
  });

  it('name is exactly "seed_feature_packs_from_graph"', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('seed_feature_packs_from_graph');
  });
});

describe('seed_feature_packs_from_graph — idempotency-key shape', () => {
  it('is mutating + prefixed seed_fp: + encodes projectSlug', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(minimalInput, { sessionId: 'sess_1', receivedAt: new Date(0) });
    expect(key.kind).toBe('mutating');
    expect(key.key.startsWith('seed_fp:proj-a:')).toBe(true);
  });

  it('is pure — the same input yields a byte-identical key', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(minimalInput, { sessionId: 's', receivedAt: new Date(0) });
    const b = reg.idempotencyKey(minimalInput, { sessionId: 's', receivedAt: new Date(123_456) });
    expect(a.key).toBe(b.key);
  });

  it('distinct community id sets yield distinct keys for log correlation', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(
      { projectSlug: 'p', communities: [{ communityId: 'c1', label: 'L' }] },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const b = reg.idempotencyKey(
      { projectSlug: 'p', communities: [{ communityId: 'c2', label: 'L' }] },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(a.key).not.toBe(b.key);
  });

  it('truncates to 200 chars on an oversized projectSlug', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { projectSlug: 'x'.repeat(256), communities: [{ communityId: 'c1', label: 'L' }] },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing', () => {
    const reg = createSeedFeaturePacksFromGraphToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, { sessionId: 's', receivedAt: new Date(0) });
    expect(key.kind).toBe('mutating');
    expect(key.key.startsWith('seed_fp:probe:')).toBe(true);
  });
});

describe('seed_feature_packs_from_graph — input schema boundaries', () => {
  it('accepts a minimal valid payload (communityId + label only)', () => {
    expect(seedFeaturePacksFromGraphInputSchema.safeParse(minimalInput).success).toBe(true);
  });

  it('accepts optional godNodes, memberFiles, and summary', () => {
    const parsed = seedFeaturePacksFromGraphInputSchema.safeParse({
      projectSlug: 'p',
      communities: [
        {
          communityId: 'c1',
          label: 'Auth',
          godNodes: ['AuthService'],
          memberFiles: ['src/auth.ts'],
          summary: 'Handles auth.',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty projectSlug', () => {
    expect(
      seedFeaturePacksFromGraphInputSchema.safeParse({ projectSlug: '', communities: minimalInput.communities })
        .success,
    ).toBe(false);
  });

  it('rejects an empty communities array', () => {
    expect(seedFeaturePacksFromGraphInputSchema.safeParse({ projectSlug: 'p', communities: [] }).success).toBe(false);
  });

  it('rejects more than 100 communities', () => {
    const communities = Array.from({ length: 101 }, (_, i) => ({ communityId: `c${i}`, label: `L${i}` }));
    expect(seedFeaturePacksFromGraphInputSchema.safeParse({ projectSlug: 'p', communities }).success).toBe(false);
  });

  it('rejects a community missing communityId', () => {
    expect(
      seedFeaturePacksFromGraphInputSchema.safeParse({ projectSlug: 'p', communities: [{ label: 'L' }] }).success,
    ).toBe(false);
  });

  it('rejects a community missing label', () => {
    expect(
      seedFeaturePacksFromGraphInputSchema.safeParse({ projectSlug: 'p', communities: [{ communityId: 'c1' }] })
        .success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(seedFeaturePacksFromGraphInputSchema.safeParse({ ...minimalInput, extra: 1 }).success).toBe(false);
  });

  it('rejects unknown fields inside a community (strict)', () => {
    expect(
      seedFeaturePacksFromGraphInputSchema.safeParse({
        projectSlug: 'p',
        communities: [{ communityId: 'c1', label: 'L', bogus: true }],
      }).success,
    ).toBe(false);
  });
});

describe('seed_feature_packs_from_graph — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createSeedFeaturePacksFromGraphToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects a non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createSeedFeaturePacksFromGraphToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
