import { ProjectsSwitcher } from '@/components/ProjectsSwitcher';
import { resolveProjectFromParams } from '@/lib/project-context';
import { fetchPickerSnapshot } from '@/lib/queries/picker';

/**
 * `apps/web/app/projects/[slug]/layout.tsx` — nested layout for every
 * `/projects/[slug]/*` route (full UI redesign).
 *
 * Renders a slim top bar with the project name + a project switcher,
 * then a <main id="main"> for the skip-to-main target. The Sidebar
 * (mounted by the root layout) handles all navigation — no more
 * sub-nav strip here.
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
      <header className="sticky top-0 z-10 flex h-(--topbar-height) items-center justify-between border-b border-border-subtle bg-bg-surface px-(--space-page-x)">
        <div className="flex items-baseline gap-3">
          <span className="text-xs font-medium text-text-tertiary">Project</span>
          <span className="font-mono text-sm font-medium text-text-primary">{project.slug}</span>
        </div>
        <ProjectsSwitcher currentSlug={project.slug} options={switcherOptions} />
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1280px] px-(--space-page-x) py-(--space-page-y) outline-none"
      >
        {children}
      </main>
    </>
  );
}
