import { createHash } from 'node:crypto';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createRecordDecisionToolRegistration } from '../../../src/tools/record-decision/manifest.js';
import type { RecordDecisionOutput } from '../../../src/tools/record-decision/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__record_decision` (S13).
 *
 * Exercises the real handler end-to-end via the `ToolRegistry`
 * against an in-memory SQLite DB migrated to 0003 and seeded with a
 * projects row + a runs row. No FS materialisation (decisions are
 * DB-only), no `ContextPackStore` wiring.
 *
 * What this test guards:
 *   - Happy path insert — DB row with expected columns + JSON
 *     alternatives + idempotency key = `dec:{runId}:{sha256(description)}`
 *   - Multi-decision-per-run — successive calls with different
 *     descriptions persist as distinct rows (unlike save_context_pack
 *     which is idempotent-per-runId)
 *   - Idempotency dedupe — same description + different rationale
 *     returns the first row's decisionId with created:false,
 *     rationale is NOT updated
 *   - run_not_found soft-failure — no decisions row inserted
 *   - ON DELETE SET NULL — decisions survive a runs-row delete,
 *     matching the S7c run_events widening pattern
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly projectId: string;
  readonly runId: string;
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

  const projectId = 'proj_rd';
  const runId = 'run_rd_primary';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, 'slug-rd', 'org_test', 'rd harness');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, projectId, 'sess_rd', 'claude_code', 'solo', 'in_progress');

  const deps = makeFakeDeps();

  return {
    close: async () => {
      await client.close();
    },
    handle,
    projectId,
    runId,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createRecordDecisionToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): RecordDecisionOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: RecordDecisionOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Happy path — DB row shape + idempotency key + alternatives JSON
// ---------------------------------------------------------------------------

describe('record_decision — happy path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('inserts a decisions row with idempotency key + JSON alternatives + created=true', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        {
          runId: h.runId,
          description: 'pick cockatiel over opossum for retries',
          rationale: 'cockatiel offers typed circuit breakers + jitter',
          alternatives: ['opossum', 'hand-rolled fetch with AbortController'],
        },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisionId).toMatch(/^dec_/);
    expect(out.created).toBe(true);
    expect(typeof out.createdAt).toBe('string');

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.id, out.decisionId));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('row missing after length-1 assertion');

    const expectedHash = createHash('sha256')
      .update('pick cockatiel over opossum for retries')
      .digest('hex')
      .slice(0, 32);
    expect(row.idempotencyKey).toBe(`dec:${h.runId}:${expectedHash}`);
    expect(row.runId).toBe(h.runId);
    expect(row.description).toBe('pick cockatiel over opossum for retries');
    expect(row.rationale).toBe('cockatiel offers typed circuit breakers + jitter');
    expect(JSON.parse(row.alternatives ?? 'null')).toEqual(['opossum', 'hand-rolled fetch with AbortController']);
  });

  it('stores NULL for alternatives when the field is omitted', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'skip that library', rationale: 'out of scope for M02' },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.id, out.decisionId));
    expect(rows[0]?.alternatives).toBeNull();
  });

  it('stores NULL for alternatives when an empty array is supplied', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'empty alts', rationale: 'why', alternatives: [] },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.id, out.decisionId));
    expect(rows[0]?.alternatives).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-decision-per-run — distinct descriptions persist as distinct rows
// ---------------------------------------------------------------------------

describe('record_decision — multi-decision-per-run', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('two calls with different descriptions on the same runId create two distinct rows', async () => {
    const registry = buildRegistry(h);
    const a = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'decision A', rationale: 'r1' },
        'sess_rd',
      ),
    );
    const b = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'decision B', rationale: 'r2' },
        'sess_rd',
      ),
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.decisionId).not.toBe(b.decisionId);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);

    const allForRun = await h.handle.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.runId, h.runId))
      .orderBy(asc(sqliteSchema.decisions.createdAt));
    expect(allForRun).toHaveLength(2);
    const descriptions = allForRun.map((r) => r.description);
    expect(descriptions).toContain('decision A');
    expect(descriptions).toContain('decision B');
  });
});

// ---------------------------------------------------------------------------
// Idempotency dedupe — same description collides, rationale is NOT updated
// ---------------------------------------------------------------------------

