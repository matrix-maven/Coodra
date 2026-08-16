import { describe, expect, it } from 'vitest';
import { buildClaudeNativePermissionsProjection } from '../../src/claude-permissions.js';
import type { PolicyRuleRow, PolicyWithRules } from '../../src/policies.js';

/**
 * Locks Claude Code's native `settings.json` `permissions.{allow,ask,deny}`
 * compiler. Unlike Codex's `workspace_roots` engine (see
 * `codex-permissions.test.ts`), Claude's format is three flat lists of
 * `Tool(pattern)` strings — there is no per-glob "access level" grammar
 * that restricts which glob shapes may appear in which list, so a
 * leading-`**\/` pattern is valid in any of allow/ask/deny alike. This
 * suite exists mainly to lock the compiled shape (previously untested)
 * and the path-normalization rules that decide whether a pattern gets
 * anchored with a leading `/`.
 */

const NOW = new Date('2026-08-02T00:00:00.000Z');

// Spreading a `Partial<PolicyRuleRow>` directly into an object
// literal makes every overridable property optional in the
// inferred type, so the literal stops satisfying PolicyRuleRow.
// Building a fully-typed base first and spreading the partial
// over it keeps the result exact.
function rule(overrides: Partial<PolicyRuleRow> = {}): PolicyRuleRow {
  const base: PolicyRuleRow = {
    id: 'rule-1',
    policyId: 'policy-1',
    priority: 10,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: null,
    matchCommandPattern: null,
    matchAgentType: null,
    decision: 'deny',
    reason: 'test',
    controlKey: null,
    ruleType: 'baseline',
    // COOD-34 governance split: enforcement decision is the
    // allow/ask/deny axis, distinct from the governance verdict.
    // NULL means "inherit `decision`" for a pre-split rule.
    enforcementDecision: null,
    // The remaining COOD-34 axes. All NULL here: these fixtures
    // exercise the native-permission projection, which reads the
    // enforcement triad only and is deliberately blind to the
    // governance verdict and capability axes.
    governanceVerdict: null,
    enforcementMode: null,
    requiredCapability: null,
    excludedCapability: null,
    severity: 'medium',
    details: null,
    createdAt: NOW,
  };
  return { ...base, ...overrides };
}

function policy(rules: readonly PolicyRuleRow[]): PolicyWithRules {
  return {
    id: 'policy-1',
    orgId: null,
    projectId: 'project-1',
    name: '__default__',
    // COOD-34: opt-in fail-closed. Default false preserves the
    // documented fail-open contract when the engine is unavailable.
    denyOnPolicyError: false,
    description: null,
    groupKey: 'default',
    profile: 'default',
    enforcementMode: 'enforced',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    rules,
  };
}

describe('buildClaudeNativePermissionsProjection', () => {
  it('compiles a deny-Edit rule on a root-relative glob to Edit(/pattern)', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ matchToolName: 'Edit', matchPathGlob: '.git/**', decision: 'deny' })]),
    ]);
    expect(projection.deny).toContain('Edit(/.git/**)');
  });

  it('compiles a deny-Write rule on a leading-**/ glob to Edit(/**/pattern) — no restriction on this shape', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ matchToolName: 'Write', matchPathGlob: '**/node_modules/**', decision: 'deny' })]),
    ]);
    expect(projection.deny).toContain('Edit(/**/node_modules/**)');
  });

  it('compiles a deny-Read rule to Read(pattern)', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ matchToolName: 'Grep', matchPathGlob: '**/.env', decision: 'deny' })]),
    ]);
    expect(projection.deny).toContain('Read(/**/.env)');
  });

  it('compiles a Bash rule to Bash(commandPattern), ignoring matchPathGlob', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ matchToolName: 'Bash', matchCommandPattern: 'rm -rf*', decision: 'deny' })]),
    ]);
    expect(projection.deny).toContain('Bash(rm -rf*)');
  });

  it('routes decisions into their matching allow/ask/deny bucket', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([
        rule({ id: 'a', matchToolName: 'Read', matchPathGlob: 'README.md', decision: 'allow' }),
        rule({ id: 'b', matchToolName: 'Bash', matchCommandPattern: 'npm test*', decision: 'ask' }),
        rule({ id: 'c', matchToolName: 'Edit', matchPathGlob: '.env', decision: 'deny' }),
      ]),
    ]);
    expect(projection.allow).toContain('Read(/README.md)');
    expect(projection.ask).toContain('Bash(npm test*)');
    expect(projection.deny).toContain('Edit(/.env)');
  });

  it('drops an unsafe wildcard allow-tool rule (bare wildcard, not an mcp__server__ prefix) as untranslated', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ id: 'unsafe', matchToolName: 'Bash*', matchCommandPattern: null, decision: 'allow' })]),
    ]);
    expect(projection.allow).toHaveLength(0);
    expect(projection.untranslatedRuleIds).toContain('unsafe');
  });

  it('keeps a safe mcp__server__* wildcard allow-tool rule', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ id: 'mcp-wild', matchToolName: 'mcp__coodra__*', matchCommandPattern: null, decision: 'allow' })]),
    ]);
    expect(projection.allow).toContain('mcp__coodra__*');
  });

  it('normalizes an already-absolute or ~-relative pattern without adding a second leading slash', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([
        rule({ id: 'abs', matchToolName: 'Edit', matchPathGlob: '/etc/hosts', decision: 'deny' }),
        rule({ id: 'home', matchToolName: 'Edit', matchPathGlob: '~/.ssh/**', decision: 'deny' }),
      ]),
    ]);
    expect(projection.deny).toContain('Edit(/etc/hosts)');
    expect(projection.deny).toContain('Edit(~/.ssh/**)');
  });

  it('excludes rules scoped to a non-Claude agent type from allow/ask/deny (reported as untranslated)', () => {
    const projection = buildClaudeNativePermissionsProjection([
      policy([rule({ id: 'codex-only', matchAgentType: 'codex', matchToolName: 'Edit', matchPathGlob: '.git/**' })]),
    ]);
    expect(projection.deny).toHaveLength(0);
    expect(projection.untranslatedRuleIds).toContain('codex-only');
  });

  it('skips inactive policies entirely', () => {
    const inactive = { ...policy([rule({ matchToolName: 'Edit', matchPathGlob: '.git/**' })]), isActive: false };
    const projection = buildClaudeNativePermissionsProjection([inactive]);
    expect(projection.deny).toHaveLength(0);
  });
});
