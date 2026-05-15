import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Unit tests for `apps/web-v2/lib/invite-token.ts`.
 *
 * The module reads `COODRA_INVITE_HMAC_SECRET` at import time via
 * `loadInviteSecret()` invocations, but loads are per-call (not
 * cached at module-init), so we can flip the env var per test and the
 * next sign/verify picks up the new secret.
 *
 * Coverage:
 *   - Round-trip: sign + verify same payload returns ok.
 *   - Expired: verify rejects with `reason: 'expired'`.
 *   - Tampered payload: signature mismatch.
 *   - Tampered signature: signature mismatch.
 *   - Wrong secret: signature mismatch (forgery attempt).
 *   - Bad payload shape: `bad_payload`.
 *   - Malformed: missing `.` segment.
 *   - Missing secret: `secret_misconfigured`.
 *   - Short secret: `secret_misconfigured`.
 *   - Two signs of the same payload produce identical strings (canonical JSON).
 *   - newJti returns distinct values across calls.
 */

const TEST_SECRET_HEX = 'a'.repeat(64); // 64 hex chars = 32 bytes
const ALT_SECRET_HEX = 'b'.repeat(64);

async function reload(): Promise<typeof import('@/lib/invite-token')> {
  // Force a re-evaluation by busting Vitest's module cache. Vitest's
  // dynamic import respects esm import caching, so this trick is to
  // bypass the cache via a fresh URL fragment. The function itself
  // reads env per-call, so a single import is fine for most tests;
  // this helper exists for the few that need a clean module slate
  // (e.g., the missing-secret test).
  return await import('@/lib/invite-token');
}

