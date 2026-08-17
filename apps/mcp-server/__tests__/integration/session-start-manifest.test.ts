import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextDeps } from '../../src/framework/tool-context.js';
import { ToolRegistry } from '../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../src/lib/context-pack.js';
import { createDbClient } from '../../src/lib/db.js';
import { createMemoryAccessRecorder } from '../../src/lib/memory-access-recorder.js';
import { registerAllTools } from '../../src/tools/index.js';
import { makeFakeDeps } from '../helpers/fake-deps.js';
import { drainOutbox } from './_helpers/drain-outbox.js';

/**
 * COOD-83 — SessionStart manifest.
 *
 * The core delivery-model change: push an INDEX and let the agent pull
 * bodies, instead of pushing excerpt bodies nobody asked for.
 *
 * Two things are locked here, and the second matters more than the
 * first:
 *
 *   1. The flag actually switches rendering, and excerpts stay the
 *      DEFAULT. The PRD gates promotion on eval Layer 1 (COOD-70/71)
 *      because the two modes fail in opposite directions — the old one
 *      bloats and goes stale, the new one under-retrieves — so shipping
 *      it on by default would be guessing.
 *   2. **Both modes record what was surfaced.** Without push rows,
 *      `memory_cohorts.surfaced_count` is always zero and pull-through
 *      rate has no denominator. Instrumenting only the new mode would
 *      make the A/B unmeasurable in exactly the arm it needs a baseline
 *      for.
 */

const SLUG = 'proj-manifest';

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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-manifest-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug: SLUG }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-manifest-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const deps: ContextDeps = Object.freeze({
    ...makeFakeDeps(),
    contextPack: store,
    memoryAccess: createMemoryAccessRecorder({ db: handle }),
  });

  await handle.db.insert(sqliteSchema.projects).values({
    id: 'proj-1',
    orgId: 'org-1',
    slug: SLUG,
    name: 'Manifest Project',
    cwd,
  });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registerAllTools(registry, { db: h.handle, mode: 'solo' });
  return registry;
}

async function seedPack(h: Harness, registry: ToolRegistry, sessionId: string): Promise<void> {
  const runId = await registry.handleCall(
    'get_run_id',
    { projectSlug: SLUG, cwd: h.cwd, confirmRegister: true },
    sessionId,
    { agentType: 'claude_code' },
  );
  const data = (runId.structuredContent as { runId?: string }).runId;
  if (data === undefined) throw new Error('no runId');
  await registry.handleCall(
    'save_context_pack',
    {
      runId: data,
      title: 'sqlite storage decision',
      content: 'A long body about why we chose sqlite for the local store, with plenty of detail.',
    },
    sessionId,
    { agentType: 'claude_code' },
  );
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'claude_code', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    sessionId,
    { agentType: 'claude_code' },
  );
  const structured = result.structuredContent as
    | { hookOutput?: { hookSpecificOutput?: { additionalContext?: string } } }
    | undefined;
  return structured?.hookOutput?.hookSpecificOutput?.additionalContext ?? '';
}

async function settleAndDrain(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = await h.handle.db.select().from(sqliteSchema.pendingJobs);
    if (pending.length > 0) break;
  }
  await drainOutbox(h.handle);
}

let h: Harness;
beforeEach(async () => {
  h = await openHarness();
});
afterEach(async () => {
  delete process.env.COODRA_SESSION_MANIFEST;
  await h.close();
});

describe('COOD-83 — manifest mode', () => {
  it('defaults to an index with ids and no bodies (COOD-94)', async () => {
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-a');
    const context = await sessionStart(registry, h, 'sess-b');

    expect(context).toContain('Recent context (index)');
    // The point of the mode: the agent is told what exists and how to
    // fetch it, not handed the body unasked.
    expect(context).toContain('coodra__read_context_pack');
    expect(context, 'manifest mode must not inject the body').not.toContain('sqlite for the local store');
    expect(context, 'but it must carry the id needed to pull it').toMatch(/`cp_[0-9a-f-]+`/);
  });

  it('restores excerpt mode, bodies and all, when explicitly disabled', async () => {
    // The escape hatch is load-bearing: bloat and under-retrieval are
    // opposite failures, and a project whose agents ignore the index
    // needs a way back that does not require a release.
    process.env.COODRA_SESSION_MANIFEST = '0';
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-a');
    const context = await sessionStart(registry, h, 'sess-b');

    expect(context).toContain('Hot Context Packs');
    expect(context, 'excerpt mode injects the body').toContain('sqlite for the local store');
  });

  it('injects fewer bytes by default than the opt-out excerpt mode', async () => {
    process.env.COODRA_SESSION_MANIFEST = '0';
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-a');
    const excerptContext = await sessionStart(registry, h, 'sess-b');

    delete process.env.COODRA_SESSION_MANIFEST;
    const manifestContext = await sessionStart(registry, h, 'sess-c');

    expect(manifestContext.length).toBeLessThan(excerptContext.length);
  });
});

describe('COOD-83 — surfaced rows are recorded in BOTH modes', () => {
  it('records a push row per surfaced pack in excerpt mode', async () => {
    process.env.COODRA_SESSION_MANIFEST = '0';
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-a');
    await sessionStart(registry, h, 'sess-b');
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.site, 'session_start_manifest'));
    expect(rows.length, 'the baseline arm needs a denominator too').toBeGreaterThan(0);
    expect(rows[0]?.channel).toBe('push');
    expect(rows[0]?.triggerType).toBe('session_start');
    expect(rows[0]?.projectId).toBe('proj-1');
    expect(rows.some((r) => r.memoryType === 'context_pack')).toBe(true);
    // COOD-85: freshness is snapshotted AT ACCESS TIME. A pack nobody
    // has verified reads `unverified` — never silently upgraded to
    // `fresh`, which is the whole point of the three-state model.
    expect(rows[0]?.freshnessStatusAtAccess).toBe('unverified');
  });

  it('records push rows in manifest mode too, with the smaller byte cost', async () => {
    process.env.COODRA_SESSION_MANIFEST = '1';
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-a');
    await sessionStart(registry, h, 'sess-b');
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.channel, 'push'));
    const packRow = rows.find((r) => r.memoryType === 'context_pack');
    expect(packRow).toBeDefined();
    // Manifest mode charges the index line, not the body — otherwise the
    // daily rollup would report a token saving that never happened.
    expect(packRow?.bytes ?? 0).toBeLessThan(80);
  });

  it('pairs a surfaced pack with a later pull into one cohort', async () => {
    process.env.COODRA_SESSION_MANIFEST = '1';
    const registry = buildRegistry(h);
    await seedPack(h, registry, 'sess-a');
    const context = await sessionStart(registry, h, 'sess-b');
    const packId = /`(cp_[0-9a-f-]+)`/.exec(context)?.[1];
    expect(packId, 'manifest must expose a pullable id').toBeDefined();

    // The agent does what the manifest told it to.
    // NOTE: read_context_pack's schema is `.strict()` with exactly one
    // of packId/runId and NO projectSlug — which is why the recorder
    // needs a session-only attribution fallback.
    await registry.handleCall('read_context_pack', { packId }, 'sess-b', { agentType: 'claude_code' });
    await settleAndDrain(h);

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.memoryAccessEvents)
      .where(eq(sqliteSchema.memoryAccessEvents.memoryId, packId ?? ''));
    // Surfaced then pulled: exactly the click-through that makes
    // stage-3 utilization measurable for the first time.
    expect(rows.some((r) => r.channel === 'push')).toBe(true);
    expect(rows.some((r) => r.channel === 'pull')).toBe(true);
  });
});
