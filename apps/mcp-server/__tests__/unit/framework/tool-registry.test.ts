import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { IdempotencyKeyBuilder } from '../../../src/framework/idempotency.js';
import type { PolicyCheck } from '../../../src/framework/policy-wrapper.js';
import type { ToolContext } from '../../../src/framework/tool-context.js';
import { MIN_DESCRIPTION_LENGTH, type ToolRegistration, ToolRegistry } from '../../../src/framework/tool-registry.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * `ToolRegistry` enforces its contract synchronously at registration
 * time. This suite locks every one of those invariants as an
 * individual negative test — a CI failure names exactly which rule
 * broke, and a future refactor that loosens the contract is caught
 * test-by-test rather than behind a single catch-all.
 *
 * Invariants covered (must stay in lock-step with the registry's
 * `assertValid`):
 *   1. Name shape matches ^[a-z][a-z0-9_]{2,63}$.
 *   2. Duplicate names are rejected.
 *   3. Description length ≥ MIN_DESCRIPTION_LENGTH (200).
 *   4. inputSchema must be a z.object.
 *   5. outputSchema is required.
 *   6. Handler arity is exactly 2.
 *   7. idempotencyKey builder must return a valid key (exercised
 *      via assertIdempotencyKeyBuilder).
 *
 * Plus three happy-path tests:
 *   A. A valid registration succeeds and appears in .list().
 *   B. handleCall routes through the policy wrapper (pre + post).
 *   C. handleCall returns a structured refusal on input-validation failure.
 */

const DESC = 'x'.repeat(MIN_DESCRIPTION_LENGTH);

const okIdempotency: IdempotencyKeyBuilder<{ a: string }> = (input, ctx) => ({
  kind: 'readonly',
  key: `readonly:test:${ctx.sessionId}:${input.a ?? ''}`.slice(0, 200),
});

function makeValidReg(
  overrides: Partial<ToolRegistration<z.ZodObject<{ a: z.ZodString }>, z.ZodObject<{ b: z.ZodString }>>> = {},
): ToolRegistration<z.ZodObject<{ a: z.ZodString }>, z.ZodObject<{ b: z.ZodString }>> {
  const inputSchema = z.object({ a: z.string() });
  const outputSchema = z.object({ b: z.string() });
  const base: ToolRegistration<typeof inputSchema, typeof outputSchema> = {
    name: 'valid_tool',
    description: DESC,
    inputSchema,
    outputSchema,
    idempotencyKey: okIdempotency as unknown as IdempotencyKeyBuilder<z.infer<typeof inputSchema>>,
    handler: async (input, _ctx) => ({ b: `echo:${input.a}` }),
  };
  return { ...base, ...overrides } as typeof base;
}

function freshRegistry(policyCheck?: PolicyCheck) {
  return new ToolRegistry({ deps: makeFakeDeps(policyCheck ? { policyCheck } : {}) });
}

describe('ToolRegistry — construction contract', () => {
  it('throws when constructed without an options object', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => new ToolRegistry(undefined as unknown as any)).toThrow(/options object/);
  });

  it('throws when options.deps is missing', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => new ToolRegistry({ deps: undefined } as any)).toThrow(/ContextDeps/);
  });

  it('throws when options.deps.policy is not a PolicyClient', () => {
    const deps = makeFakeDeps();
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    const broken = { ...deps, policy: {} as any };
    expect(() => new ToolRegistry({ deps: broken })).toThrow(/PolicyClient/);
  });
});

