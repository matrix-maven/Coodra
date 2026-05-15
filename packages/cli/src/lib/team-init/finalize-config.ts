import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCoodraConfigJson, resolveCoodraHome } from '../coodra-home.js';
import { upgradeToTeamConfig, writeTeamHomeEnv } from '../team-config.js';

/**
 * `packages/cli/src/lib/team-init/finalize-config.ts` — Phase B
 * (clarity-pass-plan, 2026-05-11). The final write step for the admin
 * onboarding wizard.
 *
 * Given the resolved inputs from the Postgres + Clerk bootstraps, glue
 * them together by:
 *   1. Generating a 32-byte hex local hook secret (unless one was passed
 *      — used for re-init or secret-rotation flows).
 *   2. Writing `~/.coodra/config.json` with the team block.
 *   3. Writing `~/.coodra/.env` with the four env keys
 *      (`COODRA_MODE`, `DATABASE_URL`, `LOCAL_HOOK_SECRET`,
 *      `COODRA_TEAM_ORG_ID`) — preserving any non-team entries.
 *
 * Both writes go through `team-config.ts` helpers, which use atomic
 * tmpfile + rename. If a crash lands mid-write, the prior file remains
 * intact. The TWO writes are independent though — a crash between them
 * leaves config.json updated but .env unchanged. Phase A's doctor check
 * 36 detects this state and routes the operator to re-run `team init`.
 *
 * No IO of its own beyond what `team-config.ts` provides; therefore
 * pure-function-ish (deterministic given inputs + clock). Test surface
 * accepts a `homeOverride` so unit tests don't touch the real home.
 */

export interface FinalizeConfigInput {
  readonly databaseUrl: string;
  readonly clerkUserId: string;
  readonly clerkOrgId: string;
  readonly clerkOrgSlug: string | null;
  /**
   * Pre-supplied local hook secret. When absent, generated as a fresh
   * 32-byte hex string. Pass-through is used for re-init / re-keying
   * flows where the secret must match an existing cloud entry.
   */
  readonly localHookSecret?: string;
  /**
   * Phase H.4 — invite HMAC secret. When the wizard re-runs and the
   * value is already in `~/.coodra/.env`, we keep it (so previously
   * minted invites still verify). When absent, a fresh 32-byte hex is
   * generated.
   */
  readonly inviteHmacSecret?: string;
  /**
   * Phase H.4 — Clerk credentials persisted to `~/.coodra/.env` so
   * the local web (next.config.ts shim layers the file into process.env)
   * can verify JWTs without the admin manually setting env vars.
   *
   * NOTE: this is the SAME secret key the admin pasted into the wizard
   * (sk_test_/sk_live_). We persist it locally so subsequent CLI
   * commands + the local web both have it. In production-cloud
   * deployments the operator sets these env vars on the cloud directly;
   * the local file is the laptop-only path.
   */
  readonly clerkSecretKey?: string;
  readonly clerkPublishableKey?: string;
  /** Override for tests; defaults to the real `~/.coodra` resolution. */
  readonly homeOverride?: string;
}

export interface FinalizeConfigResult {
  /** The (possibly newly-generated) local hook secret. Surface for display. */
  readonly localHookSecret: string;
  /** The (possibly newly-generated) invite HMAC secret. Phase H.4. */
  readonly inviteHmacSecret: string;
  /** Path of the config.json that was written. */
  readonly configPath: string;
  /** Path of the .env that was written. */
  readonly envPath: string;
  /** Wall-clock ms — for the wizard's "joined" stamp. */
  readonly joinedAt: number;
}

/**
 * Phase H.4 — preserve-or-generate the COODRA_INVITE_HMAC_SECRET +
 * other extra-env keys. We read whatever is currently in
 * `~/.coodra/.env` so re-running the wizard doesn't rotate the
 * invite secret (which would invalidate every previously-minted invite
 * link the admin already shared).
 */
function readExistingExtras(envPath: string): {
  inviteHmacSecret: string | null;
  clerkSecretKey: string | null;
  clerkPublishableKey: string | null;
} {
  if (!existsSync(envPath)) {
    return { inviteHmacSecret: null, clerkSecretKey: null, clerkPublishableKey: null };
  }
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return { inviteHmacSecret: null, clerkSecretKey: null, clerkPublishableKey: null };
  }
  const grab = (key: string): string | null => {
    const m = content.match(new RegExp(`^${key}=(\\S+)`, 'm'));
    if (m === null || m[1] === undefined) return null;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.length > 0 ? v : null;
  };
  return {
    inviteHmacSecret: grab('COODRA_INVITE_HMAC_SECRET'),
    clerkSecretKey: grab('CLERK_SECRET_KEY'),
    clerkPublishableKey: grab('CLERK_PUBLISHABLE_KEY'),
  };
}

