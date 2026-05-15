import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutboxWorker } from '@coodra/cli/lib/outbox';
import { createDb, type DbHandle, ensureGlobalProject, migrateSqlite, sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPostToolUseHandler } from '../../../src/handlers/post-tool-use.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { createSessionEndHandler } from '../../../src/handlers/session-end.js';
import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createBridgeDispatchHandler } from '../../../src/lib/outbox-dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';

/**
 * Module 03.1 outbox end-to-end smoke (per implementation.md S2).
 *
 * Drives a full PreToolUse-without-drain → PreToolUse-with-drain
 * loop and asserts:
 *   1. The first PreToolUse lands a row in `pending_jobs`, NOT in
 *      `policy_decisions`. Proves the durable path is exclusive —
 *      no fallback to setImmediate-direct.
 *   2. After ticking the OutboxWorker, the row drains to
 *      `policy_decisions` (and disappears from `pending_jobs`).
 *   3. SessionStart's `runs` row also flows through the queue and
 *      lands in `runs`. The runId on the policy_decisions row joins
 *      back (F8 invariant) — the dispatcher's session_lookup
 *      resolution finds the runs row in dispatch order.
 *
 * This is the regression detector for the AC: "every audit write
 * must be durable; nothing bypasses pending_jobs."
 */

const PROJECT_ID = 'proj_outbox_e2e';
const PROJECT_SLUG = 'outbox-e2e';

interface Harness {
  readonly cwd: string;
  readonly handle: Extract<DbHandle, { kind: 'sqlite' }>;
  readonly fire: (event: 'SessionStart' | 'PreToolUse', body: Record<string, unknown>) => Promise<void>;
}

let h: Harness;

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'outbox-e2e-'));
  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);
  await ensureGlobalProject(handle);

  await handle.db.insert(sqliteSchema.projects).values({
    id: PROJECT_ID,
    slug: PROJECT_SLUG,
    orgId: 'org_e2e',
    name: 'outbox e2e',
  });
  const policyId = 'pol_e2e';
  await handle.db.insert(sqliteSchema.policies).values({
    id: policyId,
    projectId: PROJECT_ID,
    name: 'e2e-policy',
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: 'rule_e2e',
    policyId,
    priority: 100,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: null,
    matchAgentType: '*',
    decision: 'allow',
    reason: 'allow all writes for the e2e smoke',
  });

  writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: PROJECT_SLUG }));

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: handle });
  const sessionStart = createSessionStartHandler({ runRecorder, projectSlugResolver, db: handle, mode: 'solo' });
  const sessionEnd = createSessionEndHandler({ runRecorder, projectSlugResolver, db: handle });
  const stubAllow = async (): Promise<{ permissionDecision: 'allow' }> => ({ permissionDecision: 'allow' });
  const dispatch = composeDispatch({
    preToolUse,
    postToolUse,
    sessionStart,
    sessionEnd,
    userPromptSubmit: stubAllow,
  });
  const { hono } = buildApp({
    env: { COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' },
    dispatch,
  });

  const fire = async (event: 'SessionStart' | 'PreToolUse', body: Record<string, unknown>): Promise<void> => {
    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: body.session_id ?? 'sess_e2e',
        hook_event_name: event,
        cwd,
        ...body,
      }),
    });
    if (res.status !== 200) throw new Error(`hook ${event} returned ${res.status}: ${await res.text()}`);
  };

  h = { cwd, handle, fire };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

describe('outbox end-to-end: durable enqueue → worker drain → destination', () => {
  it('SessionStart + PreToolUse enqueue to pending_jobs FIRST (no fallback to direct INSERT)', async () => {
    await h.fire('SessionStart', {});
    await h.fire('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.ts' },
      tool_use_id: 'tu-e2e-1',
    });
    // Give the fire-and-forget enqueue a microtask to land. The bridge
    // returns 200 before the await on scheduleDurableWrite resolves;
    // a single setImmediate flush is sufficient for the in-process
    // SQLite write to be visible.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pending = await h.handle.db
      .select({ queue: sqliteSchema.pendingJobs.queue, status: sqliteSchema.pendingJobs.status })
      .from(sqliteSchema.pendingJobs);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const queues = pending.map((r) => r.queue).sort();
    expect(queues).toEqual(expect.arrayContaining(['policy_decision', 'session_open']));
    for (const row of pending) {
      expect(row.status).toBe('pending');
    }

    // No direct INSERTs to destination tables yet.
    const destPolicy = await h.handle.db.select().from(sqliteSchema.policyDecisions);
    expect(destPolicy).toHaveLength(0);
    const destRuns = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.sessionId, 'sess_e2e'));
    expect(destRuns).toHaveLength(0);
  });

  it('OutboxWorker drains pending_jobs to destination tables (with runId join intact)', async () => {
    const worker = new OutboxWorker({
      db: h.handle,
      dispatchHandler: createBridgeDispatchHandler({ db: h.handle }),
      tickMs: 60_000,
      leaseMs: 1_000,
    });
    // Tick repeatedly so SessionStart drains BEFORE PolicyDecision's
    // session_lookup runs — proves the dispatcher resolves the runId
    // even when the SessionStart job dispatches in the same tick chain.
    for (let i = 0; i < 10; i += 1) {
      await worker.tick();
    }
    await worker.stop();

    const pending = await h.handle.db.select().from(sqliteSchema.pendingJobs);
    expect(pending).toHaveLength(0);

    const runsRow = await h.handle.db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.sessionId, 'sess_e2e'));
    expect(runsRow).toHaveLength(1);
    const runId = runsRow[0]?.id;
    expect(runId).toBeDefined();

    const policyRow = await h.handle.db
      .select({
        runId: sqliteSchema.policyDecisions.runId,
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, 'sess_e2e'));
    expect(policyRow).toHaveLength(1);
    expect(policyRow[0]?.runId).toBe(runId);
    expect(policyRow[0]?.permissionDecision).toBe('allow');
  });
});