describe('record_decision — idempotency dedupe', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('second call with identical description returns the first decisionId with created:false; rationale is NOT updated', async () => {
    const registry = buildRegistry(h);
    const first = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'same body', rationale: 'original rationale' },
        'sess_rd',
      ),
    );
    const second = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'same body', rationale: 'NEW rationale that should be ignored' },
        'sess_rd',
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.id, first.decisionId));
    // Only ONE row exists, and its rationale is the FIRST write — dedupe.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rationale).toBe('original rationale');
  });
});

// ---------------------------------------------------------------------------
// run_not_found soft-failure
// ---------------------------------------------------------------------------

describe('record_decision — run_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:run_not_found / howToFix when the runId is not in runs; does NOT insert a decisions row', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: 'run_nonexistent', description: 'd', rationale: 'r' },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('run_not_found');
    expect(out.howToFix).toMatch(/get_run_id/);

    const rows = await h.handle.db.select().from(sqliteSchema.decisions);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ON DELETE SET NULL — decisions survive the originating run's deletion
// ---------------------------------------------------------------------------

describe('record_decision — run_id ON DELETE SET NULL preserves history', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('deleting the originating runs row nulls the decision.run_id but keeps the row', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'persists past run deletion', rationale: 'permanent history' },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Delete the originating run.
    h.handle.raw.prepare('DELETE FROM runs WHERE id = ?').run(h.runId);

    // The decision row survives, but its run_id is now null.
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.id, out.decisionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBeNull();
    expect(rows[0]?.description).toBe('persists past run deletion');
  });
});

// ---------------------------------------------------------------------------
// coodra-work redesign round 2 — work_pack_decision_links (many-to-many)
// ---------------------------------------------------------------------------

function seedWorkPack(h: Harness, id: string, slug: string): void {
  h.handle.raw
    .prepare('INSERT INTO work_packs (id, project_id, slug, title) VALUES (?, ?, ?, ?)')
    .run(id, h.projectId, slug, `pack ${slug}`);
}

describe('record_decision — work_pack_decision_links', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("auto-links to the run's current Work Pack (runs.work_pack_id) with no workPackSlugs passed", async () => {
    seedWorkPack(h, 'wp_1', 'pack-1');
    h.handle.raw.prepare('UPDATE runs SET work_pack_id = ? WHERE id = ?').run('wp_1', h.runId);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'auto-link decision', rationale: 'r' },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackDecisionLinks)
      .where(eq(sqliteSchema.workPackDecisionLinks.decisionId, out.decisionId));
    expect(links.map((l) => l.workPackId)).toEqual(['wp_1']);
  });

  it("workPackSlugs additively links to a second, related pack alongside the run's own pack", async () => {
    seedWorkPack(h, 'wp_1', 'pack-1');
    seedWorkPack(h, 'wp_2', 'pack-2');
    h.handle.raw.prepare('UPDATE runs SET work_pack_id = ? WHERE id = ?').run('wp_1', h.runId);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'cross-pack decision', rationale: 'r', workPackSlugs: ['pack-2'] },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackDecisionLinks)
      .where(eq(sqliteSchema.workPackDecisionLinks.decisionId, out.decisionId));
    expect(links.map((l) => l.workPackId).sort()).toEqual(['wp_1', 'wp_2']);
  });

  it('skips (does not error) an unresolvable workPackSlugs entry', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'dangling slug', rationale: 'r', workPackSlugs: ['does-not-exist'] },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackDecisionLinks)
      .where(eq(sqliteSchema.workPackDecisionLinks.decisionId, out.decisionId));
    expect(links).toHaveLength(0);
  });

  it('re-recording an idempotent-hit decision with a new workPackSlugs entry adds the new link', async () => {
    seedWorkPack(h, 'wp_1', 'pack-1');
    const registry = buildRegistry(h);
    const first = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'same decision twice', rationale: 'r' },
        'sess_rd',
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'same decision twice', rationale: 'ignored', workPackSlugs: ['pack-1'] },
        'sess_rd',
      ),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.created).toBe(false);

    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackDecisionLinks)
      .where(eq(sqliteSchema.workPackDecisionLinks.decisionId, first.decisionId));
    expect(links.map((l) => l.workPackId)).toEqual(['wp_1']);
  });
});

