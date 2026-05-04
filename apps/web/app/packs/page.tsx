import Link from 'next/link';

import { StatusChip } from '@/components/StatusChip';
import { listPacks } from '@/lib/queries/packs';

/**
 * `/packs` — server-rendered list of feature packs in the current
 * project. Reads `<cwd>/docs/feature-packs/<slug>/` directly (no DB).
 *
 * M04 Phase 2 S1 (F1, OQ-9 lock): force-dynamic so newly-scaffolded
 * packs appear without a build. Without this, Next.js bakes the file-
 * system listing at build time and stale results persist forever.
 */
export const dynamic = 'force-dynamic';

export default async function PacksListPage() {
  const packs = listPacks();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Feature packs</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Every pack under <span className="font-mono">docs/feature-packs/</span> in this project.
        </p>
      </header>

      {packs.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="w-full border border-(--color-border-subtle)">
          <thead className="bg-(--color-bg-elevated)">
            <tr>
              <Th>Slug</Th>
              <Th>Parent</Th>
              <Th>Active</Th>
              <Th>Files</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {packs.map((p) => (
              <tr key={p.slug} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                <td className="px-3 py-3 font-mono text-sm font-medium text-(--color-text-code)">{p.slug}</td>
                <td className="px-3 py-3 font-mono text-xs text-(--color-text-tertiary)">{p.parentSlug ?? '—'}</td>
                <td className="px-3 py-3">
                  <StatusChip status={p.isActive ? 'success' : 'neutral'}>
                    {p.isActive ? 'active' : 'inactive'}
                  </StatusChip>
                </td>
                <td className="px-3 py-3 font-mono text-sm">
                  {p.fileCount}/4
                  {p.fileCount < 4 ? (
                    <span
                      className="ml-2 text-(--color-status-warning)"
                      title={`Missing: ${[
                        !p.hasMeta && 'meta.json',
                        !p.hasSpec && 'spec.md',
                        !p.hasImplementation && 'implementation.md',
                        !p.hasTechstack && 'techstack.md',
                      ]
                        .filter(Boolean)
                        .join(', ')}`}
                    >
                      ⚠
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-3">
                  <Link
                    href={`/packs/${encodeURIComponent(p.slug)}` as never}
                    className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
                  >
                    View ▸
                  </Link>
                </td>
              </tr>
            ))}
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
      <p className="font-display text-lg font-light uppercase tracking-wider text-(--color-text-secondary)">
        No feature packs in this project.
      </p>
      <p className="mt-2 text-sm text-(--color-text-tertiary)">
        Run <span className="font-mono">contextos pack new &lt;slug&gt;</span> to scaffold one.
      </p>
    </div>
  );
}
