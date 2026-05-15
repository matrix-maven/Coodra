import { describe, expect, it, vi } from 'vitest';

/**
 * Six fixtures locking the hooks-bridge env contract:
 *   1. valid solo (sentinel Clerk + no LOCAL_HOOK_SECRET)
 *   2. valid team (real Clerk keys + LOCAL_HOOK_SECRET)
 *   3. team mode with sentinel Clerk → solo-bypass branch (allowed)
 *   4. team mode missing CLERK_PUBLISHABLE_KEY → ValidationError
 *   5. malformed HOOKS_BRIDGE_PORT (too high) → ValidationError
 *   6. LOCAL_HOOK_SECRET too short → ValidationError
 *
 * Each test reloads the env module under fresh process.env so the
 * fail-fast Zod parse runs against the fixture, not a stale cache.
 */

interface EnvOverrides {
  [key: string]: string | undefined;
}

async function loadEnv(overrides: EnvOverrides) {
  vi.resetModules();
  const original = { ...process.env };
  // Start from a clean slate to avoid leakage from other tests / shell.
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('COODRA_') ||
      key.startsWith('CLERK_') ||
      key.startsWith('HOOKS_BRIDGE_') ||
      key === 'LOCAL_HOOK_SECRET'
    ) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await import('../../../src/config/env.js');
  } finally {
    // Restore.
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

describe('hooks-bridge env schema', () => {
  it('1) valid solo: defaults applied, sentinel Clerk allowed', async () => {
    const { env } = await loadEnv({
      COODRA_MODE: 'solo',
      CLERK_SECRET_KEY: 'sk_test_replace_me',
    });
    expect(env.COODRA_MODE).toBe('solo');
    expect(env.HOOKS_BRIDGE_PORT).toBe(3101);
    expect(env.HOOKS_BRIDGE_HOST).toBe('127.0.0.1');
    expect(env.COODRA_LOG_DESTINATION).toBe('stderr');
    expect(env.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
  });

  it('2) valid team: real Clerk keys + LOCAL_HOOK_SECRET pass strict refine', async () => {
    const { env } = await loadEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_realRealKey1234',
      CLERK_PUBLISHABLE_KEY: 'pk_test_realRealKey1234',
      LOCAL_HOOK_SECRET: 'a'.repeat(32),
    });
    expect(env.COODRA_MODE).toBe('team');
    expect(env.LOCAL_HOOK_SECRET).toBe('a'.repeat(32));
  });

  it('3) team mode with sentinel Clerk: bypass allowed (no Clerk publishable required)', async () => {
    const { env } = await loadEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_replace_me',
    });
    expect(env.COODRA_MODE).toBe('team');
    expect(env.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
    expect(env.CLERK_PUBLISHABLE_KEY).toBeUndefined();
  });

  it('4) team mode missing CLERK_PUBLISHABLE_KEY → ValidationError', async () => {
    await expect(
      loadEnv({
        COODRA_MODE: 'team',
        CLERK_SECRET_KEY: 'sk_test_realRealKey1234',
      }),
    ).rejects.toThrow(/CLERK_PUBLISHABLE_KEY/);
  });

  it('5) malformed HOOKS_BRIDGE_PORT (> 65535) → ValidationError', async () => {
    await expect(
      loadEnv({
        COODRA_MODE: 'solo',
        HOOKS_BRIDGE_PORT: '99999',
      }),
    ).rejects.toThrow();
  });

  it('6) LOCAL_HOOK_SECRET shorter than 16 chars → ValidationError', async () => {
    await expect(
      loadEnv({
        COODRA_MODE: 'solo',
        LOCAL_HOOK_SECRET: 'too-short',
      }),
    ).rejects.toThrow(/at least 16 characters/);
  });
});
