import { describe, expect, it } from 'vitest';

import { composeTeachingReason, pathFromToolInput } from '../../src/lib/policy-teaching.js';

/**
 * COOD-88 — just-in-time teaching.
 *
 * A third context-delivery model beside push-at-SessionStart and
 * pull-on-demand: guidance arriving at the exact moment of a violation,
 * scoped to it, so it is never stale and costs nothing at session start.
 *
 * The contract:
 *
 *   1. **Silence when there is nothing to teach.** A denial with no
 *      motivating decision keeps exactly its previous behaviour rather
 *      than gaining empty scaffolding that costs bytes and says nothing.
 *   2. **Never truncate mid-word.** A reason cut at "secrets must go
 *      through the local key" reads like a bug and invites the agent to
 *      guess the rest.
 *   3. **Stay inside the byte budget.** Hook reasons are bounded and the
 *      agent pays for every byte.
 */

const DECISION = {
  id: 'dec_abc',
  description: 'Secrets never live in .env',
  rationale: 'They must go through the local keychain so a leaked repo cannot leak credentials.',
};

describe('composeTeachingReason', () => {
  it('returns the base reason untouched when nothing motivates the rule', () => {
    const result = composeTeachingReason('rule_matched', []);
    expect(result.reason).toBe('rule_matched');
    expect(result.taughtDecisionIds).toEqual([]);
  });

  it('attaches the decision id and its substance', () => {
    const result = composeTeachingReason('rule_matched', [DECISION]);
    expect(result.reason).toContain('rule_matched');
    expect(result.reason).toContain('dec_abc');
    expect(result.reason).toContain('Secrets never live in .env');
    expect(result.taughtDecisionIds).toEqual(['dec_abc']);
  });

  it('stays within the hook reason budget', () => {
    const huge = {
      id: 'dec_long',
      description: 'x'.repeat(400),
      rationale: 'y'.repeat(4000),
    };
    const result = composeTeachingReason('rule_matched', [huge, { ...huge, id: 'dec_long2' }]);
    expect(result.reason.length).toBeLessThanOrEqual(600);
  });

  it('summarises at a sentence boundary rather than mid-word', () => {
    const wordy = {
      id: 'dec_w',
      description: 'Short head',
      rationale:
        'First sentence explains the constraint clearly. Second sentence adds a great deal of additional detail that will certainly not fit inside the remaining budget for this particular reason string.',
    };
    const result = composeTeachingReason('rule_matched', [wordy]);
    const tail = result.reason.slice(-3);
    // Either a clean sentence end or an explicit ellipsis — never a
    // severed word with no marker.
    expect(tail.endsWith('.') || tail.endsWith('…')).toBe(true);
  });

  it('declines to teach when the base reason already consumes the budget', () => {
    // Better to keep the original intact than to emit a fragment of a
    // decision that carries no usable meaning.
    const result = composeTeachingReason('z'.repeat(590), [DECISION]);
    expect(result.taughtDecisionIds).toEqual([]);
    expect(result.reason).toBe('z'.repeat(590));
  });
});

describe('pathFromToolInput', () => {
  it('reads the common path keys agents use', () => {
    expect(pathFromToolInput({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(pathFromToolInput({ filePath: 'src/b.ts' })).toBe('src/b.ts');
    expect(pathFromToolInput({ notebook_path: 'nb.ipynb' })).toBe('nb.ipynb');
  });

  it('returns null for inputs with no path, rather than guessing', () => {
    expect(pathFromToolInput({ command: 'ls -la' })).toBeNull();
    expect(pathFromToolInput(null)).toBeNull();
    expect(pathFromToolInput(['a'])).toBeNull();
  });
});
