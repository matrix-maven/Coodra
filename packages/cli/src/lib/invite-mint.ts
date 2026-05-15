import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPostgresDb, postgresSchema } from '@coodra/db';

import { resolveCoodraHome } from './coodra-home.js';

/**
 * `packages/cli/src/lib/invite-mint.ts` — Phase H.5.
 *
 * Sign a team-invite token AND insert the matching `team_invites` row
 * in cloud Postgres, from the CLI side. Used by the top-level
 * `coodra invite <email>` command so admins don't have to leave
 * their terminal to mint an invite.
 *
 * Wire format MUST match `apps/web-v2/lib/invite-token.ts` exactly —
 * the web's `verifyInviteToken` reads COODRA_INVITE_HMAC_SECRET from
 * its own process env, but the same SECRET must be present in
 * `~/.coodra/.env` so both signers share it. The Phase H wizard
 * (see `finalize-config.ts`) writes the secret to `~/.coodra/.env`
 * during admin onboarding; the web's `next.config.ts` shim (Phase F.6+)
 * layers that file into the dev-server's process.env, so they agree.
 *
 * The token shape:
 *   base64url(canonical JSON payload).base64url(HMAC-SHA256(payload))
 *
 * The payload (sorted keys for determinism):
 *   { v: 1, jti, org, role, email, exp, iss }
 *
 * Defense in depth (echoes the web side):
 *   - 32-byte minimum secret
 *   - jti is 24 random bytes (single-use enforced by UNIQUE(jti) + the
 *     CONDITIONAL UPDATE in the redeem endpoint)
 *   - exp is unix seconds, 7-day default (override-able)
 */

const INVITE_TOKEN_VERSION = 1 as const;
const MIN_SECRET_BYTES = 32;

export type InviteRole = 'admin' | 'member' | 'viewer';

export interface InvitePayload {
  readonly v: typeof INVITE_TOKEN_VERSION;
  readonly jti: string;
  readonly org: string;
  readonly role: InviteRole;
  readonly email: string;
  readonly exp: number;
  readonly iss: string;
}

export class InviteSecretMissingError extends Error {
  override readonly name = 'InviteSecretMissingError';
}

/**
 * Read the COODRA_INVITE_HMAC_SECRET from `~/.coodra/.env`. Mirrors
 * the same heuristic as the web side: prefer 64-hex (32 bytes), fallback
 * to utf-8 bytes when long enough. Throws `InviteSecretMissingError` if
 * absent or too short.
 *
 * We intentionally do NOT read from process.env directly. The wizard
 * writes the secret to ~/.coodra/.env so it survives shell restarts;
 * `loadHomeEnv` only layers a key into process.env if it's unset, which
 * means a stale shell session can mask a freshly-written secret. Going
 * through the file is the authoritative path.
 */
export function loadInviteSecret(opts: { readonly homeOverride?: string } = {}): Buffer {
  const home = resolveCoodraHome(opts.homeOverride !== undefined ? { override: opts.homeOverride } : {});
  const envPath = join(home, '.env');
  let raw: string | null = null;
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^COODRA_INVITE_HMAC_SECRET=(\S+)/m);
    if (match !== null && match[1] !== undefined) {
      // Strip surrounding quotes when present.
      let value = match[1];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      raw = value;
    }
  }
  if (raw === null || raw.length === 0) {
    throw new InviteSecretMissingError(
      "COODRA_INVITE_HMAC_SECRET is not set in ~/.coodra/.env. Run `coodra team init` to generate one (or copy the value from your web deployment's env and add it to ~/.coodra/.env).",
    );
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const buf = Buffer.from(raw, 'utf-8');
  if (buf.length < MIN_SECRET_BYTES) {
    throw new InviteSecretMissingError(
      `COODRA_INVITE_HMAC_SECRET is too short (${buf.length} bytes < ${MIN_SECRET_BYTES}). Regenerate with \`openssl rand -hex 32\` or re-run \`coodra team init --reset-invite-secret\`.`,
    );
  }
  return buf;
}

/**
 * Generate a 24-byte (192-bit) base64url-encoded jti. Same shape as
 * `apps/web-v2/lib/invite-token.ts::newJti`.
 */
export function newJti(): string {
  return randomBytes(24).toString('base64url');
}

/** Canonical-JSON.stringify with sorted keys. */
function canonicalJsonStringify(obj: InvitePayload): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    ordered[key] = (obj as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

/** Sign + serialise the token. */
export function signInviteToken(payload: InvitePayload, secret: Buffer): string {
  const canonical = canonicalJsonStringify(payload);
  const encoded = Buffer.from(canonical, 'utf-8').toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest();
  return `${encoded}.${sig.toString('base64url')}`;
}

export interface MintInviteInput {
  readonly databaseUrl: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: InviteRole;
  readonly invitedByUserId: string;
  readonly baseUrl: string;
  /** Override 7-day default. */
  readonly expiresInDays?: number;
  /** Override secret resolution (tests). */
  readonly secretOverride?: Buffer;
  /** Override home for secret resolution (tests). */
  readonly homeOverride?: string;
}

export interface MintInviteResult {
  readonly token: string;
  readonly jti: string;
  readonly inviteUrl: string;
  readonly expiresAt: Date;
  readonly orgId: string;
  readonly email: string;
  readonly role: InviteRole;
}

/**
 * Mint a new team invite from the CLI side:
 *   1. Resolve HMAC secret (~/.coodra/.env or override)
 *   2. Generate jti + payload
 *   3. Sign HMAC token
 *   4. INSERT into cloud Postgres `team_invites`
 *   5. Return the invite URL the admin can share
 */
export async function mintInviteFromCli(input: MintInviteInput): Promise<MintInviteResult> {
  const secret =
    input.secretOverride !== undefined
      ? input.secretOverride
      : loadInviteSecret(input.homeOverride !== undefined ? { homeOverride: input.homeOverride } : {});

  const expiresInDays = input.expiresInDays ?? 7;
  const nowMs = Date.now();
  const expiresAtMs = nowMs + expiresInDays * 24 * 60 * 60 * 1000;
  const expiresAtSec = Math.floor(expiresAtMs / 1000);
  const expiresAt = new Date(expiresAtMs);

  const emailNormalized = input.email.toLowerCase().trim();
  const baseUrl = input.baseUrl.replace(/\/$/, '');
  const jti = newJti();

  const payload: InvitePayload = {
    v: INVITE_TOKEN_VERSION,
    jti,
    org: input.orgId,
    role: input.role,
    email: emailNormalized,
    exp: expiresAtSec,
    iss: baseUrl,
  };
  const token = signInviteToken(payload, secret);

  // Cloud insert. Mirrors apps/web-v2/lib/queries/invites.ts::insertInvite.
  const cloud = createPostgresDb({ databaseUrl: input.databaseUrl });
  try {
    await cloud.db.insert(postgresSchema.teamInvites).values({
      id: randomUUID(),
      orgId: input.orgId,
      email: emailNormalized,
      role: input.role,
      jti,
      invitedByUserId: input.invitedByUserId,
      clerkInvitationId: null,
      expiresAt,
    });
  } finally {
    await cloud.close?.();
  }

  return {
    token,
    jti,
    inviteUrl: `${baseUrl}/install/${token}`,
    expiresAt,
    orgId: input.orgId,
    email: emailNormalized,
    role: input.role,
  };
}
