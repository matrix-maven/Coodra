import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq, inArray } from 'drizzle-orm';
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

  it('links the Context Pack and run to a Work Pack by slug', async () => {
    h.handle.raw
      .prepare(
        `INSERT INTO work_packs
          (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('work_1', h.projectId, 'cood-10', 'COOD-10', 'task', 'draft', '', '', '', '{}');
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Initial COOD-10 context', content: 'ready', workPackSlug: 'cood-10' },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const contextRows = await h.handle.db
      .select({ workPackId: sqliteSchema.contextPacks.workPackId })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, out.contextPackId));
    const runRows = await h.handle.db
      .select({ workPackId: sqliteSchema.runs.workPackId })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, h.runId));
    expect(contextRows[0]?.workPackId).toBe('work_1');
    expect(runRows[0]?.workPackId).toBe('work_1');

    // coodra-work redesign, round 2 — the many-to-many join table also
    // gets a row for the primary workPackSlug link.
    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackContextPackLinks)
      .where(eq(sqliteSchema.workPackContextPackLinks.contextPackId, out.contextPackId));
    expect(links.map((l) => l.workPackId)).toEqual(['work_1']);
  });
});

// ---------------------------------------------------------------------------
// coodra-work redesign round 2 — work_pack_context_pack_links (many-to-many)
// ---------------------------------------------------------------------------

function seedWorkPack(h: Harness, id: string, slug: string): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_packs
        (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, h.projectId, slug, `pack ${slug}`, 'task', 'draft', '', '', '', '{}');
}

describe('save_context_pack — alsoLinkWorkPackSlugs (additive multi-pack linking)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('links to both the primary workPackSlug pack and any alsoLinkWorkPackSlugs packs', async () => {
    seedWorkPack(h, 'wp_1', 'pack-1');
    seedWorkPack(h, 'wp_2', 'pack-2');
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        {
          runId: h.runId,
          title: 'cross-pack recap',
          content: 'body',
          workPackSlug: 'pack-1',
          alsoLinkWorkPackSlugs: ['pack-2'],
        },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Primary link still goes through the single-column fields unchanged.
    const contextRows = await h.handle.db
      .select({ workPackId: sqliteSchema.contextPacks.workPackId })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, out.contextPackId));
    expect(contextRows[0]?.workPackId).toBe('wp_1');

    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackContextPackLinks)
      .where(eq(sqliteSchema.workPackContextPackLinks.contextPackId, out.contextPackId));
    expect(links.map((l) => l.workPackId).sort()).toEqual(['wp_1', 'wp_2']);
  });

  it('links to alsoLinkWorkPackSlugs even when no primary workPackSlug is given', async () => {
    seedWorkPack(h, 'wp_1', 'pack-1');
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'no primary pack', content: 'body', alsoLinkWorkPackSlugs: ['pack-1'] },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const contextRows = await h.handle.db
      .select({ workPackId: sqliteSchema.contextPacks.workPackId })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, out.contextPackId));
    expect(contextRows[0]?.workPackId).toBeNull();

    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackContextPackLinks)
      .where(eq(sqliteSchema.workPackContextPackLinks.contextPackId, out.contextPackId));
    expect(links.map((l) => l.workPackId)).toEqual(['wp_1']);
  });

  it('skips (does not error) an unresolvable alsoLinkWorkPackSlugs entry', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'dangling', content: 'body', alsoLinkWorkPackSlugs: ['does-not-exist'] },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const links = await h.handle.db
      .select()
      .from(sqliteSchema.workPackContextPackLinks)
      .where(eq(sqliteSchema.workPackContextPackLinks.contextPackId, out.contextPackId));
    expect(links).toHaveLength(0);
  });

  it('bumps lastActivityAt/latestContextPackId for a Work Pack linked ONLY via alsoLinkWorkPackSlugs (secondary), not just the primary workPackSlug', async () => {
    // Regression coverage for a review finding: the activity rollup was
    // previously only bumped for the primary Work Pack (inside
    // ctx.contextPack.write() itself) — a Work Pack reachable only
    // through the secondary m2m link table never got its
    // lastActivityAt/latestContextPackId touched at all.
    seedWorkPack(h, 'wp_1', 'pack-1');
    seedWorkPack(h, 'wp_2', 'pack-2');
    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'save_context_pack',
        {
          runId: h.runId,
          title: 'cross-pack recap',
          content: 'body',
          workPackSlug: 'pack-1',
          alsoLinkWorkPackSlugs: ['pack-2'],
        },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const workPacks = await h.handle.db
      .select({
        id: sqliteSchema.workPacks.id,
        lastActivityAt: sqliteSchema.workPacks.lastActivityAt,
        latestContextPackId: sqliteSchema.workPacks.latestContextPackId,
      })
      .from(sqliteSchema.workPacks)
      .where(inArray(sqliteSchema.workPacks.id, ['wp_1', 'wp_2']));
    const byId = new Map(workPacks.map((w) => [w.id, w]));

    expect(byId.get('wp_1')?.lastActivityAt).not.toBeNull();
    expect(byId.get('wp_1')?.latestContextPackId).toBe(out.contextPackId);
    // The secondary-only Work Pack (wp_2) must also be bumped.
    expect(byId.get('wp_2')?.lastActivityAt).not.toBeNull();
    expect(byId.get('wp_2')?.latestContextPackId).toBe(out.contextPackId);
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
// Append-only redesign (2026-08-05) — distinct content creates a new row;
// only an EXACT (title, content) match is a true idempotent retry.
// ---------------------------------------------------------------------------

describe('save_context_pack — append-only redesign', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('second call with same runId + genuinely different content creates a NEW row, does not touch the first', async () => {
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
        { runId: h.runId, title: 'v2 DIFFERENT', content: 'a genuinely different second unit of work' },
        'sess_scp',
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.contextPackId).not.toBe(first.contextPackId);
    expect(second.status).toBe('created');

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, h.runId));
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((r) => r.id === first.contextPackId);
    const secondRow = rows.find((r) => r.id === second.contextPackId);
    expect(firstRow?.content).toBe('original body');
    expect(firstRow?.title).toBe('v1');
    expect(secondRow?.content).toBe('a genuinely different second unit of work');
    expect(secondRow?.title).toBe('v2 DIFFERENT');
  });

  it('second call with IDENTICAL title+content is a true idempotent retry — no duplicate row', async () => {
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
        { runId: h.runId, title: 'v1', content: 'original body' },
        'sess_scp',
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.contextPackId).toBe(first.contextPackId);
    expect(second.savedAt).toBe(first.savedAt);
    expect(second.status).toBe('idempotent_hit');

    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, h.runId));
    expect(rows).toHaveLength(1);
  });

  it('an identical-content re-call can still attach an existing unlinked Context Pack to a Work Pack', async () => {
    h.handle.raw
      .prepare(
        `INSERT INTO work_packs
          (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('work_2', h.projectId, 'cood-12', 'COOD-12', 'task', 'draft', '', '', '', '{}');
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
        { runId: h.runId, title: 'v1', content: 'original body', workPackSlug: 'cood-12' },
        'sess_scp',
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.contextPackId).toBe(first.contextPackId);
    expect(second.status).toBe('idempotent_hit');

    const contextRows = await h.handle.db
      .select({
        content: sqliteSchema.contextPacks.content,
        title: sqliteSchema.contextPacks.title,
        workPackId: sqliteSchema.contextPacks.workPackId,
      })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.id, first.contextPackId));
    const runRows = await h.handle.db
      .select({ workPackId: sqliteSchema.runs.workPackId })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, h.runId));
    expect(contextRows[0]?.content).toBe('original body');
    expect(contextRows[0]?.title).toBe('v1');
    expect(contextRows[0]?.workPackId).toBe('work_2');
    expect(runRows[0]?.workPackId).toBe('work_2');
  });

  it('a second, different-content save linked to a different Work Pack lands its own row with its own lastActivityAt/latestContextPackId rollup', async () => {
    h.handle.raw
      .prepare(
        `INSERT INTO work_packs
          (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'work_a',
        h.projectId,
        'mt-3',
        'MT-3',
        'task',
        'draft',
        '',
        '',
        '',
        '{}',
        'work_b',
        h.projectId,
        'security-audit',
        'Security audit',
        'unknown',
        'draft',
        '',
        '',
        '',
        '{}',
      );
    const registry = buildRegistry(h);
    const syncPack = unwrap(
      await registry.handleCall(
        'save_context_pack',
        {
          runId: h.runId,
          title: 'Jira sync',
          content: 'Synced MT-3 into Coodra as a Work Pack.',
          workPackSlug: 'mt-3',
          kind: 'sync',
        },
        'sess_scp',
      ),
    );
    const auditPack = unwrap(
      await registry.handleCall(
        'save_context_pack',
        {
          runId: h.runId,
          title: 'Security audit findings',
          content: 'No committed secrets found; 5 medium findings.',
          workPackSlug: 'security-audit',
          kind: 'audit_findings',
        },
        'sess_scp',
      ),
    );
    expect(syncPack.ok).toBe(true);
    expect(auditPack.ok).toBe(true);
    if (!syncPack.ok || !auditPack.ok) return;
    expect(auditPack.contextPackId).not.toBe(syncPack.contextPackId);

    const workPackRows = await h.handle.db
      .select({
        id: sqliteSchema.workPacks.id,
        lastActivityAt: sqliteSchema.workPacks.lastActivityAt,
        latestContextPackId: sqliteSchema.workPacks.latestContextPackId,
      })
      .from(sqliteSchema.workPacks);
    const workA = workPackRows.find((r) => r.id === 'work_a');
    const workB = workPackRows.find((r) => r.id === 'work_b');
    expect(workA?.latestContextPackId).toBe(syncPack.contextPackId);
    expect(workA?.lastActivityAt).not.toBeNull();
    expect(workB?.latestContextPackId).toBe(auditPack.contextPackId);
    expect(workB?.lastActivityAt).not.toBeNull();
  });

  it('bridge_auto upgrade is scoped to the MOST RECENT row for a run, not any row', async () => {
    // Seed a bridge_auto row directly (mirrors the bridge's own auto-save
    // path — never goes through save_context_pack's own 'agent' source).
    h.handle.raw
      .prepare(
        `INSERT INTO context_packs
          (id, org_id, run_id, project_id, title, content, content_excerpt, source, work_pack_id, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, 'bridge_auto', NULL, unixepoch())`,
      )
      .run('cp_bridge_auto', h.runId, h.projectId, 'auto title', 'auto content', 'auto content');

    const registry = buildRegistry(h);
    // First agent save: the run's only row is the bridge_auto one and is
    // its most recent — upgrades in place rather than inserting.
    const upgraded = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'agent v1', content: 'agent-authored content' },
        'sess_scp',
      ),
    );
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    expect(upgraded.contextPackId).toBe('cp_bridge_auto');
    expect(upgraded.status).toBe('upgraded_from_bridge_auto');
    expect(upgraded.source).toBe('agent');

    let rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, h.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('agent');
    expect(rows[0]?.content).toBe('agent-authored content');

    // Second agent save, different content: the most recent row is now
    // 'agent', not 'bridge_auto' — no upgrade path applies, so this
    // inserts a NEW row instead of upgrading the first one again.
    const second = unwrap(
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'agent v2', content: 'a second, different unit of work' },
        'sess_scp',
      ),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe('created');
    expect(second.contextPackId).not.toBe('cp_bridge_auto');

    rows = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, h.runId));
    expect(rows).toHaveLength(2);
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
// COOD-91 — meta.decisionIds must resolve, or say so
// ---------------------------------------------------------------------------

/**
 * The pack still saves in every case here. Rejecting it would lose a
 * whole recap because one id was mistyped, which is a worse outcome than
 * a pack with one bad link — but the caller has to be TOLD, which is
 * what was missing.
 */
describe('save_context_pack — COOD-91 decisionIds resolution', () => {
  let h: Harness;
  const FULL = 'dec_367d21cf-df81-4ee7-b482-ab2e2666b4fa';

  beforeEach(async () => {
    h = await openHarness();
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(FULL, h.projectId, 'idem_scp_dec', h.runId, 'seeded', 'seeded', 1000);
  });
  afterEach(async () => {
    await h.close();
  });

  async function save(decisionIds: string[]) {
    return unwrap(
      await buildRegistry(h).handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Pack', content: '# Pack\n', meta: { decisionIds } },
        'sess_scp',
      ),
    );
  }

  function storedIds(): string[] {
    const row = h.handle.raw.prepare(`SELECT meta FROM context_packs LIMIT 1`).get() as
      | { meta: string | null }
      | undefined;
    const meta = JSON.parse(row?.meta ?? '{}') as { decisionIds?: string[] };
    return meta.decisionIds ?? [];
  }

  it('stores a full id unchanged and warns about nothing', async () => {
    const out = await save([FULL]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.warnings).toBeUndefined();
    expect(storedIds()).toEqual([FULL]);
  });

  it('expands a truncated prefix — the exact COOD-77 failure', async () => {
    // Three packs stored `dec_367d21cf` and every link was silently dead.
    const out = await save(['dec_367d21cf']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(storedIds(), 'the stored meta must carry the FULL id').toEqual([FULL]);
    expect(out.warnings).toBeUndefined();
  });

  it('saves the pack but warns when an id resolves to nothing', async () => {
    const out = await save(['dec_deadbeef']);
    expect(out.ok, 'the pack must still save').toBe(true);
    if (!out.ok) return;
    expect(out.contextPackId).toMatch(/^cp_/);
    expect(out.warnings?.join(' ')).toContain('dec_deadbeef');
  });

  it('keeps an unresolvable id rather than dropping it', async () => {
    // Deleting the evidence would make the warning unactionable — the
    // agent meant something by that id.
    await save(['dec_deadbeef']);
    expect(storedIds()).toEqual(['dec_deadbeef']);
  });

  it('resolves what it can and warns about the rest in one save', async () => {
    const out = await save(['dec_367d21cf', 'dec_deadbeef']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(storedIds()).toEqual([FULL, 'dec_deadbeef']);
    expect(out.warnings).toHaveLength(1);
  });

  it('adds no warnings field when meta carries no decisionIds', async () => {
    const out = unwrap(
      await buildRegistry(h).handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Pack', content: '# Pack\n', meta: { testStatus: 'pass' } },
        'sess_scp',
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.warnings).toBeUndefined();
  });
});
