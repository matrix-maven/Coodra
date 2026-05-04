import type { DbHandle } from '@coodra/contextos-db';
import { createPolicyClientFromCheck } from '@coodra/contextos-policy';
import type { HookEvent } from '@coodra/contextos-shared/hooks';
import { describe, expect, it, vi } from 'vitest';

import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';

/**
 * Fail-open paths from spec acceptance #13:
 *   (a) policy evaluator throws → allow + policy_check_unavailable
 *   (b) project slug undefined → still calls policy with no projectId
 *       (the cache hits __global__ slot — verified via the inspectable
 *       PolicyCheck stub we inject)
 *   (c) wrong eventPhase → allow + event_phase_mismatch (defensive)
 */

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agentType: 'claude_code',
    eventPhase: 'pre',
    sessionId: 'sess',
    toolName: 'Write',
    toolInput: { file_path: 'src/x.ts' },
    rawAt: '2026-04-25T12:00:00.000Z',
    ...overrides,
  };
}

const slugResolverNoProject = {
  resolve: vi.fn(async () => ({ slug: undefined, projectId: undefined })),
  // M04 Phase 2 S1 (F3): handlers now call resolveAndEnsure on the
  // audit path. The stub returns the same shape — no auto-ensure
  // happens here because the slug is undefined and the cwd derive
  // path returns undefined for unit tests that don't pass a cwd.
  resolveAndEnsure: vi.fn(async () => ({ slug: undefined, projectId: undefined })),
  invalidate: vi.fn(),
};

// The handler takes a DbHandle but the unit tests don't exercise the
// DB path — they inject a stub PolicyClient that bypasses the real
// evaluator. A bare cast satisfies the type.
const stubDb = {} as DbHandle;

describe('createPreToolUseHandler — fail-open paths', () => {
  it('(a) policy evaluator throws → permissionDecision: allow + reason policy_check_unavailable', async () => {
    const policy = createPolicyClientFromCheck(async () => {
      throw new Error('DB connection lost');
    });
    const handler = createPreToolUseHandler({ policy, projectSlugResolver: slugResolverNoProject, db: stubDb });
    const result = await handler(makeEvent());
    expect(result.permissionDecision).toBe('allow');
    expect(result.permissionDecisionReason).toBe('policy_check_unavailable');
  });

  it('(b) project slug undefined → policy still called with no projectId; allow + matched reason flows through', async () => {
    let captured: { projectId?: string } = {};
    const policy = createPolicyClientFromCheck(async (input) => {
      captured = input;
      return { decision: 'allow', reason: 'no_rule_matched', matchedRuleId: null };
    });
    const handler = createPreToolUseHandler({ policy, projectSlugResolver: slugResolverNoProject, db: stubDb });
    const result = await handler(makeEvent({ cwd: '/tmp/no-contextos-json' }));
    expect(result.permissionDecision).toBe('allow');
    expect('projectId' in captured).toBe(false);
  });

  it('(c) handler called with wrong eventPhase → defensive allow + reason event_phase_mismatch', async () => {
    const policy = createPolicyClientFromCheck(async () => ({
      decision: 'deny',
      reason: 'should not be called',
      matchedRuleId: 'should-not-fire',
    }));
    const handler = createPreToolUseHandler({ policy, projectSlugResolver: slugResolverNoProject, db: stubDb });
    const result = await handler(makeEvent({ eventPhase: 'post' }));
    expect(result.permissionDecision).toBe('allow');
    expect(result.permissionDecisionReason).toBe('event_phase_mismatch');
  });

  it('happy path: deny rule matches → permissionDecision propagated as-is with rule reason', async () => {
    const policy = createPolicyClientFromCheck(async () => ({
      decision: 'deny',
      reason: 'no writes to src/auth/**',
      matchedRuleId: 'rule-7',
    }));
    const handler = createPreToolUseHandler({ policy, projectSlugResolver: slugResolverNoProject, db: stubDb });
    const result = await handler(makeEvent({ toolInput: { file_path: 'src/auth/index.ts' } }));
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toBe('no writes to src/auth/**');
  });
});
