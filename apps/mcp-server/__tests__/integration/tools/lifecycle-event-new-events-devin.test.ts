import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { createRecordDecisionToolRegistration } from '../../../src/tools/record-decision/manifest.js';
import { createSaveContextPackToolRegistration } from '../../../src/tools/save-context-pack/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration tests for Devin as a fourth supported native-plugin agent
 * (2026-08-05). Devin's own hook vocabulary is the smallest of the
 * four agents — 8 events total, already PascalCase (no
 * `CURSOR_EVENT_NAME_MAP`-style translation needed), and MCP tool names
 * use the same `mcp__<server>__<tool>` prefix as Claude Code/Codex (not
 * Cursor's bare `MCP:<tool_name>` shape) — so `isCoodraOwnMcpTool`
 * needed zero changes for Devin.
 *
 * Confirmed absent from Devin's vocabulary entirely (not just unused):
 * `PreCompact` (only `PostCompaction`, after the fact, no veto power —
 * Coodra's one-shot compaction nudge can never fire for Devin),
 * `SubagentStart`/`SubagentStop`, `PermissionDenied`,
 * `PostToolUseFailure`, `StopFailure`, `ConfigChange`.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
  readonly contextPacksRoot: string;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-devin-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-devin-packs-'));
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
    contextPacksRoot,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(
    createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo', contextPacksRoot: h.contextPacksRoot }),
  );
  registry.register(createSaveContextPackToolRegistration({ db: h.handle }));
  registry.register(createRecordDecisionToolRegistration({ db: h.handle }));
  return registry;
}

interface HookResult {
  readonly decision?: string;
  readonly reason?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
    readonly updatedInput?: unknown;
  };
}

function unwrapHook(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): HookResult {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

async function fireHook(
  registry: ToolRegistry,
  h: Harness,
  sessionId: string,
  rawPayload: Record<string, unknown>,
): Promise<HookResult> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'devin', rawPayload: { session_id: sessionId, cwd: h.cwd, ...rawPayload } },
    'mcp-session',
    { agentType: 'devin' },
  );
  return unwrapHook(result);
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'devin', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'devin' },
  );
  const structured = result.structuredContent as { runId?: string | null } | undefined;
  const runId = structured?.runId ?? null;
  if (runId === null) throw new Error('expected a runId from SessionStart structuredContent');
  return runId;
}

async function readRun(h: Harness, runId: string) {
  const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`run ${runId} not found`);
  return row;
}

describe('lifecycle_event (devin) — run-completion (agent-agnostic, works for free)', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-run-completion-devin');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'sess_1');
  });
  afterEach(async () => {
    await h.close();
  });

  it('SessionEnd marks the run completed for Devin too', async () => {
    expect((await readRun(h, runId)).status).toBe('in_progress');
    await fireHook(registry, h, 'sess_1', { hook_event_name: 'SessionEnd', reason: 'user_ended' });
    const run = await readRun(h, runId);
    expect(run.status).toBe('completed');
    expect(run.endedAt).not.toBeNull();
  });
});

describe('lifecycle_event (devin) — self-policing guard: mcp__ prefix, same shape as Claude/Codex', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-mcp-guard-devin');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_1');
  });
  afterEach(async () => {
    await h.close();
  });

  it("never runs checkPolicy against Coodra's own mcp__coodra__*/mcp__graphify__* tool calls — no name-list fallback needed, unlike Cursor's bare MCP: shape", async () => {
    const coodraTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'devin',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_1',
          cwd: h.cwd,
          tool_name: 'mcp__coodra__search_packs_nl',
          prompt_id: 'prompt-1',
          tool_input: { query: 'anything' },
        },
      },
      'mcp-session',
      { agentType: 'devin' },
    );
    expect(coodraTool.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });

    const graphifyTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'devin',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_1',
          cwd: h.cwd,
          tool_name: 'mcp__graphify__query_graph',
          prompt_id: 'prompt-2',
        },
      },
      'mcp-session',
      { agentType: 'devin' },
    );
    expect(graphifyTool.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });
  });

  it('does run checkPolicy for a third-party MCP tool call (reason is policy-derived, not the generic default)', async () => {
    const thirdParty = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'devin',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_1',
          cwd: h.cwd,
          tool_name: 'mcp__github__create_issue',
          prompt_id: 'prompt-3',
          tool_input: { title: 'x' },
        },
      },
      'mcp-session',
      { agentType: 'devin' },
    );
    const structured = thirdParty.structuredContent as { reason?: string } | undefined;
    expect(structured?.reason).toBeDefined();
    expect(structured?.reason).not.toBe('lifecycle_recorded');
  });
});

