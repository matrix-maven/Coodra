import { NextResponse } from 'next/server';

import { resolveIdentityMode } from '@/lib/deployment-mode';
import { type InviteTokenPayload, verifyInviteToken } from '@/lib/invite-token';
import { isMissingTeamInvitesTableError } from '@/lib/postgres-errors';
import { resolveDeploymentBaseUrl } from '@/lib/public-url';
import { getInviteByJti, redeemInvite } from '@/lib/queries/invites';

/**
 * `/api/install/[token]` — CLI bundle delivery endpoint (M04 Phase 2).
 *
 * Two methods:
 *
 *   - `GET`  — preview without consuming the token. Returns the email
 *              + role + expiry so the CLI / page can show context.
 *              Validates signature + expiry + revocation. Used by
 *              `/install/[token]/page.tsx` server component.
 *
 *   - `POST` — race-safe redemption. Verifies the token, confirms the
 *              caller is signed into Clerk as the invited email
 *              (caveat B), atomically marks `used_at`, and returns the
 *              CLI bundle. The bundle is constructed from server env
 *              vars at request time — never stored in `team_invites`.
 *
 * The bundle deliberately omits Clerk admin keys (caveat A). The CLI
 * authenticates to the cloud via `LOCAL_HOOK_SECRET`; Clerk SDK is
 * never spawned from the CLI.
 *
 * Failure shapes — every error response returns:
 *   `{ ok: false, error: '<stable-code>', howToFix: '<remediation>' }`
 * so the CLI and the install page render the same surface.
 */

export const dynamic = 'force-dynamic';

interface RouteParams {
  readonly params: Promise<{ readonly token: string }>;
}

interface InstallBundle {
  readonly ok: true;
  readonly userId: string;
  readonly orgId: string;
  readonly orgSlug: string | null;
  readonly databaseUrl: string;
  readonly localHookSecret: string;
  readonly cloudApiBaseUrl: string;
  readonly role: 'admin' | 'member' | 'viewer';
  readonly invitedEmail: string;
  /**
   * Phase G — Clerk publishable key for the teammate's CLI/MCP/bridge
   * to verify JWTs against the same Clerk app. The publishable key is
   * a public credential (it's already embedded in the deployment's web
   * bundle); sharing it with verified team members is safe. CLERK_SECRET_KEY
   * is NOT included — teammates verify via JWKS (public-key crypto).
   */
  readonly clerkPublishableKey: string | null;
}

function errorResponse(
  status: number,
  error: string,
  howToFix: string,
): NextResponse {
  return NextResponse.json({ ok: false, error, howToFix }, { status });
}

