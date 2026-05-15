import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthEnv } from '../../../src/auth/types.js';
import { UnauthorizedError, ValidationError } from '../../../src/errors/index.js';

/**
 * Unit tests for `packages/shared/src/auth/auth.ts` — the per-chain
 * pieces:
 *   - `createAuthClient(env)`     → dispatcher
 *   - `verifyLocalHookSecret(...)` → constant-time compare
 *   - `verifyClerkJwt(token, env)` → @clerk/backend::verifyToken adapter
 *
 * `@clerk/backend::verifyToken` is hoist-mocked. The mock resolves
 * inside this package's own vitest run, so the import the auth source
 * does (`import { verifyToken as clerkVerifyToken } from '@clerk/backend'`)
 * is intercepted. Live Clerk validation is a Module 04 precondition
 * (see `context_memory/pending-user-actions.md`).
 *
 * Module 03 S3 moved this test from `apps/mcp-server/__tests__/unit/
 * lib/auth-chain.test.ts` so it lives next to the implementation.
 * The only substantive change is replacing `McpServerEnv` (which is
 * a superset of what the auth helpers need) with `AuthEnv` — the
 * structural subset that lives in shared.
 */

const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock('@clerk/backend', () => ({
  verifyToken: mockVerifyToken,
}));

// Import AFTER the mock so auth.ts binds to the hoisted mock.
const {
  createAnonymousAuthClient,
  createAuthClient,
  createClerkAuthClient,
  createSoloAuthClient,
  SOLO_IDENTITY,
  verifyClerkJwt,
  verifyLocalHookSecret,
} = await import('../../../src/auth/auth.js');

function baseEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createAuthClient(env) dispatcher
// ---------------------------------------------------------------------------

describe('createAuthClient(env) — mode dispatch', () => {
  it('returns a solo client when COODRA_MODE=solo', async () => {
    const auth = createAuthClient(baseEnv());
    await expect(auth.getIdentity()).resolves.toEqual(SOLO_IDENTITY);
  });

  it('returns a solo client when CLERK_SECRET_KEY is the solo-bypass sentinel', async () => {
    const auth = createAuthClient(
      baseEnv({
        COODRA_MODE: 'team',
        CLERK_SECRET_KEY: 'sk_test_replace_me',
        CLERK_PUBLISHABLE_KEY: 'pk_test_xxx',
      }),
    );
    await expect(auth.getIdentity()).resolves.toEqual(SOLO_IDENTITY);
  });

  it('returns a Clerk client when team mode has real Clerk keys', async () => {
    const auth = createAuthClient(
      baseEnv({
        COODRA_MODE: 'team',
        CLERK_SECRET_KEY: 'sk_test_real_key',
        CLERK_PUBLISHABLE_KEY: 'pk_test_real_key',
      }),
    );
    // `getIdentity()` is null on stdio (no request context) — locks the
    // S7b user directive Q1 answer (option a: null-on-stdio + helpers).
    await expect(auth.getIdentity()).resolves.toBeNull();
    await expect(auth.requireIdentity()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('createClerkAuthClient — construction contract', () => {
  it('throws ValidationError when secret key is the solo-bypass sentinel', () => {
    expect(() =>
      createClerkAuthClient(
        baseEnv({
          CLERK_SECRET_KEY: 'sk_test_replace_me',
          CLERK_PUBLISHABLE_KEY: 'pk_test_x',
        }),
      ),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when publishable key is missing', () => {
    expect(() =>
      createClerkAuthClient(
        baseEnv({
          CLERK_SECRET_KEY: 'sk_test_real',
        }),
      ),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// verifyLocalHookSecret — timing-safe compare
// ---------------------------------------------------------------------------

describe('verifyLocalHookSecret', () => {
  const configured = 'local-hook-secret-that-is-long-enough';

  it('returns true for exact match', () => {
    expect(verifyLocalHookSecret(configured, configured)).toBe(true);
  });

  it('returns false for length mismatch (without throwing)', () => {
    expect(verifyLocalHookSecret('short', configured)).toBe(false);
    expect(verifyLocalHookSecret(`${configured}X`, configured)).toBe(false);
  });

  it('returns false for same-length but different contents', () => {
    const attacker = 'A'.repeat(configured.length);
    expect(verifyLocalHookSecret(attacker, configured)).toBe(false);
  });

  it('returns false for non-string inputs (defence-in-depth)', () => {
    expect(verifyLocalHookSecret(undefined, configured)).toBe(false);
    expect(verifyLocalHookSecret(123 as unknown, configured)).toBe(false);
    expect(verifyLocalHookSecret(configured, undefined as unknown as string)).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(verifyLocalHookSecret('', '')).toBe(false);
    expect(verifyLocalHookSecret('', configured)).toBe(false);
    expect(verifyLocalHookSecret(configured, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyClerkJwt — @clerk/backend adapter (mocked SDK)
// ---------------------------------------------------------------------------

describe('verifyClerkJwt', () => {
  beforeEach(() => {
    mockVerifyToken.mockReset();
  });
  afterEach(() => {
    mockVerifyToken.mockReset();
  });

  it('returns an Identity on valid token with org_id', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_xyz', org_id: 'org_abc' });
    const env = baseEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_real',
      CLERK_PUBLISHABLE_KEY: 'pk_test_real',
    });
    const id = await verifyClerkJwt('fake-jwt', env);
    expect(id).toEqual({ userId: 'user_xyz', orgId: 'org_abc', source: 'clerk' });
    expect(mockVerifyToken).toHaveBeenCalledWith('fake-jwt', { secretKey: 'sk_test_real' });
  });

  it('maps missing org_id to null', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_solo' });
    const env = baseEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_real',
      CLERK_PUBLISHABLE_KEY: 'pk_test_real',
    });
    const id = await verifyClerkJwt('fake-jwt', env);
    expect(id).toEqual({ userId: 'user_solo', orgId: null, source: 'clerk' });
  });

  it('throws UnauthorizedError when the SDK rejects the token', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('JWT expired'));
    const env = baseEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_real',
      CLERK_PUBLISHABLE_KEY: 'pk_test_real',
    });
    await expect(verifyClerkJwt('fake-jwt', env)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError when the payload has no sub', async () => {
    mockVerifyToken.mockResolvedValueOnce({});
    const env = baseEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_real',
      CLERK_PUBLISHABLE_KEY: 'pk_test_real',
    });
    await expect(verifyClerkJwt('fake-jwt', env)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError (not calling the SDK) when token is empty', async () => {
    const env = baseEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_real',
      CLERK_PUBLISHABLE_KEY: 'pk_test_real',
    });
    await expect(verifyClerkJwt('', env)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedError when CLERK_SECRET_KEY is the solo-bypass sentinel', async () => {
    const env = baseEnv({
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      CLERK_PUBLISHABLE_KEY: 'pk_test_x',
    });
    await expect(verifyClerkJwt('fake-jwt', env)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });
});

// Sanity: existing factories still work unchanged.
describe('factories (regression)', () => {
  it('createSoloAuthClient returns solo identity', async () => {
    const auth = createSoloAuthClient();
    await expect(auth.getIdentity()).resolves.toEqual(SOLO_IDENTITY);
  });

  it('createAnonymousAuthClient throws UnauthorizedError on requireIdentity', async () => {
    const auth = createAnonymousAuthClient();
    await expect(auth.requireIdentity()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
