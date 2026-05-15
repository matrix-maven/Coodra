import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * `apps/web-v2/lib/invite-token.ts` — sign + verify the team-invite
 * bootstrap token (M04 Phase 2). Pure crypto + JSON; no DB / Clerk
 * dependency so the function is trivially testable.
 *
 * Wire format (text, dot-separated, URL-safe):
 *
 *     <base64url(payload)>.<base64url(HMAC-SHA256(secret, base64url(payload)))>
 *
 * The payload is a JSON object with the shape `InviteTokenPayload` below.
 *
 * Why HMAC-SHA256 and not a Clerk-issued JWT:
 *   - Single dependency: no extra Clerk API call to sign/verify each
 *     `/install/[token]` request. The deployment already holds the
 *     HMAC secret as an env var, so verification is a 1µs hash.
 *   - The token's role is purely "did the admin who deployed this
 *     server vouch for this email + role + jti?". Clerk handles the
 *     "is this the right person?" half via the redeemer's signed-in
 *     session in `/api/install/[token]/route.ts`.
 *   - No exposure surface on Clerk's secret key in the install bundle
 *     — see caveat A from the Phase 2 design.
 *
 * Why a 32-byte minimum on the secret:
 *   - HMAC-SHA256 security collapses if the key is short. 32 bytes is
 *     the SHA-256 output size and the standard minimum. We enforce it
 *     in `assertInviteSecret()` and surface a remediation message at
 *     module load so deployments that forgot to set
 *     `COODRA_INVITE_HMAC_SECRET` fail loud, not silently.
 *
 * The module is `server-only` because the HMAC secret must never leak
 * to a client bundle. Importing this from a client component is a
 * Next.js build error.
 */

const INVITE_TOKEN_VERSION = 1 as const;

// 'admin' | 'member' | 'viewer' — matches ADR-014 Tier 2.5.
const ROLE_SCHEMA = z.enum(['admin', 'member', 'viewer']);

export const inviteTokenPayloadSchema = z
  .object({
    v: z.literal(INVITE_TOKEN_VERSION),
    jti: z.string().min(16).max(64), // UUID-ish, hex or base64url, anything in this range
    org: z.string().min(1), // Clerk org_id (org_2…)
    role: ROLE_SCHEMA,
    email: z.string().email(),
    exp: z.number().int().positive(), // unix seconds
    iss: z.string().url().or(z.string().min(1)), // deployment base URL (or hostname for tests)
  })
  .strict();

export type InviteTokenPayload = z.infer<typeof inviteTokenPayloadSchema>;
export type InviteRole = z.infer<typeof ROLE_SCHEMA>;

const MIN_SECRET_BYTES = 32;

/**
 * Resolve + validate the HMAC secret from env. Fail-loud on missing /
 * too-short / non-hex. Called by every sign/verify entry point so a
 * misconfigured deploy fails at the first request, not silently with
 * a trivially-forgeable signature.
 *
 * Accepts the secret as either:
 *   - hex (64 chars = 32 bytes), or
 *   - utf-8 string ≥ 32 bytes raw length
 *
 * The hex form is recommended (produced by `openssl rand -hex 32`);
 * raw utf-8 is accepted so emergency rotation via a copy-pasted
 * password works.
 */
function loadInviteSecret(): Buffer {
  const raw = process.env.COODRA_INVITE_HMAC_SECRET;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InviteSecretMissingError(
      "COODRA_INVITE_HMAC_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to the deployment env, then redeploy.",
    );
  }
  // Prefer hex when the string looks like hex (64 chars, [0-9a-f]).
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Fallback: utf-8 raw bytes. Require ≥ 32 bytes.
  const buf = Buffer.from(raw, 'utf-8');
  if (buf.length < MIN_SECRET_BYTES) {
    throw new InviteSecretMissingError(
      `COODRA_INVITE_HMAC_SECRET is too short (${buf.length} bytes < ${MIN_SECRET_BYTES}). Regenerate with \`openssl rand -hex 32\`.`,
    );
  }
  return buf;
}

/**
 * Thrown when the HMAC secret is missing or invalid. Distinct error
 * class so callers in `lib/actions/invite.ts` and the redeem route can
 * surface a remediation panel instead of a generic 500.
 */
export class InviteSecretMissingError extends Error {
  override readonly name = 'InviteSecretMissingError';
}

/** Lightweight base64url helpers — Node 22 has built-in support. */
function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Sign the invite token. Pure function: takes the payload + the
 * already-loaded secret. The exported wrapper `signInviteToken` reads
 * the secret from env and delegates here.
 */
function signWithSecret(payload: InviteTokenPayload, secret: Buffer): string {
  // Sort keys for deterministic JSON. Two callers signing the same
  // payload object MUST produce the same token; relying on JS object
  // key order is brittle.
  const sortedJson = canonicalJsonStringify(payload);
  const encoded = b64urlEncode(Buffer.from(sortedJson, 'utf-8'));
  const sig = createHmac('sha256', secret).update(encoded).digest();
  return `${encoded}.${b64urlEncode(sig)}`;
}

