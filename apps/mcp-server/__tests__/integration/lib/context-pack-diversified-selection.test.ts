import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectDiversifiedRecentContextPacks } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';

/**
 * Integration tests for `selectDiversifiedRecentContextPacks` (append-
 * only redesign, 2026-08-05). This is the selection policy behind
 * SessionStart's "recent context" injection — no prior test existed
 * since the function is brand new. Seeds `context_packs`/`work_packs`
 * directly via raw SQL for exact control over `createdAt`/`kind`/
 * `workPackId`, which the public `save_context_pack` tool (server-
 * generated timestamps) doesn't allow.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly projectId: string;
}

let h: Harness;

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const projectId = 'proj_diversify';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, 'slug-diversify', 'org_test', 'diversify harness');

  return {
    close: async () => {
      await client.close();
    },
    handle,
    projectId,
  };
}

function insertRun(h: Harness, id: string): void {
  h.handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, h.projectId, id, 'claude_code', 'solo', 'in_progress');
}

function insertWorkPack(h: Harness, id: string, slug: string): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_packs
        (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, h.projectId, slug, slug, 'task', 'draft', '', '', '', '{}');
}

function insertPack(
  h: Harness,
  args: {
    readonly id: string;
    readonly runId: string;
    readonly workPackId: string | null;
    readonly kind: string | null;
    readonly title: string;
    readonly createdAtEpochSeconds: number;
  },
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO context_packs
        (id, org_id, run_id, project_id, title, content, content_excerpt, source, work_pack_id, kind, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'agent', ?, ?, ?)`,
    )
    .run(
      args.id,
      args.runId,
      h.projectId,
      args.title,
      `${args.title} body`,
      `${args.title} body`,
      args.workPackId,
      args.kind,
      args.createdAtEpochSeconds,
    );
}

// Direct `work_pack_context_pack_links` insert — the secondary-link
// path `save_context_pack`'s `alsoLinkWorkPackSlugs` writes, exercised
// here without going through the tool so a pack can be given a
// secondary link independent of (or in addition to) its primary
// `work_pack_id`.
function insertSecondaryLink(h: Harness, workPackId: string, contextPackId: string): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_pack_context_pack_links (id, org_id, project_id, work_pack_id, context_pack_id)
       VALUES (?, NULL, ?, ?, ?)`,
    )
    .run(`wpcpl_${contextPackId}_${workPackId}`, h.projectId, workPackId, contextPackId);
}

describe('selectDiversifiedRecentContextPacks', () => {
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns one pack per distinct Work Pack, most-recently-active Work Pack first', async () => {
    insertRun(h, 'run_1');
    insertWorkPack(h, 'work_a', 'pack-a');
    insertWorkPack(h, 'work_b', 'pack-b');
    insertWorkPack(h, 'work_c', 'pack-c');
    insertPack(h, {
      id: 'cp_a',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: null,
      title: 'A',
      createdAtEpochSeconds: 100,
    });
    insertPack(h, {
      id: 'cp_b',
      runId: 'run_1',
      workPackId: 'work_b',
      kind: null,
      title: 'B',
      createdAtEpochSeconds: 300,
    });
    insertPack(h, {
      id: 'cp_c',
      runId: 'run_1',
      workPackId: 'work_c',
      kind: null,
      title: 'C',
      createdAtEpochSeconds: 200,
    });

    const result = await selectDiversifiedRecentContextPacks(h.handle, { projectId: h.projectId });
    expect(result.packs.map((p) => p.id)).toEqual(['cp_b', 'cp_c', 'cp_a']);
    expect(result.overflow).toEqual([]);
  });

  it('caps packs per Work Pack at maxPerWorkPack and records an overflow note for the rest', async () => {
    insertRun(h, 'run_1');
    insertWorkPack(h, 'work_a', 'pack-a');
    insertPack(h, {
      id: 'cp_1',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: null,
      title: '1',
      createdAtEpochSeconds: 100,
    });
    insertPack(h, {
      id: 'cp_2',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: null,
      title: '2',
      createdAtEpochSeconds: 200,
    });
    insertPack(h, {
      id: 'cp_3',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: null,
      title: '3',
      createdAtEpochSeconds: 300,
    });
    insertPack(h, {
      id: 'cp_4',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: null,
      title: '4',
      createdAtEpochSeconds: 400,
    });

    const result = await selectDiversifiedRecentContextPacks(h.handle, {
      projectId: h.projectId,
      maxPerWorkPack: 2,
    });
    // Newest two (no kind, so pure recency): cp_4, cp_3.
    expect(result.packs.map((p) => p.id)).toEqual(['cp_4', 'cp_3']);
    expect(result.overflow).toEqual([{ workPackSlug: 'pack-a', hiddenCount: 2 }]);
  });

  it('kind priority beats recency when trimming to maxPerWorkPack', async () => {
    insertRun(h, 'run_1');
    insertWorkPack(h, 'work_a', 'pack-a');
    // Newest is a low-priority 'sync'; an older 'final_recap' should still win a slot.
    insertPack(h, {
      id: 'cp_sync',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: 'sync',
      title: 'sync',
      createdAtEpochSeconds: 400,
    });
    insertPack(h, {
      id: 'cp_recap',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: 'final_recap',
      title: 'recap',
      createdAtEpochSeconds: 100,
    });
    insertPack(h, {
      id: 'cp_audit',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: 'audit_findings',
      title: 'audit',
      createdAtEpochSeconds: 300,
    });

    const result = await selectDiversifiedRecentContextPacks(h.handle, {
      projectId: h.projectId,
      maxPerWorkPack: 2,
    });
    // final_recap (rank 0) and audit_findings (rank 2) beat sync (rank 4)
    // despite sync being the most recently created.
    expect(result.packs.map((p) => p.id).sort()).toEqual(['cp_audit', 'cp_recap'].sort());
    expect(result.overflow).toEqual([{ workPackSlug: 'pack-a', hiddenCount: 1 }]);
  });

  it('ad hoc packs with no Work Pack are grouped by run and capped at maxPerRunWithoutWorkPack', async () => {
    insertRun(h, 'run_1');
    insertPack(h, { id: 'cp_1', runId: 'run_1', workPackId: null, kind: null, title: '1', createdAtEpochSeconds: 100 });
    insertPack(h, { id: 'cp_2', runId: 'run_1', workPackId: null, kind: null, title: '2', createdAtEpochSeconds: 200 });

    const result = await selectDiversifiedRecentContextPacks(h.handle, {
      projectId: h.projectId,
      maxPerRunWithoutWorkPack: 1,
    });
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]?.id).toBe('cp_2');
    expect(result.packs[0]?.workPackSlugs).toEqual([]);
    // No overflow note for the null-workPack bucket — overflow notes are
    // keyed by workPackSlug, which doesn't exist for ad hoc runs.
    expect(result.overflow).toEqual([]);
  });

  it('never exceeds startupBudget across Work Pack groups and the null-workPack bucket combined', async () => {
    insertRun(h, 'run_1');
    insertRun(h, 'run_2');
    insertWorkPack(h, 'work_a', 'pack-a');
    insertWorkPack(h, 'work_b', 'pack-b');
    insertPack(h, {
      id: 'cp_a1',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: null,
      title: 'a1',
      createdAtEpochSeconds: 500,
    });
    insertPack(h, {
      id: 'cp_b1',
      runId: 'run_1',
      workPackId: 'work_b',
      kind: null,
      title: 'b1',
      createdAtEpochSeconds: 400,
    });
    insertPack(h, {
      id: 'cp_none',
      runId: 'run_2',
      workPackId: null,
      kind: null,
      title: 'none',
      createdAtEpochSeconds: 300,
    });

    const result = await selectDiversifiedRecentContextPacks(h.handle, {
      projectId: h.projectId,
      startupBudget: 2,
    });
    expect(result.packs.length).toBeLessThanOrEqual(2);
  });

  it('a single chatty run spanning multiple Work Packs does not crowd out other runs’ Work Packs', async () => {
    // Reproduces the original bug scenario: one run touches several
    // units of work; a diversified selection must still surface all of
    // them (bounded by budget), not just whichever save happened last.
    insertRun(h, 'run_chatty');
    insertWorkPack(h, 'work_sync', 'mt-3');
    insertWorkPack(h, 'work_audit', 'security-audit');
    insertPack(h, {
      id: 'cp_sync',
      runId: 'run_chatty',
      workPackId: 'work_sync',
      kind: 'sync',
      title: 'Jira sync',
      createdAtEpochSeconds: 100,
    });
    insertPack(h, {
      id: 'cp_start',
      runId: 'run_chatty',
      workPackId: 'work_sync',
      kind: 'work_start',
      title: 'Implementation start',
      createdAtEpochSeconds: 200,
    });
    insertPack(h, {
      id: 'cp_audit',
      runId: 'run_chatty',
      workPackId: 'work_audit',
      kind: 'audit_findings',
      title: 'Security audit findings',
      createdAtEpochSeconds: 300,
    });

    const result = await selectDiversifiedRecentContextPacks(h.handle, { projectId: h.projectId });
    const ids = result.packs.map((p) => p.id);
    expect(ids).toContain('cp_audit');
    expect(ids).toContain('cp_start'); // work_start beats sync (rank 3 < rank 4) for the mt-3 slot(s)
    const slugs = new Set(result.packs.flatMap((p) => p.workPackSlugs));
    expect(slugs.has('mt-3')).toBe(true);
    expect(slugs.has('security-audit')).toBe(true);
  });

  it("a pack linked to a Work Pack ONLY via the secondary work_pack_context_pack_links table (no primary work_pack_id) still counts as that Work Pack's activity and is tagged with its slug", async () => {
    // Regression coverage for a review finding: grouping/tagging
    // previously used only the primary work_pack_id column, so a pack
    // whose sole connection to a Work Pack was the m2m link table was
    // invisible to that Work Pack's group entirely.
    insertRun(h, 'run_1');
    insertWorkPack(h, 'work_a', 'pack-a');
    insertPack(h, {
      id: 'cp_secondary_only',
      runId: 'run_1',
      workPackId: null,
      kind: 'audit_findings',
      title: 'secondary-only',
      createdAtEpochSeconds: 100,
    });
    insertSecondaryLink(h, 'work_a', 'cp_secondary_only');

    const result = await selectDiversifiedRecentContextPacks(h.handle, { projectId: h.projectId });
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]?.id).toBe('cp_secondary_only');
    expect(result.packs[0]?.workPackSlugs).toEqual(['pack-a']);
  });

  it('a pack linked to two Work Packs (primary + secondary) is tagged with both slugs but selected only once, not duplicated', async () => {
    insertRun(h, 'run_1');
    insertWorkPack(h, 'work_a', 'pack-a');
    insertWorkPack(h, 'work_b', 'pack-b');
    insertPack(h, {
      id: 'cp_dual',
      runId: 'run_1',
      workPackId: 'work_a',
      kind: 'audit_findings',
      title: 'dual-linked',
      createdAtEpochSeconds: 100,
    });
    insertSecondaryLink(h, 'work_b', 'cp_dual');

    const result = await selectDiversifiedRecentContextPacks(h.handle, { projectId: h.projectId });
    // Selected exactly once, not once per group it belongs to.
    expect(result.packs.filter((p) => p.id === 'cp_dual')).toHaveLength(1);
    expect(new Set(result.packs[0]?.workPackSlugs)).toEqual(new Set(['pack-a', 'pack-b']));
  });

  it('a very recent no-Work-Pack pack is not starved by several older-but-still-recent Work Pack groups (interleaved by recency, not Work-Pack-groups-first)', async () => {
    // Regression coverage for a review finding: the prior algorithm
    // exhausted startupBudget entirely on Work Pack groups before ever
    // considering the null-Work-Pack bucket, so a very recent ad hoc
    // save could be dropped outright whenever enough Work Packs existed.
    insertRun(h, 'run_1');
    for (const [id, slug, createdAt] of [
      ['work_a', 'pack-a', 600],
      ['work_b', 'pack-b', 500],
      ['work_c', 'pack-c', 400],
      ['work_d', 'pack-d', 300],
      ['work_e', 'pack-e', 200],
      ['work_f', 'pack-f', 100],
    ] as const) {
      insertWorkPack(h, id, slug);
      insertPack(h, {
        id: `cp_${id}`,
        runId: 'run_1',
        workPackId: id,
        kind: null,
        title: id,
        createdAtEpochSeconds: createdAt,
      });
    }
    // Most recent pack of all, but has no Work Pack.
    insertPack(h, {
      id: 'cp_adhoc',
      runId: 'run_1',
      workPackId: null,
      kind: 'audit_findings',
      title: 'ad hoc audit',
      createdAtEpochSeconds: 700,
    });

    const result = await selectDiversifiedRecentContextPacks(h.handle, {
      projectId: h.projectId,
      startupBudget: 6,
      maxPerWorkPack: 1,
    });
    expect(result.packs.map((p) => p.id)).toContain('cp_adhoc');
  });
});
