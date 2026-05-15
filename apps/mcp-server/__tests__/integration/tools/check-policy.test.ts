import { randomUUID } from 'node:crypto';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps, PolicyClient } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createPolicyClient, createPolicyClientFromCheck } from '../../../src/lib/policy.js';
import { createCheckPolicyToolRegistration } from '../../../src/tools/check-policy/manifest.js';
import type { CheckPolicyOutput } from '../../../src/tools/check-policy/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * Integration test for `coodra__check_policy` (S14).
 *
 * Uses a real `createPolicyClient` against in-memory SQLite migrated
 * to 0003. Policies + policy_rules seeded per test. Validates:
 *
 *   1. `project_not_found` soft-failure, no audit write.
 *   2. `no_rule_matched` → allow + audit row, reason="no_rule_matched".
 *   3. `Write + **\/*.env + deny` → deny response, audit row captures
 *       `matched_rule_id` and the rule's human reason text.
 *   4. Async audit ordering — handler returns BEFORE the audit row
 *       is visible (microtask sandwich proves setImmediate scheduling).
 *   5. Idempotent audit under retries — two calls with same
 *       `(sessionId, toolName, eventType)` produce exactly ONE row.
 *   6. Fail-open via breaker — closed DB handle trips breaker; handler
 *       returns allow + `reason='policy_engine_unavailable'` +
 *       `failOpen=true`.
 *   7. Fail-open via custom PolicyCheck that throws — handler still
 *       responds allow + fail-open enum (via createPolicyClientFromCheck,
 *       the PolicyClient's fail-open path is the evaluator's; we use
 *       the evaluator-direct-throw form here).
 *   8. Per-projectId cache isolation — project A's rules don't mask
 *       project B's. Uses a single `createPolicyClient` instance across
 *       both project slugs; per-project cache slots keep rule sets
 *       distinct.
 *   9. `runId` threads through to the audit row.
 *  10. 8 KiB truncation — oversized `toolInput` JSON truncated in the
 *       audit row, `…[truncated:N]` suffix preserves original size.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly projectA: string;
  readonly projectB: string;
  readonly slugA: string;
  readonly slugB: string;
  readonly deps: ContextDeps;
}

async function openHarness(policyOverride?: PolicyClient): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const projectA = `proj_a_${randomUUID()}`;
  const projectB = `proj_b_${randomUUID()}`;
  const slugA = `slug-a-${projectA.slice(-8)}`;
  const slugB = `slug-b-${projectB.slice(-8)}`;
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectA, slugA, 'org_test', 'project A');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectB, slugB, 'org_test', 'project B');

  const policy = policyOverride ?? createPolicyClient({ db: handle });
  const baseDeps = makeFakeDeps({ policy });
  const deps: ContextDeps = baseDeps;

  return {
    close: async () => {
      await client.close();
    },
    handle,
    projectA,
    projectB,
    slugA,
    slugB,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createCheckPolicyToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): CheckPolicyOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: CheckPolicyOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

function seedDenyRule(
  h: Harness,
  projectId: string,
  opts: { readonly matchToolName: string; readonly matchPathGlob: string | null; readonly reason: string },
): string {
  const policyId = `pol_${randomUUID()}`;
  const ruleId = `rule_${randomUUID()}`;
  h.handle.raw
    .prepare('INSERT INTO policies (id, project_id, name, is_active) VALUES (?, ?, ?, 1)')
    .run(policyId, projectId, 'test-policy');
  h.handle.raw
    .prepare(
      `INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name,
         match_path_glob, match_agent_type, decision, reason)
       VALUES (?, ?, 10, 'PreToolUse', ?, ?, '*', 'deny', ?)`,
    )
    .run(ruleId, policyId, opts.matchToolName, opts.matchPathGlob, opts.reason);
  return ruleId;
}