// ---------------------------------------------------------------------------
// COOD-58 — decision_edges
// ---------------------------------------------------------------------------

describe('record_decision — COOD-58 decision_edges', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes supersedes + affects edges idempotently', async () => {
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_old', h.projectId, 'idem_old', h.runId, 'old retry policy', 'legacy', 1000);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'record_decision',
        {
          runId: h.runId,
          description: 'replace retry policy',
          rationale: 'new policy is safer',
          impact: ['apps/mcp-server/src/tools/record-decision/handler.ts', 'graph_node:recordDecision'],
          supersedesDecisionIds: ['dec_old'],
        },
        'sess_rd',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const retry = unwrap(
      await registry.handleCall(
        'record_decision',
        {
          runId: h.runId,
          description: 'replace retry policy',
          rationale: 'retry should be idempotent',
          impact: ['apps/mcp-server/src/tools/record-decision/handler.ts', 'graph_node:recordDecision'],
          supersedesDecisionIds: ['dec_old'],
        },
        'sess_rd',
      ),
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.decisionId).toBe(out.decisionId);

    const edges = await h.handle.db
      .select()
      .from(sqliteSchema.decisionEdges)
      .where(eq(sqliteSchema.decisionEdges.fromDecisionId, out.decisionId));
    expect(edges.map((e) => `${e.edgeType}:${e.targetType}:${e.targetId}`).sort()).toEqual([
      'affects:file:apps/mcp-server/src/tools/record-decision/handler.ts',
      'affects:graph_node:recordDecision',
      'supersedes:decision:dec_old',
    ]);
  });

  it('rejects supersession cycles on idempotent follow-up calls', async () => {
    const registry = buildRegistry(h);
    const first = unwrap(
      await registry.handleCall(
        'record_decision',
        {
          runId: h.runId,
          description: 'new authority',
          rationale: 'newer',
        },
        'sess_rd',
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_old_cycle', h.projectId, 'idem_old_cycle', h.runId, 'old authority', 'older', 1000);
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_cycle_seed', h.projectId, 'dec_old_cycle', 'supersedes', 'decision', first.decisionId);

    const cycle = unwrap(
      await registry.handleCall(
        'record_decision',
        {
          runId: h.runId,
          description: 'new authority',
          rationale: 'same idempotency key',
          supersedesDecisionIds: ['dec_old_cycle'],
        },
        'sess_rd',
      ),
    );
    expect(cycle).toMatchObject({ ok: false, error: 'supersession_cycle', decisionId: 'dec_old_cycle' });
  });
});

// ---------------------------------------------------------------------------
// COOD-96 — repairing links on a retry
// ---------------------------------------------------------------------------

/**
 * The decision ROW is idempotent on (runId, description); its LINKS are
 * not. That asymmetry is deliberate — it is what lets a supersession
 * edge be attached to an already-recorded decision without minting a
 * duplicate decision to carry it — but two things made it unusable in
 * practice, and both are locked here.
 */
