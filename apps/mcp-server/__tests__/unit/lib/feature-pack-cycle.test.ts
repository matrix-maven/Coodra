import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite } from '@coodra/db';
import { InternalError } from '@coodra/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient } from '../../../src/lib/db.js';
import { createFeaturePackStore } from '../../../src/lib/feature-pack.js';

/**
 * Unit test for the feature-pack inheritance cycle detector.
 *
 * Builds a 3-node cycle on disk (a → b → c → a), calls
 * `featurePackStore.get({ projectSlug: 'a' })`, and asserts the
 * call throws `InternalError` whose message names the offending
 * chain. This is load-bearing safety — a silent infinite walk
 * would hang the get-feature-pack MCP call.
 *
 * The test is classified as "unit" because the tmpfs-backed FS ops
 * and the :memory: SQLite are fast enough for the unit runner and
 * do not require testcontainers. The feature-pack store itself
 * crosses an IO boundary, but the cycle detector is pure logic
 * once the disk load returns the metadata.
 */

function writePack(root: string, slug: string, parentSlug: string | null): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), `# ${slug} spec\n`, 'utf8');
  writeFileSync(join(dir, 'implementation.md'), `# ${slug} impl\n`, 'utf8');
  writeFileSync(join(dir, 'techstack.md'), `# ${slug} tech\n`, 'utf8');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ slug, parentSlug, sourceFiles: [] }, null, 2), 'utf8');
}

describe('feature-pack — inheritance cycle detection', () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-cycle-'));
  const dbOwner = createDbClient({ mode: 'solo', sqlite: { path: ':memory:', skipPragmas: true } });
  const handle = dbOwner.asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');

  beforeAll(() => {
    migrateSqlite(handle.db);
    writePack(root, 'a', 'b');
    writePack(root, 'b', 'c');
    writePack(root, 'c', 'a'); // closes the loop
  });

  afterAll(async () => {
    await dbOwner.client.close();
  });

  it('throws InternalError naming the cycle chain', async () => {
    const store = createFeaturePackStore({ db: handle, featurePacksRoot: root });
    let thrown: unknown;
    try {
      await store.get({ projectSlug: 'a' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/feature_pack_cycle/);
    // Chain should mention at least one of the cycle slugs —
    // "a → b → c → a" shape. Order depends on visited-set iteration
    // but `a` appears twice because it's the start and the reentry.
    expect(msg).toContain('a');
    expect(msg).toContain('b');
    expect(msg).toContain('c');
  });
});

/**
 * Slice 9 (2026-05-03 audit §12): self-referential cycle. The
 * 3-node test above covers the common multi-hop case but does NOT
 * exercise the boundary condition where a single pack's
 * `meta.json` declares itself as its own parent. The visited-set
 * walker should catch this on the first ancestor step (the seed slug
 * is added to `visited` before walking; the first cursor equals the
 * leaf, which is already in the set, so the cycle predicate fires
 * immediately). This test locks that contract — a future refactor
 * that seeds `visited` after the first walk step would silently
 * permit self-cycles, hanging the get-feature-pack handler.
 */
describe('feature-pack — self-referential cycle (slug → slug)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-self-cycle-'));
  const dbOwner = createDbClient({ mode: 'solo', sqlite: { path: ':memory:', skipPragmas: true } });
  const handle = dbOwner.asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');

  beforeAll(() => {
    migrateSqlite(handle.db);
    writePack(root, 'self', 'self'); // pathological — meta.parentSlug === slug
  });

  afterAll(async () => {
    await dbOwner.client.close();
  });

  it('throws InternalError without infinite-walking', async () => {
    const store = createFeaturePackStore({ db: handle, featurePacksRoot: root });
    let thrown: unknown;
    try {
      await store.get({ projectSlug: 'self' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/feature_pack_cycle/);
    expect(msg).toContain('self');
  });
});
