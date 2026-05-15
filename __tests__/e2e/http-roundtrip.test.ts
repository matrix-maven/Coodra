import { afterEach, describe, expect, it } from 'vitest';

import { type BootHandle, bootForE2E, buildE2eEnv, openSqliteHandle } from './_helpers/boot.js';

/**
 * HTTP roundtrip — exercises the three S16 auth chain modes against
 * a real Streamable HTTP listener via plain `fetch`. Locks the wire
 * shape (status code, WWW-Authenticate header, body envelope) for
 * each branch.
 *
 * The unit-layer S16 integration tests (under `apps/mcp-server/__tests__/`)
 * exercise the same surface but at module-level. This e2e duplicates
 * the auth-chain probes through the boot helper that wires the FULL
 * ContextDeps graph from production lib factories — proving the
 * production wiring (not just the auth helpers) accepts and rejects
 * correctly.
 */

let active: { boot: BootHandle; closeDb: () => Promise<void> } | null = null;

async function start(envOverride: Parameters<typeof buildE2eEnv>[0]): Promise<BootHandle> {
  const { handle, close: closeDb } = openSqliteHandle();
  const env = buildE2eEnv(envOverride);
  const boot = await bootForE2E({ db: handle, env, withHttp: true });
  active = { boot, closeDb };
  return boot;
}

afterEach(async () => {
  if (active) {
    await active.boot.close();
    await active.closeDb();
    active = null;
  }
});

describe('http-roundtrip — solo-bypass mode', () => {
  it('initialize succeeds with no auth header (sentinel CLERK_SECRET_KEY)', async () => {
    const boot = await start({ COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' });
    if (!boot.http) throw new Error('expected http handle');
    const res = await fetch(`${boot.http.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'http-rt-e2e', version: '0.0.0-e2e' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe('http-roundtrip — team mode auth surface', () => {
  const TEAM_OPTS = {
    COODRA_MODE: 'team' as const,
    CLERK_SECRET_KEY: 'sk_test_team_e2e_realistic_secret_xxx',
    CLERK_PUBLISHABLE_KEY: 'pk_test_team_e2e_realistic_publishable_xxx',
    LOCAL_HOOK_SECRET: 'http-rt-e2e-hook-secret-16chars-min',
  };

  it('returns 401 + WWW-Authenticate: Bearer for unauthenticated request', async () => {
    const boot = await start(TEAM_OPTS);
    if (!boot.http) throw new Error('expected http handle');
    const res = await fetch(`${boot.http.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('unauthorized');
    expect(body.reason).toBe('no_valid_auth_layer');
  });

  it('returns 401 for malformed Bearer token (Clerk verifyToken rejects)', async () => {
    const boot = await start(TEAM_OPTS);
    if (!boot.http) throw new Error('expected http handle');
    const res = await fetch(`${boot.http.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer this-is-definitely-not-a-jwt',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts request with matching X-Local-Hook-Secret header', async () => {
    const boot = await start(TEAM_OPTS);
    if (!boot.http) throw new Error('expected http handle');
    const res = await fetch(`${boot.http.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-local-hook-secret': TEAM_OPTS.LOCAL_HOOK_SECRET,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'hook-e2e', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('healthz is unauthed in team mode too (operational probe)', async () => {
    const boot = await start(TEAM_OPTS);
    if (!boot.http) throw new Error('expected http handle');
    const res = await fetch(`${boot.http.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
