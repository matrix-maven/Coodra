import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createQueryRunHistoryToolRegistration } from '../../../src/tools/query-run-history/manifest.js';
import type { QueryRunHistoryOutput } from '../../../src/tools/query-run-history/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__query_run_history` (S12).
 *
 * Real SQLite migrated to 0003. Two projects seeded to guard against
 * cross-project leaks. Runs seeded with explicit `started_at` values
 * so DESC ordering is deterministic. A subset of runs have matching
 * `context_packs` rows (via the real `ContextPackStore`) to verify
 * the LEFT JOIN title projection.
 *
 * TEST-WRITER GUARD: always pass `contextPacksRoot=<tmpdir>` when
 * constructing `createContextPackStore` — the default cwd default
 * leaks into the repo tree. This harness does so at line ~55.
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

  const projectA = 'proj_qrh_a';
  const projectB = 'proj_qrh_b';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectA, 'slug-a', 'org_test', 'project A');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectB, 'slug-b', 'org_test', 'project B');

  const contextPacksRoot = mkdtempSync(join(tmpdir(), 'qrh-'));
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
  registry.register(createQueryRunHistoryToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): QueryRunHistoryOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: QueryRunHistoryOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

/**
 * Seed a run with explicit started_at so DESC ordering is
 * deterministic even when two inserts land in the same second.
 * `started_at` stored as unix-seconds per the schema's `integer
 * mode:'timestamp'`. `ended_at` is provided for completed/failed
 * runs, null for in-progress.
 */
function seedRun(
  h: Harness,
  id: string,
  projectId: string,
  startedAtSec: number,
  status: 'in_progress' | 'completed' | 'failed',
  extras: { readonly issueRef?: string; readonly prRef?: string; readonly endedAtSec?: number } = {},
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, issue_ref, pr_ref, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      `sess_${id}`,
      'claude_code',
      'solo',
      status,
      extras.issueRef ?? null,
      extras.prRef ?? null,
      startedAtSec,
      extras.endedAtSec ?? null,
    );
}

