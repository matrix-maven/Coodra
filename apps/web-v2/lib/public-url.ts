import 'server-only';

/**
 * `apps/web-v2/lib/public-url.ts` — resolve this deployment's
 * externally-reachable base URL. Used by:
 *
 *   - `lib/actions/invite.ts` — to build the redirect URL on the
 *     `/install/<token>` page AND the `iss` claim on signed tokens.
 *   - `app/api/install/[token]/route.ts` — to include the URL in the
 *     CLI bundle so the CLI knows where to POST audit rows.
 *   - `app/install/[token]/page.tsx` — to render the one-line
 *     installer URL the teammate copies into their terminal.
 *
 * Resolution order:
 *   1. `COODRA_PUBLIC_URL` — explicit override, set by the deploy
 *      template. Always wins; admin's source of truth (Vercel/Fly/
 *      self-host/tunnel).
 *   2. `VERCEL_URL` — auto-set by Vercel runtime (no scheme; we
 *      prefix `https://`).
 *   3. `COODRA_HOME` set → local CLI invocation. The web standalone
 *      is being launched by `coodra start` on a developer laptop;
 *      the same-machine reachable URL is `http://localhost:${PORT}`.
 *      Invite links generated in this mode work for the admin's own
 *      browser and any teammate that can `ssh -L 3001:localhost:3001`
 *      or share the laptop. For cross-machine invites the admin runs
 *      `coodra start --tunnel`, which writes `COODRA_PUBLIC_URL`
 *      into `~/.coodra/.env` and takes precedence above.
 *   4. Sentinel `https://COODRA_PUBLIC_URL_NOT_SET.invalid` — only
 *      reached on a mis-deployed cloud instance (no `COODRA_PUBLIC_URL`,
 *      no `VERCEL_URL`, no `COODRA_HOME`). Produces clearly-broken
 *      links so the operator notices and sets the env var, rather
 *      than silently pointing at localhost on the deploy machine.
 *
 * 2026-05-18 — added case 3. Before this, a laptop admin running
 * `coodra invite` (or hitting the web's Invite form) without ever
 * setting `COODRA_PUBLIC_URL` got tokens with the sentinel baked
 * into both the URL host AND the `iss` claim — completely unusable.
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
  const coodraHome = process.env.COODRA_HOME;
  if (typeof coodraHome === 'string' && coodraHome.length > 0) {
    const port = process.env.PORT && process.env.PORT.length > 0 ? process.env.PORT : '3001';
    return `http://localhost:${port}`;
  }
  return 'https://COODRA_PUBLIC_URL_NOT_SET.invalid';
}

/**
 * True iff the resolver is hitting the sentinel — caller may render
 * a remediation banner. Does NOT trigger for the COODRA_HOME local
 * fallback (case 3 above) — `http://localhost:${port}` is a legitimate
 * resolution for laptop installs and shouldn't surface a warning.
 */
export function isDeploymentBaseUrlUnset(): boolean {
  return resolveDeploymentBaseUrl().includes('COODRA_PUBLIC_URL_NOT_SET');
}
