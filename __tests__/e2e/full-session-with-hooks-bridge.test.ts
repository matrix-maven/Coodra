import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxWorker } from '@coodra/cli/lib/outbox';
import { sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/hooks-bridge/src/app.js';
import { createPostToolUseHandler } from '../../apps/hooks-bridge/src/handlers/post-tool-use.js';
import { createPreToolUseHandler } from '../../apps/hooks-bridge/src/handlers/pre-tool-use.js';
import { createSessionEndHandler } from '../../apps/hooks-bridge/src/handlers/session-end.js';
import { createSessionStartHandler } from '../../apps/hooks-bridge/src/handlers/session-start.js';
import { createUserPromptSubmitHandler } from '../../apps/hooks-bridge/src/handlers/user-prompt-submit.js';
import { composeDispatch } from '../../apps/hooks-bridge/src/lib/dispatch.js';
import { createBridgeDispatchHandler } from '../../apps/hooks-bridge/src/lib/outbox-dispatch.js';
import { createProjectSlugResolver } from '../../apps/hooks-bridge/src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../apps/hooks-bridge/src/lib/run-recorder.js';

import { type BootHandle, bootForE2E, buildE2eEnv, openSqliteHandle } from './_helpers/boot.js';

/**
 * Module 03 S14: full session lifecycle through Modules 01 + 02 + 03.
 *
 * Walks the entire Coodra observation loop in one test — proves
 * the read surface (mcp-server) and the write surface (hooks-bridge)
 * cooperate against a shared SQLite without interference, and that
 * the materialised artefacts on disk + in DB form a coherent record.
 *
 *   1. seed `projects` + a deny-rule policy in the shared DB.
 *   2. write a `.coodra.json` pointing at the project slug in a
 *      synthesised cwd directory (so the resolver can find it).
 *   3. POST SessionStart → runs row 'in_progress'.
 *   4. POST PreToolUse for src/auth/x.ts → deny (rule matched);
 *      policy_decisions row written.
 *   5. POST PreToolUse for src/utils/y.ts → allow.
 *   6. POST PostToolUse → run_events 'post' row.
 *   7. POST UserPromptSubmit → run_events 'user_prompt' row.
 *   8. POST Stop → runs row 'completed' with ended_at set.
 *   9. via the MCP Client, call get_run_id → second runs row exists
 *      keyed on the SDK transport's session id (separate from the
 *      hook-session row — they're orthogonal).
 *  10. via the MCP Client, call save_context_pack → context_packs
 *      row + a markdown file on disk.
 */

interface Harness {
  readonly bootMcp: BootHandle;
  readonly bridgeHono: ReturnType<typeof buildApp>['hono'];
  readonly drain: () => Promise<void>;
  readonly closeDb: () => Promise<void>;
  readonly client: Client;
  readonly cwd: string;
  readonly projectId: string;
  readonly slug: string;
}

let h: Harness;

beforeAll(async () => {
  // Shared sqlite + project tmp dir.
  const cwd = mkdtempSync(join(tmpdir(), 'e2e-hooks-bridge-'));
  const slug = `e2e-proj-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: slug }));

  const { handle, close: closeDb } = openSqliteHandle();
  const env = buildE2eEnv({ COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' });
  const bootMcp = await bootForE2E({ db: handle, env, withHttp: true });
  if (!bootMcp.http) throw new Error('expected http transport');

  // Seed project + policy + deny rule.
  const projectId = randomUUID();
  await handle.db.insert(sqliteSchema.projects).values({
    id: projectId,
    slug,
    orgId: 'org_dev_local',
    name: 'e2e-with-hooks-bridge',
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

  // Build hooks-bridge in-process against the shared sqlite handle.
  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  // Module 03.1: drain via the OutboxWorker. Mirrors the production
  // path — bridge enqueues durably; the worker drains pending_jobs
  // to its destination tables.
  const drainWorker = new OutboxWorker({
    db: handle,
    dispatchHandler: createBridgeDispatchHandler({ db: handle }),
    tickMs: 60_000,
    leaseMs: 1_000,
  });
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 50; i += 1) {
      await drainWorker.tick();
    }
  };
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: handle });
  const sessionStart = createSessionStartHandler({ runRecorder, projectSlugResolver, db: handle, mode: 'solo' });
  const sessionEnd = createSessionEndHandler({ runRecorder, projectSlugResolver, db: handle });
  const userPromptSubmit = createUserPromptSubmitHandler({ runRecorder, projectSlugResolver, db: handle });
  const dispatch = composeDispatch({ preToolUse, postToolUse, sessionStart, sessionEnd, userPromptSubmit });
  const { hono } = buildApp({
    env: { COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' },
    dispatch,
  });

  // MCP SDK client against the running mcp-server HTTP transport.
  const transport = new StreamableHTTPClientTransport(new URL(`${bootMcp.http.url}/mcp`));
  const client = new Client({ name: 'e2e-hooks-bridge', version: '0.0.0-e2e' }, { capabilities: {} });
  await client.connect(transport);

  h = { bootMcp, bridgeHono: hono, drain, closeDb, client, cwd, projectId, slug };
}, 90_000);

afterAll(async () => {
  if (h?.client) await h.client.close().catch(() => {});
  if (h?.bootMcp) await h.bootMcp.close();
  if (h?.closeDb) await h.closeDb();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

const HOOK_SESSION_ID = 'hook-sess-e2e-001';

async function postHook(body: Record<string, unknown>): Promise<Response> {
  return h.bridgeHono.request('/v1/hooks/claude-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, cwd: h.cwd }),
  });
}

describe('full session lifecycle: hooks-bridge + mcp-server cooperation', () => {
  it('1. SessionStart opens a runs row', async () => {
    const res = await postHook({ hook_event_name: 'SessionStart', session_id: HOOK_SESSION_ID });
    expect(res.status).toBe(200);
    await h.drain();
    if (h.bootMcp.dbHandle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.bootMcp.dbHandle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, HOOK_SESSION_ID)));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('in_progress');
  });

  it('2. PreToolUse Write to src/auth/x.ts → deny + policy_decisions row', async () => {
    const res = await postHook({
      hook_event_name: 'PreToolUse',
      session_id: HOOK_SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: 'src/auth/x.ts' },
      tool_use_id: 'tool-1',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe('auth files reviewed manually');
    await h.drain();

    if (h.bootMcp.dbHandle.kind !== 'sqlite') throw new Error('expected sqlite');
    const decisions = await h.bootMcp.dbHandle.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, HOOK_SESSION_ID));
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const denyRows = decisions.filter((d) => d.permissionDecision === 'deny');
    expect(denyRows.length).toBe(1);
  });

  it('3. PreToolUse Write to src/utils/y.ts → allow', async () => {
    const res = await postHook({
      hook_event_name: 'PreToolUse',
      session_id: HOOK_SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: 'src/utils/y.ts' },
      tool_use_id: 'tool-2',
    });
    const body = (await res.json()) as { hookSpecificOutput: { permissionDecision: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('4. PostToolUse appends a run_events row that joins back to the bridge runs row (F8)', async () => {
    const res = await postHook({
      hook_event_name: 'PostToolUse',
      session_id: HOOK_SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: 'src/utils/y.ts' },
      tool_use_id: 'tool-2',
    });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.bootMcp.dbHandle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.bootMcp.dbHandle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, 'tool-2'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.phase).toBe('post');

    // F8 closure (verification 2026-04-27): the bridge's recorder
    // resolves runs.id via lookupRunId(projectId, sessionId) and writes
    // it into run_events.run_id at INSERT time. Verify the linkage with
    // a join — the assertion that would have caught F8 directly.
    const bridgeRun = await h.bootMcp.dbHandle.db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, HOOK_SESSION_ID)));
    expect(bridgeRun.length).toBe(1);
    expect(rows[0]?.runId).toBe(bridgeRun[0]?.id);
  });

  it('5. UserPromptSubmit appends a phase=user_prompt run_events row', async () => {
    const res = await postHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: HOOK_SESSION_ID,
      prompt: 'rename foo to bar',
      prompt_id: 'p1',
    });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.bootMcp.dbHandle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.bootMcp.dbHandle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.phase, 'user_prompt'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('6. Stop closes the runs row to completed', async () => {
    const res = await postHook({ hook_event_name: 'Stop', session_id: HOOK_SESSION_ID });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.bootMcp.dbHandle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.bootMcp.dbHandle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, HOOK_SESSION_ID)));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.endedAt).toBeTruthy();
  });

  it('7. MCP get_run_id mints a separate run keyed on the SDK transport sessionId (legacy contract — callers omitting agentSessionId)', async () => {
    const result = await h.client.callTool({ name: 'get_run_id', arguments: { projectSlug: h.slug } });
    const text = (result.content as ReadonlyArray<{ text: string }>)[0]?.text ?? '{}';
    const env = JSON.parse(text) as { ok: boolean; data?: { ok: boolean; runId: string } };
    expect(env.ok).toBe(true);
    expect(env.data?.ok).toBe(true);
    expect(env.data?.runId).toMatch(/^run:/);
  });

  it('7b. MCP get_run_id with agentSessionId=HOOK_SESSION_ID resolves to the bridge runs row (F9 closure)', async () => {
    if (h.bootMcp.dbHandle.kind !== 'sqlite') throw new Error('expected sqlite');

    // Snapshot the runs.id the bridge created for HOOK_SESSION_ID.
    const bridgeRunsBefore = await h.bootMcp.dbHandle.db
      .select({ id: sqliteSchema.runs.id, agentType: sqliteSchema.runs.agentType })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, HOOK_SESSION_ID)));
    expect(bridgeRunsBefore.length).toBe(1);
    const bridgeRunsId = bridgeRunsBefore[0]?.id;
    expect(bridgeRunsId).toBeDefined();

    // Call get_run_id passing the SAME session_id the bridge used.
    const result = await h.client.callTool({
      name: 'get_run_id',
      arguments: { projectSlug: h.slug, agentSessionId: HOOK_SESSION_ID, agentType: 'claude_code' },
    });
    const text = (result.content as ReadonlyArray<{ text: string }>)[0]?.text ?? '{}';
    const env = JSON.parse(text) as { ok: boolean; data?: { ok: boolean; runId: string } };
    expect(env.ok).toBe(true);
    expect(env.data?.ok).toBe(true);
    expect(env.data?.runId).toBeDefined();

    // F9 closure: the returned runId IS the bridge's runs row id.
    // Note: the bridge currently mints runs.id as a plain randomUUID
    // (recordSessionStart in run-recorder.ts), not the
    // run:{projectId}:{sessionId}:{uuid} key format MCP uses for
    // newly-minted rows. The F9 contract is that both surfaces
    // resolve to the SAME row, regardless of which id-format minted
    // it. (Unifying the format would be a follow-up; the runs.id
    // shape is internal — agents pass it through opaquely.)
    expect(env.data?.runId).toBe(bridgeRunsId);

    // No new runs row was created — still exactly one row keyed by
    // (projectId, HOOK_SESSION_ID).
    const bridgeRunsAfter = await h.bootMcp.dbHandle.db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, HOOK_SESSION_ID)));
    expect(bridgeRunsAfter.length).toBe(1);
    expect(bridgeRunsAfter[0]?.id).toBe(bridgeRunsId);
  });

  it('8. MCP save_context_pack writes a row + a file on disk', async () => {
    // First fetch the runId from a fresh get_run_id call.
    const idResult = await h.client.callTool({ name: 'get_run_id', arguments: { projectSlug: h.slug } });
    const idText = (idResult.content as ReadonlyArray<{ text: string }>)[0]?.text ?? '{}';
    const idEnv = JSON.parse(idText) as { ok: boolean; data?: { ok: boolean; runId: string } };
    if (!idEnv.ok || !idEnv.data?.ok || !idEnv.data.runId) {
      throw new Error(`get_run_id failed: ${idText}`);
    }
    const runId = idEnv.data.runId;

    const saveResult = await h.client.callTool({
      name: 'save_context_pack',
      arguments: {
        runId,
        title: 'E2E lifecycle',
        content:
          'Recorded during the Module 03 S14 e2e test.\n\n- SessionStart → PreToolUse (deny + allow) → PostToolUse → UserPromptSubmit → Stop\n- All audit rows landed in DB.',
      },
    });
    const saveText = (saveResult.content as ReadonlyArray<{ text: string }>)[0]?.text ?? '{}';
    const saveEnv = JSON.parse(saveText) as {
      ok: boolean;
      data?: { ok: boolean; contextPackId?: string; savedAt?: string; contentExcerpt?: string };
    };
    expect(saveEnv.ok).toBe(true);
    expect(saveEnv.data?.ok).toBe(true);
    expect(saveEnv.data?.contextPackId).toBeTruthy();

    // File should exist somewhere under contextPacksRoot.
    const dirEntries = readdirSync(h.bootMcp.contextPacksRoot);
    expect(dirEntries.length).toBeGreaterThan(0);
    const packFile = dirEntries.find((f) => f.endsWith('.md'));
    expect(packFile).toBeTruthy();
    if (packFile !== undefined) {
      expect(existsSync(join(h.bootMcp.contextPacksRoot, packFile))).toBe(true);
    }
  });
});
