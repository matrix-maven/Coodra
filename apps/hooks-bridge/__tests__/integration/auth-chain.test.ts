import type { AuthEnv } from '@coodra/shared/auth';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * Auth-chain order tests at the hooks-bridge boundary. Verifies the
 * three layers in order:
 *
 *   (1) solo-bypass — sentinel CLERK_SECRET_KEY accepts any caller
 *   (2) X-Local-Hook-Secret — header value must match exactly
 *   (3) no auth → 401
 *
 * The Clerk JWT layer's wire code is exercised in
 * `packages/shared/__tests__/unit/auth/auth.test.ts` (where the
 * `vi.mock('@clerk/backend')` applies natively to the shared module
 * being tested). Re-mocking it here would be a layering mistake — this
 * suite is about the chain order at the hooks-bridge ingress, not the
 * Clerk SDK's internals. Bad-Bearer requests fall through to 401 (the
 * verifyClerkJwt error path), which is itself one of the cases below.
 */

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    COODRA_MODE: 'team',
    CLERK_SECRET_KEY: 'sk_test_realRealKey1234',
    CLERK_PUBLISHABLE_KEY: 'pk_test_realRealKey1234',
    ...overrides,
  };
}

const STUB_BODY = JSON.stringify({ session_id: 'sess', hook_event_name: 'PreToolUse' });

describe('auth chain on POST /v1/hooks/{agent}', () => {
  it('(1) solo-bypass — sentinel CLERK_SECRET_KEY accepts any caller', async () => {
    const { hono } = buildApp({ env: makeEnv({ CLERK_SECRET_KEY: 'sk_test_replace_me' }) });
    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: STUB_BODY,
    });
    expect(res.status).toBe(200);
  });

  it('(1b) solo-bypass — COODRA_MODE=solo with no sentinel still bypasses (matches MCP server semantics)', async () => {
    // Regression guard: before the fix, the bridge required the literal
    // CLERK_SECRET_KEY sentinel for solo-bypass while the MCP server also
    // accepted COODRA_MODE=solo. Out-of-the-box, `coodra start` does
    // not forward .env into the daemon, so CLERK_SECRET_KEY was undefined —
    // bridge 401'd every hook in solo mode. This test pins the disjunction.
    const { hono } = buildApp({
      env: { COODRA_MODE: 'solo' } as AuthEnv,
    });
    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: STUB_BODY,
    });
    expect(res.status).toBe(200);
  });

  it('(2) X-Local-Hook-Secret matches → request proceeds', async () => {
    const secret = 'a'.repeat(32);
    const { hono } = buildApp({ env: makeEnv(), localHookSecret: secret });
    const res = await hono.request('/v1/hooks/windsurf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-local-hook-secret': secret },
      body: STUB_BODY,
    });
    expect(res.status).toBe(200);
  });

  it('(3) no auth headers → 401', async () => {
    const { hono } = buildApp({ env: makeEnv() });
    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: STUB_BODY,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unauthorized');
  });

  it('X-Local-Hook-Secret with wrong value falls through to 401', async () => {
    const { hono } = buildApp({ env: makeEnv(), localHookSecret: 'a'.repeat(32) });
    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-local-hook-secret': 'wrong'.repeat(8) },
      body: STUB_BODY,
    });
    expect(res.status).toBe(401);
  });

  it('Bearer token without a valid Clerk tenant configured → 401', async () => {
    // Real @clerk/backend rejects 'fake.jwt.token' (not three dot-separated
    // base64url segments). The chain falls through to 401, which is the
    // contract: any unverifiable Bearer is anonymous.
    const { hono } = buildApp({ env: makeEnv() });
    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not.a.jwt' },
      body: STUB_BODY,
    });
    expect(res.status).toBe(401);
  });

  it('all three agent routes share the same chain (windsurf, cursor, claude-code identical)', async () => {
    const { hono } = buildApp({ env: makeEnv({ CLERK_SECRET_KEY: 'sk_test_replace_me' }) });
    for (const agent of ['claude-code', 'windsurf', 'cursor'] as const) {
      const res = await hono.request(`/v1/hooks/${agent}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: STUB_BODY,
      });
      expect(res.status).toBe(200);
    }
  });
});
