import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { InternalError } from '@coodra/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient } from '../../../src/lib/db.js';
import { createFeaturePackStore, type FeaturePackGetReturn } from '../../../src/lib/feature-pack.js';

/**
 * Integration test for `src/lib/feature-pack.ts` (S7c).
 *
 * Exercises the filesystem-first loader + checksum-guarded cache +
 * inheritance resolver against a temporary `featurePacksRoot` and
 * an in-memory SQLite handle.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly root: string;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  const root = mkdtempSync(join(tmpdir(), 'fp-'));
  return {
    close: async () => {
      await client.close();
    },
    handle,
    root,
  };
}

function writePack(
  root: string,
  slug: string,
  opts: {
    readonly parentSlug?: string | null;
    readonly body?: string;
    readonly sourceFiles?: ReadonlyArray<string>;
  } = {},
): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const body = opts.body ?? `# ${slug}\n`;
  writeFileSync(join(dir, 'spec.md'), `${body}spec\n`, 'utf8');
  writeFileSync(join(dir, 'implementation.md'), `${body}impl\n`, 'utf8');
  writeFileSync(join(dir, 'techstack.md'), `${body}tech\n`, 'utf8');
  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify({ slug, parentSlug: opts.parentSlug ?? null, sourceFiles: opts.sourceFiles ?? [] }, null, 2)}\n`,
    'utf8',
  );
}

describe('lib/feature-pack — construction', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createFeaturePackStore(undefined as unknown as any)).toThrow(TypeError);
  });
  it('rejects missing db handle', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createFeaturePackStore({} as any)).toThrow(/db must be a DbHandle/);
  });
});

describe('lib/feature-pack — get + bootstrap from disk', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('bootstraps a new DB row from on-disk files on first get()', async () => {
    writePack(h.root, 'only', { sourceFiles: ['src/**'] });
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    const result = (await store.get({ projectSlug: 'only' })) as FeaturePackGetReturn;
    expect(result.metadata.slug).toBe('only');
    expect(result.metadata.parentSlug).toBeNull();
    expect(result.metadata.checksum.startsWith('sha256:')).toBe(true);
    expect(result.inherited).toEqual([]);
    expect(result.content.sourceFiles).toEqual(['src/**']);

    const dbRow = await h.handle.db
      .select()
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, 'only'))
      .limit(1);
    expect(dbRow[0]?.checksum).toBe(result.metadata.checksum);
  });

  it('throws when the slug is not on disk', async () => {
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    await expect(store.get({ projectSlug: 'ghost' })).rejects.toBeInstanceOf(InternalError);
  });

  it('updates the DB row when on-disk content changes (checksum mismatch)', async () => {
    writePack(h.root, 'changing', { body: 'v1\n' });
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root, cacheTtlMs: 0 });
    const first = (await store.get({ projectSlug: 'changing' })) as FeaturePackGetReturn;
    writePack(h.root, 'changing', { body: 'v2 CHANGED\n' });
    const second = (await store.get({ projectSlug: 'changing' })) as FeaturePackGetReturn;
    expect(second.metadata.checksum).not.toBe(first.metadata.checksum);
    expect(second.content.spec).toContain('v2 CHANGED');
  });

  it('rejects meta.json whose slug disagrees with the folder name', async () => {
    const dir = join(h.root, 'wrong-slug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), '', 'utf8');
    writeFileSync(join(dir, 'implementation.md'), '', 'utf8');
    writeFileSync(join(dir, 'techstack.md'), '', 'utf8');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ slug: 'different', parentSlug: null }, null, 2), 'utf8');
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    await expect(store.get({ projectSlug: 'wrong-slug' })).rejects.toBeInstanceOf(InternalError);
  });
});

describe('lib/feature-pack — inheritance', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the root-first inherited chain from parent → leaf', async () => {
    writePack(h.root, 'root', { parentSlug: null });
    writePack(h.root, 'mid', { parentSlug: 'root' });
    writePack(h.root, 'leaf', { parentSlug: 'mid' });
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    const result = (await store.get({ projectSlug: 'leaf' })) as FeaturePackGetReturn;
    expect(result.metadata.slug).toBe('leaf');
    expect(result.inherited.map((p) => p.metadata.slug)).toEqual(['root', 'mid']);
  });

  it('list() returns root-first including the leaf itself', async () => {
    writePack(h.root, 'root', { parentSlug: null });
    writePack(h.root, 'leaf', { parentSlug: 'root' });
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    const list = await store.list({ projectSlug: 'leaf' });
    expect(list.map((p) => (p as { metadata: { slug: string } }).metadata.slug)).toEqual(['root', 'leaf']);
  });

  it('throws InternalError when a parent slug is missing from disk', async () => {
    writePack(h.root, 'orphan', { parentSlug: 'absent-parent' });
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    await expect(store.get({ projectSlug: 'orphan' })).rejects.toBeInstanceOf(InternalError);
  });
});

describe('lib/feature-pack — cache', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('serves cached results within TTL (no re-checksum of disk)', async () => {
    writePack(h.root, 'cached', { body: 'v1\n' });
    let tNow = 1_000;
    const store = createFeaturePackStore({
      db: h.handle,
      featurePacksRoot: h.root,
      now: () => tNow,
      cacheTtlMs: 5_000,
    });
    const first = (await store.get({ projectSlug: 'cached' })) as FeaturePackGetReturn;
    // Mutate on disk; within TTL the cached checksum should still win.
    writePack(h.root, 'cached', { body: 'v2 CHANGED\n' });
    tNow += 1_000; // still within TTL
    const second = (await store.get({ projectSlug: 'cached' })) as FeaturePackGetReturn;
    expect(second.metadata.checksum).toBe(first.metadata.checksum);
    // Step past TTL → refresh.
    tNow += 10_000;
    const third = (await store.get({ projectSlug: 'cached' })) as FeaturePackGetReturn;
    expect(third.metadata.checksum).not.toBe(first.metadata.checksum);
  });
});

describe('lib/feature-pack — upsert', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes the four files and upserts the DB row', async () => {
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    await store.upsert({
      slug: 'new',
      parentSlug: null,
      sourceFiles: ['src/**'],
      spec: '# spec\n',
      implementation: '# impl\n',
      techstack: '# tech\n',
    });
    const dir = join(h.root, 'new');
    expect(readFileSync(join(dir, 'spec.md'), 'utf8')).toBe('# spec\n');
    expect(readFileSync(join(dir, 'implementation.md'), 'utf8')).toBe('# impl\n');
    expect(readFileSync(join(dir, 'techstack.md'), 'utf8')).toBe('# tech\n');
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).slug).toBe('new');
    const dbRow = await h.handle.db
      .select()
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, 'new'))
      .limit(1);
    expect(dbRow[0]?.checksum.startsWith('sha256:')).toBe(true);
  });

  it('rejects an invalid upsert payload', async () => {
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.root });
    await expect(store.upsert({ slug: '', spec: 'x', implementation: 'y', techstack: 'z' })).rejects.toBeInstanceOf(
      InternalError,
    );
  });
});