function seedPack(h: Harness, runId: string, projectId: string, title: string, content = 'body'): void {
  h.handle.raw
    .prepare(
      `INSERT INTO context_packs (id, run_id, project_id, title, content, content_excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`cp_${runId}`, runId, projectId, title, content, content.slice(0, 500), 1700000000);
}

// ---------------------------------------------------------------------------
// project_not_found soft-failure
// ---------------------------------------------------------------------------

describe('query_run_history — project_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found / howToFix when the slug is not registered', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'nonexistent' }, 'sess_qrh'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
    expect(out.howToFix).toMatch(/coodra init|projects table/);
  });
});

// ---------------------------------------------------------------------------
// Empty is success-with-empty, NOT soft-failure
// ---------------------------------------------------------------------------

describe('query_run_history — empty runs is ok:true runs:[]', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('registered project with zero runs returns ok:true with empty array', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DESC order by startedAt
// ---------------------------------------------------------------------------

describe('query_run_history — DESC order by startedAt', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('most recent first', async () => {
    seedRun(h, 'run_old', h.projectA, 1000, 'completed', { endedAtSec: 1100 });
    seedRun(h, 'run_mid', h.projectA, 2000, 'completed', { endedAtSec: 2100 });
    seedRun(h, 'run_new', h.projectA, 3000, 'in_progress');

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs.map((r) => r.runId)).toEqual(['run_new', 'run_mid', 'run_old']);
  });
});

// ---------------------------------------------------------------------------
// status filter
// ---------------------------------------------------------------------------

describe('query_run_history — status filter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns only runs matching the supplied status', async () => {
    seedRun(h, 'run_ip_1', h.projectA, 1000, 'in_progress');
    seedRun(h, 'run_done_1', h.projectA, 2000, 'completed', { endedAtSec: 2100 });
    seedRun(h, 'run_ip_2', h.projectA, 3000, 'in_progress');
    seedRun(h, 'run_fail_1', h.projectA, 4000, 'failed', { endedAtSec: 4100 });

    const registry = buildRegistry(h);
    const inProgress = unwrap(
      await registry.handleCall('query_run_history', { projectSlug: 'slug-a', status: 'in_progress' }, 'sess_qrh'),
    );
    expect(inProgress.ok).toBe(true);
    if (!inProgress.ok) return;
    expect(inProgress.runs.map((r) => r.runId)).toEqual(['run_ip_2', 'run_ip_1']);
    expect(inProgress.runs.every((r) => r.status === 'in_progress')).toBe(true);

    const failed = unwrap(
      await registry.handleCall('query_run_history', { projectSlug: 'slug-a', status: 'failed' }, 'sess_qrh'),
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.runs.map((r) => r.runId)).toEqual(['run_fail_1']);
  });
});

// ---------------------------------------------------------------------------
// limit parameter
// ---------------------------------------------------------------------------

describe('query_run_history — limit parameter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('honours the supplied limit; default is 10', async () => {
    for (let i = 0; i < 15; i += 1) {
      seedRun(h, `run_${String(i).padStart(2, '0')}`, h.projectA, 1000 + i, 'in_progress');
    }
    const registry = buildRegistry(h);

    const defaulted = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.runs).toHaveLength(10);
    // Latest 10 (14..5) in DESC order.
    expect(defaulted.runs[0]?.runId).toBe('run_14');
    expect(defaulted.runs[9]?.runId).toBe('run_05');

    const capped = unwrap(
      await registry.handleCall('query_run_history', { projectSlug: 'slug-a', limit: 3 }, 'sess_qrh'),
    );
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.runs.map((r) => r.runId)).toEqual(['run_14', 'run_13', 'run_12']);
  });
});

// ---------------------------------------------------------------------------
// LEFT JOIN context_packs for title
// ---------------------------------------------------------------------------

describe('query_run_history — title from joined context_pack', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns pack title for runs that have a pack, and null for runs that do not', async () => {
    seedRun(h, 'run_with_pack', h.projectA, 1000, 'completed', { endedAtSec: 1100 });
    seedPack(h, 'run_with_pack', h.projectA, 'built the cockatiel wrapper');
    seedRun(h, 'run_without_pack', h.projectA, 2000, 'in_progress');

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const byId = new Map(out.runs.map((r) => [r.runId, r]));
    expect(byId.get('run_with_pack')?.title).toBe('built the cockatiel wrapper');
    expect(byId.get('run_without_pack')?.title).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No cross-project leakage
// ---------------------------------------------------------------------------

describe('query_run_history — scopes to project', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns only runs for the requested project; other project untouched', async () => {
    seedRun(h, 'run_a_1', h.projectA, 1000, 'in_progress');
    seedRun(h, 'run_b_1', h.projectB, 2000, 'in_progress');
    seedRun(h, 'run_b_2', h.projectB, 3000, 'completed', { endedAtSec: 3100 });

    const registry = buildRegistry(h);
    const outA = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(outA.ok).toBe(true);
    if (!outA.ok) return;
    expect(outA.runs.map((r) => r.runId)).toEqual(['run_a_1']);

    const outB = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-b' }, 'sess_qrh'));
    expect(outB.ok).toBe(true);
    if (!outB.ok) return;
    expect(outB.runs.map((r) => r.runId)).toEqual(['run_b_2', 'run_b_1']);
  });
});

// ---------------------------------------------------------------------------
// issueRef / prRef / endedAt passthrough
// ---------------------------------------------------------------------------

describe('query_run_history — metadata passthrough', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('passes issueRef, prRef, and ISO-formatted endedAt through to the wire shape', async () => {
    seedRun(h, 'run_meta', h.projectA, 1000, 'completed', {
      endedAtSec: 1500,
      issueRef: 'PROJ-123',
      prRef: 'Abishai95141/Coodra#45',
    });

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [entry] = out.runs;
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.runId).toBe('run_meta');
    expect(entry.issueRef).toBe('PROJ-123');
    expect(entry.prRef).toBe('Abishai95141/Coodra#45');
    expect(entry.status).toBe('completed');
    expect(entry.startedAt).toBe(new Date(1000 * 1000).toISOString());
    expect(entry.endedAt).toBe(new Date(1500 * 1000).toISOString());
  });

  it('returns null endedAt for in-progress runs', async () => {
    seedRun(h, 'run_ip', h.projectA, 1000, 'in_progress');
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_history', { projectSlug: 'slug-a' }, 'sess_qrh'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs[0]?.endedAt).toBeNull();
    expect(out.runs[0]?.status).toBe('in_progress');
  });
});
