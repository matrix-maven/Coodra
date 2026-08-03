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
});
