import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runWikiAskCommand,
  runWikiCleanCommand,
  runWikiGenerateCommand,
  runWikiListCommand,
  runWikiStatusCommand,
  type WikiIO,
} from '../../../src/commands/wiki.js';
import { assembleGrounding, type GroundingResult, renderGroundingMarkdown } from '../../../src/lib/wiki/grounding.js';
import { buildWikiJob, renderWikiRecipe } from '../../../src/lib/wiki/recipe.js';

/** An IO that captures stdout/stderr and turns exit() into a throw we can assert on. */
function captureIO(): { io: WikiIO; out: () => string; err: () => string; code: () => number | null } {
  let outBuf = '';
  let errBuf = '';
  let exitCode: number | null = null;
  const io: WikiIO = {
    writeStdout: (c) => {
      outBuf += c;
    },
    writeStderr: (c) => {
      errBuf += c;
    },
    exit: (code) => {
      exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, out: () => outBuf, err: () => errBuf, code: () => exitCode };
}

async function run(fn: () => Promise<never>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__:')) throw e;
  }
}

describe('wiki grounding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-grounding-'));
    writeFileSync(join(dir, 'README.md'), '# Demo\n\nA demo project.', 'utf8');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@demo/root' }), 'utf8');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;', 'utf8');
    mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'junk', 'a.js'), '//', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('walks the tree (ignoring node_modules), reads README + manifest', async () => {
    const g = await assembleGrounding({ cwd: dir, projectSlug: 'demo' });
    expect(g.files).toContain('src/index.ts');
    expect(g.files).toContain('README.md');
    expect(g.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(g.readme).toContain('A demo project');
    expect(g.manifests.find((m) => m.path === 'package.json')?.name).toBe('@demo/root');
    expect(g.graphify).toBeNull();
    expect(g.knowledge).toBeNull();
  });

  it('renders a markdown grounding doc with the key sections', async () => {
    const md = renderGroundingMarkdown(await assembleGrounding({ cwd: dir, projectSlug: 'demo' }));
    expect(md).toContain('# Deep Wiki grounding — demo');
    expect(md).toContain('## Directory rollup');
    expect(md).toContain('## Files');
    expect(md).toContain('## README');
  });

  // 2026-07-12 field fix: a depth-first walk exhausted the file cap inside
  // the first alphabetical subtree, silently starving later top-level dirs.
  // The walk is now breadth-first with a 1500-file cap so every top-level
  // area appears in the sample even when one subtree alone exceeds the cap.
  it('breadth-first walk with the 1500-file cap samples every top-level dir', async () => {
    mkdirSync(join(dir, 'aaa', 'nested'), { recursive: true });
    for (let i = 0; i < 1600; i++) {
      writeFileSync(join(dir, 'aaa', 'nested', `f${String(i).padStart(4, '0')}.ts`), '', 'utf8');
    }
    mkdirSync(join(dir, 'zzz'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'zzz', `z${i}.ts`), '', 'utf8');
    }
    const g = await assembleGrounding({ cwd: dir, projectSlug: 'demo' });
    expect(g.truncated).toBe(true);
    expect(g.fileCount).toBe(1500);
    expect(g.files).toHaveLength(1500);
    // Depth-first would have burned the whole budget inside aaa/nested and
    // dropped zzz entirely; breadth-first samples depth-1 files first.
    expect(g.files).toContain('zzz/z0.ts');
    expect(g.files).toContain('src/index.ts');
  });

  it('renders the capped-SAMPLE warning blockquote when the file list is truncated', () => {
    const truncated: GroundingResult = {
      projectSlug: 'demo',
      cwd: '/repo',
      fileCount: 1500,
      truncated: true,
      dirRollup: [{ dir: 'src', files: 1500 }],
      files: ['src/a.ts'],
      readme: null,
      manifests: [],
      graphify: null,
      knowledge: null,
    };
    const md = renderGroundingMarkdown(truncated);
    expect(md).toContain('## Files (1500+, sample capped)');
    expect(md).toContain('⚠ **This file list is a capped SAMPLE');
    expect(md).toContain('Do NOT plan the wiki structure from this list alone');

    const complete = renderGroundingMarkdown({ ...truncated, truncated: false });
    expect(complete).toContain('## Files (1500)');
    expect(complete).not.toContain('capped SAMPLE');
  });

  it('caps the directory rollup at 30 and prints how many more top-level entries exist', () => {
    const rollup = Array.from({ length: 34 }, (_, i) => ({ dir: `d${String(i).padStart(2, '0')}`, files: 34 - i }));
    const md = renderGroundingMarkdown({
      projectSlug: 'demo',
      cwd: '/repo',
      fileCount: 34,
      truncated: false,
      dirRollup: rollup,
      files: ['d00/a.ts'],
      readme: null,
      manifests: [],
      graphify: null,
      knowledge: null,
    });
    expect(md).toContain('- `d29/`');
    expect(md).not.toContain('- `d30/`');
    expect(md).toContain('…and 4 more top-level entries');
  });

  // Phase 4: the grounding resolves the graph via the SAME precedence the CLI
  // and web use — an existing `graphify-out/` (legacy layout) is honoured — and
  // reads the `links` edge key (was `edges`, which is always absent on a real
  // NetworkX node-link graph), and surfaces communities + god nodes.
  it('summarises a graphify graph (legacy graphify-out/ layout) with communities + hubs', async () => {
    mkdirSync(join(dir, 'graphify-out'), { recursive: true });
    writeFileSync(
      join(dir, 'graphify-out', 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'a', label: 'a.py', community: 0, source_file: 'a.py' },
          { id: 'b', label: 'main()', community: 0, source_file: 'a.py' },
          { id: 'c', label: 'helper()', community: 1, source_file: 'b.py' },
        ],
        links: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'c' },
        ],
      }),
      'utf8',
    );
    writeFileSync(join(dir, 'graphify-out', 'GRAPH_REPORT.md'), '# Graph Report\n\n## God Nodes\n- `main()`', 'utf8');
    const g = await assembleGrounding({ cwd: dir, projectSlug: 'demo' });
    expect(g.graphify?.nodeCount).toBe(3);
    expect(g.graphify?.edgeCount).toBe(2); // reads `links`, not `edges`
    expect(g.graphify?.communityCount).toBe(2);
    expect(g.graphify?.outputDir).toBe('graphify-out');
    // main() has degree 2 → top hub.
    expect(g.graphify?.hubs[0]?.label).toBe('main()');
    expect(g.graphify?.communities.map((c) => c.id)).toEqual(['0', '1']);
    expect(g.graphify?.report).toContain('God Nodes');

    const md = renderGroundingMarkdown(g);
    expect(md).toContain('## Graphify graph (structural map)');
    expect(md).toContain('candidate sections');
    expect(md).toContain('God nodes → candidate high-importance pages');
    expect(md).toContain('GRAPH_REPORT.md');
  });

  it('renders the prior-recorded-work section from a knowledge grounding', () => {
    const md = renderGroundingMarkdown({
      projectSlug: 'demo',
      cwd: '/repo',
      fileCount: 1,
      truncated: false,
      dirRollup: [{ dir: 'src', files: 1 }],
      files: ['src/a.ts'],
      readme: null,
      manifests: [],
      graphify: null,
      knowledge: {
        projectId: 'proj_1',
        decisionCount: 3,
        decisions: [{ description: 'Use Drizzle over Prisma', rationale: 'native pgvector', alternatives: ['Prisma'] }],
        packCount: 2,
        contextPacks: [{ id: 'cp_1', title: 'Module 09 closeout', excerpt: 'wired graphify + jira' }],
      },
    });
    expect(md).toContain('## Prior recorded work');
    expect(md).toContain('Use Drizzle over Prisma');
    expect(md).toContain('why: native pgvector');
    expect(md).toContain('alternatives considered: Prisma');
    expect(md).toContain('`cp_1` — **Module 09 closeout**');
  });
});

