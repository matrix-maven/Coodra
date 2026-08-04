import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createQueryDecisionsToolRegistration } from '../../../src/tools/query-decisions/manifest.js';
import type { QueryDecisionsOutput } from '../../../src/tools/query-decisions/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__query_decisions` (Slice 4 — 2026-05-03 audit).
 *
 * Real SQLite migrated. Two projects + two runs per project so we can
 * exercise both project scoping AND runId-narrow filtering. Decisions
 * are seeded with explicit `created_at` so DESC ordering is deterministic.
 *
 * Closes the audit's §3.5 gap: pre-Slice-4 nothing in the 9-tool surface
 * read the `decisions` table back. After Slice 4, a new session can call
 * `query_decisions` and see prior session decisions.
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

  const projectA = 'proj_qd_a';
  const projectB = 'proj_qd_b';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectA, 'slug-a', 'org_test', 'project A');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectB, 'slug-b', 'org_test', 'project B');

  const contextPacksRoot = mkdtempSync(join(tmpdir(), 'qd-'));
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
  registry.register(createQueryDecisionsToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): QueryDecisionsOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: QueryDecisionsOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

function seedRun(h: Harness, id: string, projectId: string, opts?: { workPackId?: string; issueRef?: string }): void {
  h.handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at, work_pack_id, issue_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      `sess_${id}`,
      'claude_code',
      'solo',
      'in_progress',
      1000,
      opts?.workPackId ?? null,
      opts?.issueRef ?? null,
    );
}

function seedDecision(
  h: Harness,
  id: string,
  runId: string | null,
  description: string,
  rationale: string,
  alternatives: ReadonlyArray<string> | null,
  createdAtSec: number,
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO decisions (id, idempotency_key, run_id, description, rationale, alternatives, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `idem_${id}`,
      runId,
      description,
      rationale,
      alternatives === null ? null : JSON.stringify(alternatives),
      createdAtSec,
    );
}

// ---------------------------------------------------------------------------
// project_not_found soft-failure
// ---------------------------------------------------------------------------

describe('query_decisions — project_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found / howToFix when the slug is not registered', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'nonexistent' }, 'sess_qd'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_found');
    expect(out.howToFix).toMatch(/coodra init|projects table/);
  });
});

// ---------------------------------------------------------------------------
// Empty is success-with-empty, NOT soft-failure
// ---------------------------------------------------------------------------

describe('query_decisions — empty result is ok:true decisions:[]', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('registered project with zero decisions returns ok:true with empty array', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DESC order by createdAt
// ---------------------------------------------------------------------------

describe('query_decisions — DESC order by createdAt', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('most recent first', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_old', 'run_x', 'pick foo', 'because A', null, 1000);
    seedDecision(h, 'dec_mid', 'run_x', 'pick bar', 'because B', null, 2000);
    seedDecision(h, 'dec_new', 'run_x', 'pick baz', 'because C', null, 3000);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_new', 'dec_mid', 'dec_old']);
  });
});

// ---------------------------------------------------------------------------
// query LIKE filter — description
// ---------------------------------------------------------------------------

describe('query_decisions — query LIKE filter on description', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('matches a substring of description', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_storage', 'run_x', 'JSON file storage with atomic-rename', 'simpler than SQLite', null, 1000);
    seedDecision(h, 'dec_auth', 'run_x', 'use Clerk for auth', 'first-class Next.js support', null, 2000);
    seedDecision(h, 'dec_test', 'run_x', 'Vitest over Jest', 'native ESM + TS', null, 3000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', query: 'storage' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_storage']);
  });
});

// ---------------------------------------------------------------------------
// query LIKE filter — rationale
// ---------------------------------------------------------------------------

describe('query_decisions — query LIKE filter on rationale', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('matches a substring of rationale (when description does not contain it)', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_a', 'run_x', 'pick foo', 'cockatiel handles retries with circuit breaker', null, 1000);
    seedDecision(h, 'dec_b', 'run_x', 'pick bar', 'simpler than alternatives', null, 2000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', query: 'cockatiel' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_a']);
  });
});

