import { verifyToken as clerkVerifyToken } from '@clerk/backend';

import { UnauthorizedError } from '../errors/index.js';
import { createLogger } from '../logger.js';
import { parseClerkRole, type Role } from './roles.js';
import type { AuthEnv } from './types.js';

/**
 * `@coodra/shared/auth/verify-clerk-jwt` — Phase G foundation.
 *
 * Wraps `@clerk/backend::verifyToken` with three pieces of glue every
 * Phase G consumer (CLI, MCP child, hooks-bridge, sync-daemon) needs:
 *
 *   1. Claim extraction — turn the raw JWT payload into a typed
 *      `VerifiedClerkClaims` (userId, orgId, role, email, expiresAt,
 *      issuer). The existing `auth.ts::verifyClerkJwt` returns the
 *      older `Identity` shape used by HTTP middleware; that path
 *      stays. Phase G surfaces want the richer shape.
 *
 *   2. 30s in-memory cache keyed by the literal JWT string. `@clerk/
 *      backend` already caches the JWKS (default 10min TTL), but the
 *      per-token cache here saves re-parsing on rapid-fire tool calls
 *      from the MCP child (~10 ops/min). The cache invalidates on
 *      every `writeToken`/`deleteToken` via `clearVerifyClerkJwtCache`.
 *
 *   3. Hard error on missing org_id — Phase G team-mode invariant is
 *      "every Clerk session is bound to an org". A user not in an org
 *      cannot operate the CLI / web / MCP in team mode. Refusing here
 *      (not silently defaulting to '__solo__' or '') prevents writes
 *      that would otherwise stamp with a phantom org_id.
 *
 * What the existing `auth.ts::verifyClerkJwt` does NOT do that this
 * file does:
 *   - returns `role` (mapped via `parseClerkRole`)
 *   - returns `email` (from JWT payload, requires Clerk JWT template
 *     to include the email claim — phase G login flow guarantees this)
 *   - returns `expiresAt` as a Date so callers don't have to compare
 *     unix-seconds against Date.now() in milliseconds
 *   - caches the verified claims keyed by token (avoids re-verify on
 *     every MCP tool call)
 *   - rejects tokens with no `org_id` (Phase G invariant)
 *
 * The existing `auth.ts::verifyClerkJwt` is preserved untouched —
 * removing it would break the hooks-bridge + mcp-server HTTP
 * middleware that calls it with Bearer tokens from request headers.
 */

const log = createLogger('verify-clerk-jwt');

const CACHE_TTL_MS = 30_000;
const SOLO_BYPASS_CLERK_SENTINEL = 'sk_test_replace_me' as const;

export interface VerifiedClerkClaims {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly email: string | null;
  readonly issuer: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
}