async function flushSetImmediate(handle: SqliteHandle): Promise<void> {
  // Module 03.1: check_policy enqueues into pending_jobs; the
  // policy_decisions row lands only after the OutboxWorker drains.
  await drainOutbox(handle);
}

// ---------------------------------------------------------------------------
// 1. project_not_found soft-failure
// ---------------------------------------------------------------------------

describe('check_policy — project_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found and does NOT write an audit row', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: 'nonexistent',
          sessionId: 'sess_nx',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/x' },
        },
        'sess_nx',
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
    expect(out.howToFix).toMatch(/coodra init|projects table/);

    await flushSetImmediate(h.handle);
    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. no_rule_matched → allow + audit row
// ---------------------------------------------------------------------------

describe('check_policy — no_rule_matched path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns allow with reason=no_rule_matched, failOpen=false; audit row written', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: h.slugA,
          sessionId: 'sess_nrm',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/safe.ts' },
        },
        'sess_nrm',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.permissionDecision).toBe('allow');
    expect(out.reason).toBe('no_rule_matched');
    expect(out.ruleReason).toBeNull();
    expect(out.matchedRuleId).toBeNull();
    expect(out.failOpen).toBe(false);

    await flushSetImmediate(h.handle);
    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permissionDecision).toBe('allow');
    expect(rows[0]?.reason).toBe('no_rule_matched');
    expect(rows[0]?.matchedRuleId).toBeNull();
    expect(rows[0]?.projectId).toBe(h.projectA);
    expect(rows[0]?.sessionId).toBe('sess_nrm');
    expect(rows[0]?.agentType).toBe('claude_code');
    expect(rows[0]?.eventType).toBe('PreToolUse');
    expect(rows[0]?.toolName).toBe('Write');
    // F14 (2026-04-27): no toolUseId supplied → 'no-turn' fallback
    expect(rows[0]?.idempotencyKey).toBe('pd:sess_nrm:no-turn:Write:PreToolUse');
  });
});

// ---------------------------------------------------------------------------
// 3. Deny path: Write + **/*.env + deny
// ---------------------------------------------------------------------------

describe('check_policy — deny via path glob', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('Write against **/secrets.json returns deny with rule_matched + matchedRuleId; audit row captures human reason', async () => {
    // Non-dotfile path chosen deliberately: the evaluator's picomatch
    // is configured `dot: false` (per lib/policy.ts::compileRule) which
    // means leaves starting with `.` won't match through a `*` wildcard.
    // `**/*.env` as a glob → a real policy use case, but requires the
    // policy library to opt into `dot: true` or explicitly include `.`
    // in its glob semantics — out of scope for S14. A non-dotfile
    // target is equivalent-in-spirit for proving the path-glob wire.
    const ruleId = seedDenyRule(h, h.projectA, {
      matchToolName: 'Write',
      matchPathGlob: '**/secrets.json',
      reason: 'writing secrets.json is forbidden — use a vault',
    });

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: h.slugA,
          sessionId: 'sess_deny',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/repo/apps/web/config/secrets.json' },
        },
        'sess_deny',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.permissionDecision).toBe('deny');
    expect(out.reason).toBe('rule_matched');
    expect(out.ruleReason).toBe('writing secrets.json is forbidden — use a vault');
    expect(out.matchedRuleId).toBe(ruleId);
    expect(out.failOpen).toBe(false);

    await flushSetImmediate(h.handle);
    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permissionDecision).toBe('deny');
    expect(rows[0]?.matchedRuleId).toBe(ruleId);
    expect(rows[0]?.reason).toBe('writing secrets.json is forbidden — use a vault');
  });

  it('Write against a non-matching path yields allow / no_rule_matched', async () => {
    seedDenyRule(h, h.projectA, {
      matchToolName: 'Write',
      matchPathGlob: '**/secrets.json',
      reason: 'nope',
    });
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: h.slugA,
          sessionId: 'sess_pass',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/repo/apps/web/src/page.tsx' },
        },
        'sess_pass',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.permissionDecision).toBe('allow');
    expect(out.reason).toBe('no_rule_matched');
  });
});

