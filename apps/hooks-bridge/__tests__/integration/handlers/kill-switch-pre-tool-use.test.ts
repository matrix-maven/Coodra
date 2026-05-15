import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDb,
  type DbHandle,
  ensureDefaultPolicy,
  ensureGlobalProject,
  ensureProject,
  insertKillSwitch,
  migrateSqlite,
} from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createKillSwitchEvaluator } from '../../../src/lib/kill-switch-evaluator.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';

/**
 * Module 08b S2 — kill-switch evaluator wired into the pre-tool-use chain.
 *
 * 5 fixtures locking the wiring contract:
 *
 *   1. Hard global switch denies regardless of policy (path that would
 *      otherwise be allowed by the default policy still gets denied
 *      with the kill_switch_paused reason).
 *   2. Soft global switch allows but the audit reason carries the
 *      kill_switch_paused tag (operator gets observability without
 *      enforcement).
 *   3. Tool-scoped switch only matches the named tool — other tools
 *      fall through to the policy chain.
 *   4. Project-scoped switch only matches the resolved project — the
 *      same handler instance applied to a request whose cwd resolves
 *      to a different project ignores the switch entirely.
 *   5. After resuming the switch, the next request evaluates against
 *      `policy_rules` again (no stale cache; the evaluator's 5s TTL is
 *      bypassed for the resumed-row case via `invalidate()`).
 *
 * Wires the SAME path init produces (`ensureGlobalProject` → `ensureProject`
 * → `ensureDefaultPolicy`) so any future divergence between init and
 * the kill-switch + policy chain is caught here.
 */

interface ClaudeCodeBody {
  readonly hook_event_name: 'PreToolUse';
  readonly session_id: string;
  readonly tool_name: string;
  readonly tool_input: { file_path?: string; [k: string]: unknown };
  readonly tool_use_id: string;
  readonly cwd: string;
}

interface Harness {
  readonly cwd: string;
  readonly slug: string;
  readonly projectId: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
  readonly evaluator: ReturnType<typeof createKillSwitchEvaluator>;
}

let h: Harness;

function makeEnv(): AuthEnv {
  return { COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'm08b-s2-kill-switch-'));
  const slug = 'kill-switch-pre-tool-use';
  writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: slug }));

  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  await ensureGlobalProject(handle);
  const project = await ensureProject(handle, { slug });
  await ensureDefaultPolicy(handle, project.id);

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const evaluator = createKillSwitchEvaluator({ db: handle, cacheMs: 0 });
  const preToolUse = createPreToolUseHandler({
    policy,
    projectSlugResolver,
    db: handle,
    killSwitchEvaluator: evaluator,
  });
  const stubAllow = async (): Promise<{ permissionDecision: 'allow' }> => ({ permissionDecision: 'allow' });
  const dispatch = composeDispatch({
    preToolUse,
    postToolUse: stubAllow,
    sessionStart: stubAllow,
    sessionEnd: stubAllow,
    userPromptSubmit: stubAllow,
  });

  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, slug, projectId: project.id, handle, hono, evaluator };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from a clean kill_switches table so fixtures
  // don't bleed across tests. Drop the evaluator's cache too — its
  // cacheMs is 0 in this harness so the cache is mostly bypassed,
  // but invalidate() makes the reset explicit.
  if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
  h.handle.raw.exec('DELETE FROM kill_switches');
  h.evaluator.invalidate();
});

