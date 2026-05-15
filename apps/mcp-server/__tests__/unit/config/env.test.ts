import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `env.ts` parses process.env at module load and throws a
 * ValidationError for any bad vector. The schema design is locked
 * here under four fixtures per addition D of the Module 02 plan.
 *
 * Fixture coverage:
 *   valid-solo                 — COODRA_MODE=solo, no Clerk, parses cleanly.
 *   valid-team-with-sentinel   — COODRA_MODE=team + solo-bypass sentinel,
 *                                parses cleanly (Clerk keys not required).
 *   valid-team-with-real-keys  — COODRA_MODE=team + real sk_test_/pk_test_
 *                                keys, parses cleanly.
 *   invalid-team-without-clerk — COODRA_MODE=team, non-sentinel secret,
 *                                must throw with a pointer to the missing var.
 *   invalid-port               — MCP_SERVER_PORT=abc, must throw.
 *   invalid-log-destination    — COODRA_LOG_DESTINATION=syslog, must throw.
 *   no-process-env-in-source   — (structural) no file under src/ except env.ts
 *                                reads process.env directly.
 */
describe('@coodra/mcp-server env schema', () => {
  // Back up the full env before each test; restore after. We isolate
  // only the variables the schema parses so other tools (e.g. vitest)
  // see their expected environment.
  const SNAPSHOT_KEYS = [
    'NODE_ENV',
    'COODRA_MODE',
    'LOG_LEVEL',
    'COODRA_LOG_DESTINATION',
    'MCP_SERVER_PORT',
    'LOCAL_HOOK_SECRET',
    'CLERK_PUBLISHABLE_KEY',
    'CLERK_SECRET_KEY',
    'CLERK_JWT_ISSUER',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SNAPSHOT_KEYS) original[k] = process.env[k];
    for (const k of SNAPSHOT_KEYS) delete process.env[k];
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of SNAPSHOT_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    vi.resetModules();
  });

  it('valid-solo: defaults populate without Clerk keys', async () => {
    process.env.COODRA_MODE = 'solo';
    const { env } = await import('../../../src/config/env.js');
    expect(env.COODRA_MODE).toBe('solo');
    // mcp-server schema defaults COODRA_LOG_DESTINATION to 'stderr'
    // because this service owns stdout as a protocol channel; see
    // src/config/env.ts docblock.
    expect(env.COODRA_LOG_DESTINATION).toBe('stderr');
    expect(env.MCP_SERVER_PORT).toBe(3100);
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.CLERK_PUBLISHABLE_KEY).toBeUndefined();
  });

  it('valid-team + solo-bypass sentinel: Clerk keys are optional', async () => {
    process.env.COODRA_MODE = 'team';
    process.env.CLERK_SECRET_KEY = 'sk_test_replace_me';
    const { env } = await import('../../../src/config/env.js');
    expect(env.COODRA_MODE).toBe('team');
    expect(env.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
    expect(env.CLERK_PUBLISHABLE_KEY).toBeUndefined();
  });

  it('valid-team with real Clerk keys parses cleanly', async () => {
    process.env.COODRA_MODE = 'team';
    process.env.CLERK_SECRET_KEY = 'sk_test_abcd1234efgh5678';
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_abcd1234efgh5678';
    const { env } = await import('../../../src/config/env.js');
    expect(env.COODRA_MODE).toBe('team');
    expect(env.CLERK_SECRET_KEY).toBe('sk_test_abcd1234efgh5678');
    expect(env.CLERK_PUBLISHABLE_KEY).toBe('pk_test_abcd1234efgh5678');
  });

  it('invalid: team mode with a real secret but no publishable key throws', async () => {
    process.env.COODRA_MODE = 'team';
    process.env.CLERK_SECRET_KEY = 'sk_test_abcd1234efgh5678';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(/CLERK_PUBLISHABLE_KEY/);
  });

  it('invalid: malformed MCP_SERVER_PORT throws', async () => {
    process.env.COODRA_MODE = 'solo';
    process.env.MCP_SERVER_PORT = 'not-a-number';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(/MCP_SERVER_PORT/);
  });

  it('invalid: COODRA_LOG_DESTINATION outside {stdout,stderr} throws', async () => {
    process.env.COODRA_MODE = 'solo';
    process.env.COODRA_LOG_DESTINATION = 'syslog';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(/COODRA_LOG_DESTINATION/);
  });

  it('invalid: LOCAL_HOOK_SECRET shorter than 16 chars throws', async () => {
    process.env.COODRA_MODE = 'solo';
    process.env.LOCAL_HOOK_SECRET = 'short';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(/LOCAL_HOOK_SECRET/);
  });

  it('invalid: malformed CLERK_SECRET_KEY (not sk_test/sk_live and not sentinel) throws', async () => {
    process.env.COODRA_MODE = 'team';
    process.env.CLERK_SECRET_KEY = 'garbage_key';
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_abcd1234efgh5678';
    await expect(import('../../../src/config/env.js')).rejects.toThrow(/CLERK_SECRET_KEY/);
  });
});
