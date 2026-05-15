/**
 * `apps/web/lib/auth.ts` — actor identity per spec §9 + OQ-3 lock.
 *
 * Returns a stable `{ userId, orgId, mode }` triple for every request.
 *   - Solo: synthetic `__solo__` user + org (matches CLI's F7 invariant).
 *   - Team: Clerk's `auth()` → real userId + orgId.
 *
 * Server components call this; client components receive the resolved
 * actor as a prop, never the raw Clerk handle.
 */

export interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly mode: 'solo' | 'team';
}

const SOLO_ACTOR: Actor = { userId: '__solo__', orgId: '__solo__', mode: 'solo' };

export async function getActor(): Promise<Actor> {
  const mode = (process.env.COODRA_MODE ?? 'solo') as 'solo' | 'team';
  if (mode === 'solo') return SOLO_ACTOR;

  // Team — defer the Clerk import so solo bundles don't pull it
  // (avoids a Clerk-in-solo cold-start cost).
  const { auth } = await import('@clerk/nextjs/server');
  const session = await auth();
  if (session.userId === null || session.userId === undefined) {
    // Middleware should have redirected to sign-in already; this is a
    // belt-and-suspenders fallback.
    return { userId: 'anonymous', orgId: 'anonymous', mode: 'team' };
  }
  return {
    userId: session.userId,
    orgId: session.orgId ?? 'no-org',
    mode: 'team',
  };
}
