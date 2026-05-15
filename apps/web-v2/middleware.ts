import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * `apps/web-v2/middleware.ts` — Phase G unified two-mode auth gate.
 *
 * Phase G (2026-05-12) — drops the three-mode distinction (local-solo
 * / local-team / team-hosted) and treats identity as a binary
 * `solo | team`. The user-facing UX is now:
 *
 *   - solo: pass-through. No Clerk, no roles. Web rendered as the
 *           __solo__ actor (admin). Works identically whether the web
 *           is local or cloud-hosted (cloud-hosted in solo is unusual
 *           but supported).
 *
 *   - team: Clerk required. Every unauthenticated request redirects
 *           to /auth/sign-in. After auth, the single-tenant org-match
 *           invariant is enforced. UX is identical whether the web
 *           runs on a laptop or on Vercel — the laptop-vs-server
 *           distinction is implementation detail.
 *
 * Mode resolves once at module load (env doesn't change mid-process)
 * via the `COODRA_MODE` env var (production deploys + tests set
 * this explicitly).
 */

// Phase G — mode resolves from COODRA_MODE env. The env-bootstrap
// shim in next.config.ts ensures this is populated from ~/.coodra/.env
// when the web runs on a laptop.
const mode = (process.env.COODRA_MODE ?? 'solo').toLowerCase();
const requiresClerk = mode === 'team';
// EXPECTED_ORG_ID resolves from COODRA_EXPECTED_ORG_ID (the explicit
// deployment-env pin) OR from COODRA_TEAM_ORG_ID (the team-mode
// machine-config value written by the wizard / team-install). Either
// is acceptable; team-hosted deployments use the former, local-team
// laptops inherit from the latter.
const EXPECTED_ORG_ID = process.env.COODRA_EXPECTED_ORG_ID ?? process.env.COODRA_TEAM_ORG_ID;

/**
 * Boot-time invariant. Without an EXPECTED_ORG_ID pin, a deployed
 * team-hosted server is wide open to anyone who can sign into the
 * configured Clerk app — including users from completely unrelated
 * orgs (or no org at all). Refuse to even boot the middleware unless
 * the operator named which org this deployment serves.
 *
 * If you reach this throw at deploy time:
 *   1. Open your Clerk dashboard.
 *   2. Navigate to your team's Organization.
 *   3. Copy the `org_…` id.
 *   4. Set `COODRA_EXPECTED_ORG_ID=<that-id>` in your deployment env
 *      (Vercel project settings, fly secrets, docker -e, etc.).
 *   5. Redeploy.
 */
if (requiresClerk && (typeof EXPECTED_ORG_ID !== 'string' || EXPECTED_ORG_ID.length === 0)) {
  throw new Error(
    'team mode requires COODRA_EXPECTED_ORG_ID to be set. ' +
      "Without it, anyone with a Clerk account in this deployment's Clerk app could read your team's data. " +
      'Set it to your Clerk organization id (org_…) — on a laptop this comes from ~/.coodra/.env (COODRA_TEAM_ORG_ID); ' +
      'on a deployed server set it explicitly in the deployment env (Vercel, fly secrets, docker -e).',
  );
}

const isPublic = createRouteMatcher([
  '/api/healthz',
  '/auth(.*)',
  '/forbidden(.*)',
  // Phase-2 install-token landing pages — pre-auth flow for new teammates.
  '/install(.*)',
  // Phase-2 install API endpoints — the route handlers do their own
  // Clerk session check inside (the POST redeem path requires the
  // signed-in user to match the invited email; GET preview is
  // intentionally public). Without this entry, /api/install/[token]
  // gets the unauthenticated-redirect to /auth/sign-in, which breaks
  // the CLI install flow (it cannot follow redirects through a
  // browser-only sign-in page).
  '/api/install(.*)',
]);

const teamModeHandler = clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return;
  const session = await auth();
  if (session.userId === null || session.userId === undefined) {
    const signIn = new URL('/auth/sign-in', req.url);
    signIn.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signIn);
  }
  // Single-tenant invariant — every team-hosted deployment serves
  // exactly one Clerk org. Refuse anyone signed in but not in that
  // org. The boot-time check above guarantees EXPECTED_ORG_ID is
  // present here.
  if (session.orgId !== EXPECTED_ORG_ID) {
    const forbidden = new URL('/forbidden', req.url);
    forbidden.searchParams.set('reason', session.orgId ? 'org_mismatch' : 'no_org');
    if (typeof session.orgId === 'string') forbidden.searchParams.set('got', session.orgId);
    if (typeof EXPECTED_ORG_ID === 'string') forbidden.searchParams.set('expected', EXPECTED_ORG_ID);
    return NextResponse.redirect(forbidden);
  }
});

export default requiresClerk ? teamModeHandler : (_req: NextRequest) => NextResponse.next();

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)).*)',
    '/(api|trpc)(.*)',
  ],
};
