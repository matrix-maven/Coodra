import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createFeaturePackStore } from '../../../src/lib/feature-pack.js';
import { getFeaturePackToolRegistration } from '../../../src/tools/get-feature-pack/manifest.js';
import type { GetFeaturePackOutput } from '../../../src/tools/get-feature-pack/schema.js';
import { createSeedFeaturePacksFromGraphToolRegistration } from '../../../src/tools/seed-feature-packs-from-graph/manifest.js';
import type { SeedFeaturePacksFromGraphOutput } from '../../../src/tools/seed-feature-packs-from-graph/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__seed_feature_packs_from_graph`
 * (Module 09 / G2 + G2.1). Exercises the real handler end-to-end via
 * the `ToolRegistry` against an in-memory SQLite DB + a tmp
 * `featurePacksRoot`.
 *
 * What this guards:
 *   - Happy path — one DRAFT `feature_packs` row + on-disk pack files
 *     per community, with the Graphify structure embedded.
 *   - Idempotent re-seed — a second call updates in place, no duplicate.
 *   - Status preservation — re-seeding a published pack keeps it published.
 *   - project_not_found soft-failure — no rows, no disk dirs.
 *   - G2.1 end-to-end — seed → draft is hidden from `get_feature_pack`
 *     → activate → `get_feature_pack` surfaces `pack.content.structure`.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly deps: ContextDeps;
  readonly featurePacksRoot: string;
}

const PROJECT_SLUG = 'seedproj';

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run('proj_seed', PROJECT_SLUG, 'org_test', 'seed harness');

  return {
    close: async () => {
      await client.close();
    },
    handle,
    deps: makeFakeDeps(),
    featurePacksRoot: mkdtempSync(join(tmpdir(), 'seed-fp-')),
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(
    createSeedFeaturePacksFromGraphToolRegistration({ db: h.handle, featurePacksRoot: h.featurePacksRoot }),
  );
  return registry;
}

function unwrap<T>(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): T {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: T };
  if (!parsed.ok || parsed.data === undefined) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

const AUTH_COMMUNITY = {
  communityId: 'c-auth',
  label: 'Auth Layer',
  godNodes: ['AuthService', 'TokenStore'],
  memberFiles: ['src/auth/service.ts', 'src/auth/tokens.ts'],
  summary: 'Authentication and token handling.',
};
const DB_COMMUNITY = {
  communityId: 'c-db',
  label: 'Database',
  godNodes: ['DbClient'],
  memberFiles: ['src/db/client.ts'],
};

// ---------------------------------------------------------------------------
// Happy path — DB rows + on-disk pack files
// ---------------------------------------------------------------------------

describe('seed_feature_packs_from_graph — happy path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('creates one DRAFT feature_packs row + on-disk pack files per community', async () => {
    const registry = buildRegistry(h);
    const out = unwrap<SeedFeaturePacksFromGraphOutput>(
      await registry.handleCall(
        'seed_feature_packs_from_graph',
        { projectSlug: PROJECT_SLUG, communities: [AUTH_COMMUNITY, DB_COMMUNITY] },
        'sess_seed',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.count).toBe(2);
    expect(out.seeded.every((s) => s.created)).toBe(true);
    expect(out.seeded.map((s) => s.slug).sort()).toEqual(['seedproj-auth-layer', 'seedproj-database']);

    // --- DB row ---
    const authRows = await h.handle.db
      .select()
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, 'seedproj-auth-layer'));
    expect(authRows).toHaveLength(1);
    const auth = authRows[0];
    if (!auth) throw new Error('auth pack row missing');
    expect(auth.status).toBe('draft');
    expect(auth.orgId).toBe('org_test');
    expect(auth.checksum.startsWith('sha256:')).toBe(true);

    const envelope = JSON.parse(auth.contentJson ?? '{}') as {
      meta: { structure?: { communityId: string; godNodes: string[] } };
    };
    expect(envelope.meta.structure?.communityId).toBe('c-auth');
    expect(envelope.meta.structure?.godNodes).toEqual(['AuthService', 'TokenStore']);

    // --- on-disk pack files ---
    const packDir = join(h.featurePacksRoot, 'seedproj-auth-layer');
    expect(existsSync(join(packDir, 'spec.md'))).toBe(true);
    expect(existsSync(join(packDir, 'meta.json'))).toBe(true);

    const spec = readFileSync(join(packDir, 'spec.md'), 'utf8');
    expect(spec).toContain('# Auth Layer');
    expect(spec).toContain('Draft — seeded from Graphify');
    expect(spec).toContain('AuthService');
    expect(spec).toContain('src/auth/service.ts');

    const diskMeta = JSON.parse(readFileSync(join(packDir, 'meta.json'), 'utf8')) as {
      slug: string;
      structure?: { source: string; communityId: string; godNodes: string[]; memberFiles: string[] };
    };
    expect(diskMeta.slug).toBe('seedproj-auth-layer');
    expect(diskMeta.structure?.source).toBe('graphify');
    expect(diskMeta.structure?.communityId).toBe('c-auth');
    expect(diskMeta.structure?.memberFiles).toEqual(['src/auth/service.ts', 'src/auth/tokens.ts']);
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-seed + status preservation
// ---------------------------------------------------------------------------

