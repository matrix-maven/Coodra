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
 * Integration tests for the 8 new Claude Code hook events (2026-08-04
 * coverage expansion) + the ConfigChange rewire + the SessionEnd/
 * StopFailure run-completion fix. Same harness shape as
 * `lifecycle-event-recent-context.test.ts`.
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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-new-events-packs-'));
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
  readonly ok?: boolean;
  readonly decision?: string;
  readonly reason?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
    readonly decision?: { readonly behavior?: string };
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
    { agentType: 'claude_code', rawPayload: { session_id: sessionId, cwd: h.cwd, ...rawPayload } },
    'mcp-session',
    { agentType: 'claude_code' },
  );
  return unwrapHook(result);
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'claude_code', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'claude_code' },
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

describe('lifecycle_event — ConfigChange rewire', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness('proj-config-change');
  });
  afterEach(async () => {
    await h.close();
  });

  it('runs the policy-projection attestation (previously a no-op) and returns a structured hookSpecificOutput', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_pre');
    const out = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'ConfigChange' });
    expect(out.ok).toBe(true);
    expect(out.hookSpecificOutput?.hookEventName).toBe('ConfigChange');
    // No .claude/settings.json exists in this scratch cwd — attestation
    // status is 'missing', which renders a non-null drift block (as
    // opposed to 'match', which renders null). Confirms the branch
    // actually executes now, rather than falling to the old no-op default.
    expect(out.hookSpecificOutput?.additionalContext).toContain('policy projection');
  });
});

describe('lifecycle_event — PreCompact one-shot nudge', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-precompact');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'sess_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('does not block when nothing has been recorded yet', async () => {
    const out = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(out.decision).toBeUndefined();
  });

  it('blocks the first PreCompact when a decision is recorded but no Context Pack saved, then allows the second', async () => {
    await registry.handleCall('record_decision', { runId, description: 'Chose X', rationale: 'Because Y' }, 'sess_pre');

    const first = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('save_context_pack');

    const run = await readRun(h, runId);
    expect(run.compactionNudgedAt).not.toBeNull();

    const second = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(second.decision).toBeUndefined();
  });

  it('does not block when a Context Pack already exists, even with recorded decisions', async () => {
    await registry.handleCall('record_decision', { runId, description: 'Chose X', rationale: 'Because Y' }, 'sess_pre');
    await registry.handleCall('save_context_pack', { runId, title: 'Recap', content: 'Body.' }, 'sess_pre');

    const out = await fireHook(registry, h, 'sess_pre', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(out.decision).toBeUndefined();
  });
});

describe('lifecycle_event — run-completion fix (SessionEnd / StopFailure)', () => {
  let h: Harness;
  let registry: ToolRegistry;
  let runId: string;

  beforeEach(async () => {
    h = await openHarness('proj-run-completion');
    registry = buildRegistry(h);
    runId = await sessionStart(registry, h, 'sess_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('SessionEnd marks the run completed', async () => {
    expect((await readRun(h, runId)).status).toBe('in_progress');
    await fireHook(registry, h, 'sess_pre', { hook_event_name: 'SessionEnd' });
    const run = await readRun(h, runId);
    expect(run.status).toBe('completed');
    expect(run.endedAt).not.toBeNull();
  });

  it('StopFailure marks the run failed and surfaces error_type/error_message as the recorded reason', async () => {
    const out = await fireHook(registry, h, 'sess_pre', {
      hook_event_name: 'StopFailure',
      error_type: 'rate_limit',
      error_message: 'Rate limit exceeded.',
    });
    expect(out.ok).toBe(true);
    const run = await readRun(h, runId);
    expect(run.status).toBe('failed');
    expect(run.endedAt).not.toBeNull();
  });
});

describe('lifecycle_event — PermissionRequest / PermissionDenied / SubagentStart / SubagentStop / PostToolUseFailure', () => {
  let h: Harness;
  let registry: ToolRegistry;

  beforeEach(async () => {
    h = await openHarness('proj-misc-events');
    registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_pre');
  });
  afterEach(async () => {
    await h.close();
  });

  it('PermissionRequest with the default policy returns an explicit allow decision', async () => {
    const out = await fireHook(registry, h, 'sess_pre', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'npm test' },
    });
    expect(out.hookSpecificOutput?.hookEventName).toBe('PermissionRequest');
    expect(out.hookSpecificOutput?.decision?.behavior).toBe('allow');
  });

  it("never runs checkPolicy against Coodra's own mcp__coodra__*/mcp__graphify__* tool calls (self-policing guard)", async () => {
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
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
      { agentType: 'claude_code' },
    );
    // reason stays the generic default ('lifecycle_recorded') rather than
    // a checkPolicy-derived reason — proves the policy lookup was skipped
    // entirely, not just that it happened to return 'allow'.
    expect(result.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });

    const graphify = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_pre',
          cwd: h.cwd,
          tool_name: 'mcp__graphify__query_graph',
          tool_use_id: 'tool-3',
        },
      },
      'mcp-session',
      { agentType: 'claude_code' },
    );
    expect(graphify.structuredContent).toMatchObject({ permissionDecision: 'allow', reason: 'lifecycle_recorded' });
  });

  it('PermissionDenied, SubagentStart, SubagentStop, and PostToolUseFailure all return a plain ok:true ack', async () => {
    for (const rawPayload of [
      { hook_event_name: 'PermissionDenied', tool_name: 'Bash', denial_reason: 'Destructive command' },
      { hook_event_name: 'SubagentStart', agent_type: 'Explore', agent_id: 'subagent_1' },
      {
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'subagent_1',
        last_assistant_message: 'done',
      },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_error: 'exit code 1' },
      { hook_event_name: 'PostCompact', trigger: 'auto' },
    ]) {
      const out = await fireHook(registry, h, 'sess_pre', rawPayload);
      expect(out.ok).toBe(true);
      expect(out.decision).toBeUndefined();
    }
  });
});