describe('ToolRegistry — register-time enforcement (negative cases)', () => {
  it('1. rejects a name that does not match the MCP shape', () => {
    const registry = freshRegistry();
    expect(() => registry.register(makeValidReg({ name: 'Invalid_Name' }))).toThrow(/invalid tool name/);
    expect(() => registry.register(makeValidReg({ name: 'a' }))).toThrow(/invalid tool name/);
    expect(() => registry.register(makeValidReg({ name: '9_starts_with_digit' }))).toThrow(/invalid tool name/);
    expect(() => registry.register(makeValidReg({ name: 'has-hyphen' }))).toThrow(/invalid tool name/);
  });

  it('2. rejects duplicate registrations', () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'dup_tool' }));
    expect(() => registry.register(makeValidReg({ name: 'dup_tool' }))).toThrow(/already registered/);
  });

  it('3. rejects descriptions shorter than the minimum', () => {
    const registry = freshRegistry();
    expect(() => registry.register(makeValidReg({ description: 'too short' }))).toThrow(
      new RegExp(`at least ${MIN_DESCRIPTION_LENGTH} characters`),
    );
    // boundary: exactly 199 chars fails
    expect(() => registry.register(makeValidReg({ description: 'x'.repeat(MIN_DESCRIPTION_LENGTH - 1) }))).toThrow(
      new RegExp(`at least ${MIN_DESCRIPTION_LENGTH} characters`),
    );
  });

  it('4. rejects an inputSchema that is not a z.object', () => {
    const registry = freshRegistry();
    const bad = makeValidReg();
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    const broken = { ...bad, inputSchema: z.string() as unknown as any };
    expect(() => registry.register(broken)).toThrow(/inputSchema must be a z\.object/);
  });

  it('5. rejects a registration missing outputSchema', () => {
    const registry = freshRegistry();
    const bad = makeValidReg();
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    const broken = { ...bad, outputSchema: undefined as unknown as any };
    expect(() => registry.register(broken)).toThrow(/outputSchema is required/);
  });

  it('6. rejects a handler whose arity is not exactly 2', () => {
    const registry = freshRegistry();
    const bad = makeValidReg();
    const arityZero = { ...bad, handler: (async () => ({ b: 'x' })) as unknown as typeof bad.handler };
    const arityOne = { ...bad, handler: (async (_i: unknown) => ({ b: 'x' })) as unknown as typeof bad.handler };
    expect(() => registry.register(arityZero)).toThrow(/handler must take exactly 2 args/);
    expect(() => registry.register(arityOne)).toThrow(/handler must take exactly 2 args/);
  });

  it('7. rejects a broken idempotency-key builder (wrong return shape)', () => {
    const registry = freshRegistry();
    const bad = makeValidReg({
      // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
      idempotencyKey: ((_i: unknown, _c: unknown) => 'not-an-object') as unknown as any,
    });
    expect(() => registry.register(bad)).toThrow(/invalid key/);
  });

  it('7b. rejects an idempotency builder returning an empty key', () => {
    const registry = freshRegistry();
    const bad = makeValidReg({
      // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
      idempotencyKey: ((_i: unknown, _c: unknown) => ({ kind: 'readonly', key: '' })) as unknown as any,
    });
    expect(() => registry.register(bad)).toThrow(/invalid key/);
  });
});

describe('ToolRegistry — back-compat aliases (Features→Skills rename, Phase 5)', () => {
  it('an alias routes handleCall to the canonical handler', async () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'list_skills' }));
    registry.registerAlias('list_features', 'list_skills');
    const result = await registry.handleCall('list_features', { a: 'hi' }, 'sess_alias');
    expect(result.isError).toBeUndefined();
    // Canonical handler ran (echo:hi) even though we called the old name.
    expect(result.content[0]?.text).toContain('echo:hi');
  });

  it('an alias is NOT advertised in list() — tools/list shows only the canonical name', () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'get_skill' }));
    registry.registerAlias('get_feature', 'get_skill');
    const names = registry.list().map((t) => t.name);
    expect(names).toContain('get_skill');
    expect(names).not.toContain('get_feature');
    // size() counts real tools only — the alias does not inflate the count.
    expect(registry.size()).toBe(1);
  });

  it('has() is true for both the canonical name and its alias', () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'get_skill_file' }));
    registry.registerAlias('get_feature_file', 'get_skill_file');
    expect(registry.has('get_skill_file')).toBe(true);
    expect(registry.has('get_feature_file')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });

  it('refuses an alias to an unregistered canonical, a colliding alias, and a malformed alias name', () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'list_skills' }));
    expect(() => registry.registerAlias('list_features', 'does_not_exist')).toThrow(/is not registered/);
    expect(() => registry.registerAlias('list_skills', 'list_skills')).toThrow(/collides/);
    expect(() => registry.registerAlias('Bad-Alias', 'list_skills')).toThrow(/tool-name shape/);
  });
});

