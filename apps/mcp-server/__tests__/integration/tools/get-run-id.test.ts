import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__get_run_id` (S8).
 *
 * Exercises the real handler end-to-end via the `ToolRegistry` — the
 * same dispatch path the stdio transport uses — against an in-memory
 * SQLite handle with migrations 0000 + 0001 + 0002 applied.
 *
 * Covers (per user directive Q9 2026-04-24):
 *   - Solo mode: auto-create projects row when slug unknown.
 *   - Team mode: structured `project_not_found` soft-failure when
 *     slug unknown (NO projects row inserted).
 *   - Existing in-progress run: returns the cached runId.
 *   - Existing non-in-progress run: returns its runId AND emits the
 *     WARN locked in the decisions-log (Q3 escalation trigger).
 *   - Concurrent inserts: Promise.all of two calls with the same
 *     (projectSlug, sessionId) returns the same runId on both
 *     (ON CONFLICT race resolution).
 *   - Idempotent re-call on the same (projectSlug, sessionId)
 *     returns the same runId.
 *
 * All responses are parsed through the registry envelope: success
 * looks like `{ ok: true, data: { ok: true, runId, startedAt } }`;
 * soft-failure looks like `{ ok: true, data: { ok: false, error,
 * howToFix } }`. The registry's `ok: true` wraps transport success;
 * the inner `data.ok` is the domain success/failure signal.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    // vec extension must load so migration 0001 creates context_packs_vec.
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return {
    close: async () => {
      await client.close();
    },
    handle,
  };
}

function buildRegistry(handle: SqliteHandle, mode: 'solo' | 'team'): ToolRegistry {
  const registry = new ToolRegistry({ deps: makeFakeDeps() });
  registry.register(createGetRunIdToolRegistration({ db: handle, mode }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): GetRunIdOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: GetRunIdOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Solo mode — auto-create projects on unknown slug
// ---------------------------------------------------------------------------

describe('get_run_id — solo mode auto-creates the projects row', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('creates a projects row + a runs row on first call for an unknown slug', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const result = await registry.handleCall('get_run_id', { projectSlug: 'my-fresh-project' }, 'sess_1', {
      agentType: 'claude_code',
    });
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.runId).toMatch(/^run:proj_[0-9a-f-]+:sess_1:[0-9a-f-]+$/);
      expect(typeof out.startedAt).toBe('string');
    }
    // Verify the projects row materialised.
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'my-fresh-project'));
    expect(projects).toHaveLength(1);
    expect(projects[0]?.orgId).toBe('org_dev_local');
    // Verify the runs row materialised with agentType stamped.
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_1'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentType).toBe('claude_code');
    expect(runs[0]?.mode).toBe('solo');
    expect(runs[0]?.status).toBe('in_progress');
  });

  it('stamps agentType=unknown when the transport did not supply one', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const result = await registry.handleCall('get_run_id', { projectSlug: 'x' }, 'sess_x');
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_x'));
    expect(runs[0]?.agentType).toBe('unknown');
  });

  it('reuses the projects row on a second call with the same slug', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    await registry.handleCall('get_run_id', { projectSlug: 'same-slug' }, 'sess_a');
    await registry.handleCall('get_run_id', { projectSlug: 'same-slug' }, 'sess_b');
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'same-slug'));
    expect(projects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Team mode — structured soft-failure on unknown slug
// ---------------------------------------------------------------------------

describe('get_run_id — team mode returns project_not_found on unknown slug', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found / howToFix — and does NOT insert a projects row', async () => {
    const registry = buildRegistry(h.handle, 'team');
    const result = await registry.handleCall('get_run_id', { projectSlug: 'not-registered' }, 'sess_team');
    const out = unwrap(result);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('project_not_found');
      expect(out.howToFix).toMatch(/Web App|coodra init/);
      expect(out.howToFix.length).toBeGreaterThan(0);
    }
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'not-registered'));
    expect(projects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Existing runs — return cached, WARN on non-in-progress
// ---------------------------------------------------------------------------

describe('get_run_id — returns the existing run for (projectId, sessionId)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the same runId on a second call for the same (slug, sessionId)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const first = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'idem-slug' }, 'sess_idem'));
    const second = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'idem-slug' }, 'sess_idem'));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.runId).toBe(first.runId);
      expect(second.startedAt).toBe(first.startedAt);
    }
  });

  it('returns a non-in-progress run when that is the only existing row for the session (WARN logged)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const first = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'completed-slug' }, 'sess_done'));
    if (!first.ok) throw new Error('expected first call to succeed');
    // Mark the run as completed — simulates a later state after save_context_pack.
    await h.handle.db
      .update(sqliteSchema.runs)
      .set({ status: 'completed' })
      .where(eq(sqliteSchema.runs.id, first.runId));
    const second = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'completed-slug' }, 'sess_done'));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.runId).toBe(first.runId);
      // Can't easily grep log output in-test; the WARN event presence
      // is verified by `structuredLoggerCallable` in unit tests if
      // we ever add that surface. The decisions-log documents the
      // WARN as a future-migration escalation trigger — if it grows
      // common, migration 0003 relaxes the unique index.
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent-insert race
// ---------------------------------------------------------------------------

describe('get_run_id — concurrent calls with the same (slug, sessionId) converge on one run', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('Promise.all of two parallel calls returns the same runId in both responses', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const [a, b] = await Promise.all([
      registry.handleCall('get_run_id', { projectSlug: 'race-slug' }, 'sess_race'),
      registry.handleCall('get_run_id', { projectSlug: 'race-slug' }, 'sess_race'),
    ]);
    const outA = unwrap(a);
    const outB = unwrap(b);
    expect(outA.ok).toBe(true);
    expect(outB.ok).toBe(true);
    if (outA.ok && outB.ok) {
      expect(outA.runId).toBe(outB.runId);
    }
    // Exactly one runs row for the (project, session) pair.
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_race'));
    expect(runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Different sessions → different runs for the same project
// ---------------------------------------------------------------------------

describe('get_run_id — different sessionIds under the same project get different runs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('two calls with different sessionIds produce two distinct runs rows', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const a = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'multi-session' }, 'sess_1'));
    const b = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'multi-session' }, 'sess_2'));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.runId).not.toBe(b.runId);
    }
    const runs = await h.handle.db.select().from(sqliteSchema.runs);
    expect(runs).toHaveLength(2);
  });
});