/**
 * Phase H.4 — append-or-update an arbitrary key in `~/.coodra/.env`.
 * Idempotent — replaces the existing line in place when present,
 * appends to the file end when absent. Atomic via tmp+rename.
 *
 * Mirrors the contract of `writeTeamHomeEnv` for the four primary keys
 * but works generically. Used to land the three Phase H additions:
 *
 *   COODRA_INVITE_HMAC_SECRET
 *   CLERK_SECRET_KEY
 *   CLERK_PUBLISHABLE_KEY
 *
 * Without these alongside the four primaries, the local web cannot
 * verify CLI-minted invite tokens (HMAC mismatch) and the JWT
 * verifier can't reach Clerk's JWKS.
 */
/**
 * W4 (2026-05-13) — remove a key from `~/.coodra/.env` if present.
 * Idempotent: missing file or missing key is a no-op. Atomic via tmp+
 * rename for the same partial-write safety as `upsertEnvKey`.
 *
 * Used by `coodra stop` to peel the ephemeral COODRA_PUBLIC_URL
 * the tunnel wrote, so a subsequent `coodra start` (without
 * `--tunnel`) doesn't keep using the now-dead tunnel hostname.
 */
export function removeEnvKey(envPath: string, key: string): void {
  if (!existsSync(envPath)) return;
  let existing: string;
  try {
    existing = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  const lines = existing.split('\n');
  const out: string[] = [];
  let removed = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      out.push(rawLine);
      continue;
    }
    const eq = trimmed.indexOf('=');
    const lineKey = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (lineKey === key) {
      removed = true;
      continue;
    }
    out.push(rawLine);
  }
  if (!removed) return;
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmpPath, envPath);
}

export function upsertEnvKey(envPath: string, key: string, value: string): void {
  let existing = '';
  if (existsSync(envPath)) {
    try {
      existing = readFileSync(envPath, 'utf8');
    } catch {
      existing = '';
    }
  }
  const lines = existing.split('\n');
  let replaced = false;
  const out: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      out.push(rawLine);
      continue;
    }
    const eq = trimmed.indexOf('=');
    const lineKey = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (lineKey === key) {
      out.push(`${key}=${value}`);
      replaced = true;
    } else {
      out.push(rawLine);
    }
  }
  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(`${key}=${value}`);
  }
  // Strip trailing blanks, ensure trailing newline.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  mkdirSync(envPath.substring(0, envPath.lastIndexOf('/')), { recursive: true });
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmpPath, envPath);
}

export function finalizeConfig(input: FinalizeConfigInput): FinalizeConfigResult {
  const localHookSecret =
    input.localHookSecret !== undefined && input.localHookSecret.length > 0
      ? input.localHookSecret
      : randomBytes(32).toString('hex');

  const joinedAt = Date.now();

  // Atomic write 1 — config.json::team block.
  upgradeToTeamConfig(
    {
      clerkUserId: input.clerkUserId,
      clerkOrgId: input.clerkOrgId,
      ...(input.clerkOrgSlug !== null ? { clerkOrgSlug: input.clerkOrgSlug } : {}),
      localHookSecret,
      joinedAt,
    },
    input.homeOverride !== undefined ? { homeOverride: input.homeOverride } : {},
  );

  // Atomic write 2 — ~/.coodra/.env merge for the four primary keys.
  writeTeamHomeEnv(
    {
      databaseUrl: input.databaseUrl,
      localHookSecret,
      clerkOrgId: input.clerkOrgId,
    },
    input.homeOverride !== undefined ? { homeOverride: input.homeOverride } : {},
  );

  const home = input.homeOverride !== undefined ? input.homeOverride : resolveCoodraHome();
  const configPath = resolveCoodraConfigJson(home);
  // .env path is co-located with config.json under the same home.
  const envPath = join(home, '.env');

  // Phase H.4 — preserve-or-generate the invite HMAC secret. Reading
  // the existing value avoids invalidating already-shared invite links
  // on wizard re-run.
  const existing = readExistingExtras(envPath);
  const inviteHmacSecret =
    input.inviteHmacSecret !== undefined && input.inviteHmacSecret.length > 0
      ? input.inviteHmacSecret
      : (existing.inviteHmacSecret ?? randomBytes(32).toString('hex'));

  upsertEnvKey(envPath, 'COODRA_INVITE_HMAC_SECRET', inviteHmacSecret);

  // Phase H.4 — persist Clerk keys to the env file so the local web
  // (next.config.ts shim) and CLI both see them without the admin
  // having to copy values around. Wizard-pre-loaded values win;
  // otherwise we keep whatever's already there.
  const clerkSecretKey = input.clerkSecretKey ?? existing.clerkSecretKey;
  if (clerkSecretKey !== null && clerkSecretKey !== undefined && clerkSecretKey.length > 0) {
    upsertEnvKey(envPath, 'CLERK_SECRET_KEY', clerkSecretKey);
  }
  const clerkPublishableKey = input.clerkPublishableKey ?? existing.clerkPublishableKey;
  if (clerkPublishableKey !== null && clerkPublishableKey !== undefined && clerkPublishableKey.length > 0) {
    upsertEnvKey(envPath, 'CLERK_PUBLISHABLE_KEY', clerkPublishableKey);
  }

  return { localHookSecret, inviteHmacSecret, configPath, envPath, joinedAt };
}
