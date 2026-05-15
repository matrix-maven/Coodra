import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { readTeamConfig } from '@coodra/cli/lib/team-config';

/**
 * `apps/hooks-bridge/src/lib/actor-identity.ts` — Phase G slice G.7.
 *
 * Reads the active human-actor identity for stamping `created_by_user_id`
 * on bridge writes.
 *
 * Phase G trust hierarchy (highest first):
 *
 *   1. `~/.coodra/clerk-token.json::claimsMirror` (Phase G primary).
 *      The mirror was written by `writeToken` in shared/auth, which
 *      ALREADY verified the JWT signature before persisting. So the
 *      on-disk mirror is trusted as long as the file isn't tampered
 *      (file mode 0600 prevents same-user tampering by other UIDs).
 *      This path is SYNCHRONOUS — no per-event JWT verify network
 *      round-trip. The bridge already does dozens of disk ops per
 *      hook event; one more sync JSON read is in the noise.
 *
 *   2. `~/.coodra/config.json::team` (legacy, deprecation fallback).
 *      Used only when no clerk-token.json exists. Removed in Phase H
 *      after a deprecation window.
 *
 *   3. None → null (solo mode, or team mode with no credential).
 *
 * Why NOT verify the JWT signature on every event:
 *   - The CLI's `coodra login` verified the JWT BEFORE writing the
 *     file. We trust the disk-side-of-write.
 *   - JWT verification involves JWKS fetch (cached but still network
 *     possible) which would add p50 ~5-50ms per hook event. The
 *     §6 hot-path SLA is 200ms; spending 50ms on every event just
 *     for paranoia is a poor trade.
 *   - File-system permissions (0600) prevent same-machine tampering
 *     by other users. Same-user processes that can read 0600 files
 *     can also overwrite them — the trust boundary is "no privilege
 *     escalation on this UID".
 *   - The MCP server (G.6) DOES verify on every tool call because
 *     mutating tool calls are rare (low frequency) and the cost is
 *     amortized by the 30s claim cache in shared/auth.
 *
 * The function stays synchronous so the existing `resolveActorIdentity:
 * () => ActorIdentity | null` contract in `run-recorder.ts` doesn't
 * have to change. Async would force every recorder call site to
 * await, blasting the surface area.
 */

export interface ActorIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly source: 'clerk' | 'config';
}

const TOKEN_FILENAME = 'clerk-token.json';

interface StoredTokenShape {
  readonly version: number;
  readonly token: string;
  readonly fetchedAt: number;
  readonly claimsMirror?: {
    readonly userId: string;
    readonly orgId: string;
    readonly role: 'admin' | 'member' | 'viewer';
    readonly email: string | null;
    readonly expiresAt: string;
  };
}

function resolveTokenPath(): string {
  const home = process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');
  return resolve(home, TOKEN_FILENAME);
}

function readClerkTokenMirror(): ActorIdentity | null {
  const path = resolveTokenPath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: StoredTokenShape;
  try {
    parsed = JSON.parse(raw) as StoredTokenShape;
  } catch {
    return null;
  }
  const mirror = parsed.claimsMirror;
  if (mirror === undefined) return null;
  if (typeof mirror.userId !== 'string' || mirror.userId.length === 0) return null;
  if (typeof mirror.orgId !== 'string' || mirror.orgId.length === 0) return null;
  // Sanity-check expiry — if the mirror says the token has expired,
  // refuse the attribution. The CLI's `coodra login` will refresh
  // claimsMirror on next login; until then we fall back to legacy
  // config or null.
  try {
    const expiresAt = new Date(mirror.expiresAt);
    if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
      return null;
    }
  } catch {
    // expiresAt parse failure → refuse to use the mirror
    return null;
  }
  return { userId: mirror.userId, orgId: mirror.orgId, source: 'clerk' };
}

export function getActorIdentity(): ActorIdentity | null {
  // Phase G primary path: read claimsMirror from clerk-token.json.
  const clerk = readClerkTokenMirror();
  if (clerk !== null) return clerk;

  // Legacy fallback: config.json::team (removed in Phase H).
  const cfg = readTeamConfig();
  if (cfg.mode === 'team' && cfg.team !== undefined) {
    return { userId: cfg.team.clerkUserId, orgId: cfg.team.clerkOrgId, source: 'config' };
  }

  return null;
}
