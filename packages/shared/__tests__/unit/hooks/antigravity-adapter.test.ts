import { describe, expect, it } from 'vitest';

import { adaptAntigravity, canonicalizeAntigravityEventName } from '../../../src/hooks/adapters/antigravity.js';
import { AntigravityHookPayloadSchema } from '../../../src/hooks/payloads/antigravity.js';

const FROZEN = () => new Date('2026-08-06T12:00:00.000Z');

describe('Antigravity adapter', () => {
  it('PreToolUse with full payload produces the canonical HookEvent', () => {
    const canonicalName = canonicalizeAntigravityEventName({
      hookEventName: 'PreToolUse',
      conversationId: 'conv-abc-123',
      stepIdx: 4,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      workspacePaths: ['/repo'],
    });
    const event = adaptAntigravity(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-abc-123',
        stepIdx: 4,
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
        workspacePaths: ['/repo'],
      },
      canonicalName,
      { now: FROZEN },
    );

    expect(canonicalName).toBe('PreToolUse');
    expect(event).toEqual({
      agentType: 'antigravity',
      eventPhase: 'pre',
      sessionId: 'conv-abc-123',
      turnId: '4',
      toolName: 'run_command',
      toolInput: { CommandLine: 'npm test' },
      cwd: '/repo',
      rawAt: '2026-08-06T12:00:00.000Z',
    });
  });

  it("PostToolUse's own documented payload never restates the tool call — toolName comes back empty, not assumed from a prior PreToolUse", () => {
    const event = adaptAntigravity(
      { hookEventName: 'PostToolUse', conversationId: 'conv', stepIdx: 4 },
      'PostToolUse',
      { now: FROZEN },
    );
    expect(event.toolName).toBe('');
    expect(event.toolInput).toBeUndefined();
    expect(event.eventPhase).toBe('post');
  });

  it('PostToolUse error surfaces as toolError', () => {
    const event = adaptAntigravity(
      { hookEventName: 'PostToolUse', conversationId: 'conv', stepIdx: 4, error: 'exit status 1' },
      'PostToolUse',
      { now: FROZEN },
    );
    expect(event.toolError).toBe('exit status 1');
  });

  it("the first PreInvocation of a conversation (invocationNum <= 1) canonicalizes to 'SessionStart'; later ones stay 'PreInvocation'", () => {
    expect(canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 1 })).toBe('SessionStart');
    expect(canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 0 })).toBe('SessionStart');
    expect(canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation' })).toBe('SessionStart');
    expect(canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 2 })).toBe(
      'PreInvocation',
    );
    expect(canonicalizeAntigravityEventName({ hookEventName: 'PreInvocation', invocationNum: 99 })).toBe(
      'PreInvocation',
    );
  });

  it('PreToolUse/PostToolUse/Stop canonicalization is a no-op — only PreInvocation is data-dependent', () => {
    for (const name of ['PreToolUse', 'PostToolUse', 'Stop', 'PostInvocation'] as const) {
      expect(canonicalizeAntigravityEventName({ hookEventName: name, invocationNum: 1 })).toBe(name);
    }
  });

  it('a synthesized SessionStart event carries eventPhase session_start; a later PreInvocation carries the new pre_invocation phase', () => {
    const sessionStart = adaptAntigravity(
      { hookEventName: 'PreInvocation', conversationId: 'conv', invocationNum: 1 },
      'SessionStart',
      { now: FROZEN },
    );
    const laterTurn = adaptAntigravity(
      { hookEventName: 'PreInvocation', conversationId: 'conv', invocationNum: 4 },
      'PreInvocation',
      { now: FROZEN },
    );
    const postInvocation = adaptAntigravity(
      { hookEventName: 'PostInvocation', conversationId: 'conv', invocationNum: 4 },
      'PostInvocation',
      { now: FROZEN },
    );
    expect(sessionStart.eventPhase).toBe('session_start');
    expect(laterTurn.eventPhase).toBe('pre_invocation');
    expect(postInvocation.eventPhase).toBe('post_invocation');
  });

  it('Stop maps to turn_end', () => {
    const event = adaptAntigravity(
      { hookEventName: 'Stop', conversationId: 'conv', executionNum: 1, terminationReason: 'model_stop' },
      'Stop',
      { now: FROZEN },
    );
    expect(event.eventPhase).toBe('turn_end');
  });

  it('falls back to a sentinel session id when conversationId is absent', () => {
    const event = adaptAntigravity({ hookEventName: 'Stop' }, 'Stop', { now: FROZEN });
    expect(event.sessionId).toBe('unknown');
  });

  it('turnId is derived from stepIdx as a string when present, absent otherwise', () => {
    const withStep = adaptAntigravity(
      { hookEventName: 'PostToolUse', conversationId: 'conv', stepIdx: 7 },
      'PostToolUse',
      {
        now: FROZEN,
      },
    );
    const withoutStep = adaptAntigravity({ hookEventName: 'Stop', conversationId: 'conv' }, 'Stop', { now: FROZEN });
    expect(withStep.turnId).toBe('7');
    expect(withoutStep.turnId).toBeUndefined();
  });

  it('cwd is derived from the first entry of workspacePaths', () => {
    const event = adaptAntigravity(
      { hookEventName: 'PreToolUse', conversationId: 'conv', workspacePaths: ['/repo/a', '/repo/b'] },
      'PreToolUse',
      { now: FROZEN },
    );
    expect(event.cwd).toBe('/repo/a');
  });

  it('payload schema accepts unknown Antigravity extension fields (passthrough)', () => {
    const result = AntigravityHookPayloadSchema.safeParse({
      hookEventName: 'Stop',
      conversationId: 'conv',
      someFutureField: 'x',
    });
    expect(result.success).toBe(true);
  });

  it('payload schema rejects an unknown hookEventName (e.g. SessionStart, which Antigravity has no real event for)', () => {
    const result = AntigravityHookPayloadSchema.safeParse({ hookEventName: 'SessionStart', conversationId: 'conv' });
    expect(result.success).toBe(false);
  });

  it('payload schema requires hookEventName — it is a synthetic field Coodra injects, not something Antigravity ever omits from what it sends onward', () => {
    const result = AntigravityHookPayloadSchema.safeParse({ conversationId: 'conv' });
    expect(result.success).toBe(false);
  });

  it('all 5 real events parse and map to a phase already in the shared eventPhase enum', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['PreToolUse', 'pre'],
      ['PostToolUse', 'post'],
      ['PostInvocation', 'post_invocation'],
      ['Stop', 'turn_end'],
    ];
    for (const [hookEventName, expectedPhase] of cases) {
      const parsed = AntigravityHookPayloadSchema.safeParse({ hookEventName, conversationId: 'conv' });
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const canonicalName = canonicalizeAntigravityEventName(parsed.data);
      const event = adaptAntigravity(parsed.data, canonicalName, { now: FROZEN });
      expect(event.eventPhase).toBe(expectedPhase);
    }
    // PreInvocation is data-dependent — invocationNum absent defaults to
    // the SessionStart synthesis (see canonicalizeAntigravityEventName).
    const preInvocation = AntigravityHookPayloadSchema.safeParse({
      hookEventName: 'PreInvocation',
      conversationId: 'conv',
    });
    expect(preInvocation.success).toBe(true);
    if (!preInvocation.success) return;
    const canonicalName = canonicalizeAntigravityEventName(preInvocation.data);
    expect(canonicalName).toBe('SessionStart');
    expect(adaptAntigravity(preInvocation.data, canonicalName, { now: FROZEN }).eventPhase).toBe('session_start');
  });
});