describe('record_decision — COOD-96 retry repairs links', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('attaches a supersedes edge on retry without creating a second decision', async () => {
    const registry = buildRegistry(h);
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_prior', h.projectId, 'idem_prior', h.runId, 'the older ruling', 'older', 1000);

    // First call: the agent forgets to declare the supersession.
    const first = unwrap(
      await registry.handleCall(
        'record_decision',
        { runId: h.runId, description: 'the newer ruling', rationale: 'replaces the older one' },
        'sess_rd',
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Retry with the same description, now declaring it.
    const retry = unwrap(
      await registry.handleCall(
        'record_decision',
        {
          runId: h.runId,
          description: 'the newer ruling',
          rationale: 'replaces the older one',
          supersedesDecisionIds: ['dec_prior'],
        },
        'sess_rd',
      ),
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.created, 'the retry must not mint a duplicate decision').toBe(false);
    expect(retry.decisionId).toBe(first.decisionId);

    const rows = h.handle.raw
      .prepare(
        `SELECT from_decision_id FROM decision_edges
         WHERE edge_type = 'supersedes' AND target_type = 'decision' AND target_id = 'dec_prior'`,
      )
      .all() as Array<{ from_decision_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from_decision_id).toBe(first.decisionId);

    const count = h.handle.raw
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE description = 'the newer ruling'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('still returns overlap candidates on an idempotent hit, then goes quiet once handled', async () => {
    // Returning candidates only on the FIRST call meant an agent that
    // ignored the hint got no second chance — the retry, which is the
    // natural moment to declare the edge, came back empty and read as
    // confirmation that nothing overlapped.
    const registry = buildRegistry(h);
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_overlap', h.projectId, 'idem_overlap', h.runId, 'manifest ships behind a flag', 'flagged', 1000);

    const args = {
      runId: h.runId,
      description: 'manifest ships behind a flag no longer — it is the default',
      rationale: 'flagged mode replaced by default',
    };

    const first = unwrap(await registry.handleCall('record_decision', args, 'sess_rd'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.relatedDecisionCandidates.map((c) => c.decisionId)).toContain('dec_overlap');

    const retry = unwrap(await registry.handleCall('record_decision', args, 'sess_rd'));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.created).toBe(false);
    expect(
      retry.relatedDecisionCandidates.map((c) => c.decisionId),
      'the reminder must survive the retry',
    ).toContain('dec_overlap');

    // Declare the edge, and the candidate drops out — the list excludes
    // decisions that already have an incoming supersedes edge, so a
    // handled overlap stops nagging without any extra suppression.
    const declared = unwrap(
      await registry.handleCall('record_decision', { ...args, supersedesDecisionIds: ['dec_overlap'] }, 'sess_rd'),
    );
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.relatedDecisionCandidates.map((c) => c.decisionId)).not.toContain('dec_overlap');
  });

  it('merges impact on retry so the column cannot disagree with its own edges', async () => {
    const registry = buildRegistry(h);
    const args = {
      runId: h.runId,
      description: 'a decision that grows its impact',
      rationale: 'first pass named one file',
    };

    const first = unwrap(
      await registry.handleCall('record_decision', { ...args, impact: ['packages/db/src/a.ts'] }, 'sess_rd'),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const retry = unwrap(
      await registry.handleCall(
        'record_decision',
        { ...args, impact: ['packages/db/src/a.ts', 'packages/db/src/b.ts'] },
        'sess_rd',
      ),
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.created).toBe(false);

    const edgeTargets = (
      h.handle.raw
        .prepare(
          `SELECT target_id FROM decision_edges
           WHERE from_decision_id = ? AND edge_type = 'affects' AND target_type = 'file'`,
        )
        .all(first.decisionId) as Array<{ target_id: string }>
    ).map((r) => r.target_id);
    expect(edgeTargets).toContain('packages/db/src/a.ts');
    expect(edgeTargets).toContain('packages/db/src/b.ts');

    const row = h.handle.raw.prepare(`SELECT impact FROM decisions WHERE id = ?`).get(first.decisionId) as {
      impact: string | null;
    };
    const stored = JSON.parse(row.impact ?? '[]') as string[];
    // The column is what read_context_pack and the run admin views
    // display; a frozen column beside a grown edge set is a row
    // disagreeing with itself.
    expect(stored).toEqual(['packages/db/src/a.ts', 'packages/db/src/b.ts']);
  });

  it('unions rather than replaces, so a narrower retry cannot orphan earlier edges', async () => {
    // Nothing here deletes edges. If a retry replaced the column, the
    // `affects` edges from the dropped entries would survive with no
    // trace in the row that produced them.
    const registry = buildRegistry(h);
    const args = { runId: h.runId, description: 'impact narrows on retry', rationale: 'why' };

    const first = unwrap(
      await registry.handleCall(
        'record_decision',
        { ...args, impact: ['packages/db/src/a.ts', 'packages/db/src/b.ts'] },
        'sess_rd',
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await registry.handleCall('record_decision', { ...args, impact: ['packages/db/src/a.ts'] }, 'sess_rd');

    const row = h.handle.raw.prepare(`SELECT impact FROM decisions WHERE id = ?`).get(first.decisionId) as {
      impact: string | null;
    };
    expect(JSON.parse(row.impact ?? '[]')).toEqual(['packages/db/src/a.ts', 'packages/db/src/b.ts']);
  });
});
