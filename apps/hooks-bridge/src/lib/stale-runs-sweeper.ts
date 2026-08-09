/**
 * `apps/hooks-bridge/src/lib/stale-runs-sweeper.ts` — thin re-export shim.
 *
 * The implementation moved to `packages/lifecycle/src/stale-runs-sweeper.ts`
 * (COOD-62, 2026-08-09). The sweeper needs a long-lived host process; the
 * bridge stopped being one when COOD-53 dropped it from `coodra start`,
 * and nothing replaced it — so abandoned runs stayed `in_progress`
 * forever. The mcp-server daemon now starts it on the HTTP transport.
 * This shim keeps the bridge's own boot path and tests importing from
 * here unchanged.
 */
export {
  type StaleRunsSweeperHandle,
  type StaleRunsSweeperOptions,
  startStaleRunsSweeper,
} from '@coodra/lifecycle';
