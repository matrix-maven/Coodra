import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthEnv } from '../../../src/auth/types.js';
import { UnauthorizedError } from '../../../src/errors/index.js';

/**
 * Unit tests for `packages/shared/src/auth/verify-clerk-jwt.ts` (Phase G).
 *
 * Strategy: hoist-mock `@clerk/backend::verifyToken` and feed it
 * crafted payloads. The pure claim-extraction logic is covered via the
 * test-only `__extractClaimsForTest` export so we don't have to round-
 * trip through the mock for edge cases.
 */

const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock('@clerk/backend', () => ({
  verifyToken: mockVerifyToken,
}));

const {
  clearVerifyClerkJwtCache,
  verifyClerkJwtAndExtractClaims,
  __extractClaimsForTest,
} = await import('../../../src/auth/verify-clerk-jwt.js');

function baseEnv(): AuthEnv {
  return {
    COODRA_MODE: 'team',
    CLERK_SECRET_KEY: 'sk_test_realkey_12345',
    CLERK_PUBLISHABLE_KEY: 'pk_test_realkey_12345',
  };
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    sub: 'user_2abc123',
    org_id: 'org_2xyz789',
    org_role: 'org:admin',
    email: 'admin@example.com',
    iss: 'https://wise-bat-12.clerk.accounts.dev',
    iat: nowSec - 10,
    exp: nowSec + 3600,
    ...overrides,
  };
}

beforeEach(() => {
  clearVerifyClerkJwtCache();
  mockVerifyToken.mockReset();
});

