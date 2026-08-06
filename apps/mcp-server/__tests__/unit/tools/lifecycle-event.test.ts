import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { lifecycleEventInputSchema } from '../../../src/tools/lifecycle-event/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('lifecycle_event — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'lifecycle-event' })).not.toThrow();
  });
});

describe('lifecycle_event — native agent input schema', () => {
  it('accepts Codex, Claude Code, Cursor, and Devin native plugin agents', () => {
    expect(
      lifecycleEventInputSchema.safeParse({
        agentType: 'codex',
        rawPayload: { hook_event_name: 'SessionStart', session_id: 's' },
      }).success,
    ).toBe(true);
    expect(
      lifecycleEventInputSchema.safeParse({
        agentType: 'claude_code',
        rawPayload: { hook_event_name: 'SessionStart', session_id: 's' },
      }).success,
    ).toBe(true);
    expect(
      lifecycleEventInputSchema.safeParse({
        agentType: 'cursor',
        rawPayload: { hook_event_name: 'sessionStart', conversation_id: 's' },
      }).success,
    ).toBe(true);
    expect(
      lifecycleEventInputSchema.safeParse({
        agentType: 'devin',
        rawPayload: { hook_event_name: 'SessionStart', session_id: 's' },
      }).success,
    ).toBe(true);
    expect(
      lifecycleEventInputSchema.safeParse({
        agentType: 'antigravity',
        rawPayload: { hookEventName: 'PreToolUse', conversationId: 's' },
      }).success,
    ).toBe(true);
  });

  it('accepts each of the 8 new Claude Code events (2026-08-04)', () => {
    for (const hookEventName of [
      'PermissionRequest',
      'PermissionDenied',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'PostToolUseFailure',
      'StopFailure',
    ]) {
      expect(
        lifecycleEventInputSchema.safeParse({
          agentType: 'claude_code',
          rawPayload: { hook_event_name: hookEventName, session_id: 's' },
        }).success,
      ).toBe(true);
    }
  });
});