// ---------------------------------------------------------------------------
// runId narrow filter
// ---------------------------------------------------------------------------

describe('query_decisions — runId narrow filter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns only decisions for the supplied runId', async () => {
    seedRun(h, 'run_one', h.projectA);
    seedRun(h, 'run_two', h.projectA);
    seedDecision(h, 'dec_1', 'run_one', 'd1', 'r1', null, 1000);
    seedDecision(h, 'dec_2', 'run_one', 'd2', 'r2', null, 2000);
    seedDecision(h, 'dec_3', 'run_two', 'd3', 'r3', null, 3000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', runId: 'run_one' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_2', 'dec_1']);
  });

  it('combining runId + query filters both', async () => {
    seedRun(h, 'run_one', h.projectA);
    seedDecision(h, 'dec_storage', 'run_one', 'storage layout', 'r', null, 1000);
    seedDecision(h, 'dec_auth', 'run_one', 'auth provider', 'r', null, 2000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'query_decisions',
        { projectSlug: 'slug-a', runId: 'run_one', query: 'storage' },
        'sess_qd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_storage']);
  });
});

// ---------------------------------------------------------------------------
// limit parameter
// ---------------------------------------------------------------------------

describe('query_decisions — limit parameter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('honours the supplied limit; default is 10', async () => {
    seedRun(h, 'run_x', h.projectA);
    for (let i = 0; i < 15; i += 1) {
      seedDecision(h, `dec_${String(i).padStart(2, '0')}`, 'run_x', `desc${i}`, `rat${i}`, null, 1000 + i);
    }

    const registry = buildRegistry(h);
    const defaulted = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.decisions).toHaveLength(10);
    expect(defaulted.decisions[0]?.id).toBe('dec_14');

    const capped = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a', limit: 3 }, 'sess_qd'));
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.decisions.map((d) => d.id)).toEqual(['dec_14', 'dec_13', 'dec_12']);
  });
});

// ---------------------------------------------------------------------------
// Cross-project scoping
// ---------------------------------------------------------------------------

describe('query_decisions — scopes to project (no cross-project leak)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns only decisions for the requested project; other project untouched', async () => {
    seedRun(h, 'run_a', h.projectA);
    seedRun(h, 'run_b', h.projectB);
    seedDecision(h, 'dec_a1', 'run_a', 'a1', 'r', null, 1000);
    seedDecision(h, 'dec_b1', 'run_b', 'b1', 'r', null, 2000);
    seedDecision(h, 'dec_b2', 'run_b', 'b2', 'r', null, 3000);

    const registry = buildRegistry(h);
    const outA = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(outA.ok).toBe(true);
    if (!outA.ok) return;
    expect(outA.decisions.map((d) => d.id)).toEqual(['dec_a1']);

    const outB = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-b' }, 'sess_qd'));
    expect(outB.ok).toBe(true);
    if (!outB.ok) return;
    expect(outB.decisions.map((d) => d.id)).toEqual(['dec_b2', 'dec_b1']);
  });
});

// ---------------------------------------------------------------------------
// workPackId filter — spans every run tied to a Work Pack
// ---------------------------------------------------------------------------

describe('query_decisions — workPackId filter spans multiple runs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns decisions from every run tied to the same workPackId, excludes other packs and unlinked runs', async () => {
    seedRun(h, 'run_session_1', h.projectA, { workPackId: 'wp_1' });
    seedRun(h, 'run_session_2', h.projectA, { workPackId: 'wp_1' });
    seedRun(h, 'run_other_pack', h.projectA, { workPackId: 'wp_2' });
    seedRun(h, 'run_unlinked', h.projectA);
    seedDecision(h, 'dec_s1', 'run_session_1', 'first session decision', 'r', null, 1000);
    seedDecision(h, 'dec_s2', 'run_session_2', 'second session decision', 'r', null, 2000);
    seedDecision(h, 'dec_other', 'run_other_pack', 'other pack decision', 'r', null, 3000);
    seedDecision(h, 'dec_unlinked', 'run_unlinked', 'unlinked decision', 'r', null, 4000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', workPackId: 'wp_1' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_s2', 'dec_s1']);
  });
});

