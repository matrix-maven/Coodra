import 'server-only';

import { postgresSchema } from '@coodra/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { createWebCloudDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/invites.ts` — read/write the `team_invites`
 * table for M04 Phase 2.
 *
 * Phase G — cloud Postgres in any team mode (laptop OR cloud).
 * `team_invites` lives in the cloud because:
 *   - teammates redeem against the SAME cloud row regardless of where
 *     the minting admin's web ran
 *   - single-use jti needs cloud-side enforcement
 *   - the SQLite mirror exists for schema parity only — never holds rows
 * The cloud handle is sourced via `createWebCloudDb()` which throws if
 * the machine isn't in team mode.
 *
 * All time fields are returned as ISO-8601 strings for serialization
 * across the Server Component / Server Action boundary. Drizzle gives
 * us `Date` objects on read; the page-render layer wants strings.
 */

export interface TeamInviteRow {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: 'admin' | 'member' | 'viewer';
  readonly jti: string;
  readonly invitedByUserId: string;
  readonly clerkInvitationId: string | null;
  readonly expiresAt: string; // ISO-8601
  readonly usedAt: string | null;
  readonly usedByUserId: string | null;
  readonly revokedAt: string | null;
  readonly revokedByUserId: string | null;
  readonly createdAt: string;
}

// Phase G — the cloud handle is sourced via `createWebCloudDb()` which
// guarantees Postgres in any team mode. `requirePostgres` is no longer
// needed because the helper's return type is already narrowed.

function rowToInvite(r: {
  id: string;
  orgId: string;
  email: string;
  role: string;
  jti: string;
  invitedByUserId: string;
  clerkInvitationId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  usedByUserId: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  createdAt: Date;
}): TeamInviteRow {
  return {
    id: r.id,
    orgId: r.orgId,
    email: r.email,
    role: r.role as 'admin' | 'member' | 'viewer',
    jti: r.jti,
    invitedByUserId: r.invitedByUserId,
    clerkInvitationId: r.clerkInvitationId,
    expiresAt: r.expiresAt.toISOString(),
    usedAt: r.usedAt === null ? null : r.usedAt.toISOString(),
    usedByUserId: r.usedByUserId,
    revokedAt: r.revokedAt === null ? null : r.revokedAt.toISOString(),
    revokedByUserId: r.revokedByUserId,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Look up a single invite by its JWT id. Returns null when not found. */
export async function getInviteByJti(jti: string): Promise<TeamInviteRow | null> {
  const handle = createWebCloudDb();
  const rows = await handle.db
    .select()
    .from(postgresSchema.teamInvites)
    .where(eq(postgresSchema.teamInvites.jti, jti))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  if (r === undefined) return null;
  return rowToInvite(r);
}

/**
 * Pending = not used AND not revoked AND not expired. The
 * `/settings/team` page renders these as the "Pending invites" table.
 *
 * Ordered by most-recently-minted first.
 */
export async function listPendingInvites(orgId: string): Promise<TeamInviteRow[]> {
  const handle = createWebCloudDb();
  const rows = await handle.db
    .select()
    .from(postgresSchema.teamInvites)
    .where(
      and(
        eq(postgresSchema.teamInvites.orgId, orgId),
        isNull(postgresSchema.teamInvites.usedAt),
        isNull(postgresSchema.teamInvites.revokedAt),
        sql`${postgresSchema.teamInvites.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(postgresSchema.teamInvites.createdAt));
  return rows.map(rowToInvite);
}

export interface MintInviteArgs {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: 'admin' | 'member' | 'viewer';
  readonly jti: string;
  readonly invitedByUserId: string;
  readonly clerkInvitationId: string | null;
  readonly expiresAt: Date;
}

export async function insertInvite(args: MintInviteArgs): Promise<TeamInviteRow> {
  const handle = createWebCloudDb();
  const inserted = await handle.db
    .insert(postgresSchema.teamInvites)
    .values({
      id: args.id,
      orgId: args.orgId,
      email: args.email.toLowerCase(),
      role: args.role,
      jti: args.jti,
      invitedByUserId: args.invitedByUserId,
      clerkInvitationId: args.clerkInvitationId,
      expiresAt: args.expiresAt,
    })
    .returning();
  const r = inserted[0];
  if (r === undefined) {
    throw new Error('insertInvite: INSERT RETURNING produced zero rows (unexpected)');
  }
  return rowToInvite(r);
}

/**
 * Two-phase mint: insert the row first with `clerk_invitation_id =
 * NULL`, then call Clerk, then patch the row with the returned id.
 * This helper is the patch step.
 */
export async function setClerkInvitationIdByJti(jti: string, clerkInvitationId: string): Promise<void> {
  const handle = createWebCloudDb();
  await handle.db
    .update(postgresSchema.teamInvites)
    .set({ clerkInvitationId })
    .where(eq(postgresSchema.teamInvites.jti, jti));
}

export interface RedeemArgs {
  readonly jti: string;
  readonly userId: string; // Clerk user id of the signed-in redeemer
}

/**
 * Race-safe redemption — CONDITIONAL UPDATE so exactly one concurrent
 * caller wins:
 *
 *   UPDATE team_invites
 *     SET used_at = now(), used_by_user_id = $userId
 *     WHERE jti = $jti AND used_at IS NULL AND revoked_at IS NULL
 *           AND expires_at > now()
 *   RETURNING *;
 *
 * Returns the row when the redeem succeeds, `null` when the WHERE didn't
 * match (already-redeemed, revoked, expired, or non-existent — caller
 * disambiguates by a follow-up `getInviteByJti` if needed).
 */
export async function redeemInvite(args: RedeemArgs): Promise<TeamInviteRow | null> {
  const handle = createWebCloudDb();
  const updated = await handle.db
    .update(postgresSchema.teamInvites)
    .set({
      usedAt: new Date(),
      usedByUserId: args.userId,
    })
    .where(
      and(
        eq(postgresSchema.teamInvites.jti, args.jti),
        isNull(postgresSchema.teamInvites.usedAt),
        isNull(postgresSchema.teamInvites.revokedAt),
        sql`${postgresSchema.teamInvites.expiresAt} > now()`,
      ),
    )
    .returning();
  const r = updated[0];
  if (r === undefined) return null;
  return rowToInvite(r);
}

export interface RevokeArgs {
  readonly jti: string;
  readonly userId: string; // Clerk user id of the admin doing the revoke
}

/**
 * Mark an invite revoked. Only-affects-pending: if the invite was
 * already used / revoked / expired, returns `null` (idempotent).
 */
export async function revokeInvite(args: RevokeArgs): Promise<TeamInviteRow | null> {
  const handle = createWebCloudDb();
  const updated = await handle.db
    .update(postgresSchema.teamInvites)
    .set({
      revokedAt: new Date(),
      revokedByUserId: args.userId,
    })
    .where(
      and(
        eq(postgresSchema.teamInvites.jti, args.jti),
        isNull(postgresSchema.teamInvites.usedAt),
        isNull(postgresSchema.teamInvites.revokedAt),
      ),
    )
    .returning();
  const r = updated[0];
  if (r === undefined) return null;
  return rowToInvite(r);
}
