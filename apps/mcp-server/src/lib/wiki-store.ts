import { randomUUID } from 'node:crypto';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import type { WikiPageContent, WikiStructure } from '@coodra/shared/wiki';
import { and, eq } from 'drizzle-orm';

/**
 * `apps/mcp-server/src/lib/wiki-store.ts` — Module 10 Deep Wiki DB
 * access, dialect-dispatched.
 *
 * The three wiki MCP tools (`wiki_save_structure`, `wiki_save_page`,
 * `wiki_status`) all need the same SQLite/Postgres-branching primitives.
 * Concentrating them here keeps the handlers thin and means the dual-
 * dialect logic lives in one reviewable place (mirrors how
 * `context-pack.ts` centralises the context_packs write).
 *
 * No explicit transaction: the mcp-server convention is discrete
 * idempotent statements (see record-decision / save-context-pack). A
 * re-fired `wiki_save_structure` is a full re-plan (DELETE-then-INSERT
 * of the page skeleton) so a crash mid-regeneration self-heals on the
 * next call.
 */

/** Resolve `runs.projectId` for a runId. null when the run does not exist. */
export async function selectRunProjectId(db: DbHandle, runId: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ projectId: sqliteSchema.runs.projectId })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }
  const rows = await db.db
    .select({ projectId: postgresSchema.runs.projectId })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

