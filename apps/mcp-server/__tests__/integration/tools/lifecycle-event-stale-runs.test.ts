import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * COOD-62 regression coverage: `abandonStaleInProgressRuns` used to run
 * only from `apps/hooks-bridge`'s SessionStart. COOD-53 routed every
 * native plugin through `lifecycle_event` instead, so nothing swept a
 * project's orphaned `in_progress` runs — they accumulated forever.
 *
 * Locks both halves of the contract:
 *   - a genuinely stale run (old, no recent run_events) is abandoned
 *   - a LIVE concurrent run (recent run_events) is spared, so opening a
 *     second terminal on the same project does not kill the first
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-stale-runs-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-stale-runs-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const deps: ContextDeps = Object.freeze({ ...makeFakeDeps(), contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo' }));
  return registry;
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'claude_code', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'claude_code' },
  );
  const structured = result.structuredContent as { runId?: string | null } | undefined;
  const runId = structured?.runId ?? null;
  if (runId === null) throw new Error('expected a runId from SessionStart');
  return runId;
}

/** Seed an in_progress run directly, with a controllable started_at. */
function seedRun(h: Harness, args: { id: string; projectId: string; sessionId: string; startedAtSec: number }): void {
  h.handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
       VALUES (?, ?, ?, 'claude_code', 'solo', 'in_progress', ?)`,
    )
    .run(args.id, args.projectId, args.sessionId, args.startedAtSec);
}

function seedRunEvent(h: Harness, args: { runId: string; createdAtSec: number }): void {
  h.handle.raw
    .prepare(
      `INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input, created_at)
       VALUES (?, ?, 'pre', 'Write', ?, '{}', ?)`,
    )
    .run(`re-${args.runId}`, args.runId, `tu-${args.runId}`, args.createdAtSec);
}

async function projectIdFor(h: Harness, slug: string): Promise<string> {
  const rows = await h.handle.db
    .select({ id: sqliteSchema.projects.id })
    .from(sqliteSchema.projects)
    .where(eq(sqliteSchema.projects.slug, slug))
    .limit(1);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('project not found');
  return id;
}

async function statusOf(h: Harness, runId: string): Promise<string | undefined> {
  const rows = await h.handle.db
    .select({ status: sqliteSchema.runs.status })
    .from(sqliteSchema.runs)
    .where(eq(sqliteSchema.runs.id, runId))
    .limit(1);
  return rows[0]?.status;
}

describe('lifecycle_event — SessionStart abandons stale in_progress runs (COOD-62)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('proj-stale-runs');
  });
  afterEach(async () => {
    await h.close();
  });

  it('abandons a prior stuck run with no recent activity', async () => {
    const registry = buildRegistry(h);
    // First session registers the project.
    await sessionStart(registry, h, 'sess_first');
    const projectId = await projectIdFor(h, 'proj-stale-runs');

    // An orphan: started 2h ago, no run_events at all.
    const orphanId = 'run:orphan:stuck';
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    seedRun(h, { id: orphanId, projectId, sessionId: 'sess_orphan', startedAtSec: twoHoursAgo });
    expect(await statusOf(h, orphanId)).toBe('in_progress');

    // A new session opening should reap it.
    await sessionStart(registry, h, 'sess_second');
    expect(await statusOf(h, orphanId)).toBe('abandoned');
  });

  it('spares a LIVE concurrent run that has recent run_events', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_first');
    const projectId = await projectIdFor(h, 'proj-stale-runs');

    // Old start time, but active one minute ago — a long-running session
    // in another terminal, not an orphan.
    const liveId = 'run:live:working';
    const nowSec = Math.floor(Date.now() / 1000);
    seedRun(h, { id: liveId, projectId, sessionId: 'sess_live', startedAtSec: nowSec - 7200 });
    seedRunEvent(h, { runId: liveId, createdAtSec: nowSec - 60 });

    await sessionStart(registry, h, 'sess_second');
    expect(await statusOf(h, liveId), 'a run with recent activity must not be abandoned').toBe('in_progress');
  });

  it('never abandons the session that is currently opening', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_first');
    const ownRunId = await sessionStart(registry, h, 'sess_self');
    expect(await statusOf(h, ownRunId)).toBe('in_progress');
  });
});
