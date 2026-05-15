import { migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __internal as envInternal } from '../../../src/config/env.js';
import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { pingToolRegistration } from '../../../src/tools/ping/manifest.js';
import { type HttpTransportHandle, startHttpTransport } from '../../../src/transports/http.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration tests for the S16 Streamable HTTP transport.
 *
 * Boots a real listener on an ephemeral port (`port: 0` → kernel
 * assigns) and exercises the auth chain + `/healthz` + `/mcp` JSON-RPC
 * round-trip via plain `fetch`. Tests do NOT use the MCP SDK client —
 * the goal is to lock the wire shape (status codes, headers, JSON-RPC
 * envelope), not the SDK's client API.
 *
 * Auth chain (§19, locked order):
 *   solo-bypass  → CLERK_SECRET_KEY === 'sk_test_replace_me'
 *   X-Local-Hook → header matches LOCAL_HOOK_SECRET (timing-safe)
 *   Clerk JWT    → Authorization: Bearer <jwt>
 *   else         → 401
 *
 * Each test constructs a synthetic env via the schema's parse — the
 * real env loader pulls from process.env at module load and is frozen
 * by then. We override just the fields the test cares about.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: HttpTransportHandle;
  readonly url: string;
}

type EnvOverride = {
  readonly COODRA_MODE?: 'solo' | 'team';
  readonly CLERK_SECRET_KEY?: string;
  readonly CLERK_PUBLISHABLE_KEY?: string;
  readonly LOCAL_HOOK_SECRET?: string;
  readonly MCP_SERVER_PORT?: number;
};

function buildEnv(override: EnvOverride): Parameters<typeof startHttpTransport>[0]['env'] {
  // Use 0 → kernel-assigned port so parallel tests don't collide.
  const base = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    COODRA_MODE: override.COODRA_MODE ?? 'solo',
    COODRA_LOG_DESTINATION: 'stderr',
    MCP_SERVER_PORT: override.MCP_SERVER_PORT ?? 0,
    MCP_SERVER_HOST: '127.0.0.1',
    MCP_SERVER_TRANSPORT: 'http',
    CLERK_SECRET_KEY: override.CLERK_SECRET_KEY ?? 'sk_test_replace_me',
    ...(override.CLERK_PUBLISHABLE_KEY !== undefined ? { CLERK_PUBLISHABLE_KEY: override.CLERK_PUBLISHABLE_KEY } : {}),
    ...(override.LOCAL_HOOK_SECRET !== undefined ? { LOCAL_HOOK_SECRET: override.LOCAL_HOOK_SECRET } : {}),
  };
  return envInternal.schema.parse(base) as Parameters<typeof startHttpTransport>[0]['env'];
}

async function openHarness(envOverride: EnvOverride = {}): Promise<Harness> {
  const env = buildEnv(envOverride);

  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = baseDeps;
  const registry = new ToolRegistry({ deps });
  registry.register(pingToolRegistration);

  const handle2 = await startHttpTransport({
    registry,
    serverName: '@coodra/mcp-server-test',
    serverVersion: '0.0.0-test',
    env,
  });

  return {
    close: async () => {
      await handle2.close();
      await client.close();
    },
    handle: handle2,
    url: handle2.url,
  };
}

// ---------------------------------------------------------------------------
// /healthz — unauthed, always 200
// ---------------------------------------------------------------------------

describe('http transport — GET /healthz', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns 200 ok with no auth required', async () => {
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('skips the auth chain — header value is irrelevant', async () => {
    const res = await fetch(`${h.url}/healthz`, {
      headers: { authorization: 'Bearer total-garbage' },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown paths
// ---------------------------------------------------------------------------

describe('http transport — unknown path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns 404 JSON for an unrouted path (Hono fallthrough)', async () => {
    const res = await fetch(`${h.url}/random-unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toBe('not_found');
    expect(body.path).toBe('/random-unknown');
  });
});

// ---------------------------------------------------------------------------
// /mcp auth chain — solo-bypass
// ---------------------------------------------------------------------------

describe('http transport — /mcp auth: solo-bypass (sentinel CLERK_SECRET_KEY)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness({ CLERK_SECRET_KEY: 'sk_test_replace_me', COODRA_MODE: 'solo' });
  });
  afterEach(async () => {
    await h.close();
  });

  it('MCP initialize round-trip succeeds with no Authorization header', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    // Initialize response is a single JSON-RPC response (not SSE).
    // Body shape: { jsonrpc: '2.0', id: 1, result: { protocolVersion, capabilities, serverInfo } }.
    const text = await res.text();
    // Strip optional SSE prefix if the SDK chose stream mode for this client.
    const jsonStart = text.indexOf('{');
    const body = JSON.parse(text.slice(jsonStart, text.lastIndexOf('}') + 1)) as {
      jsonrpc: string;
      id: number;
      result?: { protocolVersion?: string; serverInfo?: { name: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result?.serverInfo?.name).toBe('@coodra/mcp-server-test');
  });
});

// ---------------------------------------------------------------------------
// /mcp auth chain — 401 in team mode without credentials
// ---------------------------------------------------------------------------

describe('http transport — /mcp auth: team mode rejects unauthenticated', () => {
  let h: Harness;
  beforeEach(async () => {
    // Real-shaped Clerk keys force the solo-bypass branch off without
    // requiring a live Clerk tenant (the JWT path returns 401 on a
    // bogus token, which is what we want to exercise).
    h = await openHarness({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_realistic_but_fake_secret_only_for_testing_xxx',
      CLERK_PUBLISHABLE_KEY: 'pk_test_realistic_but_fake_publishable_xxx',
      LOCAL_HOOK_SECRET: 'integration-test-hook-secret-16chars-min',
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns 401 with no Authorization and no X-Local-Hook-Secret', async () => {
    const res = await fetch(`${h.url}/mcp`, {
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

  it('returns 401 with a malformed Bearer token', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer this-is-not-a-jwt',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong X-Local-Hook-Secret', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-local-hook-secret': 'wrong-secret-which-does-not-match',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// /mcp auth chain — X-Local-Hook-Secret accepted in team mode
// ---------------------------------------------------------------------------

describe('http transport — /mcp auth: X-Local-Hook-Secret matches', () => {
  let h: Harness;
  const HOOK = 'integration-test-hook-secret-16chars-min';
  beforeEach(async () => {
    h = await openHarness({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_realistic_but_fake_secret_only_for_testing_xxx',
      CLERK_PUBLISHABLE_KEY: 'pk_test_realistic_but_fake_publishable_xxx',
      LOCAL_HOOK_SECRET: HOOK,
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('accepts a request with matching X-Local-Hook-Secret header', async () => {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-local-hook-secret': HOOK,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /mcp body-size cap (1 MiB)
// ---------------------------------------------------------------------------

describe('http transport — /mcp body size cap', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness({ CLERK_SECRET_KEY: 'sk_test_replace_me' });
  });
  afterEach(async () => {
    await h.close();
  });

  it('rejects bodies larger than 1 MiB with a 500 (request destroyed mid-read)', async () => {
    // Construct a 2 MiB body — well above the 1 MiB cap.
    const tooBig = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { x: 'y'.repeat(2 * 1024 * 1024) },
    });
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: tooBig,
    }).catch((err) => ({ ok: false, _err: err }) as unknown as Response);
    // Either Node closes the connection mid-write (fetch throws → caught
    // above) or we get an error response. Both are acceptable shapes —
    // the load-bearing assertion is "this does NOT succeed".
    if ('status' in res) {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
