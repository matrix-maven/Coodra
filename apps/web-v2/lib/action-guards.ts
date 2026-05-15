import 'server-only';

import { requireRole, type Role } from '@coodra/shared/auth';
import { redirect } from 'next/navigation';

import { type Actor, getActor } from '@/lib/auth';
import { resolveDeploymentMode } from '@/lib/deployment-mode';

/**
 * `apps/web-v2/lib/action-guards.ts` — wrapper helpers for the gate
 * conditions every server action needs:
 *
 *   - `refuseInTeamHosted(action)` — some server actions only make
 *     sense on a local developer's laptop (spawning the MCP server,
 *     writing ~/.coodra/.env, calling `coodra init`). In
 *     `team-hosted` mode the web app runs on a server with no local
 *     daemons, no ~/.coodra directory, and no business writing to
 *     it. We refuse with a redirect to a help page instead of letting
 *     a confused operator silently corrupt their deployment.
 *
 *   - `refuseInLocalSolo(action)` — RBAC-bearing actions (policy edits,
 *     pack uploads) make no sense in `local-solo` mode where there's no
 *     org to scope by. Solo bundles never get the corresponding UI
 *     buttons but the guard catches direct POSTs.
 *
 * Each helper logs the rejection (server-side console) for audit. The
 * redirect target encodes the action name so the user-facing page can
 * explain what they tried + why it was blocked.
 */

/**
 * Refuse the action if the deployment is `team-hosted`. Use on actions
 * that are inherently local-laptop operations:
 *   - starting/stopping daemons (services.ts)
 *   - coodra init (init.ts)
 *   - team join (team-join.ts) — config writes go to ~/.coodra, which
 *     doesn't exist on the deployment server
 *   - cancel-stuck-runs that touches local SQLite
 */
export function refuseInTeamHosted(action: string): never | void {
  if (resolveDeploymentMode() !== 'team-hosted') return;
  // eslint-disable-next-line no-console
  console.warn(`[action-guard] refused ${action} in team-hosted mode (local-only operation)`);
  redirect(`/forbidden?reason=local_only&action=${encodeURIComponent(action)}`);
}

/**
 * Refuse the action if the deployment is `local-solo`. Use on actions
 * that need a team context to make sense (RBAC, invites, member views).
 */
export function refuseInLocalSolo(action: string): never | void {
  if (resolveDeploymentMode() !== 'local-solo') return;
  // eslint-disable-next-line no-console
  console.warn(`[action-guard] refused ${action} in local-solo mode (team-only operation)`);
  redirect(`/forbidden?reason=team_only&action=${encodeURIComponent(action)}`);
}

/**
 * Resolve the actor + require at least `minRole`. The web-v2 `Actor`
 * shape is a superset of the shared package's `Actor` (we add `mode`);
 * this helper repackages so callers don't have to construct the args
 * by hand every time.
 *
 * On role-below-minimum: redirects to `/forbidden?reason=insufficient_role`
 * so the user-facing UX is consistent with org-mismatch / local-only
 * rejections. The redirect is terminal — `assertActorRole` returns
 * normally only when the actor passes.
 *
 * Use in server actions as:
 *   const actor = await assertActorRole('admin');
 */
export async function assertActorRole(minRole: Role): Promise<Actor> {
  const actor = await getActor();
  try {
    requireRole({ userId: actor.userId, orgId: actor.orgId, role: actor.role, source: actor.source }, minRole);
    return actor;
  } catch {
    redirect(
      `/forbidden?reason=insufficient_role&needed=${encodeURIComponent(minRole)}&actor_role=${encodeURIComponent(actor.role)}`,
    );
  }
}
