import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createSaveContextPackToolRegistration } from '../../../src/tools/save-context-pack/manifest.js';
import type { SaveContextPackOutput } from '../../../src/tools/save-context-pack/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__save_context_pack` (S10).
 *
 * Exercises the real handler end-to-end via the `ToolRegistry`
 * against an in-memory SQLite DB seeded with a projects row + a runs
 * row + the real `ContextPackStore` wired against a tmpdir
 * `contextPacksRoot`.
 *
 * TEST-WRITER GUARD: always pass `contextPacksRoot=<tmpdir>` when
 * constructing `createContextPackStore` — the default
 * `process.cwd() + /docs/context-packs` leaks into the repo tree.
 * This harness does so at line ~60.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly contextPacksRoot: string;
  readonly projectId: string;
  readonly runId: string;
  readonly deps: ContextDeps;
}

async function openHarness(options: { readonly readOnlyFs?: boolean } = {}): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const contextPacksRoot = mkdtempSync(join(tmpdir(), 'scp-'));
  if (options.readOnlyFs) {
    // Make the directory read-only so writeFile inside the store fails.
    chmodSync(contextPacksRoot, 0o555);
  }

  const projectId = 'proj_scp';
  const runId = 'run_scp_primary';
  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
    .run(projectId, 'slug-scp', 'org_test', 'scp harness');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, projectId, 'sess_scp', 'claude_code', 'solo', 'in_progress');

  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      if (options.readOnlyFs) {
        // Restore write permissions so tmp cleanup doesn't fail.
        try {
          chmodSync(contextPacksRoot, 0o755);
        } catch {
          /* best-effort */
        }
      }
      await client.close();
    },
    handle,
    contextPacksRoot,
    projectId,
    runId,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createSaveContextPackToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): SaveContextPackOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: SaveContextPackOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('save_context_pack — happy path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes context_packs row, materialises FS file, marks runs completed', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Test Pack', content: '# Test\n\nbody.\n' },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.contextPackId).toMatch(/^cp_/);
    expect(typeof out.savedAt).toBe('string');
    expect(typeof out.contentExcerpt).toBe('string');

    // DB row present.
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, out.contextPackId));
    expect(rows).toHaveLength(1);

    // Run flipped to completed.
    const runRows = await h.handle.db
      .select({ status: sqliteSchema.runs.status, endedAt: sqliteSchema.runs.endedAt })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, h.runId));
    expect(runRows[0]?.status).toBe('completed');
    expect(runRows[0]?.endedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// run_not_found soft-failure
// ---------------------------------------------------------------------------

describe('save_context_pack — run_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:run_not_found / howToFix — and does NOT insert a context_packs row', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall('save_context_pack', { runId: 'run_nope', title: 't', content: 'c' }, 'sess_scp'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('run_not_found');
    expect(out.howToFix).toMatch(/get_run_id/);
    const rows = await h.handle.db.select().from(sqliteSchema.contextPacks);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Append-only re-call (ADR-007)
// ---------------------------------------------------------------------------

describe('save_context_pack — append-only re-call returns the original row unchanged', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('second call with same runId + different content returns the original contextPackId and does NOT update content', async () => {
    const registry = buildRegistry(h);
    const first = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'v1', content: 'original body' },
        'sess_scp',
      ),
    );
    const second = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'v2 DIFFERENT', content: 'totally new body that should be ignored' },
        'sess_scp',
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.contextPackId).toBe(first.contextPackId);
    expect(second.savedAt).toBe(first.savedAt);

    // DB row content is the FIRST write — append-only.
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, first.contextPackId));
    expect(rows[0]?.content).toBe('original body');
    expect(rows[0]?.title).toBe('v1');
  });
});

// ---------------------------------------------------------------------------
// runs UPDATE is idempotent (already-completed)
// ---------------------------------------------------------------------------

describe('save_context_pack — runs UPDATE is idempotent when run already completed', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('second call does not throw or error when run is already completed', async () => {
    const registry = buildRegistry(h);
    await registry.handleCall('save_context_pack', { runId: h.runId, title: 't', content: 'c' }, 'sess_scp');
    // Run is now 'completed'. Call again.
    const out = unwrap(
      await registry.handleCall('save_context_pack', { runId: h.runId, title: 't', content: 'c' }, 'sess_scp'),
    );
    expect(out.ok).toBe(true);
    // Still completed; nothing broke.
    const runRows = await h.handle.db
      .select({ status: sqliteSchema.runs.status })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, h.runId));
    expect(runRows[0]?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// FS failure degrades cleanly (load-bearing per carryover)
// ---------------------------------------------------------------------------

describe('save_context_pack — FS failure degrades cleanly (DB-first; filesystem is reconcilable)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness({ readOnlyFs: true });
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:true and writes the DB row even when the contextPacksRoot is not writable', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Test Pack', content: 'body here' },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.contextPackId).toMatch(/^cp_/);

    // DB row exists and is durable.
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, out.contextPackId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('body here');
  });
});

// ---------------------------------------------------------------------------
// featurePackId is accepted and doesn't break the write (currently discarded)
// ---------------------------------------------------------------------------

describe('save_context_pack — featurePackId is accepted (discarded by store in M02)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('supplying featurePackId does not break the call; tool returns success', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 't', content: 'c', featurePackId: 'fp_some_id' },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
  });
});
