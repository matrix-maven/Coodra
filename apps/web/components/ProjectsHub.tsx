'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ProjectCard } from '@/components/ProjectCard';
import { EmptyState, LinkButton, PageHeader, PlusIcon, SearchIcon, Section, StatPill, Topbar } from '@/components/ui';
import type { PickerProjectTile } from '@/lib/queries/picker';

/**
 * `apps/web/components/ProjectsHub.tsx` — editorial workspace shell
 * for the project picker page (the application's `/` route).
 *
 * Mirrors brand-kit Dashboard (screen 01): editorial hero + four-stat
 * row + recent runs / system state side-by-side.
 */

export interface ProjectsHubProps {
  readonly projects: ReadonlyArray<PickerProjectTile>;
  readonly mode: 'solo' | 'team';
  readonly fetchedAt: string;
  readonly systemStatus: SystemStatus;
}

export type SystemStatus = {
  readonly tone: 'success' | 'warning' | 'error';
  readonly label: string;
  readonly hint: string;
};

type SortKey = 'recent' | 'name' | 'attention';

export function ProjectsHub({ projects, mode, fetchedAt, systemStatus }: ProjectsHubProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('attention');
  const [refreshedLabel, setRefreshedLabel] = useState(() => new Date(fetchedAt).toLocaleTimeString());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setRefreshedLabel(new Date(fetchedAt).toLocaleTimeString());
  }, [fetchedAt]);

  // ⌘K / Ctrl-K to focus the search input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const totals = useMemo(
    () =>
      projects.reduce(
        (acc, p) => {
          acc.activeRuns += p.activeRuns;
          acc.denials24h += p.denials24h;
          acc.activeKillSwitches += p.activeKillSwitches;
          if (p.statusDot === 'red') acc.alerting += 1;
          else if (p.statusDot === 'amber') acc.paused += 1;
          else if (p.statusDot === 'green') acc.active += 1;
          else acc.idle += 1;
          return acc;
        },
        { activeRuns: 0, denials24h: 0, activeKillSwitches: 0, alerting: 0, paused: 0, active: 0, idle: 0 },
      ),
    [projects],
  );

  const attentionList = useMemo(() => projects.filter((p) => p.statusDot === 'red'), [projects]);

  const filteredSorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? projects.slice()
        : projects.filter(
            (p) =>
              p.slug.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.orgId.toLowerCase().includes(q),
          );
    if (sort === 'name') {
      return filtered.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (sort === 'attention') {
      const order: Record<string, number> = { red: 0, amber: 1, green: 2, gray: 3 };
      return filtered.sort((a, b) => {
        const da = order[a.statusDot] ?? 9;
        const db = order[b.statusDot] ?? 9;
        if (da !== db) return da - db;
        const at = a.lastActivityAt ?? '';
        const bt = b.lastActivityAt ?? '';
        return bt.localeCompare(at);
      });
    }
    return filtered.sort((a, b) => {
      const at = a.lastActivityAt ?? '';
      const bt = b.lastActivityAt ?? '';
      if (at === '' && bt === '') return a.slug.localeCompare(b.slug);
      if (at === '') return 1;
      if (bt === '') return -1;
      return bt.localeCompare(at);
    });
  }, [projects, query, sort]);

  const statusTone = systemStatus.tone === 'success' ? 'ok' : systemStatus.tone === 'warning' ? 'caution' : 'warn';

  return (
    <>
      <Topbar
        crumbs={[{ label: 'contextos' }, { label: 'Projects' }]}
        search={<SearchInput query={query} onQueryChange={setQuery} inputRef={inputRef} />}
        actions={
          <>
            <span title={systemStatus.hint}>
              <StatPill tone={statusTone} dot>
                {systemStatus.label}
              </StatPill>
            </span>
            <LinkButton href="/init" variant="primary" leftIcon={<PlusIcon className="h-3 w-3" />}>
              New project
            </LinkButton>
          </>
        }
      />

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-(--content-max) px-12 pt-14 pb-20 outline-none">
        <PageHeader
          eyebrow="/00 · WORKSPACE"
          title={
            <>
              Master the <em>context</em>.
            </>
          }
          subtitle="All runs across every project. Decisions, denials, and durable packs in one quiet plane. Local-first. Read-only."
          meta={
            <>
              <strong className="font-medium text-text-primary">
                {projects.length} project{projects.length === 1 ? '' : 's'}
              </strong>
              <br />
              {totals.active} active · {totals.idle} idle
              <br />v 0.4.1 · {mode}
            </>
          }
          actions={
            <>
              <LinkButton href="/sync" variant="ghost">
                Export audit
              </LinkButton>
              <LinkButton href="/init" variant="primary">
                New project
              </LinkButton>
            </>
          }
        />

        {projects.length === 0 ? (
          <EmptyState
            size="lg"
            title={
              <>
                No <em>projects</em> yet
              </>
            }
            body={
              <>
                ContextOS organises everything around projects. Create one from the web wizard, or run{' '}
                <span className="font-mono text-accent">
                  contextos init --project-slug X --no-graphify --ide claude
                </span>{' '}
                in a project root.
              </>
            }
            action={
              <LinkButton href="/init" variant="primary" leftIcon={<PlusIcon className="h-3 w-3" />}>
                Create project
              </LinkButton>
            }
          />
        ) : (
          <>
            {/* Stat row · 4 cells, top + bottom rule */}
            <div className="mb-14 grid grid-cols-4 border-y border-rule">
              <StatCell
                label="Projects"
                value={projects.length}
                hint={`${totals.active} active · ${totals.idle} idle`}
                divider
              />
              <StatCell
                label="Active runs"
                value={totals.activeRuns}
                hint="Open agent sessions"
                emphasis={totals.activeRuns > 0}
                divider
              />
              <StatCell
                label="Denials · 24h"
                value={totals.denials24h}
                hint={
                  totals.alerting > 0
                    ? `${totals.alerting} project${totals.alerting === 1 ? '' : 's'} affected`
                    : 'No refusals in last 24 hours'
                }
                tone={totals.denials24h > 0 ? 'error' : 'neutral'}
                divider
              />
              <StatCell
                label="Active switches"
                value={totals.activeKillSwitches}
                hint={
                  totals.paused > 0
                    ? `${totals.paused} project${totals.paused === 1 ? '' : 's'} paused`
                    : 'No kill switches engaged'
                }
                tone={totals.activeKillSwitches > 0 ? 'warning' : 'neutral'}
                emphasis={totals.activeKillSwitches === 0}
              />
            </div>

            {attentionList.length > 0 ? <NeedsAttentionBanner items={attentionList} /> : null}

            <Section
              title={
                <>
                  All <em>projects</em>
                </>
              }
              count={`${filteredSorted.length} · synced`}
              actions={
                <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
                  Sort
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="h-8 border border-rule-strong bg-bg-base px-3 pr-8 font-mono text-[11px] text-text-primary transition-colors hover:border-text-tertiary focus-visible:outline-none focus:border-accent"
                  >
                    <option value="attention">Status</option>
                    <option value="recent">Recent</option>
                    <option value="name">Name (A→Z)</option>
                  </select>
                </label>
              }
            >
              {filteredSorted.length === 0 ? (
                <EmptyState
                  title={
                    <>
                      No <em>matching</em> projects
                    </>
                  }
                  body={
                    <>
                      No projects match <span className="font-mono text-accent">"{query}"</span>. Try a different
                      search.
                    </>
                  }
                />
              ) : (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {filteredSorted.map((p) => (
                    <ProjectCard key={p.id} {...p} />
                  ))}
                </div>
              )}
            </Section>

            {/* Tile is exported by the barrel for downstream pages — we don't use it on this surface. */}
          </>
        )}

        <footer className="mt-14 border-t border-rule pt-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          Last refreshed <span suppressHydrationWarning>{refreshedLabel}</span>
        </footer>
      </main>
    </>
  );
}

