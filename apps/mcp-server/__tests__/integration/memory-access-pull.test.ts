import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDefaultPolicy, migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextDeps } from '../../src/framework/tool-context.js';
import { ToolRegistry } from '../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../src/lib/context-pack.js';
import { createDbClient } from '../../src/lib/db.js';
import { createMemoryAccessRecorder } from '../../src/lib/memory-access-recorder.js';
import { createPolicyClient } from '../../src/lib/policy.js';
import { registerAllTools } from '../../src/tools/index.js';
import { makeFakeDeps } from '../helpers/fake-deps.js';
import { drainOutbox } from './_helpers/drain-outbox.js';

/**
 * COOD-80 — pull-side memory utilization.
 *
 * The highest-risk story in COOD-77, because the obvious
 * implementation breaks retrieval. `query_decisions.runId` is
 * documented as "Optional narrower filter to a single run"; if
 * telemetry reached for it as an attribution field — or if agents were
 * told to start passing it so telemetry could read it — every result
 * set would silently narrow to one run.
 *
 * So the first test here is not about telemetry at all. It asserts that
 * instrumentation changes NOTHING about what `query_decisions` returns.
 * The rest prove the log actually captures what the agent asked for,
 * including the cases that are easy to drop: an unattributed pull and a
 * search that found nothing.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly baseDeps: ContextDeps;
}

const SLUG = 'proj-pull';

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-pull-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug: SLUG }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-pull-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps: ContextDeps = Object.freeze({ ...makeFakeDeps(), contextPack: store });

  await handle.db.insert(sqliteSchema.projects).values({
    id: 'proj-1',
    orgId: 'org-1',
    slug: SLUG,
    name: 'Pull Project',
    cwd,
  });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    baseDeps,
  };
}

function buildRegistry(h: Harness, withTelemetry: boolean): ToolRegistry {
  const deps: ContextDeps = withTelemetry
    ? Object.freeze({ ...h.baseDeps, memoryAccess: createMemoryAccessRecorder({ db: h.handle }) })
    : h.baseDeps;
  const registry = new ToolRegistry({ deps });
  registerAllTools(registry, { db: h.handle, mode: 'solo' });
  return registry;
}

async function seedRunAndDecisions(h: Harness): Promise<void> {
  await h.handle.db.insert(sqliteSchema.runs).values({
    id: 'run-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    agentType: 'claude_code',
    mode: 'solo',
  });
  await h.handle.db.insert(sqliteSchema.runs).values({
    id: 'run-2',
    orgId: 'org-1',
    projectId: 'proj-1',
    sessionId: 'sess-2',
    agentType: 'claude_code',
    mode: 'solo',
  });
  for (const [id, runId, description] of [
    ['dec_a', 'run-1', 'chose sqlite for the local store'],
    ['dec_b', 'run-2', 'chose postgres for the cloud store'],
  ] as const) {
    await h.handle.db.insert(sqliteSchema.decisions).values({
      id,
      orgId: 'org-1',
      projectId: 'proj-1',
      runId,
      idempotencyKey: `idem-${id}`,
      description,
      rationale: 'because',
    });
  }
}

async function callQueryDecisions(registry: ToolRegistry, sessionId: string): Promise<unknown> {
  const result = await registry.handleCall('query_decisions', { projectSlug: SLUG, query: 'store' }, sessionId, {
    agentType: 'claude_code',
  });
  return result.structuredContent;
}

/**
 * `recordPull` is deliberately fire-and-forget in the registry — a
 * pull's result is already on its way to the agent and telemetry must
 * never delay it. Tests therefore have to let the enqueue settle before
 * draining, or they race the very design property they are checking.
 */
async function settleAndDrain(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = await h.handle.db.select().from(sqliteSchema.pendingJobs);
    if (pending.length > 0) break;
  }
  await drainOutbox(h.handle);
}

