import { OrganizationProfile } from '@clerk/nextjs';
import { notFound } from 'next/navigation';

import { PageHeader, PageShell } from '@/components/ui';
import { clerkAppearance } from '@/lib/clerk-appearance';

/**
 * `/settings/team` — Clerk's <OrganizationProfile /> embedded as the
 * org-management UI. Solo mode 404s per OQ-3.
 */

export default function TeamSettingsPage() {
  if ((process.env.COODRA_MODE ?? 'solo') === 'solo') notFound();
  return (
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="/05 · SYSTEM · TEAM"
        title={
          <>
            <em>Team</em> settings.
          </>
        }
        subtitle="Manage members, invitations, roles, and org-level configuration. Embedded Clerk surface for the team mode workspace."
      />
      <OrganizationProfile appearance={clerkAppearance} />
    </PageShell>
  );
}
