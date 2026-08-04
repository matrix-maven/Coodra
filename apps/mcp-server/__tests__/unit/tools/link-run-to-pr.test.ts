import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createLinkRunToPrToolRegistration } from '../../../src/tools/link-run-to-pr/manifest.js';
import { linkRunToPrInputSchema, linkRunToPrOutputSchema } from '../../../src/tools/link-run-to-pr/schema.js';

/**
 * Unit tests for `coodra__link_run_to_pr` — manifest contract + schema
 * boundaries, mirroring `link-run-to-issue.test.ts`. The DB-backed handler
 * behaviour is covered in `__tests__/integration/tools/link-run-to-pr.test.ts`.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('link_run_to_pr — manifest contract (via @coodra/shared/test-utils)', () => {
  it('satisfies every §24.3 rule (name shape, length, opening, word count, Returns)', () => {
    const registration = createLinkRunToPrToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(registration, { folderName: 'link-run-to-pr' })).not.toThrow();
  });

  it('name is exactly "link_run_to_pr"', () => {
    const registration = createLinkRunToPrToolRegistration({ db: fakeDb });
    expect(registration.name).toBe('link_run_to_pr');
  });

  it('idempotencyKey is mutating and keyed on runId + the trimmed prRef', () => {
    const registration = createLinkRunToPrToolRegistration({ db: fakeDb });
    const key = registration.idempotencyKey(
      { runId: 'run:p:s:u', prRef: ' 88 ' },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('mutating');
    expect(key.key).toBe('link_run_to_pr:run:p:s:u:88');
  });
});

describe('link_run_to_pr — input schema boundaries', () => {
  it('accepts a valid runId + PR reference', () => {
    const parsed = linkRunToPrInputSchema.safeParse({ runId: 'run:p:s:u', prRef: '88' });
    expect(parsed.success).toBe(true);
  });

  it('accepts varied PR reference shapes without any format constraint', () => {
    for (const ok of ['88', 'owner/repo#88', 'https://github.com/owner/repo/pull/88', 'MR!12']) {
      expect(linkRunToPrInputSchema.safeParse({ runId: 'r', prRef: ok }).success, ok).toBe(true);
    }
  });

  it('rejects an empty prRef', () => {
    expect(linkRunToPrInputSchema.safeParse({ runId: 'r', prRef: '' }).success).toBe(false);
  });

  it('rejects an empty runId', () => {
    expect(linkRunToPrInputSchema.safeParse({ runId: '', prRef: '88' }).success).toBe(false);
  });

  it('is strict — rejects unknown keys', () => {
    expect(linkRunToPrInputSchema.safeParse({ runId: 'r', prRef: '88', extra: true }).success).toBe(false);
  });
});

describe('link_run_to_pr — output schema (discriminated union on ok)', () => {
  it('parses the success branch', () => {
    const ok = linkRunToPrOutputSchema.safeParse({
      ok: true,
      runId: 'run:p:s:u',
      prRef: '88',
      previousPrRef: null,
      updated: true,
    });
    expect(ok.success).toBe(true);
  });

  it('parses the run_not_found soft-failure branch (error + howToFix)', () => {
    const fail = linkRunToPrOutputSchema.safeParse({
      ok: false,
      error: 'run_not_found',
      howToFix: 'Call get_run_id first.',
    });
    expect(fail.success).toBe(true);
  });

  it('rejects a success branch missing previousPrRef', () => {
    expect(linkRunToPrOutputSchema.safeParse({ ok: true, runId: 'r', prRef: '88', updated: true }).success).toBe(false);
  });
});
