import { UserProfile } from '@clerk/nextjs';
import { notFound } from 'next/navigation';

import { clerkAppearance } from '@/lib/clerk-appearance';

/**
 * `/settings/account` — Clerk's <UserProfile /> for personal-account
 * settings (name, email, password, MFA, sessions, connected accounts).
 * Solo mode 404s.
 */

export default function AccountSettingsPage() {
  if ((process.env.CONTEXTOS_MODE ?? 'solo') === 'solo') notFound();
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-8 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Account</h1>
        <p className="text-sm text-text-secondary">Personal profile, security, and connected accounts.</p>
      </header>
      <UserProfile appearance={clerkAppearance} />
    </div>
  );
}
