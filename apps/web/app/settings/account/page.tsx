import { UserProfile } from '@clerk/nextjs';
import { notFound } from 'next/navigation';

import { PageHeader, PageShell } from '@/components/ui';
import { clerkAppearance } from '@/lib/clerk-appearance';

/**
 * `/settings/account` — Clerk's <UserProfile /> for personal account
 * settings (name, email, password, MFA, sessions, connected accounts).
 * Solo mode 404s (no auth surface).
 */

export default function AccountSettingsPage() {
  if ((process.env.COODRA_MODE ?? 'solo') === 'solo') notFound();
  return (
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="/05 · SYSTEM · ACCOUNT"
        title={
          <>
            <em>Account</em>.
          </>
        }
        subtitle="Personal profile, security, and connected accounts. Settings sit on top of Clerk in team mode; solo mode skips this entirely."
      />
      <UserProfile appearance={clerkAppearance} />
    </PageShell>
  );
}
