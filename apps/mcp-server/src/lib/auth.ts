/**
 * `apps/mcp-server/src/lib/auth.ts` — re-export shim.
 *
 * The implementation moved to `@coodra/shared/auth` in Module 03
 * S3 so `apps/hooks-bridge` can use the same auth chain. The
 * `McpServerEnv` parameter type was generalised to `AuthEnv` (a
 * structural subset); `McpServerEnv` is structurally assignable so
 * existing call sites keep type-checking.
 *
 * New consumers should import directly from `@coodra/shared/auth`.
 */
export {
  createAnonymousAuthClient,
  createAuthClient,
  createClerkAuthClient,
  createSoloAuthClient,
  SOLO_IDENTITY,
  verifyClerkJwt,
  verifyLocalHookSecret,
} from '@coodra/shared/auth';
