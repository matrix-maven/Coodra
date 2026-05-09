import { existsSync, statSync } from 'node:fs';

import { LinkButton, PageHeader, PageShell, Section, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { LOG_SERVICES, type LogService, logPathFor } from '@/lib/log-tail';
import { resolveProjectFromParams } from '@/lib/project-context';

/**
 * `/projects/[slug]/logs` — log service picker (M04 Phase 2 S11,
 * restyled in Phase 2 UI).
 */
export const dynamic = 'force-dynamic';

export default async function LogsIndexPage({ params }: { params: Promise<{ slug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}/logs`;
  const rows = LOG_SERVICES.map((s) => describe(s));

  return (
    <PageShell>
      <PageHeader
        eyebrow="/05 · SYSTEM · LOGS"
        title={
          <>
            Tail the <em>daemons</em>.
          </>
        }
        subtitle={
          <>
            Workspace-grain log files (one per ContextOS service). Tailed live via Server-Sent Events. Pick a service to
            open the live tail surface.
          </>
        }
      />

      <Section
        title={
          <>
            Service <em>logs</em>
          </>
        }
        count={`${rows.length} services`}
      >
        <Table>
          <THead>
            <TR hoverable={false}>
              <TH>Service</TH>
              <TH>Path</TH>
              <TH align="right">Size</TH>
              <TH>Last modified</TH>
              <TH align="right">Open</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.service}>
                <TD mono>{r.service}</TD>
                <TD mono muted>
                  {r.path}
                </TD>
                <TD align="right" mono muted>
                  {r.exists ? formatBytes(r.size) : '—'}
                </TD>
                <TD mono muted>
                  {r.exists ? r.mtime.toISOString() : 'not present'}
                </TD>
                <TD align="right">
                  <LinkButton href={`${baseHref}/${r.service}`} variant="ghost" size="sm">
                    Tail
                  </LinkButton>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Section>
    </PageShell>
  );
}

function describe(service: LogService) {
  const path = logPathFor(service);
  if (!existsSync(path)) {
    return { service, path, exists: false as const, size: 0, mtime: new Date(0) };
  }
  try {
    const s = statSync(path);
    return { service, path, exists: true as const, size: s.size, mtime: new Date(s.mtimeMs) };
  } catch {
    return { service, path, exists: false as const, size: 0, mtime: new Date(0) };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
