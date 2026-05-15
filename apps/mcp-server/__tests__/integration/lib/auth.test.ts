import { UnauthorizedError, ValidationError } from '@coodra/shared';
import { describe, expect, it } from 'vitest';

import type { McpServerEnv } from '../../../src/config/env.js';
import {
  createAnonymousAuthClient,
  createAuthClient,
  createClerkAuthClient,
  createSoloAuthClient,
  SOLO_IDENTITY,
} from '../../../src/lib/auth.js';

function baseEnv(overrides: Partial<McpServerEnv> = {}): McpServerEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    HOSTNAME: 'test',
    COODRA_MODE: 'solo',
    COODRA_LOG_DESTINATION: 'stderr',
    MCP_SERVER_PORT: 3100,
    ...overrides,
  } as McpServerEnv;
}

/**
 * Integration test for `src/lib/auth.ts`.
 *
 * Proves that both factory outputs satisfy the shared `AuthClient`
 * interface and that `requireIdentity` enforces its contract — the
 * solo factory resolves, the anonymous factory rejects with
 * `UnauthorizedError` from `@coodra/shared`.
 *
 * This locks the S7a invariant that tool code never branches on
 * "is this solo or Clerk?" — both paths respond to the same
 * interface and differ only in the identity they return (or the
 * error they throw).
 */

describe('lib/auth — createSoloAuthClient', () => {
  it('returns the frozen SOLO_IDENTITY from getIdentity', async () => {
    const auth = createSoloAuthClient();
    const id = await auth.getIdentity();
    expect(id).toEqual(SOLO_IDENTITY);
  });

  it('returns the frozen SOLO_IDENTITY from requireIdentity (no throw)', async () => {
    const auth = createSoloAuthClient();
    await expect(auth.requireIdentity()).resolves.toEqual(SOLO_IDENTITY);
  });

  it('SOLO_IDENTITY has source="solo-bypass" for audit', () => {
    expect(SOLO_IDENTITY.source).toBe('solo-bypass');
    expect(SOLO_IDENTITY.userId).toBe('user_dev_local');
    expect(SOLO_IDENTITY.orgId).toBe('org_dev_local');
  });
});

describe('lib/auth — createAnonymousAuthClient', () => {
  it('returns null from getIdentity', async () => {
    const auth = createAnonymousAuthClient();
    await expect(auth.getIdentity()).resolves.toBeNull();
  });

  it('throws UnauthorizedError from requireIdentity', async () => {
    const auth = createAnonymousAuthClient();
    await expect(auth.requireIdentity()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('lib/auth — createAuthClient dispatcher (S7b)', () => {
  it('dispatches to solo in solo mode', async () => {
    const auth = createAuthClient(baseEnv());
    await expect(auth.getIdentity()).resolves.toEqual(SOLO_IDENTITY);
  });

  it('dispatches to solo when CLERK_SECRET_KEY is the solo-bypass sentinel, even in team mode', async () => {
    const auth = createAuthClient(
      baseEnv({
        COODRA_MODE: 'team',
        CLERK_SECRET_KEY: 'sk_test_replace_me',
        CLERK_PUBLISHABLE_KEY: 'pk_test_xxx',
      }),
    );
    await expect(auth.getIdentity()).resolves.toEqual(SOLO_IDENTITY);
  });

  it('dispatches to Clerk in team mode with real keys — getIdentity=null on stdio', async () => {
    const auth = createAuthClient(
      baseEnv({
        COODRA_MODE: 'team',
        CLERK_SECRET_KEY: 'sk_test_real',
        CLERK_PUBLISHABLE_KEY: 'pk_test_real',
      }),
    );
    await expect(auth.getIdentity()).resolves.toBeNull();
    await expect(auth.requireIdentity()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('lib/auth — createClerkAuthClient construction contract (S7b)', () => {
  it('rejects the solo-bypass sentinel', () => {
    expect(() =>
      createClerkAuthClient(
        baseEnv({
          CLERK_SECRET_KEY: 'sk_test_replace_me',
          CLERK_PUBLISHABLE_KEY: 'pk_test_x',
        }),
      ),
    ).toThrow(ValidationError);
  });

  it('requires publishable key alongside secret key', () => {
    expect(() => createClerkAuthClient(baseEnv({ CLERK_SECRET_KEY: 'sk_test_real' }))).toThrow(ValidationError);
  });
});