describe('seed_feature_packs_from_graph — idempotent re-seed', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('a second seed of the same community updates in place — created:false, no duplicate row', async () => {
    const registry = buildRegistry(h);
    const first = unwrap<SeedFeaturePacksFromGraphOutput>(
      await registry.handleCall(
        'seed_feature_packs_from_graph',
        { projectSlug: PROJECT_SLUG, communities: [AUTH_COMMUNITY] },
        'sess_seed',
      ),
    );
    expect(first.ok && first.seeded[0]?.created).toBe(true);

    const second = unwrap<SeedFeaturePacksFromGraphOutput>(
      await registry.handleCall(
        'seed_feature_packs_from_graph',
        {
          projectSlug: PROJECT_SLUG,
          communities: [{ ...AUTH_COMMUNITY, summary: 'Updated summary on the re-seed.' }],
        },
        'sess_seed',
      ),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.seeded[0]?.created).toBe(false);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, 'seedproj-auth-layer'));
    expect(rows).toHaveLength(1);
    const spec = readFileSync(join(h.featurePacksRoot, 'seedproj-auth-layer', 'spec.md'), 'utf8');
    expect(spec).toContain('Updated summary on the re-seed.');
  });

  it('re-seeding does NOT clobber a pack a tech lead has already published', async () => {
    const registry = buildRegistry(h);
    await registry.handleCall(
      'seed_feature_packs_from_graph',
      { projectSlug: PROJECT_SLUG, communities: [DB_COMMUNITY] },
      'sess_seed',
    );
    h.handle.raw.prepare('UPDATE feature_packs SET status = ? WHERE slug = ?').run('published', 'seedproj-database');

    await registry.handleCall(
      'seed_feature_packs_from_graph',
      { projectSlug: PROJECT_SLUG, communities: [DB_COMMUNITY] },
      'sess_seed',
    );
    const rows = await h.handle.db
      .select({ status: sqliteSchema.featurePacks.status })
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, 'seedproj-database'));
    expect(rows[0]?.status).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// project_not_found soft-failure
// ---------------------------------------------------------------------------

describe('seed_feature_packs_from_graph — project_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / project_not_found and inserts no rows, writes no files', async () => {
    const registry = buildRegistry(h);
    const out = unwrap<SeedFeaturePacksFromGraphOutput>(
      await registry.handleCall(
        'seed_feature_packs_from_graph',
        { projectSlug: 'no-such-project', communities: [AUTH_COMMUNITY] },
        'sess_seed',
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
    expect(out.howToFix.length).toBeGreaterThan(0);

    const rows = await h.handle.db.select().from(sqliteSchema.featurePacks);
    expect(rows).toHaveLength(0);
    expect(existsSync(join(h.featurePacksRoot, 'no-such-project-auth-layer'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G2.1 end-to-end — seed → draft hidden → activate → get_feature_pack
// surfaces the structure block
// ---------------------------------------------------------------------------

describe('seed_feature_packs_from_graph — G2.1 end-to-end with get_feature_pack', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('a seeded pack is hidden as a draft, then surfaces its structure once activated', async () => {
    // A registry with BOTH tools; get_feature_pack reads the real
    // filesystem-first store wired to the same featurePacksRoot.
    const store = createFeaturePackStore({ db: h.handle, featurePacksRoot: h.featurePacksRoot });
    const deps: ContextDeps = Object.freeze({ ...makeFakeDeps(), featurePack: store });
    const registry = new ToolRegistry({ deps });
    registry.register(
      createSeedFeaturePacksFromGraphToolRegistration({ db: h.handle, featurePacksRoot: h.featurePacksRoot }),
    );
    registry.register(getFeaturePackToolRegistration);

    // 1. Seed the community.
    await registry.handleCall(
      'seed_feature_packs_from_graph',
      { projectSlug: PROJECT_SLUG, communities: [AUTH_COMMUNITY] },
      'sess_e2e',
    );
    const slug = 'seedproj-auth-layer';

    // 2. Draft → get_feature_pack must NOT see it.
    const draftOut = unwrap<GetFeaturePackOutput>(
      await registry.handleCall('get_feature_pack', { projectSlug: slug }, 'sess_e2e'),
    );
    expect(draftOut.ok).toBe(false);
    if (!draftOut.ok) {
      expect(draftOut.error).toBe('pack_not_found');
    }

    // 3. Tech lead activates the pack.
    h.handle.raw.prepare('UPDATE feature_packs SET status = ? WHERE slug = ?').run('published', slug);

    // 4. get_feature_pack now surfaces the pack — including the structure block.
    const liveOut = unwrap<GetFeaturePackOutput>(
      await registry.handleCall('get_feature_pack', { projectSlug: slug }, 'sess_e2e'),
    );
    expect(liveOut.ok).toBe(true);
    if (liveOut.ok) {
      expect(liveOut.pack.metadata.slug).toBe(slug);
      expect(liveOut.pack.content.structure).toEqual({
        source: 'graphify',
        communityId: 'c-auth',
        label: 'Auth Layer',
        godNodes: ['AuthService', 'TokenStore'],
        memberFiles: ['src/auth/service.ts', 'src/auth/tokens.ts'],
      });
      expect(liveOut.pack.content.spec).toContain('# Auth Layer');
    }
  });
});
