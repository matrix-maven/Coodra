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
 * Integration tests for the 4 new Cursor hook events (Cursor hook
 * coverage expansion, mirroring Claude Code's 91e8803 / Codex's
 * a96e042). Same harness shape as the Codex equivalent, but:
 *   - agentType:'cursor' and camelCase raw `hook_event_name` values
 *     (`preCompact`, not `PreCompact`) — CURSOR_EVENT_NAME_MAP
 *     translates these to the canonical vocabulary internally.
 *   - Cursor's session identifier is `conversation_id`, not
 *     `session_id` (see adapters/cursor.ts).
 *   - PreCompact's shape diverges further than Codex's: Cursor has no
 *     `continue`/`decision` field for this event at all, only
 *     `user_message` — confirmed via direct docs quote ("Fire-and-
 *     forget; no blocking response").
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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-cursor-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-cursor-packs-'));
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
  readonly continue?: boolean;
  readonly decision?: string;
  readonly reason?: string;
  readonly user_message?: string;
  readonly hookSpecificOutput?: {
    readonly decision?: { readonly behavior?: string };
  };
}

function unwrapHook(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): HookResult {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

async function fireHook(
  registry: ToolRegistry,
  h: Harness,
  conversationId: string,
  rawPayload: Record<string, unknown>,
): Promise<HookResult> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'cursor', rawPayload: { conversation_id: conversationId, cwd: h.cwd, ...rawPayload } },
    'mcp-session',
    { agentType: 'cursor' },
  );
  return unwrapHook(result);
}

async function sessionStart(registry: ToolRegistry, h: Harness, conversationId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'cursor',
      rawPayload: { hook_event_name: 'sessionStart', conversation_id: conversationId, cwd: h.cwd },
    },
    'mcp-session',
    { agentType: 'cursor' },
  );
  const structured = result.structuredContent as { runId?: string | null } | undefined;
  const runId = structured?.runId ?? null;
  if (runId === null) throw new Error('expected a runId from sessionStart structuredContent');
  return runId;
}

async function readRun(h: Harness, runId: string) {
  const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`run ${runId} not found`);
  return row;
}

describe('lifecycle_event (cursor) — PreCompact one-shot nudge (advisory-only)', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-precompact-cursor');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'conv_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('does not nudge when nothing has been recorded yet', async () => {
    const out = await fireHook(registry, h, 'conv_pre', { hook_event_name: 'preCompact', trigger: 'auto' });
    expect(out.user_message).toBeUndefined();
  });

  it('nudges the first preCompact via user_message (not continue/decision) when unsaved, then stays quiet', async () => {
    await registry.handleCall('record_decision', { runId, description: 'Chose X', rationale: 'Because Y' }, 'conv_pre');

    const first = await fireHook(registry, h, 'conv_pre', { hook_event_name: 'preCompact', trigger: 'auto' });
    expect(first.continue).toBeUndefined();
    expect(first.decision).toBeUndefined();
    expect(first.user_message).toContain('save_context_pack');

    const run = await readRun(h, runId);
    expect(run.compactionNudgedAt).not.toBeNull();

    const second = await fireHook(registry, h, 'conv_pre', { hook_event_name: 'preCompact', trigger: 'auto' });
    expect(second.user_message).toBeUndefined();
  });

  it('does not nudge when a Context Pack already exists, even with recorded decisions', async () => {
    await registry.handleCall('record_decision', { runId, description: 'Chose X', rationale: 'Because Y' }, 'conv_pre');
    await registry.handleCall('save_context_pack', { runId, title: 'Recap', content: 'Body.' }, 'conv_pre');

    const out = await fireHook(registry, h, 'conv_pre', { hook_event_name: 'preCompact', trigger: 'auto' });
    expect(out.user_message).toBeUndefined();
  });
});

describe('lifecycle_event (cursor) — sessionEnd run-completion (already agent-agnostic)', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-run-completion-cursor');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'conv_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('sessionEnd marks the run completed for Cursor too', async () => {
    expect((await readRun(h, runId)).status).toBe('in_progress');
    await fireHook(registry, h, 'conv_pre', { hook_event_name: 'sessionEnd' });
    const run = await readRun(h, runId);
    expect(run.status).toBe('completed');
    expect(run.endedAt).not.toBeNull();
  });
});

