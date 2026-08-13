import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { WIKI_SCHEMA_VERSION } from '@coodra/shared/wiki';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createWikiAskToolRegistration } from '../../../src/tools/wiki-ask/manifest.js';
import type { WikiAskOutput } from '../../../src/tools/wiki-ask/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__wiki_ask` (COOD-30).
 *
 * Real SQLite migrated. Seeds `wikis`/`wiki_pages` directly (raw SQL,
 * same convention as search-packs-nl.test.ts) rather than going through
 * `wiki_save_structure`/`wiki_save_page` — this test is about the read
 * path, not the write tools.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly projectA: string;
  readonly projectB: string;
  readonly deps: ContextDeps;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const projectA = 'proj_wa_a';
  const projectB = 'proj_wa_b';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectA, 'slug-a', 'org_test', 'project A');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectB, 'slug-b', 'org_test', 'project B');

  return {
    close: async () => {
      await client.close();
    },
    handle,
    projectA,
    projectB,
    deps: makeFakeDeps(),
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createWikiAskToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): WikiAskOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: WikiAskOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

interface SeedPage {
  readonly pageId: string;
  readonly title: string;
  readonly description: string;
  readonly contentMarkdown: string;
  readonly state?: 'pending' | 'authored';
}

function seedWiki(h: Harness, wikiId: string, projectId: string, slug: string, pages: readonly SeedPage[]): void {
  const structure = {
    schemaVersion: WIKI_SCHEMA_VERSION,
    title: `${slug} wiki`,
    description: 'test wiki',
    mode: 'comprehensive' as const,
    sections: [],
    pages: pages.map((p) => ({
      id: p.pageId,
      title: p.title,
      description: p.description,
      importance: 'medium' as const,
      parentId: null,
      relevantFiles: [],
      relatedPageIds: [],
      wantsDiagram: false,
    })),
  };
  h.handle.raw
    .prepare(
      `INSERT INTO wikis (id, project_id, slug, title, description, mode, schema_version, structure_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'comprehensive', ?, ?, unixepoch(), unixepoch())`,
    )
    .run(
      wikiId,
      projectId,
      slug,
      structure.title,
      structure.description,
      WIKI_SCHEMA_VERSION,
      JSON.stringify(structure),
    );

  for (const p of pages) {
    h.handle.raw
      .prepare(
        `INSERT INTO wiki_pages (id, wiki_id, page_id, state, content_markdown, citations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '[]', unixepoch(), unixepoch())`,
      )
      .run(`wp_${wikiId}_${p.pageId}`, wikiId, p.pageId, p.state ?? 'authored', p.contentMarkdown);
  }
}

describe('wiki_ask — project_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found when the slug is not registered', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('wiki_ask', { projectSlug: 'nonexistent', question: 'anything' }, 'sess_wa'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
  });
});

describe('wiki_ask — wiki_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:wiki_not_found when the project exists but has no wiki', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('wiki_ask', { projectSlug: 'slug-a', question: 'anything' }, 'sess_wa'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('wiki_not_found');
  });
});

describe('wiki_ask — ranking + full content', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('ranks the denser-match page first and returns its full contentMarkdown, not just an excerpt', async () => {
    seedWiki(h, 'wiki_1', h.projectA, 'slug-a', [
      {
        pageId: 'auth-overview',
        title: 'Authentication overhaul',
        description: 'How auth works',
        contentMarkdown:
          'Authentication authentication authentication — the full rewritten flow, end to end, with every detail an agent would need to answer questions about it.',
      },
      {
        pageId: 'sprint-notes',
        title: 'Sprint planning notes',
        description: 'Sprint board notes',
        contentMarkdown: 'Briefly touched on authentication while discussing the sprint board.',
      },
    ]);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('wiki_ask', { projectSlug: 'slug-a', question: 'authentication' }, 'sess_wa'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.wikiId).toBe('wiki_1');
    expect(out.slug).toBe('slug-a');
    expect(out.results[0]?.pageId).toBe('auth-overview');
    expect(out.results[0]?.contentMarkdown).toContain('full rewritten flow');
    expect(out.results[0]?.score).toBeGreaterThan(out.results[1]?.score ?? Number.NaN);
  });

  it('excludes pending (unauthored) pages from ranking', async () => {
    seedWiki(h, 'wiki_2', h.projectA, 'slug-a', [
      { pageId: 'draft', title: 'Draft page', description: 'not yet written', contentMarkdown: '', state: 'pending' },
      { pageId: 'done', title: 'Finished page', description: 'complete', contentMarkdown: 'widget rollout notes' },
    ]);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('wiki_ask', { projectSlug: 'slug-a', question: 'widget' }, 'sess_wa'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.map((r) => r.pageId)).toEqual(['done']);
  });

  it('defaults the wiki slug to the project slug when none is given', async () => {
    seedWiki(h, 'wiki_3', h.projectA, 'slug-a', [
      { pageId: 'p1', title: 'Page one', description: 'd', contentMarkdown: 'keyword content' },
    ]);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('wiki_ask', { projectSlug: 'slug-a', question: 'keyword' }, 'sess_wa'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.slug).toBe('slug-a');
  });

  it('does not return matches from another project', async () => {
    seedWiki(h, 'wiki_a', h.projectA, 'slug-a', [
      { pageId: 'p1', title: 'Page one', description: 'd', contentMarkdown: 'widget rollout notes' },
    ]);
    seedWiki(h, 'wiki_b', h.projectB, 'slug-b', [
      { pageId: 'p1', title: 'Page one', description: 'd', contentMarkdown: 'widget rollout notes' },
    ]);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('wiki_ask', { projectSlug: 'slug-a', question: 'widget' }, 'sess_wa'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.wikiId).toBe('wiki_a');
  });

  it('honours the supplied limit', async () => {
    seedWiki(h, 'wiki_4', h.projectA, 'slug-a', [
      { pageId: 'p1', title: 'Page one', description: 'd', contentMarkdown: 'shared keyword content' },
      { pageId: 'p2', title: 'Page two', description: 'd', contentMarkdown: 'shared keyword content' },
      { pageId: 'p3', title: 'Page three', description: 'd', contentMarkdown: 'shared keyword content' },
    ]);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('wiki_ask', { projectSlug: 'slug-a', question: 'keyword', limit: 2 }, 'sess_wa'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(2);
  });
});