// ---------------------------------------------------------------------------
// issueRef filter
// ---------------------------------------------------------------------------

describe('query_decisions — issueRef filter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns only decisions whose run is bound to the given issueRef, case-insensitively', async () => {
    seedRun(h, 'run_bound', h.projectA, { issueRef: 'PROJ-412' });
    seedRun(h, 'run_other', h.projectA, { issueRef: 'PROJ-999' });
    seedDecision(h, 'dec_bound', 'run_bound', 'bound decision', 'r', null, 1000);
    seedDecision(h, 'dec_other', 'run_other', 'other decision', 'r', null, 2000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', issueRef: 'proj-412' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_bound']);
  });
});

// ---------------------------------------------------------------------------
// alternatives JSON parse
// ---------------------------------------------------------------------------

describe('query_decisions — alternatives field', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('parses JSON-encoded string[] back into an array', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_alts', 'run_x', 'd', 'r', ['option A', 'option B', 'option C'], 1000);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions[0]?.alternatives).toEqual(['option A', 'option B', 'option C']);
  });

  it('returns [] when alternatives column is NULL', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_no_alt', 'run_x', 'd', 'r', null, 1000);
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions[0]?.alternatives).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orphan decisions (run_id NULL after run deletion) are excluded
// ---------------------------------------------------------------------------

describe('query_decisions — orphan decisions (run_id NULL) are not returned', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('innerJoin excludes decisions with NULL run_id', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_normal', 'run_x', 'd', 'r', null, 1000);
    seedDecision(h, 'dec_orphan', null, 'd', 'r', null, 2000);

    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_normal']);
  });
});

// ---------------------------------------------------------------------------
// ISO timestamp passthrough
// ---------------------------------------------------------------------------

describe('query_decisions — ISO timestamp', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('serializes createdAt as ISO 8601', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_iso', 'run_x', 'd', 'r', null, 1700000000);
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_decisions', { projectSlug: 'slug-a' }, 'sess_qd'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions[0]?.createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// coodra-work redesign round 2 — work_pack_decision_links + includeRelated
// ---------------------------------------------------------------------------

function seedWorkPack(h: Harness, id: string, projectId: string, slug: string): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_packs
        (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, slug, `pack ${slug}`, 'task', 'draft', '', '', '', '{}');
}

function seedDecisionWorkPackLink(h: Harness, id: string, workPackId: string, decisionId: string): void {
  h.handle.raw
    .prepare('INSERT INTO work_pack_decision_links (id, work_pack_id, decision_id) VALUES (?, ?, ?)')
    .run(id, workPackId, decisionId);
}

function seedWorkPackRelationship(
  h: Harness,
  id: string,
  projectId: string,
  sourceWorkPackId: string,
  targetWorkPackId: string,
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_pack_relationships
        (id, project_id, source_work_pack_id, target_work_pack_id, target_external_key, relationship_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, sourceWorkPackId, targetWorkPackId, 'placeholder', 'relates_to');
}

describe('query_decisions — workPackId matches the direct work_pack_decision_links tag too', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns a decision tagged via work_pack_decision_links even when its run.work_pack_id points elsewhere', async () => {
    seedWorkPack(h, 'wp_1', h.projectA, 'pack-1');
    seedWorkPack(h, 'wp_2', h.projectA, 'pack-2');
    // run bound to pack-2, but the decision is explicitly tagged to pack-1 too.
    h.handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at, work_pack_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('run_tagged', h.projectA, 'sess_run_tagged', 'claude_code', 'solo', 'in_progress', 1000, 'wp_2');
    seedDecision(h, 'dec_tagged', 'run_tagged', 'cross-tagged decision', 'r', null, 1000);
    seedDecisionWorkPackLink(h, 'link_1', 'wp_1', 'dec_tagged');

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', workPackId: 'wp_1' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_tagged']);
  });
});

