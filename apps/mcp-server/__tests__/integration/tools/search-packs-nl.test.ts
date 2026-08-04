import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createSearchPacksNlToolRegistration } from '../../../src/tools/search-packs-nl/manifest.js';
import type { SearchPacksNlOutput } from '../../../src/tools/search-packs-nl/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__search_packs_nl` (BM25 rewrite, 2026-08-03).
 *
 * Real SQLite migrated (so `context_packs_fts` + its sync triggers are
 * live) — the LIKE-substring implementation this replaced had no
 * dedicated integration coverage; this file establishes it fresh
 * alongside the BM25 rewrite.
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

  const projectA = 'proj_spn_a';
  const projectB = 'proj_spn_b';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectA, 'slug-a', 'org_test', 'project A');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectB, 'slug-b', 'org_test', 'project B');

  const contextPacksRoot = mkdtempSync(join(tmpdir(), 'spn-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    projectA,
    projectB,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createSearchPacksNlToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): SearchPacksNlOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: SearchPacksNlOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

function seedRun(h: Harness, id: string, projectId: string): void {
  h.handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, `sess_${id}`, 'claude_code', 'solo', 'in_progress', 1000);
}

function seedContextPack(
  h: Harness,
  id: string,
  runId: string,
  projectId: string,
  title: string,
  content: string,
  contentExcerpt: string,
  createdAtSec: number,
  source = 'agent',
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO context_packs (id, run_id, project_id, title, content, content_excerpt, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, runId, projectId, title, content, contentExcerpt, source, createdAtSec);
}

describe('search_packs_nl — project_not_found soft-failure', () => {
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
      await registry.handleCall('search_packs_nl', { projectSlug: 'nonexistent', query: 'anything' }, 'sess_spn'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
  });
});

describe('search_packs_nl — empty result is ok:true packs:[]', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('registered project with no matching packs returns ok:true with empty array', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('search_packs_nl', { projectSlug: 'slug-a', query: 'nonexistentword' }, 'sess_spn'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs).toEqual([]);
  });
});

describe('search_packs_nl — BM25 ranking', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('ranks the pack with denser term matches first, ahead of a merely-mentioning pack', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedRun(h, 'run_y', h.projectA);
    seedContextPack(
      h,
      'pack_weak',
      'run_x',
      h.projectA,
      'Sprint planning notes',
      'Briefly touched on authentication while discussing the sprint board.',
      'Briefly touched on authentication while discussing the sprint board.',
      1000,
    );
    seedContextPack(
      h,
      'pack_strong',
      'run_y',
      h.projectA,
      'Authentication overhaul',
      'Authentication authentication authentication — rewrote the authentication flow end to end.',
      'Authentication authentication authentication — rewrote the authentication flow end to end.',
      2000,
    );

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('search_packs_nl', { projectSlug: 'slug-a', query: 'authentication' }, 'sess_spn'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['pack_strong', 'pack_weak']);
    const strongScore = out.packs[0]?.score;
    const weakScore = out.packs[1]?.score;
    expect(strongScore).not.toBeNull();
    expect(weakScore).not.toBeNull();
    expect(strongScore).toBeGreaterThan(weakScore ?? Number.NaN);
  });

  it('requires every word in a multi-word query to appear (implicit AND)', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedRun(h, 'run_y', h.projectA);
    seedContextPack(
      h,
      'pack_both',
      'run_x',
      h.projectA,
      'Storage and retries',
      'Chose atomic-rename storage with cockatiel retries.',
      'Chose atomic-rename storage with cockatiel retries.',
      1000,
    );
    seedContextPack(
      h,
      'pack_one',
      'run_y',
      h.projectA,
      'Storage only',
      'Chose atomic-rename storage, no retry library needed.',
      'Chose atomic-rename storage, no retry library needed.',
      2000,
    );

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('search_packs_nl', { projectSlug: 'slug-a', query: 'storage cockatiel' }, 'sess_spn'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['pack_both']);
  });
});

describe('search_packs_nl — scopes to project (no cross-project leak)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('does not return matches from another project', async () => {
    seedRun(h, 'run_a', h.projectA);
    seedRun(h, 'run_b', h.projectB);
    seedContextPack(
      h,
      'pack_a',
      'run_a',
      h.projectA,
      'widget rollout',
      'widget rollout notes',
      'widget rollout notes',
      1000,
    );
    seedContextPack(
      h,
      'pack_b',
      'run_b',
      h.projectB,
      'widget rollout',
      'widget rollout notes',
      'widget rollout notes',
      1000,
    );

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('search_packs_nl', { projectSlug: 'slug-a', query: 'widget' }, 'sess_spn'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['pack_a']);
  });
});

describe('search_packs_nl — source field passthrough', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('preserves bridge_auto vs agent source', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedContextPack(
      h,
      'pack_bridge',
      'run_x',
      h.projectA,
      'auto digest',
      'quarantine keyword content',
      'quarantine keyword content',
      1000,
      'bridge_auto',
    );

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('search_packs_nl', { projectSlug: 'slug-a', query: 'quarantine' }, 'sess_spn'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs[0]?.source).toBe('bridge_auto');
  });
});

describe('search_packs_nl — limit parameter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('honours the supplied limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      seedRun(h, `run_${i}`, h.projectA);
      seedContextPack(
        h,
        `pack_${i}`,
        `run_${i}`,
        h.projectA,
        `pack ${i}`,
        'shared keyword content across every pack',
        'shared keyword content across every pack',
        1000 + i,
      );
    }

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('search_packs_nl', { projectSlug: 'slug-a', query: 'keyword', limit: 2 }, 'sess_spn'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs).toHaveLength(2);
  });
});