describe('wiki recipe', () => {
  it('builds a job descriptor', () => {
    const job = buildWikiJob({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
    });
    expect(job).toEqual({
      v: 1,
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
    });
  });

  it('renders the two-pass recipe naming every MCP tool', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('coodra__get_run_id');
    expect(md).toContain('coodra__wiki_save_structure');
    expect(md).toContain('coodra__wiki_save_page');
    expect(md).toContain('wiki_status');
    expect(md).toContain('"schemaVersion": 1');
    expect(md).toContain('mermaid');
  });

  it('the recipe requires MCP saves before writing the markdown mirror', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('source of truth + Markdown mirror');
    expect(md).toContain('.coodra/wiki/demo/structure.json');
    expect(md).toContain('.coodra/wiki/demo/md/<pageId>.md');
    expect(md).toContain('DEEP_WIKI.md');
    expect(md).toContain('docs/wiki/*');
    expect(md).toContain('Preflight');
  });

  it('instructs a connected-Markdown mirror: enriched frontmatter, rendered cross-links, and an index.md', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: true,
    });
    // Per-page mirror.
    expect(md).toContain('type: wiki-page');
    expect(md).toContain('relatedPageIds');
    expect(md).toContain('## Related pages');
    // Wiki-level index, written right after the structure save.
    expect(md).toContain('.coodra/wiki/demo/md/index.md');
    expect(md).toContain('type: wiki-index');
    expect(md).not.toContain('OKF');
  });

  it('comprehensive mode uses discovery planning instead of a fixed template', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: false,
    });
    expect(md).toContain('OpenWiki-style discovery plan');
    expect(md).toContain('Model relationships before page creation');
    expect(md).toContain('Do NOT use a fixed Coodra/SaaS/OpenWiki/DeepWiki template');
    expect(md).toContain('A section should usually contain multiple substantive pages');
    expect(md).toContain('Coverage target (comprehensive mode)');
    expect(md).toContain('12–30 pages');
    expect(md).toContain('when in doubt, ADD the page');
    expect(md).not.toContain('6–12 focused pages');
  });

  it('concise mode targets 6–12 focused flat pages', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'concise',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: false,
    });
    expect(md).toContain('Coverage target (concise mode)');
    expect(md).toContain('6–12 focused pages');
    expect(md).not.toContain('12–30 pages');
    expect(md).not.toContain('when in doubt, ADD the page');
  });

  it('pass 1 explains the wiki_exists soft-failure and the replace: true re-plan escape hatch', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('wiki_exists');
    expect(md).toContain('replace: true');
  });

  it("the quality bar says SPLIT crowded pages — never 'Prefer fewer, deeper pages'", () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki/grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('SPLIT them into two pages');
    expect(md).not.toContain('Prefer fewer, deeper pages');
  });
});