/** Common preflight — runs for GET + POST before any DB / Clerk work. */
async function preflight(
  token: string,
): Promise<{ ok: true; payload: InviteTokenPayload } | { ok: false; response: NextResponse }> {
  // Phase G — install works in any team mode (laptop or cloud).
  if (resolveIdentityMode() !== 'team') {
    return {
      ok: false,
      response: errorResponse(
        404,
        'not_team_mode',
        'This endpoint only exists in team-mode deployments. Run `coodra team init` to switch into team mode.',
      ),
    };
  }

  const verification = verifyInviteToken(token, Math.floor(Date.now() / 1000));
  if (!verification.ok) {
    // Map verification reasons to HTTP statuses.
    const statusByReason: Record<typeof verification.reason, number> = {
      malformed: 400,
      bad_signature: 401,
      bad_payload: 400,
      expired: 410,
      secret_misconfigured: 500,
    };
    return {
      ok: false,
      response: errorResponse(
        statusByReason[verification.reason] ?? 400,
        verification.reason,
        verification.howToFix,
      ),
    };
  }

  // DB row checks (independent of signature):
  //   - row must exist (it always should — admin minted both at once)
  //   - not revoked, not used, expiry matches signed expiry
  //
  // Catch the "relation does not exist" case so a not-yet-migrated
  // deployment surfaces a clear remediation instead of a generic 500.
  let row: Awaited<ReturnType<typeof getInviteByJti>>;
  try {
    row = await getInviteByJti(verification.payload.jti);
  } catch (err) {
    if (isMissingTeamInvitesTableError(err)) {
      return {
        ok: false,
        response: errorResponse(
          503,
          'schema_not_migrated',
          'Deployment Postgres is missing the `team_invites` table. The admin must apply Drizzle migration 0014_team_invites (`coodra db migrate`) before invites can be served.',
        ),
      };
    }
    throw err;
  }
  if (row === null) {
    return {
      ok: false,
      response: errorResponse(
        404,
        'invite_not_found',
        'The invite record is missing from the deployment database. Ask the admin to mint a new one.',
      ),
    };
  }
  if (row.revokedAt !== null) {
    return {
      ok: false,
      response: errorResponse(
        410,
        'revoked',
        `This invite was revoked on ${row.revokedAt}. Ask the admin to mint a new one.`,
      ),
    };
  }
  if (row.usedAt !== null) {
    return {
      ok: false,
      response: errorResponse(
        410,
        'already_redeemed',
        `This invite was redeemed on ${row.usedAt}. Each invite is single-use; ask the admin to mint a new one if you need to set up another machine.`,
      ),
    };
  }
  if (row.orgId !== verification.payload.org) {
    // Defense in depth — the signed `org` claim must match the row's
    // `org_id`. If they diverge, something is forged or the DB was
    // tampered with directly.
    return {
      ok: false,
      response: errorResponse(
        401,
        'org_mismatch',
        'The invite payload does not match its database record. Refusing to serve.',
      ),
    };
  }

  return { ok: true, payload: verification.payload };
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  const { token } = await params;
  const pre = await preflight(token);
  if (!pre.ok) return pre.response;
  // Preview: never reveals secrets, only the public-facing fields.
  return NextResponse.json({
    ok: true,
    email: pre.payload.email,
    role: pre.payload.role,
    orgId: pre.payload.org,
    expiresAt: new Date(pre.payload.exp * 1000).toISOString(),
  });
}

/**
 * Map the invite role onto Clerk's organization role wire format.
 *
 * Roles:
 *   - `admin`  → `org:admin`  (always present)
 *   - `member` → `org:member` (default in modern Clerk; some legacy
 *                              instances still use `org:basic_member`)
 *   - `viewer` → `org:viewer` (custom role — admin must provision it
 *                              in the Clerk dashboard's Roles tab before
 *                              viewer invites can auto-add)
 *
 * If `org:viewer` doesn't exist in the deployment's Clerk org, the
 * `createOrganizationMembership` call will fail with `Organization
 * role not found`. The error surfaces back to the CLI via
 * `org_membership_failed` so the admin sees the actionable remediation.
 */
function clerkRoleForInvite(role: 'admin' | 'member' | 'viewer'): string {
  if (role === 'admin') return 'org:admin';
  if (role === 'viewer') return 'org:viewer';
  return 'org:member';
}

