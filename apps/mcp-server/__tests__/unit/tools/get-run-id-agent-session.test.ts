import type { DbHandle } from '@coodra/db';
import { describe, expect, it } from 'vitest';

import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import { getRunIdInputSchema } from '../../../src/tools/get-run-id/schema.js';

/**
 * Locks F9 + F10 closure (verification 2026-04-27) — `get_run_id`
 * accepts optional `agentSessionId` + `agentType` so the bridge and
 * MCP server agree on a single canonical `runs` row per logical
 * agent session. Without this, the bridge and MCP each minted their
 * own row keyed on different sessionId conventions
 * (event.session_id vs ctx.sessionId).
 *
 * Pure-input tests live here. The DB-backed handler behaviour
 * (find-existing-vs-mint, run_id encoding, agentType propagation
 * onto the runs row) is covered by the integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('get_run_id — agentSessionId + agentType inputs (F9 + F10)', () => {
  it('schema accepts a valid agentSessionId + agentType', () => {
    const result = getRunIdInputSchema.safeParse({
      projectSlug: 'p',
      agentSessionId: 'phase5-ts-1777276516460',
      agentType: 'claude_code',
    });
    expect(result.success).toBe(true);
  });

  it('schema rejects agentSessionId containing colon (runKeySegmentSchema)', () => {
    const result = getRunIdInputSchema.safeParse({
      projectSlug: 'p',
      agentSessionId: 'has:colon',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'agentSessionId');
      expect(issue).toBeDefined();
    }
  });

  it('schema rejects agentSessionId longer than 256 chars', () => {
    const result = getRunIdInputSchema.safeParse({
      projectSlug: 'p',
      agentSessionId: 'a'.repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it('schema rejects agentType outside the enum', () => {
    const result = getRunIdInputSchema.safeParse({
      projectSlug: 'p',
      agentType: 'gpt5', // not in enum
    });
    expect(result.success).toBe(false);
  });

  it('schema accepts when both fields are omitted (legacy callers preserved)', () => {
    const result = getRunIdInputSchema.safeParse({ projectSlug: 'p' });
    expect(result.success).toBe(true);
  });

  it('idempotency key uses agentSessionId when present (F9 dedupe contract)', () => {
    const registration = createGetRunIdToolRegistration({ db: fakeDb, mode: 'solo' });
    const key = registration.idempotencyKey(
      { projectSlug: 'my-proj', agentSessionId: 'agent-X' },
      { sessionId: 'http-transport-uuid', receivedAt: new Date(0) },
    );
    expect(key.key).toBe('get_run_id:my-proj:agent-X');
  });

  it('idempotency key falls back to ctx.sessionId when agentSessionId is omitted (legacy)', () => {
    const registration = createGetRunIdToolRegistration({ db: fakeDb, mode: 'solo' });
    const key = registration.idempotencyKey(
      { projectSlug: 'my-proj' },
      { sessionId: 'stdio-fallback', receivedAt: new Date(0) },
    );
    expect(key.key).toBe('get_run_id:my-proj:stdio-fallback');
  });
});
