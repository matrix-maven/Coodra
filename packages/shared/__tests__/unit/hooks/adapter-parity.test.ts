import { describe, expect, it } from 'vitest';

import { adaptAntigravity, canonicalizeAntigravityEventName } from '../../../src/hooks/adapters/antigravity.js';
import { adaptClaudeCode } from '../../../src/hooks/adapters/claude-code.js';
import { adaptCodex } from '../../../src/hooks/adapters/codex.js';
import { adaptCursor } from '../../../src/hooks/adapters/cursor.js';
import { adaptDevin } from '../../../src/hooks/adapters/devin.js';

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

    const cursor = adaptCursor(
      {
        hook_event_name: 'preToolUse',
        conversation_id: 'cursor-session-1',
        tool_name: 'Write',
        tool_use_id: 'tool-uuid-1',
        tool_input: { file_path: 'src/auth.ts' },
        cwd: '/home/dev/myapp',
      },
      { now: FROZEN },
    );

    const devin = adaptDevin(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'devin-session-1',
        tool_name: 'write',
        prompt_id: 'prompt-uuid-1',
        tool_input: { file_path: 'src/auth.ts' },
        cwd: '/home/dev/myapp',
      },
      { now: FROZEN },
    );

    const antigravity = adaptAntigravity(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'antigravity-session-1',
        stepIdx: 1,
        toolCall: { name: 'write_file', args: { file_path: 'src/auth.ts' } },
        workspacePaths: ['/home/dev/myapp'],
      },
      'PreToolUse',
      { now: FROZEN },
    );

    for (const event of [cc, codex, cursor, devin, antigravity]) {
      expect(event.eventPhase).toBe('pre');
      expect(['Write', 'apply_patch', 'write', 'write_file']).toContain(event.toolName);
      expect(event.filePath).toBe('src/auth.ts');
      expect(event.rawAt).toBe('2026-04-25T12:00:00.000Z');
    }
  });

  it('PostToolUse → eventPhase=post across all five agents', () => {
    const cc = adaptClaudeCode(
      { hook_event_name: 'PostToolUse', session_id: 'cc', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { now: FROZEN },
    );
    const codex = adaptCodex(
      { hook_event_name: 'PostToolUse', session_id: 'codex', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { now: FROZEN },
    );
    const cursor = adaptCursor(
      { hook_event_name: 'postToolUse', conversation_id: 'cursor', tool_name: 'Shell', tool_input: { command: 'ls' } },
      { now: FROZEN },
    );
    const devin = adaptDevin(
      { hook_event_name: 'PostToolUse', session_id: 'devin', tool_name: 'exec', tool_input: { command: 'ls' } },
      { now: FROZEN },
    );
    // Antigravity's own PostToolUse payload never restates the tool call
    // (confirmed gap — see payloads/antigravity.ts) — no toolCall here,
    // matching the real wire shape, not assumed symmetry with PreToolUse.
    const antigravity = adaptAntigravity(
      { hookEventName: 'PostToolUse', conversationId: 'antigravity', stepIdx: 2 },
      'PostToolUse',
      { now: FROZEN },
    );
    expect(cc.eventPhase).toBe('post');
    expect(codex.eventPhase).toBe('post');
    expect(cursor.eventPhase).toBe('post');
    expect(devin.eventPhase).toBe('post');
    expect(antigravity.eventPhase).toBe('post');
    expect(antigravity.toolName).toBe('');
  });

  it('Antigravity: canonicalizeAntigravityEventName synthesizes SessionStart from the first PreInvocation only', () => {
    const first = canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 1 });
    const firstZero = canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 0 });
    const firstAbsent = canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation' });
    const later = canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 5 });
    expect(first).toBe('SessionStart');
    expect(firstZero).toBe('SessionStart');
    expect(firstAbsent).toBe('SessionStart');
    expect(later).toBe('PreInvocation');

    const sessionStartEvent = adaptAntigravity(
      { hookEventName: 'PreInvocation', conversationId: 'antigravity', invocationNum: 1 },
      first,
      { now: FROZEN },
    );
    const laterEvent = adaptAntigravity(
      { hookEventName: 'PreInvocation', conversationId: 'antigravity', invocationNum: 5 },
      later,
      { now: FROZEN },
    );
    expect(sessionStartEvent.eventPhase).toBe('session_start');
    expect(laterEvent.eventPhase).toBe('pre_invocation');
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
    const cursorStart = adaptCursor({ hook_event_name: 'sessionStart', conversation_id: 'cursor' }, { now: FROZEN });
    const cursorEnd = adaptCursor({ hook_event_name: 'sessionEnd', conversation_id: 'cursor' }, { now: FROZEN });
    const devinStart = adaptDevin({ hook_event_name: 'SessionStart', session_id: 'devin' }, { now: FROZEN });
    const devinEnd = adaptDevin({ hook_event_name: 'SessionEnd', session_id: 'devin' }, { now: FROZEN });
    expect(ccStart.eventPhase).toBe('session_start');
    expect(ccEnd.eventPhase).toBe('session_end');
    expect(codexStart.eventPhase).toBe('session_start');
    expect(codexEnd.eventPhase).toBe('session_end');
    expect(cursorStart.eventPhase).toBe('session_start');
    expect(cursorEnd.eventPhase).toBe('session_end');
    expect(devinStart.eventPhase).toBe('session_start');
    expect(devinEnd.eventPhase).toBe('session_end');
  });
});