describe('lifecycle_event — registry hook text output', () => {
  it('returns Claude-shaped hook JSON as MCP text content for Claude mcp_tool hooks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-claude-cwd-'));
    const registry = new ToolRegistry({
      deps: makeFakeDeps(),
      clock: () => new Date('2026-07-30T00:00:00.000Z'),
    });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));

    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'claude-session',
          cwd,
          tool_name: 'Write',
          tool_use_id: 'toolu_123',
          tool_input: { file_path: 'src/index.ts' },
        },
      },
      'mcp-session',
      { agentType: 'claude_code' },
    );

    expect(result.isError).toBeUndefined();
    const text = JSON.parse(result.content[0]?.text ?? '{}') as {
      ok?: boolean;
      data?: unknown;
      hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(text.ok).toBe(true);
    expect(text.data).toBeUndefined();
    expect(text.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'project_config_missing',
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      reason: 'project_config_missing',
    });
  });

  it('returns Cursor-shaped hook JSON (permission/additional_context, not hookSpecificOutput) for Cursor hooks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-cursor-cwd-'));
    const registry = new ToolRegistry({
      deps: makeFakeDeps(),
      clock: () => new Date('2026-08-02T00:00:00.000Z'),
    });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));

    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'cursor',
        rawPayload: {
          hook_event_name: 'preToolUse',
          conversation_id: 'cursor-session',
          cwd,
          tool_name: 'Shell',
          tool_use_id: 'tool-123',
          tool_input: { command: 'npm test' },
        },
      },
      'mcp-session',
      { agentType: 'cursor' },
    );

    expect(result.isError).toBeUndefined();
    const text = JSON.parse(result.content[0]?.text ?? '{}') as {
      permission?: string;
      hookSpecificOutput?: unknown;
      decision?: unknown;
    };
    expect(text.permission).toBe('allow');
    expect(text.hookSpecificOutput).toBeUndefined();
    expect(text.decision).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      reason: 'project_config_missing',
    });
  });

  it('returns Devin-shaped hook JSON (top-level decision, not hookSpecificOutput) for Devin PreToolUse hooks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-devin-cwd-'));
    const registry = new ToolRegistry({
      deps: makeFakeDeps(),
      clock: () => new Date('2026-08-05T00:00:00.000Z'),
    });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));

    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'devin',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'devin-session',
          cwd,
          tool_name: 'exec',
          prompt_id: 'prompt-123',
          tool_input: { command: 'npm test' },
        },
      },
      'mcp-session',
      { agentType: 'devin' },
    );

    expect(result.isError).toBeUndefined();
    const text = JSON.parse(result.content[0]?.text ?? '{}') as {
      decision?: string;
      reason?: string;
      hookSpecificOutput?: unknown;
    };
    // Allow (no project registered → permissionDecision stays 'allow') —
    // no decision key at all, since Devin's own exit-code/decision-omit
    // semantics already mean "continue normally".
    expect(text.decision).toBeUndefined();
    expect(text.hookSpecificOutput).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      reason: 'project_config_missing',
    });
  });

  it('returns Antigravity-shaped hook JSON (top-level decision, not hookSpecificOutput) for Antigravity PreToolUse hooks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-antigravity-cwd-'));
    const registry = new ToolRegistry({
      deps: makeFakeDeps(),
      clock: () => new Date('2026-08-06T00:00:00.000Z'),
    });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));

    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: {
          hookEventName: 'PreToolUse',
          conversationId: 'antigravity-session',
          workspacePaths: [cwd],
          stepIdx: 1,
          toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
        },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );

    expect(result.isError).toBeUndefined();
    const text = JSON.parse(result.content[0]?.text ?? '{}') as {
      decision?: string;
      reason?: string;
      hookSpecificOutput?: unknown;
      injectSteps?: unknown;
    };
    // Allow (no project registered → permissionDecision stays 'allow') —
    // no decision key at all, matching the "omit rather than force allow"
    // precedent every other agent's PreToolUse mapping already follows.
    expect(text.decision).toBeUndefined();
    expect(text.hookSpecificOutput).toBeUndefined();
    expect(text.injectSteps).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      reason: 'project_config_missing',
    });
  });

  it("Antigravity's PostToolUse always returns an empty object, even when the underlying result would carry additionalContext (confirmed capability gap)", async () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps(), clock: () => new Date('2026-08-06T00:00:00.000Z') });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: { hookEventName: 'PostToolUse', conversationId: 'antigravity-session', stepIdx: 1 },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    expect(result.isError).toBeUndefined();
    const text = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(text).toEqual({});
  });

  it("Antigravity's first PreInvocation of a conversation is canonicalized to SessionStart and carries the full session contract via injectSteps", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-antigravity-session-cwd-'));
    const registry = new ToolRegistry({ deps: makeFakeDeps(), clock: () => new Date('2026-08-06T00:00:00.000Z') });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: {
          hookEventName: 'PreInvocation',
          conversationId: 'antigravity-session',
          workspacePaths: [cwd],
          invocationNum: 1,
        },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, hookEventName: 'SessionStart' });
    const text = JSON.parse(result.content[0]?.text ?? '{}') as {
      injectSteps?: Array<{ ephemeralMessage?: string }>;
    };
    expect(text.injectSteps?.[0]?.ephemeralMessage).toContain('Coodra session contract');
  });

  it("Antigravity's later PreInvocation calls (invocationNum > 1) stay PreInvocation — no session contract re-injected every turn", async () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps(), clock: () => new Date('2026-08-06T00:00:00.000Z') });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: { hookEventName: 'PreInvocation', conversationId: 'antigravity-session', invocationNum: 5 },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, hookEventName: 'PreInvocation' });
    const text = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(text).toEqual({});
  });

  it("Antigravity's Stop uses a positive decision:'continue' (inverted wire shape, same block semantics as every other agent)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-antigravity-stop-cwd-'));
    const registry = new ToolRegistry({ deps: makeFakeDeps(), clock: () => new Date('2026-08-06T00:00:00.000Z') });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'antigravity',
        rawPayload: {
          hookEventName: 'Stop',
          conversationId: 'antigravity-session',
          workspacePaths: [cwd],
          executionNum: 1,
          terminationReason: 'model_stop',
        },
      },
      'mcp-session',
      { agentType: 'antigravity' },
    );
    expect(result.isError).toBeUndefined();
    // No project registered → permissionDecision stays 'allow' → Stop
    // never blocks (an empty object, not decision:'continue'). Confirms
    // the mapping is deny-triggered, not unconditional.
    const text = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(text).toEqual({});
  });

  it('PermissionRequest with no project resolves to an explicit allow decision, not the PreToolUse ask/deny shape', async () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps(), clock: () => new Date('2026-08-04T00:00:00.000Z') });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: {
          hook_event_name: 'PermissionRequest',
          session_id: 'claude-session',
          tool_name: 'Bash',
          tool_use_id: 'toolu_1',
          tool_input: { command: 'npm test' },
        },
      },
      'mcp-session',
      { agentType: 'claude_code' },
    );
    const text = JSON.parse(result.content[0]?.text ?? '{}') as {
      hookSpecificOutput?: { hookEventName?: string; decision?: { behavior?: string } };
    };
    expect(text.hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    });
  });

  it('PreCompact with no project just acks — no nudge logic runs without a runId', async () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps(), clock: () => new Date('2026-08-04T00:00:00.000Z') });
    registry.register(createLifecycleEventToolRegistration({ db: fakeDb, mode: 'solo' }));
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: { hook_event_name: 'PreCompact', session_id: 'claude-session', trigger: 'auto' },
      },
      'mcp-session',
      { agentType: 'claude_code' },
    );
    const text = JSON.parse(result.content[0]?.text ?? '{}') as { ok?: boolean; decision?: string };
    expect(text.ok).toBe(true);
    expect(text.decision).toBeUndefined();
  });
});
