import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `apps/web/lib/queries/pack-runs.ts` (M04 Phase 2 S7).
 *
 * Verifies:
 *   - The query fans out to listRuns + listContextPacks in parallel
 *     for the same projectId.
 *   - The hasMoreRuns flag is propagated from the runs query.
 *   - Returns whatever the underlying queries return — no extra
 *     filtering at this layer (per the spec note that pack-grain
 *     filtering needs the M05 schema extension).
 */

vi.mock('@/lib/db', () => ({
  createWebDb: () => ({ kind: 'sqlite', db: {} }) as never,
}));

vi.mock('@/lib/queries/runs', () => ({
  listRuns: vi.fn(),
}));

vi.mock('@/lib/queries/context-packs', () => ({
  listContextPacks: vi.fn(),
}));

describe('listRunsAndContextPacksForProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns runs + context packs scoped to the project', async () => {
    const { listRuns } = await import('@/lib/queries/runs');
    const { listContextPacks } = await import('@/lib/queries/context-packs');
    const { listRunsAndContextPacksForProject } = await import('@/lib/queries/pack-runs');

    vi.mocked(listRuns).mockResolvedValue({
      runs: [
        {
          id: 'run-1',
          projectId: 'proj-1',
          sessionId: 'sess-1',
          agentType: 'claude_code',
          mode: 'solo',
          status: 'completed',
          issueRef: null,
          prRef: null,
          startedAt: new Date('2026-05-04T10:00:00Z'),
          endedAt: new Date('2026-05-04T10:05:00Z'),
        },
      ] as never,
      hasMore: false,
      limit: 50,
    });
    vi.mocked(listContextPacks).mockResolvedValue([
      {
        id: 'cp-1',
        runId: 'run-1',
        projectId: 'proj-1',
        title: 'first pack',
        contentExcerpt: 'short',
        createdAt: new Date('2026-05-04T10:05:00Z'),
      },
    ] as never);

    const result = await listRunsAndContextPacksForProject({ projectId: 'proj-1' });
    expect(result.runs).toHaveLength(1);
    expect(result.contextPacks).toHaveLength(1);
    expect(result.hasMoreRuns).toBe(false);
    expect(result.runsLimit).toBe(50);
    expect(result.contextPacksLimit).toBe(50);

    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', limit: 50 }));
    expect(listContextPacks).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', limit: 50 }));
  });

  it('propagates the hasMoreRuns flag', async () => {
    const { listRuns } = await import('@/lib/queries/runs');
    const { listContextPacks } = await import('@/lib/queries/context-packs');
    const { listRunsAndContextPacksForProject } = await import('@/lib/queries/pack-runs');

    vi.mocked(listRuns).mockResolvedValue({
      runs: [],
      hasMore: true,
      limit: 5,
    } as never);
    vi.mocked(listContextPacks).mockResolvedValue([]);

    const result = await listRunsAndContextPacksForProject({ projectId: 'proj-2', runsLimit: 5 });
    expect(result.hasMoreRuns).toBe(true);
    expect(result.runsLimit).toBe(5);
  });

  it('returns empty arrays when nothing in the project yet', async () => {
    const { listRuns } = await import('@/lib/queries/runs');
    const { listContextPacks } = await import('@/lib/queries/context-packs');
    const { listRunsAndContextPacksForProject } = await import('@/lib/queries/pack-runs');

    vi.mocked(listRuns).mockResolvedValue({ runs: [], hasMore: false, limit: 50 } as never);
    vi.mocked(listContextPacks).mockResolvedValue([]);

    const result = await listRunsAndContextPacksForProject({ projectId: 'fresh-project' });
    expect(result.runs).toEqual([]);
    expect(result.contextPacks).toEqual([]);
    expect(result.hasMoreRuns).toBe(false);
  });
});
