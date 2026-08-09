import { describe, expect, it } from 'vitest';

import { evaluateRules } from '../../../src/lib/policy.js';

/**
 * Pure unit tests for the policy rule-match logic in
 * `src/lib/policy.ts::evaluateRules`. These tests do NOT touch the DB,
 * the cache, or the breaker — they pin the rule-matching semantics
 * (event-type, tool-name glob, path glob, agent-type wildcard, priority
 * ordering, first-match-wins, no-match defaulting to allow in the
 * evaluator above).
 *
 * The CompiledRule shape is intentionally a structural type, not an
 * exported class — these tests construct inline minimal records by
 * intersecting a helper that also pre-compiles the path matcher the
 * same way the production code does (via picomatch).
 */

import picomatch from 'picomatch';

// Mirror of CompiledRule in src/lib/policy.ts. Inlining the structural
// shape rather than exporting it from policy.ts because compiling is
// an implementation detail — tests should not depend on it.
type CompiledRule = Parameters<typeof evaluateRules>[0][number];

function rule(overrides: Partial<CompiledRule> & { id: string }): CompiledRule {
  return {
    id: overrides.id,
    policyId: overrides.policyId ?? `policy_${overrides.id}`,
    priority: overrides.priority ?? 100,
    matchEventType: overrides.matchEventType ?? '*',
    matchToolName: overrides.matchToolName ?? '*',
    matchPath: overrides.matchPath !== undefined ? overrides.matchPath : null,
    matchCommand: overrides.matchCommand !== undefined ? overrides.matchCommand : null,
    matchAgentType: overrides.matchAgentType ?? null,
    decision: overrides.decision ?? 'allow',
    enforcementDecision: overrides.enforcementDecision ?? overrides.decision ?? 'allow',
    governanceVerdict: overrides.governanceVerdict ?? 'pass',
    enforcementMode: overrides.enforcementMode ?? 'preventive',
    denyOnPolicyError: overrides.denyOnPolicyError ?? false,
    requiredCapability: overrides.requiredCapability ?? null,
    excludedCapability: overrides.excludedCapability ?? null,
    reason: overrides.reason ?? 'default',
  };
}

function compileGlob(pattern: string) {
  return picomatch(pattern, { dot: false, nobrace: true });
}

describe('evaluateRules — no rules', () => {
  it('returns null when there are no rules (evaluator defaults to allow)', () => {
    expect(evaluateRules([], { phase: 'pre', toolName: 'ping', input: {} })).toBeNull();
  });
});

describe('evaluateRules — event-type axis', () => {
  it('matches a PreToolUse rule on phase=pre', () => {
    const r = rule({ id: 'r1', matchEventType: 'PreToolUse', decision: 'deny', reason: 'blocked' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })?.id).toBe('r1');
  });

  it('skips a PreToolUse rule on phase=post', () => {
    const r = rule({ id: 'r1', matchEventType: 'PreToolUse' });
    expect(evaluateRules([r], { phase: 'post', toolName: 'x', input: {} })).toBeNull();
  });

  it('"*" event-type matches both phases', () => {
    const r = rule({ id: 'r1', matchEventType: '*' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })?.id).toBe('r1');
    expect(evaluateRules([r], { phase: 'post', toolName: 'x', input: {} })?.id).toBe('r1');
  });
});

describe('evaluateRules — tool-name axis', () => {
  it('exact name matches', () => {
    const r = rule({ id: 'r1', matchToolName: 'save_context_pack' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'save_context_pack', input: {} })?.id).toBe('r1');
    expect(evaluateRules([r], { phase: 'pre', toolName: 'get_run_id', input: {} })).toBeNull();
  });

  it('"*" matches every tool', () => {
    const r = rule({ id: 'r1', matchToolName: '*' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'ping', input: {} })?.id).toBe('r1');
    expect(evaluateRules([r], { phase: 'pre', toolName: 'write_file', input: {} })?.id).toBe('r1');
  });

  it('glob matches prefixes', () => {
    const r = rule({ id: 'r1', matchToolName: 'get_*' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'get_run_id', input: {} })?.id).toBe('r1');
    expect(evaluateRules([r], { phase: 'pre', toolName: 'save_run_id', input: {} })).toBeNull();
  });
});

