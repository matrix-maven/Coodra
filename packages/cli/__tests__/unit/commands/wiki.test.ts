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
import { assembleGrounding, renderGroundingMarkdown } from '../../../src/lib/wiki/grounding.js';
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

  it('walks the tree (ignoring node_modules), reads README + manifest', () => {
    const g = assembleGrounding({ cwd: dir, projectSlug: 'demo' });
    expect(g.files).toContain('src/index.ts');
    expect(g.files).toContain('README.md');
    expect(g.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(g.readme).toContain('A demo project');
    expect(g.manifests.find((m) => m.path === 'package.json')?.name).toBe('@demo/root');
    expect(g.graphify).toBeNull();
  });

  it('renders a markdown grounding doc with the key sections', () => {
    const md = renderGroundingMarkdown(assembleGrounding({ cwd: dir, projectSlug: 'demo' }));
    expect(md).toContain('# Deep Wiki grounding — demo');
    expect(md).toContain('## Directory rollup');
    expect(md).toContain('## Files');
    expect(md).toContain('## README');
  });

  it('summarises a graphify graph when present', () => {
    mkdirSync(join(dir, 'graphify-out'), { recursive: true });
    writeFileSync(
      join(dir, 'graphify-out', 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'a', community: 0 },
          { id: 'b', community: 1 },
        ],
        edges: [{ s: 'a', t: 'b' }],
      }),
      'utf8',
    );
    const g = assembleGrounding({ cwd: dir, projectSlug: 'demo' });
    expect(g.graphify?.nodeCount).toBe(2);
    expect(g.graphify?.edgeCount).toBe(1);
    expect(g.graphify?.communityCount).toBe(2);
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
    const feature = readFileSync(join(dir, 'docs', 'features', 'deep-wiki-author', 'feature.md'), 'utf8');
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
    writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: 'demo' }), 'utf8');
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
