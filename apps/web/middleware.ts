import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * `apps/web/middleware.ts` — auth + mode-aware routing per spec §9 + OQ-3 lock.
 *
 * Solo mode (`COODRA_MODE=solo`):
 *   - Clerk middleware is short-circuited entirely.
 *   - `/auth/*` and `/settings/team` routes return 404 (rewritten to /not-found).
 *   - Every other route renders without sign-in as the synthetic
 *     `__solo__` user (resolved in `lib/auth.ts::getActor()`).
 *
 * Team mode (`COODRA_MODE=team`):
 *   - Wraps everything in `clerkMiddleware()` for JWT validation.
 *   - Public routes: `/api/healthz`, `/auth/sign-in`, `/auth/sign-up`.
 *   - Unauthenticated → 302 to `/auth/sign-in`.
 *
 * Either mode: `/api/healthz` is always public — process supervisors must
 * be able to probe it without auth.
 */

const isSoloOnly404 = createRouteMatcher(['/auth(.*)', '/settings/team(.*)']);
const isPublic = createRouteMatcher(['/api/healthz', '/auth(.*)']);

const isSolo = (process.env.COODRA_MODE ?? 'solo') === 'solo';

export default isSolo
  ? soloMiddleware
  : clerkMiddleware(
      async (auth, req) => {
        if (isPublic(req)) return;
        // Clerk's default behaviour for unauthenticated requests is to
        // throw notFound() (which renders our /not-found page) — that's
        // not the right UX for a protected route. Manually redirect
        // unauthenticated requests to /auth/sign-in so the user lands
        // on Clerk's hosted form.
        const session = await auth();
        if (session.userId === null || session.userId === undefined) {
          const signInUrl = new URL('/auth/sign-in', req.url);
          signInUrl.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
          return NextResponse.redirect(signInUrl);
        }
      },
      { signInUrl: '/auth/sign-in' },
    );

function soloMiddleware(req: NextRequest): NextResponse | undefined {
  if (isSoloOnly404(req)) {
    return NextResponse.rewrite(new URL('/not-found', req.url));
  }
  return undefined;
}

export const config = {
  // Run middleware on every route except _next assets, image optimisation,
  // and static files. Mirrors Clerk's recommended matcher.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)).*)',
    '/(api|trpc)(.*)',
  ],
};
