import { execFileSync } from 'node:child_process';
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
 * COOD-60 regression coverage: `git rev-parse HEAD` capture at
 * SessionStart used to be hooks-bridge-only. COOD-53 routed every
 * native plugin's SessionStart through `lifecycle_event` instead, but
 * nothing there called `captureBaseSha` — so `runs.base_sha` stayed
 * NULL forever for native-plugin sessions (Codex, Devin, Cursor,
 * Antigravity, and Claude Code plugin installs) and every run-diff
 * landed `error='no_base_sha'`, even against a real git repository.
 * This spins up a real (tiny) git repo — matching this suite's own
 * convention of injecting fake git functions everywhere else in
 * `packages/lifecycle` doesn't apply here, since the native handler
 * doesn't expose an injection point for `captureBaseSha`'s git
 * subprocess — so a real repo is the faithful way to prove the wiring.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
  readonly headSha: string;
}

function gitInitWithOneCommit(cwd: string): string {
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@coodra.dev'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Coodra Test'], { cwd });
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], { cwd });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-capture-base-sha-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');
  const headSha = gitInitWithOneCommit(cwd);

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-capture-base-sha-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
    headSha,
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
    { agentType: 'codex', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'codex' },
  );
  const structured = result.structuredContent as { runId?: string | null } | undefined;
  const runId = structured?.runId ?? null;
  if (runId === null) throw new Error('expected a runId from SessionStart structuredContent');
  return runId;
}

describe('lifecycle_event — SessionStart captures runs.base_sha for native-plugin sessions (COOD-60)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('proj-capture-base-sha');
  });
  afterEach(async () => {
    await h.close();
  });

  it('persists a real `git rev-parse HEAD` into runs.base_sha via the native lifecycle_event tool', async () => {
    const registry = buildRegistry(h);
    const runId = await sessionStart(registry, h, 'sess_codex_base_sha');

    const runRows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
    expect(runRows[0]?.baseSha).toBe(h.headSha);
  });

  it('is idempotent: a second SessionStart-equivalent event does not overwrite an already-captured base_sha', async () => {
    const registry = buildRegistry(h);
    const runId = await sessionStart(registry, h, 'sess_codex_base_sha_2');

    // A second SessionStart for the same session is a no-op re-fire — the
    // idempotent `WHERE base_sha IS NULL` in captureBaseSha must leave the
    // first-captured SHA untouched even if HEAD later moves.
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'second'], { cwd: h.cwd });
    await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'codex',
        rawPayload: { hook_event_name: 'SessionStart', session_id: 'sess_codex_base_sha_2', cwd: h.cwd },
      },
      'mcp-session',
      { agentType: 'codex' },
    );

    const runRows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
    expect(runRows[0]?.baseSha).toBe(h.headSha);
  });
});
