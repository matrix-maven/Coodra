import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { getWorkPackProject } from '@/lib/queries/work-packs';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly projectSlug: string }>;
}

export default async function WorkPackProjectPage({ params }: PageProps) {
  const { projectSlug } = await params;
  const group = await getWorkPackProject(projectSlug);
  if (group === null) notFound();

  const linked = group.packs.filter((pack) => pack.externalKey !== null).length;
  const synced = group.packs.filter((pack) => pack.syncState === 'synced').length;

  return (
    <>
      <Topbar crumb={`${group.projectSlug} / Work Packs`} crumbPrefix="coodra / work packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /12 · WORK PACKS ·{' '}
              <Link href="/work-packs" style={{ color: 'var(--accent)' }}>
                all projects
              </Link>
            </div>
            <h1 className="head__title">
              <em>{group.projectName}</em> work packs.
            </h1>
            <p className="head__lede">
              Issue-bound implementation records imported for this project. Open a Work Pack to read the local
              requirements, implementation notes, sync history, and linked Jira metadata.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {group.packs.length} work pack{group.packs.length === 1 ? '' : 's'}
              </strong>
              <br />
              {linked} Jira-linked · {synced} synced
              <br />
              .coodra/work-packs/
            </div>
          </div>
        </div>

        <div className="pack-grid">
          {group.packs.map((pack) => {
            const syncedPack = pack.syncState === 'synced';
            return (
              <article key={pack.id} className="pack">
                <Link
                  href={`/work-packs/${encodeURIComponent(group.projectSlug)}/${encodeURIComponent(pack.slug)}`}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  <div
                    className="pack__num"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                  >
                    <span>/ {pack.slug.toUpperCase()}</span>
                    <span className={`badge ${syncedPack ? 'badge--ok' : 'badge--caution'}`}>
                      <span className="badge__dot"></span>
                      {pack.syncState ?? 'LOCAL'}
                    </span>
                  </div>
                  <h3 className="pack__title">{pack.title}</h3>
                  <p className="pack__excerpt">
                    {pack.packType} · {pack.status}
                    {pack.externalKey !== null ? ` · ${pack.externalKey}` : ''}
                    {pack.externalStatus !== null ? ` is ${pack.externalStatus}` : ''}
                  </p>
                </Link>
                <div className="pack__meta">
                  <span>{formatRelative(pack.updatedAt)}</span>
                  {pack.externalUrl !== null ? (
                    <a
                      href={pack.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ marginLeft: 'auto', color: 'var(--ink-mute)', textDecoration: 'none' }}
                    >
                      JIRA ↗
                    </a>
                  ) : (
                    <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>LOCAL</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
