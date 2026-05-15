import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { getFeaturePackToolRegistration } from '../../../src/tools/get-feature-pack/manifest.js';
import { getFeaturePackInputSchema } from '../../../src/tools/get-feature-pack/schema.js';

/**
 * Unit tests for `coodra__get_feature_pack` — manifest contract +
 * input schema boundaries + idempotency-key shape. DB/filesystem
 * behaviour is covered in `__tests__/integration/tools/get-feature-
 * pack.test.ts`.
 */

describe('get_feature_pack — manifest contract (via @coodra/shared/test-utils)', () => {
  it('satisfies every §24.3 rule (name shape, length, opening, word count, Returns)', () => {
    expect(() =>
      assertManifestDescriptionValid(getFeaturePackToolRegistration, { folderName: 'get-feature-pack' }),
    ).not.toThrow();
  });

  it('name is exactly "get_feature_pack"', () => {
    expect(getFeaturePackToolRegistration.name).toBe('get_feature_pack');
  });
});

describe('get_feature_pack — idempotency-key shape', () => {
  it('is readonly + encodes projectSlug and filePath (wildcard when absent)', () => {
    const keyWithPath = getFeaturePackToolRegistration.idempotencyKey(
      { projectSlug: 'my-pack', filePath: 'src/foo.ts' },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(keyWithPath.kind).toBe('readonly');
    expect(keyWithPath.key).toBe('readonly:get_feature_pack:my-pack:src/foo.ts');

    const keyNoPath = getFeaturePackToolRegistration.idempotencyKey(
      { projectSlug: 'my-pack' },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(keyNoPath.kind).toBe('readonly');
    expect(keyNoPath.key).toBe('readonly:get_feature_pack:my-pack:*');
  });

  it('truncates to 200 chars', () => {
    const longSlug = 'x'.repeat(300);
    const key = getFeaturePackToolRegistration.idempotencyKey(
      { projectSlug: longSlug },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });
});

describe('get_feature_pack — input schema boundaries', () => {
  it('accepts projectSlug alone', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: 'ok' }).success).toBe(true);
  });

  it('accepts projectSlug + filePath', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: 'ok', filePath: 'src/a.ts' }).success).toBe(true);
  });

  it('rejects empty projectSlug', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: '' }).success).toBe(false);
  });

  it('rejects empty filePath', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: 'ok', filePath: '' }).success).toBe(false);
  });

  it('rejects projectSlug > 128 chars', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: 'x'.repeat(129) }).success).toBe(false);
  });

  it('rejects filePath > 1024 chars', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: 'ok', filePath: 'x'.repeat(1025) }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(getFeaturePackInputSchema.safeParse({ projectSlug: 'ok', extra: 1 }).success).toBe(false);
  });

  it('rejects missing projectSlug', () => {
    expect(getFeaturePackInputSchema.safeParse({}).success).toBe(false);
  });
});