describe('evaluateRules — path-glob axis', () => {
  it('null matchPath means any path matches (including empty input)', () => {
    const r = rule({ id: 'r1', matchPath: null });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })?.id).toBe('r1');
  });

  it('matchPath fails when input has no path candidate', () => {
    const r = rule({ id: 'r1', matchPath: compileGlob('src/**/*.ts') });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })).toBeNull();
  });

  it('matchPath matches on filePath key', () => {
    const r = rule({ id: 'r1', matchPath: compileGlob('src/**/*.ts') });
    expect(
      evaluateRules([r], {
        phase: 'pre',
        toolName: 'x',
        input: { filePath: 'src/lib/auth.ts' },
      })?.id,
    ).toBe('r1');
  });

  it('matchPath reads file_path and path keys too', () => {
    const r = rule({ id: 'r1', matchPath: compileGlob('src/**/*.ts') });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: { file_path: 'src/a.ts' } })?.id).toBe('r1');
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: { path: 'src/a.ts' } })?.id).toBe('r1');
  });

  it('matchPath rejects non-matching paths', () => {
    const r = rule({ id: 'r1', matchPath: compileGlob('src/**/*.ts') });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: { filePath: 'dist/a.js' } })).toBeNull();
  });
});

describe('evaluateRules — agent-type axis', () => {
  it('null agent rule applies to every auto-wrap call', () => {
    const r = rule({ id: 'r1', matchAgentType: null });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })?.id).toBe('r1');
  });

  it('"*" agent rule applies to every auto-wrap call', () => {
    const r = rule({ id: 'r1', matchAgentType: '*' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })?.id).toBe('r1');
  });

  it('rules pinned to a specific agent are skipped by the auto-wrap path', () => {
    // The registry auto-wrap does not carry agentType. Specific-agent rules
    // only match when S14's check_policy threads agentType through input —
    // at which point this test file grows. For S7b the axis must skip.
    const r = rule({ id: 'r1', matchAgentType: 'claude_code' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })).toBeNull();
  });
});

describe('evaluateRules — first-match-wins by priority', () => {
  it('returns the lowest-priority matching rule', () => {
    // evaluateRules assumes callers pre-sort by priority ASC (the DB
    // query does this). We preserve that assumption here.
    const lowerPriorityDeny = rule({ id: 'lo', priority: 10, decision: 'deny', reason: 'lo' });
    const higherPriorityAllow = rule({
      id: 'hi',
      priority: 20,
      decision: 'allow',
      reason: 'hi',
    });
    const result = evaluateRules([lowerPriorityDeny, higherPriorityAllow], {
      phase: 'pre',
      toolName: 'x',
      input: {},
    });
    expect(result?.id).toBe('lo');
    expect(result?.decision).toBe('deny');
  });

  it('skips non-matching rules until the first match', () => {
    const noMatch = rule({
      id: 'skip',
      priority: 5,
      matchToolName: 'save_context_pack',
    });
    const match = rule({ id: 'hit', priority: 10, matchToolName: 'ping', decision: 'allow' });
    const result = evaluateRules([noMatch, match], {
      phase: 'pre',
      toolName: 'ping',
      input: {},
    });
    expect(result?.id).toBe('hit');
  });
});

describe('evaluateRules — capability axis', () => {
  it('skips a rule when its required capability is not active', () => {
    const r = rule({ id: 'deploy-only', requiredCapability: 'deployment' });
    expect(evaluateRules([r], { phase: 'pre', toolName: 'x', input: {} })).toBeNull();
  });

  it('matches a rule when its required capability is active', () => {
    const r = rule({ id: 'deploy-only', requiredCapability: 'deployment' });
    expect(
      evaluateRules([r], {
        phase: 'pre',
        toolName: 'x',
        input: {},
        activeCapabilities: ['deployment'],
      })?.id,
    ).toBe('deploy-only');
  });

  it('skips a rule when its excluded capability is active', () => {
    const r = rule({ id: 'not-dev', excludedCapability: 'dev' });
    expect(
      evaluateRules([r], {
        phase: 'pre',
        toolName: 'x',
        input: {},
        activeCapabilities: ['dev'],
      }),
    ).toBeNull();
  });
});
