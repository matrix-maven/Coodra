import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps, GraphifyClient } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGraphifyClient } from '../../../src/lib/graphify.js';
import { createQueryCodebaseGraphToolRegistration } from '../../../src/tools/query-codebase-graph/manifest.js';
import type { QueryCodebaseGraphOutput } from '../../../src/tools/query-codebase-graph/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__query_codebase_graph` (S15).
 *
 * Uses a real `createGraphifyClient` against a temp `graphifyRoot`
 * plus an in-memory SQLite handle migrated to 0003 with a projects
 * row seeded. Exercises the three distinct soft-failure / success
 * branches and locks the `getIndexStatus`-before-`expandContextBySlug`
 * ordering via a spy test.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly graphifyRoot: string;
  readonly projectId: string;
  readonly slug: string;
  readonly deps: ContextDeps;
}

async function openHarness(opts: { readonly graphifyOverride?: GraphifyClient } = {}): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const graphifyRoot = mkdtempSync(join(tmpdir(), 'qcg-'));
  const projectId = 'proj_qcg';
  const slug = 'slug-qcg';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, slug, 'org_test', 'qcg harness');

  const graphify = opts.graphifyOverride ?? createGraphifyClient({ db: handle, graphifyRoot });
  const baseDeps = makeFakeDeps({ graphify });
  return {
    close: async () => {
      await client.close();
    },
    handle,
    graphifyRoot,
    projectId,
    slug,
    deps: baseDeps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createQueryCodebaseGraphToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): QueryCodebaseGraphOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: QueryCodebaseGraphOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

function writeGraphJson(
  graphifyRoot: string,
  slug: string,
  body: { nodes?: ReadonlyArray<unknown>; edges?: ReadonlyArray<unknown> },
): void {
  const dir = join(graphifyRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(body), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. project_not_found soft-failure (slug not registered)
// ---------------------------------------------------------------------------

describe('query_codebase_graph — project_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found / howToFix for unknown projectSlug', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: 'nonexistent', query: 'foo' }, 'sess_nx'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
    expect(out.howToFix).toMatch(/coodra init|projects table/);
  });
});

// ---------------------------------------------------------------------------
// 2. codebase_graph_not_indexed — project exists, no graph.json on disk
// ---------------------------------------------------------------------------

describe('query_codebase_graph — codebase_graph_not_indexed soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:codebase_graph_not_indexed / howToFix when graph.json is missing', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'foo' }, 'sess_ni'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('codebase_graph_not_indexed');
    expect(out.howToFix).toMatch(/graphify scan/);
  });
});

// ---------------------------------------------------------------------------
// 3. Success — graph.json present, returns nodes + edges + indexed + notice
// ---------------------------------------------------------------------------

