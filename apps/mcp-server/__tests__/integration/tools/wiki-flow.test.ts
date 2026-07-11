import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { createWikiSavePageToolRegistration } from '../../../src/tools/wiki-save-page/manifest.js';
import type { WikiSavePageOutput } from '../../../src/tools/wiki-save-page/schema.js';
import { createWikiSaveStructureToolRegistration } from '../../../src/tools/wiki-save-structure/manifest.js';
import type { WikiSaveStructureOutput } from '../../../src/tools/wiki-save-structure/schema.js';
import { createWikiStatusToolRegistration } from '../../../src/tools/wiki-status/manifest.js';
import type { WikiStatusOutput } from '../../../src/tools/wiki-status/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for the Module 10 Deep Wiki flow. Exercises the real
 * handlers end-to-end via the `ToolRegistry` against an in-memory SQLite
 * handle: structure pass (skeleton) → status → content pass (author each
 * page) → status, plus every soft-failure branch.
 *
 * COODRA_HOME is pinned to a fresh temp dir so `requireActorIdentityForTeamMode`
 * reads no team config and resolves to solo (actor=null) — deterministic
 * regardless of the developer's real ~/.coodra.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return { close: async () => client.close(), handle };
}

function buildRegistry(handle: SqliteHandle): ToolRegistry {
  const registry = new ToolRegistry({ deps: makeFakeDeps() });
  registry.register(createGetRunIdToolRegistration({ db: handle, mode: 'solo' }));
  registry.register(createWikiSaveStructureToolRegistration({ db: handle }));
  registry.register(createWikiSavePageToolRegistration({ db: handle }));
  registry.register(createWikiStatusToolRegistration({ db: handle }));
  return registry;
}

function unwrap<T>(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): T {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: T };
  if (!parsed.ok || parsed.data === undefined) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

async function mintRun(registry: ToolRegistry, projectSlug: string, sessionId: string): Promise<string> {
  const result = await registry.handleCall('get_run_id', { projectSlug }, sessionId, { agentType: 'claude_code' });
  const out = unwrap<GetRunIdOutput>(result);
  if (!out.ok) throw new Error(`get_run_id failed: ${JSON.stringify(out)}`);
  return out.runId;
}

function twoPageStructure() {
  return {
    schemaVersion: 1 as const,
    title: 'Coodra',
    description: 'An MCP coordination platform for AI coding agents.',
    mode: 'comprehensive' as const,
    sections: [{ id: 'overview', title: 'Overview', pageIds: ['intro', 'mcp-server'], subsectionIds: [] }],
    pages: [
      {
        id: 'intro',
        title: 'Introduction',
        description: 'what it is',
        importance: 'high' as const,
        parentId: null,
        relevantFiles: ['README.md'],
        relatedPageIds: ['mcp-server'],
        wantsDiagram: true,
      },
      {
        id: 'mcp-server',
        title: 'MCP Server',
        description: 'tool manifest',
        importance: 'medium' as const,
        parentId: 'intro',
        relevantFiles: ['apps/mcp-server/src/index.ts'],
        relatedPageIds: [],
        wantsDiagram: false,
      },
    ],
  };
}

