import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, desc, eq } from 'drizzle-orm';

import { selectRunProjectId } from './wiki-store.js';

export interface WorkPackSourceInput {
  readonly provider: string;
  readonly externalKey: string;
  readonly issueType: string;
  readonly status: string;
  readonly url?: string | null | undefined;
  readonly parentExternalKey?: string | null | undefined;
  readonly rawExternalJson?: Record<string, unknown> | undefined;
}

export interface WorkPackRelationshipInput {
  readonly targetExternalKey: string;
  readonly relationshipType: string;
  readonly syncLevel?: 'summary' | 'full' | undefined;
  readonly metadataJson?: Record<string, unknown> | undefined;
}

export interface UpsertWorkPackArgs {
  readonly runId: string;
  readonly slug: string;
  readonly title: string;
  readonly packType: string;
  readonly status: string;
  readonly specMarkdown: string;
  readonly implementationMarkdown: string;
  readonly syncMarkdown: string;
  readonly metadataJson: Record<string, unknown>;
  readonly source: WorkPackSourceInput;
  readonly relationships: readonly WorkPackRelationshipInput[];
  readonly now: Date;
}

export interface UpsertWorkPackResult {
  readonly ok: true;
  readonly projectId: string;
  readonly workPackId: string;
  readonly externalWorkItemId: string;
  readonly slug: string;
  readonly fileDir: string | null;
  readonly relationshipCount: number;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

async function selectProjectContext(db: DbHandle, runId: string): Promise<{
  projectId: string;
  projectSlug: string;
  cwd: string | null;
  orgId: string;
  createdByUserId: string | null;
} | null> {
  const projectId = await selectRunProjectId(db, runId);
  if (projectId === null) return null;
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        projectId: sqliteSchema.projects.id,
        projectSlug: sqliteSchema.projects.slug,
        cwd: sqliteSchema.projects.cwd,
        orgId: sqliteSchema.projects.orgId,
        createdByUserId: sqliteSchema.runs.createdByUserId,
      })
      .from(sqliteSchema.projects)
      .innerJoin(sqliteSchema.runs, eq(sqliteSchema.runs.projectId, sqliteSchema.projects.id))
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select({
      projectId: postgresSchema.projects.id,
      projectSlug: postgresSchema.projects.slug,
      cwd: postgresSchema.projects.cwd,
      orgId: postgresSchema.projects.orgId,
      createdByUserId: postgresSchema.runs.createdByUserId,
    })
    .from(postgresSchema.projects)
    .innerJoin(postgresSchema.runs, eq(postgresSchema.runs.projectId, postgresSchema.projects.id))
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function writeWorkPackFiles(args: {
  readonly cwd: string | null;
  readonly slug: string;
  readonly title: string;
  readonly packType: string;
  readonly status: string;
  readonly source: WorkPackSourceInput;
  readonly specMarkdown: string;
  readonly implementationMarkdown: string;
  readonly syncMarkdown: string;
  readonly metadataJson: Record<string, unknown>;
  readonly relationships: readonly WorkPackRelationshipInput[];
}): Promise<string | null> {
  if (args.cwd === null || args.cwd.length === 0) return null;
  const dir = join(args.cwd, '.coodra', 'work-packs', args.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'meta.json'),
    `${JSON.stringify(
      {
        slug: args.slug,
        title: args.title,
        packType: args.packType,
        status: args.status,
        source: args.source,
        ...args.metadataJson,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(join(dir, 'spec.md'), args.specMarkdown, 'utf8');
  await writeFile(join(dir, 'implementation.md'), args.implementationMarkdown, 'utf8');
  await writeFile(join(dir, 'sync.md'), args.syncMarkdown, 'utf8');
  await writeFile(join(dir, 'relationships.json'), `${JSON.stringify(args.relationships, null, 2)}\n`, 'utf8');
  return dir;
}

export async function upsertWorkPack(db: DbHandle, args: UpsertWorkPackArgs): Promise<UpsertWorkPackResult | null> {
  const project = await selectProjectContext(db, args.runId);
  if (project === null) return null;
  const workPackId = `work_${randomUUID()}`;
  const externalWorkItemId = `ext_${randomUUID()}`;
  const now = args.now;
  const source = args.source;

  if (db.kind === 'sqlite') {
    await db.db
      .insert(sqliteSchema.externalWorkItems)
      .values({
        id: externalWorkItemId,
        projectId: project.projectId,
        provider: source.provider,
        externalKey: source.externalKey,
        issueType: source.issueType,
        title: args.title,
        status: source.status,
        url: source.url ?? null,
        parentExternalKey: source.parentExternalKey ?? null,
        rawExternalJson: json(source.rawExternalJson),
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          sqliteSchema.externalWorkItems.projectId,
          sqliteSchema.externalWorkItems.provider,
          sqliteSchema.externalWorkItems.externalKey,
        ],
        set: {
          issueType: source.issueType,
          title: args.title,
          status: source.status,
          url: source.url ?? null,
          parentExternalKey: source.parentExternalKey ?? null,
          rawExternalJson: json(source.rawExternalJson),
          lastSeenAt: now,
          updatedAt: now,
        },
      });
    const externalRows = await db.db
      .select({ id: sqliteSchema.externalWorkItems.id })
      .from(sqliteSchema.externalWorkItems)
      .where(
        and(
          eq(sqliteSchema.externalWorkItems.projectId, project.projectId),
          eq(sqliteSchema.externalWorkItems.provider, source.provider),
          eq(sqliteSchema.externalWorkItems.externalKey, source.externalKey),
        ),
      )
      .limit(1);
    const settledExternalId = externalRows[0]?.id ?? externalWorkItemId;

    await db.db
      .insert(sqliteSchema.workPacks)
      .values({
        id: workPackId,
        projectId: project.projectId,
        slug: args.slug,
        title: args.title,
        packType: args.packType,
        status: args.status,
        specMarkdown: args.specMarkdown,
        implementationMarkdown: args.implementationMarkdown,
        syncMarkdown: args.syncMarkdown,
        metadataJson: json(args.metadataJson),
        createdByRunId: args.runId,
        createdByUserId: project.createdByUserId,
        orgId: project.orgId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [sqliteSchema.workPacks.projectId, sqliteSchema.workPacks.slug],
        set: {
          title: args.title,
          packType: args.packType,
          status: args.status,
          specMarkdown: args.specMarkdown,
          implementationMarkdown: args.implementationMarkdown,
          syncMarkdown: args.syncMarkdown,
          metadataJson: json(args.metadataJson),
          createdByRunId: args.runId,
          createdByUserId: project.createdByUserId,
          orgId: project.orgId,
          updatedAt: now,
        },
      });
    const workRows = await db.db
      .select({ id: sqliteSchema.workPacks.id })
      .from(sqliteSchema.workPacks)
      .where(and(eq(sqliteSchema.workPacks.projectId, project.projectId), eq(sqliteSchema.workPacks.slug, args.slug)))
      .limit(1);
    const settledWorkPackId = workRows[0]?.id ?? workPackId;

    await db.db
      .insert(sqliteSchema.workPackExternalLinks)
      .values({
        id: `wplink_${randomUUID()}`,
        workPackId: settledWorkPackId,
        externalWorkItemId: settledExternalId,
        syncDirection: 'bidirectional',
        syncState: 'synced',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          sqliteSchema.workPackExternalLinks.workPackId,
          sqliteSchema.workPackExternalLinks.externalWorkItemId,
        ],
        set: { syncDirection: 'bidirectional', syncState: 'synced', updatedAt: now },
      });

    await db.db
      .delete(sqliteSchema.workPackRelationships)
      .where(eq(sqliteSchema.workPackRelationships.sourceWorkPackId, settledWorkPackId));
    if (args.relationships.length > 0) {
      await db.db.insert(sqliteSchema.workPackRelationships).values(
        args.relationships.map((rel) => ({
          id: `wprel_${randomUUID()}`,
          projectId: project.projectId,
          sourceWorkPackId: settledWorkPackId,
          sourceExternalKey: source.externalKey,
          targetExternalKey: rel.targetExternalKey,
          relationshipType: rel.relationshipType,
          syncLevel: rel.syncLevel ?? 'summary',
          metadataJson: json(rel.metadataJson),
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await db.db.insert(sqliteSchema.syncEvents).values({
      id: `sync_${randomUUID()}`,
      projectId: project.projectId,
      workPackId: settledWorkPackId,
      provider: source.provider,
      direction: 'external_to_coodra',
      action: 'work_pack_upsert',
      result: 'success',
      actorRunId: args.runId,
      externalKey: source.externalKey,
      summary: `Imported ${source.externalKey} into Work Pack ${args.slug}`,
      metadataJson: json({ relationshipCount: args.relationships.length }),
      createdAt: now,
    });
    const fileDir = await writeWorkPackFiles({ ...args, cwd: project.cwd, source });
    return {
      ok: true,
      projectId: project.projectId,
      workPackId: settledWorkPackId,
      externalWorkItemId: settledExternalId,
      slug: args.slug,
      fileDir,
      relationshipCount: args.relationships.length,
    };
  }

  await db.db
    .insert(postgresSchema.externalWorkItems)
    .values({
      id: externalWorkItemId,
      projectId: project.projectId,
      provider: source.provider,
      externalKey: source.externalKey,
      issueType: source.issueType,
      title: args.title,
      status: source.status,
      url: source.url ?? null,
      parentExternalKey: source.parentExternalKey ?? null,
      rawExternalJson: json(source.rawExternalJson),
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        postgresSchema.externalWorkItems.projectId,
        postgresSchema.externalWorkItems.provider,
        postgresSchema.externalWorkItems.externalKey,
      ],
      set: {
        issueType: source.issueType,
        title: args.title,
        status: source.status,
        url: source.url ?? null,
        parentExternalKey: source.parentExternalKey ?? null,
        rawExternalJson: json(source.rawExternalJson),
        lastSeenAt: now,
        updatedAt: now,
      },
    });
  const externalRows = await db.db
    .select({ id: postgresSchema.externalWorkItems.id })
    .from(postgresSchema.externalWorkItems)
    .where(
      and(
        eq(postgresSchema.externalWorkItems.projectId, project.projectId),
        eq(postgresSchema.externalWorkItems.provider, source.provider),
        eq(postgresSchema.externalWorkItems.externalKey, source.externalKey),
      ),
    )
    .limit(1);
  const settledExternalId = externalRows[0]?.id ?? externalWorkItemId;

  await db.db
    .insert(postgresSchema.workPacks)
    .values({
      id: workPackId,
      projectId: project.projectId,
      slug: args.slug,
      title: args.title,
      packType: args.packType,
      status: args.status,
      specMarkdown: args.specMarkdown,
      implementationMarkdown: args.implementationMarkdown,
      syncMarkdown: args.syncMarkdown,
      metadataJson: json(args.metadataJson),
      createdByRunId: args.runId,
      createdByUserId: project.createdByUserId,
      orgId: project.orgId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [postgresSchema.workPacks.projectId, postgresSchema.workPacks.slug],
      set: {
        title: args.title,
        packType: args.packType,
        status: args.status,
        specMarkdown: args.specMarkdown,
        implementationMarkdown: args.implementationMarkdown,
        syncMarkdown: args.syncMarkdown,
        metadataJson: json(args.metadataJson),
        createdByRunId: args.runId,
        createdByUserId: project.createdByUserId,
        orgId: project.orgId,
        updatedAt: now,
      },
    });
  const workRows = await db.db
    .select({ id: postgresSchema.workPacks.id })
    .from(postgresSchema.workPacks)
    .where(and(eq(postgresSchema.workPacks.projectId, project.projectId), eq(postgresSchema.workPacks.slug, args.slug)))
    .limit(1);
  const settledWorkPackId = workRows[0]?.id ?? workPackId;

  await db.db
    .insert(postgresSchema.workPackExternalLinks)
    .values({
      id: `wplink_${randomUUID()}`,
      workPackId: settledWorkPackId,
      externalWorkItemId: settledExternalId,
      syncDirection: 'bidirectional',
      syncState: 'synced',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        postgresSchema.workPackExternalLinks.workPackId,
        postgresSchema.workPackExternalLinks.externalWorkItemId,
      ],
      set: { syncDirection: 'bidirectional', syncState: 'synced', updatedAt: now },
    });

  await db.db
    .delete(postgresSchema.workPackRelationships)
    .where(eq(postgresSchema.workPackRelationships.sourceWorkPackId, settledWorkPackId));
  if (args.relationships.length > 0) {
    await db.db.insert(postgresSchema.workPackRelationships).values(
      args.relationships.map((rel) => ({
        id: `wprel_${randomUUID()}`,
        projectId: project.projectId,
        sourceWorkPackId: settledWorkPackId,
        sourceExternalKey: source.externalKey,
        targetExternalKey: rel.targetExternalKey,
        relationshipType: rel.relationshipType,
        syncLevel: rel.syncLevel ?? 'summary',
        metadataJson: json(rel.metadataJson),
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  await db.db.insert(postgresSchema.syncEvents).values({
    id: `sync_${randomUUID()}`,
    projectId: project.projectId,
    workPackId: settledWorkPackId,
    provider: source.provider,
    direction: 'external_to_coodra',
    action: 'work_pack_upsert',
    result: 'success',
    actorRunId: args.runId,
    externalKey: source.externalKey,
    summary: `Imported ${source.externalKey} into Work Pack ${args.slug}`,
    metadataJson: json({ relationshipCount: args.relationships.length }),
    createdAt: now,
  });
  const fileDir = await writeWorkPackFiles({ ...args, cwd: project.cwd, source });
  return {
    ok: true,
    projectId: project.projectId,
    workPackId: settledWorkPackId,
    externalWorkItemId: settledExternalId,
    slug: args.slug,
    fileDir,
    relationshipCount: args.relationships.length,
  };
}

export async function listWorkPackStatus(db: DbHandle, projectId: string | null) {
  if (db.kind === 'sqlite') {
    const query = db.db
      .select({
        id: sqliteSchema.workPacks.id,
        slug: sqliteSchema.workPacks.slug,
        title: sqliteSchema.workPacks.title,
        packType: sqliteSchema.workPacks.packType,
        status: sqliteSchema.workPacks.status,
        updatedAt: sqliteSchema.workPacks.updatedAt,
        externalKey: sqliteSchema.externalWorkItems.externalKey,
        externalStatus: sqliteSchema.externalWorkItems.status,
        syncState: sqliteSchema.workPackExternalLinks.syncState,
      })
      .from(sqliteSchema.workPacks)
      .leftJoin(
        sqliteSchema.workPackExternalLinks,
        eq(sqliteSchema.workPackExternalLinks.workPackId, sqliteSchema.workPacks.id),
      )
      .leftJoin(
        sqliteSchema.externalWorkItems,
        eq(sqliteSchema.externalWorkItems.id, sqliteSchema.workPackExternalLinks.externalWorkItemId),
      );
    return projectId === null
      ? query.orderBy(desc(sqliteSchema.workPacks.updatedAt))
      : query.where(eq(sqliteSchema.workPacks.projectId, projectId)).orderBy(desc(sqliteSchema.workPacks.updatedAt));
  }
  const query = db.db
    .select({
      id: postgresSchema.workPacks.id,
      slug: postgresSchema.workPacks.slug,
      title: postgresSchema.workPacks.title,
      packType: postgresSchema.workPacks.packType,
      status: postgresSchema.workPacks.status,
      updatedAt: postgresSchema.workPacks.updatedAt,
      externalKey: postgresSchema.externalWorkItems.externalKey,
      externalStatus: postgresSchema.externalWorkItems.status,
      syncState: postgresSchema.workPackExternalLinks.syncState,
    })
    .from(postgresSchema.workPacks)
    .leftJoin(
      postgresSchema.workPackExternalLinks,
      eq(postgresSchema.workPackExternalLinks.workPackId, postgresSchema.workPacks.id),
    )
    .leftJoin(
      postgresSchema.externalWorkItems,
      eq(postgresSchema.externalWorkItems.id, postgresSchema.workPackExternalLinks.externalWorkItemId),
    );
  return projectId === null
    ? query.orderBy(desc(postgresSchema.workPacks.updatedAt))
    : query.where(eq(postgresSchema.workPacks.projectId, projectId)).orderBy(desc(postgresSchema.workPacks.updatedAt));
}
