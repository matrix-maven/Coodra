import { createDb, migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { extractReferencedPaths, runMemoryGardeningOnce } from '../../src/memory-gardening-worker.js';

/**
 * COOD-86 — memory gardening.
 *
 * Coodra had no mechanical freshness check, so packs referencing
 * `apps/hooks-bridge` stayed authoritative for weeks after COOD-67
 * deleted that tree. Ranking a stale pack into position 1 is worse than
 * not retrieving it at all.
 *
 * The contract, in order of how badly a regression would hurt:
 *
 *   1. **It marks and proposes. It never rewrites.** Memory the user
 *      did not write and cannot see changing is worse than stale
 *      memory — at least stale memory is what somebody actually
 *      decided.
 *   2. **No false staleness.** A flag that fires on ordinary prose
 *      trains people to ignore it, which is worse than no flag.
 *   3. **Verdicts can improve.** A restored file flips an artifact back
 *      to fresh; a verdict that could only ever worsen would drift from
 *      reality in the one direction nobody notices.
 */

function openMigrated(): SqliteHandle {
  const handle = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return handle;
}

async function seed(handle: SqliteHandle, packContent: string): Promise<string> {
  await handle.db
    .insert(sqliteSchema.projects)
    .values({ id: 'proj-1', orgId: 'org-1', slug: 'p1', name: 'P1', cwd: '/repo' });
  await handle.db.insert(sqliteSchema.runs).values({
    id: 'run-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    agentType: 'claude_code',
    mode: 'solo',
  });
  await handle.db.insert(sqliteSchema.contextPacks).values({
    id: 'cp_1',
    orgId: 'org-1',
    runId: 'run-1',
    projectId: 'proj-1',
    title: 'storage notes',
    content: packContent,
  });
  return 'cp_1';
}

/** Filesystem stub: only the listed paths exist. */
function fsWith(present: readonly string[]) {
  const set = new Set(present);
  return async (_cwd: string, relPath: string): Promise<boolean> => set.has(relPath);
}

async function packRow(handle: SqliteHandle) {
  const rows = await handle.db.select().from(sqliteSchema.contextPacks).where(eq(sqliteSchema.contextPacks.id, 'cp_1'));
  return rows[0];
}

describe('extractReferencedPaths', () => {
  it('finds repo-relative source paths in prose', () => {
    const paths = extractReferencedPaths(
      'We moved the sweeper into packages/lifecycle/src/stale-runs-sweeper.ts and wired apps/mcp-server/src/index.ts.',
    );
    expect(paths).toContain('packages/lifecycle/src/stale-runs-sweeper.ts');
    expect(paths).toContain('apps/mcp-server/src/index.ts');
  });

  it('ignores bare filenames in ordinary prose', () => {
    // A looser pattern would match "config.json" here and manufacture
    // staleness out of ordinary writing — a flag that cries wolf is
    // worse than no flag.
    const paths = extractReferencedPaths('Update config.json and then run package.json scripts.');
    expect(paths).toEqual([]);
  });

  it('is bounded so one enormous pack cannot dominate a pass', () => {
    const many = Array.from({ length: 60 }, (_v, i) => `packages/p/src/f${i}.ts`).join(' ');
    expect(extractReferencedPaths(many, 20).length).toBeLessThanOrEqual(20);
  });

  it('ignores package-relative paths, which prose writes constantly', () => {
    // Found on real data: packs say `src/run-diff-runner.ts` meaning
    // packages/lifecycle/src/..., and `__tests__/unit/x.test.ts` meaning
    // the one under packages/db/. Neither resolves from the repo root,
    // so accepting them produced a ~20% false-stale rate.
    const paths = extractReferencedPaths(
      'We moved it to src/run-diff-runner.ts and covered it in __tests__/unit/claude-permissions.test.ts.',
    );
    expect(paths).toEqual([]);
  });

  it('ignores elided paths, which are prose rather than references', () => {
    const paths = extractReferencedPaths('See apps/mcp-server/.../lifecycle-event/handler.ts for the shape.');
    expect(paths).toEqual([]);
  });
});

describe('runMemoryGardeningOnce — context packs', () => {
  it('marks a pack stale when a path it describes no longer exists', async () => {
    const handle = openMigrated();
    try {
      await seed(handle, 'The bridge lives in apps/hooks-bridge/src/index.ts and handles PreToolUse.');
      const result = await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith([]), // the tree was deleted
      });

      expect(result.packsMarkedStale).toBe(1);
      const row = await packRow(handle);
      expect(row?.freshnessStatus).toBe('stale');
      expect(row?.staleReason).toContain('apps/hooks-bridge/src/index.ts');
    } finally {
      handle.close();
    }
  });

  it('marks a pack fresh when everything it describes still exists', async () => {
    const handle = openMigrated();
    try {
      await seed(handle, 'Policy lives in packages/policy/src/policy.ts.');
      await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith(['packages/policy/src/policy.ts']),
      });
      const row = await packRow(handle);
      expect(row?.freshnessStatus).toBe('fresh');
      expect(row?.staleReason).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('leaves a pack with no verifiable paths as unverified', async () => {
    const handle = openMigrated();
    try {
      await seed(handle, 'We decided to prefer boring technology. No paths here.');
      const result = await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith([]),
      });
      expect(result.packsChecked, 'nothing to check against is not a verdict').toBe(0);
      const row = await packRow(handle);
      expect(row?.freshnessStatus).toBe('unverified');
    } finally {
      handle.close();
    }
  });

  it('NEVER rewrites pack content — only the freshness columns', async () => {
    const handle = openMigrated();
    try {
      const original = 'The bridge lives in apps/hooks-bridge/src/index.ts.';
      await seed(handle, original);
      await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith([]),
      });
      const row = await packRow(handle);
      expect(row?.content, 'gardening marks and proposes; it does not edit user memory').toBe(original);
      expect(row?.title).toBe('storage notes');
    } finally {
      handle.close();
    }
  });

  it('flips back to fresh when a missing file is restored', async () => {
    const handle = openMigrated();
    try {
      await seed(handle, 'See packages/policy/src/policy.ts for the evaluator.');
      await runMemoryGardeningOnce({ db: handle, projectCwd: '/repo', projectId: 'proj-1', pathExists: fsWith([]) });
      expect((await packRow(handle))?.freshnessStatus).toBe('stale');

      await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith(['packages/policy/src/policy.ts']),
      });
      // A verdict that could only ever worsen would drift from reality
      // in the one direction nobody would notice.
      expect((await packRow(handle))?.freshnessStatus).toBe('fresh');
    } finally {
      handle.close();
    }
  });
});

