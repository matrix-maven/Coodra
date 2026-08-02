import { describe, expect, it } from 'vitest';
import { buildCodexNativePermissionsProjection } from '../../src/codex-permissions.js';
import type { PolicyRuleRow, PolicyWithRules } from '../../src/policies.js';

/**
 * Locks Codex's own native `filesystem.":workspace_roots"` glob grammar:
 * a leading-`**\/` (recursive-anywhere) glob only ever validates for
 * `deny` access — Codex's config loader rejects one written with `read`
 * at chat-session start ("filesystem glob path `**\/.git/**` only
 * supports `deny` access"), which hard-blocks every tool call for the
 * whole session. `read` requires either an exact path or a glob with
 * only a trailing `/**` subtree (e.g. `.git/**`).
 */

const NOW = new Date('2026-08-02T00:00:00.000Z');

function rule(overrides: Partial<PolicyRuleRow>): PolicyRuleRow {
  return {
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
    severity: 'medium',
    details: null,
    createdAt: NOW,
    ...overrides,
  };
}

function policy(rules: readonly PolicyRuleRow[]): PolicyWithRules {
  return {
    id: 'policy-1',
    orgId: null,
    projectId: 'project-1',
    name: '__default__',
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

describe('buildCodexNativePermissionsProjection — Codex glob/access grammar', () => {
  it('never emits `read` access for a leading-`**/` glob in the hardcoded .git/node_modules baseline', () => {
    const projection = buildCodexNativePermissionsProjection([]);
    for (const r of projection.filesystemWorkspaceRoots) {
      if (r.path.startsWith('**/')) {
        expect(r.access).toBe('deny');
      }
    }
    // Root-relative trailing-`/**` forms stay `read` — Codex accepts that shape.
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: '.git/**', access: 'read' });
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: 'node_modules/**', access: 'read' });
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: '**/.git/**', access: 'deny' });
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: '**/node_modules/**', access: 'deny' });
  });

  it('downgrades a DB deny-Write rule on a leading-`**/` non-sensitive glob to `deny` instead of `read`', () => {
    const projection = buildCodexNativePermissionsProjection([
      policy([rule({ matchToolName: 'Write', matchPathGlob: '**/vendor/**', decision: 'deny' })]),
    ]);
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: '**/vendor/**', access: 'deny' });
    expect(projection.filesystemWorkspaceRoots).not.toContainEqual({ path: '**/vendor/**', access: 'read' });
  });

  it('keeps `read` for a deny-Write rule on a root-relative trailing-`/**` glob (no leading `**/`)', () => {
    const projection = buildCodexNativePermissionsProjection([
      policy([rule({ matchToolName: 'Edit', matchPathGlob: 'vendor/**', decision: 'deny' })]),
    ]);
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: 'vendor/**', access: 'read' });
  });

  it('still denies a leading-`**/` sensitive-looking glob (unaffected by the read/deny downgrade)', () => {
    const projection = buildCodexNativePermissionsProjection([
      policy([rule({ matchToolName: 'Write', matchPathGlob: '**/*.secret', decision: 'deny' })]),
    ]);
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: '**/*.secret', access: 'deny' });
  });

  it('a read-tool (Grep) deny rule always compiles to `deny`, leading `**/` or not', () => {
    const projection = buildCodexNativePermissionsProjection([
      policy([rule({ matchToolName: 'Grep', matchPathGlob: '**/logs/**', decision: 'deny' })]),
    ]);
    expect(projection.filesystemWorkspaceRoots).toContainEqual({ path: '**/logs/**', access: 'deny' });
  });
});
