import { desc, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * Read model for COOD-12 Work Packs.
 *
 * Writes are agent-mediated through the MCP server because the active agent
 * owns Atlassian access. The web app only needs a compact joined view that
 * shows local Work Packs, their linked Jira item, and last sync state.
 */

export interface WorkPackListItem {
  readonly id: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly slug: string;
  readonly title: string;
  readonly packType: string;
  readonly status: string;
  readonly updatedAt: Date;
  readonly externalProvider: string | null;
  readonly externalKey: string | null;
  readonly externalIssueType: string | null;
  readonly externalStatus: string | null;
  readonly externalUrl: string | null;
  readonly syncState: string | null;
}

export interface WorkPackDetail extends WorkPackListItem {
  readonly specMarkdown: string;
  readonly implementationMarkdown: string;
  readonly syncMarkdown: string;
  readonly metadataJson: string;
}

export async function listWorkPacksDetailed(db: DbHandle): Promise<WorkPackListItem[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.workPacks.id,
        projectId: sqliteSchema.workPacks.projectId,
        projectSlug: sqliteSchema.projects.slug,
        projectName: sqliteSchema.projects.name,
        slug: sqliteSchema.workPacks.slug,
        title: sqliteSchema.workPacks.title,
        packType: sqliteSchema.workPacks.packType,
        status: sqliteSchema.workPacks.status,
        updatedAt: sqliteSchema.workPacks.updatedAt,
        externalProvider: sqliteSchema.externalWorkItems.provider,
        externalKey: sqliteSchema.externalWorkItems.externalKey,
        externalIssueType: sqliteSchema.externalWorkItems.issueType,
        externalStatus: sqliteSchema.externalWorkItems.status,
        externalUrl: sqliteSchema.externalWorkItems.url,
        syncState: sqliteSchema.workPackExternalLinks.syncState,
      })
      .from(sqliteSchema.workPacks)
      .innerJoin(sqliteSchema.projects, eq(sqliteSchema.workPacks.projectId, sqliteSchema.projects.id))
      .leftJoin(
        sqliteSchema.workPackExternalLinks,
        eq(sqliteSchema.workPackExternalLinks.workPackId, sqliteSchema.workPacks.id),
      )
      .leftJoin(
        sqliteSchema.externalWorkItems,
        eq(sqliteSchema.externalWorkItems.id, sqliteSchema.workPackExternalLinks.externalWorkItemId),
      )
      .orderBy(desc(sqliteSchema.workPacks.updatedAt));
    return coalesceWorkPackListRows(rows);
  }

  const rows = await db.db
    .select({
      id: postgresSchema.workPacks.id,
      projectId: postgresSchema.workPacks.projectId,
      projectSlug: postgresSchema.projects.slug,
      projectName: postgresSchema.projects.name,
      slug: postgresSchema.workPacks.slug,
      title: postgresSchema.workPacks.title,
      packType: postgresSchema.workPacks.packType,
      status: postgresSchema.workPacks.status,
      updatedAt: postgresSchema.workPacks.updatedAt,
      externalProvider: postgresSchema.externalWorkItems.provider,
      externalKey: postgresSchema.externalWorkItems.externalKey,
      externalIssueType: postgresSchema.externalWorkItems.issueType,
      externalStatus: postgresSchema.externalWorkItems.status,
      externalUrl: postgresSchema.externalWorkItems.url,
      syncState: postgresSchema.workPackExternalLinks.syncState,
    })
    .from(postgresSchema.workPacks)
    .innerJoin(postgresSchema.projects, eq(postgresSchema.workPacks.projectId, postgresSchema.projects.id))
    .leftJoin(
      postgresSchema.workPackExternalLinks,
      eq(postgresSchema.workPackExternalLinks.workPackId, postgresSchema.workPacks.id),
    )
    .leftJoin(
      postgresSchema.externalWorkItems,
      eq(postgresSchema.externalWorkItems.id, postgresSchema.workPackExternalLinks.externalWorkItemId),
    )
    .orderBy(desc(postgresSchema.workPacks.updatedAt));
  return coalesceWorkPackListRows(rows);
}

