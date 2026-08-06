import { describe, expect, it } from 'vitest';

import { adaptDevin } from '../../../src/hooks/adapters/devin.js';
import { DevinHookPayloadSchema } from '../../../src/hooks/payloads/devin.js';

const FROZEN = () => new Date('2026-08-05T12:00:00.000Z');

describe('Devin adapter', () => {
  it('PreToolUse with full payload produces the canonical HookEvent', () => {
    const event = adaptDevin(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-abc-123',
        prompt_id: 'prompt-xyz',
        tool_name: 'exec',
        tool_input: { file_path: 'src/x.ts', command: 'npm test' },
        cwd: '/repo',
      },
      { now: FROZEN },
    );

    expect(event).toEqual({
      agentType: 'devin',
      eventPhase: 'pre',
      sessionId: 'sess-abc-123',
      turnId: 'prompt-xyz',
      toolName: 'exec',
      filePath: 'src/x.ts',
      toolInput: { file_path: 'src/x.ts', command: 'npm test' },
      cwd: '/repo',
      rawAt: '2026-08-05T12:00:00.000Z',
    });
  });

  it("UserPromptSubmit folds prompt into toolInput under a stable sentinel toolName (no tool_name field at all in Devin's own payload)", () => {
    const event = adaptDevin(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess',
        prompt: 'use Coodra context first',
      },
      { now: FROZEN },
    );

    expect(event.eventPhase).toBe('user_prompt');
    expect(event.toolName).toBe('user_prompt');
    expect(event.toolInput).toEqual({ prompt: 'use Coodra context first' });
  });

  it('SessionEnd maps to session_end and Stop maps to turn_end', () => {
    const sessionEnd = adaptDevin({ hook_event_name: 'SessionEnd', session_id: 'sess' }, { now: FROZEN });
    const stop = adaptDevin({ hook_event_name: 'Stop', session_id: 'sess' }, { now: FROZEN });

    expect(sessionEnd.eventPhase).toBe('session_end');
    expect(stop.eventPhase).toBe('turn_end');
  });

  it('PermissionRequest maps to permission_request and PostCompaction maps to post_compact', () => {
    const permissionRequest = adaptDevin(
      { hook_event_name: 'PermissionRequest', session_id: 'sess', tool_name: 'exec' },
      { now: FROZEN },
    );
    const postCompaction = adaptDevin({ hook_event_name: 'PostCompaction', session_id: 'sess' }, { now: FROZEN });

    expect(permissionRequest.eventPhase).toBe('permission_request');
    expect(postCompaction.eventPhase).toBe('post_compact');
  });

  it('falls back to a sentinel session id when session_id is absent', () => {
    const event = adaptDevin({ hook_event_name: 'SessionStart' }, { now: FROZEN });
    expect(event.sessionId).toBe('unknown');
  });

  it("turnId is absent for SessionStart (fires before the first prompt_id exists, confirmed in Devin's own docs)", () => {
    const event = adaptDevin({ hook_event_name: 'SessionStart', session_id: 'sess' }, { now: FROZEN });
    expect(event.turnId).toBeUndefined();
  });

  it("PostToolUse's nested tool_response.error surfaces as toolError — structurally different from every other agent's flatter error field", () => {
    const event = adaptDevin(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess',
        tool_name: 'exec',
        tool_response: { success: false, output: '', error: 'command exited with code 1' },
      },
      { now: FROZEN },
    );
    expect(event.toolError).toBe('command exited with code 1');
  });

  it('PostToolUse with a successful tool_response (error: null) does not set toolError', () => {
    const event = adaptDevin(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess',
        tool_name: 'exec',
        tool_response: { success: true, output: 'ok', error: null },
      },
      { now: FROZEN },
    );
    expect(event.toolError).toBeUndefined();
  });

  it('payload schema accepts unknown Devin extension fields (passthrough)', () => {
    const result = DevinHookPayloadSchema.safeParse({
      hook_event_name: 'PreToolUse',
      session_id: 'sess',
      devin_version: '3000.3.27',
      some_future_field: 'x',
    });
    expect(result.success).toBe(true);
  });

  it('payload schema rejects an unknown hook_event_name (e.g. PreCompact, which Devin does not have)', () => {
    const result = DevinHookPayloadSchema.safeParse({ hook_event_name: 'PreCompact', session_id: 'sess' });
    expect(result.success).toBe(false);
  });

  it('all 8 documented events parse and map to a phase already in the shared eventPhase enum', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['PreToolUse', 'pre'],
      ['PostToolUse', 'post'],
      ['PermissionRequest', 'permission_request'],
      ['UserPromptSubmit', 'user_prompt'],
      ['Stop', 'turn_end'],
      ['PostCompaction', 'post_compact'],
      ['SessionStart', 'session_start'],
      ['SessionEnd', 'session_end'],
    ];
    for (const [hookEventName, expectedPhase] of cases) {
      const parsed = DevinHookPayloadSchema.safeParse({ hook_event_name: hookEventName, session_id: 'sess' });
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const event = adaptDevin(parsed.data, { now: FROZEN });
      expect(event.eventPhase).toBe(expectedPhase);
    }
  });
});
