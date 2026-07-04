import { randomUUID } from 'node:crypto';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDbClient } from '../../../src/lib/db.js';
import {
  buildPolicyDecisionIdempotencyKey,
  createPolicyClient,
  recordPolicyDecision,
} from '../../../src/lib/policy.js';

/**
 * End-to-end integration test for the real policy engine against an
 * in-memory SQLite handle. Proves:
 *
 *   1. `createPolicyClient` reads `policies` + `policy_rules`, caches
 *      the result within the TTL window, and refreshes after TTL.
 *   2. No-rules cache returns `{ decision: 'allow', reason:
 *      'no_rule_matched' }`.
 *   3. A seeded `deny` rule is matched with `matchedRuleId` populated.
 *   4. Breaker fails open after the configured consecutive failures.
 *   5. `recordPolicyDecision` writes a single row and ON CONFLICT
 *      dedupes a retry with the same idempotency key.
 *
 * The test uses the SAME migration path production uses (`migrateSqlite`
 * from `@coodra/db`) so the schema here is byte-identical to the
 * server's. The sqlite-vec extension is disabled — this test has
 * nothing to do with embeddings.
 */

interface Harness {
  client: ReturnType<typeof createDbClient>['client'];
  handle: SqliteHandle;
  projectId: string;
}

function openTestDb(): Harness {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    // vec extension must load so migration 0001 (which contains a
    // CREATE VIRTUAL TABLE USING vec0 preserve-block) can run.
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') {
    throw new Error('expected sqlite handle');
  }
  migrateSqlite(handle.db);
  const projectId = `proj_${randomUUID()}`;
  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
    .run(projectId, `slug-${projectId}`, 'org_test', 'test project');
  return { client, handle, projectId };
}

