import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getRunBaselineGeneration, migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../src/framework/tool-context.js';
import { ToolRegistry } from '../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../src/lib/context-pack.js';
import { createDbClient } from '../../src/lib/db.js';
import { createMemoryAccessRecorder } from '../../src/lib/memory-access-recorder.js';
import { createRunRecorder } from '../../src/lib/run-recorder.js';
import { registerAllTools } from '../../src/tools/index.js';
import { makeFakeDeps } from '../helpers/fake-deps.js';
import { drainOutbox } from './_helpers/drain-outbox.js';

/**
 * COOD-84 — compaction generations.
 *
 * The gap this closes: `isSessionStartEquivalent` covered SessionStart
 * and the first UserPromptSubmit of a run, and nothing else. A
 * compaction could drop or summarise away every block Coodra injected,
 * and Coodra would never notice — project grounding silently degraded
 * to whatever the agent's own summariser happened to keep, while
 * per-prompt blocks kept arriving on top of a lossy summary. Long runs
 * compact repeatedly and each pass is lossy over the last.
 *
 * Why re-emission lands on UserPromptSubmit rather than PostCompact:
 * neither Claude Code nor Devin accepts `additionalContext` on
 * PostCompact (their field tables are explicit; see `shapeHookOutput`).
 * So the compaction BUMPS the generation, and the next prompt — an
 * event every agent but Cursor can carry context on — re-seeds it.
 */

const SLUG = 'proj-compaction';

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-compaction-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug: SLUG }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-compaction-packs-'));
  const deps: ContextDeps = Object.freeze({
    ...makeFakeDeps(),
    contextPack: createContextPackStore({ db: handle, contextPacksRoot }),
    memoryAccess: createMemoryAccessRecorder({ db: handle }),
    // A REAL run recorder, not the no-op default. The pre-existing
    // "SessionStart never happened for this run" fallback keys off
    // run_events, so with a no-op recorder every prompt would look like
    // a first prompt and re-seed — masking whether the COMPACTION path
    // is the thing doing the re-emission.
    runRecorder: createRunRecorder({ db: handle }),
  });

  await handle.db
    .insert(sqliteSchema.projects)
    .values({ id: 'proj-1', orgId: 'org-1', slug: SLUG, name: 'Compaction Project', cwd });

  return { close: async () => void (await client.close()), handle, cwd, deps };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registerAllTools(registry, { db: h.handle, mode: 'solo' });
  return registry;
}

async function hook(
  registry: ToolRegistry,
  h: Harness,
  sessionId: string,
  hookEventName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'claude_code',
      rawPayload: { hook_event_name: hookEventName, session_id: sessionId, cwd: h.cwd, ...extra },
    },
    sessionId,
    { agentType: 'claude_code' },
  );
  const structured = result.structuredContent as
    | { hookOutput?: { hookSpecificOutput?: { additionalContext?: string }; additionalContext?: string } }
    | undefined;
  return (
    structured?.hookOutput?.hookSpecificOutput?.additionalContext ?? structured?.hookOutput?.additionalContext ?? ''
  );
}

async function seedPack(h: Harness, registry: ToolRegistry, sessionId: string): Promise<void> {
  const res = await registry.handleCall(
    'get_run_id',
    { projectSlug: SLUG, cwd: h.cwd, confirmRegister: true },
    sessionId,
    { agentType: 'claude_code' },
  );
  const runId = (res.structuredContent as { runId?: string }).runId;
  if (runId === undefined) throw new Error('no runId');
  await registry.handleCall(
    'save_context_pack',
    { runId, title: 'storage choice', content: 'we chose sqlite for the local store because it is embedded' },
    sessionId,
    { agentType: 'claude_code' },
  );
}

async function settleAndDrain(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = await h.handle.db.select().from(sqliteSchema.pendingJobs);
    if (pending.length > 0) break;
  }
  await drainOutbox(h.handle);
}

async function runIdFor(h: Harness, sessionId: string): Promise<string> {
  const rows = await h.handle.db
    .select({ id: sqliteSchema.runs.id })
    .from(sqliteSchema.runs)
    .where(eq(sqliteSchema.runs.sessionId, sessionId));
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no run row');
  return id;
}

let h: Harness;
beforeEach(async () => {
  h = await openHarness();
});
afterEach(async () => {
  await h.close();
});

describe('COOD-84 — compaction advances the baseline generation', () => {
  it('starts at generation 0 and increments on PostCompact', async () => {
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-1');
    await hook(registry, h, 'sess-1', 'SessionStart');
    const runId = await runIdFor(h, 'sess-1');

    expect(await getRunBaselineGeneration(h.handle, runId)).toBe(0);

    await hook(registry, h, 'sess-1', 'PostCompact');
    expect(await getRunBaselineGeneration(h.handle, runId)).toBe(1);

    await hook(registry, h, 'sess-1', 'PostCompact');
    expect(await getRunBaselineGeneration(h.handle, runId), 'long runs compact repeatedly').toBe(2);
  });

  it('re-emits grounding on the first prompt after a compaction', async () => {
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-1');
    await hook(registry, h, 'sess-1', 'SessionStart');
    await settleAndDrain(h);

    // A normal mid-session prompt does NOT re-seed — that would be the
    // bloat this epic is trying to remove.
    await settleAndDrain(h);
    const ordinary = await hook(registry, h, 'sess-1', 'UserPromptSubmit', {
      tool_input: { prompt: 'what next' },
    });
    expect(ordinary).not.toContain('Coodra session contract');

    await hook(registry, h, 'sess-1', 'PostCompact');
    const afterCompaction = await hook(registry, h, 'sess-1', 'UserPromptSubmit', {
      tool_input: { prompt: 'what next' },
    });
    // The compaction may have taken the original block with it, so the
    // next prompt re-seeds rather than assuming it survived.
    expect(afterCompaction, 'grounding must be re-established').toContain('Coodra session contract');
  });

  it('does not re-emit twice for the same generation', async () => {
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-1');
    await hook(registry, h, 'sess-1', 'SessionStart');
    await settleAndDrain(h);
    await hook(registry, h, 'sess-1', 'PostCompact');

    const first = await hook(registry, h, 'sess-1', 'UserPromptSubmit', { tool_input: { prompt: 'a' } });
    await settleAndDrain(h);
    const second = await hook(registry, h, 'sess-1', 'UserPromptSubmit', { tool_input: { prompt: 'b' } });

    expect(first).toContain('Coodra session contract');
    expect(second, 'one re-seed per generation, not one per prompt').not.toContain('Coodra session contract');
  });

  it('stamps push rows with the generation that surfaced them', async () => {
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-1');
    await hook(registry, h, 'sess-1', 'SessionStart');
    await settleAndDrain(h);
    await hook(registry, h, 'sess-1', 'PostCompact');
    await hook(registry, h, 'sess-1', 'UserPromptSubmit', { tool_input: { prompt: 'a' } });
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.channel, 'push'));
    const generations = new Set(rows.map((r) => r.baselineGeneration));
    // Both generations are represented, which is what lets COOD-79's
    // cohort rollup attribute a post-compaction pull to the manifest
    // that actually surfaced it rather than the original one.
    expect(generations.has(0)).toBe(true);
    expect(generations.has(1)).toBe(true);
  });
});
