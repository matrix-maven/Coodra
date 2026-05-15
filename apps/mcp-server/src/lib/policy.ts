/**
 * `apps/mcp-server/src/lib/policy.ts` — re-export shim.
 *
 * The implementation moved to `@coodra/policy` in Module 03 S3 so
 * `apps/hooks-bridge` can use the same evaluator without depending on
 * `apps/mcp-server`. This file stays as a thin re-export so existing
 * consumers (`tools/check-policy/handler.ts`, the framework wiring,
 * test files) keep working unchanged.
 *
 * New consumers should import directly from `@coodra/policy`.
 */
export {
  buildPolicyDecisionIdempotencyKey,
  type CreatePolicyClientOptions,
  createDevNullPolicyClient,
  createPolicyClient,
  createPolicyClientFromCheck,
  devNullPolicyCheck,
  evaluateRules,
  type RecordPolicyDecisionArgs,
  recordPolicyDecision,
} from '@coodra/policy';
