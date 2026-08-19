import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { runMemoryRollupOnce } from '@coodra/lifecycle';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../src/framework/tool-context.js';
import { ToolRegistry } from '../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../src/lib/context-pack.js';
import { createDbClient } from '../../src/lib/db.js';
import { createMemoryAccessRecorder, type MemoryAccessRecorder } from '../../src/lib/memory-access-recorder.js';
import { registerAllTools } from '../../src/tools/index.js';
import { makeFakeDeps } from '../helpers/fake-deps.js';
import { drainOutbox } from './_helpers/drain-outbox.js';

/**
 * Pull attribution across the transport/agent session-id split.
 *
 * COOD-80 resolved the run from `ctx.sessionId`, which is minted by the
 * transport (`stdio-<uuid>`), while `runs.session_id` holds the AGENT's
 * session id. The two never match, so every pull wrote `run_id = NULL`
 * and `memory_cohorts` — which requires a non-null run — never paired a
 * surfaced item with its own retrieval. Pull-through read zero
 * regardless of traffic.
 *
 * The original suite missed this because it called `handleCall` with
 * `sessionId: 'sess-1'`, the same value it had written into
 * `runs.session_id`. Every test here uses a transport-shaped id, which
 * is the only thing production ever passes.
 */

const SLUG = 'proj-attrib';
const AGENT_SESSION = 'agent-sess-1';
const TRANSPORT_SESSION = 'stdio-3ce9ec0d-5ba0-45a3-be29-9c0c320d40ba';
const RUN_ID = `run:proj-1:${AGENT_SESSION}:uuid-1`;

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly baseDeps: ContextDeps;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-attrib-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug: SLUG }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-attrib-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps: ContextDeps = Object.freeze({ ...makeFakeDeps(), contextPack: store });

  await handle.db.insert(sqliteSchema.projects).values({
    id: 'proj-1',
    orgId: 'org-1',
    slug: SLUG,
    name: 'Attribution Project',
    cwd,
  });
  await handle.db.insert(sqliteSchema.runs).values({
    id: RUN_ID,
    orgId: 'org-1',
    projectId: 'proj-1',
    // The AGENT's session id — never the transport's.
    sessionId: AGENT_SESSION,
    agentType: 'claude_code',
    mode: 'solo',
  });
  await handle.db.insert(sqliteSchema.decisions).values({
    id: 'dec_a',
    orgId: 'org-1',
    projectId: 'proj-1',
    runId: RUN_ID,
    idempotencyKey: 'idem-dec_a',
    description: 'chose sqlite for the local store',
    rationale: 'because',
  });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    baseDeps,
  };
}

function buildRegistry(h: Harness): { registry: ToolRegistry; recorder: MemoryAccessRecorder } {
  const recorder = createMemoryAccessRecorder({ db: h.handle });
  const registry = new ToolRegistry({ deps: Object.freeze({ ...h.baseDeps, memoryAccess: recorder }) });
  registerAllTools(registry, { db: h.handle, mode: 'solo' });
  return { registry, recorder };
}

async function queryDecisions(registry: ToolRegistry): Promise<void> {
  await registry.handleCall('query_decisions', { projectSlug: SLUG, query: 'store' }, TRANSPORT_SESSION, {
    agentType: 'claude_code',
  });
}

/** recordPull is fire-and-forget; let the enqueue settle before draining. */
async function settleAndDrain(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = await h.handle.db.select().from(sqliteSchema.pendingJobs);
    if (pending.length > 0) break;
  }
  await drainOutbox(h.handle);
}

async function pullRows(h: Harness) {
  const rows = await h.handle.db.select().from(sqliteSchema.memoryAccessEvents);
  return rows.filter((r) => r.channel === 'pull');
}

