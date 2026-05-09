import Link from 'next/link';

import { ProjectsSwitcher } from '@/components/ProjectsSwitcher';
import { Topbar } from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { fetchPickerSnapshot } from '@/lib/queries/picker';

/**
 * `apps/web/app/projects/[slug]/layout.tsx` — nested layout for every
 * `/projects/[slug]/*` route. Editorial Topbar (crumbs · search slot ·
 * actions) + a generous main content shell with editorial padding.
 */

export const dynamic = 'force-dynamic';

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const project = await resolveProjectFromParams(params);
  const picker = await fetchPickerSnapshot();
  const switcherOptions = picker.projects.map((p) => ({ slug: p.slug, statusDot: p.statusDot }));

  return (
    <>
      <Topbar
        crumbs={[{ label: 'contextos', href: '/' }, { label: project.slug }]}
        actions={
          <>
            <ProjectsSwitcher currentSlug={project.slug} options={switcherOptions} />
            <Link
              href={`/projects/${encodeURIComponent(project.slug)}/settings` as never}
              aria-label="Project settings"
              className="flex h-8 w-8 items-center justify-center border border-rule-strong text-text-tertiary transition-colors hover:border-text-primary hover:text-text-primary"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-4 w-4">
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </Link>
          </>
        }
      />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-(--content-max) px-12 pt-14 pb-20 outline-none">
        {children}
      </main>
    </>
  );
}