export async function getWorkPackDetail(db: DbHandle, workPackId: string): Promise<WorkPackDetail | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.workPacks.id,
        projectId: sqliteSchema.workPacks.projectId,
        projectSlug: sqliteSchema.projects.slug,
        projectName: sqliteSchema.projects.name,
        slug: sqliteSchema.workPacks.slug,
        title: sqliteSchema.workPacks.title,
        packType: sqliteSchema.workPacks.packType,
        status: sqliteSchema.workPacks.status,
        updatedAt: sqliteSchema.workPacks.updatedAt,
        specMarkdown: sqliteSchema.workPacks.specMarkdown,
        implementationMarkdown: sqliteSchema.workPacks.implementationMarkdown,
        syncMarkdown: sqliteSchema.workPacks.syncMarkdown,
        metadataJson: sqliteSchema.workPacks.metadataJson,
        externalProvider: sqliteSchema.externalWorkItems.provider,
        externalKey: sqliteSchema.externalWorkItems.externalKey,
        externalIssueType: sqliteSchema.externalWorkItems.issueType,
        externalStatus: sqliteSchema.externalWorkItems.status,
        externalUrl: sqliteSchema.externalWorkItems.url,
        syncState: sqliteSchema.workPackExternalLinks.syncState,
      })
      .from(sqliteSchema.workPacks)
      .innerJoin(sqliteSchema.projects, eq(sqliteSchema.workPacks.projectId, sqliteSchema.projects.id))
      .leftJoin(
        sqliteSchema.workPackExternalLinks,
        eq(sqliteSchema.workPackExternalLinks.workPackId, sqliteSchema.workPacks.id),
      )
      .leftJoin(
        sqliteSchema.externalWorkItems,
        eq(sqliteSchema.externalWorkItems.id, sqliteSchema.workPackExternalLinks.externalWorkItemId),
      )
      .where(eq(sqliteSchema.workPacks.id, workPackId))
      .limit(1);
    return coalesceWorkPackListRows(rows)[0] ?? null;
  }

  const rows = await db.db
    .select({
      id: postgresSchema.workPacks.id,
      projectId: postgresSchema.workPacks.projectId,
      projectSlug: postgresSchema.projects.slug,
      projectName: postgresSchema.projects.name,
      slug: postgresSchema.workPacks.slug,
      title: postgresSchema.workPacks.title,
      packType: postgresSchema.workPacks.packType,
      status: postgresSchema.workPacks.status,
      updatedAt: postgresSchema.workPacks.updatedAt,
      specMarkdown: postgresSchema.workPacks.specMarkdown,
      implementationMarkdown: postgresSchema.workPacks.implementationMarkdown,
      syncMarkdown: postgresSchema.workPacks.syncMarkdown,
      metadataJson: postgresSchema.workPacks.metadataJson,
      externalProvider: postgresSchema.externalWorkItems.provider,
      externalKey: postgresSchema.externalWorkItems.externalKey,
      externalIssueType: postgresSchema.externalWorkItems.issueType,
      externalStatus: postgresSchema.externalWorkItems.status,
      externalUrl: postgresSchema.externalWorkItems.url,
      syncState: postgresSchema.workPackExternalLinks.syncState,
    })
    .from(postgresSchema.workPacks)
    .innerJoin(postgresSchema.projects, eq(postgresSchema.workPacks.projectId, postgresSchema.projects.id))
    .leftJoin(
      postgresSchema.workPackExternalLinks,
      eq(postgresSchema.workPackExternalLinks.workPackId, postgresSchema.workPacks.id),
    )
    .leftJoin(
      postgresSchema.externalWorkItems,
      eq(postgresSchema.externalWorkItems.id, postgresSchema.workPackExternalLinks.externalWorkItemId),
    )
    .where(eq(postgresSchema.workPacks.id, workPackId))
    .limit(1);
  return coalesceWorkPackListRows(rows)[0] ?? null;
}

export function coalesceWorkPackListRows<T extends WorkPackListItem>(rows: readonly T[]): T[] {
  const byWorkPackId = new Map<string, T>();
  for (const row of rows) {
    const existing = byWorkPackId.get(row.id);
    if (existing === undefined || compareExternalLinkPreference(row, existing) > 0) {
      byWorkPackId.set(row.id, row);
    }
  }
  return [...byWorkPackId.values()];
}

function compareExternalLinkPreference(a: WorkPackListItem, b: WorkPackListItem): number {
  const providerRank = rankExternalProvider(a.externalProvider) - rankExternalProvider(b.externalProvider);
  if (providerRank !== 0) return providerRank;
  if (a.syncState === 'synced' && b.syncState !== 'synced') return 1;
  if (a.syncState !== 'synced' && b.syncState === 'synced') return -1;
  return a.updatedAt.getTime() - b.updatedAt.getTime();
}

function rankExternalProvider(provider: string | null): number {
  if (provider === 'atlassian') return 3;
  if (provider !== null && provider !== 'manual') return 2;
  if (provider === 'manual') return 1;
  return 0;
}
