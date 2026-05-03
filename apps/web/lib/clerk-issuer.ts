/**
 * `apps/web/lib/clerk-issuer.ts` — auto-discover the Clerk JWT issuer URL
 * from the publishable key (per spec §9 — operator does NOT type the
 * issuer URL into env).
 *
 * Clerk's publishable keys encode the tenant slug in the key body. The
 * format is `pk_{test|live}_<base64-encoded-tenant-domain>`. Decoding the
 * trailing portion yields the issuer URL. Implementation matches Clerk's
 * own internal algorithm (documented in `@clerk/shared/keys`).
 *
 * Falls back to env override `CLERK_JWT_ISSUER` if set; throws if neither
 * the env var nor a parseable publishable key is available.
 *
 * Live verification (M04 S2): boot calls this, hits the issuer URL's
 * `.well-known/jwks.json`, and confirms a valid JWKS is returned.
 */

export interface ClerkIssuerOptions {
  readonly publishableKey?: string | undefined;
  readonly envOverride?: string | undefined;
}

export class ClerkIssuerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClerkIssuerError';
  }
}

export function resolveClerkIssuer(opts: ClerkIssuerOptions = {}): string {
  const env = opts.envOverride ?? process.env.CLERK_JWT_ISSUER;
  if (typeof env === 'string' && env.length > 0) return env;

  const pk = opts.publishableKey ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (typeof pk !== 'string' || pk.length === 0) {
    throw new ClerkIssuerError(
      'resolveClerkIssuer: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY missing AND CLERK_JWT_ISSUER not set. Configure one.',
    );
  }
  const match = pk.match(/^pk_(test|live)_([A-Za-z0-9+/=]+)$/);
  if (match === null) {
    throw new ClerkIssuerError(`resolveClerkIssuer: publishable key shape unrecognised: '${pk.slice(0, 12)}…'`);
  }
  const encodedTenant = match[2];
  if (encodedTenant === undefined) {
    throw new ClerkIssuerError('resolveClerkIssuer: regex matched but tenant capture is undefined');
  }
  let decodedTenant: string;
  try {
    // Clerk pads the trailing `$` and we strip it before base64 decode.
    decodedTenant = atob(encodedTenant.replace(/\$+$/, ''));
  } catch (err) {
    throw new ClerkIssuerError(
      `resolveClerkIssuer: failed to base64-decode tenant from publishable key: ${(err as Error).message}`,
    );
  }
  // Clerk's encoded value sometimes has a trailing `$` byte; strip post-decode too.
  const tenant = decodedTenant.replace(/\$+$/, '').replace(/\.$/, '');
  return `https://${tenant}`;
}

export async function probeClerkJwks(issuer: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { keys?: unknown };
    return Array.isArray(body.keys);
  } catch {
    return false;
  }
}
