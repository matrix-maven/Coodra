import type { Metadata } from 'next';
import Link from 'next/link';

import { resolveProjectFromParams } from '@/lib/project-context';
import { getDoctorReport } from '@/lib/queries/doctor';

/**
 * `/projects/[slug]/doctor` — live doctor report (M04 Phase 2 S8).
 *
 * Server-rendered. Each request runs the doctor probe set fresh
 * against the dev server's cwd — `force-dynamic` + the auto-refresh
 * meta tag give a quasi-live experience without client JS or SSE.
 *
 * `?scope=full` toggles to the full registry (~35 checks). The default
 * surface stays essential (~11 install-gate invariants per
 * decision dec_83ba10c1) because that's what an operator wants to see
 * at the top of the doctor page.
 *
 * Note on scope: doctor checks today probe `~/.contextos/`, the local
 * data.db, the bridge & MCP server health, IDE registration and
 * pending-job depth — all workspace-grain, not project-grain. The page
 * lives at /projects/[slug]/doctor for navigation symmetry; a future
 * refinement adds per-project filtering when the checks support it.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly scope?: string;
  readonly autorefresh?: string;
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const sp = await searchParams;
  if (sp.autorefresh !== '1') return {};
  // 5-second meta refresh — server-side, no client JS, no biome
  // noHeadElement complaint.
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
  const scope = sp.scope === 'full' ? 'full' : 'essential';
  const autorefresh = sp.autorefresh === '1';
  const report = await getDoctorReport(scope);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
            Doctor
          </h1>
          <ScopeToggle projectSlug={project.slug} scope={scope} autorefresh={autorefresh} />
        </div>
        <p className="text-sm text-(--color-text-secondary)">
          Workspace-grain health checks. Scope: <span className="font-mono">{scope}</span> ({report.checks.length}{' '}
          checks). Last run <span className="font-mono">{new Date().toISOString()}</span>.
        </p>
      </header>

      <SummaryStrip
        ok={report.summary.ok}
        warn={report.summary.warn}
        fail={report.summary.fail}
        skipped={report.summary.skipped}
      />

      <table className="w-full border border-(--color-border-subtle)">
        <thead className="bg-(--color-bg-elevated)">
          <tr>
            <Th>Status</Th>
            <Th>Id</Th>
            <Th>Name</Th>
            <Th>Detail</Th>
            <Th>Remediation</Th>
            <Th>ms</Th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
              <td className="px-3 py-2 align-top">
                <StatusDot status={c.status} />
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs text-(--color-text-tertiary)">{c.id}</td>
              <td className="px-3 py-2 align-top font-mono text-sm text-(--color-text-primary)">{c.name}</td>
              <td className="px-3 py-2 align-top text-xs text-(--color-text-secondary)">{c.detail ?? '—'}</td>
              <td className="px-3 py-2 align-top text-xs text-(--color-text-tertiary)">{c.remediation ?? ''}</td>
              <td className="px-3 py-2 align-top font-mono text-xs text-(--color-text-tertiary)">{c.durationMs}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-(--color-text-tertiary)">
        contextos home: <span className="font-mono">{report.contextosHome}</span> · cwd:{' '}
        <span className="font-mono">{report.cwd}</span> · version <span className="font-mono">{report.version}</span>
      </p>

      <div className="flex gap-3">
        <Link
          href={
            `/projects/${encodeURIComponent(project.slug)}/doctor?scope=${scope}&autorefresh=${autorefresh ? '1' : '0'}` as never
          }
          className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
        >
          ↻ Re-run now
        </Link>
        <Link
          href={`/projects/${encodeURIComponent(project.slug)}` as never}
          className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-brand)"
        >
          ◂ Back to project
        </Link>
      </div>
    </div>
  );
}

function ScopeToggle({
  projectSlug,
  scope,
  autorefresh,
}: {
  readonly projectSlug: string;
  readonly scope: 'essential' | 'full';
  readonly autorefresh: boolean;
}) {
  const altScope = scope === 'essential' ? 'full' : 'essential';
  return (
    <div className="flex items-center gap-3 text-xs">
      <Link
        href={
          `/projects/${encodeURIComponent(projectSlug)}/doctor?scope=${altScope}&autorefresh=${autorefresh ? '1' : '0'}` as never
        }
        className="border border-(--color-border-default) bg-(--color-bg-base) px-3 py-1.5 font-display font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
      >
        Switch to {altScope}
      </Link>
      <Link
        href={
          `/projects/${encodeURIComponent(projectSlug)}/doctor?scope=${scope}&autorefresh=${autorefresh ? '0' : '1'}` as never
        }
        className="border border-(--color-border-default) bg-(--color-bg-base) px-3 py-1.5 font-display font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
      >
        Auto-refresh: {autorefresh ? 'on' : 'off'}
      </Link>
    </div>
  );
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
    <div className="flex gap-2">
      <Pill colorClass="bg-(--color-status-success)/15 text-(--color-status-success)">{ok} green</Pill>
      <Pill colorClass="bg-(--color-status-warning)/15 text-(--color-status-warning)">{warn} yellow</Pill>
      <Pill colorClass="bg-(--color-status-error)/15 text-(--color-status-error)">{fail} red</Pill>
      <Pill colorClass="bg-(--color-bg-elevated) text-(--color-text-tertiary)">{skipped} skipped</Pill>
    </div>
  );
}

function Pill({ colorClass, children }: { readonly colorClass: string; readonly children: React.ReactNode }) {
  return (
    <span className={`px-3 py-1 font-display text-xs font-bold uppercase tracking-wider ${colorClass}`}>
      {children}
    </span>
  );
}

function StatusDot({ status }: { readonly status: 'green' | 'yellow' | 'red' | 'skipped' | 'timeout' }) {
  const map: Record<typeof status, string> = {
    green: 'bg-(--color-status-success)',
    yellow: 'bg-(--color-status-warning)',
    red: 'bg-(--color-status-error)',
    timeout: 'bg-(--color-status-error)',
    skipped: 'bg-(--color-text-tertiary)',
  } as const;
  return (
    <span className="flex items-center gap-2">
      <span className={`inline-block h-3 w-3 rounded-full ${map[status]}`} title={status} />
      <span className="font-mono text-xs">{status}</span>
    </span>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}
