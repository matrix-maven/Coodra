import { ForbiddenError } from '../errors/index.js';

/**
 * `@coodra/shared/auth/roles` — Module 04 Phase 4 RBAC.
 *
 * Tier 2.5 — three Clerk roles enforced at the server-action boundary.
 * The web app (apps/web), the bridge (apps/hooks-bridge), and the MCP
 * server (apps/mcp-server) all branch on this shape via `requireRole`
 * / `assertCanEdit` / `assertCanResume`. The role names are stable
 * wire-format strings shared across services.
 *
 * Mapping from Clerk's role identifiers:
 *   `org:admin`        → `admin`
 *   `org:viewer`       → `viewer`   (custom Clerk role; configured at org level)
 *   anything else      → `member`   (Clerk default `org:basic_member` + safe fallback)
 *
 * Solo mode shortcut: `SOLO_ACTOR` is `{ userId: '__solo__', orgId: '__solo__',
 * role: 'admin' }`. Solo users implicitly have admin privileges; there's
 * no one else to share the box with.
 */

/**
 * The three roles Coodra recognizes. Ordered by privilege ascending
 * (viewer < member < admin) so `ROLE_RANK[role]` gives a comparable
 * number.
 */
export type Role = 'viewer' | 'member' | 'admin';

export const ROLES: ReadonlyArray<Role> = ['viewer', 'member', 'admin'] as const;

const ROLE_RANK: Record<Role, number> = Object.freeze({ viewer: 0, member: 1, admin: 2 });

/**
 * Parse Clerk's role string into our internal Role. Unknown / missing
 * values default to `'member'` — the floor that allows agent-session
 * use. To lock a user out of writes, set their role to `'viewer'`
 * explicitly (custom Clerk role).
 */
export function parseClerkRole(clerkRole: string | null | undefined): Role {
  if (clerkRole === null || clerkRole === undefined) return 'member';
  // Clerk role strings are conventionally `org:<role>`; we lowercase
  // and strip the prefix to be permissive on shape.
  const normalized = clerkRole.trim().toLowerCase().replace(/^org:/, '');
  if (normalized === 'admin') return 'admin';
  if (normalized === 'viewer') return 'viewer';
  return 'member';
}

/**
 * Authorization actor — Identity + role + the org context required
 * to scope every read query. Web pages / server actions / MCP tool
 * handlers all receive this.
 */
export interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
  /**
   * Provenance of the identity. Per-source meaning:
   *   - `solo-bypass`  — synthetic __solo__ user (no real identity)
   *   - `clerk`        — verified Clerk session JWT (team-hosted web)
   *   - `local-hook`   — local hook-secret-authenticated HTTP request
   *   - `local-config` — read from ~/.coodra/config.json on this
   *                      machine (per-developer local web pattern)
   */
  readonly source: 'solo-bypass' | 'clerk' | 'local-hook' | 'local-config';
}

export const SOLO_ACTOR: Actor = Object.freeze({
  userId: '__solo__',
  orgId: '__solo__',
  role: 'admin',
  source: 'solo-bypass',
});

/**
 * True iff the actor's role is at least `min`. Pure predicate; never
 * throws. Use this to render UI affordances (gray out an "Edit" button
 * for under-privileged roles). The server is the security boundary —
 * always pair UI gating with `requireRole` on the server action.
 */
export function hasRole(actor: Actor, min: Role): boolean {
  return ROLE_RANK[actor.role] >= ROLE_RANK[min];
}

/**
 * Throws `ForbiddenError` if the actor's role is below `min`. The
 * canonical guard for server actions:
 *
 *   export async function deletePolicyAction(formData: FormData) {
 *     const actor = await getActor();
 *     requireRole(actor, 'admin');
 *     // ... admin-only work below
 *   }
 *
 * The error message names the required role + actual role so the web
 * app's toast can render a useful "you need admin" message.
 */
export function requireRole(actor: Actor, min: Role): void {
  if (!hasRole(actor, min)) {
    throw new ForbiddenError(`Requires role '${min}' or higher; actor has '${actor.role}'.`);
  }
}

