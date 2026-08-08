import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * Integration test for the `UserPromptSubmit` session-contract fallback
 * (found investigating a live Codex Desktop report, 2026-08-08): Codex
 * Desktop gates plugin-bundled hooks behind a one-time interactive trust
 * review, so a real session can have `SessionStart` silently skipped while
 * `UserPromptSubmit`/`PreToolUse`/... still fire once the user trusts the
 * hook definition mid-session. Before this fix, `additionalContext` (the
 * session contract + runId + recent context) was ONLY ever injected on
 * `SessionStart` — a session that never got a real `SessionStart` had no
 * way to recover visibility that Coodra was even active.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
  readonly contextPacksRoot: string;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-ups-fallback-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-ups-fallback-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  // A real (not noop) runRecorder — the SessionStart-suppression logic
  // under test reads `run_events` back via `hasSessionStartEventForRun`,
  // so SessionStart's own event write has to actually land for the second
  // test case ("does NOT inject... once a real SessionStart has been
  // recorded") to mean anything. record() writes through pending_jobs;
  // see `drainOutbox` usage below for why callers await the OutboxWorker.
  const baseDeps = makeFakeDeps({ runRecorder: createRunRecorder({ db: handle }) });
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
    contextPacksRoot,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(
    createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo', contextPacksRoot: h.contextPacksRoot }),
  );
  return registry;
}

function unwrapHook(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): {
  hookSpecificOutput?: { additionalContext?: string };
} {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

async function userPromptSubmit(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string | undefined> {
  const result = await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'codex',
      rawPayload: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: h.cwd },
    },
    'mcp-session',
    { agentType: 'codex' },
  );
  return unwrapHook(result).hookSpecificOutput?.additionalContext;
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<void> {
  await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'codex',
      rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd },
    },
    'mcp-session',
    { agentType: 'codex' },
  );
  // The handler's own `runRecorder.record()` call only enqueues the
  // SessionStart row into `pending_jobs` — the `run_events` INSERT this
  // test depends on lands only after the OutboxWorker drains it.
  await drainOutbox(h.handle);
}

describe('lifecycle_event — UserPromptSubmit session-contract fallback', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness('proj-ups-fallback');
  });
  afterEach(async () => {
    await h.close();
  });

  it('injects the session contract + runId when UserPromptSubmit fires with no prior SessionStart', async () => {
    const registry = buildRegistry(h);
    const additionalContext = await userPromptSubmit(registry, h, 'sess_no_start');
    expect(additionalContext).toBeDefined();
    expect(additionalContext).toContain('## Coodra session contract');
    expect(additionalContext).toContain('Project slug: `proj-ups-fallback`');
    expect(additionalContext).toMatch(/Run id: `run/);
  });

  it('keeps injecting on every subsequent UserPromptSubmit as long as SessionStart never fires', async () => {
    const registry = buildRegistry(h);
    const first = await userPromptSubmit(registry, h, 'sess_still_missing');
    const second = await userPromptSubmit(registry, h, 'sess_still_missing');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).toContain('## Coodra session contract');
  });

  it('does NOT inject on UserPromptSubmit once a real SessionStart has been recorded for the run', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_normal');
    const additionalContext = await userPromptSubmit(registry, h, 'sess_normal');
    expect(additionalContext).toBeUndefined();
  });
});
