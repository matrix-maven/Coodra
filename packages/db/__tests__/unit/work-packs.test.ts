import { describe, expect, it } from 'vitest';

import { coalesceWorkPackListRows, type WorkPackListItem } from '../../src/work-packs';

const baseRow: WorkPackListItem = {
  id: 'work_1',
  projectId: 'proj_1',
  projectSlug: 'coodra',
  projectName: 'coodra',
  slug: 'release-053-merge-main',
  title: 'Merge release',
  packType: 'task',
  status: 'done',
  updatedAt: new Date('2026-08-08T10:00:00Z'),
  externalProvider: null,
  externalKey: null,
  externalIssueType: null,
  externalStatus: null,
  externalUrl: null,
  syncState: null,
};

describe('coalesceWorkPackListRows', () => {
  it('returns one row per Work Pack and prefers Atlassian over a manual fallback link', () => {
    const rows = [
      {
        ...baseRow,
        externalProvider: 'manual',
        externalKey: 'release-053-merge-main',
        externalIssueType: 'manual merge task',
        externalStatus: 'done',
        syncState: 'synced',
      },
      {
        ...baseRow,
        externalProvider: 'atlassian',
        externalKey: 'COOD-55',
        externalIssueType: 'Task',
        externalStatus: 'Done',
        externalUrl: 'https://matrixmaven.atlassian.net/browse/COOD-55',
        syncState: 'synced',
      },
    ];

    expect(coalesceWorkPackListRows(rows)).toEqual([rows[1]]);
  });

  it('keeps independent Work Packs while coalescing duplicate joined links', () => {
    const rows = [
      { ...baseRow, externalProvider: 'manual', externalKey: 'manual-1', syncState: 'synced' },
      { ...baseRow, id: 'work_2', slug: 'manual-2', externalProvider: 'manual', externalKey: 'manual-2' },
    ];

    expect(coalesceWorkPackListRows(rows)).toHaveLength(2);
  });
});
