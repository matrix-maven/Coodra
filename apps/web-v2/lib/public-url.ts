import 'server-only';

/**
 * `apps/web-v2/lib/public-url.ts` — resolve this deployment's
 * externally-reachable base URL. Used by:
 *
 *   - `lib/actions/invite.ts` — to build the `redirectUrl` on Clerk
 *     invitations + the `iss` claim on signed tokens.
 *   - `app/api/install/[token]/route.ts` — to include the URL in the
 *     CLI bundle so the CLI knows where to POST audit rows.
 *   - `app/install/[token]/page.tsx` — to render the one-line
 *     installer URL the teammate copies into their terminal.
 *
 * Resolution order:
 *   1. `COODRA_PUBLIC_URL` — explicit override, set by the deploy
 *      template. Always wins; admin's source of truth.
 *   2. `VERCEL_URL` — auto-set by Vercel runtime (no scheme; we prefix
 *      `https://`).
 *   3. Sentinel `https://COODRA_PUBLIC_URL_NOT_SET.invalid` so a
 *      mis-deployed instance produces clearly-broken links rather
 *      than silently pointing at localhost. Operators see "what is
 *      that URL" and search the env vars they forgot.
 */

export function resolveDeploymentBaseUrl(): string {
  const explicit = process.env.COODRA_PUBLIC_URL;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit.replace(/\/$/, '');
  }
  const vercel = process.env.VERCEL_URL;
  if (typeof vercel === 'string' && vercel.length > 0) {
    return `https://${vercel.replace(/\/$/, '')}`;
  }
  return 'https://COODRA_PUBLIC_URL_NOT_SET.invalid';
}

/**
 * True iff the resolver is hitting the sentinel — caller may render
 * a remediation banner.
 */
export function isDeploymentBaseUrlUnset(): boolean {
  return resolveDeploymentBaseUrl().includes('COODRA_PUBLIC_URL_NOT_SET');
}
