'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertActorRole, refuseInLocalSolo } from '@/lib/action-guards';
import { getInviteByJti, revokeInvite } from '@/lib/queries/invites';

/**
 * `apps/web-v2/lib/actions/revoke-invite.ts` — admin-only server action
 * that disables a pending invite.
 *
 * Flow:
 *   1. Guard: refuse in `local-solo`. Admin-role required.
 *   2. Look up the invite by jti. 404 if missing.
 *   3. Org check: refuse if invite belongs to a different org than the
 *      actor (defense in depth — the middleware already pins on
 *      COODRA_EXPECTED_ORG_ID, but a misconfigured deploy where the
 *      env mismatches the DB shouldn't allow cross-org revoke).
 *   4. UPDATE team_invites with revoked_at / revoked_by_user_id.
 *      Idempotent: re-revoking an already-revoked or already-used
 *      invite returns null and we redirect with a "no-op" banner.
 *   5. Best-effort: revoke the matching Clerk organization invitation
 *      if `clerk_invitation_id` is set, so Clerk also stops sending
 *      reminder emails.
 *   6. Redirect back to /settings/team.
 */

export async function revokeInviteAction(formData: FormData): Promise<void> {
  refuseInLocalSolo('revoke_invite');
  const actor = await assertActorRole('admin');

  const jti = String(formData.get('jti') ?? '').trim();
  if (jti.length === 0) {
    redirect('/settings/team?error=' + encodeURIComponent('Missing jti on revoke form'));
  }

  const existing = await getInviteByJti(jti);
  if (existing === null) {
    redirect('/settings/team?error=' + encodeURIComponent('Invite not found'));
  }
  if (existing.orgId !== actor.orgId) {
    redirect(
      '/settings/team?error=' +
        encodeURIComponent('Refusing to revoke an invite from a different organization'),
    );
  }
  if (existing.usedAt !== null) {
    redirect(
      `/settings/team?error=${encodeURIComponent(
        `That invite was already redeemed on ${existing.usedAt}. Revoke is a no-op.`,
      )}`,
    );
  }
  if (existing.revokedAt !== null) {
    redirect(
      `/settings/team?error=${encodeURIComponent('That invite was already revoked. Nothing to do.')}`,
    );
  }

  const updated = await revokeInvite({ jti, userId: actor.userId });
  if (updated === null) {
    // Race: another admin clicked Revoke at the same moment. Treat as
    // a no-op; the row is in the desired state.
    redirect(
      `/settings/team?error=${encodeURIComponent('Concurrent revoke; the invite is already disabled.')}`,
    );
  }

  // Best-effort: revoke Clerk-side invitation too.
  if (existing.clerkInvitationId !== null) {
    try {
      const { clerkClient } = await import('@clerk/nextjs/server');
      const client = await clerkClient();
      await client.organizations.revokeOrganizationInvitation({
        organizationId: actor.orgId,
        invitationId: existing.clerkInvitationId,
        requestingUserId: actor.userId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[revoke-invite] Clerk revoke failed; local revoke succeeded:', (err as Error).message);
    }
  }

  revalidatePath('/settings/team');
  redirect(`/settings/team?revoked=${encodeURIComponent(existing.email)}`);
}
