import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextDeps, FeaturePackStore } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createFeaturePackStore } from '../../../src/lib/feature-pack.js';
import { getFeaturePackToolRegistration } from '../../../src/tools/get-feature-pack/manifest.js';
import type { GetFeaturePackOutput } from '../../../src/tools/get-feature-pack/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__get_feature_pack` (S9).
 *
 * Exercises the real handler end-to-end via the `ToolRegistry` — the
 * same dispatch path the stdio transport uses — against an in-memory
 * SQLite handle + a temporary `featurePacksRoot` containing real
 * markdown + meta.json files.
 *
 * Covers (per user directive Q11 2026-04-24):
 *   - Simple slug, no filePath → slug's own pack, empty inherited.
 *   - 3-deep parent chain, no filePath → slug's pack + ancestors
 *     root-first in inherited.
 *   - filePath matches leaf's own sourceFiles → pack = leaf.
 *   - filePath matches a mid ancestor's sourceFiles → pack = mid
 *     (ancestor-glob match; proves the chain walk goes in the
 *     correct direction).
 *   - filePath matches root's sourceFiles only → pack = root,
 *     inherited = [].
 *   - filePath with no match anywhere → silent fallback to leaf
 *     (DEBUG log; test asserts the response shape, not the log).
 *   - pack_not_found soft-failure.
 *   - feature_pack_cycle soft-failure with chain parsed from the
 *     store's InternalError message.
 *   - inherited ordering lock: 3-deep chain, assert the returned
 *     inherited[].map(p => p.metadata.slug) === ['root', 'middle'].
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly root: string;
  readonly store: FeaturePackStore;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  const root = mkdtempSync(join(tmpdir(), 'gfp-'));
  const store = createFeaturePackStore({ db: handle, featurePacksRoot: root });
  return {
    close: async () => {
      await client.close();
    },
    handle,
    root,
    store,
  };
}

function writePack(
  root: string,
  slug: string,
  opts: {
    readonly parentSlug?: string | null;
    readonly body?: string;
    readonly sourceFiles?: ReadonlyArray<string>;
    readonly structure?: Record<string, unknown>;
  } = {},
): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const body = opts.body ?? `# ${slug}\n`;
  writeFileSync(join(dir, 'spec.md'), `${body}spec\n`, 'utf8');
  writeFileSync(join(dir, 'implementation.md'), `${body}impl\n`, 'utf8');
  writeFileSync(join(dir, 'techstack.md'), `${body}tech\n`, 'utf8');
  const meta: Record<string, unknown> = {
    slug,
    parentSlug: opts.parentSlug ?? null,
    sourceFiles: opts.sourceFiles ?? [],
  };
  if (opts.structure !== undefined) meta.structure = opts.structure;
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function buildRegistry(store: FeaturePackStore): ToolRegistry {
  // makeFakeDeps supplies everything except featurePack; we override
  // that slot with the real store wired against the tmpdir.
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, featurePack: store });
  const registry = new ToolRegistry({ deps });
  registry.register(getFeaturePackToolRegistration);
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): GetFeaturePackOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: GetFeaturePackOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Simple single-pack + parent chain
// ---------------------------------------------------------------------------

describe('get_feature_pack — simple pack without filePath', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the slug pack and empty inherited for a root-only pack', async () => {
    writePack(h.root, 'solo-pack', { sourceFiles: ['src/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'solo-pack' }, 'sess_1'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.metadata.slug).toBe('solo-pack');
      expect(out.subPack).toBeNull();
      expect(out.inherited).toEqual([]);
    }
  });
});