// ---------------------------------------------------------------------------
// BM25 full-text search (2026-08-03) — real ranking, not just substring match
// ---------------------------------------------------------------------------

describe('query_decisions — BM25 ranking', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('ranks the decision with denser term matches first, overriding recency order', async () => {
    seedRun(h, 'run_x', h.projectA);
    // Older but denser match should outrank the newer, thinner match —
    // proves this is relevance-ranked, not still createdAt DESC.
    seedDecision(h, 'dec_strong', 'run_x', 'retry retry retry policy', 'retry retry logic everywhere', null, 1000);
    seedDecision(h, 'dec_weak', 'run_x', 'pick bar', 'mentions retry once in passing', null, 2000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', query: 'retry' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_strong', 'dec_weak']);
  });

  it('requires every word in a multi-word query to appear (implicit AND)', async () => {
    seedRun(h, 'run_x', h.projectA);
    seedDecision(h, 'dec_both', 'run_x', 'storage layout', 'atomic-rename storage with cockatiel retries', null, 1000);
    seedDecision(h, 'dec_one', 'run_x', 'storage layout', 'atomic-rename storage, no retry library', null, 2000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', query: 'storage cockatiel' }, 'sess_qd'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions.map((d) => d.id)).toEqual(['dec_both']);
  });
});

describe('query_decisions — includeRelated pulls decisions from related packs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('surfaces a decision recorded on a related pack when includeRelated is true', async () => {
    seedWorkPack(h, 'wp_1', h.projectA, 'pack-1');
    seedWorkPack(h, 'wp_2', h.projectA, 'pack-2');
    seedWorkPackRelationship(h, 'rel_1', h.projectA, 'wp_1', 'wp_2');
    seedRun(h, 'run_pack1', h.projectA, { workPackId: 'wp_1' });
    seedDecision(h, 'dec_pack1', 'run_pack1', 'remove UserPromptSubmit Jira phrase detection', 'r', null, 1000);

    const registry = buildRegistry(h);

    const withoutRelated = unwrap(
      await registry.handleCall('query_decisions', { projectSlug: 'slug-a', workPackId: 'wp_2' }, 'sess_qd'),
    );
    expect(withoutRelated.ok).toBe(true);
    if (withoutRelated.ok) expect(withoutRelated.decisions).toEqual([]);

    const withRelated = unwrap(
      await registry.handleCall(
        'query_decisions',
        { projectSlug: 'slug-a', workPackId: 'wp_2', includeRelated: true },
        'sess_qd',
      ),
    );
    expect(withRelated.ok).toBe(true);
    if (!withRelated.ok) return;
    expect(withRelated.decisions.map((d) => d.id)).toEqual(['dec_pack1']);
  });

  it('does not pull decisions from unrelated packs even with includeRelated true', async () => {
    seedWorkPack(h, 'wp_1', h.projectA, 'pack-1');
    seedWorkPack(h, 'wp_2', h.projectA, 'pack-2');
    seedWorkPack(h, 'wp_3', h.projectA, 'pack-3');
    // pack-1 and pack-2 are related; pack-3 is not related to either.
    seedWorkPackRelationship(h, 'rel_1', h.projectA, 'wp_1', 'wp_2');
    seedRun(h, 'run_pack3', h.projectA, { workPackId: 'wp_3' });
    seedDecision(h, 'dec_pack3', 'run_pack3', 'unrelated decision', 'r', null, 1000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'query_decisions',
        { projectSlug: 'slug-a', workPackId: 'wp_1', includeRelated: true },
        'sess_qd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions).toEqual([]);
  });
});
