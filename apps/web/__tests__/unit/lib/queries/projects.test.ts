import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M04 Phase 2 S1 — F2 guard.
 *
 * Asserts `listProjects()` filters the `__global__` sentinel project
 * out of the user-facing list. The sentinel is real data (it anchors
 * policy_rules for un-registered cwds per the F7 invariant) but it
 * was leaking into `/projects` as "Global Policy Rules" in the
 * 2026-05-04 audit.
 *
 * `getProject('__global__')` still resolves so deep-link inspection
 * works; only the list view hides it.
 */

vi.mock('@/lib/db', () => ({
  createWebDb: () => ({ kind: 'sqlite', db: {} }) as never,
}));

vi.mock('@coodra/db', () => ({
  listProjects: vi.fn(),
  getProjectByIdentifier: vi.fn(),
  resetProject: vi.fn(),
}));

describe('listProjects — F2 sentinel filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('omits the __global__ sentinel from the list', async () => {
    const { listProjects: listProjectsDb } = await import('@coodra/db');
    const { listProjects } = await import('@/lib/queries/projects');
    vi.mocked(listProjectsDb).mockResolvedValue([
      { id: '__global__', slug: '__global__', orgId: '__global__', name: 'Global Policy Rules', createdAt: new Date() },
      { id: 'p1', slug: 'coodra-dev', orgId: '__solo__', name: 'coodra-dev', createdAt: new Date() },
      { id: 'p2', slug: 'second-project', orgId: '__solo__', name: 'second-project', createdAt: new Date() },
    ] as never);
    const result = await listProjects();
    expect(result.map((r) => r.slug)).toEqual(['coodra-dev', 'second-project']);
  });

  it('returns an empty array when only the sentinel exists', async () => {
    const { listProjects: listProjectsDb } = await import('@coodra/db');
    const { listProjects } = await import('@/lib/queries/projects');
    vi.mocked(listProjectsDb).mockResolvedValue([
      { id: '__global__', slug: '__global__', orgId: '__global__', name: 'Global Policy Rules', createdAt: new Date() },
    ] as never);
    const result = await listProjects();
    expect(result).toEqual([]);
  });

  it('returns rows unchanged when the sentinel is absent', async () => {
    const { listProjects: listProjectsDb } = await import('@coodra/db');
    const { listProjects } = await import('@/lib/queries/projects');
    const rows = [{ id: 'p1', slug: 'coodra-dev', orgId: '__solo__', name: 'coodra-dev', createdAt: new Date() }];
    vi.mocked(listProjectsDb).mockResolvedValue(rows as never);
    const result = await listProjects();
    expect(result).toEqual(rows);
  });
});

describe('getProject — F2: sentinel still resolvable by deep-link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the __global__ sentinel when asked for it directly', async () => {
    const { getProjectByIdentifier } = await import('@coodra/db');
    const { getProject } = await import('@/lib/queries/projects');
    const sentinel = {
      id: '__global__',
      slug: '__global__',
      orgId: '__global__',
      name: 'Global Policy Rules',
      createdAt: new Date(),
    };
    vi.mocked(getProjectByIdentifier).mockResolvedValue(sentinel as never);
    const result = await getProject('__global__');
    expect(result).toEqual(sentinel);
  });
});
