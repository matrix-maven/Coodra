import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { createLogger } from '../logger.js';
import type { AuthEnv } from './types.js';
import {
  clearVerifyClerkJwtCache,
  verifyClerkJwtAndExtractClaims,
  type VerifiedClerkClaims,
} from './verify-clerk-jwt.js';

/**
 * `@coodra/shared/auth/clerk-token-store` — Phase G slice G.1.
 *
 * The on-disk identity record every Phase G consumer reads on every
 * write operation. Solves the trust-based identity gap surfaced in
 * Phase F.6+ where `config.json::team.clerkUserId` was a forgeable
 * string nobody verified.
 *
 * File: `~/.coodra/clerk-token.json` (or `${COODRA_HOME}/clerk-token.json`).
 * Mode: 0600. Format: see `StoredTokenSchema` below.
 *
 * Consumers and their flow:
 *   - CLI commands           → `readVerifiedToken()` before any mutation.
 *                              On null → "Run `coodra login` to re-authenticate." + exit non-zero.
 *   - MCP child handlers     → same pattern, but return soft-failure
 *                              `{ ok: false, error: 'auth_required' }`.
 *   - hooks-bridge handlers  → same pattern; respond 401 on missing/expired.
 *   - sync-daemon            → reads on startup to scope cloud pull queries.
 *
 * Why disk-based, not env-based:
 *   - Long-running daemons need to pick up new tokens AFTER login
 *     without restart. Disk-read-on-every-op (cheap, file system cache
 *     handles repeat reads) wins over env (process restart required).
 *   - Process env leaks through `ps aux` on Unix; mode-0600 file
 *     restricts to owner only.
 *   - Lets `coodra logout` actually log out in-flight MCP children
 *     mid-tool-call (next read returns null → soft-failure).
 *
 * Why verify on every read (not just on write):
 *   - Token may have been written by an old version of the file with
 *     a stale signature.
 *   - Token may have been tampered (someone edited the file).
 *   - Expiry checks need to happen at read time, not write time —
 *     a 24h token written this morning expires this evening even
 *     though disk content didn't change.
 *
 * The 30s in-memory cache (in `verify-clerk-jwt`) prevents the
 * Clerk JWKS round-trip from firing on every MCP tool call; the
 * 600ms typical JWT-decode + JWKS-cache-hit cost is well under
 * the 200ms hook-bridge SLA.
 */

const log = createLogger('clerk-token-store');

const TOKEN_FILENAME = 'clerk-token.json';
const FILE_MODE = 0o600;

/**
 * On-disk shape. Versioned so future field additions (refresh token,
 * device fingerprint, etc.) can land without breaking existing files.
 * The `claims` mirror is for diagnostic UX (CLI `coodra whoami`
 * shouldn't have to re-verify just to print the user's email) — the
 * authoritative claims always come from re-verifying `token`.
 */
const StoredTokenSchema = z
  .object({
    version: z.literal(1),
    token: z.string().min(1),
    webUrl: z.string().min(1),
    fetchedAt: z.number().int(),
    /**
     * Diagnostic mirror of the token's claims at write time. NEVER
     * trusted by `readVerifiedToken` — that function always re-verifies
     * the JWT signature. Present so `whoami` / `org status` can print
     * email/role without paying the verify cost.
     */
    claimsMirror: z
      .object({
        userId: z.string(),
        orgId: z.string(),
        role: z.enum(['admin', 'member', 'viewer']),
        email: z.string().nullable(),
        expiresAt: z.string(),
      })
      .optional(),
  })
  .strict();

export type StoredToken = z.infer<typeof StoredTokenSchema>;

export interface TokenStoreOptions {
  readonly homeOverride?: string;
  /**
   * Override the Clerk env used for verification. Useful in tests; in
   * production the env comes from `~/.coodra/.env` via
   * `loadHomeEnvForVerify`.
   */
  readonly envOverride?: AuthEnv;
}

/**
 * Resolves the absolute path to the token file. Order:
 *   1. `opts.homeOverride` (test-side injection)
 *   2. `process.env.COODRA_HOME`
 *   3. `~/.coodra`
 */