describe('coodra wiki build/generate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-gen-'));
    writeFileSync(join(dir, 'README.md'), '# Gen', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes grounding + job + recipe (json mode)', async () => {
    const cap = captureIO();
    await run(() => runWikiGenerateCommand({ cwd: dir, slug: 'my-wiki', mode: 'concise', json: true }, cap.io));
    expect(cap.code()).toBe(0);
    const report = JSON.parse(cap.out()) as {
      ok: boolean;
      slug: string;
      mode: string;
      grounding: { path: string };
      job: string;
      recipe: string;
      markdownMirror: string;
    };
    expect(report.ok).toBe(true);
    expect(report.slug).toBe('my-wiki');
    expect(report.mode).toBe('concise');
    expect(report.grounding.path).toBe('.coodra/wiki/grounding.md');
    expect(report.job).toBe('.coodra/wiki/job.json');
    expect(report.recipe).toBe('.coodra/wiki/job.md');
    expect(report.markdownMirror).toBe('.coodra/wiki/my-wiki');
    expect(existsSync(join(dir, '.coodra', 'wiki', 'grounding.md'))).toBe(true);
    expect(existsSync(join(dir, '.coodra', 'wiki', 'job.json'))).toBe(true);
    expect(existsSync(join(dir, '.coodra', 'wiki', 'job.md'))).toBe(true);
    expect(existsSync(join(dir, '.coodra', 'wiki', 'my-wiki'))).toBe(true);
    // The dead OKF export scaffold is retired — the connected-Markdown
    // mirror now lives under the agent-written `md/` subdir instead, not
    // pre-created by `coodra wiki build` (same as the flat mirror never was).
    expect(existsSync(join(dir, '.coodra', 'wiki', 'okf'))).toBe(false);
    expect(existsSync(join(dir, '.coodra', 'recipes', 'deep-wiki-author'))).toBe(false);
    const job = JSON.parse(readFileSync(join(dir, '.coodra', 'wiki', 'job.json'), 'utf8')) as {
      slug: string;
      mode: string;
    };
    expect(job).toMatchObject({ slug: 'my-wiki', mode: 'concise' });
    const manifest = JSON.parse(readFileSync(join(dir, '.coodra', 'manifest.json'), 'utf8')) as {
      entries: Array<{ path: string; kind: string; cleanup: string }>;
    };
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.coodra/wiki/grounding.md', kind: 'wiki-working-artifact', cleanup: 'safe' }),
        expect.objectContaining({ path: '.coodra/wiki/job.json', kind: 'wiki-working-artifact', cleanup: 'safe' }),
        expect.objectContaining({ path: '.coodra/wiki/job.md', kind: 'wiki-working-artifact', cleanup: 'safe' }),
        expect.objectContaining({ path: '.coodra/wiki/my-wiki', kind: 'wiki-markdown-mirror', cleanup: 'safe' }),
      ]),
    );
    expect(manifest.entries.some((e) => e.path === '.coodra/wiki/okf')).toBe(false);
  });

  it('defaults the slug from the directory basename and uses comprehensive mode', async () => {
    const cap = captureIO();
    await run(() => runWikiGenerateCommand({ cwd: dir, json: true }, cap.io));
    const report = JSON.parse(cap.out()) as { slug: string; mode: string };
    expect(report.mode).toBe('comprehensive');
    expect(report.slug.length).toBeGreaterThan(0);
  });

  it('rejects an invalid mode', async () => {
    const cap = captureIO();
    await run(() => runWikiGenerateCommand({ cwd: dir, mode: 'fancy', json: true }, cap.io));
    expect(cap.code()).toBe(1);
    expect(JSON.parse(cap.out())).toMatchObject({ ok: false, error: 'bad_mode' });
  });
});

