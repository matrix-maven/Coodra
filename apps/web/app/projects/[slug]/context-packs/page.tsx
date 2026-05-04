import Link from 'next/link';

import { resolveProjectFromParams } from '@/lib/project-context';
import { listContextPacks } from '@/lib/queries/context-packs';

/**
 * `/projects/[slug]/context-packs` — Context Packs list (M04 Phase 2 S9).
 *
 * Newest-first table of context packs for the URL-bound project.
 * Detail page lives at `/projects/[slug]/context-packs/[id]` and uses
 * the S4 markdown renderer for the `content` field.
 *
 * Why a dedicated surface (was implicit in Phase 1 as a tab inside
 * `/runs/[id]`): per the user pushback that drove the IA pivot,
 * context packs are project artifacts that survive runs and deserve
 * their own browseable home — runs come and go, the context packs
 * accumulate.
 */

export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 100;

export default async function ContextPacksListPage({ params }: { params: Promise<{ slug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const packs = await listContextPacks({ projectId: project.id, limit: PAGE_LIMIT });
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
          Context packs
        </h1>
        <p className="text-sm text-(--color-text-secondary)">
          {packs.length}
          {packs.length === PAGE_LIMIT ? '+' : ''} pack{packs.length === 1 ? '' : 's'} for{' '}
          <span className="font-mono">{project.slug}</span>, newest first.
        </p>
      </header>

      {packs.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="w-full border border-(--color-border-subtle)">
          <thead className="bg-(--color-bg-elevated)">
            <tr>
              <Th>Title</Th>
              <Th>Created</Th>
              <Th>Excerpt</Th>
              <Th>Run</Th>
              <Th>Open</Th>
            </tr>
          </thead>
          <tbody>
            {packs.map((p) => {
              const detailHref = `${baseHref}/context-packs/${encodeURIComponent(p.id)}`;
              return (
                <tr key={p.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-3 align-top">
                    <Link href={detailHref as never} className="font-mono text-sm text-(--color-brand) hover:underline">
                      {p.title}
                    </Link>
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs text-(--color-text-tertiary)">
                    {formatDate(p.createdAt)}
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-(--color-text-secondary)">
                    {truncate(p.contentExcerpt, 160)}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <Link
                      href={`${baseHref}/runs/${encodeURIComponent(p.runId)}` as never}
                      className="font-mono text-xs text-(--color-text-secondary) hover:text-(--color-brand)"
                    >
                      {p.runId.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <Link
                      href={detailHref as never}
                      className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
                    >
                      Open ▸
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}

function EmptyState() {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-12 text-center">
      <p className="font-display text-base font-light uppercase tracking-wider text-(--color-text-secondary)">
        No context packs yet for this project.
      </p>
      <p className="mt-2 text-xs text-(--color-text-tertiary)">
        Context packs land when an agent calls <span className="font-mono">save_context_pack</span> at session end (or
        when the hooks-bridge auto-fires on Stop / SessionEnd per ADR-012).
      </p>
    </div>
  );
}

function formatDate(d: Date): string {
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
