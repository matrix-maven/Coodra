import { readVerifiedToken } from '@coodra/shared/auth';
import { readTeamConfig } from '@coodra/cli/lib/team-config';

/**
 * `apps/mcp-server/src/lib/actor-identity.ts` — Phase G slice G.6.
 *
 * The MCP-tool write-side identity resolver. Returns the active human-
 * actor's Clerk user id + org id, sourcing identity from the Phase G
 * verified token store as the primary path and the legacy
 * config.json::team.clerkUserId block as a deprecation fallback.
 *
 * Phase G change (2026-05-12): Pre-fix, this function read
 * `~/.coodra/config.json::team.clerkUserId` directly — a trust-
 * based identity model where any process with write access to
 * `~/.coodra/` could forge attribution. Phase G adds Clerk-signed
 * JWT verification via `readVerifiedToken` (from shared/auth) as the
 * primary path. The legacy config.json read is preserved as a
 * fallback so existing installs don't break overnight, but a
 * forthcoming Phase H removes it entirely.
 *
 * Trust hierarchy (highest first):
 *   1. `~/.coodra/clerk-token.json` (Phase G) — Clerk-signed,
 *      verified, unforgeable. `result.source === 'clerk'`.
 *   2. `~/.coodra/config.json::team` (legacy, deprecated) —
 *      trusted-but-unverified. `result.source === 'config'`. Removed
 *      in Phase H.
 *   3. None — solo mode, or team mode with no usable credential.
 *      Returns null. Callers writing in team mode use
 *      `requireActorIdentityForTeamMode` to refuse-with-soft-failure
 *      instead.
 *
 * Why not require Clerk in team mode here:
 *   - During the migration window, existing installs have
 *     config.json but no clerk-token.json yet. Hard-refusing on the
 *     spot would brick them.
 *   - The strict variant (`requireActorIdentityForTeamMode`) is what
 *     handlers use for mutating ops; the laxer variant
 *     (`getActorIdentity`) is what callers use when null-fallback is
 *     acceptable (read-only paths).
 *
 * Reads happen on every call (not cached at boot) so a `coodra
 * login` mid-session picks up the new identity without an MCP server
 * restart. The shared `readVerifiedToken` has its own 30s JWT cache,
 * so repeat reads inside a session don't hammer Clerk.
 */

export interface ActorIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly source: 'clerk' | 'config' | 'solo';
}

/**
 * Return the active actor identity, or null when solo / team-mode-
 * with-no-credential.
 *
 * Solo mode: returns null (no actor). Callers stamp NULL into the
 * `created_by_user_id` column.
 *
 * Team mode + verified Clerk token: returns the token's claims with
 * `source: 'clerk'`.
 *
 * Team mode + no Clerk token, legacy config.json present: returns
 * the config.json values with `source: 'config'` (deprecation
 * fallback). Logged at warn level by callers that want to nudge
 * users toward `coodra login`.
 *
 * Team mode + no credential at all: returns null. Callers must
 * decide whether to refuse the operation or proceed with NULL
 * attribution. Mutating handlers use `requireActorIdentityForTeamMode`
 * to refuse cleanly.
 */
export async function getActorIdentity(): Promise<ActorIdentity | null> {
  // Phase G primary path: verified Clerk JWT.
  try {
    const claims = await readVerifiedToken();
    if (claims !== null) {
      return { userId: claims.userId, orgId: claims.orgId, source: 'clerk' };
    }
  } catch {
    // ignore — fall through to legacy path
  }

  // Legacy deprecation fallback: config.json::team.
  const cfg = readTeamConfig();
  if (cfg.mode === 'team' && cfg.team !== undefined) {
    return { userId: cfg.team.clerkUserId, orgId: cfg.team.clerkOrgId, source: 'config' };
  }

  // Solo or no credential.
  return null;
}

/**
 * Strict variant — refuses to proceed in team mode when no verified
 * Clerk token is available. Returns one of:
 *
 *   - `{ kind: 'identity', actor }` — proceed; actor.source ∈ {clerk, config, solo}
 *   - `{ kind: 'auth_required', howToFix }` — handler must return
 *     a soft-failure with this message and refuse the write
 *
 * Phase G policy: in team mode, mutating handlers MUST have a
 * Clerk-verified token. The `getActorIdentity` legacy fallback to
 * config.json is allowed for READ paths only — write paths refuse to
 * stamp unverified identity on durable rows.
 *
 * The "auth_required" path's howToFix is consistent across MCP /
 * bridge / web so the agent surfaces the same remediation message
 * everywhere: "Run `coodra login` to authenticate."
 *
 * Solo mode: short-circuits to `{ kind: 'identity', actor: solo }`.
 * No Clerk token needed; the write column gets NULL.
 */
export type RequireActorResult =
  | { readonly kind: 'identity'; readonly actor: ActorIdentity | null }
  | {
      readonly kind: 'auth_required';
      readonly howToFix: string;
    };

export async function requireActorIdentityForTeamMode(): Promise<RequireActorResult> {
  // Resolve mode from config.json (the canonical "is this machine in
  // team mode?" signal). Solo mode is the default + safe fallback.
  const cfg = readTeamConfig();
  if (cfg.mode !== 'team') {
    return { kind: 'identity', actor: null };
  }

  // Team mode — require a Clerk-verified token.
  let claims;
  try {
    claims = await readVerifiedToken();
  } catch {
    claims = null;
  }

  if (claims !== null) {
    return { kind: 'identity', actor: { userId: claims.userId, orgId: claims.orgId, source: 'clerk' } };
  }

  // No verified token. Refuse the write.
  return {
    kind: 'auth_required',
    howToFix:
      'Run `coodra login` in your terminal to authenticate with Clerk. Phase G requires a verified Clerk session for all mutating MCP tool calls in team mode.',
  };
}
