import { describe, expect, it } from 'vitest';

import { adaptWindsurf } from '../../../src/hooks/adapters/windsurf.js';
import { WindsurfHookPayloadSchema } from '../../../src/hooks/payloads/windsurf.js';

const FROZEN = () => new Date('2026-04-25T12:00:00.000Z');

describe('Windsurf adapter', () => {
  it('pre_write_code maps to phase=pre, toolName=Write, filePath extracted from tool_info', () => {
    const event = adaptWindsurf(
      {
        agent_action_name: 'pre_write_code',
        trajectory_id: 'traj-abc',
        execution_id: 'exec-1',
        tool_info: { file_path: 'src/auth.ts' },
      },
      { now: FROZEN },
    );
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event.agentType).toBe('windsurf');
    expect(event.eventPhase).toBe('pre');
    expect(event.toolName).toBe('Write');
    expect(event.sessionId).toBe('traj-abc');
    expect(event.turnId).toBe('exec-1');
    expect(event.filePath).toBe('src/auth.ts');
  });

  it('pre_run_command maps to phase=pre, toolName=Bash', () => {
    const event = adaptWindsurf({ agent_action_name: 'pre_run_command', trajectory_id: 'traj' }, { now: FROZEN });
    expect(event?.toolName).toBe('Bash');
  });

  it('post_cascade_response maps to session_end', () => {
    const event = adaptWindsurf({ agent_action_name: 'post_cascade_response', trajectory_id: 'traj' }, { now: FROZEN });
    expect(event?.eventPhase).toBe('session_end');
  });

  it('returns null for the three unmapped events (post_read_code, post_user_prompt, pre_cascade_response)', () => {
    for (const action of ['post_read_code', 'post_user_prompt', 'pre_cascade_response'] as const) {
      const event = adaptWindsurf({ agent_action_name: action, trajectory_id: 'traj' }, { now: FROZEN });
      expect(event).toBeNull();
    }
  });

  it('payload schema accepts unknown top-level fields (.passthrough — Phase 3 Fix A)', () => {
    // Same widening discipline as Claude Code's schema (see Fix A
    // commit 2026-05-02).
    const result = WindsurfHookPayloadSchema.safeParse({
      agent_action_name: 'pre_write_code',
      trajectory_id: 'traj',
      bogus_field: 'should pass through',
    });
    expect(result.success).toBe(true);
  });
});
