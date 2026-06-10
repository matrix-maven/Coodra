import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteDb, type SqliteHandle } from '../../src/client.js';
import { migrateSqlite } from '../../src/migrate.js';
import { sqliteSchema } from '../../src/schema/index.js';

/**
 * Module 10 — Deep Wiki DB round-trip. Exercises the `wikis` +
 * `wiki_pages` tables against a real migrated SQLite store: the
 * structure row + page skeleton insert, the author-a-page UPDATE, the
 * (wiki_id, page_id) uniqueness, and the ON DELETE CASCADE that a wiki
 * regeneration/delete relies on.
 */

describe('wiki tables — round trip', () => {
  let dir: string;
  let dbPath: string;
  let handle: SqliteHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-rt-'));
    dbPath = join(dir, 'data.db');
    handle = createSqliteDb({ path: dbPath });
    migrateSqlite(handle.db);
    handle.raw.pragma('foreign_keys = ON');
    const now = new Date();
    handle.db
      .insert(sqliteSchema.projects)
      .values({ id: 'proj_1', slug: 'coodra', orgId: 'org_dev_local', name: 'Coodra', createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(() => {
    handle.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function insertWikiWithSkeleton(): void {
    const now = new Date();
    handle.db
      .insert(sqliteSchema.wikis)
      .values({
        id: 'wiki_1',
        projectId: 'proj_1',
        slug: 'coodra',
        title: 'Coodra',
        description: 'desc',
        mode: 'comprehensive',
        schemaVersion: 1,
        structureJson: JSON.stringify({ pages: [{ id: 'intro' }, { id: 'mcp-server' }] }),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    handle.db
      .insert(sqliteSchema.wikiPages)
      .values([
        { id: 'wp_1', wikiId: 'wiki_1', pageId: 'intro', createdAt: now, updatedAt: now },
        { id: 'wp_2', wikiId: 'wiki_1', pageId: 'mcp-server', createdAt: now, updatedAt: now },
      ])
      .run();
  }

  it('inserts a wiki + a pending page skeleton', () => {
    insertWikiWithSkeleton();
    const pages = handle.db
      .select()
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.wikiId, 'wiki_1'))
      .all();
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.state === 'pending')).toBe(true);
    expect(pages.every((p) => p.contentMarkdown === '' && p.citations === '[]')).toBe(true);
  });

  it('authoring a page flips state and persists body + citations', () => {
    insertWikiWithSkeleton();
    handle.db
      .update(sqliteSchema.wikiPages)
      .set({
        state: 'authored',
        contentMarkdown: '# Intro\n\n```mermaid\ngraph TD; A-->B;\n```',
        citations: JSON.stringify([{ file: 'README.md' }]),
        updatedAt: new Date(),
      })
      .where(and(eq(sqliteSchema.wikiPages.wikiId, 'wiki_1'), eq(sqliteSchema.wikiPages.pageId, 'intro')))
      .run();

    const authored = handle.db
      .select()
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.state, 'authored'))
      .all();
    expect(authored).toHaveLength(1);
    expect(authored[0]?.pageId).toBe('intro');
    expect(authored[0]?.contentMarkdown).toContain('mermaid');
  });

  it('enforces UNIQUE(wiki_id, page_id)', () => {
    insertWikiWithSkeleton();
    expect(() =>
      handle.db
        .insert(sqliteSchema.wikiPages)
        .values({ id: 'wp_dup', wikiId: 'wiki_1', pageId: 'intro', createdAt: new Date(), updatedAt: new Date() })
        .run(),
    ).toThrow();
  });

  it('cascades page deletion when the wiki is deleted (regeneration path)', () => {
    insertWikiWithSkeleton();
    handle.db.delete(sqliteSchema.wikis).where(eq(sqliteSchema.wikis.id, 'wiki_1')).run();
    const pages = handle.db.select().from(sqliteSchema.wikiPages).all();
    expect(pages).toHaveLength(0);
  });

  it('enforces UNIQUE(project_id, slug) on wikis', () => {
    insertWikiWithSkeleton();
    expect(() =>
      handle.db
        .insert(sqliteSchema.wikis)
        .values({
          id: 'wiki_2',
          projectId: 'proj_1',
          slug: 'coodra',
          title: 'dup',
          description: 'd',
          structureJson: '{}',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run(),
    ).toThrow();
  });
});