async function accessRows(h: Harness) {
  return h.handle.db.select().from(sqliteSchema.memoryAccessEvents);
}

describe('COOD-80 — instrumentation must not change retrieval', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
    await seedRunAndDecisions(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('query_decisions returns byte-identical results with and without telemetry', async () => {
    const without = await callQueryDecisions(buildRegistry(h, false), 'sess-1');
    const with_ = await callQueryDecisions(buildRegistry(h, true), 'sess-1');

    // The whole point: attribution is resolved from (projectSlug,
    // sessionId), never from the tool's `runId` filter, so the result
    // set is untouched.
    expect(with_).toEqual(without);

    const decisions = (with_ as { decisions?: unknown[] }).decisions ?? [];
    expect(decisions.length, 'both runs’ decisions still returned').toBe(2);
  });
});

describe('COOD-80 — pull rows', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
    await seedRunAndDecisions(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('records one attributed row per returned decision, in result order', async () => {
    const registry = buildRegistry(h, true);
    await callQueryDecisions(registry, 'sess-1');
    await settleAndDrain(h);

    const rows = (await accessRows(h)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.channel).toBe('pull');
      expect(row.site).toBe('query_decisions');
      expect(row.memoryType).toBe('decision');
      expect(row.triggerType).toBe('tool_call');
      expect(row.projectId).toBe('proj-1');
      expect(row.orgId).toBe('org-1');
      expect(row.agentType).toBe('claude_code');
      // Resolved from the SESSION, not from any tool argument.
      expect(row.runId).toBe('run-1');
      expect(row.resultCount).toBe(2);
    }
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    // Latency belongs to the call, not to each item — charging every
    // row would inflate total_latency_ms N-fold in the daily rollup.
    expect(rows.filter((r) => r.latencyMs !== null)).toHaveLength(1);
  });

  it('writes an unattributed row rather than dropping it, and counts the miss', async () => {
    const recorder = createMemoryAccessRecorder({ db: h.handle });
    const registry = new ToolRegistry({ deps: Object.freeze({ ...h.baseDeps, memoryAccess: recorder }) });
    registerAllTools(registry, { db: h.handle, mode: 'solo' });

    // A session with no `runs` row — the shape an attribution miss takes.
    await callQueryDecisions(registry, 'sess-orphan');
    await settleAndDrain(h);

    const rows = await accessRows(h);
    expect(rows.length, 'the agent still asked; that is evidence').toBeGreaterThan(0);
    expect(rows[0]?.runId).toBeNull();
    expect(rows[0]?.projectId, 'project still resolves even when the run does not').toBe('proj-1');
    expect(recorder.attributionMisses(), 'loss is counted, never silent').toBeGreaterThan(0);
  });

  it('records a zero-result search as one row with a null memory_id', async () => {
    const registry = buildRegistry(h, true);
    await registry.handleCall(
      'query_decisions',
      { projectSlug: SLUG, query: 'zzzz-nothing-matches-this-zzzz' },
      'sess-1',
      { agentType: 'claude_code' },
    );
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.site, 'query_decisions'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memoryId, 'asked and got nothing is the empty-answer signal').toBeNull();
    expect(rows[0]?.resultCount).toBe(0);
  });

  it('does not instrument write tools', async () => {
    const registry = buildRegistry(h, true);
    await registry.handleCall(
      'record_decision',
      {
        runId: 'run:proj-1:sess-1:00000000-0000-0000-0000-000000000000',
        description: 'a write, not a pull',
        rationale: 'because',
      },
      'sess-1',
      { agentType: 'claude_code' },
    );
    await settleAndDrain(h);

    const rows = await accessRows(h);
    expect(rows, 'recording a decision is not retrieving memory').toHaveLength(0);
  });
});

