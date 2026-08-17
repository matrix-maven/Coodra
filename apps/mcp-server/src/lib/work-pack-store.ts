import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { toSqliteFtsQuery } from './fts-query.js';
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

export interface WorkPackPatchInput {
  readonly title?: string | undefined;
  readonly packType?: string | undefined;
  readonly status?: string | undefined;
  readonly specMarkdown?: string | undefined;
  readonly implementationMarkdown?: string | undefined;
  readonly syncMarkdown?: string | undefined;
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

export interface UpdateWorkPackArgs {
  readonly runId: string;
  readonly slug: string;
  readonly patch: WorkPackPatchInput;
  readonly relationships?: readonly WorkPackRelationshipInput[] | undefined;
  readonly changeReason?: string | undefined;
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

export interface UpdateWorkPackResult {
  readonly ok: true;
  readonly projectId: string;
  readonly workPackId: string;
  readonly slug: string;
  readonly fieldsChanged: string[];
  readonly syncState: 'local_ahead' | 'local_only';
  readonly externalLinkCount: number;
  readonly relationshipCount: number;
  readonly fileDir: string | null;
}

export type UpdateWorkPackFailure = 'run_not_found' | 'work_pack_not_found';

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (value === undefined || value === null || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function selectProjectContext(
  db: DbHandle,
  runId: string,
): Promise<{
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

interface ExistingWorkPackForUpdate {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly packType: string;
  readonly status: string;
  readonly specMarkdown: string;
  readonly implementationMarkdown: string;
  readonly syncMarkdown: string;
  readonly metadataJson: string;
}

interface ExistingExternalLinkForUpdate {
  readonly provider: string;
  readonly externalKey: string;
  readonly issueType: string;
  readonly status: string;
  readonly url: string | null;
  readonly parentExternalKey: string | null;
  readonly rawExternalJson: string;
}

function mergeWorkPackPatch(
  existing: ExistingWorkPackForUpdate,
  patch: WorkPackPatchInput,
): ExistingWorkPackForUpdate & { readonly metadataObject: Record<string, unknown>; readonly fieldsChanged: string[] } {
  const metadataObject =
    patch.metadataJson === undefined
      ? parseJsonObject(existing.metadataJson)
      : { ...parseJsonObject(existing.metadataJson), ...patch.metadataJson };
  const next = {
    ...existing,
    title: patch.title ?? existing.title,
    packType: patch.packType ?? existing.packType,
    status: patch.status ?? existing.status,
    specMarkdown: patch.specMarkdown ?? existing.specMarkdown,
    implementationMarkdown: patch.implementationMarkdown ?? existing.implementationMarkdown,
    syncMarkdown: patch.syncMarkdown ?? existing.syncMarkdown,
    metadataJson: json(metadataObject),
  };
  const fieldsChanged = [
    patch.title !== undefined && patch.title !== existing.title ? 'title' : null,
    patch.packType !== undefined && patch.packType !== existing.packType ? 'packType' : null,
    patch.status !== undefined && patch.status !== existing.status ? 'status' : null,
    patch.specMarkdown !== undefined && patch.specMarkdown !== existing.specMarkdown ? 'specMarkdown' : null,
    patch.implementationMarkdown !== undefined && patch.implementationMarkdown !== existing.implementationMarkdown
      ? 'implementationMarkdown'
      : null,
    patch.syncMarkdown !== undefined && patch.syncMarkdown !== existing.syncMarkdown ? 'syncMarkdown' : null,
    patch.metadataJson !== undefined ? 'metadataJson' : null,
  ].filter((value): value is string => value !== null);
  return { ...next, metadataObject, fieldsChanged };
}

function sourceFromLink(link: ExistingExternalLinkForUpdate | null): WorkPackSourceInput {
  if (link === null) {
    return {
      provider: 'manual',
      externalKey: 'local-only',
      issueType: 'manual',
      status: 'local',
      rawExternalJson: {},
    };
  }
  return {
    provider: link.provider,
    externalKey: link.externalKey,
    issueType: link.issueType,
    status: link.status,
    url: link.url,
    parentExternalKey: link.parentExternalKey,
    rawExternalJson: parseJsonObject(link.rawExternalJson),
  };
}

function syncSummary(args: UpdateWorkPackArgs, fieldsChanged: readonly string[]): string {
  const fields = fieldsChanged.length === 0 ? 'relationships' : fieldsChanged.join(', ');
  return args.changeReason === undefined || args.changeReason.length === 0
    ? `Updated local Work Pack ${args.slug}: ${fields}`
    : `Updated local Work Pack ${args.slug}: ${fields}. Reason: ${args.changeReason}`;
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
        target: [sqliteSchema.workPackExternalLinks.workPackId, sqliteSchema.workPackExternalLinks.externalWorkItemId],
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

export async function updateWorkPack(
  db: DbHandle,
  args: UpdateWorkPackArgs,
): Promise<UpdateWorkPackResult | UpdateWorkPackFailure> {
  const project = await selectProjectContext(db, args.runId);
  if (project === null) return 'run_not_found';
  const now = args.now;

  if (db.kind === 'sqlite') {
    const workRows = await db.db
      .select({
        id: sqliteSchema.workPacks.id,
        slug: sqliteSchema.workPacks.slug,
        title: sqliteSchema.workPacks.title,
        packType: sqliteSchema.workPacks.packType,
        status: sqliteSchema.workPacks.status,
        specMarkdown: sqliteSchema.workPacks.specMarkdown,
        implementationMarkdown: sqliteSchema.workPacks.implementationMarkdown,
        syncMarkdown: sqliteSchema.workPacks.syncMarkdown,
        metadataJson: sqliteSchema.workPacks.metadataJson,
      })
      .from(sqliteSchema.workPacks)
      .where(and(eq(sqliteSchema.workPacks.projectId, project.projectId), eq(sqliteSchema.workPacks.slug, args.slug)))
      .limit(1);
    const existing = workRows[0];
    if (existing === undefined) return 'work_pack_not_found';

    const linkRows = await db.db
      .select({
        provider: sqliteSchema.externalWorkItems.provider,
        externalKey: sqliteSchema.externalWorkItems.externalKey,
        issueType: sqliteSchema.externalWorkItems.issueType,
        status: sqliteSchema.externalWorkItems.status,
        url: sqliteSchema.externalWorkItems.url,
        parentExternalKey: sqliteSchema.externalWorkItems.parentExternalKey,
        rawExternalJson: sqliteSchema.externalWorkItems.rawExternalJson,
      })
      .from(sqliteSchema.workPackExternalLinks)
      .innerJoin(
        sqliteSchema.externalWorkItems,
        eq(sqliteSchema.externalWorkItems.id, sqliteSchema.workPackExternalLinks.externalWorkItemId),
      )
      .where(eq(sqliteSchema.workPackExternalLinks.workPackId, existing.id));
    const primaryLink = linkRows[0] ?? null;
    const existingRelationships =
      args.relationships === undefined
        ? await db.db
            .select({
              targetExternalKey: sqliteSchema.workPackRelationships.targetExternalKey,
              relationshipType: sqliteSchema.workPackRelationships.relationshipType,
              syncLevel: sqliteSchema.workPackRelationships.syncLevel,
              metadataJson: sqliteSchema.workPackRelationships.metadataJson,
            })
            .from(sqliteSchema.workPackRelationships)
            .where(eq(sqliteSchema.workPackRelationships.sourceWorkPackId, existing.id))
        : [];
    const relationshipsForMirror =
      args.relationships ??
      existingRelationships.map((rel) => ({
        targetExternalKey: rel.targetExternalKey,
        relationshipType: rel.relationshipType,
        syncLevel: rel.syncLevel === 'full' ? 'full' : 'summary',
        metadataJson: parseJsonObject(rel.metadataJson),
      }));
    const merged = mergeWorkPackPatch(existing, args.patch);
    const fieldsChanged =
      args.relationships === undefined
        ? merged.fieldsChanged
        : [...new Set([...merged.fieldsChanged, 'relationships'])];

    await db.db
      .update(sqliteSchema.workPacks)
      .set({
        title: merged.title,
        packType: merged.packType,
        status: merged.status,
        specMarkdown: merged.specMarkdown,
        implementationMarkdown: merged.implementationMarkdown,
        syncMarkdown: merged.syncMarkdown,
        metadataJson: merged.metadataJson,
        updatedAt: now,
      })
      .where(eq(sqliteSchema.workPacks.id, existing.id));

    if (args.relationships !== undefined) {
      await db.db
        .delete(sqliteSchema.workPackRelationships)
        .where(eq(sqliteSchema.workPackRelationships.sourceWorkPackId, existing.id));
      if (args.relationships.length > 0) {
        await db.db.insert(sqliteSchema.workPackRelationships).values(
          args.relationships.map((rel) => ({
            id: `wprel_${randomUUID()}`,
            projectId: project.projectId,
            sourceWorkPackId: existing.id,
            sourceExternalKey: primaryLink?.externalKey ?? null,
            targetExternalKey: rel.targetExternalKey,
            relationshipType: rel.relationshipType,
            syncLevel: rel.syncLevel ?? 'summary',
            metadataJson: json(rel.metadataJson),
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    }

    await db.db
      .update(sqliteSchema.workPackExternalLinks)
      .set({ syncState: 'local_ahead', conflictState: null, updatedAt: now })
      .where(eq(sqliteSchema.workPackExternalLinks.workPackId, existing.id));

    await db.db.insert(sqliteSchema.syncEvents).values({
      id: `sync_${randomUUID()}`,
      projectId: project.projectId,
      workPackId: existing.id,
      provider: primaryLink?.provider ?? 'coodra',
      direction: primaryLink === null ? 'local' : 'coodra_to_external',
      action: 'work_pack_update',
      result: primaryLink === null ? 'local_only' : 'pending_review',
      actorRunId: args.runId,
      externalKey: primaryLink?.externalKey ?? null,
      summary: syncSummary(args, fieldsChanged),
      metadataJson: json({ fieldsChanged, changeReason: args.changeReason ?? null }),
      createdAt: now,
    });

    const fileDir = await writeWorkPackFiles({
      cwd: project.cwd,
      slug: existing.slug,
      title: merged.title,
      packType: merged.packType,
      status: merged.status,
      source: sourceFromLink(primaryLink),
      specMarkdown: merged.specMarkdown,
      implementationMarkdown: merged.implementationMarkdown,
      syncMarkdown: merged.syncMarkdown,
      metadataJson: merged.metadataObject,
      relationships: relationshipsForMirror,
    });

    return {
      ok: true,
      projectId: project.projectId,
      workPackId: existing.id,
      slug: existing.slug,
      fieldsChanged,
      syncState: primaryLink === null ? 'local_only' : 'local_ahead',
      externalLinkCount: linkRows.length,
      relationshipCount: relationshipsForMirror.length,
      fileDir,
    };
  }

  const workRows = await db.db
    .select({
      id: postgresSchema.workPacks.id,
      slug: postgresSchema.workPacks.slug,
      title: postgresSchema.workPacks.title,
      packType: postgresSchema.workPacks.packType,
      status: postgresSchema.workPacks.status,
      specMarkdown: postgresSchema.workPacks.specMarkdown,
      implementationMarkdown: postgresSchema.workPacks.implementationMarkdown,
      syncMarkdown: postgresSchema.workPacks.syncMarkdown,
      metadataJson: postgresSchema.workPacks.metadataJson,
    })
    .from(postgresSchema.workPacks)
    .where(and(eq(postgresSchema.workPacks.projectId, project.projectId), eq(postgresSchema.workPacks.slug, args.slug)))
    .limit(1);
  const existing = workRows[0];
  if (existing === undefined) return 'work_pack_not_found';

  const linkRows = await db.db
    .select({
      provider: postgresSchema.externalWorkItems.provider,
      externalKey: postgresSchema.externalWorkItems.externalKey,
      issueType: postgresSchema.externalWorkItems.issueType,
      status: postgresSchema.externalWorkItems.status,
      url: postgresSchema.externalWorkItems.url,
      parentExternalKey: postgresSchema.externalWorkItems.parentExternalKey,
      rawExternalJson: postgresSchema.externalWorkItems.rawExternalJson,
    })
    .from(postgresSchema.workPackExternalLinks)
    .innerJoin(
      postgresSchema.externalWorkItems,
      eq(postgresSchema.externalWorkItems.id, postgresSchema.workPackExternalLinks.externalWorkItemId),
    )
    .where(eq(postgresSchema.workPackExternalLinks.workPackId, existing.id));
  const primaryLink = linkRows[0] ?? null;
  const existingRelationships =
    args.relationships === undefined
      ? await db.db
          .select({
            targetExternalKey: postgresSchema.workPackRelationships.targetExternalKey,
            relationshipType: postgresSchema.workPackRelationships.relationshipType,
            syncLevel: postgresSchema.workPackRelationships.syncLevel,
            metadataJson: postgresSchema.workPackRelationships.metadataJson,
          })
          .from(postgresSchema.workPackRelationships)
          .where(eq(postgresSchema.workPackRelationships.sourceWorkPackId, existing.id))
      : [];
  const relationshipsForMirror: readonly WorkPackRelationshipInput[] =
    args.relationships ??
    existingRelationships.map((rel) => ({
      targetExternalKey: rel.targetExternalKey,
      relationshipType: rel.relationshipType,
      syncLevel: rel.syncLevel === 'full' ? 'full' : 'summary',
      metadataJson: parseJsonObject(rel.metadataJson),
    }));
  const merged = mergeWorkPackPatch(existing, args.patch);
  const fieldsChanged =
    args.relationships === undefined ? merged.fieldsChanged : [...new Set([...merged.fieldsChanged, 'relationships'])];

  await db.db
    .update(postgresSchema.workPacks)
    .set({
      title: merged.title,
      packType: merged.packType,
      status: merged.status,
      specMarkdown: merged.specMarkdown,
      implementationMarkdown: merged.implementationMarkdown,
      syncMarkdown: merged.syncMarkdown,
      metadataJson: merged.metadataJson,
      updatedAt: now,
    })
    .where(eq(postgresSchema.workPacks.id, existing.id));

  if (args.relationships !== undefined) {
    await db.db
      .delete(postgresSchema.workPackRelationships)
      .where(eq(postgresSchema.workPackRelationships.sourceWorkPackId, existing.id));
    if (args.relationships.length > 0) {
      await db.db.insert(postgresSchema.workPackRelationships).values(
        args.relationships.map((rel) => ({
          id: `wprel_${randomUUID()}`,
          projectId: project.projectId,
          sourceWorkPackId: existing.id,
          sourceExternalKey: primaryLink?.externalKey ?? null,
          targetExternalKey: rel.targetExternalKey,
          relationshipType: rel.relationshipType,
          syncLevel: rel.syncLevel ?? 'summary',
          metadataJson: json(rel.metadataJson),
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
  }

  await db.db
    .update(postgresSchema.workPackExternalLinks)
    .set({ syncState: 'local_ahead', conflictState: null, updatedAt: now })
    .where(eq(postgresSchema.workPackExternalLinks.workPackId, existing.id));

  await db.db.insert(postgresSchema.syncEvents).values({
    id: `sync_${randomUUID()}`,
    projectId: project.projectId,
    workPackId: existing.id,
    provider: primaryLink?.provider ?? 'coodra',
    direction: primaryLink === null ? 'local' : 'coodra_to_external',
    action: 'work_pack_update',
    result: primaryLink === null ? 'local_only' : 'pending_review',
    actorRunId: args.runId,
    externalKey: primaryLink?.externalKey ?? null,
    summary: syncSummary(args, fieldsChanged),
    metadataJson: json({ fieldsChanged, changeReason: args.changeReason ?? null }),
    createdAt: now,
  });

  const fileDir = await writeWorkPackFiles({
    cwd: project.cwd,
    slug: existing.slug,
    title: merged.title,
    packType: merged.packType,
    status: merged.status,
    source: sourceFromLink(primaryLink),
    specMarkdown: merged.specMarkdown,
    implementationMarkdown: merged.implementationMarkdown,
    syncMarkdown: merged.syncMarkdown,
    metadataJson: merged.metadataObject,
    relationships: relationshipsForMirror,
  });

  return {
    ok: true,
    projectId: project.projectId,
    workPackId: existing.id,
    slug: existing.slug,
    fieldsChanged,
    syncState: primaryLink === null ? 'local_only' : 'local_ahead',
    externalLinkCount: linkRows.length,
    relationshipCount: relationshipsForMirror.length,
    fileDir,
  };
}

interface RankedId {
  readonly id: string;
  readonly rank: number;
}

// Same ceiling/rationale as query_decisions' FTS_CANDIDATE_CAP.
const FTS_CANDIDATE_CAP = 500 as const;

/**
 * Resolves work pack ids matching `query`, ranked best-first, via
 * `work_packs_fts`/`work_packs.search_vector` — see `packages/db/drizzle/
 * {sqlite,postgres}/00{24,26}_fts_search.sql`. Rank is normalized so
 * higher is always more relevant (SQLite's bm25() is natively
 * negative-lower-is-better; negated here to match Postgres's ts_rank()).
 * `projectId === null` means unscoped (no runId was supplied to
 * work_pack_status) — matches `listWorkPackStatus`'s existing no-runId
 * behavior of listing across every project.
 */
async function selectWorkPackIdsByQuery(db: DbHandle, projectId: string | null, query: string): Promise<RankedId[]> {
  if (db.kind === 'sqlite') {
    const ftsQuery = toSqliteFtsQuery(query);
    const rows = db.db.all<{ id: string; rank: number }>(sql`
      SELECT wp.id AS id, bm25(work_packs_fts) AS rank
      FROM work_packs_fts
      JOIN work_packs wp ON wp.id = work_packs_fts.work_pack_id
      WHERE work_packs_fts MATCH ${ftsQuery}
        ${projectId === null ? sql`` : sql`AND wp.project_id = ${projectId}`}
      ORDER BY rank
      LIMIT ${FTS_CANDIDATE_CAP}
    `);
    return rows.map((row) => ({ id: row.id, rank: -row.rank }));
  }
  const rows = (await db.db.execute(sql`
    SELECT wp.id AS id, ts_rank(wp.search_vector, plainto_tsquery('english', ${query})) AS rank
    FROM work_packs wp
    WHERE wp.search_vector @@ plainto_tsquery('english', ${query})
      ${projectId === null ? sql`` : sql`AND wp.project_id = ${projectId}`}
    ORDER BY rank DESC
    LIMIT ${FTS_CANDIDATE_CAP}
  `)) as unknown as { id: string; rank: number }[];
  return rows.map((row) => ({ id: row.id, rank: row.rank }));
}

interface WorkPackStatusRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly packType: string;
  readonly status: string;
  readonly updatedAt: Date;
  readonly externalKey: string | null;
  readonly externalStatus: string | null;
  readonly syncState: string | null;
}

/** Reorders `rows` to match `rankedIds`'s best-first order (higher rank = more relevant). */
function sortByRank(rows: WorkPackStatusRow[], rankedIds: ReadonlyArray<RankedId>): WorkPackStatusRow[] {
  const rankById = new Map(rankedIds.map((r) => [r.id, r.rank]));
  return [...rows].sort((a, b) => (rankById.get(b.id) ?? 0) - (rankById.get(a.id) ?? 0));
}

export async function listWorkPackStatus(
  db: DbHandle,
  projectId: string | null,
  query?: string,
): Promise<WorkPackStatusRow[]> {
  let rankedIds: RankedId[] | undefined;
  if (query !== undefined) {
    rankedIds = await selectWorkPackIdsByQuery(db, projectId, query);
    if (rankedIds.length === 0) return [];
  }

  if (db.kind === 'sqlite') {
    const conditions = [];
    if (projectId !== null) conditions.push(eq(sqliteSchema.workPacks.projectId, projectId));
    if (rankedIds !== undefined)
      conditions.push(
        inArray(
          sqliteSchema.workPacks.id,
          rankedIds.map((r) => r.id),
        ),
      );
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
    let selectQuery = db.db
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
      )
      .$dynamic();
    if (where !== undefined) selectQuery = selectQuery.where(where);
    if (rankedIds === undefined) selectQuery = selectQuery.orderBy(desc(sqliteSchema.workPacks.updatedAt));
    const rows = (await selectQuery) as WorkPackStatusRow[];
    return rankedIds !== undefined ? sortByRank(rows, rankedIds) : rows;
  }
  const conditions = [];
  if (projectId !== null) conditions.push(eq(postgresSchema.workPacks.projectId, projectId));
  if (rankedIds !== undefined)
    conditions.push(
      inArray(
        postgresSchema.workPacks.id,
        rankedIds.map((r) => r.id),
      ),
    );
  const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
  let selectQuery = db.db
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
    )
    .$dynamic();
  if (where !== undefined) selectQuery = selectQuery.where(where);
  if (rankedIds === undefined) selectQuery = selectQuery.orderBy(desc(postgresSchema.workPacks.updatedAt));
  const rows = (await selectQuery) as WorkPackStatusRow[];
  return rankedIds !== undefined ? sortByRank(rows, rankedIds) : rows;
}