afterEach(() => {
  clearVerifyClerkJwtCache();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('verifyClerkJwtAndExtractClaims — happy path', () => {
  it('returns typed claims for a valid token', async () => {
    mockVerifyToken.mockResolvedValue(basePayload());

    const claims = await verifyClerkJwtAndExtractClaims('jwt-string', baseEnv());

    expect(claims.userId).toBe('user_2abc123');
    expect(claims.orgId).toBe('org_2xyz789');
    expect(claims.role).toBe('admin');
    expect(claims.email).toBe('admin@example.com');
    expect(claims.issuer).toBe('https://wise-bat-12.clerk.accounts.dev');
    expect(claims.expiresAt).toBeInstanceOf(Date);
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('parses org:basic_member as member', async () => {
    mockVerifyToken.mockResolvedValue(basePayload({ org_role: 'org:basic_member' }));
    const claims = await verifyClerkJwtAndExtractClaims('jwt', baseEnv());
    expect(claims.role).toBe('member');
  });

  it('parses org:viewer as viewer', async () => {
    mockVerifyToken.mockResolvedValue(basePayload({ org_role: 'org:viewer' }));
    const claims = await verifyClerkJwtAndExtractClaims('jwt', baseEnv());
    expect(claims.role).toBe('viewer');
  });

  it('defaults role to member when org_role missing', async () => {
    const p = basePayload();
    delete p.org_role;
    mockVerifyToken.mockResolvedValue(p);
    const claims = await verifyClerkJwtAndExtractClaims('jwt', baseEnv());
    expect(claims.role).toBe('member');
  });

  it('sets email to null when missing', async () => {
    const p = basePayload();
    delete p.email;
    mockVerifyToken.mockResolvedValue(p);
    const claims = await verifyClerkJwtAndExtractClaims('jwt', baseEnv());
    expect(claims.email).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------

describe('verifyClerkJwtAndExtractClaims — env validation', () => {
  it('rejects empty token', async () => {
    await expect(verifyClerkJwtAndExtractClaims('', baseEnv())).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('accepts missing CLERK_SECRET_KEY (JWKS-only verification mode)', async () => {
    mockVerifyToken.mockResolvedValue(basePayload());
    await expect(
      verifyClerkJwtAndExtractClaims('jwt', {
        ...baseEnv(),
        CLERK_SECRET_KEY: undefined,
      }),
    ).resolves.toHaveProperty('userId');
    // JWKS mode → no secretKey in the options passed to clerkVerifyToken
    expect(mockVerifyToken).toHaveBeenCalledWith('jwt', {});
  });

  it('rejects the solo-bypass sentinel as CLERK_SECRET_KEY', async () => {
    await expect(
      verifyClerkJwtAndExtractClaims('jwt', {
        ...baseEnv(),
        CLERK_SECRET_KEY: 'sk_test_replace_me',
      }),
    ).rejects.toThrow(/solo-bypass sentinel/);
  });

  it('rejects missing CLERK_PUBLISHABLE_KEY', async () => {
    await expect(
      verifyClerkJwtAndExtractClaims('jwt', {
        ...baseEnv(),
        CLERK_PUBLISHABLE_KEY: undefined,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ---------------------------------------------------------------------------
// Claim-extraction edge cases (via __extractClaimsForTest)
// ---------------------------------------------------------------------------

describe('extractClaims — edge cases', () => {
  it('rejects payload with no sub', () => {
    const p = basePayload();
    delete p.sub;
    expect(() => __extractClaimsForTest(p, Date.now())).toThrow(/sub is missing/);
  });

  it('rejects payload with empty-string sub', () => {
    expect(() => __extractClaimsForTest(basePayload({ sub: '' }), Date.now())).toThrow(/sub is missing/);
  });

  it('rejects payload with no exp', () => {
    const p = basePayload();
    delete p.exp;
    expect(() => __extractClaimsForTest(p, Date.now())).toThrow(/exp is missing/);
  });

  it('rejects payload with non-numeric exp', () => {
    expect(() => __extractClaimsForTest(basePayload({ exp: 'soon' }), Date.now())).toThrow(/exp is missing/);
  });

  it('rejects expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(() => __extractClaimsForTest(basePayload({ exp: past }), Date.now())).toThrow(/token expired/);
  });

  it('rejects token with no org_id', () => {
    const p = basePayload();
    delete p.org_id;
    expect(() => __extractClaimsForTest(p, Date.now())).toThrow(/org_id missing/);
  });

  it('rejects token with empty-string org_id', () => {
    expect(() => __extractClaimsForTest(basePayload({ org_id: '' }), Date.now())).toThrow(/org_id missing/);
  });

  it('defaults issuedAt to epoch when iat missing', () => {
    const p = basePayload();
    delete p.iat;
    const claims = __extractClaimsForTest(p, Date.now());
    expect(claims.issuedAt.getTime()).toBe(0);
  });

  it('handles missing iss as empty issuer', () => {
    const p = basePayload();
    delete p.iss;
    const claims = __extractClaimsForTest(p, Date.now());
    expect(claims.issuer).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Verification failure
// ---------------------------------------------------------------------------

describe('verifyClerkJwtAndExtractClaims — Clerk verification failure', () => {
  it('throws UnauthorizedError when @clerk/backend rejects', async () => {
    mockVerifyToken.mockRejectedValue(new Error('JWT signature is invalid'));
    await expect(verifyClerkJwtAndExtractClaims('bad-jwt', baseEnv())).rejects.toThrow(
      /JWT signature is invalid/,
    );
  });

  it('wraps non-Error rejections', async () => {
    mockVerifyToken.mockRejectedValue('something weird');
    await expect(verifyClerkJwtAndExtractClaims('bad-jwt', baseEnv())).rejects.toThrow(
      /something weird/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe('verifyClerkJwtAndExtractClaims — 30s cache', () => {
  it('returns the same instance on the second call within TTL', async () => {
    mockVerifyToken.mockResolvedValue(basePayload());
    const first = await verifyClerkJwtAndExtractClaims('jwt-a', baseEnv());
    const second = await verifyClerkJwtAndExtractClaims('jwt-a', baseEnv());
    expect(first).toBe(second);
    expect(mockVerifyToken).toHaveBeenCalledTimes(1);
  });

  it('different token strings do not share cache entries', async () => {
    mockVerifyToken.mockResolvedValue(basePayload());
    await verifyClerkJwtAndExtractClaims('jwt-a', baseEnv());
    await verifyClerkJwtAndExtractClaims('jwt-b', baseEnv());
    expect(mockVerifyToken).toHaveBeenCalledTimes(2);
  });

  it('clearVerifyClerkJwtCache forces re-verify on next call', async () => {
    mockVerifyToken.mockResolvedValue(basePayload());
    await verifyClerkJwtAndExtractClaims('jwt-a', baseEnv());
    clearVerifyClerkJwtCache();
    await verifyClerkJwtAndExtractClaims('jwt-a', baseEnv());
    expect(mockVerifyToken).toHaveBeenCalledTimes(2);
  });

  it('a token that expires mid-cache window does NOT serve stale claims', async () => {
    // First verify: expires 1s from now
    const closeExp = Math.floor(Date.now() / 1000) + 1;
    mockVerifyToken.mockResolvedValueOnce(basePayload({ exp: closeExp }));
    await verifyClerkJwtAndExtractClaims('jwt-soon', baseEnv());

    // Fast-forward past expiry
    vi.useFakeTimers();
    vi.setSystemTime(new Date((closeExp + 5) * 1000));

    // Second call: cache says stale (expiresAt now <= Date.now()) → re-verify.
    // Re-verify returns the SAME exp, so extractClaims throws "expired".
    mockVerifyToken.mockResolvedValueOnce(basePayload({ exp: closeExp }));
    await expect(verifyClerkJwtAndExtractClaims('jwt-soon', baseEnv())).rejects.toThrow(/token expired/);

    vi.useRealTimers();
  });
});