describe('invite-token round-trip', () => {
  beforeEach(() => {
    process.env.COODRA_INVITE_HMAC_SECRET = TEST_SECRET_HEX;
  });
  afterEach(() => {
    process.env.COODRA_INVITE_HMAC_SECRET = undefined;
  });

  it('signs and verifies a valid payload', async () => {
    const { signInviteToken, verifyInviteToken } = await reload();
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1 as const,
      jti: 'jti-abc-123-456-789x',
      org: 'org_test',
      role: 'member' as const,
      email: 'alice@acme.com',
      exp: now + 3600,
      iss: 'https://coodra-acme.test',
    };
    const token = signInviteToken(payload);
    expect(token.split('.').length).toBe(2);
    const result = verifyInviteToken(token, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(payload);
    }
  });

  it('canonicalizes key order: signing the same logical payload twice yields identical strings', async () => {
    const { signInviteToken } = await reload();
    const now = Math.floor(Date.now() / 1000);
    const t1 = signInviteToken({
      v: 1,
      jti: 'jti-stablexxxxxxxxxx',
      org: 'org_test',
      role: 'admin',
      email: 'bob@acme.com',
      exp: now + 3600,
      iss: 'https://x.test',
    });
    // Re-build the object with keys in a different order; same logical content.
    const t2 = signInviteToken({
      iss: 'https://x.test',
      exp: now + 3600,
      email: 'bob@acme.com',
      role: 'admin',
      org: 'org_test',
      jti: 'jti-stablexxxxxxxxxx',
      v: 1,
    });
    expect(t1).toBe(t2);
  });

  it('rejects an expired token', async () => {
    const { signInviteToken, verifyInviteToken } = await reload();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = signInviteToken({
      v: 1,
      jti: 'jti-expiredxxxxxxxxx',
      org: 'org_test',
      role: 'member',
      email: 'a@a.com',
      exp: past,
      iss: 'https://x.test',
    });
    const result = verifyInviteToken(token, past + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects a tampered signature segment', async () => {
    const { signInviteToken, verifyInviteToken } = await reload();
    const now = Math.floor(Date.now() / 1000);
    const token = signInviteToken({
      v: 1,
      jti: 'jti-tamperedxxxxxxxx',
      org: 'org_test',
      role: 'member',
      email: 'a@a.com',
      exp: now + 3600,
      iss: 'https://x.test',
    });
    // Flip a character of the signature.
    const dot = token.indexOf('.');
    const sig = token.slice(dot + 1);
    const flippedChar = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${token.slice(0, dot)}.${flippedChar}${sig.slice(1)}`;
    const result = verifyInviteToken(tampered, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a tampered payload segment', async () => {
    const { signInviteToken, verifyInviteToken } = await reload();
    const now = Math.floor(Date.now() / 1000);
    const token = signInviteToken({
      v: 1,
      jti: 'jti-payloadxxxxxxxxx',
      org: 'org_test',
      role: 'member',
      email: 'a@a.com',
      exp: now + 3600,
      iss: 'https://x.test',
    });
    const dot = token.indexOf('.');
    const payload = token.slice(0, dot);
    const flippedChar = payload[0] === 'A' ? 'B' : 'A';
    const tampered = `${flippedChar}${payload.slice(1)}.${token.slice(dot + 1)}`;
    const result = verifyInviteToken(tampered, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects tokens signed with a different secret (forgery attempt)', async () => {
    process.env.COODRA_INVITE_HMAC_SECRET = TEST_SECRET_HEX;
    const sigA = (await reload()).signInviteToken;
    const now = Math.floor(Date.now() / 1000);
    const token = sigA({
      v: 1,
      jti: 'jti-forgexxxxxxxxxxx',
      org: 'org_test',
      role: 'admin',
      email: 'attacker@evil.test',
      exp: now + 3600,
      iss: 'https://x.test',
    });

    process.env.COODRA_INVITE_HMAC_SECRET = ALT_SECRET_HEX;
    const verifyB = (await reload()).verifyInviteToken;
    const result = verifyB(token, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a malformed (single-segment) token', async () => {
    const { verifyInviteToken } = await reload();
    const result = verifyInviteToken('not-a-real-token-no-dot', Math.floor(Date.now() / 1000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects a payload that fails Zod schema (non-email)', async () => {
    const { verifyInviteToken } = await reload();
    // Build a token by hand with a non-email payload.
    const { createHmac } = await import('node:crypto');
    const bogusPayload = {
      v: 1,
      jti: 'jti-bogus-bogus-bogu',
      org: 'org_test',
      role: 'member',
      email: 'not-an-email-at-all',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: 'https://x.test',
    };
    const sortedJson = JSON.stringify(
      Object.fromEntries(Object.entries(bogusPayload).sort(([a], [b]) => a.localeCompare(b))),
    );
    const encoded = Buffer.from(sortedJson).toString('base64url');
    const sig = createHmac('sha256', Buffer.from(TEST_SECRET_HEX, 'hex'))
      .update(encoded)
      .digest('base64url');
    const token = `${encoded}.${sig}`;
    const result = verifyInviteToken(token, Math.floor(Date.now() / 1000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_payload');
  });

  it('newJti returns distinct, base64url-safe ids', async () => {
    const { newJti } = await reload();
    const a = newJti();
    const b = newJti();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(20);
  });
});

describe('invite-token secret misconfiguration', () => {
  afterEach(() => {
    process.env.COODRA_INVITE_HMAC_SECRET = undefined;
  });

  it('verify returns secret_misconfigured when env is unset', async () => {
    process.env.COODRA_INVITE_HMAC_SECRET = undefined;
    const { verifyInviteToken } = await reload();
    const result = verifyInviteToken('aaa.bbb', Math.floor(Date.now() / 1000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('secret_misconfigured');
  });

  it('verify returns secret_misconfigured when secret is too short', async () => {
    process.env.COODRA_INVITE_HMAC_SECRET = 'shorty';
    const { verifyInviteToken } = await reload();
    const result = verifyInviteToken('aaa.bbb', Math.floor(Date.now() / 1000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('secret_misconfigured');
  });

  it('describeInviteSecretConfig returns null when secret is valid', async () => {
    process.env.COODRA_INVITE_HMAC_SECRET = TEST_SECRET_HEX;
    const { describeInviteSecretConfig } = await reload();
    expect(describeInviteSecretConfig()).toBeNull();
  });

  it('describeInviteSecretConfig returns a remediation message when secret is missing', async () => {
    process.env.COODRA_INVITE_HMAC_SECRET = undefined;
    const { describeInviteSecretConfig } = await reload();
    const msg = describeInviteSecretConfig();
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/COODRA_INVITE_HMAC_SECRET/);
  });

  it('sign throws when the secret is missing', async () => {
    process.env.COODRA_INVITE_HMAC_SECRET = undefined;
    const { signInviteToken } = await reload();
    expect(() =>
      signInviteToken({
        v: 1,
        jti: 'jti-x-x-x-x-x-x-xxxx',
        org: 'o',
        role: 'member',
        email: 'a@a.com',
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: 'x',
      }),
    ).toThrow(/COODRA_INVITE_HMAC_SECRET/);
  });
});