describe('runMemoryGardeningOnce — decisions', () => {
  it('marks a decision stale when a file it affects is gone', async () => {
    const handle = openMigrated();
    try {
      await seed(handle, 'no paths');
      await handle.db.insert(sqliteSchema.decisions).values({
        id: 'dec_1',
        orgId: 'org-1',
        projectId: 'proj-1',
        runId: 'run-1',
        idempotencyKey: 'idem-1',
        description: 'route hooks through the bridge',
        rationale: 'because',
      });
      await handle.db.insert(sqliteSchema.decisionEdges).values({
        id: 'edge-1',
        projectId: 'proj-1',
        fromDecisionId: 'dec_1',
        edgeType: 'affects',
        targetType: 'file',
        targetId: 'apps/hooks-bridge/src/index.ts',
      });

      const result = await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith([]),
      });

      expect(result.decisionsMarkedStale).toBe(1);
      const rows = await handle.db.select().from(sqliteSchema.decisions).where(eq(sqliteSchema.decisions.id, 'dec_1'));
      expect(rows[0]?.freshnessStatus).toBe('stale');
      // Supersession is NOT touched — that stays canonical in
      // decision_edges, and staleness is a different property.
      expect(rows[0]?.description).toBe('route hooks through the bridge');
    } finally {
      handle.close();
    }
  });

  it('ignores prose impact targets rather than reporting them deleted', async () => {
    // record_decision's impactTarget() classifies ANY bare string as a
    // file target, so real rows contain prose like "identity" or
    // "licensing". On this repo that made 5 of 8 stale decisions
    // spurious. Gardening verifies only path-shaped targets; the
    // looseness in `impact` is a separate contract problem.
    const handle = openMigrated();
    try {
      await seed(handle, 'no paths');
      await handle.db.insert(sqliteSchema.decisions).values({
        id: 'dec_prose',
        orgId: 'org-1',
        projectId: 'proj-1',
        runId: 'run-1',
        idempotencyKey: 'idem-prose',
        description: 'open-core packaging',
        rationale: 'because',
      });
      for (const [i, target] of ['identity', 'licensing', 'observability'].entries()) {
        await handle.db.insert(sqliteSchema.decisionEdges).values({
          id: `edge-prose-${i}`,
          projectId: 'proj-1',
          fromDecisionId: 'dec_prose',
          edgeType: 'affects',
          targetType: 'file',
          targetId: target,
        });
      }

      const result = await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo',
        projectId: 'proj-1',
        pathExists: fsWith([]),
      });

      expect(result.decisionsMarkedStale, 'prose is not a deleted file').toBe(0);
      const rows = await handle.db
        .select()
        .from(sqliteSchema.decisions)
        .where(eq(sqliteSchema.decisions.id, 'dec_prose'));
      expect(rows[0]?.freshnessStatus).toBe('unverified');
    } finally {
      handle.close();
    }
  });
});