describe('COOD-80 — adapters normalise ids across differently-shaped tools', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
    await seedRunAndDecisions(h);
  });
  afterEach(async () => {
    await h.close();
  });

  /**
   * These schemas were designed independently long before this log
   * existed, so the id field differs per tool (`id` for packs and
   * decisions, `pageId` for wiki pages, `slug` for recipes). The
   * adapters normalise them into one `memory_id` column so pull-through
   * is comparable across surfaces — without touching eight public tool
   * contracts.
   */
  it('search_packs_nl records context_pack ids', async () => {
    const registry = buildRegistry(h, true);
    await registry.handleCall(
      'save_context_pack',
      {
        runId: 'run:proj-1:sess-1:00000000-0000-0000-0000-000000000000',
        title: 'sqlite storage notes',
        content: 'we picked sqlite for the local store',
      },
      'sess-1',
      { agentType: 'claude_code' },
    );
    await registry.handleCall('search_packs_nl', { projectSlug: SLUG, query: 'sqlite' }, 'sess-1', {
      agentType: 'claude_code',
    });
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.site, 'search_packs_nl'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.memoryType).toBe('context_pack');
    expect(rows[0]?.channel).toBe('pull');
  });

  it('list_context_packs records context_pack ids', async () => {
    const registry = buildRegistry(h, true);
    await registry.handleCall('list_context_packs', { projectSlug: SLUG }, 'sess-1', { agentType: 'claude_code' });
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.site, 'list_context_packs'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memoryType).toBe('context_pack');
  });

  it('query_decisions_by_file records decision ids', async () => {
    const registry = buildRegistry(h, true);
    await registry.handleCall('query_decisions_by_file', { projectSlug: SLUG, filePath: 'src/store.ts' }, 'sess-1', {
      agentType: 'claude_code',
    });
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.site, 'query_decisions_by_file'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memoryType).toBe('decision');
  });
});

describe('COOD-88 — just-in-time teaching through permissionDecisionReason', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
    await seedRunAndDecisions(h);
    // dec_a already exists; give it a file target so a denial on that
    // path has something to teach.
    // The harness inserts the project row directly, which bypasses the
    // default-policy seeding that `ensureProject` normally does — so
    // without this there is no `.env` deny rule to teach against.
    await ensureDefaultPolicy(h.handle, 'proj-1');
    await h.handle.db.insert(sqliteSchema.decisionEdges).values({
      id: 'edge-teach',
      projectId: 'proj-1',
      fromDecisionId: 'dec_a',
      edgeType: 'affects',
      targetType: 'file',
      targetId: '.env',
    });
  });
  afterEach(async () => {
    await h.close();
  });

  async function preToolUse(registry: ToolRegistry, filePath: string): Promise<string | undefined> {
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-1',
          cwd: h.cwd,
          tool_name: 'Write',
          tool_input: { file_path: filePath, content: 'x' },
          tool_use_id: `tu-${filePath}`,
        },
      },
      'sess-1',
      { agentType: 'claude_code' },
    );
    const structured = result.structuredContent as
      | { hookOutput?: { hookSpecificOutput?: { permissionDecisionReason?: string } } }
      | undefined;
    return structured?.hookOutput?.hookSpecificOutput?.permissionDecisionReason;
  }

  it('teaches the motivating decision on a real deny', async () => {
    // The seeded policy denies `.env` writes — a genuine opinion, so
    // Coodra asserts it AND now explains it.
    const registry = new ToolRegistry({
      deps: Object.freeze({
        ...h.baseDeps,
        policy: createPolicyClient({ db: h.handle }),
        memoryAccess: createMemoryAccessRecorder({ db: h.handle }),
      }),
    });
    registerAllTools(registry, { db: h.handle, mode: 'solo' });

    const reason = await preToolUse(registry, '.env');
    expect(reason, 'a denial should still be a denial').toBeTruthy();
    expect(reason, 'and should now carry the decision that motivated it').toContain('dec_a');
  });

  it('leaves an un-gated path byte-identical — no empty scaffolding', async () => {
    const registry = new ToolRegistry({
      deps: Object.freeze({
        ...h.baseDeps,
        policy: createPolicyClient({ db: h.handle }),
        memoryAccess: createMemoryAccessRecorder({ db: h.handle }),
      }),
    });
    registerAllTools(registry, { db: h.handle, mode: 'solo' });

    // No rule matches src/app.ts, so Coodra has no opinion and must not
    // assert one — COOD-62's "don't interfere" contract.
    const reason = await preToolUse(registry, 'src/app.ts');
    expect(reason).toBeUndefined();
  });

  it('records a policy_reason push row so the channel is measurable', async () => {
    const registry = new ToolRegistry({
      deps: Object.freeze({
        ...h.baseDeps,
        policy: createPolicyClient({ db: h.handle }),
        memoryAccess: createMemoryAccessRecorder({ db: h.handle }),
      }),
    });
    registerAllTools(registry, { db: h.handle, mode: 'solo' });

    await preToolUse(registry, '.env');
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.site, 'policy_reason'));
    // policy_decisions can see that a rule fired, but not whether a
    // decision was TAUGHT through the reason text — without this row the
    // channel is unmeasurable.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.channel).toBe('push');
    expect(rows[0]?.memoryType).toBe('decision');
    expect(rows[0]?.memoryId).toBe('dec_a');
  });
});

