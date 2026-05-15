import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createSaveContextPackToolRegistration } from '../../../src/tools/save-context-pack/manifest.js';
import { saveContextPackInputSchema } from '../../../src/tools/save-context-pack/schema.js';

/**
 * Unit tests for `coodra__save_context_pack` — manifest contract +
 * input schema boundaries + idempotency-key shape. DB behaviour
 * (runs SELECT, context_packs write, runs UPDATE) is covered in
 * `__tests__/integration/tools/save-context-pack.test.ts`.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('save_context_pack — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createSaveContextPackToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'save-context-pack' })).not.toThrow();
  });

  it('name is exactly "save_context_pack"', () => {
    const reg = createSaveContextPackToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('save_context_pack');
  });
});

describe('save_context_pack — idempotency-key shape', () => {
  it('is mutating + keys on runId alone (append-only per S7c)', () => {
    const reg = createSaveContextPackToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { runId: 'run_abc', title: 't', content: 'c' },
      { sessionId: 'sess_1', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('mutating');
    expect(key.key).toBe('save_context_pack:run_abc');
  });

  it('truncates to 200 chars', () => {
    const reg = createSaveContextPackToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      { runId: 'x'.repeat(300), title: 't', content: 'c' },
      { sessionId: 'sess', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });
});

describe('save_context_pack — input schema boundaries', () => {
  it('accepts a minimal valid payload', () => {
    expect(saveContextPackInputSchema.safeParse({ runId: 'r1', title: 't', content: 'body' }).success).toBe(true);
  });

  it('accepts featurePackId when supplied', () => {
    expect(
      saveContextPackInputSchema.safeParse({
        runId: 'r1',
        title: 't',
        content: 'body',
        featurePackId: 'fp_xyz',
      }).success,
    ).toBe(true);
  });

  it('rejects missing runId', () => {
    expect(saveContextPackInputSchema.safeParse({ title: 't', content: 'c' }).success).toBe(false);
  });

  it('rejects empty title', () => {
    expect(saveContextPackInputSchema.safeParse({ runId: 'r1', title: '', content: 'c' }).success).toBe(false);
  });

  it('rejects title > 512 chars', () => {
    expect(saveContextPackInputSchema.safeParse({ runId: 'r1', title: 'x'.repeat(513), content: 'c' }).success).toBe(
      false,
    );
  });

  it('rejects content > 1 MiB', () => {
    const oversized = 'x'.repeat(1_048_577);
    expect(saveContextPackInputSchema.safeParse({ runId: 'r1', title: 't', content: oversized }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(saveContextPackInputSchema.safeParse({ runId: 'r1', title: 't', content: 'c', extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('save_context_pack — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createSaveContextPackToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createSaveContextPackToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
