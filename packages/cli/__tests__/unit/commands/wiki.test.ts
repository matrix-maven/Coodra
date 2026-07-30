import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runWikiCleanCommand,
  runWikiGenerateCommand,
  runWikiListCommand,
  runWikiStatusCommand,
  type WikiIO,
} from '../../../src/commands/wiki.js';
import { assembleGrounding, type GroundingResult, renderGroundingMarkdown } from '../../../src/lib/wiki/grounding.js';
import { buildWikiJob, deepWikiFeatureFrontmatter, renderWikiRecipe } from '../../../src/lib/wiki/recipe.js';

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
      groundingPath: '.coodra/wiki-grounding.md',
    });
    expect(job).toEqual({
      v: 1,
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki-grounding.md',
    });
  });

  it('renders the two-pass recipe naming every MCP tool', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki-grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('coodra__get_run_id');
    expect(md).toContain('coodra__wiki_save_structure');
    expect(md).toContain('coodra__wiki_save_page');
    expect(md).toContain('wiki_status');
    expect(md).toContain('"schemaVersion": 1');
    expect(md).toContain('mermaid');
  });

  it('the recipe forbids free-writing standalone files (the #1 failure mode)', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki-grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('Do NOT create files');
    expect(md).toContain('DEEP_WIKI.md');
    expect(md).toContain('Preflight');
  });

  // 2026-07-12: the structure block is mode-aware — comprehensive derives
  // the page count from the repo (under-covering is the failure mode);
  // concise pins a small flat page budget.
  it('comprehensive mode targets 12–30 pages and biases toward adding pages', () => {
    const md = renderWikiRecipe({
      projectSlug: 'demo',
      slug: 'demo',
      mode: 'comprehensive',
      groundingPath: '.coodra/wiki-grounding.md',
      includeJobHeader: false,
    });
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
      groundingPath: '.coodra/wiki-grounding.md',
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
      groundingPath: '.coodra/wiki-grounding.md',
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
      groundingPath: '.coodra/wiki-grounding.md',
      includeJobHeader: true,
    });
    expect(md).toContain('SPLIT them into two pages');
    expect(md).not.toContain('Prefer fewer, deeper pages');
  });

  it('the deep-wiki-author feature frontmatter has a trigger description', () => {
    const fm = deepWikiFeatureFrontmatter();
    expect(fm.name).toBe('deep-wiki-author');
    expect(fm.description.toLowerCase()).toContain('deep wiki');
    expect(fm.maturity).toBe('stable');
  });
});

describe('coodra wiki generate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-gen-'));
    writeFileSync(join(dir, 'README.md'), '# Gen', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes grounding + job + recipe + scaffolds the feature (json mode)', async () => {
    const cap = captureIO();
    await run(() => runWikiGenerateCommand({ cwd: dir, slug: 'my-wiki', mode: 'concise', json: true }, cap.io));
    expect(cap.code()).toBe(0);
    const report = JSON.parse(cap.out()) as { ok: boolean; slug: string; mode: string; featureScaffolded: boolean };
    expect(report.ok).toBe(true);
    expect(report.slug).toBe('my-wiki');
    expect(report.mode).toBe('concise');
    expect(report.featureScaffolded).toBe(true);
    expect(existsSync(join(dir, '.coodra', 'wiki-grounding.md'))).toBe(true);
    expect(existsSync(join(dir, '.coodra', 'wiki-job.json'))).toBe(true);
    expect(existsSync(join(dir, '.coodra', 'wiki-job.md'))).toBe(true);
    // Phase 5: the scaffold now lands under docs/skills/ (greenfield resolves
    // there via skillsRoot); a legacy docs/features/ project would keep it there.
    const feature = readFileSync(join(dir, 'docs', 'skills', 'deep-wiki-author', 'feature.md'), 'utf8');
    expect(feature).toContain('deep-wiki-author');
    const job = JSON.parse(readFileSync(join(dir, '.coodra', 'wiki-job.json'), 'utf8')) as {
      slug: string;
      mode: string;
    };
    expect(job).toMatchObject({ slug: 'my-wiki', mode: 'concise' });
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
