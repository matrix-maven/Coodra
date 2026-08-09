import { describe, expect, it } from 'vitest';

import { policyDecisionForStorage, policyGovernanceVerdictForStorage } from '../../src/policy-evaluators.js';

describe('policy evaluator storage mapping', () => {
  it('does not turn advisory UI decisions into runtime asks', () => {
    expect(policyDecisionForStorage('flag')).toBe('allow');
    expect(policyDecisionForStorage('warn')).toBe('allow');
    expect(policyDecisionForStorage('record')).toBe('allow');
  });

  it('maps UI flag to canonical governance verdicts by severity', () => {
    expect(policyGovernanceVerdictForStorage('flag', 'low')).toBe('record');
    expect(policyGovernanceVerdictForStorage('flag', 'medium')).toBe('warn');
  });

  it('keeps runtime asks as confirmations', () => {
    expect(policyDecisionForStorage('ask')).toBe('ask');
    expect(policyGovernanceVerdictForStorage('ask')).toBe('confirm');
  });
});
