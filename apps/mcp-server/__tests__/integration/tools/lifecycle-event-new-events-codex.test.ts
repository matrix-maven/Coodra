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
 * Integration tests for the 5 new Codex hook events (Codex hook
 * coverage expansion, mirroring Claude Code's 91e8803). Same harness
 * shape as `lifecycle-event-new-events.test.ts`, just agentType:'codex'
 * — Codex's shapeHookOutput uses different field shapes than Claude
 * Code's for these events (continue:false for PreCompact, no `ok`
 * wrapper), asserted explicitly below.
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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-codex-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-codex-packs-'));
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
  readonly continue?: boolean;
  readonly reason?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
    readonly decision?: { readonly behavior?: string; readonly message?: string };
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
    { agentType: 'codex', rawPayload: { session_id: sessionId, cwd: h.cwd, ...rawPayload } },
    'mcp-session',
    { agentType: 'codex' },
  );
  return unwrapHook(result);
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'codex', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'codex' },
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

describe('lifecycle_event (codex) — PreCompact one-shot nudge', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-precompact-codex');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'sess_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('does not block when nothing has been recorded yet', async () => {
    const out = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(out.continue).toBeUndefined();
  });

  it('blocks the first PreCompact via continue:false (not decision:block) when unsaved, then allows the second', async () => {
    await registry.handleCall('record_decision', { runId, description: 'Chose X', rationale: 'Because Y' }, 'sess_pre');

    const first = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(first.continue).toBe(false);
    expect(first.reason).toContain('save_context_pack');

    const run = await readRun(h, runId);
    expect(run.compactionNudgedAt).not.toBeNull();

    const second = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(second.continue).toBeUndefined();
  });

  it('does not block when a Context Pack already exists, even with recorded decisions', async () => {
    await registry.handleCall('record_decision', { runId, description: 'Chose X', rationale: 'Because Y' }, 'sess_pre');
    await registry.handleCall('save_context_pack', { runId, title: 'Recap', content: 'Body.' }, 'sess_pre');

    const out = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(out.continue).toBeUndefined();
  });
});

describe('lifecycle_event (codex) — SessionEnd run-completion (already agent-agnostic)', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-run-completion-codex');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'sess_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('SessionEnd marks the run completed for Codex too', async () => {
    expect((await readRun(h, runId)).status).toBe('in_progress');
    await fireHook(registry, h, 'sess_pre', { hook_event_name: 'SessionEnd' });
    const run = await readRun(h, runId);
    expect(run.status).toBe('completed');
    expect(run.endedAt).not.toBeNull();
  });
});

describe('lifecycle_event (codex) — PermissionRequest / PostCompact / SubagentStart / SubagentStop', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-misc-events-codex');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('PermissionRequest with the default policy returns a bare ack (no decision) — allow is never forced', async () => {
    const out = await fireHook(registry, h, 'sess_pre', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'npm test' },
    });
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("never runs checkPolicy against Coodra's own mcp__coodra__*/mcp__graphify__* tool calls (self-policing guard, still true after the TOOL_MATCHER fix)", async () => {
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'codex',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_pre',
          cwd: h.cwd,
          tool_name: 'mcp__coodra__search_packs_nl',
          tool_use_id: 'tool-2',
          tool_input: { query: 'anything' },
        },
      },
      'mcp-session',
      { agentType: 'codex' },
    );
    expect(result.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });
  });

  it('PostCompact, SubagentStart, and SubagentStop all return a plain ack with no decision/continue field', async () => {
    for (const rawPayload of [
      { hook_event_name: 'PostCompact', trigger: 'auto' },
      { hook_event_name: 'SubagentStart', agent_type: 'Explore', agent_id: 'subagent_1' },
      { hook_event_name: 'SubagentStop', agent_type: 'Explore', agent_id: 'subagent_1' },
    ]) {
      const out = await fireHook(registry, h, 'sess_pre', rawPayload);
      expect(out.continue).toBeUndefined();
      expect(out.hookSpecificOutput?.decision).toBeUndefined();
    }
  });
});
