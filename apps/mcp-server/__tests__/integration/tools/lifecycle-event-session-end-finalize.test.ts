import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
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
 * Phase 1 lifecycle extraction (2026-08-08) parity coverage: proves the
 * native `lifecycle_event` MCP tool's SessionEnd now produces the SAME
 * artifacts the HTTP Hooks Bridge always produced for Claude Code —
 * not just the run-completion status flip
 * (`lifecycle-event-new-events.test.ts` already locks that half) — but
 * also an auto-saved Context Pack, via the shared
 * `@coodra/lifecycle` `finalizeRunOnSessionEnd`. Regression target:
 * before this extraction, a Codex/Devin/Cursor/Antigravity SessionEnd
 * (no hooks-bridge in the loop for those agents) left a `runs` row
 * completed but with zero Context Pack — the bug this whole Phase 1
 * effort exists to close.
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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-session-end-finalize-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-session-end-finalize-packs-'));
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

async function sessionEnd(registry: ToolRegistry, h: Harness, sessionId: string): Promise<void> {
  await registry.handleCall(
    'lifecycle_event',
    { agentType: 'codex', rawPayload: { hook_event_name: 'SessionEnd', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'codex' },
  );
}

describe('lifecycle_event — SessionEnd finalization parity (Codex, no hooks-bridge in the loop)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('proj-session-end-finalize');
  });
  afterEach(async () => {
    await h.close();
  });

  it('auto-saves a Context Pack and marks the run completed, matching pre-extraction bridge behavior', async () => {
    const registry = buildRegistry(h);
    const runId = await sessionStart(registry, h, 'sess_codex_1');

    await sessionEnd(registry, h, 'sess_codex_1');

    const runRows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
    expect(runRows[0]?.status).toBe('completed');
    expect(runRows[0]?.endedAt).not.toBeNull();

    const packRows = await h.handle.db
      .select({ id: sqliteSchema.contextPacks.id })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .limit(1);
    expect(packRows).toHaveLength(1);

    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(h.contextPacksRoot)).toBe(true);
    const files = await readdir(h.contextPacksRoot);
    expect(files.some((f) => f.startsWith(today) && f.endsWith('.md'))).toBe(true);
  });
});
