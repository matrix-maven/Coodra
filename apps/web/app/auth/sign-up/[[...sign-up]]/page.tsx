import { SignUp } from '@clerk/nextjs';
import { notFound } from 'next/navigation';

import { clerkAppearance } from '@/lib/clerk-appearance';

/**
 * `/auth/sign-up/[[...sign-up]]` — Clerk-hosted sign-up. See sign-in
 * page docblock for the catch-all rationale.
 */

export default function SignUpPage() {
  if ((process.env.COODRA_MODE ?? 'solo') === 'solo') notFound();
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center gap-8">
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-display text-5xl font-black font-medium">[CTX]OS</h1>
        <p className="font-display text-sm font-light font-medium text-text-secondary">Create an account</p>
      </div>
      <SignUp appearance={clerkAppearance} />
    </div>
  );
}
