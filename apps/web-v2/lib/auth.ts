/**
 * web-v2 actor identity. Mirrors the shape of apps/web/lib/auth.ts so
 * actions/queries copied from the old app keep working unchanged. The
 * v2 shell currently runs solo-mode-first; team-mode auth (Clerk) is
 * reintroduced in a follow-up alongside the auth surfaces.
 */

export interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly mode: 'solo' | 'team';
}

const SOLO_ACTOR: Actor = { userId: '__solo__', orgId: '__solo__', mode: 'solo' };

export async function getActor(): Promise<Actor> {
  const mode = (process.env.CONTEXTOS_MODE ?? 'solo') as 'solo' | 'team';
  if (mode === 'solo') return SOLO_ACTOR;
  // Team-mode auth not yet ported into web-v2 — return a placeholder so
  // server actions don't crash. Production team mode should still use
  // the original apps/web until the v2 auth pass lands.
  return { userId: 'team-placeholder', orgId: 'team-placeholder', mode: 'team' };
}
