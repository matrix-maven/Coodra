import { existsSync } from 'node:fs';

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LogTailClient } from '@/components/LogTailClient';
import { isLogService, logPathFor, readLastLines } from '@/lib/log-tail';
import { resolveProjectFromParams } from '@/lib/project-context';

/**
 * `/projects/[slug]/logs/[service]` — live log tail (M04 Phase 2 S11).
 *
 * Server-side initial render: read the last `INITIAL_LINES` lines so
 * the page is useful immediately without waiting for SSE traffic, and
 * pass the file's current byte size as `initialOffset` so the SSE
 * stream resumes exactly where the initial slice left off.
 *
 * Client-side: <LogTailClient> opens an EventSource against the
 * `/api/.../stream` route and appends new lines, with a substring
 * filter and sticky-tail toggle.
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
  const baseHref = `/projects/${encodeURIComponent(project.slug)}/logs`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
            <span className="font-mono text-2xl normal-case tracking-normal text-(--color-text-code)">{service}</span>{' '}
            log
          </h1>
          <Link
            href={baseHref as never}
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-brand)"
          >
            ◂ Back to logs
          </Link>
        </div>
        <p className="text-xs text-(--color-text-tertiary)">
          Path: <span className="font-mono">{path}</span> · last {INITIAL_LINES} lines on first paint, then SSE tail.
        </p>
      </header>

      {!exists ? (
        <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-8 text-center">
          <p className="font-display text-base font-light uppercase tracking-wider text-(--color-text-secondary)">
            Log file does not exist yet.
          </p>
          <p className="mt-2 text-xs text-(--color-text-tertiary)">
            The {service} service has not started, or its log was never written. Start the service via{' '}
            <span className="font-mono">contextos start</span> (or the workspace settings page in S12).
          </p>
        </div>
      ) : (
        <LogTailClient
          slug={project.slug}
          service={service}
          initialLines={initial.lines}
          initialOffset={initial.endOffset}
        />
      )}
    </div>
  );
}
