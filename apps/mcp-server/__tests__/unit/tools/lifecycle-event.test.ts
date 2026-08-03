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
  it('accepts Codex, Claude Code, and Cursor native plugin agents', () => {
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
});
