import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type DbHandle, migrateSqlite, sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';

/**
 * End-to-end pre-tool-use enforcement: real SQLite, real policy
 * evaluator, real adapter chain. Verifies the policy decision propagates
 * back through the agent's response shape.
 *
 * Layout:
 *   - tmp dir with `.coodra.json` containing a project slug
 *   - sqlite path inside the tmp dir; migrations applied at setup
 *   - one project row + one policy row + one rule denying writes to
 *     `src/auth/**` for any agent
 *   - POST /v1/hooks/claude-code with a Write to src/auth/x.ts → deny
 *   - POST /v1/hooks/claude-code with a Write to src/utils/y.ts → allow
 *   - POST /v1/hooks/cursor mirrors the same deny path (cross-agent)
 */

interface Harness {
  readonly cwd: string;
  readonly slug: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
}

let h: Harness;

function makeEnv(): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pre-tool-test-'));
  const slug = `test-proj-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: slug }));

  const sqlitePath = join(cwd, 'data.db');
  // sqlite-vec MUST be loaded — migration 0001's hand-written
  // `CREATE VIRTUAL TABLE ... USING vec0` block fails otherwise.
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  // Seed: project row, policy row, rule row.
  const projectId = randomUUID();
  const policyId = randomUUID();
  const ruleId = randomUUID();
  await handle.db.insert(sqliteSchema.projects).values({
    id: projectId,
    slug,
    orgId: 'org_dev_local',
    name: 'pre-tool-test',
  });
  await handle.db.insert(sqliteSchema.policies).values({
    id: policyId,
    projectId,
    name: 'no writes to src/auth/**',
    description: 'test rule',
    isActive: true,
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: ruleId,
    policyId,
    priority: 1,
    matchEventType: 'PreToolUse',
    matchToolName: 'Write',
    matchPathGlob: 'src/auth/**',
    matchAgentType: '*',
    decision: 'deny',
    reason: 'auth files are reviewed manually',
  });

  // Build dispatch chain bound to this real DB.
  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle });
  // Stubs for non-pre lifecycle handlers — this suite isn't testing
  // the recorder; the dedicated suites for post / session-lifecycle do.
  const stubAllow = async (): Promise<{ permissionDecision: 'allow' }> => ({ permissionDecision: 'allow' });
  const dispatch = composeDispatch({
    preToolUse,
    postToolUse: stubAllow,
    sessionStart: stubAllow,
    sessionEnd: stubAllow,
    userPromptSubmit: stubAllow,
  });

  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, slug, handle, hono };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') {
    h.handle.close();
  }
  if (h?.cwd) {
    rmSync(h.cwd, { recursive: true, force: true });
  }
});

describe('pre-tool-use enforcement (real policy + real sqlite)', () => {
  it('claude-code: Write to src/auth/x.ts → permissionDecision: deny', async () => {
    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-deny-1',
        tool_name: 'Write',
        tool_input: { file_path: 'src/auth/x.ts', content: '...' },
        tool_use_id: 'tool-1',
        cwd: h.cwd,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(body.ok).toBe(true);
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe('auth files are reviewed manually');
  });

  it('claude-code: Write to src/utils/y.ts → permissionDecision: allow', async () => {
    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-allow-1',
        tool_name: 'Write',
        tool_input: { file_path: 'src/utils/y.ts', content: '...' },
        tool_use_id: 'tool-2',
        cwd: h.cwd,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('cursor: Write to src/auth/x.ts → decision: deny (cross-agent rule applies)', async () => {
    const res = await h.hono.request('/v1/hooks/cursor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conv-deny-1',
        event_type: 'pre_tool_use',
        tool_name: 'Write',
        tool_input: { file_path: 'src/auth/x.ts' },
        cwd: h.cwd,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('auth files are reviewed manually');
  });

  it('post-tool events still pass through unchanged (S8 will wire RunRecorder)', async () => {
    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-post',
        tool_name: 'Write',
        tool_input: { file_path: 'src/auth/x.ts' },
        tool_use_id: 'tool-3',
        cwd: h.cwd,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hookSpecificOutput: { permissionDecision: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
