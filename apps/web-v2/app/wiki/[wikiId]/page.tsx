import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { WikiReader } from '@/components/wiki/WikiReader';
import { getWiki } from '@/lib/queries/wiki';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly wikiId: string }>;
}

/**
 * `/wiki/[wikiId]` — Module 10 Deep Wiki reader. Renders the hierarchical
 * mind-map nav + the selected page's Markdown (with Mermaid diagrams).
 * The structure + page bodies come from the local SQLite store (solo) or
 * cloud Postgres (team), authored by the user's agent via the wiki_* MCP
 * tools.
 */
export default async function WikiDetailPage({ params }: PageProps) {
  const { wikiId } = await params;
  const view = await getWiki(wikiId);
  if (view === null) notFound();

  const total = view.structure?.pages.length ?? 0;
  const authored = Object.values(view.pages).filter((p) => p.state === 'authored').length;

  return (
    <>
      <Topbar crumb="Deep Wiki" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /10 · DEEP WIKI ·{' '}
              <Link href="/wiki" style={{ color: 'var(--accent)' }}>
                all wikis
              </Link>
            </div>
            <h1 className="head__title">{view.title}</h1>
            <p className="head__lede">{view.description}</p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {authored} / {total} pages
              </strong>
              <br />
              {view.projectSlug} · {view.mode}
            </div>
          </div>
        </div>

        {view.structure === null ? (
          <div className="empty">
            <strong>This wiki's structure couldn't be read.</strong>
            Re-generate it:{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra wiki generate</span> then ask the
            agent to rebuild.
          </div>
        ) : (
          <WikiReader structure={view.structure} pages={view.pages} />
        )}
      </section>
    </>
  );
}