/**
 * Sign an invite-token payload. Throws `InviteSecretMissingError` if
 * the env secret is missing/short. The returned string is the entire
 * token (payload + signature) — embed directly in URL paths.
 */
export function signInviteToken(payload: InviteTokenPayload): string {
  const parsed = inviteTokenPayloadSchema.parse(payload);
  const secret = loadInviteSecret();
  return signWithSecret(parsed, secret);
}

/**
 * Discriminated-union verify result. Always returns; never throws on
 * bad input. Callers branch on `.ok` for the error path; on success
 * they read `.payload`.
 *
 * Error reasons are stable strings so the redeem route can return a
 * specific HTTP status + structured body for each:
 *   - `malformed`            → token isn't `<b64>.<b64>` shape
 *   - `bad_signature`        → HMAC mismatch (forgery or wrong secret)
 *   - `bad_payload`          → payload JSON didn't validate against schema
 *   - `expired`              → payload.exp < now
 *   - `secret_misconfigured` → env secret missing / too short (rare,
 *                              admin should re-set COODRA_INVITE_HMAC_SECRET)
 */
export type VerifyResult =
  | { readonly ok: true; readonly payload: InviteTokenPayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'bad_payload' | 'expired' | 'secret_misconfigured'; readonly howToFix: string };

/**
 * Verify an invite token. Returns a `VerifyResult` discriminated
 * union; never throws on user input. Throws only if `nowSeconds` is
 * negative (programming bug).
 *
 * `nowSeconds` is an explicit parameter so tests can pin time without
 * mocking `Date.now()`. Production callers pass `Math.floor(Date.now()
 * / 1000)`.
 */
export function verifyInviteToken(token: string, nowSeconds: number): VerifyResult {
  if (nowSeconds < 0) throw new Error('verifyInviteToken: nowSeconds must be non-negative');

  let secret: Buffer;
  try {
    secret = loadInviteSecret();
  } catch (err) {
    if (err instanceof InviteSecretMissingError) {
      return { ok: false, reason: 'secret_misconfigured', howToFix: err.message };
    }
    throw err;
  }

  const dot = token.indexOf('.');
  if (dot === -1 || dot === 0 || dot === token.length - 1) {
    return { ok: false, reason: 'malformed', howToFix: 'Token is not in the expected `<payload>.<signature>` shape.' };
  }
  const encodedPayload = token.slice(0, dot);
  const encodedSig = token.slice(dot + 1);

  let actualSig: Buffer;
  try {
    actualSig = b64urlDecode(encodedSig);
  } catch {
    return { ok: false, reason: 'malformed', howToFix: 'Token signature segment is not valid base64url.' };
  }
  const expectedSig = createHmac('sha256', secret).update(encodedPayload).digest();
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    return {
      ok: false,
      reason: 'bad_signature',
      howToFix:
        'The invite token signature does not match. Ask the admin to mint a new invite (the link may have been tampered with, or the deployment has a different `COODRA_INVITE_HMAC_SECRET`).',
    };
  }

  let json: unknown;
  try {
    const raw = b64urlDecode(encodedPayload).toString('utf-8');
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'bad_payload', howToFix: 'Token payload is not valid base64url-encoded JSON.' };
  }
  const parsed = inviteTokenPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'bad_payload',
      howToFix: `Token payload failed schema validation: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
    };
  }
  if (parsed.data.exp <= nowSeconds) {
    return {
      ok: false,
      reason: 'expired',
      howToFix: 'This invite has expired. Ask the admin to mint a fresh one from /settings/team.',
    };
  }
  return { ok: true, payload: parsed.data };
}

/**
 * Generate a 24-byte (192-bit) random jti, base64url-encoded (32 chars
 * stripped of padding). The jti must be unique per invite — uniqueness
 * is enforced at the `team_invites.jti` DB UNIQUE constraint as the
 * last line of defense (the CONDITIONAL UPDATE in the redeem endpoint
 * is the primary).
 */
export function newJti(): string {
  return b64urlEncode(randomBytes(24));
}

/**
 * Canonical JSON.stringify — keys sorted lexically at every depth.
 * Used so signing the same logical payload twice produces the same
 * token string (and so verifiers don't depend on JS object key order).
 *
 * We deliberately don't use a third-party canonical-json package — the
 * payload schema is fixed + small (7 keys, no nested objects), so the
 * stable property is preserved by a single Object.keys().sort() pass.
 */
function canonicalJsonStringify(obj: InviteTokenPayload): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    ordered[key] = (obj as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Assert that the env secret is loadable. Useful at boot / in
 * `/settings/team/invite` server component so the admin sees a clear
 * remediation panel instead of a 500 the first time they click
 * "Generate".
 *
 * Returns `null` when the secret is fine; an error message otherwise.
 */
export function describeInviteSecretConfig(): string | null {
  try {
    loadInviteSecret();
    return null;
  } catch (err) {
    if (err instanceof InviteSecretMissingError) return err.message;
    throw err;
  }
}
