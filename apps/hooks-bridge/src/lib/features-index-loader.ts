/**
 * `apps/hooks-bridge/src/lib/features-index-loader.ts` — thin re-export shim.
 *
 * The implementation moved to `packages/lifecycle/src/features-index-loader.ts`
 * (COOD-63, 2026-08-09) so the native `lifecycle_event` SessionStart path
 * injects the Agent Recipes index too — it was bridge-only, and COOD-53
 * had already routed every supported agent away from the bridge. This
 * shim keeps the bridge's own handler and tests importing from here
 * unchanged.
 */
export {
  type LoadedFeaturesIndex,
  type LoadFeaturesIndexOptions,
  loadFeaturesIndexForSession,
} from '@coodra/lifecycle';
