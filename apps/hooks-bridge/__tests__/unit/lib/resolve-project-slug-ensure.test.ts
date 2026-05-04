import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, migrateSqlite, sqliteSchema } from '@coodra/contextos-db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';

/**
 * M04 Phase 2 S1 (F3 root-cause fix) — locks `resolveAndEnsure()`'s
 * contract:
 *
 *   1. When a `.contextos.json` slug exists + projects row exists →
 *      returns existing id; no insert.
 *   2. When a `.contextos.json` slug exists but projects row doesn't →
 *      auto-creates the row + returns the new id.
 *   3. When no `.contextos.json` exists → derives slug from
 *      `basename(cwd)` + auto-creates.
 *   4. Reserved basenames (tmp, var, root, etc.) → returns
 *      `{ slug: undefined, projectId: undefined }` (caller falls back
 *      to `__global__`).
 *   5. The new mapping is cached so the next call from the same cwd
 *      is a fast in-memory hit.
 *
 * Pre-fix: every event from an un-registered cwd landed with
 * `run_id=NULL` (1,405 of 1,407 historical events orphaned in the
 * 2026-05-04 audit). The fix closes the loop at the source.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cxos-resolve-ensure-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function freshDb() {
  const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(db.db);
  return db;
}

describe('resolveAndEnsure — F3 root-cause fix', () => {
  it('returns the existing projectId when both .contextos.json and the row exist', async () => {
    const db = await freshDb();
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    const cwd = mkdtempSync(join(tmpRoot, 'has-sidecar-and-row-'));
    writeFileSync(join(cwd, '.contextos.json'), JSON.stringify({ projectSlug: 'pre-existing' }));
    await db.db.insert(sqliteSchema.projects).values({
      id: 'pre-existing-id',
      slug: 'pre-existing',
      orgId: '__solo__',
      name: 'pre-existing',
    });
    const resolver = createProjectSlugResolver();
    const r = await resolver.resolveAndEnsure(cwd, db);
    expect(r).toEqual({ slug: 'pre-existing', projectId: 'pre-existing-id' });
  });

  it('auto-creates the projects row when .contextos.json names an unregistered slug', async () => {
    const db = await freshDb();
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    const cwd = mkdtempSync(join(tmpRoot, 'has-sidecar-no-row-'));
    writeFileSync(join(cwd, '.contextos.json'), JSON.stringify({ projectSlug: 'auto-created-from-sidecar' }));
    const resolver = createProjectSlugResolver();
    const r = await resolver.resolveAndEnsure(cwd, db);
    expect(r.slug).toBe('auto-created-from-sidecar');
    expect(typeof r.projectId).toBe('string');
    expect(r.projectId).not.toBe('__global__');
    const rows = await db.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'auto-created-from-sidecar'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(r.projectId);
  });

  it('derives slug from basename(cwd) when no .contextos.json exists', async () => {
    const db = await freshDb();
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    const cwd = mkdtempSync(join(tmpRoot, 'derive-from-basename-')); // basename will be 'derive-from-basename-XXXXXX'
    const resolver = createProjectSlugResolver();
    const r = await resolver.resolveAndEnsure(cwd, db);
    expect(r.slug).toMatch(/^derive-from-basename-/);
    expect(r.slug?.length).toBeLessThanOrEqual(64);
    expect(typeof r.projectId).toBe('string');
    const rows = await db.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, r.slug ?? ''));
    expect(rows).toHaveLength(1);
  });

  it('returns undefined for reserved basenames (caller falls back to __global__)', async () => {
    const db = await freshDb();
    const resolver = createProjectSlugResolver();
    // Don't create a real /tmp dir — just pass the path string. The resolver
    // checks the path string's basename, doesn't read disk for derivation.
    const r = await resolver.resolveAndEnsure('/tmp', db);
    expect(r).toEqual({ slug: undefined, projectId: undefined });
  });

  it('returns undefined for empty cwd', async () => {
    const db = await freshDb();
    const resolver = createProjectSlugResolver();
    const r = await resolver.resolveAndEnsure('', db);
    expect(r).toEqual({ slug: undefined, projectId: undefined });
  });

  it('caches the derived mapping so subsequent calls are fast (no second insert)', async () => {
    const db = await freshDb();
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    const cwd = mkdtempSync(join(tmpRoot, 'cache-test-'));
    const resolver = createProjectSlugResolver();
    const r1 = await resolver.resolveAndEnsure(cwd, db);
    const r2 = await resolver.resolveAndEnsure(cwd, db);
    expect(r1.projectId).toBe(r2.projectId);
    expect(r1.slug).toBe(r2.slug);
    // Confirm only ONE projects row landed.
    const rows = await db.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, r1.slug ?? ''));
    expect(rows).toHaveLength(1);
  });

  it('sanitizes basename characters that violate the slug regex', async () => {
    const db = await freshDb();
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    // mkdtemp inserts random suffix. Force a name with caps + special chars.
    const cwd = mkdtempSync(join(tmpRoot, 'My_Weird Name!__-'));
    const resolver = createProjectSlugResolver();
    const r = await resolver.resolveAndEnsure(cwd, db);
    expect(r.slug).toMatch(/^[a-z0-9-]+$/);
    expect(r.slug?.length).toBeLessThanOrEqual(64);
  });

  it('resolve() (read-only path) does NOT auto-create — preserves the soft-fail contract', async () => {
    const db = await freshDb();
    const cwd = mkdtempSync(join(tmpRoot, 'read-only-'));
    writeFileSync(join(cwd, '.contextos.json'), JSON.stringify({ projectSlug: 'should-not-auto-create' }));
    const resolver = createProjectSlugResolver();
    const r = await resolver.resolve(cwd, db);
    expect(r.slug).toBe('should-not-auto-create');
    expect(r.projectId).toBeUndefined();
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await db.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'should-not-auto-create'));
    expect(rows).toHaveLength(0);
  });
});
