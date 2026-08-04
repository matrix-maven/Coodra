import { describe, expect, it } from 'vitest';

import { adaptClaudeCode } from '../../../src/hooks/adapters/claude-code.js';
import { ClaudeCodeHookPayloadSchema } from '../../../src/hooks/payloads/claude-code.js';

const FROZEN = () => new Date('2026-04-25T12:00:00.000Z');

describe('Claude Code adapter', () => {
  it('PreToolUse with full payload produces the canonical HookEvent', () => {
    const event = adaptClaudeCode(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-abc-123',
        tool_name: 'Write',
        tool_input: { file_path: 'src/x.ts', content: '...' },
        tool_use_id: 'tool-xyz',
        permission_mode: 'default',
        cwd: '/repo',
      },
      { now: FROZEN },
    );
    expect(event).toEqual({
      agentType: 'claude_code',
      eventPhase: 'pre',
      sessionId: 'sess-abc-123',
      turnId: 'tool-xyz',
      toolName: 'Write',
      filePath: 'src/x.ts',
      toolInput: { file_path: 'src/x.ts', content: '...' },
      permissionMode: 'default',
      cwd: '/repo',
      rawAt: '2026-04-25T12:00:00.000Z',
    });
  });

  it('UserPromptSubmit folds prompt + promptId into toolInput under a stable sentinel toolName', () => {
    const event = adaptClaudeCode(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess',
        prompt: 'rename the foo function to bar',
        prompt_id: 'prompt-001',
      },
      { now: FROZEN },
    );
    expect(event.eventPhase).toBe('user_prompt');
    expect(event.toolName).toBe('user_prompt');
    expect(event.toolInput).toEqual({ prompt: 'rename the foo function to bar', promptId: 'prompt-001' });
  });

  it('normalizes session_id with a colon (Claude Code fork notation)', () => {
    const event = adaptClaudeCode({ hook_event_name: 'PreToolUse', session_id: 'sess-abc:fork-2' }, { now: FROZEN });
    expect(event.sessionId).toBe('sess-abc-fork-2');
  });

  it('payload schema accepts unknown top-level fields (.passthrough — Phase 3 Fix A)', () => {
    // Real Claude Code envelopes carry transcript_path, permission_mode,
    // source, model, agent_id, agent_type beyond the fields Coodra
    // reads. Pre-Phase-3 these were rejected with `invalid_hook_payload`
    // and the route fell open — broken policy, no logging. After Fix A
    // unknown top-level fields parse cleanly.
    const result = ClaudeCodeHookPayloadSchema.safeParse({
      hook_event_name: 'PreToolUse',
      session_id: 'sess',
      transcript_path: '/Users/dev/.claude/projects/abc/abc.jsonl',
      permission_mode: 'default',
      bogus_field: 'should pass through',
    });
    expect(result.success).toBe(true);
  });

  it('payload schema rejects unknown hook_event_name values', () => {
    const result = ClaudeCodeHookPayloadSchema.safeParse({
      hook_event_name: 'NotAnEvent',
      session_id: 'sess',
    });
    expect(result.success).toBe(false);
  });

  it('payload schema accepts SessionEnd (Phase 3 Fix A)', () => {
    const result = ClaudeCodeHookPayloadSchema.safeParse({
      hook_event_name: 'SessionEnd',
      session_id: 'sess',
    });
    expect(result.success).toBe(true);
  });

  it('SessionEnd maps to phase=session_end; Stop maps to phase=turn_end (Phase 3 Fix A)', () => {
    const sessionEnd = adaptClaudeCode({ hook_event_name: 'SessionEnd', session_id: 'cc' }, { now: FROZEN });
    const stop = adaptClaudeCode({ hook_event_name: 'Stop', session_id: 'cc' }, { now: FROZEN });
    expect(sessionEnd.eventPhase).toBe('session_end');
    expect(stop.eventPhase).toBe('turn_end');
  });

  // Claude Code hook coverage expansion (2026-08-04) — 8 new events.
  describe('8 new events (2026-08-04)', () => {
    it.each([
      ['PermissionRequest', 'permission_request'],
      ['PermissionDenied', 'permission_denied'],
      ['SubagentStart', 'subagent_start'],
      ['SubagentStop', 'subagent_stop'],
      ['PreCompact', 'pre_compact'],
      ['PostCompact', 'post_compact'],
      ['PostToolUseFailure', 'post_tool_use_failure'],
      ['StopFailure', 'stop_failure'],
    ] as const)('%s maps to eventPhase=%s', (hookEventName, expectedPhase) => {
      const parsed = ClaudeCodeHookPayloadSchema.safeParse({ hook_event_name: hookEventName, session_id: 'sess' });
      expect(parsed.success).toBe(true);
      const event = adaptClaudeCode({ hook_event_name: hookEventName, session_id: 'sess' }, { now: FROZEN });
      expect(event.eventPhase).toBe(expectedPhase);
    });

    it('PermissionRequest/PermissionDenied/PostToolUseFailure thread tool_name/tool_input like PreToolUse', () => {
      const event = adaptClaudeCode(
        {
          hook_event_name: 'PermissionRequest',
          session_id: 'sess',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_use_id: 'tool-1',
        },
        { now: FROZEN },
      );
      expect(event.toolName).toBe('Bash');
      expect(event.toolInput).toEqual({ command: 'npm test' });
      expect(event.turnId).toBe('tool-1');
    });

    it('PermissionDenied threads denial_reason', () => {
      const event = adaptClaudeCode(
        { hook_event_name: 'PermissionDenied', session_id: 'sess', denial_reason: 'Destructive command' },
        { now: FROZEN },
      );
      expect(event.denialReason).toBe('Destructive command');
    });

    it('SubagentStart/SubagentStop thread agent_type/agent_id, not tool_name', () => {
      const event = adaptClaudeCode(
        { hook_event_name: 'SubagentStart', session_id: 'sess', agent_type: 'Explore', agent_id: 'subagent_xyz' },
        { now: FROZEN },
      );
      expect(event.subagentType).toBe('Explore');
      expect(event.subagentId).toBe('subagent_xyz');
      expect(event.toolName).toBe('');
    });

    it('SubagentStop additionally threads last_assistant_message', () => {
      const event = adaptClaudeCode(
        { hook_event_name: 'SubagentStop', session_id: 'sess', agent_type: 'Explore', last_assistant_message: 'done' },
        { now: FROZEN },
      );
      expect(event.lastAssistantMessage).toBe('done');
    });

    it('PreCompact/PostCompact thread trigger', () => {
      const event = adaptClaudeCode(
        { hook_event_name: 'PreCompact', session_id: 'sess', trigger: 'auto' },
        { now: FROZEN },
      );
      expect(event.compactTrigger).toBe('auto');
    });

    it('PostToolUseFailure threads tool_error', () => {
      const event = adaptClaudeCode(
        {
          hook_event_name: 'PostToolUseFailure',
          session_id: 'sess',
          tool_name: 'Bash',
          tool_error: 'Command failed with exit code 1',
        },
        { now: FROZEN },
      );
      expect(event.toolError).toBe('Command failed with exit code 1');
    });

    it('StopFailure threads error_type/error_message, no tool fields', () => {
      const event = adaptClaudeCode(
        {
          hook_event_name: 'StopFailure',
          session_id: 'sess',
          error_type: 'rate_limit',
          error_message: 'Rate limit exceeded.',
        },
        { now: FROZEN },
      );
      expect(event.errorType).toBe('rate_limit');
      expect(event.errorMessage).toBe('Rate limit exceeded.');
      expect(event.toolName).toBe('');
    });
  });
});
