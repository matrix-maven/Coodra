import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `apps/web/lib/queries/context-packs.ts` (M04 Phase 2 S9).
 *
 * The wrapper is a thin pass-through to the db package — these tests
 * just confirm the projectId / id flows through and the createWebDb
 * fallback fires when the caller doesn't supply a handle.
 */

vi.mock('@/lib/db', () => ({
  createWebDb: () => ({ kind: 'sqlite', db: {} }) as never,
}));

vi.mock('@coodra/db', () => ({
  listContextPacksForProject: vi.fn(),
  getContextPackById: vi.fn(),
}));

describe('listContextPacks', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('passes projectId + limit through to the db helper', async () => {
    const { listContextPacksForProject } = await import('@coodra/db');
    const { listContextPacks } = await import('@/lib/queries/context-packs');
    vi.mocked(listContextPacksForProject).mockResolvedValue([
      {
        id: 'cp-1',
        runId: 'run-1',
        projectId: 'proj-1',
        title: 'first',
        contentExcerpt: 'short',
        createdAt: new Date('2026-05-04T10:00:00Z'),
      },
    ] as never);
    const result = await listContextPacks({ projectId: 'proj-1', limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('first');
    expect(listContextPacksForProject).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sqlite' }),
      expect.objectContaining({ projectId: 'proj-1', limit: 10 }),
    );
  });

  it('returns empty array when project has no CPs yet', async () => {
    const { listContextPacksForProject } = await import('@coodra/db');
    const { listContextPacks } = await import('@/lib/queries/context-packs');
    vi.mocked(listContextPacksForProject).mockResolvedValue([]);
    const result = await listContextPacks({ projectId: 'fresh-project' });
    expect(result).toEqual([]);
  });
});

describe('getContextPack', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns the detail row with full content', async () => {
    const { getContextPackById } = await import('@coodra/db');
    const { getContextPack } = await import('@/lib/queries/context-packs');
    vi.mocked(getContextPackById).mockResolvedValue({
      id: 'cp-1',
      runId: 'run-1',
      projectId: 'proj-1',
      title: 'detailed',
      contentExcerpt: 'short',
      content: '# full body\n\nbody text',
      createdAt: new Date('2026-05-04T10:00:00Z'),
    } as never);
    const result = await getContextPack('cp-1');
    expect(result?.content).toContain('# full body');
    expect(getContextPackById).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sqlite' }), 'cp-1');
  });

  it('returns null when row not found', async () => {
    const { getContextPackById } = await import('@coodra/db');
    const { getContextPack } = await import('@/lib/queries/context-packs');
    vi.mocked(getContextPackById).mockResolvedValue(null);
    const result = await getContextPack('nonexistent');
    expect(result).toBeNull();
  });
});
