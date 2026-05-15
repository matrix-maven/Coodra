import { existsSync } from 'node:fs';

import { notFound } from 'next/navigation';

import { LogTailClient } from '@/components/LogTailClient';
import { Breadcrumbs, type Crumb, EmptyState, PageHeader, PageShell } from '@/components/ui';
import { isLogService, logPathFor, readLastLines } from '@/lib/log-tail';
import { resolveProjectFromParams } from '@/lib/project-context';

/**
 * `/projects/[slug]/logs/[service]` — live log tail (M04 Phase 2 S11,
 * restyled in Phase 2 UI).
 */
export const dynamic = 'force-dynamic';

const INITIAL_LINES = 200;

export default async function LogTailPage({ params }: { params: Promise<{ slug: string; service: string }> }) {
  const project = await resolveProjectFromParams(params);
  const { service: rawService } = await params;
  const service = decodeURIComponent(rawService);
  if (!isLogService(service)) notFound();

  const path = logPathFor(service);
  const exists = existsSync(path);
  const initial = exists ? readLastLines(path, INITIAL_LINES) : { lines: [], endOffset: 0 as const };
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Logs', href: `${baseHref}/logs` },
    { label: service, mono: true },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Service log"
        title="Tail"
        code={service}
        subtitle={
          <>
            Path: <span className="font-mono">{path}</span> · last {INITIAL_LINES} lines on first paint, then SSE tail.
          </>
        }
      />

      {!exists ? (
        <EmptyState
          title="Log file does not exist yet"
          body={
            <>
              The {service} service has not started, or its log was never written. Start the service via{' '}
              <span className="font-mono">coodra start</span> or the workspace settings page.
            </>
          }
        />
      ) : (
        <LogTailClient
          slug={project.slug}
          service={service}
          initialLines={initial.lines}
          initialOffset={initial.endOffset}
        />
      )}
    </PageShell>
  );
}
