import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createLinkRunToIssueToolRegistration } from '../../../src/tools/link-run-to-issue/manifest.js';
import { linkRunToIssueInputSchema, linkRunToIssueOutputSchema } from '../../../src/tools/link-run-to-issue/schema.js';

/**
 * Unit tests for `coodra__link_run_to_issue` (Module 09 Track 9A, ADR-016)
 * — manifest contract + schema boundaries. The DB-backed handler behaviour
 * (SELECT → UPDATE runs.issue_ref, idempotency, rebind, soft-failure) is
 * covered in `__tests__/integration/tools/link-run-to-issue.test.ts`.
 */

// A fake DbHandle is enough for registration — the handler closure is
// never invoked in these unit tests.
const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('link_run_to_issue — manifest contract (via @coodra/shared/test-utils)', () => {
  it('satisfies every §24.3 rule (name shape, length, opening, word count, Returns)', () => {
    const registration = createLinkRunToIssueToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(registration, { folderName: 'link-run-to-issue' })).not.toThrow();
  });

  it('name is exactly "link_run_to_issue"', () => {
    const registration = createLinkRunToIssueToolRegistration({ db: fakeDb });
    expect(registration.name).toBe('link_run_to_issue');
  });

  it('idempotencyKey is mutating and keyed on runId + the UPPERCASED issueRef', () => {
    const registration = createLinkRunToIssueToolRegistration({ db: fakeDb });
    const key = registration.idempotencyKey(
      { runId: 'run:p:s:u', issueRef: 'proj-123' },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('mutating');
    expect(key.key).toBe('link_run_to_issue:run:p:s:u:PROJ-123');
  });
});

describe('link_run_to_issue — input schema boundaries', () => {
  it('accepts a valid runId + Jira key', () => {
    const parsed = linkRunToIssueInputSchema.safeParse({ runId: 'run:p:s:u', issueRef: 'PROJ-123' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a lowercase key (the handler upper-cases it)', () => {
    expect(linkRunToIssueInputSchema.safeParse({ runId: 'r', issueRef: 'proj-123' }).success).toBe(true);
  });

  it("accepts non-Jira-shaped references — format validation is the provider's job, not Coodra's", () => {
    for (const ok of ['PROJ', 'ENG-42', '123-45', 'my-manual-slug', 'issue#88']) {
      expect(linkRunToIssueInputSchema.safeParse({ runId: 'r', issueRef: ok }).success, ok).toBe(true);
    }
  });

  it('rejects an empty issueRef', () => {
    expect(linkRunToIssueInputSchema.safeParse({ runId: 'r', issueRef: '' }).success).toBe(false);
  });

  it('rejects an empty runId', () => {
    expect(linkRunToIssueInputSchema.safeParse({ runId: '', issueRef: 'PROJ-1' }).success).toBe(false);
  });

  it('is strict — rejects unknown keys', () => {
    expect(linkRunToIssueInputSchema.safeParse({ runId: 'r', issueRef: 'PROJ-1', extra: true }).success).toBe(false);
  });
});

describe('link_run_to_issue — output schema (discriminated union on ok)', () => {
  it('parses the success branch', () => {
    const ok = linkRunToIssueOutputSchema.safeParse({
      ok: true,
      runId: 'run:p:s:u',
      issueRef: 'PROJ-123',
      previousIssueRef: null,
      updated: true,
    });
    expect(ok.success).toBe(true);
  });

  it('parses the run_not_found soft-failure branch (error + howToFix)', () => {
    const fail = linkRunToIssueOutputSchema.safeParse({
      ok: false,
      error: 'run_not_found',
      howToFix: 'Call get_run_id first.',
    });
    expect(fail.success).toBe(true);
  });

  it('rejects a success branch missing previousIssueRef', () => {
    expect(
      linkRunToIssueOutputSchema.safeParse({ ok: true, runId: 'r', issueRef: 'PROJ-1', updated: true }).success,
    ).toBe(false);
  });
});
