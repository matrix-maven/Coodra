import { createLogger } from '@coodra/shared';

import type { PolicyCheck } from '../../src/framework/policy-wrapper.js';
import type {
  AuthClient,
  ContextDeps,
  ContextPackStore,
  DbClient,
  FeaturePackStore,
  Identity,
  PolicyClient,
  RunRecorder,
} from '../../src/framework/tool-context.js';
import { createPolicyClientFromCheck } from '../../src/lib/policy.js';

/**
 * Test-only `ContextDeps` builder.
 *
 * The registry now takes a `ContextDeps` bag rather than a narrow
 * `PolicyCheck`. Rather than spread a dozen null-objects across every
 * test file, this helper builds a sane fake bag, lets callers
 * override any slot they care about, and lets the rest no-op through
 * `NotImplementedError` throws identical to the production stubs.
 *
 * Usage:
 *
 *   const deps = makeFakeDeps({ policyCheck: trackingPolicyCheck });
 *   const registry = new ToolRegistry({ deps });
 *
 * Overrides:
 *   - `policyCheck`:  a `PolicyCheck` callback; wrapped into a
 *                     PolicyClient via `createPolicyClientFromCheck`.
 *   - `policy`:       a pre-built `PolicyClient` (overrides `policyCheck`).
 *   - `auth`:         replace the solo identity with a custom one.
 *   - Any other slot: pass the object directly.
 */
export interface MakeFakeDepsOptions {
  readonly policyCheck?: PolicyCheck;
  readonly policy?: PolicyClient;
  readonly auth?: AuthClient;
  readonly db?: DbClient;
  readonly featurePack?: FeaturePackStore;
  readonly contextPack?: ContextPackStore;
  readonly runRecorder?: RunRecorder;
}

const alwaysAllow: PolicyCheck = async () => ({
  decision: 'allow',
  reason: 'fake-deps: always-allow',
  matchedRuleId: null,
});

const FAKE_IDENTITY: Identity = Object.freeze({
  userId: 'user_test',
  orgId: 'org_test',
  source: 'solo-bypass',
});

function fakeAuth(): AuthClient {
  return {
    async getIdentity() {
      return FAKE_IDENTITY;
    },
    async requireIdentity() {
      return FAKE_IDENTITY;
    },
  };
}

function fakeDb(): DbClient {
  return {
    db: {},
    async close() {
      /* no-op */
    },
  };
}

function notImpl<T>(subsystem: string): T {
  // Proxy that throws on any method invocation. Tests that need real
  // behaviour pass an override; tests that never touch this slot pay
  // zero for its presence.
  return new Proxy({} as object, {
    get(_target, prop) {
      return () => {
        throw new Error(`fake-deps: ${subsystem}.${String(prop)} not stubbed`);
      };
    },
  }) as T;
}

/**
 * No-op `RunRecorder` used by default. The registry's 2026-05-08
 * `mcp_call` audit hook (tool-registry.ts ~L474) fire-and-forgets
 * `runRecorder.record(...)` for every tool call whose input carries a
 * `runId`. The pattern is `void this.deps.runRecorder.record(...).catch(...)`
 * — fine when `record()` returns a rejected promise, but a SYNCHRONOUS
 * throw inside `.record(...)` escapes the `.catch` chain entirely.
 *
 * A `notImpl<RunRecorder>` Proxy throws synchronously, so every tool
 * test that passes a `runId` would crash with `runRecorder.record not
 * stubbed`. The audit hook is irrelevant to the tool-under-test's
 * surface area in these integration suites — a no-op default is the
 * right semantics. Tests that DO care about the audit event can
 * pass `overrides.runRecorder: { record: vi.fn().mockResolvedValue(undefined) }`.
 */
function noopRunRecorder(): RunRecorder {
  return {
    async record() {
      /* no-op — see noopRunRecorder docstring */
    },
  };
}

export function makeFakeDeps(overrides: MakeFakeDepsOptions = {}): ContextDeps {
  const policy = overrides.policy ?? createPolicyClientFromCheck(overrides.policyCheck ?? alwaysAllow);
  return Object.freeze({
    db: overrides.db ?? fakeDb(),
    logger: createLogger('mcp-server.test'),
    auth: overrides.auth ?? fakeAuth(),
    policy,
    featurePack: overrides.featurePack ?? notImpl<FeaturePackStore>('featurePack'),
    contextPack: overrides.contextPack ?? notImpl<ContextPackStore>('contextPack'),
    runRecorder: overrides.runRecorder ?? noopRunRecorder(),
  }) satisfies ContextDeps;
}
