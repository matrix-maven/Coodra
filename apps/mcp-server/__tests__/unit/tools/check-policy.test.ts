import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createCheckPolicyToolRegistration } from '../../../src/tools/check-policy/manifest.js';
import { checkPolicyInputSchema, checkPolicyOutputSchema } from '../../../src/tools/check-policy/schema.js';

/**
 * Unit tests for `coodra__check_policy` — manifest contract +
 * input schema boundaries + idempotency-key shape + reason-enum +
 * failOpen-derivation + `'ask'`-never-at-M02 schema lock. DB +
 * evaluator behaviour (fail-open paths, audit dedupe, per-projectId
 * cache isolation, async audit ordering) are in the integration suite.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('check_policy — manifest contract', () => {
  it('satisfies every §24.3 rule via assertManifestDescriptionValid', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'check-policy' })).not.toThrow();
  });

  it('name is exactly "check_policy"', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    expect(reg.name).toBe('check_policy');
  });
});

describe('check_policy — idempotency-key shape', () => {
  it('is mutating + matches DB audit key (pd:{sessionId}:{toolUseId}:{toolName}:{eventType}) — F14 (2026-04-27)', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 'sess_abc',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x' },
        toolUseId: 'tu_42',
      },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(key.kind).toBe('mutating');
    expect(key.key).toBe('pd:sess_abc:tu_42:Write:PreToolUse');
  });

  it('legacy callers (no toolUseId) fall back to "no-turn" segment', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 'sess_abc',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x' },
      },
      { sessionId: 'sess_abc', receivedAt: new Date(0) },
    );
    expect(key.key).toBe('pd:sess_abc:no-turn:Write:PreToolUse');
  });

  it('retry with same (sessionId, toolUseId, toolName, eventType) tuple produces identical key', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { a: 1 },
        toolUseId: 'tu_x',
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const b = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { a: 2 }, // different toolInput — does NOT change key
        toolUseId: 'tu_x',
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(a.key).toBe(b.key);
  });

  it('distinct toolUseIds in the same session yield distinct keys (F14 audit-trail integrity)', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    const a = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/a.ts' },
        toolUseId: 'tu_1',
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const b = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/b.ts' },
        toolUseId: 'tu_2',
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(a.key).not.toBe(b.key);
  });

  it('different eventType yields distinct key (Pre vs Post)', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    const pre = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    const post = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PostToolUse',
        toolName: 'Write',
        toolInput: {},
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(pre.key).not.toBe(post.key);
  });

  it('truncates to 200 chars', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    const key = reg.idempotencyKey(
      {
        projectSlug: 'p',
        sessionId: 's'.repeat(256),
        agentType: 'a',
        eventType: 'PreToolUse',
        toolName: 't'.repeat(256),
        toolInput: {},
      },
      { sessionId: 's', receivedAt: new Date(0) },
    );
    expect(key.key.length).toBeLessThanOrEqual(200);
  });

  it('survives probe-style empty input without throwing', () => {
    const reg = createCheckPolicyToolRegistration({ db: fakeDb });
    // biome-ignore lint/suspicious/noExplicitAny: probe sweep sends minimal shapes
    const key = reg.idempotencyKey({} as any, { sessionId: 'sess', receivedAt: new Date(0) });
    expect(key.kind).toBe('mutating');
    // F14 (2026-04-27): toolUseId segment lands as 'no-turn' for empty input.
    expect(key.key).toBe('pd:probe:no-turn:probe:probe');
  });
});

describe('check_policy — input schema boundaries', () => {
  it('accepts a minimal valid payload', () => {
    expect(
      checkPolicyInputSchema.safeParse({
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x' },
      }).success,
    ).toBe(true);
  });

  it('accepts PostToolUse', () => {
    expect(
      checkPolicyInputSchema.safeParse({
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PostToolUse',
        toolName: 'Write',
        toolInput: {},
      }).success,
    ).toBe(true);
  });

  it('rejects unknown eventType', () => {
    expect(
      checkPolicyInputSchema.safeParse({
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'Unknown',
        toolName: 'Write',
        toolInput: {},
      }).success,
    ).toBe(false);
  });

  it('rejects empty projectSlug/sessionId/agentType/toolName', () => {
    for (const field of ['projectSlug', 'sessionId', 'agentType', 'toolName'] as const) {
      const payload: Record<string, unknown> = {
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
      };
      payload[field] = '';
      expect(checkPolicyInputSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('rejects non-object toolInput (string, array, number)', () => {
    for (const toolInput of ['string', 123, ['array'], null] as unknown[]) {
      expect(
        checkPolicyInputSchema.safeParse({
          projectSlug: 'p',
          sessionId: 's',
          agentType: 'claude_code',
          eventType: 'PreToolUse',
          toolName: 'Write',
          toolInput,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts optional runId', () => {
    expect(
      checkPolicyInputSchema.safeParse({
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
        runId: 'run_123',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(
      checkPolicyInputSchema.safeParse({
        projectSlug: 'p',
        sessionId: 's',
        agentType: 'claude_code',
        eventType: 'PreToolUse',
        toolName: 'Write',
        toolInput: {},
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("check_policy — output schema: 'ask' is a real emitted tier (F6, 2026-07-04)", () => {
  it("schema permits 'ask' as a permissionDecision (emitted by a matched rule with decision='ask', e.g. the seeded 'ask before Bash' rule)", () => {
    const parsed = checkPolicyOutputSchema.safeParse({
      ok: true,
      permissionDecision: 'ask',
      reason: 'rule_matched',
      ruleReason: 'hypothetical higher-layer rule',
      matchedRuleId: 'r_1',
      failOpen: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('schema rejects an unknown reason string', () => {
    const parsed = checkPolicyOutputSchema.safeParse({
      ok: true,
      permissionDecision: 'allow',
      reason: 'custom_reason',
      ruleReason: null,
      matchedRuleId: null,
      failOpen: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('schema requires failOpen to be boolean (not optional)', () => {
    const parsed = checkPolicyOutputSchema.safeParse({
      ok: true,
      permissionDecision: 'allow',
      reason: 'no_rule_matched',
      ruleReason: null,
      matchedRuleId: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('check_policy — factory construction contract', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createCheckPolicyToolRegistration(undefined as unknown as any)).toThrow(TypeError);
  });

  it('rejects non-DbHandle db', () => {
    // biome-ignore lint/suspicious/noExplicitAny: negative test
    expect(() => createCheckPolicyToolRegistration({ db: {} as any })).toThrow(/db must be a DbHandle/);
  });
});
