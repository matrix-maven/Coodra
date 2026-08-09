/**
 * `apps/hooks-bridge/src/lib/capture-base-sha.ts` — thin re-export shim.
 *
 * The implementation moved to `packages/lifecycle/src/capture-base-sha.ts`
 * (COOD-60, 2026-08-09) so both the HTTP Hooks Bridge and the native
 * `lifecycle_event` MCP tool call the same `captureBaseSha`, instead of
 * only the bridge having it — the native SessionStart path never called
 * it, so `runs.base_sha` was never populated for native-plugin sessions
 * and every run-diff landed `error='no_base_sha'`. This shim keeps the
 * bridge's own handler and its unit tests importing from this path
 * unchanged; the DB reads/writes, git subprocess, and idempotent-UPDATE
 * behavior are all identical, just relocated.
 */
export { type CaptureBaseShaInput, type CaptureBaseShaResult, captureBaseSha } from '@coodra/lifecycle';
