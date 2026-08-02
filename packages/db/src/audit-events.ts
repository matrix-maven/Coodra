import { createHash, randomUUID } from 'node:crypto';

import { desc, eq } from 'drizzle-orm';
import type { DbHandle } from './client.js';
import { SOLO_ORG_ID } from './ensure-project.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

export interface InsertAuditEventArgs {
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly runId?: string | null;
  readonly actorUserId?: string | null;
  readonly actorRunId?: string | null;
  readonly eventType: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly action: string;
  readonly result?: string;
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly beforeHash?: string | null;
  readonly afterHash?: string | null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function latestAuditHash(db: DbHandle, orgId: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.auditEvents;
    const rows = await db.db
      .select({ hash: t.hash })
      .from(t)
      .where(eq(t.orgId, orgId))
      .orderBy(desc(t.createdAt))
      .limit(1);
    return rows[0]?.hash ?? null;
  }

  const t = postgresSchema.auditEvents;
  const rows = await db.db
    .select({ hash: t.hash })
    .from(t)
    .where(eq(t.orgId, orgId))
    .orderBy(desc(t.createdAt))
    .limit(1);
  return rows[0]?.hash ?? null;
}

export async function insertAuditEvent(db: DbHandle, args: InsertAuditEventArgs): Promise<{ readonly id: string }> {
  const orgId = args.orgId ?? SOLO_ORG_ID;
  const prevHash = await latestAuditHash(db, orgId);
  const row = {
    id: randomUUID(),
    orgId,
    projectId: args.projectId ?? null,
    runId: args.runId ?? null,
    actorUserId: args.actorUserId ?? null,
    actorRunId: args.actorRunId ?? null,
    eventType: args.eventType,
    subjectTable: args.subjectTable,
    subjectId: args.subjectId,
    action: args.action,
    result: args.result ?? 'success',
    reason: args.reason ?? null,
    metadataJson: JSON.stringify(args.metadata ?? {}),
    beforeHash: args.beforeHash ?? null,
    afterHash: args.afterHash ?? null,
    prevHash,
    hash: '',
  };
  row.hash = sha256(
    stableStringify({
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      runId: row.runId,
      actorUserId: row.actorUserId,
      actorRunId: row.actorRunId,
      eventType: row.eventType,
      subjectTable: row.subjectTable,
      subjectId: row.subjectId,
      action: row.action,
      result: row.result,
      reason: row.reason,
      metadataJson: row.metadataJson,
      beforeHash: row.beforeHash,
      afterHash: row.afterHash,
      prevHash,
    }),
  );

  if (db.kind === 'sqlite') {
    await db.db.insert(sqliteSchema.auditEvents).values(row);
    return { id: row.id };
  }

  await db.db.insert(postgresSchema.auditEvents).values(row);
  return { id: row.id };
}
