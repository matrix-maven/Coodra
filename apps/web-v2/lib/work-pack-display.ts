import type { WorkPackListItem } from '@coodra/db';

export interface WorkPackGroupSummary {
  readonly total: number;
  readonly jiraLinked: number;
  readonly local: number;
  readonly syncedJira: number;
}

export function isJiraLinkedWorkPack(pack: Pick<WorkPackListItem, 'externalProvider' | 'externalKey'>): boolean {
  return pack.externalProvider === 'atlassian' && pack.externalKey !== null;
}

export function summarizeWorkPackGroup(packs: readonly WorkPackListItem[]): WorkPackGroupSummary {
  const jiraLinked = packs.filter(isJiraLinkedWorkPack).length;
  return {
    total: packs.length,
    jiraLinked,
    local: packs.length - jiraLinked,
    syncedJira: packs.filter((pack) => isJiraLinkedWorkPack(pack) && pack.syncState === 'synced').length,
  };
}

export function formatWorkPackProviderSummary(summary: WorkPackGroupSummary): string {
  const parts: string[] = [`${summary.jiraLinked} Jira-linked`];
  if (summary.local > 0) parts.push(`${summary.local} local`);
  return parts.join(' · ');
}

export function formatWorkPackSyncBadge(summary: WorkPackGroupSummary): string {
  if (summary.jiraLinked === 0) return `${summary.local} local`;
  return `${summary.syncedJira}/${summary.jiraLinked} Jira synced`;
}