// ---------------------------------------------------------------------------
// 4. Async audit ordering — handler returns BEFORE audit row is visible
// ---------------------------------------------------------------------------

describe('check_policy — audit write is fire-and-forget via setImmediate', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('handler response returns before the audit row is visible; row appears after setImmediate flush', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: h.slugA,
          sessionId: 'sess_async',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/a' },
        },
        'sess_async',
      ),
    );
    expect(out.ok).toBe(true);

    // Immediately after handler resolves (microtask), setImmediate
    // task has NOT yet run. DB should still be empty.
    const beforeFlush = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(beforeFlush).toHaveLength(0);

    await flushSetImmediate(h.handle);

    const afterFlush = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(afterFlush).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotent audit dedupe under retries
// ---------------------------------------------------------------------------

describe('check_policy — idempotent audit dedupe', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('two calls with same (sessionId, toolName, eventType) produce exactly ONE policy_decisions row', async () => {
    const registry = buildRegistry(h);
    const call = async () =>
      unwrap(
        await registry.handleCall(
          'check_policy',
          {
            projectSlug: h.slugA,
            sessionId: 'sess_dup',
            agentType: 'claude_code',
            eventType: 'PreToolUse',
            toolName: 'Write',
            toolInput: { file_path: '/tmp/a' },
          },
          'sess_dup',
        ),
      );
    const a = await call();
    const b = await call();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    await flushSetImmediate(h.handle);
    // Second setImmediate might have scheduled while first DO-NOTHING
    // insert was pending — run flush twice to be safe.
    await flushSetImmediate(h.handle);

    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(1);
    // F14 (2026-04-27): no toolUseId supplied → 'no-turn' fallback
    expect(rows[0]?.idempotencyKey).toBe('pd:sess_dup:no-turn:Write:PreToolUse');
  });

  it('same (toolName, eventType) across different sessionIds produces two rows', async () => {
    const registry = buildRegistry(h);
    const call = async (sessionId: string) =>
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: h.slugA,
          sessionId,
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/a' },
        },
        sessionId,
      );
    await call('sess_one');
    await call('sess_two');
    await flushSetImmediate(h.handle);
    await flushSetImmediate(h.handle);

    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.idempotencyKey).sort();
    expect(keys).toEqual(['pd:sess_one:no-turn:Write:PreToolUse', 'pd:sess_two:no-turn:Write:PreToolUse']);
  });
});

// ---------------------------------------------------------------------------
// 6. Fail-open via breaker (closed DB → consecutive throws trip breaker)
// ---------------------------------------------------------------------------

describe('check_policy — fail-open surfaces via reason=policy_engine_unavailable', () => {
  it('closed DB → evaluator fails open → handler returns allow + failOpen:true', async () => {
    const h = await openHarness();
    // Use a fresh real PolicyClient with a low breaker threshold against
    // a closed DB handle so the first fail-open branch fires predictably.
    h.handle.raw.close();
    // Rewire deps.policy with a breaker-threshold:2 client that sees the
    // closed DB. The harness's default policy was bound to the live
    // handle; we substitute before running.
    const failingPolicy = createPolicyClient({
      db: h.handle,
      breakerThreshold: 2,
      breakerHalfOpenMs: 60_000,
      timeoutMs: 200,
    });
    const deps: ContextDeps = makeFakeDeps({ policy: failingPolicy });
    const registry = new ToolRegistry({ deps });
    // We can't use buildRegistry because it also uses h.handle for the
    // handler's resolveProjectId call — but that handle is closed now.
    // For this fail-open test, use a separate live handle for the
    // projects lookup.
    const secondary = await openHarness();
    registry.register(createCheckPolicyToolRegistration({ db: secondary.handle }));

    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: secondary.slugA,
          sessionId: 'sess_failopen',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/a' },
        },
        'sess_failopen',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.permissionDecision).toBe('allow');
    expect(out.reason).toBe('policy_engine_unavailable');
    expect(out.failOpen).toBe(true);
    expect(out.ruleReason).toBeNull();
    expect(out.matchedRuleId).toBeNull();

    await secondary.close();
  });
});