export function getClerkTokenPath(homeOverride?: string): string {
  const home = homeOverride ?? process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');
  return resolve(home, TOKEN_FILENAME);
}

/**
 * Reads `~/.coodra/.env` and returns just the keys the JWT verifier
 * needs. Returns `{}` (which the verifier will reject) if the file is
 * missing — caller decides whether to treat that as "no auth in this
 * mode" (solo) or "auth required, prompt login" (team).
 *
 * We use a minimal in-line parser instead of the `dotenv` package to
 * keep `packages/shared` zero-dep on dotenv (CLI already has it, but
 * shared has tighter dep hygiene rules).
 */
/**
 * Phase H.6 (2026-05-13) — solo-bypass sentinel detection.
 *
 * `coodra init` writes `CLERK_SECRET_KEY=sk_test_replace_me` and
 * `CLERK_PUBLISHABLE_KEY=pk_test_replace_me` into every project's
 * `.env` as solo-mode placeholders. When the CLI's env-bootstrap shim
 * runs from inside such a project dir, the project `.env` flows into
 * `process.env`, the sentinels mask the real keys from
 * `~/.coodra/.env`, and JWT verification fails with
 * `CLERK_SECRET_KEY is the solo-bypass sentinel`. That falls back to
 * the (forgeable) `config.json::team.clerkUserId` — regressing the
 * Phase G tamper-safety invariant.
 *
 * Fix: when the value seen in process.env is one of these solo-mode
 * sentinels, treat it as "not present" and prefer the value from the
 * authoritative `~/.coodra/.env` file. This makes the home value
 * always win for team-mode JWT verification regardless of which
 * project directory the CLI was launched from.
 */
const SOLO_BYPASS_SENTINELS: ReadonlySet<string> = new Set([
  'sk_test_replace_me',
  'pk_test_replace_me',
]);

function isRealKey(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return !SOLO_BYPASS_SENTINELS.has(value);
}

export function loadHomeEnvForVerify(homeOverride?: string): AuthEnv {
  const home = homeOverride ?? process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');
  const envPath = resolve(home, '.env');
  if (!existsSync(envPath)) {
    return {
      CLERK_SECRET_KEY: isRealKey(process.env.CLERK_SECRET_KEY) ? process.env.CLERK_SECRET_KEY : undefined,
      CLERK_PUBLISHABLE_KEY: isRealKey(process.env.CLERK_PUBLISHABLE_KEY) ? process.env.CLERK_PUBLISHABLE_KEY : undefined,
      CLERK_JWT_ISSUER: process.env.CLERK_JWT_ISSUER ?? null,
      COODRA_MODE: process.env.COODRA_MODE === 'team' || process.env.COODRA_MODE === 'solo'
        ? process.env.COODRA_MODE
        : undefined,
    };
  }
  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  // Phase H.6 — for Clerk keys: prefer process.env BUT skip the
  // solo-bypass sentinels (which `coodra init` writes to project
  // `.env`s). Home file is the authoritative source. For other keys,
  // process.env wins as before (operator override / test injection).
  const mergeClerk = (key: 'CLERK_SECRET_KEY' | 'CLERK_PUBLISHABLE_KEY'): string | undefined => {
    const proc = process.env[key];
    if (isRealKey(proc)) return proc;
    return parsed[key];
  };
  const merge = (key: string): string | undefined => process.env[key] ?? parsed[key];
  const modeRaw = merge('COODRA_MODE');
  return {
    CLERK_SECRET_KEY: mergeClerk('CLERK_SECRET_KEY'),
    CLERK_PUBLISHABLE_KEY: mergeClerk('CLERK_PUBLISHABLE_KEY'),
    CLERK_JWT_ISSUER: merge('CLERK_JWT_ISSUER') ?? null,
    COODRA_MODE: modeRaw === 'team' || modeRaw === 'solo' ? modeRaw : undefined,
  };
}

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip matching single/double quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Reads + verifies the token. Returns null on any failure (missing
 * file, malformed JSON, expired, tampered, missing Clerk env).
 *
 * Every failure path is logged at WARN level with the path + reason
 * so an operator running `coodra doctor` (or just tailing logs)
 * can diagnose "why are my writes refused?".
 *
 * Callers branch on null vs non-null. They do NOT call `loadHomeEnv`
 * themselves; this function handles env resolution internally.
 */
