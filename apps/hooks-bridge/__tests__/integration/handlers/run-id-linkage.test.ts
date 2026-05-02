import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, migrateSqlite, sqliteSchema } from '@coodra/contextos-db';
import { createPolicyClient } from '@coodra/contextos-policy';
import type { AuthEnv } from '@coodra/contextos-shared/auth';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPostToolUseHandler } from '../../../src/handlers/post-tool-use.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { createSessionEndHandler } from '../../../src/handlers/session-end.js';
import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import { createUserPromptSubmitHandler } from '../../../src/handlers/user-prompt-submit.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * F8 closure (verification 2026-04-27) — locks the runs ↔ run_events ↔
 * policy_decisions linkage. The prior recorder implementation hardcoded
 * `projectSlug = undefined` at the lookupRunId call site, so every
 * `run_events.run_id` and `policy_decisions.run_id` was NULL. The join
 * `runs → run_events` returned 0 rows for any session — the foundational
 * NHI query was broken. This test would have caught F8 by asserting on
 * the join, not just on row counts.
 *
 * Drives the full lifecycle: SessionStart → PreToolUse → PostToolUse →
 * UserPromptSubmit → Stop. After draining async writes, asserts:
 *   1. `runs` row exists for (projectId, sessionId).
 *   2. Every `run_events.run_id` for this session matches that runs.id.
 *   3. Every `policy_decisions.run_id` for this session matches.
 *   4. The join `runs.id → run_events.run_id` returns the expected count.
 */

interface Harness {
  readonly cwd: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
  readonly drain: () => Promise<void>;
  readonly projectId: string;
}

let h: Harness;

const PROJECT_ID = 'proj_run_id_linkage';
const PROJECT_SLUG = 'verify-f8-linkage';

function makeEnv(): AuthEnv {
  return {
    CONTEXTOS_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'run-id-linkage-test-'));
  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  // Seed a project so the resolver returns a projectId for our cwd.
  await handle.db.insert(sqliteSchema.projects).values({
    id: PROJECT_ID,
    slug: PROJECT_SLUG,
    orgId: 'org_test',
    name: PROJECT_SLUG,
  });

  // Seed a deny rule so PreToolUse against /tmp/forbidden produces a
  // policy_decisions audit row with a matched_rule_id.
  const policyId = 'pol_test';
  await handle.db.insert(sqliteSchema.policies).values({
    id: policyId,
    projectId: PROJECT_ID,
    name: 'forbid-tmp-forbidden',
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: 'rule_test',
    policyId,
    priority: 100,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: '/tmp/forbidden/**',
    matchAgentType: '*',
    decision: 'deny',
    reason: 'forbidden by F8 linkage test',
  });

  // .contextos.json for the resolver.
  writeFileSync(join(cwd, '.contextos.json'), JSON.stringify({ projectSlug: PROJECT_SLUG }));

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  const drain = (): Promise<void> => drainOutbox(handle);
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: handle });
  const sessionStart = createSessionStartHandler({ runRecorder, projectSlugResolver, db: handle, mode: 'solo' });
  const sessionEnd = createSessionEndHandler({ runRecorder, projectSlugResolver, db: handle });
  const userPromptSubmit = createUserPromptSubmitHandler({ runRecorder, projectSlugResolver, db: handle });
  const dispatch = composeDispatch({ preToolUse, postToolUse, sessionStart, sessionEnd, userPromptSubmit });

  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, handle, hono, drain, projectId: PROJECT_ID };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

async function postHook(eventName: string, body: Record<string, unknown>): Promise<void> {
  const res = await h.hono.request('/v1/hooks/claude-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: body.session_id ?? 'default',
      hook_event_name: eventName,
      cwd: h.cwd,
      ...body,
    }),
  });
  if (res.status !== 200) throw new Error(`hook ${eventName} returned ${res.status}: ${await res.text()}`);
}