/**
 * COOD-97 — a pull event id must identify the EVENT, not the query.
 *
 * Pull rows were minted as `mae_${idempotencyKey}_${i}`, where the
 * idempotency key comes from the registry's `readonly` builder. Those
 * keys are derived purely from tool INPUT — `search_packs_nl`'s carries
 * only project slug and query prefix, and its own comment says
 * collisions "are fine for log-correlation (not dedup-critical)". They
 * were never event identities.
 *
 * Combined with `insertMemoryAccessEvent`'s `onConflictDoNothing`, the
 * second access with the same inputs was silently dropped.
 *
 * `read_context_pack` was the worst case and the one that matters most:
 * its key is `readonly:read_context_pack:${id}:e${excerptOnly}`, so
 * every read of a given pack — across every session, forever — collapsed
 * to a single row. That is exactly the pull COOD-83's cohort pairing
 * depends on and the numerator of the pull-through rate COOD-94's
 * observation week is meant to read.
 */
describe('COOD-97 — pull events are per access, not per query', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
    await seedRunAndDecisions(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('records two rows when two sessions issue the identical query', async () => {
    const registry = buildRegistry(h, true);
    await callQueryDecisions(registry, 'sess-1');
    await callQueryDecisions(registry, 'sess-2');
    await settleAndDrain(h);

    const rows = await accessRows(h);
    const pulls = rows.filter((r) => r.channel === 'pull');
    const sessions = new Set(pulls.map((r) => r.sessionId));
    expect(sessions, 'both sessions must appear').toEqual(new Set(['sess-1', 'sess-2']));
    // Two accesses, each returning the same two decisions.
    expect(pulls.length).toBe(4);
  });

  it('records two rows when ONE session repeats the identical query', async () => {
    // Two accesses are two events. Collapsing them undercounts the
    // denominator that "was this memory wanted?" is computed from.
    const registry = buildRegistry(h, true);
    await callQueryDecisions(registry, 'sess-1');
    await callQueryDecisions(registry, 'sess-1');
    await settleAndDrain(h);

    const pulls = (await accessRows(h)).filter((r) => r.channel === 'pull');
    expect(pulls.length).toBe(4);
  });

  it('mints a distinct id per row so nothing can collide', async () => {
    const registry = buildRegistry(h, true);
    await callQueryDecisions(registry, 'sess-1');
    await callQueryDecisions(registry, 'sess-2');
    await settleAndDrain(h);

    const pulls = (await accessRows(h)).filter((r) => r.channel === 'pull');
    expect(new Set(pulls.map((r) => r.id)).size).toBe(pulls.length);
  });
});
