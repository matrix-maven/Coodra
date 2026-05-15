'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { assertActorRole, refuseInLocalSolo } from '@/lib/action-guards';
import {
  describeInviteSecretConfig,
  type InviteRole,
  newJti,
  signInviteToken,
} from '@/lib/invite-token';
import { isMissingTeamInvitesTableError } from '@/lib/postgres-errors';
import { resolveDeploymentBaseUrl } from '@/lib/public-url';
import { insertInvite } from '@/lib/queries/invites';

/**
 * `apps/web-v2/lib/actions/invite.ts` — admin-only server action that
 * mints a new team invite.
 *
 * Flow:
 *   1. Guard: refuse in `local-solo` (no org). Admin-role required.
 *   2. Validate form fields (email + role + expiresInDays).
 *   3. Check `COODRA_INVITE_HMAC_SECRET` is configured (caveat E):
 *      surface a remediation redirect, not a crash, if missing.
 *   4. Mint a jti + sign the invite token.
 *   5. **Persist the `team_invites` row FIRST.** This is the durable
 *      record of what we're about to ask Clerk to do. If Clerk fails,
 *      the local row stays — admin can revoke + retry. If the DB
 *      throws (e.g. schema not migrated), we surface a clean error
 *      and have NOT spammed Clerk with an orphan invitation.
 *   6. Then fire Clerk's invitation API. On success, write the
 *      returned `clerkInvitationId` back onto the row so /revoke can
 *      cancel both sides atomically.
 *   7. Redirect back to /settings/team with success banner.
 *
 * Why insert-then-Clerk (not Clerk-then-insert): a previous iteration
 * called Clerk first; on a DB failure that left an unrevocable Clerk
 * invitation in flight. Reversing the order makes the DB row the
 * single source of truth, and Clerk's invitation a best-effort
 * follow-up that can be retried without producing duplicates (each
 * mint has a unique jti).
 *
 * Note on the Clerk-side coupling: per design caveat C, the Clerk
 * invitation handles the "join the org" half (Clerk's responsibility).
 * Our token is purely the CLI-bundle ticket. So a missed Clerk call
 * isn't fatal — the admin can hand the link to the teammate directly
 * (and they'll still need a Clerk identity to redeem, which is a
 * separate boundary).
 */

/**
 * Sanitise an Error message before embedding it in a redirect URL.
 * Two responsibilities:
 *   1. Detect the schema-missing case and substitute a clean
 *      remediation copy (no raw SQL).
 *   2. For everything else, strip newlines + cap length so the
 *      ?error= querystring stays readable and small.
 */
function sanitiseInviteError(err: unknown): string {
  if (isMissingTeamInvitesTableError(err)) {
    return 'team_invites table is missing on the deployment Postgres. Apply Drizzle migration 0014_team_invites (`coodra db migrate`) and reload.';
  }
  if (err instanceof Error) {
    const flat = err.message.split('\n')[0]?.trim() ?? '';
    return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat;
  }
  const s = String(err);
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

const INVITE_FORM_SCHEMA = z.object({
  email: z.string().email('a valid email is required'),
  role: z.enum(['admin', 'member', 'viewer'], {
    message: "role must be 'admin', 'member', or 'viewer'",
  }),
  expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
});

export async function mintInviteAction(formData: FormData): Promise<void> {
  refuseInLocalSolo('invite_teammate');
  // Phase G — every team-mode actor (laptop OR cloud) goes through
  // Clerk now, so `actor.source === 'clerk'` is invariant in team mode.
  // The pre-Phase-G gate that required 'team-hosted' is dropped because
  // local-team admins can mint invites too — teammates redeem against
  // the cloud row regardless of where the admin's web ran.
  const actor = await assertActorRole('admin');

  const parsed = INVITE_FORM_SCHEMA.safeParse({
    email: formData.get('email') ?? '',
    role: formData.get('role') ?? 'member',
    expiresInDays: formData.get('expiresInDays') ?? '7',
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`/settings/team?error=${encodeURIComponent(msg)}`);
  }

  // Caveat E — fail-loud on missing HMAC secret with a usable remediation.
  const secretIssue = describeInviteSecretConfig();
  if (secretIssue !== null) {
    redirect(
      `/settings/team?error=${encodeURIComponent(`Invite secret misconfigured: ${secretIssue}`)}`,
    );
  }

  const { email, role, expiresInDays } = parsed.data;
  const emailNormalized = email.toLowerCase().trim();
  const nowMs = Date.now();
  const expiresAtMs = nowMs + expiresInDays * 24 * 60 * 60 * 1000;
  const expiresAtSec = Math.floor(expiresAtMs / 1000);

  const jti = newJti();
  const baseUrl = resolveDeploymentBaseUrl();

  let token: string;
  try {
    token = signInviteToken({
      v: 1,
      jti,
      org: actor.orgId,
      role: role as InviteRole,
      email: emailNormalized,
      exp: expiresAtSec,
      iss: baseUrl,
    });
  } catch (err) {
    // Schema validation OR secret loading failed. Both rare given the
    // earlier check, but a defensive path.
    redirect(
      `/settings/team?error=${encodeURIComponent(`Failed to sign invite token: ${(err as Error).message}`)}`,
    );
  }

  // Step 1 — durable row first. If the DB throws (schema missing /
  // connection / unique-jti collision), nothing leaks to Clerk.
  const inviteId = randomUUID();
  try {
    await insertInvite({
      id: inviteId,
      orgId: actor.orgId,
      email: emailNormalized,
      role: role as InviteRole,
      jti,
      invitedByUserId: actor.userId,
      clerkInvitationId: null,
      expiresAt: new Date(expiresAtMs),
    });
  } catch (err) {
    redirect(`/settings/team?error=${encodeURIComponent(sanitiseInviteError(err))}`);
  }

  // Phase H.6 — one-email teammate onboarding.
  //
  // Pre-Phase-H this step called `client.organizations.createOrganizationInvitation`
  // which fires a Clerk-managed email to the invited address. That email
  // carried a DIFFERENT URL (Clerk's redemption flow) from the
  // Coodra install URL the admin would also share — Jane ended up
  // with two links and didn't know which to click.
  //
  // The Phase H rule: the Coodra install URL is the ONE link Jane
  // ever sees. `/api/install/[token]` POST handles Clerk org-membership
  // creation at redemption time via `createOrganizationMembership`. Jane
  // only ever needs a Clerk *user* (sign-up at /auth/sign-up handles
  // that), and the install endpoint adds her to the org transparently.
  //
  // We keep `clerk_invitation_id` on the row as a nullable column for
  // historical compatibility — pre-Phase-H rows still have it populated,
  // and the revoke flow handles both cases.

  revalidatePath('/settings/team');
  const params = new URLSearchParams({
    invited: emailNormalized,
    token,
  });
  redirect(`/settings/team?${params.toString()}`);
}

// (clerkRoleFromInvite removed in Phase H.6 — Clerk role mapping now
// lives at the redemption site in apps/web-v2/app/api/install/[token]/route.ts.)
