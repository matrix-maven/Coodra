import { describe, expect, it } from 'vitest';

import { adaptCodex } from '../../../src/hooks/adapters/codex.js';
import { CodexHookPayloadSchema } from '../../../src/hooks/payloads/codex.js';

const FROZEN = () => new Date('2026-07-29T12:00:00.000Z');

describe('Codex adapter', () => {
  it('PreToolUse with full payload produces the canonical HookEvent', () => {
    const event = adaptCodex(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'thr-abc-123',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'tool-xyz',
        tool_input: { file_path: 'src/x.ts', command: '*** Begin Patch...' },
        cwd: '/repo',
      },
      { now: FROZEN },
    );

    expect(event).toEqual({
      agentType: 'codex',
      eventPhase: 'pre',
      sessionId: 'thr-abc-123',
      turnId: 'tool-xyz',
      toolName: 'apply_patch',
      filePath: 'src/x.ts',
      toolInput: { file_path: 'src/x.ts', command: '*** Begin Patch...' },
      cwd: '/repo',
      rawAt: '2026-07-29T12:00:00.000Z',
    });
  });

  it('UserPromptSubmit folds prompt into toolInput under a stable sentinel toolName', () => {
    const event = adaptCodex(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'thr',
        prompt: 'use Coodra context first',
      },
      { now: FROZEN },
    );

    expect(event.eventPhase).toBe('user_prompt');
    expect(event.toolName).toBe('user_prompt');
    expect(event.toolInput).toEqual({ prompt: 'use Coodra context first' });
  });

  it('SessionEnd maps to session_end and Stop maps to turn_end', () => {
    const sessionEnd = adaptCodex({ hook_event_name: 'SessionEnd', session_id: 'thr' }, { now: FROZEN });
    const stop = adaptCodex({ hook_event_name: 'Stop', session_id: 'thr' }, { now: FROZEN });

    expect(sessionEnd.eventPhase).toBe('session_end');
    expect(stop.eventPhase).toBe('turn_end');
  });

  it('payload schema accepts unknown Codex extension fields', () => {
    const result = CodexHookPayloadSchema.safeParse({
      hook_event_name: 'PreToolUse',
      session_id: 'thr',
      transcript_path: '/repo/.codex/session.jsonl',
      permission_mode: 'default',
      model: 'gpt-5',
    });

    expect(result.success).toBe(true);
  });
});
