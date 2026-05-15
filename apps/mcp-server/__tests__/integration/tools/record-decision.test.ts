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
