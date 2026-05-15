import type { Metadata } from 'next';

import {
  Breadcrumbs,
  type Crumb,
  LinkButton,
  PageHeader,
  PageShell,
  RefreshIcon,
  Section,
  StatusDot,
  type StatusTone,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getDoctorReport } from '@/lib/queries/doctor';

/**
 * `/projects/[slug]/doctor` — live doctor report (M04 Phase 2 S8,
 * restyled in Phase 2 UI).
 *
 * Server-rendered; each request runs the doctor probe set fresh
 * against the dev server's cwd. ?scope=full toggles to the 35-check
 * registry; ?autorefresh=1 sets a meta http-equiv refresh (5s).
 *
 * Doctor checks today probe ~/.coodra/, the local data.db, the
 * bridge & MCP server health, IDE registration, and pending-job
 * depth — all workspace-grain. The page lives at /projects/[slug]/
 * doctor for navigation symmetry; per-project filtering arrives when
 * the checks support it.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly scope?: string;
  readonly autorefresh?: string;
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const sp = await searchParams;
  if (sp.autorefresh !== '1') return {};
  return { other: { refresh: '5' } };
}

export default async function DoctorPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const scope: 'essential' | 'full' = sp.scope === 'full' ? 'full' : 'essential';
  const autorefresh = sp.autorefresh === '1';
  const report = await getDoctorReport(scope);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Doctor' },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="/05 · SYSTEM · DOCTOR"
        title={
          <>
            <em>Doctor</em>, in good repair.
          </>
        }
        subtitle={
          <>
            Workspace-grain probes — scope <span className="font-mono text-accent">{scope}</span> (
            {report.checks.length} checks). Last run{' '}
            <span className="font-mono text-accent">{new Date().toISOString().slice(11, 19)} UTC</span>.
          </>
        }
        actions={
          <>
            <LinkButton
              href={`${baseHref}/doctor?scope=${scope === 'essential' ? 'full' : 'essential'}&autorefresh=${autorefresh ? '1' : '0'}`}
              variant="secondary"
              size="sm"
            >
              Switch to {scope === 'essential' ? 'full' : 'essential'}
            </LinkButton>
            <LinkButton
              href={`${baseHref}/doctor?scope=${scope}&autorefresh=${autorefresh ? '0' : '1'}`}
              variant="secondary"
              size="sm"
              leftIcon={<RefreshIcon className="h-3 w-3" />}
            >
              Auto-refresh: {autorefresh ? 'on' : 'off'}
            </LinkButton>
          </>
        }
      />

      <SummaryStrip
        ok={report.summary.ok}
        warn={report.summary.warn}
        fail={report.summary.fail}
        skipped={report.summary.skipped}
      />

      <Section title="Checks" count={report.checks.length}>
        <Table>
          <THead>
            <TR hoverable={false}>
              <TH width="120px">Status</TH>
              <TH align="right" width="48px">
                Id
              </TH>
              <TH>Name</TH>
              <TH>Detail</TH>
              <TH>Remediation</TH>
              <TH align="right" width="64px">
                ms
              </TH>
            </TR>
          </THead>
          <TBody>
            {report.checks.map((c) => (
              <TR key={c.id}>
                <TD>
                  <StatusDot tone={statusTone(c.status)} label={c.status} />
                </TD>
                <TD align="right" mono muted>
                  {c.id}
                </TD>
                <TD mono>{c.name}</TD>
                <TD muted>{c.detail ?? '—'}</TD>
                <TD muted>{c.remediation ?? ''}</TD>
                <TD align="right" mono muted>
                  {c.durationMs}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Section>

      <p className="text-xs text-text-tertiary">
        coodra home: <span className="font-mono">{report.coodraHome}</span> · cwd:{' '}
        <span className="font-mono">{report.cwd}</span> · version <span className="font-mono">{report.version}</span>
      </p>
    </PageShell>
  );
}

function statusTone(status: 'green' | 'yellow' | 'red' | 'skipped' | 'timeout'): StatusTone {
  if (status === 'green') return 'success';
  if (status === 'yellow') return 'warning';
  if (status === 'skipped') return 'neutral';
  return 'error';
}

function SummaryStrip({
  ok,
  warn,
  fail,
  skipped,
}: {
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
  readonly skipped: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill colorClass="bg-status-success/15 text-status-success">{ok} green</Pill>
      <Pill colorClass="bg-status-warning/15 text-status-warning">{warn} yellow</Pill>
      <Pill colorClass="bg-status-error/15 text-status-error">{fail} red</Pill>
      <Pill colorClass="bg-bg-elevated text-text-tertiary">{skipped} skipped</Pill>
    </div>
  );
}

function Pill({ colorClass, children }: { readonly colorClass: string; readonly children: React.ReactNode }) {
  return <span className={`px-3 py-1 text-xs font-medium ${colorClass}`}>{children}</span>;
}
