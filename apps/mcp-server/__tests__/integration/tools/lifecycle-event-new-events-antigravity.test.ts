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
 * Integration tests for Antigravity as a fifth supported native-plugin
 * agent (2026-08-06). Antigravity's own hook vocabulary is the smallest
 * and most different of every agent — only 5 events (`PreToolUse`,
 * `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`), camelCase
 * payloads, and no field identifying which event fired at all (Coodra's
 * own `hook-runner.mjs` injects a synthetic `hookEventName` — see
 * `payloads/antigravity.ts`'s module docblock).
 *
 * Confirmed absent from Antigravity's vocabulary entirely: `SessionStart`
 * (synthesized from the first `PreInvocation` — see
 * `canonicalizeAntigravityEventName`), `SessionEnd`, `UserPromptSubmit`,
 * `PermissionRequest`, `PreCompact`/`PostCompact`. Because there's no
 * real `SessionEnd`, `markRunCompleted` never fires for Antigravity —
 * unlike every other agent's own "run-completion (agent-agnostic, works
 * for free)" test, there is no equivalent test here; that's a
 * deliberate, documented gap, not an oversight.
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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-antigravity-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-antigravity-packs-'));
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
  registry.register(createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo' }));
  registry.register(createSaveContextPackToolRegistration({ db: h.handle }));
  registry.register(createRecordDecisionToolRegistration({ db: h.handle }));
  return registry;
}

interface HookResult {
  readonly decision?: string;
  readonly reason?: string;
  readonly injectSteps?: ReadonlyArray<{ ephemeralMessage?: string }>;
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
    { agentType: 'antigravity', rawPayload: { conversationId, workspacePaths: [h.cwd], ...rawPayload } },
    'mcp-session',
    { agentType: 'antigravity' },
  );
  return unwrapHook(result);
}

async function sessionStart(registry: ToolRegistry, h: Harness, conversationId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'antigravity',
      rawPayload: { hookEventName: 'PreInvocation', conversationId, workspacePaths: [h.cwd], invocationNum: 1 },
    },
    'mcp-session',
    { agentType: 'antigravity' },
  );
  const structured = result.structuredContent as { runId?: string | null; hookEventName?: string } | undefined;
  expect(structured?.hookEventName).toBe('SessionStart');
  const runId = structured?.runId ?? null;
  if (runId === null) throw new Error('expected a runId from the synthesized SessionStart structuredContent');
  return runId;
}

async function readRun(h: Harness, runId: string) {
  const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`run ${runId} not found`);
  return row;
}

describe('lifecycle_event (antigravity) — the synthesized SessionStart creates a run like every other agent', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-run-creation-antigravity');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'conv_1');
  });
  afterEach(async () => {
    await h.close();
  });

  it('the run is in_progress after the synthesized SessionStart, and stays in_progress — there is no real SessionEnd to complete it', async () => {
    expect((await readRun(h, runId)).status).toBe('in_progress');
    // Later PreInvocation calls on the same conversation do NOT
    // re-trigger SessionStart or otherwise change run status.
    await fireHook(registry, h, 'conv_1', { hookEventName: 'PreInvocation', invocationNum: 2 });
    expect((await readRun(h, runId)).status).toBe('in_progress');
  });
});

describe('lifecycle_event (antigravity) — self-policing guard: bare tool name, unconfirmed matcher namespace', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-mcp-guard-antigravity');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'conv_1');
  });
  afterEach(async () => {
    await h.close();
  });

  it("never runs checkPolicy against Coodra's own mcp__coodra__*/mcp__graphify__* tool calls (structural prefix, same as Claude/Codex/Devin)", async () => {
    const coodraTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: {
          hookEventName: 'PreToolUse',
          conversationId: 'conv_1',
          workspacePaths: [h.cwd],
          stepIdx: 1,
          toolCall: { name: 'mcp__coodra__search_packs_nl', args: { query: 'anything' } },
        },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    expect(coodraTool.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });
  });

  it("also treats a BARE tool name (no mcp__ prefix at all) matching Coodra's own tool list as Coodra's own — the server-side backstop for Antigravity's unconfirmed matcher namespace", async () => {
    const bareCoodraTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: {
          hookEventName: 'PreToolUse',
          conversationId: 'conv_1',
          workspacePaths: [h.cwd],
          stepIdx: 2,
          toolCall: { name: 'search_packs_nl', args: { query: 'anything' } },
        },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    expect(bareCoodraTool.structuredContent).toMatchObject({
      permissionDecision: 'allow',
      reason: 'lifecycle_recorded',
    });
  });

  it('does run checkPolicy for a real native tool call (reason is policy-derived, not the generic default)', async () => {
    const nativeTool = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: {
          hookEventName: 'PreToolUse',
          conversationId: 'conv_1',
          workspacePaths: [h.cwd],
          stepIdx: 3,
          toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } },
        },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    const structured = nativeTool.structuredContent as { reason?: string } | undefined;
    expect(structured?.reason).toBeDefined();
    expect(structured?.reason).not.toBe('lifecycle_recorded');
  });
});

describe('lifecycle_event (antigravity) — output shapes across all 5 events', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-shapes-antigravity');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'conv_1');
  });
  afterEach(async () => {
    await h.close();
  });

  it('the synthesized SessionStart injects the session contract via injectSteps[0].ephemeralMessage (no top-level decision)', async () => {
    const out = await fireHook(registry, h, 'conv_new', { hookEventName: 'PreInvocation', invocationNum: 1 });
    expect(out.decision).toBeUndefined();
    expect(out.injectSteps?.[0]?.ephemeralMessage).toContain('Coodra session contract');
  });

  it('PreToolUse/PostToolUse/PreInvocation(later)/PostInvocation/Stop all stay a plain ack ({}) when nothing is denied', async () => {
    for (const rawPayload of [
      { hookEventName: 'PreToolUse', stepIdx: 1, toolCall: { name: 'run_command', args: {} } },
      { hookEventName: 'PostToolUse', stepIdx: 1 },
      { hookEventName: 'PreInvocation', invocationNum: 3 },
      { hookEventName: 'PostInvocation', invocationNum: 3 },
      { hookEventName: 'Stop', executionNum: 1, terminationReason: 'model_stop' },
    ]) {
      const out = await fireHook(registry, h, 'conv_1', rawPayload);
      expect(out).toEqual({});
    }
  });

  it("PostToolUse never carries injectSteps, even indirectly — Antigravity's own docs give it a bare {} output contract", async () => {
    const out = await fireHook(registry, h, 'conv_1', { hookEventName: 'PostToolUse', stepIdx: 1 });
    expect(out).toEqual({});
  });

  it('an unknown/malformed Antigravity payload (missing the synthetic hookEventName field) fails schema validation and falls back to the generic Unknown-event ack, not a crash', async () => {
    const result = await registry.handleCall(
      'lifecycle_event',
      { agentType: 'antigravity', rawPayload: { conversationId: 'conv_1', workspacePaths: [h.cwd] } },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    const structured = result.structuredContent as { hookEventName?: string; reason?: string } | undefined;
    expect(structured?.hookEventName).toBe('Unknown');
    expect(structured?.reason).toBe('invalid_hook_payload');
  });
});
