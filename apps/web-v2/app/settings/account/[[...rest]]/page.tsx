import { notFound, redirect } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { resolveIdentityMode } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';

/**
 * `/settings/account/[[...rest]]` — Clerk's `<UserProfile />` widget.
 *
 * Catch-all route — Clerk mounts nested sub-routes (verify-email,
 * connected-accounts, security/2fa, active sessions, etc.) under
 * the base path. With path-based routing those nested URLs MUST
 * resolve to the same page component, hence `[[...rest]]`.
 *
 * Server-side auth check:
 *   - Even though the middleware redirects unauthenticated requests
 *     to /auth/sign-in, the page also explicitly verifies the
 *     Clerk session before rendering `<UserProfile />`. This handles
 *     a real edge case where the middleware passes (cookie present)
 *     but the cookie has expired between middleware and render —
 *     in that window `<UserProfile />` would otherwise log the
 *     "cannot_render_user_missing" runtime warning that Next.js dev
 *     surfaces as a Runtime error in the overlay.
 *
 * Only renders in `team-hosted` mode; 404 elsewhere.
 */

export default async function AccountSettingsPage() {
  // Phase G — account settings render in any team mode (laptop or cloud).
  if (resolveIdentityMode() !== 'team') notFound();

  // Defensive server-side auth gate. Returns immediately if Clerk's
  // server-side `auth()` doesn't see a userId — redirecting rather
  // than throwing keeps the UX consistent with middleware behaviour.
  const { auth } = await import('@clerk/nextjs/server');
  const session = await auth();
  if (session.userId === null || session.userId === undefined) {
    redirect('/auth/sign-in?redirect_url=/settings/account');
  }

  const { UserProfile } = await import('@clerk/nextjs');
  return (
    <>
      <Topbar crumb="Account" crumbPrefix="coodra / settings" />
      <section className="screen" style={{ maxWidth: 1100 }}>
        <div className="head">
          <div>
            <div className="head__num">/05 · SYSTEM · ACCOUNT</div>
            <h1 className="head__title">
              Your <em>account</em>.
            </h1>
            <p className="head__lede">
              Managed by Clerk. Coodra uses your Clerk identity for every read + write you make against the team
              workspace; updates here propagate to every page on next refresh.
            </p>
          </div>
        </div>
        <UserProfile appearance={clerkAppearance} routing="path" path="/settings/account" />
      </section>
    </>
  );
}