async function selectWikiIdByProjectSlug(db: DbHandle, projectId: string, slug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.wikis.id })
      .from(sqliteSchema.wikis)
      .where(and(eq(sqliteSchema.wikis.projectId, projectId), eq(sqliteSchema.wikis.slug, slug)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.wikis.id })
    .from(postgresSchema.wikis)
    .where(and(eq(postgresSchema.wikis.projectId, projectId), eq(postgresSchema.wikis.slug, slug)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface UpsertWikiStructureArgs {
  readonly projectId: string;
  readonly runId: string;
  readonly slug: string;
  readonly structure: WikiStructure;
  readonly actorUserId: string | null;
  readonly orgId: string | null;
  readonly now: Date;
}

export interface UpsertWikiStructureResult {
  readonly wikiId: string;
  readonly status: 'created' | 'replaced';
}

/**
 * Upsert a wiki structure by `(projectId, slug)` and (re)write its page
 * skeleton: every `structure.pages[i]` becomes a `wiki_pages` row in
 * `state='pending'`. A pre-existing wiki for the same key is replaced
 * (its pages are deleted first — ON DELETE CASCADE makes this clean) so
 * a re-plan supersedes the prior attempt.
 */
export async function upsertWikiStructure(
  db: DbHandle,
  args: UpsertWikiStructureArgs,
): Promise<UpsertWikiStructureResult> {
  const existingId = await selectWikiIdByProjectSlug(db, args.projectId, args.slug);
  const structureJson = JSON.stringify(args.structure);
  const wikiId = existingId ?? `wiki_${randomUUID()}`;
  const status: 'created' | 'replaced' = existingId ? 'replaced' : 'created';

  if (db.kind === 'sqlite') {
    if (existingId) {
      await db.db
        .update(sqliteSchema.wikis)
        .set({
          title: args.structure.title,
          description: args.structure.description,
          mode: args.structure.mode,
          schemaVersion: args.structure.schemaVersion,
          structureJson,
          generatedByRunId: args.runId,
          createdByUserId: args.actorUserId,
          orgId: args.orgId,
          updatedAt: args.now,
        })
        .where(eq(sqliteSchema.wikis.id, existingId));
      await db.db.delete(sqliteSchema.wikiPages).where(eq(sqliteSchema.wikiPages.wikiId, existingId));
    } else {
      await db.db.insert(sqliteSchema.wikis).values({
        id: wikiId,
        projectId: args.projectId,
        slug: args.slug,
        title: args.structure.title,
        description: args.structure.description,
        mode: args.structure.mode,
        schemaVersion: args.structure.schemaVersion,
        structureJson,
        generatedByRunId: args.runId,
        createdByUserId: args.actorUserId,
        orgId: args.orgId,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    if (args.structure.pages.length > 0) {
      await db.db.insert(sqliteSchema.wikiPages).values(
        args.structure.pages.map((page) => ({
          id: `wp_${randomUUID()}`,
          wikiId,
          pageId: page.id,
          state: 'pending' as const,
          contentMarkdown: '',
          citations: '[]',
          authoredByRunId: null,
          createdByUserId: args.actorUserId,
          orgId: args.orgId,
          createdAt: args.now,
          updatedAt: args.now,
        })),
      );
    }
    return { wikiId, status };
  }

  if (existingId) {
    await db.db
      .update(postgresSchema.wikis)
      .set({
        title: args.structure.title,
        description: args.structure.description,
        mode: args.structure.mode,
        schemaVersion: args.structure.schemaVersion,
        structureJson,
        generatedByRunId: args.runId,
        createdByUserId: args.actorUserId,
        orgId: args.orgId,
        updatedAt: args.now,
      })
      .where(eq(postgresSchema.wikis.id, existingId));
    await db.db.delete(postgresSchema.wikiPages).where(eq(postgresSchema.wikiPages.wikiId, existingId));
  } else {
    await db.db.insert(postgresSchema.wikis).values({
      id: wikiId,
      projectId: args.projectId,
      slug: args.slug,
      title: args.structure.title,
      description: args.structure.description,
      mode: args.structure.mode,
      schemaVersion: args.structure.schemaVersion,
      structureJson,
      generatedByRunId: args.runId,
      createdByUserId: args.actorUserId,
      orgId: args.orgId,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }
  if (args.structure.pages.length > 0) {
    await db.db.insert(postgresSchema.wikiPages).values(
      args.structure.pages.map((page) => ({
        id: `wp_${randomUUID()}`,
        wikiId,
        pageId: page.id,
        state: 'pending' as const,
        contentMarkdown: '',
        citations: '[]',
        authoredByRunId: null,
        createdByUserId: args.actorUserId,
        orgId: args.orgId,
        createdAt: args.now,
        updatedAt: args.now,
      })),
    );
  }
  return { wikiId, status };
}

export interface WikiRow {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly title: string;
  readonly mode: string;
  readonly structureJson: string;
}

/** Fetch a wiki row by id. null when no such wiki. */
export async function selectWikiById(db: DbHandle, wikiId: string): Promise<WikiRow | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.wikis.id,
        projectId: sqliteSchema.wikis.projectId,
        slug: sqliteSchema.wikis.slug,
        title: sqliteSchema.wikis.title,
        mode: sqliteSchema.wikis.mode,
        structureJson: sqliteSchema.wikis.structureJson,
      })
      .from(sqliteSchema.wikis)
      .where(eq(sqliteSchema.wikis.id, wikiId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select({
      id: postgresSchema.wikis.id,
      projectId: postgresSchema.wikis.projectId,
      slug: postgresSchema.wikis.slug,
      title: postgresSchema.wikis.title,
      mode: postgresSchema.wikis.mode,
      structureJson: postgresSchema.wikis.structureJson,
    })
    .from(postgresSchema.wikis)
    .where(eq(postgresSchema.wikis.id, wikiId))
    .limit(1);
  return rows[0] ?? null;
}

export interface WikiPageStateRow {
  readonly pageId: string;
  readonly state: string;
}

/** All `(pageId, state)` rows for a wiki — drives status + progress counts. */
export async function selectWikiPageStates(db: DbHandle, wikiId: string): Promise<ReadonlyArray<WikiPageStateRow>> {
  if (db.kind === 'sqlite') {
    return db.db
      .select({ pageId: sqliteSchema.wikiPages.pageId, state: sqliteSchema.wikiPages.state })
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.wikiId, wikiId));
  }
  return db.db
    .select({ pageId: postgresSchema.wikiPages.pageId, state: postgresSchema.wikiPages.state })
    .from(postgresSchema.wikiPages)
    .where(eq(postgresSchema.wikiPages.wikiId, wikiId));
}

export interface AuthorWikiPageArgs {
  readonly wikiId: string;
  readonly pageId: string;
  readonly content: WikiPageContent;
  readonly runId: string;
  readonly actorUserId: string | null;
  readonly orgId: string | null;
  readonly now: Date;
}

/**
 * Flip a wiki page to `state='authored'` with its body + citations.
 * Returns the page row's id, or null when no `(wikiId, pageId)` row
 * matched (the pageId is not in the wiki's structure skeleton) — the
 * caller maps that to the `page_not_in_structure` soft-failure. The id is
 * also the team-sync enqueue key.
 */
export async function authorWikiPage(db: DbHandle, args: AuthorWikiPageArgs): Promise<string | null> {
  const citationsJson = JSON.stringify(args.content.citations);
  if (db.kind === 'sqlite') {
    const updated = await db.db
      .update(sqliteSchema.wikiPages)
      .set({
        state: 'authored',
        contentMarkdown: args.content.contentMarkdown,
        citations: citationsJson,
        authoredByRunId: args.runId,
        createdByUserId: args.actorUserId,
        orgId: args.orgId,
        updatedAt: args.now,
      })
      .where(and(eq(sqliteSchema.wikiPages.wikiId, args.wikiId), eq(sqliteSchema.wikiPages.pageId, args.pageId)))
      .returning({ id: sqliteSchema.wikiPages.id });
    return updated[0]?.id ?? null;
  }
  const updated = await db.db
    .update(postgresSchema.wikiPages)
    .set({
      state: 'authored',
      contentMarkdown: args.content.contentMarkdown,
      citations: citationsJson,
      authoredByRunId: args.runId,
      createdByUserId: args.actorUserId,
      orgId: args.orgId,
      updatedAt: args.now,
    })
    .where(and(eq(postgresSchema.wikiPages.wikiId, args.wikiId), eq(postgresSchema.wikiPages.pageId, args.pageId)))
    .returning({ id: postgresSchema.wikiPages.id });
  return updated[0]?.id ?? null;
}