/* ───────────────────────── Search input ───────────────────────── */

function SearchInput({
  query,
  onQueryChange,
  inputRef,
}: {
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="relative flex h-8 w-[320px] items-center border border-rule-strong bg-bg-elevated px-3.5 font-mono text-[11px] text-text-tertiary tracking-[0.04em] transition-colors hover:border-text-tertiary focus-within:border-accent">
      <SearchIcon className="pointer-events-none mr-2.5 h-3 w-3 text-text-muted" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search projects, runs, packs…"
        className="w-full bg-transparent font-mono text-[11px] text-text-primary placeholder:text-text-muted focus-visible:outline-none"
      />
      <span className="ml-2 border border-rule-strong px-1.5 py-[1px] font-mono text-[9px] text-text-muted">⌘K</span>
    </label>
  );
}

/* ───────────────────────── Stat cell ───────────────────────── */

function StatCell({
  label,
  value,
  hint,
  emphasis,
  tone,
  divider,
}: {
  readonly label: string;
  readonly value: number;
  readonly hint: string;
  readonly emphasis?: boolean;
  readonly tone?: 'neutral' | 'error' | 'warning';
  readonly divider?: boolean;
}) {
  const dividerCls = divider === true ? 'border-r border-rule' : '';
  const hintCls =
    tone === 'error' ? 'text-status-error' : tone === 'warning' ? 'text-status-warning' : 'text-text-tertiary';
  return (
    <div className={`px-7 py-8 ${dividerCls}`}>
      <div className="eyebrow mb-5 text-text-tertiary">{label}</div>
      <div className="num-display text-[64px] leading-[0.95] text-text-primary">
        {emphasis ? <em>{value}</em> : value}
      </div>
      <div className={`mt-3 font-mono text-[10px] tracking-[0.08em] ${hintCls}`}>{hint}</div>
    </div>
  );
}

/* ───────────────────────── Needs attention banner ───────────────────────── */

function NeedsAttentionBanner({ items }: { readonly items: ReadonlyArray<PickerProjectTile> }) {
  const headline = items[0];
  const more = items.length - 1;
  return (
    <div className="mb-14 flex items-center gap-5 border border-status-error/40 bg-bg-surface px-6 py-5">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-status-error" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-status-error">
          /needs attention · {items.length}
        </span>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="heading-display text-[24px] text-text-primary">
            <span>{headline?.name ?? ''}</span>
          </span>
          <span className="font-mono text-[11px] tracking-[0.04em] text-text-tertiary">
            {(headline?.denials24h ?? 0) === 1
              ? '1 denial in the last 24 hours'
              : `${headline?.denials24h ?? 0} denials in the last 24 hours`}
          </span>
        </div>
      </div>
      <Link
        href={`/projects/${encodeURIComponent(headline?.slug ?? '')}` as never}
        className="shrink-0 border border-rule-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-primary transition-colors hover:border-accent hover:text-accent"
      >
        {more > 0 ? `Open · +${more} more` : 'Open'}
      </Link>
    </div>
  );
}