// ---------------------------------------------------------------------------
// 7. Fail-open via evaluator that directly emits the fail-open reason
// ---------------------------------------------------------------------------

describe('check_policy — fail-open mapping (evaluator emits policy_check_unavailable)', () => {
  it('maps evaluator sentinel policy_check_unavailable → response reason=policy_engine_unavailable + failOpen=true', async () => {
    // Simulate the evaluator's internal fail-open branch by returning
    // the S7b sentinel reason. The handler must map it to the locked
    // response enum.
    const failOpenStub: PolicyClient = {
      async evaluate() {
        return { decision: 'allow', reason: 'policy_check_unavailable', matchedRuleId: null };
      },
    };
    const h = await openHarness(failOpenStub);
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'check_policy',
        {
          projectSlug: h.slugA,
          sessionId: 'sess_map',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput: {},
        },
        'sess_map',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reason).toBe('policy_engine_unavailable');
    expect(out.failOpen).toBe(true);

    // Audit row also carries the enum code (not the evaluator sentinel)
    // so policy_decisions stays consistent with the response.
    await flushSetImmediate(h.handle);
    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('policy_engine_unavailable');
    await h.close();
  });
});

// ---------------------------------------------------------------------------
// 8. Per-projectId cache isolation
// ---------------------------------------------------------------------------

