import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutboxWorker } from '@coodra/cli/lib/outbox';
import { sqliteSchema } from '@coodra/db';
import { createMcpDispatchHandler } from '../../apps/mcp-server/src/lib/outbox-dispatch.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootHandle, bootForE2E, buildE2eEnv, openSqliteHandle } from './_helpers/boot.js';

/**
 * Full session LIFECYCLE end-to-end, driven through the native
 * `lifecycle_event` MCP tool over the real HTTP transport.
 *
 * Replaces `full-session-with-hooks-bridge.test.ts` (COOD-66). That
 * suite exercised the retired `/v1/hooks/*` HTTP bridge — a transport
 * no supported agent has used since COOD-53 — so it proved nothing
 * about production behaviour while blocking deletion of
 * `apps/hooks-bridge`.
 *
 * Complements `full-session.test.ts`, which covers the DATA plane
 * (get_run_id → record_decision → save_context_pack → query_run_history).
 * This one covers the LIFECYCLE plane:
 *   SessionStart → PreToolUse(deny) → PreToolUse(allow) → PostToolUse
 *   → UserPromptSubmit → SessionEnd
 * with real policy enforcement and every assertion made against the
 * actual DB tables.
 */

interface Harness {
  readonly boot: BootHandle;
  readonly closeDb: () => Promise<void>;
  readonly client: Client;
  readonly cwd: string;
  readonly projectId: string;
  readonly slug: string;
  readonly drain: () => Promise<void>;
}

let h: Harness;

const SESSION_ID = 'lifecycle-sess-e2e-001';

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'e2e-lifecycle-'));
  const slug = `e2e-lifecycle-${randomUUID().slice(0, 8)}`;
  mkdirSync(join(cwd, '.coodra'), { recursive: true });
  writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug: slug }));

  const { handle, close: closeDb } = openSqliteHandle();
  const env = buildE2eEnv({ COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' });
  const boot = await bootForE2E({ db: handle, env, withHttp: true });
  if (!boot.http) throw new Error('expected http transport');

  // Seed project + an explicit deny rule so PreToolUse enforcement is
  // exercised for real rather than falling through to default-allow.
  const projectId = randomUUID();
  await handle.db.insert(sqliteSchema.projects).values({
    id: projectId,
    slug,
    orgId: 'org_dev_local',
    name: 'e2e-lifecycle',
    cwd,
  });
  const policyId = randomUUID();
  await handle.db.insert(sqliteSchema.policies).values({
    id: policyId,
    projectId,
    name: 'no writes to src/auth/**',
    description: null,
    isActive: true,
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: randomUUID(),
    policyId,
    priority: 1,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: 'src/auth/**',
    matchAgentType: '*',
    decision: 'deny',
    reason: 'auth files reviewed manually',
  });

  const transport = new StreamableHTTPClientTransport(new URL(`${boot.http.url}/mcp`));
  const client = new Client({ name: 'lifecycle-e2e', version: '0.0.0-e2e' }, { capabilities: {} });
  await client.connect(transport);

  // `policy_decisions` and `run_events` land via the durable outbox,
  // and the e2e boot harness starts no worker — so drain explicitly,
  // exercising the real dispatch path rather than a test shortcut.
  const drain = async (): Promise<void> => {
    const worker = new OutboxWorker({
      db: handle,
      dispatchHandler: createMcpDispatchHandler({ db: handle }),
      tickMs: 60_000,
      leaseMs: 1_000,
    });
    for (let i = 0; i < 50; i += 1) await worker.tick();
    await worker.stop();
  };

  h = { boot, closeDb, client, cwd, projectId, slug, drain };
}, 90_000);

afterAll(async () => {
  if (h?.client) await h.client.close().catch(() => {});
  if (h?.boot) await h.boot.close();
  if (h?.closeDb) await h.closeDb();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
}, 30_000);