async function postPreToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
): Promise<{ permissionDecision: string; permissionDecisionReason?: string }> {
  const body: ClaudeCodeBody = {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: `tu-${sessionId}-${toolName}`,
    cwd: h.cwd,
  };
  const res = await h.hono.request('/v1/hooks/claude-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    ok: boolean;
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  return json.hookSpecificOutput;
}

describe('PreToolUse + kill-switch evaluator (M08b S2)', () => {
  it('Fixture 1 — hard global switch denies even paths that the default policy would allow', async () => {
    // Sanity: without any switch, Write to src/app.ts is allowed.
    const beforeSwitch = await postPreToolUse(
      'Write',
      { file_path: 'src/app.ts', content: 'irrelevant' },
      'sess-fixture-1-pre',
    );
    expect(beforeSwitch.permissionDecision).toBe('allow');

    const ks = await insertKillSwitch(h.handle, {
      scope: 'global',
      target: null,
      reason: 'demo: stop the system',
      mode: 'hard',
    });
    h.evaluator.invalidate();

    const afterSwitch = await postPreToolUse(
      'Write',
      { file_path: 'src/app.ts', content: 'irrelevant' },
      'sess-fixture-1',
    );
    expect(afterSwitch.permissionDecision).toBe('deny');
    expect(afterSwitch.permissionDecisionReason).toBe(`kill_switch_paused:${ks.id}`);
  });

  it('Fixture 2 — soft global switch allows but the response carries the kill_switch_paused reason', async () => {
    const ks = await insertKillSwitch(h.handle, {
      scope: 'global',
      target: null,
      reason: 'observability-only pause',
      mode: 'soft',
    });
    h.evaluator.invalidate();

    const out = await postPreToolUse('Write', { file_path: 'src/app.ts', content: 'irrelevant' }, 'sess-fixture-2');
    expect(out.permissionDecision).toBe('allow');
    expect(out.permissionDecisionReason).toBe(`kill_switch_paused:${ks.id}`);
  });

  it('Fixture 3 — tool-scoped switch only matches the named tool; others fall through to policy', async () => {
    const ks = await insertKillSwitch(h.handle, {
      scope: 'tool',
      target: 'Bash',
      reason: 'no shell during demo',
      mode: 'hard',
    });
    h.evaluator.invalidate();

    // Bash → kill-switch deny.
    const bashOut = await postPreToolUse('Bash', { command: 'ls' }, 'sess-fixture-3-bash');
    expect(bashOut.permissionDecision).toBe('deny');
    expect(bashOut.permissionDecisionReason).toBe(`kill_switch_paused:${ks.id}`);

    // Write to src/app.ts → no kill-switch match → policy allows (default policy
    // only denies dangerous paths).
    const writeOut = await postPreToolUse(
      'Write',
      { file_path: 'src/app.ts', content: 'irrelevant' },
      'sess-fixture-3-write',
    );
    expect(writeOut.permissionDecision).toBe('allow');
    // The reason for an allowed event isn't required to mention the kill switch.
    expect(writeOut.permissionDecisionReason ?? '').not.toContain('kill_switch_paused:');
  });

  it('Fixture 4 — project-scoped switch matches only the resolved project', async () => {
    // A switch scoped to a DIFFERENT project should not affect this handler's cwd.
    const _foreignSwitch = await insertKillSwitch(h.handle, {
      scope: 'project',
      target: '00000000-0000-0000-0000-000000000fff', // different from h.projectId
      reason: 'pause some other project',
      mode: 'hard',
    });
    h.evaluator.invalidate();

    const out = await postPreToolUse(
      'Write',
      { file_path: 'src/app.ts', content: 'irrelevant' },
      'sess-fixture-4-foreign',
    );
    expect(out.permissionDecision).toBe('allow');

    // Now scope a switch to THIS project — should deny.
    const projectSwitch = await insertKillSwitch(h.handle, {
      scope: 'project',
      target: h.projectId,
      reason: 'pause this project',
      mode: 'hard',
    });
    h.evaluator.invalidate();

    const out2 = await postPreToolUse(
      'Write',
      { file_path: 'src/app.ts', content: 'irrelevant' },
      'sess-fixture-4-self',
    );
    expect(out2.permissionDecision).toBe('deny');
    expect(out2.permissionDecisionReason).toBe(`kill_switch_paused:${projectSwitch.id}`);
  });

  it('Fixture 5 — resuming the switch returns to the policy chain (deny falls back to default policy)', async () => {
    const ks = await insertKillSwitch(h.handle, {
      scope: 'global',
      target: null,
      reason: 'demo pause',
      mode: 'hard',
    });
    h.evaluator.invalidate();

    // While active: write to .env returns deny with kill_switch_paused reason
    // (kill switch beats the .env policy rule because it short-circuits first).
    const denyOut = await postPreToolUse(
      'Write',
      { file_path: '.env', content: 'SECRET=1' },
      'sess-fixture-5-pre-resume',
    );
    expect(denyOut.permissionDecision).toBe('deny');
    expect(denyOut.permissionDecisionReason).toBe(`kill_switch_paused:${ks.id}`);

    // Resume by setting resumed_at directly via raw SQL (S3's `coodra resume`
    // CLI is the production path; this integration test exercises the bridge
    // contract, not the CLI). After resume + cache invalidation, the next
    // PreToolUse falls through to the policy chain and is denied by the
    // .env rule (different reason — proves the policy chain is back in play).
    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    h.handle.raw.prepare('UPDATE kill_switches SET resumed_at = unixepoch() WHERE id = ?').run(ks.id);
    h.evaluator.invalidate();

    const policyDenyOut = await postPreToolUse(
      'Write',
      { file_path: '.env', content: 'SECRET=1' },
      'sess-fixture-5-post-resume',
    );
    expect(policyDenyOut.permissionDecision).toBe('deny');
    // The reason now comes from the default policy's .env rule, not from
    // the kill switch.
    expect(policyDenyOut.permissionDecisionReason ?? '').not.toContain('kill_switch_paused:');
    expect(policyDenyOut.permissionDecisionReason ?? '').toMatch(/secret|\.env/i);
  });
});