describe('check_policy — per-projectId cache isolation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('project A has a deny rule, project B has none — same PolicyClient instance serves both correctly', async () => {
    seedDenyRule(h, h.projectA, {
      matchToolName: 'Write',
      matchPathGlob: null,
      reason: 'project A blocks all writes',
    });
    // No rules for project B.

    const registry = buildRegistry(h);
    const payloadFor = (slug: string, sessionId: string) => ({
      projectSlug: slug,
      sessionId,
      agentType: 'claude_code',
      eventType: 'PreToolUse' as const,
      toolName: 'Write',
      toolInput: { file_path: '/tmp/x' },
    });

    const outA = unwrap(await registry.handleCall('check_policy', payloadFor(h.slugA, 'sess_a'), 'sess_a'));
    const outB = unwrap(await registry.handleCall('check_policy', payloadFor(h.slugB, 'sess_b'), 'sess_b'));

    expect(outA.ok).toBe(true);
    expect(outB.ok).toBe(true);
    if (!outA.ok || !outB.ok) return;
    expect(outA.permissionDecision).toBe('deny');
    expect(outA.reason).toBe('rule_matched');
    expect(outB.permissionDecision).toBe('allow');
    expect(outB.reason).toBe('no_rule_matched');

    // Swap order: calling B first then A — cache isolation guarantees
    // A still denies.
    const outB2 = unwrap(await registry.handleCall('check_policy', payloadFor(h.slugB, 'sess_b2'), 'sess_b2'));
    const outA2 = unwrap(await registry.handleCall('check_policy', payloadFor(h.slugA, 'sess_a2'), 'sess_a2'));
    if (!outA2.ok || !outB2.ok) return;
    expect(outB2.permissionDecision).toBe('allow');
    expect(outA2.permissionDecision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// 9. runId threads into the audit row
// ---------------------------------------------------------------------------

describe('check_policy — runId threads to policy_decisions.run_id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('supplied runId lands in the audit row; omitted runId writes NULL', async () => {
    // Seed a runs row so the FK satisfies.
    const runId = `run_${randomUUID()}`;
    h.handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, h.projectA, 'sess_with_run', 'claude_code', 'solo', 'in_progress');

    const registry = buildRegistry(h);
    await registry.handleCall(
      'check_policy',
      {
        projectSlug: h.slugA,
        sessionId: 'sess_with_run',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
        runId,
      },
      'sess_with_run',
    );
    await registry.handleCall(
      'check_policy',
      {
        projectSlug: h.slugA,
        sessionId: 'sess_no_run',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
      },
      'sess_no_run',
    );
    await flushSetImmediate(h.handle);
    await flushSetImmediate(h.handle);

    const withRun = await h.handle.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_with_run'));
    const withoutRun = await h.handle.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_no_run'));
    expect(withRun[0]?.runId).toBe(runId);
    expect(withoutRun[0]?.runId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. 8 KiB toolInputSnapshot truncation
// ---------------------------------------------------------------------------

describe('check_policy — toolInputSnapshot truncates at 8 KiB', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('oversized toolInput JSON is truncated in the audit row; suffix preserves original size', async () => {
    const bigBody = 'x'.repeat(20_000);
    const registry = buildRegistry(h);
    await registry.handleCall(
      'check_policy',
      {
        projectSlug: h.slugA,
        sessionId: 'sess_big',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x', body: bigBody },
      },
      'sess_big',
    );
    await flushSetImmediate(h.handle);

    const rows = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(rows).toHaveLength(1);
    const snapshot = rows[0]?.toolInputSnapshot ?? '';
    // Snapshot is 8192 + suffix; suffix starts with '…[truncated:'
    expect(snapshot.length).toBeGreaterThan(8192);
    expect(snapshot.length).toBeLessThan(8192 + 64);
    expect(snapshot).toMatch(/…\[truncated:\d+\]$/);
    // First 8192 chars are a valid prefix of the JSON.
    expect(snapshot.startsWith('{"file_path":"/tmp/x","body":"xxx')).toBe(true);
  });

  it('small toolInput is stored verbatim (no truncation)', async () => {
    const registry = buildRegistry(h);
    await registry.handleCall(
      'check_policy',
      {
        projectSlug: h.slugA,
        sessionId: 'sess_small',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x', body: 'short' },
      },
      'sess_small',
    );
    await flushSetImmediate(h.handle);
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_small'));
    expect(rows[0]?.toolInputSnapshot).toBe('{"file_path":"/tmp/x","body":"short"}');
  });
});

// ---------------------------------------------------------------------------
// 11. PolicyCheck-stub round-trip (proves createPolicyClientFromCheck
//     threads projectId per S14 additive-optional)
// ---------------------------------------------------------------------------

describe('check_policy — projectId threads through createPolicyClientFromCheck', () => {
  it('test PolicyCheck stub receives projectId matching the resolved projects.id', async () => {
    // The registry auto-wraps every tool call in pre + post policy
    // evaluations via `ctx.policy.evaluate` — those run with no
    // projectId (auto-wrap path, per the S7b → S14 contract). The
    // HANDLER's own call to `ctx.policy.evaluate` passes projectId.
    // Capture all calls and assert the handler-originated one
    // supplied the resolved projects.id.
    const seen: Array<string | undefined> = [];
    const trackingPolicy = createPolicyClientFromCheck(async (req) => {
      seen.push(req.projectId);
      return { decision: 'allow', reason: 'stub', matchedRuleId: null };
    });
    const h = await openHarness(trackingPolicy);
    const registry = buildRegistry(h);
    const raw = await registry.handleCall(
      'check_policy',
      {
        projectSlug: h.slugA,
        sessionId: 'sess_id_thread',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
      },
      'sess_id_thread',
    );
    const out = unwrap(raw);
    expect(out.ok).toBe(true);
    // Exactly one of the observed calls carries the resolved projectId
    // (the handler's own evaluate call); the auto-wrap pre/post calls
    // carry undefined per the additive-optional contract.
    expect(seen).toContain(h.projectA);
    expect(seen.filter((p) => p === undefined).length).toBeGreaterThanOrEqual(1);
    await h.close();
  });
});
