import { describe, expect, it } from 'vitest';
import { defaultWorkflowPolicy, parseWorkflowPolicy, renderWorkflowPolicyContext } from '../../src/workflow-policy.js';

describe('workflow policy', () => {
  it('defaults solo mode to push-capable solo workflow with auto-merge allowed', () => {
    const policy = defaultWorkflowPolicy('solo');
    expect(policy.profile).toBe('solo');
    expect(policy.requireBranch).toBe(true);
    expect(policy.requirePush).toBe(true);
    expect(policy.requirePrLink).toBe(false);
    expect(policy.allowAutoMerge).toBe(true);
  });

  it('defaults team mode to PR-required with no auto-merge', () => {
    const policy = defaultWorkflowPolicy('team');
    expect(policy.profile).toBe('team');
    expect(policy.requirePush).toBe(true);
    expect(policy.requirePrLink).toBe(true);
    expect(policy.allowAutoMerge).toBe(false);
  });

  it('renders compact governance text for injection and instruction files', () => {
    const text = renderWorkflowPolicyContext(defaultWorkflowPolicy('team'), {
      projectSlug: 'coodra',
      runId: 'run_123',
    });
    expect(text).toContain('## Coodra Workflow Policy');
    expect(text).toContain('Project slug: `coodra`');
    expect(text).toContain('Run id: `run_123`');
    expect(text).toContain('Team mode: create a branch, push it, open a PR for review, and do not auto-merge.');
    expect(text).toContain('- Link or create a PR before completion: yes');
  });

  it('returns null when disabled', () => {
    const policy = parseWorkflowPolicy({ enabled: false });
    expect(renderWorkflowPolicyContext(policy)).toBeNull();
  });
});