interface CacheEntry {
  readonly claims: VerifiedClerkClaims;
  readonly verifiedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Drop every cached verification. Called by `clerk-token-store` after
 * a `writeToken` / `deleteToken` so a stale claim shape never lingers
 * after the user re-authenticates (or logs out).
 */
export function clearVerifyClerkJwtCache(): void {
  cache.clear();
}

/**
 * Verify a Clerk JWT and return the typed claim shape Phase G surfaces
 * consume. Throws `UnauthorizedError` on any failure — empty token,
 * missing Clerk env, signature mismatch, expired, missing sub/org_id.
 *
 * The cache returns the same `VerifiedClerkClaims` instance for the
 * same `token` for up to 30s OR until `expiresAt` — whichever comes
 * first. After that, a fresh `@clerk/backend::verifyToken` call lands.
 */
export async function verifyClerkJwtAndExtractClaims(
  token: string,
  env: AuthEnv,
): Promise<VerifiedClerkClaims> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new UnauthorizedError('verifyClerkJwtAndExtractClaims: token is empty');
  }

  // Phase G accepts EITHER:
  //   1. CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY (admin machines, web server) —
  //      uses Clerk's machine API for verification.
  //   2. CLERK_PUBLISHABLE_KEY alone (teammate machines, sync daemons) —
  //      uses JWKS-only verification. @clerk/backend's verifyToken derives
  //      the JWKS URL from the token's `iss` claim and validates the
  //      signature against the public key.
  //
  // We reject solo-bypass sentinel + empty / missing publishable key.
  const hasSecret = env.CLERK_SECRET_KEY !== undefined && env.CLERK_SECRET_KEY.length > 0;
  if (hasSecret && env.CLERK_SECRET_KEY === SOLO_BYPASS_CLERK_SENTINEL) {
    throw new UnauthorizedError(
      'verifyClerkJwtAndExtractClaims: CLERK_SECRET_KEY is the solo-bypass sentinel; ' +
        'this code path requires a real sk_test_/sk_live_ key',
    );
  }
  if (env.CLERK_PUBLISHABLE_KEY === undefined || env.CLERK_PUBLISHABLE_KEY.length === 0) {
    throw new UnauthorizedError(
      'verifyClerkJwtAndExtractClaims: CLERK_PUBLISHABLE_KEY is required (used to derive the JWKS issuer).',
    );
  }

  const now = Date.now();
  const cached = cache.get(token);
  if (cached !== undefined && now - cached.verifiedAt < CACHE_TTL_MS && cached.claims.expiresAt.getTime() > now) {
    return cached.claims;
  }

  let payload: Awaited<ReturnType<typeof clerkVerifyToken>>;
  try {
    // When CLERK_SECRET_KEY is set we pass it (full admin verification path).
    // Otherwise we let @clerk/backend derive the JWKS URL from the token's
    // `iss` claim — pure public-key verification.
    payload = hasSecret
      ? await clerkVerifyToken(token, { secretKey: env.CLERK_SECRET_KEY as string })
      : await clerkVerifyToken(token, {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { event: 'clerk_verify_failed', err: message, mode: hasSecret ? 'secret' : 'jwks' },
      'verifyClerkJwtAndExtractClaims: @clerk/backend rejected token',
    );
    throw new UnauthorizedError(`Clerk JWT verification failed: ${message}`);
  }

  const claims = extractClaims(payload, now);
  cache.set(token, { claims, verifiedAt: now });
  return claims;
}

/**
 * Internal — turn a verified payload into the typed `VerifiedClerkClaims`.
 * Pulled out so unit tests can poke at edge cases (missing fields,
 * malformed exp, etc.) without spinning up `@clerk/backend`.
 */
function extractClaims(payload: Record<string, unknown>, nowMs: number): VerifiedClerkClaims {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedError('Clerk JWT: payload.sub is missing or empty');
  }

  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new UnauthorizedError('Clerk JWT: payload.exp is missing or not a finite number');
  }
  const expiresAt = new Date(exp * 1000);
  if (expiresAt.getTime() <= nowMs) {
    throw new UnauthorizedError(
      `Clerk JWT: token expired at ${expiresAt.toISOString()} (now=${new Date(nowMs).toISOString()})`,
    );
  }

  const iat = payload.iat;
  const issuedAt = typeof iat === 'number' && Number.isFinite(iat) ? new Date(iat * 1000) : new Date(0);

  const orgIdRaw = payload.org_id;
  const orgId = typeof orgIdRaw === 'string' && orgIdRaw.length > 0 ? orgIdRaw : '';
  if (orgId.length === 0) {
    throw new UnauthorizedError(
      'Clerk JWT: org_id missing. Team-mode operations require the user to be in a Clerk org. ' +
        'Sign in via /auth/sign-in and select an organization before retrying.',
    );
  }

  const orgRoleRaw = payload.org_role;
  const role: Role = parseClerkRole(typeof orgRoleRaw === 'string' ? orgRoleRaw : null);

  const emailRaw = payload.email;
  const email = typeof emailRaw === 'string' && emailRaw.length > 0 ? emailRaw : null;

  const issuerRaw = payload.iss;
  const issuer = typeof issuerRaw === 'string' ? issuerRaw : '';

  return {
    userId: sub,
    orgId,
    role,
    email,
    issuer,
    expiresAt,
    issuedAt,
  };
}

/**
 * Test-only helper — turn a raw payload object into `VerifiedClerkClaims`
 * without going through `@clerk/backend::verifyToken`. Lets unit tests
 * cover the claim-extraction edge cases (missing sub, malformed exp,
 * empty org_id) without mocking the network round-trip.
 */
export function __extractClaimsForTest(payload: Record<string, unknown>, nowMs: number): VerifiedClerkClaims {
  return extractClaims(payload, nowMs);
}