describe('lib/policy — createPolicyClient against real SQLite', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = openTestDb();
    return async () => {
      await harness.client.close();
    };
  });

  it('allows when no rules are active (reason = no_rule_matched)', async () => {
    const policy = createPolicyClient({ db: harness.handle });
    const out = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 'sess_1',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(out.decision).toBe('allow');
    expect(out.reason).toBe('no_rule_matched');
    expect(out.matchedRuleId).toBeNull();
  });

  it('denies when a deny rule matches, exposing matchedRuleId', async () => {
    const policyId = `pol_${randomUUID()}`;
    const ruleId = `rule_${randomUUID()}`;
    harness.handle.raw
      .prepare(`INSERT INTO policies (id, project_id, name, description, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run(policyId, harness.projectId, 'block pings', 'test');
    harness.handle.raw
      .prepare(
        `INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name,
          match_path_glob, match_agent_type, decision, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ruleId, policyId, 10, 'PreToolUse', 'ping', null, '*', 'deny', 'blocked in test');

    const policy = createPolicyClient({ db: harness.handle });
    const out = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 'sess_1',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(out.decision).toBe('deny');
    expect(out.matchedRuleId).toBe(ruleId);
    expect(out.reason).toBe('blocked in test');
  });

  it('respects first-match-wins by priority ASC across two rules', async () => {
    const policyId = `pol_${randomUUID()}`;
    harness.handle.raw
      .prepare(`INSERT INTO policies (id, project_id, name, is_active) VALUES (?, ?, ?, 1)`)
      .run(policyId, harness.projectId, 'ordered');

    const lowPri = `rule_${randomUUID()}`;
    const highPri = `rule_${randomUUID()}`;
    harness.handle.raw
      .prepare(
        `INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name,
          match_path_glob, match_agent_type, decision, reason)
         VALUES
           (?, ?, 10, 'PreToolUse', 'ping', NULL, '*', 'deny', 'first'),
           (?, ?, 50, 'PreToolUse', 'ping', NULL, '*', 'allow', 'second')`,
      )
      .run(lowPri, policyId, highPri, policyId);

    const policy = createPolicyClient({ db: harness.handle });
    const out = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 'sess_1',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(out.matchedRuleId).toBe(lowPri);
    expect(out.reason).toBe('first');
  });

  it('caches rules within the TTL window and refreshes after', async () => {
    const policyId = `pol_${randomUUID()}`;
    const ruleId = `rule_${randomUUID()}`;
    harness.handle.raw
      .prepare(`INSERT INTO policies (id, project_id, name, is_active) VALUES (?, ?, ?, 1)`)
      .run(policyId, harness.projectId, 'caching');
    harness.handle.raw
      .prepare(
        `INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name,
          match_path_glob, match_agent_type, decision, reason)
        VALUES (?, ?, 10, 'PreToolUse', '*', NULL, '*', 'deny', 'original')`,
      )
      .run(ruleId, policyId);

    // Fake clock so we can step across the TTL boundary.
    let tNow = 1_000;
    const policy = createPolicyClient({
      db: harness.handle,
      now: () => tNow,
      cacheTtlMs: 1_000,
    });

    const first = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(first.reason).toBe('original');

    // Update the rule on disk. While cache is warm, result is stale.
    harness.handle.raw.prepare(`UPDATE policy_rules SET reason = 'updated' WHERE id = ?`).run(ruleId);

    tNow += 500; // still within TTL
    const cachedHit = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(cachedHit.reason).toBe('original'); // cache still hot

    tNow += 1_500; // past TTL
    const refreshed = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(refreshed.reason).toBe('updated');
  });

  it('fails open when the DB throws (breaker triggers on consecutive throws)', async () => {
    // Close the DB handle — any subsequent query throws.
    harness.handle.raw.close();
    const policy = createPolicyClient({
      db: harness.handle,
      breakerThreshold: 2,
      breakerHalfOpenMs: 60_000,
      timeoutMs: 200,
    });

    // First failure: returns fail-open via the error branch (breaker
    // still half-open after one throw).
    const first = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(first.reason).toBe('policy_check_unavailable');

    // Second failure — tips the breaker to open.
    const second = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(second.reason).toBe('policy_check_unavailable');

    // Third call: breaker is open, returns immediately without touching
    // the DB again. Same fail-open shape.
    const third = await policy.evaluate({
      toolName: 'ping',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(third.reason).toBe('policy_check_unavailable');
    expect(third.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// recordPolicyDecision — the audit-write helper S14 will call.
// ---------------------------------------------------------------------------

describe('lib/policy — recordPolicyDecision audit writes', () => {
  let harness: Harness;
  let runId: string | null;

  beforeEach(() => {
    harness = openTestDb();
    runId = null; // S14 will eventually pass a real FK; S7b tests both paths.
    return async () => {
      await harness.client.close();
    };
  });

  it('inserts a policy_decisions row with the locked idempotency key', async () => {
    const args = {
      projectId: harness.projectId,
      sessionId: 'sess_audit',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'write_file',
      toolInputSnapshot: JSON.stringify({ file_path: 'src/a.ts' }),
      permissionDecision: 'allow' as const,
      reason: 'no_rule_matched',
      matchedRuleId: null,
      runId,
    };
    const first = await recordPolicyDecision(harness.handle, args);
    expect(first.inserted).toBe(true);

    const rows = await harness.handle.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_audit'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(
      buildPolicyDecisionIdempotencyKey({
        sessionId: 'sess_audit',
        toolName: 'write_file',
        eventType: 'PreToolUse',
        // F7 (2026-07-04): recordPolicyDecision keys no-turn callers by tool
        // input, so the expected key must include the same snapshot.
        toolInputSnapshot: JSON.stringify({ file_path: 'src/a.ts' }),
      }),
    );
  });

  it('ON CONFLICT DO NOTHING dedupes a retry with the same idempotency key', async () => {
    const args = {
      projectId: harness.projectId,
      sessionId: 'sess_retry',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'write_file',
      toolInputSnapshot: '{}',
      permissionDecision: 'allow' as const,
      reason: 'no_rule_matched',
      matchedRuleId: null,
      runId,
    };
    const first = await recordPolicyDecision(harness.handle, args);
    expect(first.inserted).toBe(true);
    const second = await recordPolicyDecision(harness.handle, args);
    expect(second.inserted).toBe(false);
    const rows = await harness.handle.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_retry'));
    expect(rows).toHaveLength(1);
  });

  it('accepts null runId (PreToolUse-before-run-exists path per §4.3)', async () => {
    const args = {
      projectId: harness.projectId,
      sessionId: 'sess_no_run',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'x',
      toolInputSnapshot: '{}',
      permissionDecision: 'allow' as const,
      reason: 'no_rule_matched',
      matchedRuleId: null,
      runId: null,
    };
    const out = await recordPolicyDecision(harness.handle, args);
    expect(out.inserted).toBe(true);
    const row = harness.handle.raw
      .prepare(`SELECT run_id FROM policy_decisions WHERE session_id = ?`)
      .get('sess_no_run') as { run_id: string | null };
    expect(row.run_id).toBeNull();
  });
});
