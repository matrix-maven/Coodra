import { describe, expect, it } from 'vitest';

import { adaptCursor } from '../../../src/hooks/adapters/cursor.js';
import { CursorHookPayloadSchema } from '../../../src/hooks/payloads/cursor.js';

const FROZEN = () => new Date('2026-04-25T12:00:00.000Z');

describe('Cursor adapter', () => {
  it('pre_tool_use maps to phase=pre, sessionId from conversation_id', () => {
    const event = adaptCursor(
      {
        conversation_id: 'conv-abc',
        event_type: 'pre_tool_use',
        tool_name: 'Edit',
        tool_call_id: 'call-xyz',
        tool_input: { file_path: 'src/x.ts', edits: [] },
        cwd: '/repo',
      },
      { now: FROZEN },
    );
    expect(event.agentType).toBe('cursor');
    expect(event.eventPhase).toBe('pre');
    expect(event.sessionId).toBe('conv-abc');
    expect(event.turnId).toBe('call-xyz');
    expect(event.toolName).toBe('Edit');
    expect(event.filePath).toBe('src/x.ts');
    expect(event.cwd).toBe('/repo');
  });

  it('session_start / session_end map to the corresponding eventPhase', () => {
    const start = adaptCursor({ conversation_id: 'conv', event_type: 'session_start' }, { now: FROZEN });
    const end = adaptCursor({ conversation_id: 'conv', event_type: 'session_end' }, { now: FROZEN });
    expect(start.eventPhase).toBe('session_start');
    expect(end.eventPhase).toBe('session_end');
  });

  it('payload schema accepts unknown top-level fields (.passthrough — Phase 3 Fix A)', () => {
    // Same widening discipline as Claude Code's schema (see Fix A
    // commit 2026-05-02). Cursor will inevitably grow new fields and
    // we don't want a recurrence of the strict-schema fail-open bug.
    const result = CursorHookPayloadSchema.safeParse({
      conversation_id: 'conv',
      event_type: 'pre_tool_use',
      bogus_field: 'should pass through',
    });
    expect(result.success).toBe(true);
  });

  it('payload schema rejects unknown event_type values', () => {
    const result = CursorHookPayloadSchema.safeParse({
      conversation_id: 'conv',
      event_type: 'NotAnEvent',
    });
    expect(result.success).toBe(false);
  });
});
