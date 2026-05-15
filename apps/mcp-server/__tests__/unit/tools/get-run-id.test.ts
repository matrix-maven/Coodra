import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import { getRunIdInputSchema } from '../../../src/tools/get-run-id/schema.js';

/**
 * Unit tests for `coodra__get_run_id` — manifest contract + input
 * schema boundaries. The DB-backed behaviour is covered in
 * `__tests__/integration/tools/get-run-id.test.ts`.
 */

// A fake DbHandle is enough for registration — the handler closure is
// never invoked in these unit tests.
const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('get_run_id — manifest contract (via @coodra/shared/test-utils)', () => {
  it('satisfies every §24.3 rule (name shape, length, opening, word count, Returns)', () => {
    const registration = createGetRunIdToolRegistration({ db: fakeDb, mode: 'solo' });
    expect(() => assertManifestDescriptionValid(registration, { folderName: 'get-run-id' })).not.toThrow();
  });

  it('name is exactly "get_run_id"', () => {
    const registration = createGetRunIdToolRegistration({ db: fakeDb, mode: 'solo' });
    expect(registration.name).toBe('get_run_id');
  });

  it('idempotencyKey builder uses caller-supplied projectSlug + sessionId', () => {
    const registration = createGetRunIdToolRegistration({ db: fakeDb, mode: 'solo' });
    const key = registration.idempotencyKey(
      { projectSlug: 'my-project' },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('mutating');
    expect(key.key).toBe('get_run_id:my-project:sess_abc');
  });
});

describe('get_run_id — input schema boundaries', () => {
  it('accepts a valid projectSlug', () => {
    const result = getRunIdInputSchema.safeParse({ projectSlug: 'some-project' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty projectSlug', () => {
    const result = getRunIdInputSchema.safeParse({ projectSlug: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a projectSlug longer than 128 chars', () => {
    const result = getRunIdInputSchema.safeParse({ projectSlug: 'x'.repeat(129) });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const result = getRunIdInputSchema.safeParse({ projectSlug: 'ok', extra: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects missing projectSlug', () => {
    const result = getRunIdInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('get_run_id — factory construction contract', () => {
  it('rejects missing options', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: negative test
      createGetRunIdToolRegistration(undefined as unknown as any),
    ).toThrow(TypeError);
  });

  it('rejects a non-DbHandle db', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: negative test
      createGetRunIdToolRegistration({ db: {} as any, mode: 'solo' }),
    ).toThrow(/db must be a DbHandle/);
  });

  it('rejects an invalid mode', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: negative test
      createGetRunIdToolRegistration({ db: fakeDb, mode: 'other' as any }),
    ).toThrow(/mode must be/);
  });
});
