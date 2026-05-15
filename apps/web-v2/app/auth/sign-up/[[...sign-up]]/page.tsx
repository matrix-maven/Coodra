import { notFound } from 'next/navigation';

import { clerkAppearance } from '@/lib/clerk-appearance';
import { resolveIdentityMode } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';

/**
 * `/auth/sign-up/[[...sign-up]]` — Clerk's catch-all sign-up route.
 *
 * Phase G — renders in any TEAM mode (laptop or cloud). Solo mode returns
 * 404 (no Clerk).
 *
 * In Phase 2 (invite tokens), new teammates land here via the
 * `/install/<token>` page after clicking their invitation email. Admin
 * should configure Clerk to require invitation (Clerk dashboard →
 * Authentication → Restrictions) to prevent randos from joining the
 * deployment's Clerk app.
 */

export default async function SignUpPage() {
  if (resolveIdentityMode() !== 'team') notFound();
  const { SignUp } = await import('@clerk/nextjs');
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
          Join your team workspace
        </p>
      </div>
      <SignUp appearance={clerkAppearance} routing="path" path="/auth/sign-up" signInUrl="/auth/sign-in" />
    </div>
  );
}