/**
 * Throws `ForbiddenError` if the actor cannot edit a resource. Default
 * policy: admin can edit anything. With `{ allowOwner: true }` a
 * member can edit their own resource (used for "members can resume
 * their own kill-switch pauses" / "members can edit their own context
 * packs"). Viewers are read-only — `allowOwner: true` does NOT relax
 * the gate for viewers, regardless of ownership.
 *
 * `resource.createdByUserId` of `null` (solo-mode rows + pre-Phase-4
 * rows) means "no owner recorded" — only admin can edit those, even
 * when allowOwner is true. This is intentional: an unattributed row
 * has no claim to ownership.
 */
export function assertCanEdit(
  actor: Actor,
  resource: { readonly createdByUserId?: string | null | undefined },
  opts: { readonly allowOwner?: boolean } = {},
): void {
  if (hasRole(actor, 'admin')) return;
  if (opts.allowOwner === true && hasRole(actor, 'member')) {
    const owner = resource.createdByUserId ?? null;
    if (owner !== null && owner === actor.userId) return;
  }
  const ownerLabel =
    resource.createdByUserId === actor.userId ? 'is owner' : `owner is '${resource.createdByUserId ?? 'unknown'}'`;
  throw new ForbiddenError(
    `Requires admin role${
      opts.allowOwner === true ? ' or member-ownership' : ''
    }; actor has role '${actor.role}' and ${ownerLabel}.`,
  );
}

/**
 * Specialization for kill-switch resume: members can resume a switch
 * they paused themselves; admins can resume any switch. Wraps
 * `assertCanEdit` with `allowOwner: true` and the kill-switch's
 * `pausedByUserId` field as the ownership claim.
 */
export function assertCanResumeKillSwitch(
  actor: Actor,
  killSwitch: { readonly pausedByUserId?: string | null | undefined },
): void {
  assertCanEdit(actor, { createdByUserId: killSwitch.pausedByUserId ?? null }, { allowOwner: true });
}

/**
 * Phase F.3 — knowledge-layer authoring gate. An actor may CREATE or
 * EDIT (when also owner) a feature / feature_pack iff they are `admin`
 * or `member`. Viewers are explicitly excluded — the viewer role is
 * read-only by definition and authoring a draft would violate that
 * contract regardless of subsequent publish gating.
 *
 * The `member` floor is intentional: features and feature packs ARE
 * the team's shared knowledge — every team member should be able to
 * contribute. The publish step (separately gated by ownership +
 * admin override via `assertCanEditKnowledge`) is where review-style
 * gates would normally land, but Phase F.3 ships with auto-publish
 * for the member's own drafts (admin can demote / hide drafts but
 * can't block them from existing).
 *
 * Throws ForbiddenError when the actor is `viewer`.
 */
export function assertCanAuthorKnowledge(actor: Actor): void {
  if (hasRole(actor, 'member')) return;
  throw new ForbiddenError(
    `Requires role 'member' or higher to author features or feature packs; actor has '${actor.role}'.`,
  );
}

/**
 * Phase F.3 — knowledge-layer edit gate. Mirrors `assertCanEdit` with
 * a knowledge-tailored rationale:
 *
 *   - admin       → can edit ANY feature / feature_pack
 *   - member      → can edit OWN feature / feature_pack (createdByUserId
 *                   matches actor.userId)
 *   - viewer      → never
 *   - null owner  → admin-only (unattributed rows have no ownership claim)
 *
 * Use this from web server actions that mutate `features` / `feature_packs`
 * rows and from the MCP / sync-daemon layers that would expose a
 * cross-user write surface in future iterations. The default
 * `allowOwner: true` reflects "Phase F.3 RBAC table" defaults — opt
 * back to admin-only by passing `{ allowOwner: false }` for surgical
 * cases (e.g. delete operations that should require an admin).
 */
export function assertCanEditKnowledge(
  actor: Actor,
  resource: { readonly createdByUserId?: string | null | undefined },
  opts: { readonly allowOwner?: boolean } = {},
): void {
  const allowOwner = opts.allowOwner ?? true;
  if (hasRole(actor, 'admin')) return;
  if (allowOwner && hasRole(actor, 'member')) {
    const owner = resource.createdByUserId ?? null;
    if (owner !== null && owner === actor.userId) return;
  }
  throw new ForbiddenError(
    `Requires admin role${allowOwner ? ' or member-ownership' : ''} to edit this knowledge artifact; actor has '${actor.role}'.`,
  );
}
