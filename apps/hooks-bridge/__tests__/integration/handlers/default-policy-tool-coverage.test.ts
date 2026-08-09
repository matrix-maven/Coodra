import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  type DbHandle,
  ensureDefaultPolicy,
  ensureGlobalProject,
  ensureProject,
  migrateSqlite,
} from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';

/**
 * Phase 4 Fix F regression — every file-mutating tool gets denied
 * for the documented dangerous paths under the DEFAULT policy.
 *
 * Pre-fix state (this test FAILS on `main` at HEAD):
 *
 *   `ensureDefaultPolicy` seeded deny rules ONLY for `Write` and
 *   `Edit`. PreToolUse calls naming `MultiEdit` or `NotebookEdit`
 *   fell through to the policy evaluator's "no rule matched →
 *   allow" default. Result: an agent invoking `MultiEdit` against
 *   `.env`, or `NotebookEdit` inside `.git/`, sailed past
 *   Coodra enforcement entirely.
 *
 *   The existing rules also missed nested `.git/` and nested
 *   `node_modules/` (e.g. submodules + monorepo workspaces) —
 *   `.git/**` matches `.git/HEAD` but NOT `apps/foo/.git/HEAD`.
 *
 * Post-fix state (this test PASSES after Phase 4 Fix F):
 *
 *   `ensureDefaultPolicy` seeds 26 rules covering the cross-product of:
 *     tools = { Write, Edit, MultiEdit, NotebookEdit }
 *     globs = { .env, **\/.env, .git/**, **\/.git/**,
 *               node_modules/**, **\/node_modules/** }
 *   plus Read denies for .env / nested .env
 *   plus targeted risky Bash command ask rules.
 *
 *   As of 2026-08-09, the `.git/**`/`node_modules/**` rules within
 *   that cross-product are `ask`, not `deny` — hygiene, not a
 *   security boundary. `.env` write/read rules remain `deny`.
 *
 * The test wires the SAME code path init does — `ensureGlobalProject`
 * → `ensureProject` → `ensureDefaultPolicy` — so any future divergence
 * between init's setup and the seeded rule list is caught here.
 */

interface Harness {
  readonly cwd: string;
  readonly slug: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
}

let h: Harness;

const TOOLS_THAT_MUST_DENY = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
// .env is secrets protection — stays a hard deny.
const PATHS_THAT_MUST_DENY = [
  '.env',
  'apps/web/.env', // nested (monorepo / submodule shape)
] as const;
// git/node_modules are hygiene rules, softened to ask (2026-08-09) — a
// human can confirm through them instead of hitting a hard block.
const PATHS_THAT_MUST_ASK = [
  '.git/HEAD',
  'node_modules/foo/index.js',
  'apps/web/.git/HEAD', // nested (monorepo / submodule shape)
  'apps/web/node_modules/foo/index.js', // nested (monorepo / submodule shape)
] as const;

function makeEnv(): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phase4-fix-f-test-'));
  const slug = 'phase4-fix-f-coverage';
  mkdirSync(join(cwd, '.coodra'), { recursive: true });
  writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: slug }));

  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  // Use the SAME entry points init uses. No hand-seeded rules — this
  // test is regression coverage for the default rule set itself.
  await ensureGlobalProject(handle);
  const project = await ensureProject(handle, { slug });
  await ensureDefaultPolicy(handle, project.id);

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle });
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

interface ClaudeCodeBody {
  readonly hook_event_name: 'PreToolUse';
  readonly session_id: string;
  readonly tool_name: string;
  readonly tool_input: { file_path?: string; command?: string; [k: string]: unknown };
  readonly tool_use_id: string;
  readonly cwd: string;
}

async function postPreToolUse(
  toolName: string,
  toolInput: string | { file_path?: string; command?: string; [k: string]: unknown },
  idem: string,
): Promise<{ permissionDecision: string; permissionDecisionReason?: string }> {
  const body: ClaudeCodeBody = {
    hook_event_name: 'PreToolUse',
    session_id: `phase4-${idem}`,
    tool_name: toolName,
    tool_input: typeof toolInput === 'string' ? { file_path: toolInput, content: 'irrelevant' } : toolInput,
    tool_use_id: `tu-${idem}`,
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

describe('default policy — every file-mutating tool covered for dangerous paths (Phase 4 Fix F)', () => {
  for (const tool of TOOLS_THAT_MUST_DENY) {
    for (const path of PATHS_THAT_MUST_DENY) {
      it(`PreToolUse ${tool} → ${path}: deny with non-empty reason`, async () => {
        const out = await postPreToolUse(tool, path, `${tool}-${path.replace(/[^a-zA-Z0-9]/g, '_')}`);
        expect(out.permissionDecision, `${tool} → ${path} must deny`).toBe('deny');
        expect(out.permissionDecisionReason, `${tool} → ${path} deny must carry a reason`).toBeTruthy();
        expect((out.permissionDecisionReason ?? '').length).toBeGreaterThan(0);
      });
    }
    for (const path of PATHS_THAT_MUST_ASK) {
      it(`PreToolUse ${tool} → ${path}: ask with non-empty reason`, async () => {
        const out = await postPreToolUse(tool, path, `${tool}-${path.replace(/[^a-zA-Z0-9]/g, '_')}`);
        expect(out.permissionDecision, `${tool} → ${path} must ask`).toBe('ask');
        expect(out.permissionDecisionReason, `${tool} → ${path} ask must carry a reason`).toBeTruthy();
        expect((out.permissionDecisionReason ?? '').length).toBeGreaterThan(0);
      });
    }
  }

  it('PreToolUse Write → src/app.ts: still allows non-dangerous paths (sanity check)', async () => {
    const out = await postPreToolUse('Write', 'src/app.ts', 'allow-sanity');
    expect(out.permissionDecision).toBe('allow');
  });

  it('PreToolUse Read → .env: denies secret reads before credentials enter context', async () => {
    const out = await postPreToolUse('Read', '.env', 'read-env-deny');
    expect(out.permissionDecision).toBe('deny');
    expect((out.permissionDecisionReason ?? '').length).toBeGreaterThan(0);
  });

  it('PreToolUse Bash → harmless command: still allows without prompting', async () => {
    const out = await postPreToolUse('Bash', { command: 'ls -la' }, 'bash-allow');
    expect(out.permissionDecision).toBe('allow');
  });

  it('PreToolUse Bash → risky command: asks for confirmation with a reason', async () => {
    const out = await postPreToolUse('Bash', { command: 'rm -rf node_modules' }, 'bash-ask');
    expect(out.permissionDecision).toBe('ask');
    expect((out.permissionDecisionReason ?? '').length).toBeGreaterThan(0);
  });
});