interface HookEnvelope {
  readonly hookSpecificOutput?: {
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}

async function lifecycle(rawPayload: Record<string, unknown>): Promise<HookEnvelope> {
  const result = (await h.client.callTool({
    name: 'lifecycle_event',
    arguments: { agentType: 'claude_code', rawPayload: { ...rawPayload, cwd: h.cwd } },
  })) as { structuredContent?: { hookOutput?: HookEnvelope } };
  return result.structuredContent?.hookOutput ?? {};
}

describe('full session lifecycle over the native lifecycle_event MCP tool', () => {
  it('1. SessionStart opens an in_progress runs row and injects the session contract', async () => {
    const out = await lifecycle({ hook_event_name: 'SessionStart', session_id: SESSION_ID });
    expect(out.hookSpecificOutput?.additionalContext).toContain('Coodra session contract');

    const runs = await (h.boot.dbHandle as { db: any }).db
      .select({ id: sqliteSchema.runs.id, status: sqliteSchema.runs.status })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, SESSION_ID)));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('in_progress');
  });

  it('2. PreToolUse Write to src/auth/** is denied by the seeded rule', async () => {
    const out = await lifecycle({
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: 'src/auth/token.ts', content: 'x' },
      tool_use_id: 'tu-deny-1',
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('auth files reviewed manually');
  });

  it('3. PreToolUse Write outside the rule defers to native permissions (COOD: no opinion)', async () => {
    const out = await lifecycle({
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: 'src/utils/y.ts', content: 'x' },
      tool_use_id: 'tu-allow-1',
    });
    // No rule matched → Coodra asserts nothing and lets Claude Code decide.
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('4. both PreToolUse decisions are audited in policy_decisions', async () => {
    await h.drain();
    const decisions = await (h.boot.dbHandle as { db: any }).db
      .select({
        toolName: sqliteSchema.policyDecisions.toolName,
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
        reason: sqliteSchema.policyDecisions.reason,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, SESSION_ID));

    const denied = decisions.find((d) => d.permissionDecision === 'deny');
    expect(denied, 'the deny must be audited').toBeDefined();
    // The deferred allow is still audited — deferring on the wire must
    // never cost the audit trail.
    const allowed = decisions.find((d) => d.permissionDecision === 'allow');
    expect(allowed, 'the deferred default-allow must also be audited').toBeDefined();
    expect(allowed?.reason).toBe('no_rule_matched');
  });

  it('5. PostToolUse and UserPromptSubmit append run_events joined to the same run', async () => {
    await lifecycle({
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: 'src/utils/y.ts' },
      tool_use_id: 'tu-allow-1',
    });
    await lifecycle({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      tool_input: { prompt: 'ship it' },
    });
    await h.drain();

    const runs = await (h.boot.dbHandle as { db: any }).db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, SESSION_ID)));
    const runId = runs[0]?.id;
    expect(runId).toBeDefined();

    const events = await (h.boot.dbHandle as { db: any }).db
      .select({ phase: sqliteSchema.runEvents.phase, toolName: sqliteSchema.runEvents.toolName })
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.runId, runId ?? ''));
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.some((e: { phase: string }) => e.phase === 'post'),
      'PostToolUse recorded',
    ).toBe(true);
    // NOTE — divergence from the retired bridge, asserted deliberately:
    // the bridge stored UserPromptSubmit as `phase='user_prompt'`, while
    // `eventRecordPhase` on the native path collapses anything not
    // pre/post to `mcp_call` and carries the discriminator in toolName
    // instead. The event IS recorded either way; only the labelling
    // differs. Captured here so the difference stays visible rather than
    // disappearing along with the bridge suite.
    expect(
      events.some((e: { phase: string; toolName: string }) => e.toolName === 'user_prompt'),
      'UserPromptSubmit recorded',
    ).toBe(true);
  });

  it('6. SessionEnd closes the run to completed and auto-saves a Context Pack', async () => {
    await lifecycle({ hook_event_name: 'SessionEnd', session_id: SESSION_ID });
    await h.drain();

    const runs = await (h.boot.dbHandle as { db: any }).db
      .select({ id: sqliteSchema.runs.id, status: sqliteSchema.runs.status, endedAt: sqliteSchema.runs.endedAt })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, SESSION_ID)));
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.endedAt).not.toBeNull();

    // finalizeRunOnSessionEnd's auto-pack — the artifact the bridge
    // suite also asserted, now proven on the native path.
    const packs = await (h.boot.dbHandle as { db: any }).db
      .select({ id: sqliteSchema.contextPacks.id })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runs[0]?.id ?? ''));
    expect(packs.length).toBeGreaterThan(0);
  });
});
