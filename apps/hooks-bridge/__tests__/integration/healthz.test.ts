import type { AuthEnv } from '@coodra/shared/auth';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * GET /healthz happy path. Uses Hono's `app.request()` fixture — no
 * real port-listen needed.
 */

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
    ...overrides,
  };
}

describe('GET /healthz', () => {
  it('returns 200 with the expected envelope', async () => {
    const startedAt = new Date('2026-04-25T12:00:00.000Z');
    const { hono } = buildApp({ env: makeEnv(), serverStartedAt: startedAt });

    const res = await hono.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      service: 'hooks-bridge',
      mode: 'solo',
      serverStartedAt: '2026-04-25T12:00:00.000Z',
    });
  });

  it('does NOT require authentication', async () => {
    // Use a team-mode env with real keys so the auth middleware would
    // normally reject anonymous requests; healthz must still return 200.
    const env = makeEnv({
      COODRA_MODE: 'team',
      CLERK_SECRET_KEY: 'sk_test_realRealKey1234',
      CLERK_PUBLISHABLE_KEY: 'pk_test_realRealKey1234',
    });
    const { hono } = buildApp({ env });
    const res = await hono.request('/healthz');
    expect(res.status).toBe(200);
  });
});
