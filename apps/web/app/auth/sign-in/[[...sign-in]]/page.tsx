import { SignIn } from '@clerk/nextjs';
import { notFound } from 'next/navigation';

import { clerkAppearance } from '@/lib/clerk-appearance';

/**
 * `/auth/sign-in/[[...sign-in]]` — Clerk-hosted sign-in. Catch-all
 * route per Clerk's recommended Next.js App Router pattern (handles
 * the SSO callback + verification email landing-page nested paths).
 *
 * Solo mode 404s this route per OQ-3 lock — no sign-in needed.
 */

export default function SignInPage() {
  if ((process.env.COODRA_MODE ?? 'solo') === 'solo') notFound();
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center gap-8">
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-display text-5xl font-black font-medium">[CTX]OS</h1>
        <p className="font-display text-sm font-light font-medium text-text-secondary">Sign in to continue</p>
      </div>
      <SignIn appearance={clerkAppearance} />
    </div>
  );
}
