import { and, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

const CAPABILITY_ID_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;

export interface RunCapabilityMutation {
  readonly status: 'updated' | 'not_found';
  readonly capabilities: readonly string[];
}

export function normalizeRunCapability(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return CAPABILITY_ID_RE.test(normalized) ? normalized : null;
}

export function normalizeRunCapabilities(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeRunCapability(value);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseRunCapabilitiesJson(value: string | null | undefined): readonly string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeRunCapabilities(parsed.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return [];
  }
}

export function serializeRunCapabilities(values: readonly string[]): string {
  return JSON.stringify(normalizeRunCapabilities(values));
}

export async function getRunActiveCapabilities(
  db: DbHandle,
  args: { readonly runId: string },
): Promise<readonly string[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ activeCapabilitiesJson: sqliteSchema.runs.activeCapabilitiesJson })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, args.runId))
      .limit(1);
    return parseRunCapabilitiesJson(rows[0]?.activeCapabilitiesJson);
  }
  const rows = await db.db
    .select({ activeCapabilitiesJson: postgresSchema.runs.activeCapabilitiesJson })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, args.runId))
    .limit(1);
  return parseRunCapabilitiesJson(rows[0]?.activeCapabilitiesJson);
}

export async function getRunActiveCapabilitiesForSession(
  db: DbHandle,
  args: { readonly projectId: string; readonly sessionId: string },
): Promise<readonly string[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ activeCapabilitiesJson: sqliteSchema.runs.activeCapabilitiesJson })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, args.projectId), eq(sqliteSchema.runs.sessionId, args.sessionId)))
      .limit(1);
    return parseRunCapabilitiesJson(rows[0]?.activeCapabilitiesJson);
  }
  const rows = await db.db
    .select({ activeCapabilitiesJson: postgresSchema.runs.activeCapabilitiesJson })
    .from(postgresSchema.runs)
    .where(and(eq(postgresSchema.runs.projectId, args.projectId), eq(postgresSchema.runs.sessionId, args.sessionId)))
    .limit(1);
  return parseRunCapabilitiesJson(rows[0]?.activeCapabilitiesJson);
}

export async function updateRunActiveCapabilities(
  db: DbHandle,
  args: { readonly runId: string; readonly capabilities: readonly string[] },
): Promise<RunCapabilityMutation> {
  const capabilities = normalizeRunCapabilities(args.capabilities);
  const activeCapabilitiesJson = serializeRunCapabilities(capabilities);
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await db.db.select({ id: t.id }).from(t).where(eq(t.id, args.runId)).limit(1);
    if (rows.length === 0) return { status: 'not_found', capabilities };
    await db.db.update(t).set({ activeCapabilitiesJson }).where(eq(t.id, args.runId));
    return { status: 'updated', capabilities };
  }
  const t = postgresSchema.runs;
  const updated = await db.db
    .update(t)
    .set({ activeCapabilitiesJson })
    .where(eq(t.id, args.runId))
    .returning({ id: t.id });
  if (updated.length === 0) return { status: 'not_found', capabilities };
  return { status: 'updated', capabilities };
}