describe('get_feature_pack — parent chain without filePath', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns inherited root-first, NOT including the leaf itself', async () => {
    writePack(h.root, 'root', { parentSlug: null, sourceFiles: ['packages/**'] });
    writePack(h.root, 'middle', { parentSlug: 'root', sourceFiles: ['apps/**'] });
    writePack(h.root, 'leaf', { parentSlug: 'middle', sourceFiles: ['apps/mcp-server/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'leaf' }, 'sess_1'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.metadata.slug).toBe('leaf');
      expect(out.inherited.map((p) => p.metadata.slug)).toEqual(['root', 'middle']);
      expect(out.subPack).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// filePath deepest-match resolution
// ---------------------------------------------------------------------------

describe('get_feature_pack — filePath matches leaf own sourceFiles', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns pack = leaf, inherited = [root, middle]', async () => {
    writePack(h.root, 'root', { parentSlug: null, sourceFiles: ['packages/**'] });
    writePack(h.root, 'middle', { parentSlug: 'root', sourceFiles: ['apps/**'] });
    writePack(h.root, 'leaf', { parentSlug: 'middle', sourceFiles: ['apps/mcp-server/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(
      await registry.handleCall(
        'get_feature_pack',
        { projectSlug: 'leaf', filePath: 'apps/mcp-server/src/index.ts' },
        'sess_1',
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.metadata.slug).toBe('leaf');
      expect(out.inherited.map((p) => p.metadata.slug)).toEqual(['root', 'middle']);
    }
  });
});

describe('get_feature_pack — filePath matches an ancestor, NOT the leaf', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns pack = middle, inherited = [root] when filePath matches middle sourceFiles only', async () => {
    // leaf.sourceFiles narrow to apps/mcp-server/** — won't match apps/hooks-bridge/**.
    // middle.sourceFiles ['apps/**'] — will match.
    writePack(h.root, 'root', { parentSlug: null, sourceFiles: ['packages/**'] });
    writePack(h.root, 'middle', { parentSlug: 'root', sourceFiles: ['apps/**'] });
    writePack(h.root, 'leaf', { parentSlug: 'middle', sourceFiles: ['apps/mcp-server/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(
      await registry.handleCall(
        'get_feature_pack',
        { projectSlug: 'leaf', filePath: 'apps/hooks-bridge/src/index.ts' },
        'sess_1',
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.metadata.slug).toBe('middle');
      expect(out.inherited.map((p) => p.metadata.slug)).toEqual(['root']);
      expect(out.subPack).toBeNull();
    }
  });

  it('returns pack = root, inherited = [] when filePath matches root sourceFiles only', async () => {
    writePack(h.root, 'root', { parentSlug: null, sourceFiles: ['packages/**'] });
    writePack(h.root, 'middle', { parentSlug: 'root', sourceFiles: ['apps/**'] });
    writePack(h.root, 'leaf', { parentSlug: 'middle', sourceFiles: ['apps/mcp-server/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(
      await registry.handleCall(
        'get_feature_pack',
        { projectSlug: 'leaf', filePath: 'packages/shared/src/errors/index.ts' },
        'sess_1',
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.metadata.slug).toBe('root');
      expect(out.inherited).toEqual([]);
    }
  });
});

describe('get_feature_pack — filePath with no match falls back silently', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns pack = slug pack and inherited = ancestors (no notice field emitted)', async () => {
    writePack(h.root, 'root', { parentSlug: null, sourceFiles: ['packages/**'] });
    writePack(h.root, 'leaf', { parentSlug: 'root', sourceFiles: ['apps/mcp-server/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(
      await registry.handleCall(
        'get_feature_pack',
        { projectSlug: 'leaf', filePath: 'docs/something-unrelated.md' },
        'sess_1',
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      // No sourceFiles glob matches; fall back to the slug's pack.
      expect(out.pack.metadata.slug).toBe('leaf');
      expect(out.inherited.map((p) => p.metadata.slug)).toEqual(['root']);
      // DEBUG log was emitted but we don't assert on log output here.
      // No `notice` or `warning` field leaks into the success branch.
      expect(Object.keys(out).sort()).toEqual(['inherited', 'ok', 'pack', 'subPack']);
    }
  });
});

// ---------------------------------------------------------------------------
// Soft-failures
// ---------------------------------------------------------------------------

describe('get_feature_pack — pack_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:pack_not_found / howToFix for an unknown slug', async () => {
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'ghost-slug' }, 'sess_1'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('pack_not_found');
      expect(out.howToFix).toMatch(/Register the pack via|proceed with default/);
    }
  });

  it('returns pack_not_found when a parent slug is missing from disk', async () => {
    // Child's parentSlug references 'absent-parent' which we never create.
    writePack(h.root, 'orphan', { parentSlug: 'absent-parent', sourceFiles: [] });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'orphan' }, 'sess_1'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('pack_not_found');
    }
  });
});

describe('get_feature_pack — feature_pack_cycle soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:feature_pack_cycle / chain / howToFix for a cyclic parentSlug chain', async () => {
    writePack(h.root, 'a', { parentSlug: 'b', sourceFiles: [] });
    writePack(h.root, 'b', { parentSlug: 'c', sourceFiles: [] });
    writePack(h.root, 'c', { parentSlug: 'a', sourceFiles: [] });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'a' }, 'sess_1'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('feature_pack_cycle');
      if (out.error === 'feature_pack_cycle') {
        expect(out.chain.length).toBeGreaterThanOrEqual(2);
        // Must contain at least one of the cycle slugs — visited-set
        // iteration order may vary, but 'a' always reappears at the end.
        expect(out.chain).toContain('a');
        expect(out.howToFix).toMatch(/parentSlug cycle/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Inherited ordering lock (Q11 explicit lock in addition to the unit test)
// ---------------------------------------------------------------------------

describe('get_feature_pack — inherited[] ordering lock (root-first)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('3-deep chain: inherited === ["root", "middle"] for the leaf pack', async () => {
    writePack(h.root, 'root', { parentSlug: null });
    writePack(h.root, 'middle', { parentSlug: 'root' });
    writePack(h.root, 'leaf', { parentSlug: 'middle' });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'leaf' }, 'sess_1'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.inherited.map((p) => p.metadata.slug)).toEqual(['root', 'middle']);
    }
  });
});

// ---------------------------------------------------------------------------
// G2.1 — the `structure` block (Graphify-seeded packs)
// ---------------------------------------------------------------------------

describe('get_feature_pack — structure block', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('surfaces pack.content.structure when meta.json carries a structure block', async () => {
    writePack(h.root, 'graph-seeded', {
      sourceFiles: ['src/auth/**'],
      structure: {
        source: 'graphify',
        communityId: 'c-auth',
        label: 'Auth Layer',
        godNodes: ['AuthService', 'TokenStore'],
        memberFiles: ['src/auth/service.ts'],
      },
    });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'graph-seeded' }, 'sess_1'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.content.structure).toEqual({
        source: 'graphify',
        communityId: 'c-auth',
        label: 'Auth Layer',
        godNodes: ['AuthService', 'TokenStore'],
        memberFiles: ['src/auth/service.ts'],
      });
    }
  });

  it('omits structure for a pack whose meta.json has no structure block', async () => {
    writePack(h.root, 'plain-pack', { sourceFiles: ['src/**'] });
    const registry = buildRegistry(h.store);
    const out = unwrap(await registry.handleCall('get_feature_pack', { projectSlug: 'plain-pack' }, 'sess_1'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pack.content.structure).toBeUndefined();
    }
  });
});
