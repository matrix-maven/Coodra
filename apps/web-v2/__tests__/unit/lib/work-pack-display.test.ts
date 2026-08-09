import { describe, expect, it } from 'vitest';

import {
  formatWorkPackProviderSummary,
  formatWorkPackSyncBadge,
  isJiraLinkedWorkPack,
  summarizeWorkPackGroup,
} from '../../../lib/work-pack-display';

const basePack = {
  id: 'work_1',
  projectId: 'proj_1',
  projectSlug: 'coodra',
  projectName: 'coodra',
  slug: 'pack-1',
  title: 'Pack 1',
  packType: 'task',
  status: 'in_progress',
  updatedAt: new Date('2026-08-08T10:00:00Z'),
  externalIssueType: null,
  externalStatus: null,
  externalUrl: null,
  syncState: null,
};

describe('work pack display helpers', () => {
  it('does not treat manual work packs as Jira-linked or Jira-synced', () => {
    const packs = [
      {
        ...basePack,
        externalProvider: 'manual',
        externalKey: 'release-053-merge-main',
        syncState: 'synced',
      },
      {
        ...basePack,
        id: 'work_2',
        slug: 'manual-ui-fix',
        externalProvider: 'manual',
        externalKey: 'manual-ui-fix',
        syncState: 'synced',
      },
    ];

    const summary = summarizeWorkPackGroup(packs);

    expect(summary).toEqual({ total: 2, jiraLinked: 0, local: 2, syncedJira: 0 });
    expect(formatWorkPackProviderSummary(summary)).toBe('0 Jira-linked · 2 local');
    expect(formatWorkPackSyncBadge(summary)).toBe('2 local');
  });

  it('counts only Atlassian external items as Jira-linked', () => {
    const pack = {
      ...basePack,
      externalProvider: 'atlassian',
      externalKey: 'COOD-55',
      syncState: 'synced',
    };

    expect(isJiraLinkedWorkPack(pack)).toBe(true);
    expect(summarizeWorkPackGroup([pack])).toMatchObject({ jiraLinked: 1, local: 0, syncedJira: 1 });
  });
});