export async function readVerifiedToken(opts: TokenStoreOptions = {}): Promise<VerifiedClerkClaims | null> {
  const path = getClerkTokenPath(opts.homeOverride);
  if (!existsSync(path)) {
    return null;
  }

  // Best-effort permissions warning. Doesn't refuse — operator might
  // have run `cp` and lost the mode; we tell them but still serve the
  // token. The Clerk JWT signature is the real security boundary.
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    if (mode !== FILE_MODE) {
      log.warn(
        { path, mode: mode.toString(8) },
        `clerk-token.json has mode ${mode.toString(8)} (expected 0600). Run \`chmod 600 ${path}\` to lock it down.`,
      );
    }
  } catch {
    // statSync failure is recoverable — the readFile below will surface the real error.
  }

  let stored: StoredToken;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    stored = StoredTokenSchema.parse(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ path, err: message, event: 'token_file_unreadable' }, 'clerk-token.json: unreadable or malformed');
    return null;
  }

  const env = opts.envOverride ?? loadHomeEnvForVerify(opts.homeOverride);

  try {
    return await verifyClerkJwtAndExtractClaims(stored.token, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ path, err: message, event: 'token_verify_failed' }, 'clerk-token.json: JWT verification failed');
    return null;
  }
}

/**
 * Writes a fresh token. Throws if the token does not verify against
 * the current Clerk env — fail-fast at write so we don't store a
 * known-bad token on disk.
 *
 * Returns the verified claims so callers don't have to round-trip
 * through `readVerifiedToken` immediately after.
 */
export async function writeToken(
  token: string,
  webUrl: string,
  opts: TokenStoreOptions = {},
): Promise<VerifiedClerkClaims> {
  const env = opts.envOverride ?? loadHomeEnvForVerify(opts.homeOverride);
  // Throws if invalid — propagate to caller so `coodra login` can
  // surface a clean error.
  const claims = await verifyClerkJwtAndExtractClaims(token, env);

  const path = getClerkTokenPath(opts.homeOverride);
  mkdirSync(dirname(path), { recursive: true });

  const stored: StoredToken = {
    version: 1,
    token,
    webUrl,
    fetchedAt: Date.now(),
    claimsMirror: {
      userId: claims.userId,
      orgId: claims.orgId,
      role: claims.role,
      email: claims.email,
      expiresAt: claims.expiresAt.toISOString(),
    },
  };

  // Two-step: write then chmod. writeFileSync's `mode` option respects
  // umask, so we explicitly chmod afterwards to guarantee 0600 on
  // every platform.
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      `clerk-token.json: chmod 0600 failed. Run \`chmod 600 ${path}\` manually.`,
    );
  }

  // Invalidate verify cache so the next `readVerifiedToken` doesn't
  // serve stale claims for an old token at the same key.
  clearVerifyClerkJwtCache();

  log.info(
    { path, userId: claims.userId, orgId: claims.orgId, role: claims.role, event: 'token_written' },
    'clerk-token.json written',
  );

  return claims;
}

/**
 * Deletes the token. Idempotent — missing file is not an error.
 * Always clears the verify cache so any in-flight handler holding a
 * cached claim doesn't keep serving requests as the logged-out user.
 */
export function deleteToken(opts: TokenStoreOptions = {}): void {
  const path = getClerkTokenPath(opts.homeOverride);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
      log.info({ path, event: 'token_deleted' }, 'clerk-token.json deleted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ path, err: message }, 'clerk-token.json: delete failed');
      throw err;
    }
  }
  clearVerifyClerkJwtCache();
}

/**
 * Lightweight existence check that does NOT verify the token. Useful
 * for CLI status commands ("are we logged in?") that don't want to
 * make a Clerk JWKS round-trip just to render a banner.
 *
 * Note: a present file might still be expired/tampered. For "is this
 * a real authenticated session?" use `readVerifiedToken` and check
 * for non-null.
 */
export function hasStoredToken(opts: TokenStoreOptions = {}): boolean {
  return existsSync(getClerkTokenPath(opts.homeOverride));
}