export async function POST(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  const { token } = await params;
  const pre = await preflight(token);
  if (!pre.ok) return pre.response;
  const payload = pre.payload;

  // Phase H.6 — one-email teammate onboarding.
  //
  // Pre-Phase-H, this endpoint required the redeemer to already be in
  // the Clerk org (i.e. they had to click the SEPARATE Clerk
  // organization-invitation email first). That created the "two-email
  // confusion" gap: admin pasted the install URL, but Jane ALSO got a
  // Clerk email she had to accept first.
  //
  // Phase H drops the Clerk org-invite step entirely. The admin's
  // `mintInviteAction` no longer fires `createOrganizationInvitation`,
  // so Jane only ever sees ONE link — the Coodra install URL.
  //
  // At redemption time, this route looks up Jane by email. Two cases:
  //
  //   A. Jane is already in the org (re-installing on a new laptop,
  //      or her Clerk membership was created out-of-band): trust the
  //      membership and proceed.
  //   B. Jane is signed up in Clerk but NOT in the org: this endpoint
  //      now ADDS her via Clerk Backend API
  //      `organizations.createOrganizationMembership`. The HMAC-signed
  //      single-use token is the admin's vouching credential.
  //
  // If Jane has no Clerk user at all (case C), she has to sign up via
  // /auth/sign-up first. The install page UX (and `coodra team join`)
  // open the browser to the cli-login page, which routes through Clerk
  // sign-in/sign-up so case C is handled at the UX layer — by the time
  // a request hits this POST, Jane has a Clerk identity in some form.
  //
  // Defense in depth (unchanged):
  //   1. HMAC signature — token can't be forged.
  //   2. UNIQUE(jti) + race-safe UPDATE — single-use, first-caller-wins.
  //   3. 7-day default expiry — leak window is bounded.
  //   4. Admin can revoke at any time.
  //   5. Email match — payload.email must equal a verified Clerk address.
  const { clerkClient } = await import('@clerk/nextjs/server');
  let resolvedUserId: string;
  try {
    const client = await clerkClient();
    const users = await client.users.getUserList({
      emailAddress: [payload.email],
      limit: 5,
    });
    const candidate = users.data.find((u) =>
      u.emailAddresses.some((e) => e.emailAddress.toLowerCase() === payload.email.toLowerCase()),
    );
    if (candidate === undefined) {
      return errorResponse(
        403,
        'user_not_in_clerk',
        `No Clerk user found with email ${payload.email}. Open this invite URL in a browser first — it'll prompt you to sign up with Clerk. After sign-up, re-run this command.`,
      );
    }
    // Membership check — Phase H auto-adds if missing.
    const memberships = await client.users.getOrganizationMembershipList({
      userId: candidate.id,
    });
    const inOrg = memberships.data.some((m) => m.organization.id === payload.org);
    if (!inOrg) {
      try {
        await client.organizations.createOrganizationMembership({
          organizationId: payload.org,
          userId: candidate.id,
          role: clerkRoleForInvite(payload.role),
        });
      } catch (membershipErr) {
        return errorResponse(
          500,
          'org_membership_failed',
          `Couldn't add ${payload.email} to ${payload.org.slice(0, 16)}…: ${(membershipErr as Error).message}. ` +
            'The admin can also add you manually via the Clerk dashboard, then re-run this command.',
        );
      }
    }
    resolvedUserId = candidate.id;
  } catch (err) {
    return errorResponse(
      500,
      'clerk_lookup_failed',
      `Could not resolve the Clerk user for ${payload.email}: ${(err as Error).message}`,
    );
  }

  // Atomic redeem.
  const redeemed = await redeemInvite({ jti: payload.jti, userId: resolvedUserId });
  if (redeemed === null) {
    // Most likely: a concurrent CLI call won the race. Surface as
    // already-redeemed so the second CLI sees a clear error.
    return errorResponse(
      410,
      'already_redeemed',
      'This invite was just redeemed by another process. Each invite is single-use.',
    );
  }

  // Construct the bundle from server env. Never stored in DB.
  const databaseUrl = process.env.DATABASE_URL;
  const localHookSecret = process.env.LOCAL_HOOK_SECRET;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    return errorResponse(
      500,
      'database_url_missing',
      'Deployment misconfig: DATABASE_URL is not set on the server. Ask the admin to set it and redeploy.',
    );
  }
  if (typeof localHookSecret !== 'string' || localHookSecret.length === 0) {
    return errorResponse(
      500,
      'local_hook_secret_missing',
      'Deployment misconfig: LOCAL_HOOK_SECRET is not set on the server. Ask the admin to set it (32-byte hex, `openssl rand -hex 32`) and redeploy.',
    );
  }

  // Try to resolve the Clerk org slug so the CLI can store a
  // human-readable identifier alongside the org id.
  let orgSlug: string | null = null;
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: payload.org });
    orgSlug = org.slug ?? null;
  } catch {
    // Not fatal — slug is purely cosmetic.
  }

  const baseUrl = resolveDeploymentBaseUrl();
  const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null;
  const bundle: InstallBundle = {
    ok: true,
    userId: resolvedUserId,
    orgId: payload.org,
    orgSlug,
    databaseUrl,
    localHookSecret,
    cloudApiBaseUrl: baseUrl,
    role: payload.role,
    invitedEmail: payload.email,
    clerkPublishableKey,
  };
  return NextResponse.json(bundle);
}