describe('Deep Wiki flow — structure → status → content → status', () => {
  let h: Harness;
  let prevHome: string | undefined;
  let prevMode: string | undefined;

  beforeEach(async () => {
    prevHome = process.env.COODRA_HOME;
    prevMode = process.env.COODRA_MODE;
    process.env.COODRA_HOME = mkdtempSync(join(tmpdir(), 'wiki-home-'));
    // Deterministic solo for the flow tests (no team-sync enqueue). The
    // team-mode enqueue is exercised in its own test below.
    process.env.COODRA_MODE = 'solo';
    h = await openHarness();
  });

  afterEach(async () => {
    await h.close();
    if (process.env.COODRA_HOME?.startsWith(join(tmpdir(), 'wiki-home-'))) {
      rmSync(process.env.COODRA_HOME, { recursive: true, force: true });
    }
    if (prevHome === undefined) delete process.env.COODRA_HOME;
    else process.env.COODRA_HOME = prevHome;
    if (prevMode === undefined) delete process.env.COODRA_MODE;
    else process.env.COODRA_MODE = prevMode;
  });

  it('runs the full two-pass flow and tracks per-page progress', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_1');

    // PASS 1 — structure.
    const struct = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_1',
      ),
    );
    expect(struct.ok).toBe(true);
    if (!struct.ok) return;
    expect(struct.status).toBe('created');
    expect(struct.pageCount).toBe(2);
    expect(struct.pendingPageIds.sort()).toEqual(['intro', 'mcp-server']);
    const wikiId = struct.wikiId;

    // STATUS — both pending.
    const status1 = unwrap<WikiStatusOutput>(await registry.handleCall('wiki_status', { wikiId }, 'sess_1'));
    expect(status1.ok && status1.pendingCount).toBe(2);
    expect(status1.ok && status1.authoredCount).toBe(0);

    // PASS 2 — author page 1.
    const page1 = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        {
          runId,
          wikiId,
          pageId: 'intro',
          content: {
            contentMarkdown: '# Intro\n\n```mermaid\ngraph TD; A-->B;\n```',
            citations: [{ file: 'README.md' }],
          },
        },
        'sess_1',
      ),
    );
    expect(page1.ok).toBe(true);
    if (page1.ok) {
      expect(page1.state).toBe('authored');
      expect(page1.authoredCount).toBe(1);
      expect(page1.remaining).toBe(1);
    }

    // PASS 2 — author page 2.
    const page2 = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        { runId, wikiId, pageId: 'mcp-server', content: { contentMarkdown: '# MCP Server' } },
        'sess_1',
      ),
    );
    expect(page2.ok && page2.remaining).toBe(0);

    // STATUS — done.
    const status2 = unwrap<WikiStatusOutput>(await registry.handleCall('wiki_status', { wikiId }, 'sess_1'));
    expect(status2.ok && status2.pendingCount).toBe(0);
    expect(status2.ok && status2.authoredCount).toBe(2);

    // DB assertions — body + citations persisted.
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.wikiId, wikiId));
    const intro = rows.find((r) => r.pageId === 'intro');
    expect(intro?.state).toBe('authored');
    expect(intro?.contentMarkdown).toContain('mermaid');
    expect(JSON.parse(intro?.citations ?? '[]')).toEqual([{ file: 'README.md' }]);
  });

  it('lint-gates mermaid: broken diagrams and missing wantsDiagram diagrams are rejected before the write', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_mmd');
    const struct = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_mmd',
      ),
    );
    if (!struct.ok) throw new Error('structure save failed');
    const wikiId = struct.wikiId;

    // Broken diagram (the classic unquoted-parens label) → invalid_mermaid.
    const broken = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        {
          runId,
          wikiId,
          pageId: 'intro',
          content: { contentMarkdown: '# Intro\n\n```mermaid\nflowchart TD\n  A[calls fn(x)] --> B\n```' },
        },
        'sess_mmd',
      ),
    );
    expect(broken.ok).toBe(false);
    if (!broken.ok && broken.error === 'invalid_mermaid') {
      expect(broken.issues.length).toBeGreaterThan(0);
      expect(broken.issues[0]?.message).toContain('double quotes');
    } else {
      throw new Error(`expected invalid_mermaid, got ${JSON.stringify(broken)}`);
    }

    // wantsDiagram page with no ```mermaid block → diagram_missing.
    const missing = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        { runId, wikiId, pageId: 'intro', content: { contentMarkdown: '# Intro\n\nprose only' } },
        'sess_mmd',
      ),
    );
    expect(!missing.ok && missing.error).toBe('diagram_missing');

    // Neither rejection wrote anything — the page is still pending.
    const status = unwrap<WikiStatusOutput>(await registry.handleCall('wiki_status', { wikiId }, 'sess_mmd'));
    expect(status.ok && status.pendingCount).toBe(2);

    // The corrected diagram (quoted label) is accepted.
    const fixed = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        {
          runId,
          wikiId,
          pageId: 'intro',
          content: { contentMarkdown: '# Intro\n\n```mermaid\nflowchart TD\n  A["calls fn(x)"] --> B\n```' },
        },
        'sess_mmd',
      ),
    );
    expect(fixed.ok).toBe(true);
  });

  it('re-planning the same slug replaces the wiki (status=replaced, pages reset to pending)', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_2');
    const first = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_2',
      ),
    );
    expect(first.ok && first.status).toBe('created');
    if (!first.ok) return;
    await registry.handleCall(
      'wiki_save_page',
      { runId, wikiId: first.wikiId, pageId: 'intro', content: { contentMarkdown: '# Intro v1' } },
      'sess_2',
    );

    // Re-plan with a single different page.
    const replan = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        {
          runId,
          slug: 'coodra',
          structure: {
            schemaVersion: 1 as const,
            title: 'Coodra v2',
            description: 'redo',
            mode: 'concise' as const,
            sections: [],
            pages: [
              {
                id: 'architecture',
                title: 'Architecture',
                description: 'x',
                importance: 'high' as const,
                parentId: null,
                relevantFiles: [],
                relatedPageIds: [],
                wantsDiagram: false,
              },
            ],
          },
        },
        'sess_2',
      ),
    );
    expect(replan.ok && replan.status).toBe('replaced');
    expect(replan.ok && replan.wikiId).toBe(first.wikiId); // same wiki id, replaced in place
    expect(replan.ok && replan.pageCount).toBe(1);

    const status = unwrap<WikiStatusOutput>(
      await registry.handleCall('wiki_status', { wikiId: first.wikiId }, 'sess_2'),
    );
    expect(status.ok && status.pages.map((p) => p.pageId)).toEqual(['architecture']);
    expect(status.ok && status.authoredCount).toBe(0); // old authored page is gone
  });

  it('refuses to re-plan a wiki with authored pages unless replace: true (wiki_exists guard)', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_guard');
    const first = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_guard',
      ),
    );
    if (!first.ok) throw new Error('structure save failed');

    // Author 'mcp-server' (wantsDiagram: false — prose passes the mermaid gate).
    const authored = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        { runId, wikiId: first.wikiId, pageId: 'mcp-server', content: { contentMarkdown: '# MCP Server' } },
        'sess_guard',
      ),
    );
    expect(authored.ok).toBe(true);

    // Re-plan the SAME slug without replace → wiki_exists soft-failure.
    const blocked = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_guard',
      ),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.error === 'wiki_exists') {
      expect(blocked.wikiId).toBe(first.wikiId);
      expect(blocked.authoredCount).toBe(1);
      expect(blocked.pageCount).toBe(2);
      expect(blocked.howToFix.length).toBeGreaterThan(0);
    } else {
      throw new Error(`expected wiki_exists, got ${JSON.stringify(blocked)}`);
    }

    // Nothing was modified — the authored page survived the refused re-plan.
    const status = unwrap<WikiStatusOutput>(
      await registry.handleCall('wiki_status', { wikiId: first.wikiId }, 'sess_guard'),
    );
    expect(status.ok && status.authoredCount).toBe(1);
    expect(status.ok && status.pages.find((p) => p.pageId === 'mcp-server')?.state).toBe('authored');
  });

  it('replace: true re-plans even with authored pages (status=replaced, pages reset to pending)', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_force');
    const first = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_force',
      ),
    );
    if (!first.ok) throw new Error('structure save failed');
    const authored = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        { runId, wikiId: first.wikiId, pageId: 'mcp-server', content: { contentMarkdown: '# MCP Server' } },
        'sess_force',
      ),
    );
    expect(authored.ok).toBe(true);

    const replaced = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure(), replace: true },
        'sess_force',
      ),
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.status).toBe('replaced');
    expect(replaced.wikiId).toBe(first.wikiId);
    expect(replaced.pendingPageIds.sort()).toEqual(['intro', 'mcp-server']);

    // The authored page was wiped by the destructive re-plan — all pending.
    const status = unwrap<WikiStatusOutput>(
      await registry.handleCall('wiki_status', { wikiId: first.wikiId }, 'sess_force'),
    );
    expect(status.ok && status.authoredCount).toBe(0);
    expect(status.ok && status.pendingCount).toBe(2);
  });

  it('re-plans a pending-only wiki freely without replace (no authored pages → no guard)', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_pending');
    const first = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_pending',
      ),
    );
    expect(first.ok && first.status).toBe('created');
    if (!first.ok) return;

    // Nothing authored yet — same-session plan iteration replaces freely.
    const second = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_pending',
      ),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe('replaced');
    expect(second.wikiId).toBe(first.wikiId);
  });

  it('returns run_not_found for an unknown runId', async () => {
    const registry = buildRegistry(h.handle);
    const out = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId: 'run_does_not_exist', slug: 'coodra', structure: twoPageStructure() },
        'sess_3',
      ),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('run_not_found');
  });

  it('wiki_save_page returns wiki_not_found for an unknown wikiId', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_4');
    const out = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        { runId, wikiId: 'wiki_ghost', pageId: 'intro', content: { contentMarkdown: '# x' } },
        'sess_4',
      ),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('wiki_not_found');
  });

  it('wiki_save_page returns page_not_in_structure for a pageId not in the skeleton', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_5');
    const struct = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_5',
      ),
    );
    if (!struct.ok) throw new Error('structure save failed');
    const out = unwrap<WikiSavePageOutput>(
      await registry.handleCall(
        'wiki_save_page',
        { runId, wikiId: struct.wikiId, pageId: 'nonexistent-page', content: { contentMarkdown: '# x' } },
        'sess_5',
      ),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('page_not_in_structure');
  });

  it('wiki_status returns wiki_not_found for an unknown wikiId', async () => {
    const registry = buildRegistry(h.handle);
    const out = unwrap<WikiStatusOutput>(await registry.handleCall('wiki_status', { wikiId: 'wiki_ghost' }, 'sess_6'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('wiki_not_found');
  });

  it('team mode enqueues sync_to_cloud jobs for wikis + wiki_pages (Phase 6 push wiring)', async () => {
    // Flip to team mode for this test. The temp COODRA_HOME has no team
    // config, so requireActorIdentityForTeamMode resolves solo (actor=null)
    // and the handler proceeds — but the enqueue guard keys on COODRA_MODE,
    // so the sync_to_cloud jobs are written. (Cloud push itself needs a live
    // Postgres and is covered by the sync-daemon's own integration tests.)
    process.env.COODRA_MODE = 'team';
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'coodra', 'sess_7');
    const struct = unwrap<WikiSaveStructureOutput>(
      await registry.handleCall(
        'wiki_save_structure',
        { runId, slug: 'coodra', structure: twoPageStructure() },
        'sess_7',
      ),
    );
    if (!struct.ok) throw new Error('structure save failed');
    // The 'mcp-server' page has wantsDiagram: false — prose-only content
    // passes the mermaid gate; this test is about the sync enqueue.
    await registry.handleCall(
      'wiki_save_page',
      { runId, wikiId: struct.wikiId, pageId: 'mcp-server', content: { contentMarkdown: '# MCP Server' } },
      'sess_7',
    );

    const jobs = await h.handle.db
      .select({ payload: sqliteSchema.pendingJobs.payload })
      .from(sqliteSchema.pendingJobs)
      .where(eq(sqliteSchema.pendingJobs.queue, 'sync_to_cloud'));
    const tables = jobs.map((j) => (JSON.parse(j.payload) as { table?: string }).table);
    expect(tables).toContain('wikis');
    expect(tables).toContain('wiki_pages');
  });
});