describe('lifecycle_event (devin) — output shapes across all 8 events', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-shapes-devin');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_1');
  });
  afterEach(async () => {
    await h.close();
  });

  it('SessionStart injects the session contract via hookSpecificOutput.additionalContext (top-level decision absent)', async () => {
    const out = await fireHook(registry, h, 'sess_new', { hook_event_name: 'SessionStart' });
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput?.additionalContext).toContain('Coodra session contract');
  });

  it('PreToolUse/PostToolUse/PermissionRequest/Stop stay a plain ack ({}) when nothing is denied — no positive "approve" is ever emitted', async () => {
    for (const rawPayload of [
      { hook_event_name: 'PreToolUse', tool_name: 'exec', prompt_id: 'p1', tool_input: { command: 'ls' } },
      { hook_event_name: 'PostToolUse', tool_name: 'exec', prompt_id: 'p1', tool_response: { success: true } },
      { hook_event_name: 'PermissionRequest', tool_name: 'exec', prompt_id: 'p2', tool_input: { command: 'ls' } },
      { hook_event_name: 'Stop', stop_hook_active: false },
    ]) {
      const out = await fireHook(registry, h, 'sess_1', rawPayload);
      expect(out.decision).toBeUndefined();
    }
  });

  it('PostToolUse can inject additionalContext but never a decision', async () => {
    const out = await fireHook(registry, h, 'sess_1', {
      hook_event_name: 'PostToolUse',
      tool_name: 'exec',
      prompt_id: 'p1',
      tool_response: { success: true, output: 'ok' },
    });
    expect(out.decision).toBeUndefined();
    // additionalContext is only populated by the handler for specific
    // conditions (e.g. SessionStart injection) — here it's simply absent
    // since PostToolUse carries none by default, which is itself the
    // point: PostToolUse's hookSpecificOutput shape is reachable, unlike
    // PostCompaction below.
  });

  it('UserPromptSubmit records the prompt and returns hookSpecificOutput shape (block branch present but inert — Coodra never denies UserPromptSubmit today)', async () => {
    const out = await fireHook(registry, h, 'sess_1', { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
  });

  it("SessionEnd and PostCompaction are pure acks ({}) — PostCompaction never gets additionalContext (docs' field table excludes it, despite prose mentioning reinjection as a use case)", async () => {
    const sessionEnd = await fireHook(registry, h, 'sess_1', { hook_event_name: 'SessionEnd', reason: 'done' });
    expect(sessionEnd).toEqual({});

    const postCompaction = await fireHook(registry, h, 'sess_1', {
      hook_event_name: 'PostCompaction',
      summary: 'compacted 40 messages',
    });
    expect(postCompaction).toEqual({});
  });

  it('an unknown/malformed Devin payload (e.g. PreCompact, which Devin does not have) fails schema validation and falls back to the generic Unknown-event ack, not a crash', async () => {
    const result = await registry.handleCall(
      'lifecycle_event',
      { agentType: 'devin', rawPayload: { hook_event_name: 'PreCompact', session_id: 'sess_1', cwd: h.cwd } },
      'mcp-session',
      { agentType: 'devin' },
    );
    const structured = result.structuredContent as { hookEventName?: string; reason?: string } | undefined;
    expect(structured?.hookEventName).toBe('Unknown');
    expect(structured?.reason).toBe('invalid_hook_payload');
  });
});
