import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createWorkPackStatusToolRegistration } from '../../../src/tools/work-pack-status/manifest.js';
import type { WorkPackStatusOutput } from '../../../src/tools/work-pack-status/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__work_pack_status` (BM25 `query` param
 * added 2026-08-03, alongside search_packs_nl/query_decisions).
 *
 * Real SQLite migrated (so `work_packs_fts` + its sync triggers are
 * live). No dedicated integration coverage existed for this tool before
 * — established fresh alongside the `query` param.
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

  const projectA = 'proj_wps_a';
  const projectB = 'proj_wps_b';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectA, 'slug-a', 'org_test', 'project A');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectB, 'slug-b', 'org_test', 'project B');

  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps });

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
  registry.register(createWorkPackStatusToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): WorkPackStatusOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: WorkPackStatusOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

function seedWorkPack(
  h: Harness,
  id: string,
  projectId: string,
  slug: string,
  title: string,
  specMarkdown: string,
  updatedAtSec: number,
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_packs
        (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, slug, title, 'task', 'draft', specMarkdown, '', '', '{}', updatedAtSec);
}

describe('work_pack_status — query BM25 ranking', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('ranks the pack with denser term matches first', async () => {
    seedWorkPack(
      h,
      'wp_weak',
      h.projectA,
      'pack-weak',
      'Sprint planning',
      'Briefly touched on BM25 search while discussing the sprint board.',
      1000,
    );
    seedWorkPack(
      h,
      'wp_strong',
      h.projectA,
      'pack-strong',
      'BM25 search rollout',
      'BM25 BM25 BM25 — implemented BM25 search across every searchable tool.',
      2000,
    );

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('work_pack_status', { query: 'BM25' }, 'sess_wps'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['wp_strong', 'wp_weak']);
  });

  it('requires every word in a multi-word query to appear (implicit AND)', async () => {
    seedWorkPack(h, 'wp_both', h.projectA, 'pack-both', 'FTS rollout', 'BM25 and tsvector both implemented.', 1000);
    seedWorkPack(h, 'wp_one', h.projectA, 'pack-one', 'BM25 only', 'BM25 implemented, ranking deferred.', 2000);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('work_pack_status', { query: 'BM25 tsvector' }, 'sess_wps'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['wp_both']);
  });

  it('returns ok:true packs:[] when nothing matches', async () => {
    seedWorkPack(h, 'wp_x', h.projectA, 'pack-x', 'unrelated', 'nothing to see here', 1000);
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('work_pack_status', { query: 'nonexistentterm' }, 'sess_wps'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs).toEqual([]);
  });
});

describe('work_pack_status — query scoped by runId project when both are supplied', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('does not return matches from another project when runId scopes to project A', async () => {
    h.handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('run_a', h.projectA, 'sess_run_a', 'claude_code', 'solo', 'in_progress', 1000);
    seedWorkPack(h, 'wp_a', h.projectA, 'pack-a', 'widget work', 'widget rollout notes', 1000);
    seedWorkPack(h, 'wp_b', h.projectB, 'pack-b', 'widget work', 'widget rollout notes', 1000);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('work_pack_status', { runId: 'run_a', query: 'widget' }, 'sess_wps'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['wp_a']);
  });
});

describe('work_pack_status — default (no query) behaviour is unchanged', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists every pack ordered by updatedAt DESC when query is absent', async () => {
    seedWorkPack(h, 'wp_old', h.projectA, 'pack-old', 'old', 'old spec', 1000);
    seedWorkPack(h, 'wp_new', h.projectA, 'pack-new', 'new', 'new spec', 2000);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('work_pack_status', {}, 'sess_wps'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.packs.map((p) => p.id)).toEqual(['wp_new', 'wp_old']);
  });
});