describe('query_codebase_graph — success path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the full subgraph with indexed:true + notice when graph.json is present and populated', async () => {
    writeGraphJson(h.graphifyRoot, h.slug, {
      nodes: [
        { id: 'mod_a', name: 'mod_a', kind: 'module' },
        { id: 'mod_b', name: 'mod_b', kind: 'module' },
      ],
      edges: [{ from: 'mod_a', to: 'mod_b', kind: 'calls' }],
    });
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'mod_a' }, 'sess_ok'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
    expect(out.indexed).toBe(true);
    // M05 reshape (2026-05-08): the deferral notice was removed.
  });

  it('empty graph.json (index present, zero nodes) is success-with-empty, NOT codebase_graph_not_indexed', async () => {
    writeGraphJson(h.graphifyRoot, h.slug, { nodes: [], edges: [] });
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'anything' }, 'sess_empty'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.indexed).toBe(true);
    // M05 reshape (2026-05-08): the deferral notice was removed.
  });

  it('malformed graph.json (index present, parse fails) returns success with empty nodes/edges + indexed:true — lib fail-open does NOT collapse with codebase_graph_not_indexed', async () => {
    // Write invalid JSON — the lib returns empty arrays but keeps the
    // file present (getIndexStatus still reports present:true).
    const dir = join(h.graphifyRoot, h.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.json'), '{not valid json', 'utf8');
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'foo' }, 'sess_bad'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Lib-level fail-open: parse failure → empty arrays. But the file
    // exists so getIndexStatus returns present:true → indexed stays true.
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.indexed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Ordering — getIndexStatus called BEFORE expandContextBySlug
// ---------------------------------------------------------------------------

describe('query_codebase_graph — getIndexStatus runs BEFORE expandContextBySlug', () => {
  it('missing-index path short-circuits — expandContextBySlug is NOT called', async () => {
    // Graphify client with a present:false stub — assert expandContextBySlug
    // is NOT invoked when getIndexStatus reports missing.
    const calls: string[] = [];
    const stub: GraphifyClient = {
      async getIndexStatus(slug) {
        calls.push(`getIndexStatus:${slug}`);
        return { present: false, howToFix: 'run `graphify scan` at repo root' };
      },
      async expandContextBySlug(slug) {
        calls.push(`expandContextBySlug:${slug}`);
        return { nodes: [], edges: [] };
      },
      async expandContext() {
        calls.push('expandContext');
        return { nodes: [], edges: [] };
      },
    };
    const h = await openHarness({ graphifyOverride: stub });
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'foo' }, 'sess_order'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('codebase_graph_not_indexed');
    // Order lock: only getIndexStatus fired. Never expandContextBySlug.
    expect(calls).toEqual([`getIndexStatus:${h.slug}`]);
    await h.close();
  });

  it('present-index path — getIndexStatus called BEFORE expandContextBySlug; both observed in order via spy', async () => {
    const calls: string[] = [];
    const stub: GraphifyClient = {
      async getIndexStatus(slug) {
        calls.push(`getIndexStatus:${slug}`);
        return { present: true };
      },
      async expandContextBySlug(slug) {
        calls.push(`expandContextBySlug:${slug}`);
        return { nodes: [{ id: 'n1' }], edges: [] };
      },
      async expandContext() {
        calls.push('expandContext');
        return { nodes: [], edges: [] };
      },
    };
    const h = await openHarness({ graphifyOverride: stub });
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'foo' }, 'sess_ok_spy'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.nodes).toEqual([{ id: 'n1' }]);
    expect(calls).toEqual([`getIndexStatus:${h.slug}`, `expandContextBySlug:${h.slug}`]);
    // expandContext (runId-variant) is never called by S15.
    expect(calls).not.toContain('expandContext');
    await h.close();
  });

  it('project_not_found short-circuits BEFORE any graphify call', async () => {
    const calls: string[] = [];
    const stub: GraphifyClient = {
      async getIndexStatus(slug) {
        calls.push(`getIndexStatus:${slug}`);
        return { present: true };
      },
      async expandContextBySlug(slug) {
        calls.push(`expandContextBySlug:${slug}`);
        return { nodes: [], edges: [] };
      },
      async expandContext() {
        calls.push('expandContext');
        return { nodes: [], edges: [] };
      },
    };
    const h = await openHarness({ graphifyOverride: stub });
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: 'nonexistent-slug', query: 'foo' }, 'sess_nf'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
    expect(calls).toEqual([]);
    await h.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Per-slug cache observable — second call for same slug hits cache
// ---------------------------------------------------------------------------

describe('query_codebase_graph — per-slug cache (lib level)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('second call for same slug returns the same cached subgraph — disk change while cache is warm is NOT observed', async () => {
    writeGraphJson(h.graphifyRoot, h.slug, { nodes: [{ id: 'first' }], edges: [] });
    const registry = buildRegistry(h);
    const first = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'foo' }, 'sess_c1'),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.nodes).toEqual([{ id: 'first' }]);

    // Rewrite graph.json. Because the lib has no TTL, the cached
    // version wins.
    writeGraphJson(h.graphifyRoot, h.slug, { nodes: [{ id: 'second' }], edges: [] });

    const second = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'foo' }, 'sess_c2'),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.nodes).toEqual([{ id: 'first' }]);
  });
});

// ---------------------------------------------------------------------------
// 6. query is accepted but NOT applied at M02
// ---------------------------------------------------------------------------

describe('query_codebase_graph — query is accepted but NOT applied at M02', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('different query values return identical nodes at M02 — filtering deferred to Module 05', async () => {
    writeGraphJson(h.graphifyRoot, h.slug, {
      nodes: [
        { id: 'mod_a', name: 'matches' },
        { id: 'mod_b', name: 'also_matches' },
        { id: 'mod_c', name: 'unrelated' },
      ],
      edges: [],
    });
    const registry = buildRegistry(h);
    const matchQuery = unwrap(
      await registry.handleCall('query_codebase_graph', { projectSlug: h.slug, query: 'matches' }, 'sess_q1'),
    );
    const unmatchQuery = unwrap(
      await registry.handleCall(
        'query_codebase_graph',
        { projectSlug: h.slug, query: 'xyzzy_never_present' },
        'sess_q2',
      ),
    );
    expect(matchQuery.ok).toBe(true);
    expect(unmatchQuery.ok).toBe(true);
    if (!matchQuery.ok || !unmatchQuery.ok) return;
    // M05 reshape (2026-05-08): the deferral notice was removed.
    // The full subgraph is still returned regardless of query.
    expect(matchQuery.nodes).toHaveLength(3);
    expect(unmatchQuery.nodes).toHaveLength(3);
  });
});