describe('pull attribution — transport session id is not an agent session id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes an unattributed row when nothing has bound the session yet', async () => {
    const { registry, recorder } = buildRegistry(h);
    await queryDecisions(registry);
    await settleAndDrain(h);

    const rows = await pullRows(h);
    expect(rows).toHaveLength(1);
    // Still NULL, and still counted — an unattributed pull is evidence
    // the agent wanted something, and the miss must stay observable
    // rather than becoming a hole nobody can see.
    expect(rows[0]?.runId).toBeNull();
    expect(recorder.attributionMisses()).toBe(1);
  });

  it('attributes the pull once the agent has asserted its run on this connection', async () => {
    const { registry, recorder } = buildRegistry(h);

    // The agent hands back the run id the SessionStart manifest gave
    // it. This is an attribution field, not a retrieval filter.
    const bind = await registry.handleCall(
      'record_decision',
      { runId: RUN_ID, description: 'a decision made this session', rationale: 'why' },
      TRANSPORT_SESSION,
      { agentType: 'claude_code' },
    );
    expect((bind.structuredContent as { ok?: boolean } | undefined)?.ok).toBe(true);

    await queryDecisions(registry);
    await settleAndDrain(h);

    const rows = await pullRows(h);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.runId).toBe(RUN_ID);
      expect(row.projectId).toBe('proj-1');
      expect(row.orgId).toBe('org-1');
    }
    expect(recorder.attributionMisses()).toBe(0);
  });

  it('does not bind from a runId that is a retrieval filter', async () => {
    const { registry } = buildRegistry(h);

    // `query_decisions.runId` narrows results to a run the agent wants
    // to read ABOUT. Binding on it would attribute this session's
    // pulls to someone else's run.
    await registry.handleCall(
      'query_decisions',
      { projectSlug: SLUG, query: 'store', runId: RUN_ID },
      TRANSPORT_SESSION,
      { agentType: 'claude_code' },
    );
    await settleAndDrain(h);

    for (const row of await pullRows(h)) {
      expect(row.runId).toBeNull();
    }
  });

  it('does not bind from a fabricated run id, because the call fails first', async () => {
    const { registry } = buildRegistry(h);

    const bad = await registry.handleCall(
      'record_decision',
      { runId: 'run:proj-1:invented:uuid-x', description: 'd', rationale: 'r' },
      TRANSPORT_SESSION,
      { agentType: 'claude_code' },
    );
    expect((bad.structuredContent as { ok?: boolean } | undefined)?.ok).toBe(false);

    await queryDecisions(registry);
    await settleAndDrain(h);

    for (const row of await pullRows(h)) {
      expect(row.runId).toBeNull();
    }
  });
});

describe('pull attribution — the cohort actually pairs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('gives pull-through a numerator: surfaced then pulled lands on one cohort row', async () => {
    const { registry, recorder } = buildRegistry(h);

    // Surfaced by the SessionStart manifest — the push half already
    // knows the run, because the hook payload carries the agent id.
    await recorder.recordPush({
      site: 'session_start_manifest',
      triggerType: 'session_start',
      sessionId: AGENT_SESSION,
      runId: RUN_ID,
      projectId: 'proj-1',
      orgId: 'org-1',
      agentType: 'claude_code',
      idempotencyKey: 'push-1',
      items: [{ memoryType: 'decision', memoryId: 'dec_a', position: 0, bytes: 120 }],
    });

    await registry.handleCall(
      'record_decision',
      { runId: RUN_ID, description: 'bind this session', rationale: 'why' },
      TRANSPORT_SESSION,
      { agentType: 'claude_code' },
    );
    await queryDecisions(registry);
    await settleAndDrain(h);

    await runMemoryRollupOnce(h.handle);

    const cohorts = await h.handle.db.select().from(sqliteSchema.memoryCohorts);
    const surfaced = cohorts.find((c) => c.memoryId === 'dec_a');
    expect(surfaced, 'a cohort row exists for the surfaced-and-pulled decision').toBeDefined();
    expect(surfaced?.runId).toBe(RUN_ID);
    expect(surfaced?.surfacedCount).toBe(1);
    // The whole point of the fix. Before it, this was 0 forever.
    expect(surfaced?.pulledCount).toBeGreaterThan(0);
    expect(surfaced?.surfacedSite).toBe('session_start_manifest');
    expect(surfaced?.pulledSite).toBe('query_decisions');
  });
});
