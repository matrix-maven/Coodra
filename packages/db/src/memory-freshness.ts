import { eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/memory-freshness` — COOD-85.
 *
 * Freshness as computed state.
 *
 * COOD-58 gave decisions a supersede edge, but an edge only exists when
 * an agent volunteers one. Nothing has ever checked whether a pack or
 * decision still describes how the code actually behaves — which is why
 * packs referencing `apps/hooks-bridge` stayed authoritative for weeks
 * after COOD-67 deleted it, and why ranking a stale pack into position
 * 1 is worse than not retrieving it at all.
 *
 * ## Staleness is not supersession
 *
 * Two different questions, deliberately kept apart:
 *
 *   - **staleness** — is this still TRUE? Derived here from code drift.
 *   - **supersession** — has this been REPLACED? Canonical in
 *     `decision_edges` for decisions and `archived_in_pack_id` for packs.
 *
 * There is no `superseded_by` column and this module never writes one.
 * A denormalised copy of authority is a second source of truth free to
 * disagree with the edges it duplicates.
 *
 * ## Two staleness horizons, not one number
 *
 * Deliberately never collapsed into a single "staleness %", because
 * they have different causes and different fixes:
 *
 *   - **short-term** — superseded within a run. Measures churn: how
 *     often the agent's own work invalidates what it was just given.
 *     Fixed by better mid-session invalidation (COOD-84).
 *   - **long-term** — the files it was verified against have drifted
 *     over days or weeks. Measures rot. A background query, not a
 *     session-time one. Fixed by gardening cadence (COOD-86).
 *
 * ## `unverified` is not `fresh`
 *
 * Rows start `unverified` and backfill that way. Claiming a freshness
 * that was never established is exactly the error this field exists to
 * prevent — the same distinction COOD-81 drew between `unknown` and
 * `stale` for graph drift.
 */

/**
 * `unverified` — never checked. `fresh` — checked, files unchanged.
 * `stale` — checked, the files it depends on have changed since.
 */
export type MemoryFreshnessStatus = 'unverified' | 'fresh' | 'stale';

export interface MemoryFreshnessMark {
  readonly status: MemoryFreshnessStatus;
  readonly staleReason?: string | null;
  readonly verifiedAgainstCommit?: string | null;
  /** Repo-relative paths; stored as a JSON string array. */
  readonly verifiedAgainstFiles?: readonly string[] | null;
  readonly verifiedAt?: Date;
}

function encodeFiles(files: readonly string[] | null | undefined): string | null {
  if (files === undefined || files === null) return null;
  try {
    return JSON.stringify([...files]);
  } catch {
    return null;
  }
}

export function decodeVerifiedAgainstFiles(value: string | null): readonly string[] {
  if (value === null || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Record a freshness verdict against a context pack.
 *
 * Callers are gardening passes (COOD-86) and, later, `save_context_pack`
 * stamping the commit a pack was authored against. Nothing here decides
 * WHETHER something is stale — that judgement needs a working tree and
 * belongs to the caller; this module owns the storage contract only.
 */
export async function markContextPackFreshness(db: DbHandle, packId: string, mark: MemoryFreshnessMark): Promise<void> {
  const values = {
    freshnessStatus: mark.status,
    staleReason: mark.staleReason ?? null,
    verifiedAgainstCommit: mark.verifiedAgainstCommit ?? null,
    verifiedAgainstFiles: encodeFiles(mark.verifiedAgainstFiles),
    lastVerifiedAt: mark.verifiedAt ?? new Date(),
  };
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.contextPacks;
    await db.db.update(t).set(values).where(eq(t.id, packId));
    return;
  }
  const t = postgresSchema.contextPacks;
  await db.db.update(t).set(values).where(eq(t.id, packId));
}

export async function markDecisionFreshness(
  db: DbHandle,
  decisionId: string,
  mark: MemoryFreshnessMark,
): Promise<void> {
  const values = {
    freshnessStatus: mark.status,
    staleReason: mark.staleReason ?? null,
    verifiedAgainstCommit: mark.verifiedAgainstCommit ?? null,
    verifiedAgainstFiles: encodeFiles(mark.verifiedAgainstFiles),
    lastVerifiedAt: mark.verifiedAt ?? new Date(),
  };
  if (db.kind === 'sqlite') {
    await db.db.update(sqliteSchema.decisions).set(values).where(eq(sqliteSchema.decisions.id, decisionId));
    return;
  }
  await db.db.update(postgresSchema.decisions).set(values).where(eq(postgresSchema.decisions.id, decisionId));
}

/**
 * The mechanical staleness check COOD-58 was missing.
 *
 * Given the files an artifact was verified against and the set of files
 * that have changed since its `verified_against_commit`, decide whether
 * it is still true. Pure — the caller supplies the changed set (from
 * `git diff --name-only`), so this stays testable and has no opinion
 * about how the working tree is inspected.
 *
 * A deleted dependency is reported separately from a modified one: a
 * pack describing a file that no longer exists is a stronger signal
 * than one whose file merely moved on, and gardening should be able to
 * tell those apart when it proposes a fix.
 */
export function evaluateStaleness(args: {
  readonly verifiedAgainstFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly deletedFiles?: readonly string[];
}): { readonly status: MemoryFreshnessStatus; readonly staleReason: string | null } {
  // Nothing to check against is not the same as nothing having changed.
  if (args.verifiedAgainstFiles.length === 0) {
    return { status: 'unverified', staleReason: null };
  }
  const deleted = new Set(args.deletedFiles ?? []);
  const changed = new Set(args.changedFiles);

  const goneDeps = args.verifiedAgainstFiles.filter((file) => deleted.has(file));
  if (goneDeps.length > 0) {
    return { status: 'stale', staleReason: `files_deleted:${goneDeps.slice(0, 5).join(',')}` };
  }
  const changedDeps = args.verifiedAgainstFiles.filter((file) => changed.has(file));
  if (changedDeps.length > 0) {
    return { status: 'stale', staleReason: `files_changed:${changedDeps.slice(0, 5).join(',')}` };
  }
  return { status: 'fresh', staleReason: null };
}

/**
 * Current freshness for a batch of memory ids, for stamping
 * `memory_access_events.freshness_status_at_access` (COOD-78 reserved
 * the column; this fills it).
 *
 * The snapshot is taken AT ACCESS TIME on purpose. Joining freshness at
 * read time instead would let an item that goes stale next week rewrite
 * how it looked when it was actually surfaced — and "what fraction of
 * surfaced memory had already gone stale?" is a question about the
 * moment of surfacing, not about today.
 *
 * One query per batch; unknown ids are simply absent from the map, and
 * callers treat that as `unverified` rather than inventing a status.
 */
export async function freshnessForMemoryIds(
  db: DbHandle,
  memoryType: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, MemoryFreshnessStatus>> {
  const out = new Map<string, MemoryFreshnessStatus>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  try {
    const { inArray } = await import('drizzle-orm');
    if (memoryType === 'context_pack') {
      const rows =
        db.kind === 'sqlite'
          ? await db.db
              .select({ id: sqliteSchema.contextPacks.id, status: sqliteSchema.contextPacks.freshnessStatus })
              .from(sqliteSchema.contextPacks)
              .where(inArray(sqliteSchema.contextPacks.id, unique))
          : await db.db
              .select({ id: postgresSchema.contextPacks.id, status: postgresSchema.contextPacks.freshnessStatus })
              .from(postgresSchema.contextPacks)
              .where(inArray(postgresSchema.contextPacks.id, unique));
      for (const row of rows) out.set(row.id, row.status as MemoryFreshnessStatus);
      return out;
    }
    if (memoryType === 'decision') {
      const rows =
        db.kind === 'sqlite'
          ? await db.db
              .select({ id: sqliteSchema.decisions.id, status: sqliteSchema.decisions.freshnessStatus })
              .from(sqliteSchema.decisions)
              .where(inArray(sqliteSchema.decisions.id, unique))
          : await db.db
              .select({ id: postgresSchema.decisions.id, status: postgresSchema.decisions.freshnessStatus })
              .from(postgresSchema.decisions)
              .where(inArray(postgresSchema.decisions.id, unique));
      for (const row of rows) out.set(row.id, row.status as MemoryFreshnessStatus);
      return out;
    }
    // wiki pages, recipes and work packs have no freshness columns yet;
    // absent from the map means "unverified", which is the truth.
    return out;
  } catch {
    return out;
  }
}