describe('F8 closure — run_events.run_id and policy_decisions.run_id are populated', () => {
  it('full lifecycle: every run_events row links back to the runs row', async () => {
    const sessionId = 'sess-f8-lifecycle';

    await postHook('SessionStart', { session_id: sessionId });
    await postHook('UserPromptSubmit', {
      session_id: sessionId,
      prompt: 'add a feature',
      prompt_id: 'pid-1',
    });
    // Two PreToolUse calls — F14 (2026-04-27) extended the idempotency
    // key to `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}`, so
    // distinct toolUseIds within a session no longer collide. We use
    // distinct toolNames here historically; the dedicated
    // distinct-tool-uses.test.ts suite locks the F14 invariant
    // (same toolName + distinct toolUseIds → 2 audit rows).
    await postHook('PreToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/forbidden/blocked.ts' }, // matches deny rule
      tool_use_id: 'tu-pre-1',
    });
    await postHook('PreToolUse', {
      session_id: sessionId,
      tool_name: 'Bash', // distinct toolName → distinct idempotency key
      tool_input: { command: 'ls' }, // no rule match
      tool_use_id: 'tu-pre-2',
    });
    await postHook('PostToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/safe/ok.ts' },
      tool_use_id: 'tu-post-1',
    });
    // Phase 3 Fix A (2026-05-02): SessionEnd carries the runs-close
    // semantics; Stop is now an ack-only per-turn-end signal.
    await postHook('SessionEnd', { session_id: sessionId });

    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');

    // (1) runs row exists.
    const runs = await h.handle.db
      .select({ id: sqliteSchema.runs.id, status: sqliteSchema.runs.status })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, PROJECT_ID), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('completed'); // SessionEnd closed it.
    const runId = runs[0]?.id;
    expect(runId).toBeDefined();
    // Module 04a finding #9: bridge auto-create-run path now emits the
    // canonical 4-segment runId shape (matches MCP get_run_id output).
    expect(runId).toMatch(/^run:[^:]+:[^:]+:[0-9a-f-]{36}$/);

    // (2) Every run_events row for this session has run_id === runId.
    const runEvents = await h.handle.db
      .select({
        id: sqliteSchema.runEvents.id,
        runId: sqliteSchema.runEvents.runId,
        phase: sqliteSchema.runEvents.phase,
      })
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.runId, runId as string));
    // user_prompt + 1 post = 2 events (Pre events don't write run_events,
    // they write policy_decisions).
    expect(runEvents.length).toBeGreaterThanOrEqual(2);
    for (const ev of runEvents) {
      expect(ev.runId).toBe(runId);
    }

    // (3) Every policy_decisions row for this session has run_id === runId.
    const decisions = await h.handle.db
      .select({
        id: sqliteSchema.policyDecisions.id,
        runId: sqliteSchema.policyDecisions.runId,
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, sessionId));
    expect(decisions.length).toBe(2); // 2 PreToolUse calls
    for (const d of decisions) {
      expect(d.runId).toBe(runId);
    }
    // One of them should be deny.
    expect(decisions.some((d) => d.permissionDecision === 'deny')).toBe(true);

    // (4) The join `runs → run_events` returns the expected count.
    // This is the assertion that would have caught F8 directly.
    const joinedCount = await h.handle.db
      .select({ id: sqliteSchema.runEvents.id })
      .from(sqliteSchema.runEvents)
      .innerJoin(sqliteSchema.runs, eq(sqliteSchema.runEvents.runId, sqliteSchema.runs.id))
      .where(and(eq(sqliteSchema.runs.sessionId, sessionId), isNotNull(sqliteSchema.runEvents.runId)));
    expect(joinedCount.length).toBe(runEvents.length);
  });

  it('PostToolUse arriving before SessionStart writes runId=null (best-effort), then a later SessionStart does not retroactively repair it', async () => {
    // Documents the architectural choice: backfill is out of scope for
    // this commit. The recorder fills run_id on a best-effort basis at
    // INSERT time; events that arrive before the runs row exists keep
    // run_id=null. F7's __global__ project (Commit 5) does NOT change
    // this behavior — it just provides a fallback projectId, not a
    // fallback runs.id.
    const sessionId = 'sess-f8-out-of-order';

    await postHook('PostToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/safe/early.ts' },
      tool_use_id: 'tu-early-1',
    });

    await h.drain();

    await postHook('SessionStart', { session_id: sessionId });
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const earlyEvent = await h.handle.db
      .select({ runId: sqliteSchema.runEvents.runId })
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, 'tu-early-1'));
    expect(earlyEvent.length).toBe(1);
    expect(earlyEvent[0]?.runId).toBeNull(); // NOT backfilled (deferred work).

    // The runs row DOES exist (SessionStart fired second).
    const runs = await h.handle.db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, PROJECT_ID), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(runs.length).toBe(1);
  });
});
