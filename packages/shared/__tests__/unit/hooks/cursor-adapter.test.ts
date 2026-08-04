import { describe, expect, it } from 'vitest';

import { adaptCursor } from '../../../src/hooks/adapters/cursor.js';
import { CursorHookPayloadSchema } from '../../../src/hooks/payloads/cursor.js';

const FROZEN = () => new Date('2026-08-02T12:00:00.000Z');

describe('Cursor adapter', () => {
  it('preToolUse with full payload produces the canonical HookEvent', () => {
    const event = adaptCursor(
      {
        hook_event_name: 'preToolUse',
        conversation_id: 'conv-abc-123',
        tool_name: 'Shell',
        tool_use_id: 'tool-xyz',
        tool_input: { file_path: 'src/x.ts', command: 'npm test' },
        cwd: '/repo',
      },
      { now: FROZEN },
    );

    expect(event).toEqual({
      agentType: 'cursor',
      eventPhase: 'pre',
      sessionId: 'conv-abc-123',
      turnId: 'tool-xyz',
      toolName: 'Shell',
      filePath: 'src/x.ts',
      toolInput: { file_path: 'src/x.ts', command: 'npm test' },
      cwd: '/repo',
      rawAt: '2026-08-02T12:00:00.000Z',
    });
  });

  it('beforeSubmitPrompt folds prompt into toolInput under a stable sentinel toolName', () => {
    const event = adaptCursor(
      {
        hook_event_name: 'beforeSubmitPrompt',
        conversation_id: 'conv',
        prompt: 'use Coodra context first',
      },
      { now: FROZEN },
    );

    expect(event.eventPhase).toBe('user_prompt');
    expect(event.toolName).toBe('user_prompt');
    expect(event.toolInput).toEqual({ prompt: 'use Coodra context first' });
  });

  it('sessionEnd maps to session_end and stop maps to turn_end', () => {
    const sessionEnd = adaptCursor({ hook_event_name: 'sessionEnd', conversation_id: 'conv' }, { now: FROZEN });
    const stop = adaptCursor({ hook_event_name: 'stop', conversation_id: 'conv' }, { now: FROZEN });

    expect(sessionEnd.eventPhase).toBe('session_end');
    expect(stop.eventPhase).toBe('turn_end');
  });

  it('falls back to session_id when conversation_id is absent', () => {
    const event = adaptCursor({ hook_event_name: 'sessionStart', session_id: 'sess-1' }, { now: FROZEN });
    expect(event.sessionId).toBe('sess-1');
  });

  it('falls back to a sentinel session id when neither conversation_id nor session_id is present', () => {
    const event = adaptCursor({ hook_event_name: 'sessionStart' }, { now: FROZEN });
    expect(event.sessionId).toBe('unknown');
  });

  it('payload schema accepts unknown Cursor extension fields', () => {
    const result = CursorHookPayloadSchema.safeParse({
      hook_event_name: 'preToolUse',
      conversation_id: 'conv',
      cursor_version: '3.13.25',
      model: 'claude-opus-4-7-thinking-max',
      workspace_roots: ['/repo'],
    });

    expect(result.success).toBe(true);
  });

  it('payload schema rejects an unknown hook_event_name', () => {
    const result = CursorHookPayloadSchema.safeParse({
      hook_event_name: 'beforeShellExecution',
      conversation_id: 'conv',
    });

    expect(result.success).toBe(false);
  });

  // Cursor hook coverage expansion — 4 new events, mirroring Claude
  // Code's 91e8803 / Codex's a96e042.
  describe('4 new events', () => {
    it.each([
      ['postToolUseFailure', 'post_tool_use_failure'],
      ['subagentStart', 'subagent_start'],
      ['subagentStop', 'subagent_stop'],
      ['preCompact', 'pre_compact'],
    ] as const)('%s maps to eventPhase=%s', (hookEventName, expectedPhase) => {
      const parsed = CursorHookPayloadSchema.safeParse({ hook_event_name: hookEventName, conversation_id: 'conv' });
      expect(parsed.success).toBe(true);
      const event = adaptCursor({ hook_event_name: hookEventName, conversation_id: 'conv' }, { now: FROZEN });
      expect(event.eventPhase).toBe(expectedPhase);
    });

    it('postToolUseFailure combines failure_type + error_message into toolError', () => {
      const event = adaptCursor(
        {
          hook_event_name: 'postToolUseFailure',
          conversation_id: 'conv',
          tool_name: 'Shell',
          failure_type: 'timeout',
          error_message: 'Command timed out after 30s',
        },
        { now: FROZEN },
      );
      expect(event.toolError).toBe('timeout: Command timed out after 30s');
    });

    it('subagentStart threads subagent_type/subagent_id, not tool_name', () => {
      const event = adaptCursor(
        { hook_event_name: 'subagentStart', conversation_id: 'conv', subagent_type: 'explore', subagent_id: 'abc-123' },
        { now: FROZEN },
      );
      expect(event.subagentType).toBe('explore');
      expect(event.subagentId).toBe('abc-123');
      expect(event.toolName).toBe('');
    });

    it('subagentStop threads subagent_type and folds summary into lastAssistantMessage', () => {
      const event = adaptCursor(
        {
          hook_event_name: 'subagentStop',
          conversation_id: 'conv',
          subagent_type: 'explore',
          summary: 'Explored the auth flow, found 3 entry points.',
        },
        { now: FROZEN },
      );
      expect(event.subagentType).toBe('explore');
      expect(event.subagentId).toBeUndefined();
      expect(event.lastAssistantMessage).toBe('Explored the auth flow, found 3 entry points.');
    });

    it('preCompact threads trigger', () => {
      const event = adaptCursor(
        { hook_event_name: 'preCompact', conversation_id: 'conv', trigger: 'auto' },
        { now: FROZEN },
      );
      expect(event.compactTrigger).toBe('auto');
    });
  });
});
