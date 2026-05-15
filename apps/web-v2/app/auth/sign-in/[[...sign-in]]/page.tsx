import { notFound } from 'next/navigation';

import { clerkAppearance } from '@/lib/clerk-appearance';
import { resolveIdentityMode } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';

/**
 * `/auth/sign-in/[[...sign-in]]` — Clerk's catch-all sign-in route.
 *
 * Phase G (2026-05-12) — renders in any TEAM mode (laptop or cloud).
 * The catch-all segment captures the sub-paths Clerk's hosted flow uses
 * (`/auth/sign-in/factor-one`, `/auth/sign-in/sso-callback`, etc).
 *
 * In solo mode this returns 404 because there's no Clerk to sign into —
 * the local config IS the identity (Phase G + §19).
 *
 * Pre-Phase-G this gated on `team-hosted` only; that meant the laptop
 * sign-in flow (where `/auth/cli-login` redirects unauthenticated users
 * here) returned 404 because the legacy `local-team` mode wasn't
 * `team-hosted`. Phase G binary mode collapses that distinction.
 */

export default async function SignInPage() {
  if (resolveIdentityMode() !== 'team') notFound();
  // Defer the Clerk SignIn import so local bundles never pay the cost.
  const { SignIn } = await import('@clerk/nextjs');
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '80vh',
        gap: 32,
        padding: '40px 24px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <h1
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 56,
            fontWeight: 400,
            letterSpacing: '-0.02em',
            color: 'var(--ink)',
            lineHeight: 1,
          }}
        >
          Coodra
        </h1>
        <p
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.22em',
            color: 'var(--ink-mute)',
            textTransform: 'uppercase',
          }}
        >
          Sign in to your team workspace
        </p>
      </div>
      <SignIn appearance={clerkAppearance} routing="path" path="/auth/sign-in" signUpUrl="/auth/sign-up" />
    </div>
  );
}
