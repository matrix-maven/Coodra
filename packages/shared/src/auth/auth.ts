import { timingSafeEqual } from 'node:crypto';

import { verifyToken as clerkVerifyToken } from '@clerk/backend';

import { UnauthorizedError, ValidationError } from '../errors/index.js';
import { createLogger } from '../logger.js';
import type { AuthClient, AuthEnv, Identity } from './types.js';

/**
 * `@coodra/shared/auth` — three-layer auth chain shared by every
 * Coodra HTTP transport (Module 02 mcp-server, Module 03 hooks-
 * bridge, future Module 04 web). The three layers are evaluated in
 * the order locked by `system-architecture.md` §19 and Module 02
 * decisions-log 2026-04-22 Q-02-1:
 *
 *     (1) solo-bypass       — CLERK_SECRET_KEY === 'sk_test_replace_me'
 *     (2) X-Local-Hook      — presented secret matches LOCAL_HOOK_SECRET
 *     (3) Clerk JWT         — @clerk/backend::verifyToken
 *
 * First match wins. No match → `UnauthorizedError` at the HTTP
 * middleware boundary.
 *
 * Module 03 S3 moved this file from `apps/mcp-server/src/lib/auth.ts`.
 * The original location remains as a thin re-export shim. The only
 * surface change is that `AuthEnv` (a structural subset) replaces
 * the app-specific `McpServerEnv` type — every app's env shape is
 * structurally assignable to `AuthEnv`.
 */

const authLogger = createLogger('auth');

const SOLO_BYPASS_CLERK_SENTINEL = 'sk_test_replace_me' as const;

/** Stable solo identity. */
export const SOLO_IDENTITY: Identity = Object.freeze({
  userId: 'user_dev_local',
  orgId: 'org_dev_local',
  source: 'solo-bypass',
} satisfies Identity);

/**
 * Solo-bypass factory — always returns the frozen solo identity. Zero
 * I/O, zero env reads. Warns on construction so a team-mode smoke
 * deploy running with this factory shows up in ops logs every boot.
 */
export function createSoloAuthClient(): AuthClient {
  authLogger.warn(
    { event: 'auth_solo_bypass_in_use', identity: SOLO_IDENTITY },
    'createSoloAuthClient: returning fixed solo identity. ' +
      'Team-mode deployments must use createClerkAuthClient via createAuthClient(env).',
  );

  return {
    async getIdentity() {
      return SOLO_IDENTITY;
    },
    async requireIdentity() {
      return SOLO_IDENTITY;
    },
  };
}

/**
 * Thin factory helper for tests that need an `AuthClient` returning
 * no identity — exercises the `null` branch of `getIdentity` and the
 * throw branch of `requireIdentity`.
 */
export function createAnonymousAuthClient(): AuthClient {
  return {
    async getIdentity() {
      return null;
    },
    async requireIdentity() {
      throw new UnauthorizedError('no identity attached to this tool call');
    },
  };
}

/**
 * Constant-time comparison of a presented `X-Local-Hook-Secret` header
 * value against the configured `LOCAL_HOOK_SECRET` env value. Returns
 * `false` for length mismatches without leaking timing, and for any
 * non-string input (defence-in-depth against header-parser quirks).
 */
export function verifyLocalHookSecret(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a Clerk JWT Bearer token and translate its payload into the
 * Coodra `Identity` shape. Throws `UnauthorizedError` on any
 * failure — malformed token, expired, signed by a different tenant,
 * missing `sub`, etc. Callers at the HTTP middleware boundary
 * translate this into a `401`.
 */
export async function verifyClerkJwt(token: string, env: AuthEnv): Promise<Identity> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new UnauthorizedError('Clerk JWT verification: token is empty');
  }
  if (!env.CLERK_SECRET_KEY || env.CLERK_SECRET_KEY === SOLO_BYPASS_CLERK_SENTINEL) {
    throw new UnauthorizedError(
      'Clerk JWT verification: CLERK_SECRET_KEY is the solo-bypass sentinel; ' +
        'this code path requires a real sk_test_/sk_live_ key',
    );
  }
  if (!env.CLERK_PUBLISHABLE_KEY) {
    throw new UnauthorizedError('Clerk JWT verification: CLERK_PUBLISHABLE_KEY is required alongside CLERK_SECRET_KEY');
  }

  let payload: Awaited<ReturnType<typeof clerkVerifyToken>>;
  try {
    payload = await clerkVerifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    authLogger.warn(
      { event: 'clerk_verify_token_failed', err: message },
      'verifyClerkJwt: @clerk/backend rejected the token',
    );
    throw new UnauthorizedError(`Clerk JWT verification: ${message}`);
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedError('Clerk JWT verification: payload.sub is missing or empty');
  }
  const orgIdRaw = (payload as Record<string, unknown>).org_id;
  const orgId = typeof orgIdRaw === 'string' && orgIdRaw.length > 0 ? orgIdRaw : null;

  return {
    userId: sub,
    orgId,
    source: 'clerk',
  };
}

/**
 * Team-mode factory. On a transport that has no inbound request
 * (e.g. mcp-server stdio), `getIdentity()` returns `null`. HTTP
 * middleware (mcp-server S16, hooks-bridge Module 03 S5) calls
 * `verifyClerkJwt` / `verifyLocalHookSecret` directly above — those
 * helpers are the real wire code, not this factory's methods.
 *
 * `requireIdentity()` throws `UnauthorizedError` — handlers map that
 * to the agent's deny shape.
 */
export function createClerkAuthClient(env: AuthEnv): AuthClient {
  if (!env.CLERK_SECRET_KEY || env.CLERK_SECRET_KEY === SOLO_BYPASS_CLERK_SENTINEL) {
    throw new ValidationError(
      'createClerkAuthClient requires a real CLERK_SECRET_KEY (sk_test_/sk_live_); ' +
        'got the solo-bypass sentinel or an empty value. Use createAuthClient(env) at the dispatch ' +
        'site so solo mode routes to createSoloAuthClient instead.',
    );
  }
  if (!env.CLERK_PUBLISHABLE_KEY) {
    throw new ValidationError('createClerkAuthClient requires CLERK_PUBLISHABLE_KEY alongside CLERK_SECRET_KEY');
  }

  authLogger.info(
    {
      event: 'auth_clerk_wired',
      clerkPublishableKeyPrefix: env.CLERK_PUBLISHABLE_KEY.slice(0, 8),
      clerkJwtIssuer: env.CLERK_JWT_ISSUER ?? null,
    },
    'createClerkAuthClient: team-mode auth wired. ' +
      'Per-request identity flows through verifyClerkJwt / verifyLocalHookSecret at the HTTP boundary.',
  );

  return {
    async getIdentity() {
      return null;
    },
    async requireIdentity() {
      throw new UnauthorizedError(
        'Clerk auth client: no identity attached to this tool call. ' +
          'The HTTP transport populates per-request identity; stdio has no auth context.',
      );
    },
  };
}

/**
 * Top-level factory the application uses. Picks solo-bypass when the
 * sentinel is set or mode is solo; otherwise picks Clerk. `index.ts`
 * calls this once at boot.
 */
export function createAuthClient(env: AuthEnv): AuthClient {
  const isSolo =
    env.COODRA_MODE === 'solo' || !env.CLERK_SECRET_KEY || env.CLERK_SECRET_KEY === SOLO_BYPASS_CLERK_SENTINEL;
  if (isSolo) return createSoloAuthClient();
  return createClerkAuthClient(env);
}
