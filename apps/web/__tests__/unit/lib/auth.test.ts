import { afterEach, describe, expect, it, vi } from 'vitest';

import { getActor } from '@/lib/auth';

describe('getActor', () => {
  const original = process.env.CONTEXTOS_MODE;

  afterEach(() => {
    process.env.CONTEXTOS_MODE = original;
  });

  it('returns the synthetic __solo__ actor in solo mode', async () => {
    process.env.CONTEXTOS_MODE = 'solo';
    const actor = await getActor();
    expect(actor).toEqual({ userId: '__solo__', orgId: '__solo__', mode: 'solo' });
  });

  it('returns the synthetic __solo__ actor when CONTEXTOS_MODE is unset', async () => {
    delete process.env.CONTEXTOS_MODE;
    const actor = await getActor();
    expect(actor.userId).toBe('__solo__');
    expect(actor.orgId).toBe('__solo__');
    expect(actor.mode).toBe('solo');
  });

  it('falls back to the anonymous actor in team mode when Clerk has no session', async () => {
    process.env.CONTEXTOS_MODE = 'team';
    vi.doMock('@clerk/nextjs/server', () => ({
      auth: async () => ({ userId: null, orgId: null }),
    }));
    // Re-import after mocking to pick up the doMock.
    const { getActor: getActorMocked } = await import('@/lib/auth');
    const actor = await getActorMocked();
    expect(actor.userId).toBe('anonymous');
    expect(actor.mode).toBe('team');
    vi.doUnmock('@clerk/nextjs/server');
  });
});
