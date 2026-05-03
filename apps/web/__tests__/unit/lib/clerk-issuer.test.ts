import { afterEach, describe, expect, it } from 'vitest';

import { ClerkIssuerError, probeClerkJwks, resolveClerkIssuer } from '@/lib/clerk-issuer';

describe('resolveClerkIssuer', () => {
  const originalIssuer = process.env.CLERK_JWT_ISSUER;
  const originalKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  afterEach(() => {
    if (originalIssuer !== undefined) process.env.CLERK_JWT_ISSUER = originalIssuer;
    else delete process.env.CLERK_JWT_ISSUER;
    if (originalKey !== undefined) process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalKey;
    else delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it('returns env override when set', () => {
    expect(resolveClerkIssuer({ envOverride: 'https://override.clerk.dev' })).toBe('https://override.clerk.dev');
  });

  it('decodes the tenant from a publishable key', () => {
    // Real key from .env: pk_test_ZnVuLWdudS05Ni5jbGVyay5hY2NvdW50cy5kZXYk
    // base64-decoded = "fun-gnu-96.clerk.accounts.dev$"
    const issuer = resolveClerkIssuer({
      publishableKey: 'pk_test_ZnVuLWdudS05Ni5jbGVyay5hY2NvdW50cy5kZXYk',
    });
    expect(issuer).toBe('https://fun-gnu-96.clerk.accounts.dev');
  });

  it('throws when neither env nor publishable key is provided', () => {
    delete process.env.CLERK_JWT_ISSUER;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    expect(() => resolveClerkIssuer()).toThrow(ClerkIssuerError);
  });

  it('throws on a malformed publishable key', () => {
    expect(() => resolveClerkIssuer({ publishableKey: 'pk_test_!!!not-base64!!!' })).toThrow(ClerkIssuerError);
  });
});

describe('probeClerkJwks', () => {
  it('returns true when the JWKS endpoint returns a keys array', async () => {
    const fakeFetch = (async (_input: unknown, _init?: unknown) =>
      ({
        ok: true,
        json: async () => ({ keys: [{ kty: 'RSA', kid: 'k1' }] }),
      }) as unknown as Response) as typeof fetch;
    expect(await probeClerkJwks('https://example.test', fakeFetch)).toBe(true);
  });

  it('returns false on non-2xx', async () => {
    const fakeFetch = (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;
    expect(await probeClerkJwks('https://example.test', fakeFetch)).toBe(false);
  });

  it('returns false on missing keys array', async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
    expect(await probeClerkJwks('https://example.test', fakeFetch)).toBe(false);
  });

  it('returns false on fetch throw', async () => {
    const fakeFetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await probeClerkJwks('https://example.test', fakeFetch)).toBe(false);
  });
});
