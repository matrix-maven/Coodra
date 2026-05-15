import 'server-only';

import { parseClerkRole, type Role } from '@coodra/shared/auth';

import { resolveIdentityMode } from '@/lib/deployment-mode';
import { requireOrgMatch } from '@/lib/org-guard';

/**
 * `apps/web-v2/lib/auth.ts` — the one source of "who is the current
 * actor on this request?" for every page + server action in v2.
 *
 * Branches three ways:
 *
 *   - `local-solo`   → synthetic `__solo__` actor with admin powers.
 *                       No Clerk import even occurs — solo bundles
 *                       don't pay the cold-start cost.
 *
 *   - `local-team`   → read user_id + org_id from ~/.coodra/config.json.
 *                       Treat the local operator as admin for their own
 *                       machine (single user per laptop). No Clerk
 *                       verification — the local file IS the truth.
 *
 *   - `team-hosted`  → call `auth()` from @clerk/nextjs/server. Clerk
 *                       verifies the session JWT signature. Org match
 *                       is enforced via `requireOrgMatch`. Role comes
 *                       from Clerk's `orgRole` on the session.
 *
 * Every page server-component should call this exactly once at the top
 * and pass the resolved actor down as a prop to children. Calling it
 * multiple times per request is safe but wastes a Clerk round-trip.
 *
 * The return shape (`Actor`) is wider than `@coodra/shared/auth::Actor`
 * because the web app wants `mode` to distinguish "solo" from "team"
 * for UI rendering. The shared package's Actor is used by RBAC
 * helpers (`requireRole`, `assertCanEdit`) which we delegate to.
 */

export interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly mode: 'solo' | 'team';
  readonly source: 'solo-bypass' | 'local-config' | 'clerk';
}

const SOLO_ACTOR: Actor = {
  userId: '__solo__',
  orgId: '__solo__',
  role: 'admin',
  mode: 'solo',
  source: 'solo-bypass',
};

export async function getActor(): Promise<Actor> {
  const idMode = resolveIdentityMode();

  if (idMode === 'solo') {
    return SOLO_ACTOR;
  }

  // Phase F.6+ (2026-05-12) — UNIFIED TEAM-MODE IDENTITY.
  //
  // Pre-fix, `local-team` mode hardcoded `role: 'admin'` from config.json
  // because we assumed "operator on their own laptop = admin." That
  // assumption breaks the moment:
  //   - a teammate signs into local-team web on a shared laptop
  //   - config.json gets overwritten by `team install` (which doesn't
  //     verify the redeemer's identity)
  //   - someone with viewer role uses the local web
  //
  // The fix: both `local-team` and `team-hosted` resolve identity AND
  // role from Clerk. The location of the web (laptop vs server) is
  // implementation detail — identity is always Clerk-authenticated in
  // team mode.
  //
  // config.json::team is now used ONLY by daemons (CLI/MCP/bridge) for
  // stamping `created_by_user_id` on writes — and those writes default
  // to role='member' (never admin) because the daemon can't verify the
  // active Clerk role of an unattended process. Admin actions are
  // web-only (Clerk-gated).
  const { auth } = await import('@clerk/nextjs/server');
  const session = await auth();
  if (session.userId === null || session.userId === undefined) {
    // Middleware should have redirected to /auth/sign-in already. If
    // we reach here, middleware is misconfigured or someone hit a
    // non-public route bypassing it. Hard-fail rather than silently
    // returning anonymous.
    throw new Error(
      'team mode but no Clerk session at getActor() — middleware misconfig or non-public route reached without auth',
    );
  }
  // Single-tenant invariant: refuse if Clerk session's org doesn't match
  // this deployment's EXPECTED_ORG_ID. Redirects to /forbidden.
  await requireOrgMatch(session.orgId ?? null);
  return {
    userId: session.userId,
    orgId: session.orgId ?? 'no-org',
    role: parseClerkRole(session.orgRole),
    mode: 'team',
    source: 'clerk',
  };
}

/**
 * Non-throwing variant for pages that want to render different UI
 * based on signed-in vs signed-out. Returns null when there's no
 * Clerk session in team-hosted mode. Returns the resolved actor
 * otherwise.
 *
 * Use sparingly. Most pages should call `getActor()` and let the
 * middleware redirect handle unauthenticated requests.
 */
export async function tryGetActor(): Promise<Actor | null> {
  const idMode = resolveIdentityMode();
  if (idMode === 'solo') {
    return SOLO_ACTOR;
  }
  // Phase F.6+ — team-mode (both local-team and team-hosted) reads
  // Clerk session. No session → no actor.
  try {
    const { auth } = await import('@clerk/nextjs/server');
    const session = await auth();
    if (session.userId === null || session.userId === undefined) return null;
    return {
      userId: session.userId,
      orgId: session.orgId ?? 'no-org',
      role: parseClerkRole(session.orgRole),
      mode: 'team',
      source: 'clerk',
    };
  } catch {
    return null;
  }
}
