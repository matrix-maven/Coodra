import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, migrateSqlite, sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * F14 closure (verification 2026-04-27 — fix for audit-trail integrity).
 *
 * The original idempotency-key formula `pd:{sessionId}:{toolName}:{eventType}`
 * collapsed legitimately distinct tool invocations within a session
 * into a single audit row. SOC2 / NHI governance depends on every
 * decision having an audit row, so the formula was extended to
 * `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}`.
 *
 * This test drives two PreToolUse calls in the same session with the
 * same toolName but DIFFERENT toolUseIds and asserts that BOTH audit
 * rows land. The pre-F14 implementation would produce only ONE row.
 *
 * The companion test in `run-id-linkage.test.ts` historically worked
 * around this by using distinct toolNames; this suite is the
 * dedicated regression lock for the F14 invariant.
 */

interface Harness {
  readonly cwd: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
  readonly drain: () => Promise<void>;
  readonly projectId: string;
}

let h: Harness;

const PROJECT_ID = 'proj_distinct_tool_uses';
const PROJECT_SLUG = 'verify-f14-distinct-tool-uses';

function makeEnv(): AuthEnv {
  return { COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'distinct-tool-uses-test-'));
  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  await handle.db.insert(sqliteSchema.projects).values({
    id: PROJECT_ID,
    slug: PROJECT_SLUG,
    orgId: 'org_test',
    name: PROJECT_SLUG,
  });

  // Deny rule for /tmp/forbidden so one of the two invocations matches
  // a rule and the other doesn't — proving distinct decisions land
  // distinctly, not just distinct rows.
  const policyId = 'pol_f14_test';
  await handle.db.insert(sqliteSchema.policies).values({
    id: policyId,
    projectId: PROJECT_ID,
    name: 'forbid-tmp-forbidden',
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: 'rule_f14_test',
    policyId,
    priority: 100,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: '/tmp/forbidden/**',
    matchAgentType: '*',
    decision: 'deny',
    reason: 'forbidden by F14 test',
  });

  writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: PROJECT_SLUG }));

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  const drain = (): Promise<void> => drainOutbox(handle);
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const sessionStart = createSessionStartHandler({ runRecorder, projectSlugResolver, db: handle, mode: 'solo' });
  const stubAllow = async (): Promise<{ permissionDecision: 'allow' }> => ({ permissionDecision: 'allow' });
  const dispatch = composeDispatch({
    preToolUse,
    postToolUse: stubAllow,
    sessionStart,
    sessionEnd: stubAllow,
    userPromptSubmit: stubAllow,
  });
  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, handle, hono, drain, projectId: PROJECT_ID };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

async function postHook(eventName: string, body: Record<string, unknown>): Promise<Response> {
  return await h.hono.request('/v1/hooks/claude-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: body.session_id ?? 'default',
      hook_event_name: eventName,
      cwd: h.cwd,
      ...body,
    }),
  });
}

describe('F14 — distinct toolUseIds within a session land distinct audit rows', () => {
  it('same session + same toolName + DIFFERENT toolUseIds → 2 policy_decisions rows', async () => {
    const sessionId = 'sess-f14-distinct';
    await postHook('SessionStart', { session_id: sessionId });

    // Invocation 1: deny (matches /tmp/forbidden rule)
    const r1 = await postHook('PreToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/forbidden/a.ts' },
      tool_use_id: 'tu-f14-1',
    });
    expect(r1.status).toBe(200);

    // Invocation 2: allow (no rule matches /tmp/safe)
    const r2 = await postHook('PreToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/safe/b.ts' },
      tool_use_id: 'tu-f14-2',
    });
    expect(r2.status).toBe(200);

    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const decisions = await h.handle.db
      .select({
        idempotencyKey: sqliteSchema.policyDecisions.idempotencyKey,
        permissionDecision: sqliteSchema.policyDecisions.permissionDecision,
      })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, sessionId));

    // Pre-F14 implementation produced ONE row (deny, by first-write-wins).
    expect(decisions.length).toBe(2);

    const decisionsSet = new Set(decisions.map((d) => d.permissionDecision));
    expect(decisionsSet.has('deny')).toBe(true);
    expect(decisionsSet.has('allow')).toBe(true);

    const keys = decisions.map((d) => d.idempotencyKey).sort();
    expect(keys).toEqual([`pd:${sessionId}:tu-f14-1:Write:PreToolUse`, `pd:${sessionId}:tu-f14-2:Write:PreToolUse`]);
  });

  it('same session + same toolName + SAME toolUseId fired twice → 1 row (retry dedupe preserved)', async () => {
    const sessionId = 'sess-f14-retry';
    await postHook('SessionStart', { session_id: sessionId });

    const fixedUseId = 'tu-f14-retry-fixed';
    for (let i = 0; i < 5; i++) {
      const r = await postHook('PreToolUse', {
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/safe/x.ts' },
        tool_use_id: fixedUseId,
      });
      expect(r.status).toBe(200);
    }

    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const decisions = await h.handle.db
      .select({ idempotencyKey: sqliteSchema.policyDecisions.idempotencyKey })
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.sessionId, sessionId));

    expect(decisions.length).toBe(1);
    expect(decisions[0]?.idempotencyKey).toBe(`pd:${sessionId}:${fixedUseId}:Write:PreToolUse`);
  });
});
