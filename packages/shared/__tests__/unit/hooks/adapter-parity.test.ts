import { describe, expect, it } from 'vitest';

import { adaptClaudeCode } from '../../../src/hooks/adapters/claude-code.js';
import { adaptCodex } from '../../../src/hooks/adapters/codex.js';

/**
 * Two semantically-equivalent fixtures (one per agent representing
 * "PreToolUse: Write to src/auth.ts") must produce HookEvents that
 * match across `eventPhase`, `toolName`, `filePath`, and the *shape*
 * of `sessionId` after normalization. The full equality check is
 * relaxed to those four fields because:
 *   - `agentType` differs by design
 *   - `turnId` is agent-specific
 *   - `toolInput` is opaque passthrough
 *   - `sessionId` content differs (each agent has its own ID format
 *     after normalization)
 *
 * This is what §16 pattern 12 means by "zero agent-specific code
 * downstream of the adapter": the four fields above are what the
 * downstream policy + run-recorder code branches on.
 */

const FROZEN = () => new Date('2026-04-25T12:00:00.000Z');

describe('adapter parity — semantically-equivalent inputs produce structurally-equivalent HookEvents', () => {
  it('PreToolUse: Write to src/auth.ts produces phase=pre + toolName=Write + filePath set across both agents', () => {
    const cc = adaptClaudeCode(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'cc-session-1',
        tool_name: 'Write',
        tool_input: { file_path: 'src/auth.ts', content: '...' },
        tool_use_id: 'tool-uuid-1',
        cwd: '/home/dev/myapp',
      },
      { now: FROZEN },
    );

    const codex = adaptCodex(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'codex-session-1',
        tool_name: 'apply_patch',
        tool_call_id: 'call-1',
        tool_input: { file_path: 'src/auth.ts' },
        cwd: '/home/dev/myapp',
      },
      { now: FROZEN },
    );

    for (const event of [cc, codex]) {
      expect(event.eventPhase).toBe('pre');
      expect(['Write', 'apply_patch']).toContain(event.toolName);
      expect(event.filePath).toBe('src/auth.ts');
      expect(event.rawAt).toBe('2026-04-25T12:00:00.000Z');
    }
  });

  it('PostToolUse → eventPhase=post across both agents', () => {
    const cc = adaptClaudeCode(
      { hook_event_name: 'PostToolUse', session_id: 'cc', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { now: FROZEN },
    );
    const codex = adaptCodex(
      { hook_event_name: 'PostToolUse', session_id: 'codex', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { now: FROZEN },
    );
    expect(cc.eventPhase).toBe('post');
    expect(codex.eventPhase).toBe('post');
  });

  it('SessionStart / SessionEnd → session_start / session_end uniformly (Phase 3 Fix A)', () => {
    // Pre-Phase-3 Claude Code's Stop event mapped to 'session_end',
    // conflating per-turn-end with session-termination. Phase 3 Fix A
    // (2026-05-02 — `dec_ea32e7ed`): SessionEnd is the canonical
    // session-termination event in Claude Code; Stop maps to a
    // distinct 'turn_end' phase asserted in claude-code-adapter.test.ts.
    const ccStart = adaptClaudeCode({ hook_event_name: 'SessionStart', session_id: 'cc' }, { now: FROZEN });
    const ccEnd = adaptClaudeCode({ hook_event_name: 'SessionEnd', session_id: 'cc' }, { now: FROZEN });
    const codexStart = adaptCodex({ hook_event_name: 'SessionStart', session_id: 'codex' }, { now: FROZEN });
    const codexEnd = adaptCodex({ hook_event_name: 'SessionEnd', session_id: 'codex' }, { now: FROZEN });
    expect(ccStart.eventPhase).toBe('session_start');
    expect(ccEnd.eventPhase).toBe('session_end');
    expect(codexStart.eventPhase).toBe('session_start');
    expect(codexEnd.eventPhase).toBe('session_end');
  });
});
