/**
 * `apps/mcp-server/src/framework/policy-wrapper.ts` — re-export shim.
 *
 * The policy-evaluation primitives moved to `@coodra/policy` in
 * Module 03 S3 so the same types are shared with `apps/hooks-bridge`.
 * This file stays as a thin re-export so existing internal imports
 * (`import type { PolicyCheck } from '../framework/policy-wrapper.js'`)
 * keep compiling unchanged.
 */
export {
  type PolicyCheck,
  type PolicyDecision,
  PolicyDenyError,
  type PolicyInput,
  type PolicyResult,
} from '@coodra/policy';
