import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusChip } from '@/components/StatusChip';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listRunsAndContextPacksForProject } from '@/lib/queries/pack-runs';
import { getPack } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs/[packSlug]/runs` — pack-scoped activity panel
 * (M04 Phase 2 S7).
 *
 * Lists Context Packs and Runs that belong to the *project* that owns
 * this pack. The header makes the scope explicit because the schema
 * does not yet carry a `feature_pack_id` foreign key on either table —
 * filtering further per-pack would be a lie until M05 adds the FK.
 *
 * Renders two stacked sections:
 *   1. Context Packs — newest first, link to /projects/[slug]/context-packs/[id]
 *   2. Runs — newest first, link to /projects/[slug]/runs/[id]
 *
 * Both have brand-styled empty states with explanations of why a list
 * might be blank (no runs yet, or session never reached the
 * save_context_pack call).
 */

export const dynamic = 'force-dynamic';

const RUNS_LIMIT = 50;
const CONTEXT_PACKS_LIMIT = 50;

export default async function PackActivityPage({ params }: { params: Promise<{ slug: string; packSlug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const { packSlug: rawPackSlug } = await params;
  const packSlug = decodeURIComponent(rawPackSlug);
  const pack = getPack(packSlug);
  if (pack === null) notFound();
  if (pack.slug !== project.slug && pack.parentSlug !== project.slug) notFound();

  const { runs, contextPacks, hasMoreRuns } = await listRunsAndContextPacksForProject({
    projectId: project.id,
    runsLimit: RUNS_LIMIT,
    contextPacksLimit: CONTEXT_PACKS_LIMIT,
  });

  const projectHref = `/projects/${encodeURIComponent(project.slug)}`;
  const packHref = `${projectHref}/packs/${encodeURIComponent(pack.slug)}`;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
            Activity for{' '}
            <span className="font-mono text-2xl normal-case tracking-normal text-(--color-text-code)">{pack.slug}</span>
          </h1>
          <Link
            href={packHref as never}
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-brand)"
          >
            ◂ Back to pack
          </Link>
        </div>
        <p className="text-sm text-(--color-text-secondary)">
          Runs and context packs for the project{' '}
          <Link href={projectHref as never} className="font-mono text-(--color-brand) hover:underline">
            {project.slug}
          </Link>{' '}
          that owns this pack.
        </p>
        <p className="text-xs text-(--color-text-tertiary)">
          Pack-grain filtering arrives with M05 (NL Assembly) — the schema does not yet store the feature-pack FK on
          runs or context packs.
        </p>
      </header>

      <Section
        title="Context packs"
        countLabel={`${contextPacks.length}${contextPacks.length === CONTEXT_PACKS_LIMIT ? '+' : ''}`}
      >
        {contextPacks.length === 0 ? (
          <EmptyState
            primary="No context packs yet for this project."
            secondary="Context packs are written when an agent calls `save_context_pack` (or when the bridge auto-fires on Stop / SessionEnd)."
          />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>Title</Th>
                <Th>Created</Th>
                <Th>Excerpt</Th>
                <Th>Run</Th>
              </tr>
            </thead>
            <tbody>
              {contextPacks.map((cp) => (
                <tr key={cp.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-3 align-top">
                    <Link
                      href={`${projectHref}/context-packs/${encodeURIComponent(cp.id)}` as never}
                      className="font-mono text-sm text-(--color-brand) hover:underline"
                    >
                      {cp.title}
                    </Link>
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs text-(--color-text-tertiary)">
                    {formatDate(cp.createdAt)}
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-(--color-text-secondary)">
                    {truncate(cp.contentExcerpt, 120)}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <Link
                      href={`${projectHref}/runs/${encodeURIComponent(cp.runId)}` as never}
                      className="font-mono text-xs text-(--color-text-secondary) hover:text-(--color-brand)"
                    >
                      {cp.runId.slice(0, 8)}…
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Runs" countLabel={`${runs.length}${hasMoreRuns ? '+' : ''}`}>
        {runs.length === 0 ? (
          <EmptyState
            primary="No runs yet for this project."
            secondary="Start an agent session against this project — Claude Code's SessionStart hook records a run row via the bridge."
          />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>Run</Th>
                <Th>Agent</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th>Ended</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-3 align-top">
                    <Link
                      href={`${projectHref}/runs/${encodeURIComponent(r.id)}` as never}
                      className="font-mono text-sm text-(--color-brand) hover:underline"
                    >
                      {r.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs text-(--color-text-secondary)">{r.agentType}</td>
                  <td className="px-3 py-3 align-top">
                    <StatusChip status={statusKind(r.status)}>{r.status}</StatusChip>
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs text-(--color-text-tertiary)">
                    {formatDate(r.startedAt)}
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs text-(--color-text-tertiary)">
                    {r.endedAt === null ? '—' : formatDate(r.endedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function statusKind(status: string): 'success' | 'warning' | 'error' | 'neutral' | 'info' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'info';
    case 'cancelled':
      return 'warning';
    case 'failed':
    case 'abandoned':
      return 'error';
    default:
      return 'neutral';
  }
}

function Section({
  title,
  countLabel,
  children,
}: {
  readonly title: string;
  readonly countLabel: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">{title}</h2>
        <span className="font-mono text-xs text-(--color-text-tertiary)">{countLabel}</span>
      </div>
      {children}
    </section>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}

function EmptyState({ primary, secondary }: { readonly primary: string; readonly secondary: string }) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-8 text-center">
      <p className="font-display text-base font-light uppercase tracking-wider text-(--color-text-secondary)">
        {primary}
      </p>
      <p className="mt-2 text-xs text-(--color-text-tertiary)">{secondary}</p>
    </div>
  );
}

function formatDate(d: Date): string {
  // YYYY-MM-DD HH:MM (UTC) — locale-free for repeatable rendering.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
