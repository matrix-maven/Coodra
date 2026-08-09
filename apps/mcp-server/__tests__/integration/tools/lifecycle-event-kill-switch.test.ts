import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertKillSwitch, migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { createKillSwitchEvaluator } from '@coodra/lifecycle';
import { createPolicyClient } from '@coodra/policy';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drainOutbox } from '../_helpers/drain-outbox.js';
import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * COOD-61 regression coverage: kill-switch evaluation (`coodra pause`)
 * used to live only in `apps/hooks-bridge/src/handlers/pre-tool-use.ts`.
 * COOD-53 routed every native plugin's PreToolUse through
 * `lifecycle_event` instead, and nothing there consulted the evaluator —
 * so `coodra pause` was silently non-functional for all five supported
 * agents while still reporting success to the operator.
 *
 * Locks the Module 08b S2 contract on the native path:
 *   - hard-mode match  → deny, policy chain skipped
 *   - soft-mode match  → allow (audit-only, no enforcement)
 *   - no match         → falls through to the policy chain unchanged
 *
 * The evaluator is injected with `cacheMs: 0` so a switch inserted
 * mid-test is visible immediately instead of waiting out the 5s TTL.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-kill-switch-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-kill-switch-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(
    createLifecycleEventToolRegistration({
      db: h.handle,
      mode: 'solo',
      // cacheMs: 0 — no TTL, so a switch inserted after the handler was
      // built is seen on the very next call.
      killSwitchEvaluator: createKillSwitchEvaluator({ db: h.handle, cacheMs: 0 }),
    }),
  );
  return registry;
}

interface HookSpecificOutput {
  readonly permissionDecision?: string;
  readonly permissionDecisionReason?: string;
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<void> {
  await registry.handleCall(
    'lifecycle_event',
    { agentType: 'claude_code', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'claude_code' },
  );
}

async function preToolUse(
  registry: ToolRegistry,
  h: Harness,
  sessionId: string,
  toolName: string,
): Promise<HookSpecificOutput> {
  const result = await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'claude_code',
      rawPayload: {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: h.cwd,
        tool_name: toolName,
        tool_input: { file_path: 'src/app.ts', content: 'x' },
        tool_use_id: `tu-${toolName}-${sessionId}`,
      },
    },
    'mcp-session',
    { agentType: 'claude_code' },
  );
  const structured = result.structuredContent as
    | { hookOutput?: { hookSpecificOutput?: HookSpecificOutput } }
    | undefined;
  return structured?.hookOutput?.hookSpecificOutput ?? {};
}

describe('lifecycle_event — kill switches enforced on the native path (COOD-61)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('proj-kill-switch');
  });
  afterEach(async () => {
    await h.close();
  });

  it('allows a tool call when no kill switch is active', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_no_switch');

    const out = await preToolUse(registry, h, 'sess_no_switch', 'Write');
    // No switch and no matching rule → Coodra has no opinion, so it
    // omits the permission field entirely and lets Claude Code decide.
    expect(out.permissionDecision).toBeUndefined();
  });

  it('denies a tool call when a hard-mode global kill switch is active', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_hard');

    const inserted = await insertKillSwitch(h.handle, {
      scope: 'global',
      target: null,
      mode: 'hard',
      reason: 'operator paused all agents',
    });

    const out = await preToolUse(registry, h, 'sess_hard', 'Write');
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toBe(`kill_switch_paused:${inserted.id}`);
  });

  it('allows but still audits when a soft-mode kill switch matches', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_soft');

    const inserted = await insertKillSwitch(h.handle, {
      scope: 'global',
      target: null,
      mode: 'soft',
      reason: 'observability-only pause',
    });

    const out = await preToolUse(registry, h, 'sess_soft', 'Write');
    expect(out.permissionDecision).toBe('allow');
    // Soft mode is audit-only: it does NOT enforce, but the reason still
    // carries the matched switch so the decision row is attributable.
    expect(out.permissionDecisionReason).toBe(`kill_switch_paused:${inserted.id}`);

    // The audit row lands via the outbox, not synchronously — drain it
    // before asserting (same pattern as check-policy.test.ts).
    await drainOutbox(h.handle);
    const decisions = await h.handle.db
      .select({
        reason: sqliteSchema.policyDecisions.reason,
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_soft'));
    const row = decisions.find((d) => d.reason === `kill_switch_paused:${inserted.id}`);
    expect(row, 'soft-mode kill switch must still write an audit row').toBeDefined();
    expect(row?.permissionDecision).toBe('allow');
  });

  it('scopes a tool-scoped kill switch to the matching tool only', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_tool_scope');

    await insertKillSwitch(h.handle, {
      scope: 'tool',
      target: 'Write',
      mode: 'hard',
      reason: 'writes paused',
    });

    const denied = await preToolUse(registry, h, 'sess_tool_scope', 'Write');
    expect(denied.permissionDecision).toBe('deny');

    // Read is outside the switch's scope and matches no rule → deferred.
    const allowed = await preToolUse(registry, h, 'sess_tool_scope', 'Read');
    expect(allowed.permissionDecision).toBeUndefined();
  });
});

describe('lifecycle_event — defers to native permissions when Coodra has no opinion', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('proj-defer-native');
  });
  afterEach(async () => {
    await h.close();
  });

  it('omits permissionDecision on a default allow, but still writes the audit row', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_defer');

    // `Edit` matches no seeded rule for this path → `no_rule_matched`.
    const out = await preToolUse(registry, h, 'sess_defer', 'Edit');
    expect(out.permissionDecision, 'Coodra must not assert a permission it did not decide').toBeUndefined();
    expect(out.permissionDecisionReason).toBeUndefined();

    // Deferring on the wire must NOT cost us the audit trail — that is
    // the whole point of "don't interfere, but still log".
    await drainOutbox(h.handle);
    const decisions = await h.handle.db
      .select({
        reason: sqliteSchema.policyDecisions.reason,
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
        toolName: sqliteSchema.policyDecisions.toolName,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_defer'));
    const row = decisions.find((d) => d.toolName === 'Edit');
    expect(row, 'a deferred default-allow must still be audited').toBeDefined();
    expect(row?.reason).toBe('no_rule_matched');
    expect(row?.permissionDecision).toBe('allow');
  });

  it('still asserts deny when a rule actually matched', async () => {
    // `makeFakeDeps()` stubs the policy client to always-allow, so this
    // one test wires the REAL DB-backed evaluator — otherwise no seeded
    // rule could ever fire and the assertion would be vacuous.
    const registry = new ToolRegistry({
      deps: Object.freeze({ ...h.deps, policy: createPolicyClient({ db: h.handle }) }),
    });
    registry.register(
      createLifecycleEventToolRegistration({
        db: h.handle,
        mode: 'solo',
        killSwitchEvaluator: createKillSwitchEvaluator({ db: h.handle, cacheMs: 0 }),
      }),
    );
    await sessionStart(registry, h, 'sess_opinion');

    // `.env` writes are a seeded preventive deny — a real opinion, so
    // Coodra must assert it rather than defer.
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_opinion',
          cwd: h.cwd,
          tool_name: 'Write',
          tool_input: { file_path: '.env', content: 'SECRET=1' },
          tool_use_id: 'tu-env-deny',
        },
      },
      'mcp-session',
      { agentType: 'claude_code' },
    );
    const structured = result.structuredContent as
      | { hookOutput?: { hookSpecificOutput?: HookSpecificOutput } }
      | undefined;
    const out = structured?.hookOutput?.hookSpecificOutput ?? {};
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toBeTruthy();
  });
});
