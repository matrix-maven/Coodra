import { describe, expect, it } from 'vitest';

import {
  buildPolicyDecisionIdempotencyKey,
  createDevNullPolicyClient,
  createPolicyClientFromCheck,
  devNullPolicyCheck,
  PolicyDenyError,
} from '../../src/index.js';

/**
 * Smoke + pure-logic tests for `@coodra/policy`. The cache + breaker
 * + DB-backed evaluator (`createPolicyClient`) is covered by the
 * mcp-server integration test suite (which has the testcontainers-
 * Postgres infra); this file locks the surface that doesn't need a
 * real DB.
 */

describe('buildPolicyDecisionIdempotencyKey', () => {
  it('produces the §4.3 shape `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}` (F14)', () => {
    const key = buildPolicyDecisionIdempotencyKey({
      sessionId: 'sess_abc',
      toolUseId: 'tu_42',
      toolName: 'write_file',
      eventType: 'PreToolUse',
    });
    expect(key).toBe('pd:sess_abc:tu_42:write_file:PreToolUse');
  });

  it('falls back to `no-turn` when toolUseId is omitted (legacy callers)', () => {
    const key = buildPolicyDecisionIdempotencyKey({
      sessionId: 'sess_abc',
      toolName: 'write_file',
      eventType: 'PreToolUse',
    });
    expect(key).toBe('pd:sess_abc:no-turn:write_file:PreToolUse');
  });

  it('distinct toolUseIds in the same session produce distinct keys (audit-trail integrity)', () => {
    const k1 = buildPolicyDecisionIdempotencyKey({
      sessionId: 'sess',
      toolUseId: 'tu-1',
      toolName: 'Write',
      eventType: 'PreToolUse',
    });
    const k2 = buildPolicyDecisionIdempotencyKey({
      sessionId: 'sess',
      toolUseId: 'tu-2',
      toolName: 'Write',
      eventType: 'PreToolUse',
    });
    expect(k1).not.toBe(k2);
  });
});

describe('devNullPolicyCheck', () => {
  it('always returns allow', async () => {
    const result = await devNullPolicyCheck({
      toolName: 'any',
      sessionId: 'any',
      idempotencyKey: { kind: 'readonly', key: 'any' },
      input: {},
      phase: 'pre',
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedRuleId).toBeNull();
  });
});

describe('createDevNullPolicyClient', () => {
  it('exposes the PolicyClient surface and routes to devNullPolicyCheck', async () => {
    const client = createDevNullPolicyClient();
    const result = await client.evaluate({
      toolName: 'whatever',
      phase: 'pre',
      sessionId: 'sess',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('createPolicyClientFromCheck', () => {
  it('rejects non-function arguments at construction', () => {
    expect(() => createPolicyClientFromCheck('not-a-fn' as unknown as never)).toThrow(TypeError);
  });

  it('forwards the PolicyInput contract verbatim, including projectId when supplied', async () => {
    let captured: unknown;
    const client = createPolicyClientFromCheck(async (input) => {
      captured = input;
      return { decision: 'deny', reason: 'test', matchedRuleId: 'rule-1' };
    });
    const result = await client.evaluate({
      toolName: 'write_file',
      phase: 'pre',
      sessionId: 'sess',
      input: { filePath: 'src/a.ts' },
      idempotencyKey: { kind: 'mutating', key: 'k' },
      projectId: 'proj_xyz',
    });
    expect(result).toEqual({ decision: 'deny', reason: 'test', matchedRuleId: 'rule-1' });
    expect(captured).toMatchObject({
      toolName: 'write_file',
      phase: 'pre',
      sessionId: 'sess',
      projectId: 'proj_xyz',
    });
  });

  it('omits projectId from the forwarded input when not supplied (additive-optional contract)', async () => {
    let captured: { projectId?: string } = {};
    const client = createPolicyClientFromCheck(async (input) => {
      captured = input;
      return { decision: 'allow', reason: '', matchedRuleId: null };
    });
    await client.evaluate({
      toolName: 't',
      phase: 'pre',
      sessionId: 's',
      input: {},
      idempotencyKey: { kind: 'readonly', key: 'k' },
    });
    expect('projectId' in captured).toBe(false);
  });
});

describe('PolicyDenyError', () => {
  it('carries toolName, reason, matchedRuleId and a useful message', () => {
    const err = new PolicyDenyError('write_file', 'no writes to src/auth/**', 'rule-7');
    expect(err.name).toBe('PolicyDenyError');
    expect(err.toolName).toBe('write_file');
    expect(err.reason).toBe('no writes to src/auth/**');
    expect(err.matchedRuleId).toBe('rule-7');
    expect(err.message).toContain('write_file');
    expect(err.message).toContain('no writes');
  });
});