describe('coodra wiki status / list / clean (DB-backed)', () => {
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wiki-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'wiki-proj-'));
    mkdirSync(join(cwd, '.coodra'), { recursive: true });
    writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }), 'utf8');
    env = { ...process.env, COODRA_HOME: home };

    // Migrate a fresh data.db and seed a project + a half-authored wiki.
    const dataDb = join(home, 'data.db');
    const handle = createSqliteDb({ path: dataDb });
    migrateSqlite(handle.db);
    const now = new Date();
    handle.db
      .insert(sqliteSchema.projects)
      .values({ id: 'proj_demo', slug: 'demo', orgId: 'org_dev_local', name: 'Demo', createdAt: now, updatedAt: now })
      .run();
    handle.db
      .insert(sqliteSchema.wikis)
      .values({
        id: 'wiki_demo',
        projectId: 'proj_demo',
        slug: 'demo',
        title: 'Demo',
        description: 'd',
        mode: 'comprehensive',
        schemaVersion: 1,
        structureJson: JSON.stringify({ pages: [{ id: 'a' }, { id: 'b' }] }),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    handle.db
      .insert(sqliteSchema.wikiPages)
      .values([
        { id: 'wp_a', wikiId: 'wiki_demo', pageId: 'a', state: 'authored', createdAt: now, updatedAt: now },
        { id: 'wp_b', wikiId: 'wiki_demo', pageId: 'b', state: 'pending', createdAt: now, updatedAt: now },
      ])
      .run();
    handle.close();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('status reports 1/2 authored', async () => {
    const cap = captureIO();
    await run(() => runWikiStatusCommand({ cwd, env, json: true }, cap.io));
    const r = JSON.parse(cap.out()) as { wiki: { authoredCount: number; pageCount: number } | null };
    expect(r.wiki).not.toBeNull();
    expect(r.wiki?.authoredCount).toBe(1);
    expect(r.wiki?.pageCount).toBe(2);
  });

  it('list shows the wiki', async () => {
    const cap = captureIO();
    await run(() => runWikiListCommand({ cwd, env, json: true }, cap.io));
    const r = JSON.parse(cap.out()) as { wikis: Array<{ slug: string }> };
    expect(r.wikis.map((w) => w.slug)).toContain('demo');
  });

  it('clean deletes the wiki and its pages', async () => {
    const cap = captureIO();
    await run(() => runWikiCleanCommand('demo', { cwd, env, json: true }, cap.io));
    expect(JSON.parse(cap.out())).toMatchObject({ ok: true, deleted: { slug: 'demo' } });

    // Verify gone.
    const cap2 = captureIO();
    await run(() => runWikiListCommand({ cwd, env, json: true }, cap2.io));
    expect((JSON.parse(cap2.out()) as { wikis: unknown[] }).wikis).toHaveLength(0);
  });
});

