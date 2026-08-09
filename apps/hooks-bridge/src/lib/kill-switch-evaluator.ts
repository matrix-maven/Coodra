/**
 * `apps/hooks-bridge/src/lib/kill-switch-evaluator.ts` — thin re-export shim.
 *
 * The implementation moved to `packages/lifecycle/src/kill-switch-evaluator.ts`
 * (COOD-61, 2026-08-09) so both the HTTP Hooks Bridge and the native
 * `lifecycle_event` MCP tool consult the same evaluator. Before the move
 * it was bridge-only, which meant `coodra pause` was silently
 * non-functional for every native-plugin session — i.e. every currently
 * supported agent, since COOD-53 retired the bridge from the runtime
 * path. This shim keeps the bridge's own handler and its unit tests
 * importing from this path unchanged; cache TTL, fail-open posture, and
 * hard/soft-mode semantics are all identical, just relocated.
 */
export {
  type CreateKillSwitchEvaluatorDeps,
  createKillSwitchEvaluator,
  type KillSwitchEvaluationInput,
  type KillSwitchEvaluator,
  type KillSwitchMatch,
} from '@coodra/lifecycle';
