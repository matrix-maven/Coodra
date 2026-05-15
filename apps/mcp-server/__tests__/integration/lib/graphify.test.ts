import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient } from '../../../src/lib/db.js';
import { createGraphifyClient } from '../../../src/lib/graphify.js';

/**
 * Integration test for `src/lib/graphify.ts` (S7c).
 *
 * Exercises both `expandContext` and `getIndexStatus` against a
 * temporary `graphifyRoot` and an in-memory SQLite handle seeded
 * with a `runs` + `projects` pair so runId-resolution has real
 * rows to hit.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly graphifyRoot: string;
  readonly projectSlug: string;
  readonly runId: string;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  const graphifyRoot = mkdtempSync(join(tmpdir(), 'graphify-'));
  const projectId = 'proj_graphify';
  const projectSlug = 'slug-graphify';
  const runId = 'run_graphify';
  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
    .run(projectId, projectSlug, 'org_test', 'graphify harness');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, projectId, 'sess_gfx', 'claude_code', 'solo', 'in_progress');
  return {
    close: async () => {
      await client.close();
    },
    handle,
    graphifyRoot,
    projectSlug,
    runId,
  };
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

describe('lib/graphify — createGraphifyClient construction', () => {
  it('rejects missing options', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createGraphifyClient(undefined as unknown as any)).toThrow(TypeError);
  });
  it('rejects missing db handle', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createGraphifyClient({} as any)).toThrow(/db must be a DbHandle/);
  });
});

describe('lib/graphify — getIndexStatus', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns { present: false, howToFix } when graph.json missing', async () => {
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const status = await client.getIndexStatus(h.projectSlug);
    expect(status.present).toBe(false);
    expect(status.howToFix).toMatch(/graphify scan/);
  });

  it('returns { present: true } once graph.json exists', async () => {
    writeGraphJson(h.graphifyRoot, h.projectSlug, { nodes: [], edges: [] });
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const status = await client.getIndexStatus(h.projectSlug);
    expect(status.present).toBe(true);
  });

  it('returns present=false for an empty slug', async () => {
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const status = await client.getIndexStatus('');
    expect(status.present).toBe(false);
  });
});

describe('lib/graphify — expandContext', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns empty when runId does not resolve to a slug', async () => {
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const out = await client.expandContext({ runId: 'run_nope', depth: 1 });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it('returns empty when runId resolves but graph.json is missing', async () => {
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const out = await client.expandContext({ runId: h.runId, depth: 1 });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it('parses nodes + edges from graph.json when the file exists', async () => {
    writeGraphJson(h.graphifyRoot, h.projectSlug, {
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      edges: [{ from: 'n1', to: 'n2' }],
    });
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const out = await client.expandContext({ runId: h.runId, depth: 1 });
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
  });

  it('returns empty on malformed graph.json (fail-open, logs WARN)', async () => {
    const dir = join(h.graphifyRoot, h.projectSlug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.json'), 'not valid json{', 'utf8');
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const out = await client.expandContext({ runId: h.runId, depth: 1 });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it('caches the parsed graph after first read', async () => {
    writeGraphJson(h.graphifyRoot, h.projectSlug, {
      nodes: [{ id: 'original' }],
      edges: [],
    });
    const client = createGraphifyClient({ db: h.handle, graphifyRoot: h.graphifyRoot });
    const first = await client.expandContext({ runId: h.runId, depth: 1 });
    expect(first.nodes).toEqual([{ id: 'original' }]);
    // Mutate the file; cached client must NOT observe the change.
    writeGraphJson(h.graphifyRoot, h.projectSlug, {
      nodes: [{ id: 'mutated' }],
      edges: [],
    });
    const second = await client.expandContext({ runId: h.runId, depth: 1 });
    expect(second.nodes).toEqual([{ id: 'original' }]);
  });
});
