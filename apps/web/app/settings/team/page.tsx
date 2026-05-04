import { OrganizationProfile } from '@clerk/nextjs';
import { notFound } from 'next/navigation';

import { clerkAppearance } from '@/lib/clerk-appearance';

/**
 * `/settings/team` — Clerk's <OrganizationProfile /> embedded as the
 * org-management UI. Solo mode 404s per OQ-3.
 */

export default function TeamSettingsPage() {
  if ((process.env.CONTEXTOS_MODE ?? 'solo') === 'solo') notFound();
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-8 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Team settings</h1>
        <p className="text-sm text-text-secondary">Manage members, invitations, roles, and org-level configuration.</p>
      </header>
      <OrganizationProfile appearance={clerkAppearance} />
    </div>
  );
}