describe('ToolRegistry — happy path', () => {
  it('A. a valid registration appears in list(), sorted by name', () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'zeta_tool' }));
    registry.register(makeValidReg({ name: 'alpha_tool' }));
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe('alpha_tool');
    expect(list[1]?.name).toBe('zeta_tool');
    expect(list[0]?.description).toHaveLength(MIN_DESCRIPTION_LENGTH);
    expect(list[0]?.inputSchema.type).toBe('object');
  });

  it('B. handleCall runs pre and post policy checks around the handler', async () => {
    const policyCalls: Array<{ phase: 'pre' | 'post'; toolName: string }> = [];
    const trackingPolicy: PolicyCheck = async (req) => {
      policyCalls.push({ phase: req.phase, toolName: req.toolName });
      return { decision: 'allow', reason: 'test', matchedRuleId: null };
    };
    const registry = freshRegistry(trackingPolicy);
    registry.register(makeValidReg({ name: 'traced_tool' }));
    const result = await registry.handleCall('traced_tool', { a: 'hi' }, 'sess_1');
    expect(result.isError).toBeUndefined();
    // Post-phase is fired and awaited inside the registry via a catch
    // side channel; give the microtask queue a turn so the post call
    // lands before we assert.
    await new Promise((r) => setImmediate(r));
    const phases = policyCalls.map((c) => c.phase);
    expect(phases).toContain('pre');
    expect(phases).toContain('post');
  });

  it('B2. handlers cannot opt out of the policy wrapper — a deny blocks the handler', async () => {
    const denyPolicy: PolicyCheck = async () => ({
      decision: 'deny',
      reason: 'test_deny',
      matchedRuleId: 'rule_test_1',
    });
    const handlerSpy = vi.fn(async (_i: unknown, _c: unknown) => ({ b: 'should-not-appear' }));
    const registry = freshRegistry(denyPolicy);
    registry.register(
      makeValidReg({
        name: 'denied_tool',
        handler: handlerSpy as unknown as ToolRegistration<
          z.ZodObject<{ a: z.ZodString }>,
          z.ZodObject<{ b: z.ZodString }>
        >['handler'],
      }),
    );
    const result = await registry.handleCall('denied_tool', { a: 'hi' }, 'sess_1');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/policy_denied/);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('C. handleCall returns a structured refusal on invalid input', async () => {
    const registry = freshRegistry();
    registry.register(makeValidReg({ name: 'input_validated_tool' }));
    const result = await registry.handleCall('input_validated_tool', { a: 123 }, 'sess_1');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/invalid_input/);
  });

  it('C2. handleCall returns tool_not_found for unknown tools', async () => {
    const registry = freshRegistry();
    const result = await registry.handleCall('nope', {}, 'sess_1');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/tool_not_found/);
  });

  it('D. injected clock drives ctx.now() — handler sees the frozen time', async () => {
    const frozen = new Date('2026-04-23T12:34:56.000Z');
    const deps = makeFakeDeps();
    const registry = new ToolRegistry({ deps, clock: () => new Date(frozen) });
    const observed: Array<string> = [];
    registry.register(
      makeValidReg({
        name: 'clock_tool',
        handler: (async (_input: { a: string }, ctx: ToolContext) => {
          observed.push(ctx.now().toISOString());
          return { b: 'ok' };
        }) as unknown as ToolRegistration<z.ZodObject<{ a: z.ZodString }>, z.ZodObject<{ b: z.ZodString }>>['handler'],
      }),
    );
    await registry.handleCall('clock_tool', { a: 'x' }, 'sess_1');
    expect(observed).toEqual([frozen.toISOString()]);
  });

  it('E. ctx.requestId is populated and stable per call', async () => {
    const deps = makeFakeDeps();
    const registry = new ToolRegistry({
      deps,
      mintRequestId: () => 'req_fixed_42',
    });
    let seen: string | null = null;
    registry.register(
      makeValidReg({
        name: 'reqid_tool',
        handler: (async (_input: { a: string }, ctx: ToolContext) => {
          seen = ctx.requestId;
          return { b: 'ok' };
        }) as unknown as ToolRegistration<z.ZodObject<{ a: z.ZodString }>, z.ZodObject<{ b: z.ZodString }>>['handler'],
      }),
    );
    await registry.handleCall('reqid_tool', { a: 'x' }, 'sess_1');
    expect(seen).toBe('req_fixed_42');
  });
});
