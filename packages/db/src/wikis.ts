import { desc, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/wikis.ts` — Module 10 Deep Wiki read surface for the
 * web app (and any other read consumer). Dialect-dispatched, mirroring
 * `runs-admin.ts` / `policies.ts`. The wiki *write* path lives in the
 * mcp-server's tool handlers; this module is read-only.
 */

export interface WikiListItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly mode: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly updatedAt: Date;
  readonly pageCount: number;
  readonly authoredCount: number;
}

export interface WikiPageDetail {
  readonly pageId: string;
  readonly state: string;
  readonly contentMarkdown: string;
  /** JSON-encoded WikiCitation[]. */
  readonly citations: string;
}

export interface WikiDetail {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly mode: string;
  /** JSON-encoded WikiStructure envelope. */
  readonly structureJson: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly updatedAt: Date;
  readonly pages: ReadonlyArray<WikiPageDetail>;
}

async function pageStateCounts(db: DbHandle, wikiId: string): Promise<{ total: number; authored: number }> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ state: sqliteSchema.wikiPages.state })
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.wikiId, wikiId));
    return { total: rows.length, authored: rows.filter((r) => r.state === 'authored').length };
  }
  const rows = await db.db
    .select({ state: postgresSchema.wikiPages.state })
    .from(postgresSchema.wikiPages)
    .where(eq(postgresSchema.wikiPages.wikiId, wikiId));
  return { total: rows.length, authored: rows.filter((r) => r.state === 'authored').length };
}

/**
 * List every wiki across the store, joined to its project, newest first,
 * with page counts. The web `/wiki` index groups these by project.
 */
export async function listWikisDetailed(db: DbHandle): Promise<WikiListItem[]> {
  const base =
    db.kind === 'sqlite'
      ? await db.db
          .select({
            id: sqliteSchema.wikis.id,
            slug: sqliteSchema.wikis.slug,
            title: sqliteSchema.wikis.title,
            mode: sqliteSchema.wikis.mode,
            projectId: sqliteSchema.wikis.projectId,
            projectSlug: sqliteSchema.projects.slug,
            projectName: sqliteSchema.projects.name,
            updatedAt: sqliteSchema.wikis.updatedAt,
          })
          .from(sqliteSchema.wikis)
          .innerJoin(sqliteSchema.projects, eq(sqliteSchema.wikis.projectId, sqliteSchema.projects.id))
          .orderBy(desc(sqliteSchema.wikis.updatedAt))
      : await db.db
          .select({
            id: postgresSchema.wikis.id,
            slug: postgresSchema.wikis.slug,
            title: postgresSchema.wikis.title,
            mode: postgresSchema.wikis.mode,
            projectId: postgresSchema.wikis.projectId,
            projectSlug: postgresSchema.projects.slug,
            projectName: postgresSchema.projects.name,
            updatedAt: postgresSchema.wikis.updatedAt,
          })
          .from(postgresSchema.wikis)
          .innerJoin(postgresSchema.projects, eq(postgresSchema.wikis.projectId, postgresSchema.projects.id))
          .orderBy(desc(postgresSchema.wikis.updatedAt));

  const out: WikiListItem[] = [];
  for (const w of base) {
    const counts = await pageStateCounts(db, w.id);
    out.push({ ...w, pageCount: counts.total, authoredCount: counts.authored });
  }
  return out;
}

/** Fetch one wiki by id with its full page bodies. null when no such wiki. */
export async function getWikiDetail(db: DbHandle, wikiId: string): Promise<WikiDetail | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.wikis.id,
        slug: sqliteSchema.wikis.slug,
        title: sqliteSchema.wikis.title,
        description: sqliteSchema.wikis.description,
        mode: sqliteSchema.wikis.mode,
        structureJson: sqliteSchema.wikis.structureJson,
        projectId: sqliteSchema.wikis.projectId,
        projectSlug: sqliteSchema.projects.slug,
        updatedAt: sqliteSchema.wikis.updatedAt,
      })
      .from(sqliteSchema.wikis)
      .innerJoin(sqliteSchema.projects, eq(sqliteSchema.wikis.projectId, sqliteSchema.projects.id))
      .where(eq(sqliteSchema.wikis.id, wikiId))
      .limit(1);
    const wiki = rows[0];
    if (!wiki) return null;
    const pages = await db.db
      .select({
        pageId: sqliteSchema.wikiPages.pageId,
        state: sqliteSchema.wikiPages.state,
        contentMarkdown: sqliteSchema.wikiPages.contentMarkdown,
        citations: sqliteSchema.wikiPages.citations,
      })
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.wikiId, wikiId));
    return { ...wiki, pages };
  }
  const rows = await db.db
    .select({
      id: postgresSchema.wikis.id,
      slug: postgresSchema.wikis.slug,
      title: postgresSchema.wikis.title,
      description: postgresSchema.wikis.description,
      mode: postgresSchema.wikis.mode,
      structureJson: postgresSchema.wikis.structureJson,
      projectId: postgresSchema.wikis.projectId,
      projectSlug: postgresSchema.projects.slug,
      updatedAt: postgresSchema.wikis.updatedAt,
    })
    .from(postgresSchema.wikis)
    .innerJoin(postgresSchema.projects, eq(postgresSchema.wikis.projectId, postgresSchema.projects.id))
    .where(eq(postgresSchema.wikis.id, wikiId))
    .limit(1);
  const wiki = rows[0];
  if (!wiki) return null;
  const pages = await db.db
    .select({
      pageId: postgresSchema.wikiPages.pageId,
      state: postgresSchema.wikiPages.state,
      contentMarkdown: postgresSchema.wikiPages.contentMarkdown,
      citations: postgresSchema.wikiPages.citations,
    })
    .from(postgresSchema.wikiPages)
    .where(eq(postgresSchema.wikiPages.wikiId, wikiId));
  return { ...wiki, pages };
}