/**
 * COOD-100 — gardening must not judge other projects' memory.
 *
 * `~/.coodra/data.db` holds EVERY project on the machine. The
 * context-pack query has always filtered on `projectId`; the
 * `decision_edges` query did not, and `markDecisionFreshness` updates by
 * decision id alone.
 *
 * So a pass for project A walked project B's decisions and checked them
 * against A's working tree. B's files resolve nowhere under A's cwd, so
 * every one of them came back "deleted" — a confident, wrong staleness
 * verdict on a project the pass was never asked about, written by a
 * background worker nobody was watching.
 */
describe('runMemoryGardeningOnce — project scoping', () => {
  async function seedTwoProjects(handle: SqliteHandle): Promise<void> {
    for (const [projectId, slug, cwd] of [
      ['proj-a', 'a', '/repo-a'],
      ['proj-b', 'b', '/repo-b'],
    ] as const) {
      await handle.db.insert(sqliteSchema.projects).values({ id: projectId, orgId: 'org-1', slug, name: slug, cwd });
      await handle.db.insert(sqliteSchema.runs).values({
        id: `run-${projectId}`,
        orgId: 'org-1',
        projectId,
        sessionId: `sess-${projectId}`,
        agentType: 'claude_code',
        mode: 'solo',
      });
      await handle.db.insert(sqliteSchema.decisions).values({
        id: `dec-${projectId}`,
        orgId: 'org-1',
        projectId,
        runId: `run-${projectId}`,
        idempotencyKey: `idem-${projectId}`,
        description: `choice for ${slug}`,
        rationale: 'because',
      });
      await handle.db.insert(sqliteSchema.decisionEdges).values({
        id: `de-${projectId}`,
        projectId,
        fromDecisionId: `dec-${projectId}`,
        edgeType: 'affects',
        targetType: 'file',
        // A path that exists in that project's tree and nowhere else.
        targetId: `packages/${slug}/src/index.ts`,
      });
    }
  }

  async function decisionRow(handle: SqliteHandle, id: string) {
    const rows = await handle.db.select().from(sqliteSchema.decisions).where(eq(sqliteSchema.decisions.id, id));
    return rows[0];
  }

  it('leaves another project’s decision completely untouched', async () => {
    const handle = openMigrated();
    try {
      await seedTwoProjects(handle);

      // Running for A, on A's filesystem. B's file is absent here —
      // which is exactly why the unscoped query marked it deleted.
      await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo-a',
        projectId: 'proj-a',
        pathExists: fsWith(['packages/a/src/index.ts']),
      });

      expect((await decisionRow(handle, 'dec-proj-a'))?.freshnessStatus).toBe('fresh');
      const b = await decisionRow(handle, 'dec-proj-b');
      expect(b?.freshnessStatus, 'B was never asked about').toBe('unverified');
      expect(b?.staleReason).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('does not report another project’s files as deleted', async () => {
    const handle = openMigrated();
    try {
      await seedTwoProjects(handle);

      // Nothing exists on A's disk. A's own decision should go stale;
      // B's must still be left alone rather than swept up.
      await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo-a',
        projectId: 'proj-a',
        pathExists: fsWith([]),
      });

      expect((await decisionRow(handle, 'dec-proj-a'))?.freshnessStatus).toBe('stale');
      expect((await decisionRow(handle, 'dec-proj-b'))?.freshnessStatus).toBe('unverified');
    } finally {
      handle.close();
    }
  });

  it('counts only this project’s decisions as checked', async () => {
    // The `batch * 5` budget was being spent on other projects' edges,
    // so a large sibling could starve this project of any checking.
    const handle = openMigrated();
    try {
      await seedTwoProjects(handle);
      const result = await runMemoryGardeningOnce({
        db: handle,
        projectCwd: '/repo-a',
        projectId: 'proj-a',
        pathExists: fsWith(['packages/a/src/index.ts']),
      });
      expect(result.decisionsChecked).toBe(1);
    } finally {
      handle.close();
    }
  });
});