describe('coodra wiki ask', () => {
  function writeLocalPage(
    dir: string,
    slug: string,
    pageId: string,
    fields: { title: string; description: string; relatedPageIds?: string[] },
    body: string,
  ): void {
    const mdDir = join(dir, '.coodra', 'wiki', slug, 'md');
    mkdirSync(mdDir, { recursive: true });
    const related = fields.relatedPageIds ?? [];
    const lines = [
      '---',
      'type: wiki-page',
      `pageId: ${pageId}`,
      `wikiId: wiki_${slug}`,
      `title: ${fields.title}`,
      `description: ${fields.description}`,
      `relatedPageIds: [${related.join(', ')}]`,
      'state: authored',
      'updatedAt: 2026-08-04T00:00:00.000Z',
      '---',
      '',
      body,
    ];
    writeFileSync(join(mdDir, `${pageId}.md`), lines.join('\n'), 'utf8');
  }

  describe('local mirror path', () => {
    let cwd: string;
    let home: string;
    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'wiki-ask-local-'));
      mkdirSync(join(cwd, '.coodra'), { recursive: true });
      writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }), 'utf8');
      // A fresh, empty home with no data.db — proves the local path never
      // opens the DB (see the assertion below).
      home = mkdtempSync(join(tmpdir(), 'wiki-ask-home-'));

      writeLocalPage(
        cwd,
        'demo',
        'retries',
        { title: 'Retry policy', description: 'How retries are configured.' },
        'Retry retry retry — the retry policy uses cockatiel with exponential backoff.',
      );
      writeLocalPage(
        cwd,
        'demo',
        'storage',
        { title: 'Storage layout', description: 'Where files live on disk.', relatedPageIds: ['retries'] },
        'Storage briefly mentions retry once in passing.',
      );
    });
    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it('ranks the denser local match first and never opens the DB', async () => {
      const cap = captureIO();
      const env = { ...process.env, COODRA_HOME: home };
      await run(() => runWikiAskCommand('retry', { cwd, env, json: true }, cap.io));
      expect(cap.code()).toBe(0);
      const report = JSON.parse(cap.out()) as {
        ok: boolean;
        source: string;
        results: Array<{ pageId: string; filePath?: string }>;
      };
      expect(report.ok).toBe(true);
      expect(report.source).toBe('local');
      expect(report.results.map((r) => r.pageId)).toEqual(['retries', 'storage']);
      expect(report.results[0]?.filePath).toBe('.coodra/wiki/demo/md/retries.md');
      // The local path is DB-free — no data.db should exist in the home dir.
      expect(existsSync(join(home, 'data.db'))).toBe(false);
    });

    it('respects --limit', async () => {
      const cap = captureIO();
      const env = { ...process.env, COODRA_HOME: home };
      await run(() => runWikiAskCommand('retry', { cwd, env, json: true, limit: 1 }, cap.io));
      const report = JSON.parse(cap.out()) as { results: unknown[] };
      expect(report.results).toHaveLength(1);
    });

    it('--refresh skips the local mirror and falls back to the DB (no wiki there → no_wiki)', async () => {
      // A migrated-but-wiki-less DB, matching how `coodra install` leaves a
      // real home before any wiki has been built.
      const migratedHome = mkdtempSync(join(tmpdir(), 'wiki-ask-home-migrated-'));
      const migratedHandle = createSqliteDb({ path: join(migratedHome, 'data.db') });
      migrateSqlite(migratedHandle.db);
      migratedHandle.close();
      try {
        const cap = captureIO();
        const env = { ...process.env, COODRA_HOME: migratedHome };
        await run(() => runWikiAskCommand('retry', { cwd, env, json: true, refresh: true }, cap.io));
        expect(cap.code()).toBe(1);
        expect(JSON.parse(cap.out())).toMatchObject({ ok: false, error: 'no_wiki' });
      } finally {
        rmSync(migratedHome, { recursive: true, force: true });
      }
    });
  });

  describe('old flat-layout mirror falls through to the DB', () => {
    let cwd: string;
    afterEach(() => rmSync(cwd, { recursive: true, force: true }));

    it('a pre-existing flat .coodra/wiki/<slug>/<pageId>.md (no md/ subdir) is not read locally', async () => {
      cwd = mkdtempSync(join(tmpdir(), 'wiki-ask-flat-'));
      mkdirSync(join(cwd, '.coodra'), { recursive: true });
      writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }), 'utf8');
      const flatDir = join(cwd, '.coodra', 'wiki', 'demo');
      mkdirSync(flatDir, { recursive: true });
      writeFileSync(join(flatDir, 'retries.md'), '---\npageId: retries\n---\nold flat mirror body', 'utf8');

      const home = mkdtempSync(join(tmpdir(), 'wiki-ask-home-'));
      const handle = createSqliteDb({ path: join(home, 'data.db') });
      migrateSqlite(handle.db);
      handle.close();
      try {
        const cap = captureIO();
        const env = { ...process.env, COODRA_HOME: home };
        await run(() => runWikiAskCommand('retries', { cwd, env, json: true }, cap.io));
        // No md/ subdir exists, so the local check finds nothing and falls
        // through to the DB fallback — which also finds nothing here.
        expect(JSON.parse(cap.out())).toMatchObject({ ok: false, error: 'no_wiki' });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('DB fallback (no local mirror)', () => {
    let home: string;
    let cwd: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'wiki-ask-db-home-'));
      cwd = mkdtempSync(join(tmpdir(), 'wiki-ask-db-proj-'));
      mkdirSync(join(cwd, '.coodra'), { recursive: true });
      writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }), 'utf8');
      env = { ...process.env, COODRA_HOME: home };

      const dataDb = join(home, 'data.db');
      const handle = createSqliteDb({ path: dataDb });
      migrateSqlite(handle.db);
      const now = new Date();
      handle.db
        .insert(sqliteSchema.projects)
        .values({ id: 'proj_demo', slug: 'demo', orgId: 'org_dev_local', name: 'Demo', createdAt: now, updatedAt: now })
        .run();
      handle.db
        .insert(sqliteSchema.wikis)
        .values({
          id: 'wiki_demo',
          projectId: 'proj_demo',
          slug: 'demo',
          title: 'Demo',
          description: 'd',
          mode: 'comprehensive',
          schemaVersion: 1,
          structureJson: JSON.stringify({
            schemaVersion: 1,
            title: 'Demo',
            description: 'A demo wiki',
            mode: 'comprehensive',
            sections: [],
            pages: [
              {
                id: 'retries',
                title: 'Retry policy',
                description: 'How retries are configured.',
                importance: 'high',
                parentId: null,
                relevantFiles: [],
                relatedPageIds: [],
                wantsDiagram: false,
              },
              {
                id: 'storage',
                title: 'Storage layout',
                description: 'Where files live on disk.',
                importance: 'medium',
                parentId: null,
                relevantFiles: [],
                relatedPageIds: [],
                wantsDiagram: false,
              },
            ],
          }),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      handle.db
        .insert(sqliteSchema.wikiPages)
        .values([
          {
            id: 'wp_a',
            wikiId: 'wiki_demo',
            pageId: 'retries',
            state: 'authored',
            contentMarkdown: 'Retry retry retry — cockatiel with exponential backoff.',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'wp_b',
            wikiId: 'wiki_demo',
            pageId: 'storage',
            state: 'authored',
            contentMarkdown: 'Storage briefly mentions retry once in passing.',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'wp_c',
            wikiId: 'wiki_demo',
            pageId: 'pending-page',
            state: 'pending',
            contentMarkdown: '',
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
      handle.close();
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    it('ranks pages read from the DB, using titles/descriptions parsed out of structureJson', async () => {
      const cap = captureIO();
      await run(() => runWikiAskCommand('retry', { cwd, env, json: true }, cap.io));
      const report = JSON.parse(cap.out()) as {
        ok: boolean;
        source: string;
        results: Array<{ pageId: string; title: string; filePath?: string }>;
      };
      expect(report.ok).toBe(true);
      expect(report.source).toBe('db');
      expect(report.results.map((r) => r.pageId)).toEqual(['retries', 'storage']);
      expect(report.results[0]?.title).toBe('Retry policy');
      expect(report.results[0]?.filePath).toBeUndefined();
    });

    it('excludes pending pages (empty bodies would just add noise)', async () => {
      const cap = captureIO();
      await run(() => runWikiAskCommand('pending', { cwd, env, json: true }, cap.io));
      const report = JSON.parse(cap.out()) as { results: unknown[] };
      expect(report.results).toEqual([]);
    });

    it('no wiki for this project at all → no_wiki soft-failure', async () => {
      const cap = captureIO();
      await run(() => runWikiAskCommand('anything', { cwd, env, json: true, slug: 'nonexistent' }, cap.io));
      expect(cap.code()).toBe(1);
      expect(JSON.parse(cap.out())).toMatchObject({ ok: false, error: 'no_wiki' });
    });
  });
});
