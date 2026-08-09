/**
 * `apps/hooks-bridge/src/lib/abandon-stale-runs.ts` — thin re-export shim.
 *
 * The implementation moved to `packages/lifecycle/src/abandon-stale-runs.ts`
 * (COOD-62, 2026-08-09) so the native `lifecycle_event` SessionStart path
 * gets the same per-session cleanup the bridge always had. This shim keeps
 * the bridge's own handler and tests importing from here unchanged.
 */
export {
  type AbandonStaleInProgressRunsInput,
  type AbandonStaleInProgressRunsResult,
  abandonStaleInProgressRuns,
} from '@coodra/lifecycle';
