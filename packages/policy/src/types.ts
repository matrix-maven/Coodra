import type { IdempotencyKey } from '@coodra/shared/idempotency';

/**
 * `@coodra/policy/types` — policy-evaluation primitives shared by
 * the registry, the `PolicyClient` interface, and every consumer that
 * wraps / implements a policy check.
 *
 * `system-architecture.md` §5 + §16 pattern 1 say the Policy Engine is
 * evaluated at every tool call — both PreToolUse and PostToolUse. The
 * MCP server's registry and the Hooks Bridge's pre-tool handler both
 * depend on this shape; extracting it into a workspace package means
 * neither owns it.
 *
 * Module 03 S3 moved this file from `apps/mcp-server/src/framework/
 * policy-wrapper.ts` here. The original path remains as a 1-line
 * re-export for the duration of one slice; consumers that previously
 * imported from `framework/policy-wrapper.js` keep compiling.
 */

export type PolicyDecision = 'allow' | 'deny';

export interface PolicyInput {
  readonly toolName: string;
  readonly sessionId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** The validated tool input, available so policies can match on shape. */
  readonly input: unknown;
  /** `'pre'` or `'post'` — mirrors the Claude Code hook phase. */
  readonly phase: 'pre' | 'post';
  /**
   * Project scope for the evaluation, if known. Additive-optional slot
   * (Module 02 S14 sign-off 2026-04-24). Auto-wrap callers that omit
   * this field hit the `__global__` cache slot with every-project
   * rules loaded; `check_policy` and the Module 03 hooks-bridge pre-
   * tool handler supply the real value, keying the cache per project.
   */
  readonly projectId?: string;
}

export interface PolicyResult {
  readonly decision: PolicyDecision;
  readonly reason: string;
  readonly matchedRuleId: string | null;
}

/**
 * Abstraction the registry / hooks-bridge calls before and after every
 * handler invocation. Production wires the cache-backed evaluator from
 * `policy.ts`; tests inject a stub via `createPolicyClientFromCheck`.
 */
export type PolicyCheck = (req: PolicyInput) => Promise<PolicyResult>;

/**
 * Policy evaluation, as consumed by tool handlers after the registry-
 * level wrapper. Identical shape to `PolicyCheck` but expressed as a
 * one-method interface so DI sites can swap implementations cleanly.
 */
export interface PolicyClient {
  evaluate(input: {
    readonly toolName: string;
    readonly phase: 'pre' | 'post';
    readonly sessionId: string;
    readonly input: unknown;
    readonly idempotencyKey: IdempotencyKey;
    readonly projectId?: string;
  }): Promise<{ decision: PolicyDecision; reason: string; matchedRuleId: string | null }>;
}

/**
 * Error thrown when the policy engine denies a call. The MCP server's
 * registry translates this into the tool-error envelope so clients see
 * a structured refusal rather than a silent success + empty body.
 * Hooks-bridge translates it into the agent's native deny shape
 * (Claude Code hookSpecificOutput / Windsurf+Cursor decision JSON).
 */
export class PolicyDenyError extends Error {
  public readonly toolName: string;
  public readonly reason: string;
  public readonly matchedRuleId: string | null;
  constructor(toolName: string, reason: string, matchedRuleId: string | null) {
    super(`policy denied '${toolName}': ${reason}`);
    this.name = 'PolicyDenyError';
    this.toolName = toolName;
    this.reason = reason;
    this.matchedRuleId = matchedRuleId;
  }
}
