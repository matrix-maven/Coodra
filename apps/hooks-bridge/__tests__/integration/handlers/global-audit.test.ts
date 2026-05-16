import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDb,
  type DbHandle,
  ensureGlobalProject,
  GLOBAL_PROJECT_ID,
  migrateSqlite,
  sqliteSchema,
} from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { and, eq } from 'drizzle-orm';
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
 * F7 closure (verification 2026-04-27) — drives a PreToolUse hook from
 * a cwd with NO `.coodra.json` and a basename the resolver can't
 * derive a slug from, and asserts:
 *
 *   1. The deny rule (attached to project_id='__global__') still
 *      fires — the global rule cache slot loads every project's
 *      rules including the global ones.
 *   2. The audit row for the decision lands with
 *      `project_id='__global__'` (not skipped — closes the gap that
 *      F7 surfaced).
 *   3. SessionStart from the same cwd opens a `runs` row also under
 *      `project_id='__global__'`.
 *
 * Before this fix the bridge skipped the audit write to avoid the
 * NOT NULL FK violation, leaving no governance trail for unregistered
 * cwds. The __global__ sentinel project is the FK-safe fallback.
 *
 * **Why the cwd's basename is literally `tmp`:** M04 Phase 2 S1 (F3
 * root-cause fix, 2026-05-04) replaced the "unresolved → __global__"
 * default with `resolveAndEnsure` — it now auto-creates a `projects`
 * row from `basename(cwd)` for any normal cwd, so the F7 fallback
 * path is reachable only when basename derivation fails (reserved
 * name list in `resolve-project-slug.ts::RESERVED_BASENAMES`). Naming
 * the cwd's leaf directory `tmp` (a reserved name) deterministically
 * exercises the __global__ branch this suite is locking down.
 */

interface Harness {
  readonly root: string; // outer tmpdir wrapping `cwd` — owns cleanup
  readonly cwd: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
  readonly drain: () => Promise<void>;
}

let h: Harness;

function makeEnv(): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

beforeAll(async () => {
  // Outer tmp wrapper; the actual cwd is a subdir whose basename is a
  // reserved value so `deriveSlugFromCwd` returns undefined → resolver
  // returns `{slug: undefined, projectId: undefined}` → policy + recorder
  // fall through to GLOBAL_PROJECT_ID. No `.coodra.json` anywhere on
  // the walk-up either.
  const root = mkdtempSync(join(tmpdir(), 'global-audit-test-'));
  const cwd = join(root, 'tmp'); // 'tmp' is in RESERVED_BASENAMES
  mkdirSync(cwd);
  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  // Seed the __global__ sentinel project (mimics the boot helper).
  await ensureGlobalProject(handle);

  // Attach a deny policy + rule to the __global__ project so the
  // policy evaluator's GLOBAL_CACHE_KEY slot picks it up.
  await handle.db.insert(sqliteSchema.policies).values({
    id: 'pol_global_deny',
    projectId: GLOBAL_PROJECT_ID,
    name: 'forbid-tmp-global-deny',
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: 'rule_global_deny',
    policyId: 'pol_global_deny',
    priority: 100,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: '/tmp/forbidden/**',
    matchAgentType: '*',
    decision: 'deny',
    reason: 'forbidden by global policy (F7)',
  });

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
  h = { root, cwd, handle, hono, drain };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.root) rmSync(h.root, { recursive: true, force: true });
});

describe('F7 closure — audit-on-unresolved via __global__ sentinel', () => {
  it('PreToolUse from a cwd without .coodra.json gets denied + audits to __global__', async () => {
    const sessionId = 'sess-f7-deny';
    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/forbidden/blocked.ts' },
        tool_use_id: 'tu-f7-1',
        cwd: h.cwd, // no .coodra.json here
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe('forbidden by global policy (F7)');

    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    // F7 closure assertion: audit row landed (NOT skipped), project_id=__global__.
    const decisions = await h.handle.db
      .select({
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
        projectId: sqliteSchema.policyDecisions.projectId,
        matchedRuleId: sqliteSchema.policyDecisions.matchedRuleId,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, sessionId));
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.permissionDecision).toBe('deny');
    expect(decisions[0]?.projectId).toBe(GLOBAL_PROJECT_ID);
    expect(decisions[0]?.matchedRuleId).toBe('rule_global_deny');
  });

  it('SessionStart from a cwd without .coodra.json opens a runs row under __global__', async () => {
    const sessionId = 'sess-f7-lifecycle';
    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        cwd: h.cwd,
      }),
    });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const runs = await h.handle.db
      .select({ id: sqliteSchema.runs.id, projectId: sqliteSchema.runs.projectId, status: sqliteSchema.runs.status })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, GLOBAL_PROJECT_ID), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('in_progress');
  });
});