describe('lifecycle_event (cursor) — postToolUseFailure / subagentStart / subagentStop', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-misc-events-cursor');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'conv_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('never runs checkPolicy against a mcp__coodra__*/mcp__graphify__*-shaped tool_name (the Claude/Codex prefix path, agent-agnostic)', async () => {
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'cursor',
        rawPayload: {
          hook_event_name: 'preToolUse',
          conversation_id: 'conv_pre',
          cwd: h.cwd,
          tool_name: 'mcp__coodra__search_packs_nl',
          tool_use_id: 'tool-2',
          tool_input: { query: 'anything' },
        },
      },
      'mcp-session',
      { agentType: 'cursor' },
    );
    expect(result.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });
  });

  it("never runs checkPolicy against Cursor's REAL MCP:<tool_name> shape for Coodra's own tools, but does run it for a third-party MCP:<tool_name>", async () => {
    // Cursor's actual wire format (confirmed against Cursor's own hooks
    // docs, 2026-08-05) is the bare tool name, `MCP:<tool_name>` — no
    // server-qualifying prefix like Claude Code's/Codex's
    // `mcp__<server>__<tool>`. isCoodraOwnMcpTool falls back to a
    // maintained name list (COODRA_MCP_TOOL_NAMES/GRAPHIFY_MCP_TOOL_NAMES
    // in @coodra/shared) for exactly this shape.
    const ownTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'cursor',
        rawPayload: {
          hook_event_name: 'preToolUse',
          conversation_id: 'conv_pre',
          cwd: h.cwd,
          tool_name: 'MCP:search_packs_nl',
          tool_use_id: 'tool-own',
          tool_input: { query: 'anything' },
        },
      },
      'mcp-session',
      { agentType: 'cursor' },
    );
    expect(ownTool.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });

    const graphifyOwnTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'cursor',
        rawPayload: {
          hook_event_name: 'preToolUse',
          conversation_id: 'conv_pre',
          cwd: h.cwd,
          tool_name: 'MCP:query_graph',
          tool_use_id: 'tool-own-graphify',
        },
      },
      'mcp-session',
      { agentType: 'cursor' },
    );
    expect(graphifyOwnTool.structuredContent).toMatchObject({
      permissionDecision: 'allow',
      reason: 'lifecycle_recorded',
    });

    const thirdParty = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'cursor',
        rawPayload: {
          hook_event_name: 'preToolUse',
          conversation_id: 'conv_pre',
          cwd: h.cwd,
          tool_name: 'MCP:browser_navigate',
          tool_use_id: 'tool-third-party',
          tool_input: { url: 'https://example.com' },
        },
      },
      'mcp-session',
      { agentType: 'cursor' },
    );
    // checkPolicy actually ran — reason is now policy-derived, not the
    // generic default, proving the third-party call was NOT skipped.
    const thirdPartyStructured = thirdParty.structuredContent as { reason?: string } | undefined;
    expect(thirdPartyStructured?.reason).toBeDefined();
    expect(thirdPartyStructured?.reason).not.toBe('lifecycle_recorded');
  });

  it('postToolUseFailure, subagentStart, and subagentStop all return a plain ack with no decision/continue field', async () => {
    for (const rawPayload of [
      {
        hook_event_name: 'postToolUseFailure',
        tool_name: 'Shell',
        failure_type: 'timeout',
        error_message: 'timed out',
      },
      { hook_event_name: 'subagentStart', subagent_type: 'explore', subagent_id: 'subagent_1' },
      { hook_event_name: 'subagentStop', subagent_type: 'explore', summary: 'done' },
    ]) {
      const out = await fireHook(registry, h, 'conv_pre', rawPayload);
      expect(out.continue).toBeUndefined();
      expect(out.hookSpecificOutput?.decision).toBeUndefined();
    }
  });
});
