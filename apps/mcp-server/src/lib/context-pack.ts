import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { type DbHandle, postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { type Logger, ValidationError } from '@coodra/shared';
import {
  contextPackFilename as sharedContextPackFilename,
  defaultContextPacksRoot as sharedDefaultContextPacksRoot,
} from '@coodra/shared/context-pack-paths';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { ContextPackStore } from '../framework/tool-context.js';
import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/context-pack.ts` — DB-first Context-Pack
 * store wired into `ToolContext.contextPack`.
 *
 * Module 05 reshape (2026-05-08): the embedding-supplied path was
 * removed entirely. The store no longer accepts a `Float32Array`
 * second argument — it accepts an `options` object with `source`
 * ('agent' | 'bridge_auto') and optional `meta` (JSON-encodable
 * agent-curated metadata). See
 * `docs/feature-packs/05-agent-driven-nl-assembly/spec.md` §5.4 for
 * the source semantics — including the single ADR-007 relaxation
 * that lets an agent-explicit save overwrite a bridge_auto row.
 *
 * Write flow (append-only redesign, 2026-08-05 — see
 * `packages/db/drizzle/sqlite/0026_context_packs_append_only.sql`): a
 * run is a session, not a unit of work, and a session can legitimately
 * touch several units of work (a Work Pack it's resuming, plus ad hoc
 * asks). `context_packs` no longer enforces one row per run — a run
 * accumulates one pack per unit of work, each optionally linked to a
 * Work Pack via `workPackId`.
 *   1. Validate the `pack` payload with a module-local Zod schema.
 *   2. Compute `content_excerpt` = first 500 Unicode CODE POINTS of
 *      `content` with trailing whitespace trimmed. Emoji + CJK at
 *      position 499 survive.
 *   3. Look up every existing row for `runId` (newest first):
 *        - Any row with identical `(title, content)` → true
 *          idempotency, return that row unchanged. This is what
 *          protects a network retry from duplicating a row; it no
 *          longer fires just because *any* row exists for the run.
 *        - Else, if the MOST RECENT row is `source='bridge_auto'` and
 *          the incoming call is `source='agent'` → UPDATE content +
 *          flip source in place (the M05 single ADR-007 relaxation,
 *          now scoped to the most recent row specifically, not "any"
 *          row).
 *        - Otherwise → INSERT a new row. This is the default path for
 *          a second, genuinely different save on the same run.
 *   4. If a Work Pack is resolved (from `workPackId` or the row's
 *      existing link), mechanically update
 *      `work_packs.{last_activity_at,latest_context_pack_id}` in the
 *      same call — not a background job, always run regardless of
 *      which branch above fired.
 *   5. Materialise the on-disk markdown file under
 *      `docs/context-packs/YYYY-MM-DD-<runId-first-8>.md`. Failure is
 *      non-fatal — DB is source of truth.
 */

const contextPackLogger = createMcpLogger('lib-context-pack');

const EXCERPT_MAX_CODE_POINTS = 500 as const;

// ---------------------------------------------------------------------------
// Context payload schema
// ---------------------------------------------------------------------------

const packSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
});
export type ContextPackInput = z.infer<typeof packSchema>;

/**
 * Optional metadata the agent supplies on `save_context_pack`. Stored as
 * JSON-encoded text in `context_packs.meta`. Validated at the tool
 * boundary (see save-context-pack/schema.ts) — this layer trusts the
 * shape and only does a minimal sanity check.
 */
export interface ContextPackMeta {
  readonly decisionIds?: ReadonlyArray<string>;
  readonly affectedFiles?: ReadonlyArray<string>;
  readonly testStatus?: 'pass' | 'fail' | 'skip' | 'unknown';
  readonly openTodos?: ReadonlyArray<string>;
  readonly workPackSlug?: string;
}

export type ContextPackSource = 'agent' | 'bridge_auto';

export interface ContextPackWriteOptions {
  readonly source: ContextPackSource;
  readonly meta?: ContextPackMeta;
  /**
   * Module 04 Phase 4 — Clerk user id of the human saving the pack.
   * Forwarded to `context_packs.created_by_user_id`. NULL in solo
   * mode + when the actor identity is unavailable.
   */
  readonly createdByUserId?: string | null;
  readonly orgId?: string | null;
  /** Nullable Work Pack link for smart Jira-work sessions. */
  readonly workPackId?: string | null;
  /**
   * Append-only redesign (2026-08-05). Soft-governed, free text — not a
   * hard enum. Recommended values: 'sync' | 'work_start' |
   * 'implementation_recap' | 'audit_findings' | 'final_recap' |
   * 'bridge_auto'. Deliberately provider-neutral ('sync', not
   * 'jira_sync') — the provider lives on the linked Work Pack's own
   * source.provider, one join away.
   */
  readonly kind?: string | null;
  /** Soft-governed, free text. Recommended values: 'high' | 'medium' | 'low'. */
  readonly importance?: string | null;
}

export interface ContextPackWriteResult {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: Date;
  readonly contentExcerpt: string;
  readonly filePath: string | null;
  readonly source: ContextPackSource;
  /**
   * 'created' | 'idempotent_hit' | 'upgraded_from_bridge_auto'. Lets
   * callers tell apart. Append-only redesign (2026-08-05): 'created' now
   * legitimately fires more than once per run (whenever content genuinely
   * differs); 'idempotent_hit' now means "exact (title, content) match
   * with an existing row for this run," not "any row already exists."
   */
  readonly status: 'created' | 'idempotent_hit' | 'upgraded_from_bridge_auto';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unicode code-point-safe excerpt. `String.prototype.slice(0, N)`
 * operates on UTF-16 code units and splits surrogate pairs mid-
 * character for emoji and supplementary-plane CJK. `Array.from`
 * iterates code points, so slicing the resulting array preserves
 * whole characters. Also trims trailing whitespace so a run of
 * newlines at the end doesn't poison LIKE search.
 */
export function computeContentExcerpt(content: string, max: number = EXCERPT_MAX_CODE_POINTS): string {
  if (typeof content !== 'string') return '';
  const chars = Array.from(content);
  const sliced = chars.length <= max ? chars : chars.slice(0, max);
  return sliced.join('').replace(/\s+$/u, '');
}

export const defaultContextPacksRoot = sharedDefaultContextPacksRoot;
export const contextPackFilename = sharedContextPackFilename;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function selectByRunId(db: DbHandle, runId: string) {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .orderBy(desc(sqliteSchema.contextPacks.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select()
    .from(postgresSchema.contextPacks)
    .where(eq(postgresSchema.contextPacks.runId, runId))
    .orderBy(desc(postgresSchema.contextPacks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Append-only redesign (2026-08-05). Every existing row for a run,
 * newest first — `write()` needs the full set to check for an exact
 * (title, content) idempotency match and to find the most recent row
 * for the narrow bridge_auto->agent upgrade case.
 */
async function selectAllByRunId(db: DbHandle, runId: string) {
  if (db.kind === 'sqlite') {
    return db.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .orderBy(desc(sqliteSchema.contextPacks.createdAt));
  }
  return db.db
    .select()
    .from(postgresSchema.contextPacks)
    .where(eq(postgresSchema.contextPacks.runId, runId))
    .orderBy(desc(postgresSchema.contextPacks.createdAt));
}

/**
 * Append-only redesign (2026-08-05) — mechanically updates the Work
 * Pack activity rollup in the same call as a context-pack write, never
 * via a background job. Always safe to call; both columns are simple
 * denormalized pointers with no derived/summarized content. Exported
 * so `save-context-pack/handler.ts` can also bump activity for a
 * pack's *secondary* `alsoLinkWorkPackSlugs` Work Packs, not just the
 * primary one this module's own `write()` already bumps.
 */
export async function touchWorkPackActivity(
  db: DbHandle,
  workPackId: string,
  latestContextPackId: string,
  now: Date,
): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.workPacks)
      .set({ lastActivityAt: now, latestContextPackId })
      .where(eq(sqliteSchema.workPacks.id, workPackId));
    return;
  }
  await db.db
    .update(postgresSchema.workPacks)
    .set({ lastActivityAt: now, latestContextPackId })
    .where(eq(postgresSchema.workPacks.id, workPackId));
}

async function insertRow(
  db: DbHandle,
  row: {
    readonly id: string;
    readonly runId: string;
    readonly orgId: string | null;
    readonly projectId: string;
    readonly title: string;
    readonly content: string;
    readonly contentExcerpt: string;
    readonly source: ContextPackSource;
    readonly metaJson: string | null;
    readonly createdByUserId: string | null;
    readonly workPackId: string | null;
    readonly kind: string | null;
    readonly importance: string | null;
  },
): Promise<{ readonly createdAt: Date }> {
  if (db.kind === 'sqlite') {
    const baseRow = {
      id: row.id,
      runId: row.runId,
      orgId: row.orgId,
      projectId: row.projectId,
      title: row.title,
      content: row.content,
      contentExcerpt: row.contentExcerpt,
      source: row.source,
      meta: row.metaJson,
      workPackId: row.workPackId,
      createdByUserId: row.createdByUserId,
      kind: row.kind,
      importance: row.importance,
    };
    const inserted = await db.db
      .insert(sqliteSchema.contextPacks)
      .values(baseRow)
      .returning({ id: sqliteSchema.contextPacks.id, createdAt: sqliteSchema.contextPacks.createdAt });
    return { createdAt: inserted[0]?.createdAt ?? new Date() };
  }
  const values = {
    id: row.id,
    runId: row.runId,
    orgId: row.orgId,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    contentExcerpt: row.contentExcerpt,
    source: row.source,
    meta: row.metaJson,
    workPackId: row.workPackId,
    createdByUserId: row.createdByUserId,
    kind: row.kind,
    importance: row.importance,
  };
  const inserted = await db.db
    .insert(postgresSchema.contextPacks)
    .values(values as typeof postgresSchema.contextPacks.$inferInsert)
    .returning({ id: postgresSchema.contextPacks.id, createdAt: postgresSchema.contextPacks.createdAt });
  return { createdAt: inserted[0]?.createdAt ?? new Date() };
}

async function upgradeBridgeAutoToAgent(
  db: DbHandle,
  rowId: string,
  payload: {
    readonly title: string;
    readonly content: string;
    readonly contentExcerpt: string;
    readonly metaJson: string | null;
    readonly workPackId: string | null;
    readonly kind: string | null;
    readonly importance: string | null;
  },
): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.contextPacks)
      .set({
        title: payload.title,
        content: payload.content,
        contentExcerpt: payload.contentExcerpt,
        source: 'agent',
        meta: payload.metaJson,
        workPackId: payload.workPackId,
        kind: payload.kind,
        importance: payload.importance,
      })
      .where(eq(sqliteSchema.contextPacks.id, rowId));
    return;
  }
  await db.db
    .update(postgresSchema.contextPacks)
    .set({
      title: payload.title,
      content: payload.content,
      contentExcerpt: payload.contentExcerpt,
      source: 'agent',
      meta: payload.metaJson,
      workPackId: payload.workPackId,
      kind: payload.kind,
      importance: payload.importance,
    })
    .where(eq(postgresSchema.contextPacks.id, rowId));
}

async function linkExistingContextPackToWorkPack(db: DbHandle, rowId: string, workPackId: string): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db.update(sqliteSchema.contextPacks).set({ workPackId }).where(eq(sqliteSchema.contextPacks.id, rowId));
    return;
  }
  await db.db.update(postgresSchema.contextPacks).set({ workPackId }).where(eq(postgresSchema.contextPacks.id, rowId));
}

// ---------------------------------------------------------------------------
// SessionStart diversified selection (append-only redesign, 2026-08-05)
// ---------------------------------------------------------------------------

export interface DiversifiedContextPackRow {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  // Every Work Pack this pack is linked to — the primary
  // `context_packs.work_pack_id` (if set) plus any secondary links via
  // `work_pack_context_pack_links` (`save_context_pack`'s
  // `alsoLinkWorkPackSlugs`). Empty array = genuinely no Work Pack.
  // Parallel arrays (same order, same length) rather than pair objects
  // to keep the common `.map(p => p.workPackSlugs)` call site simple.
  readonly workPackIds: ReadonlyArray<string>;
  readonly workPackSlugs: ReadonlyArray<string>;
  readonly kind: string | null;
  readonly runId: string;
  readonly createdAt: Date;
  readonly tier: ContextPackInjectionTier;
}

export interface DiversifiedOverflowNote {
  readonly workPackSlug: string;
  readonly hiddenCount: number;
}

export interface SelectDiversifiedRecentContextPacksResult {
  readonly packs: ReadonlyArray<DiversifiedContextPackRow>;
  readonly overflow: ReadonlyArray<DiversifiedOverflowNote>;
}

// Lower rank = shown first when a Work Pack has more packs than
// `maxPerWorkPack` allows. Unlisted/unknown kinds (including `null`)
// sort last — soft governance, a future kind not in this list just
// doesn't get prioritized, it isn't rejected.
const KIND_PRIORITY: Readonly<Record<string, number>> = {
  final_recap: 0,
  implementation_recap: 1,
  audit_findings: 2,
  work_start: 3,
  sync: 4,
  bridge_auto: 5,
};

function kindRank(kind: string | null): number {
  if (kind === null) return 6;
  return KIND_PRIORITY[kind] ?? 6;
}

export type ContextPackInjectionTier = 'hot' | 'warm';

function tierForWorkPackStatuses(
  statuses: ReadonlyArray<string>,
  archivedInPackId: string | null,
): ContextPackInjectionTier | null {
  if (archivedInPackId !== null) return null;
  if (statuses.length === 0) return 'hot';
  return statuses.every((status) => status === 'done') ? 'warm' : 'hot';
}

/**
 * Every group here is constructed by pushing at least one row before
 * being stored in the grouping Map (see `selectDiversifiedRecentContextPacks`),
 * so `rows[0]` is never actually empty — this just gives TypeScript
 * (`noUncheckedIndexedAccess`) an explicit invariant check instead of a
 * silent `!` assertion.
 */
function firstRow(rows: readonly DiversifiedContextPackRow[]): DiversifiedContextPackRow {
  const row = rows[0];
  if (row === undefined) throw new Error('selectDiversifiedRecentContextPacks: unexpected empty group');
  return row;
}

type WorkPackLink = { readonly id: string; readonly slug: string; readonly status: string };

/**
 * Fetches the secondary `work_pack_context_pack_links` rows for a
 * candidate id set, joined to `work_packs` for the slug. The primary
 * `context_packs.work_pack_id` link is already redundantly mirrored
 * into this same table by `save_context_pack`'s handler, but that
 * mirroring isn't guaranteed for every historical/direct-write path —
 * callers of this function still merge it against the primary column
 * separately rather than relying on the link table alone.
 */
async function fetchSecondaryWorkPackLinks(
  db: DbHandle,
  contextPackIds: ReadonlyArray<string>,
): Promise<Map<string, WorkPackLink[]>> {
  const byContextPackId = new Map<string, WorkPackLink[]>();
  if (contextPackIds.length === 0) return byContextPackId;
  if (db.kind === 'sqlite') {
    const links = sqliteSchema.workPackContextPackLinks;
    const wp = sqliteSchema.workPacks;
    const rows = await db.db
      .select({ contextPackId: links.contextPackId, workPackId: links.workPackId, slug: wp.slug, status: wp.status })
      .from(links)
      .innerJoin(wp, eq(links.workPackId, wp.id))
      .where(inArray(links.contextPackId, contextPackIds));
    for (const r of rows) {
      const list = byContextPackId.get(r.contextPackId) ?? [];
      list.push({ id: r.workPackId, slug: r.slug, status: r.status });
      byContextPackId.set(r.contextPackId, list);
    }
    return byContextPackId;
  }
  const links = postgresSchema.workPackContextPackLinks;
  const wp = postgresSchema.workPacks;
  const rows = await db.db
    .select({ contextPackId: links.contextPackId, workPackId: links.workPackId, slug: wp.slug, status: wp.status })
    .from(links)
    .innerJoin(wp, eq(links.workPackId, wp.id))
    .where(inArray(links.contextPackId, contextPackIds));
  for (const r of rows) {
    const list = byContextPackId.get(r.contextPackId) ?? [];
    list.push({ id: r.workPackId, slug: r.slug, status: r.status });
    byContextPackId.set(r.contextPackId, list);
  }
  return byContextPackId;
}

async function fetchDiversificationCandidates(
  db: DbHandle,
  projectId: string,
  limit: number,
): Promise<DiversifiedContextPackRow[]> {
  type PrimaryRow = {
    readonly id: string;
    readonly title: string;
    readonly excerpt: string;
    readonly workPackId: string | null;
    readonly workPackSlug: string | null;
    readonly workPackStatus: string | null;
    readonly kind: string | null;
    readonly runId: string;
    readonly createdAt: Date;
    readonly archivedInPackId: string | null;
  };
  let primaryRows: PrimaryRow[];
  if (db.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const wp = sqliteSchema.workPacks;
    const rows = await db.db
      .select({
        id: cp.id,
        title: cp.title,
        excerpt: cp.contentExcerpt,
        workPackId: cp.workPackId,
        workPackSlug: wp.slug,
        workPackStatus: wp.status,
        kind: cp.kind,
        runId: cp.runId,
        createdAt: cp.createdAt,
        archivedInPackId: cp.archivedInPackId,
      })
      .from(cp)
      .leftJoin(wp, eq(cp.workPackId, wp.id))
      .where(eq(cp.projectId, projectId))
      .orderBy(desc(cp.createdAt))
      .limit(limit);
    primaryRows = rows.map((r) => ({
      ...r,
      workPackSlug: r.workPackSlug ?? null,
      workPackStatus: r.workPackStatus ?? null,
      archivedInPackId: r.archivedInPackId ?? null,
    }));
  } else {
    const cp = postgresSchema.contextPacks;
    const wp = postgresSchema.workPacks;
    const rows = await db.db
      .select({
        id: cp.id,
        title: cp.title,
        excerpt: cp.contentExcerpt,
        workPackId: cp.workPackId,
        workPackSlug: wp.slug,
        workPackStatus: wp.status,
        kind: cp.kind,
        runId: cp.runId,
        createdAt: cp.createdAt,
        archivedInPackId: cp.archivedInPackId,
      })
      .from(cp)
      .leftJoin(wp, eq(cp.workPackId, wp.id))
      .where(eq(cp.projectId, projectId))
      .orderBy(desc(cp.createdAt))
      .limit(limit);
    primaryRows = rows.map((r) => ({
      ...r,
      workPackSlug: r.workPackSlug ?? null,
      workPackStatus: r.workPackStatus ?? null,
      archivedInPackId: r.archivedInPackId ?? null,
    }));
  }

  const secondaryLinks = await fetchSecondaryWorkPackLinks(
    db,
    primaryRows.map((r) => r.id),
  );

  return primaryRows.flatMap((r) => {
    const links = new Map<string, WorkPackLink>();
    if (r.workPackId !== null && r.workPackSlug !== null && r.workPackStatus !== null) {
      links.set(r.workPackId, { id: r.workPackId, slug: r.workPackSlug, status: r.workPackStatus });
    }
    for (const link of secondaryLinks.get(r.id) ?? []) {
      if (!links.has(link.id)) links.set(link.id, link);
    }
    const tier = tierForWorkPackStatuses(
      [...links.values()].map((link) => link.status),
      r.archivedInPackId,
    );
    if (tier === null) return [];
    return {
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      workPackIds: [...links.keys()],
      workPackSlugs: [...links.values()].map((link) => link.slug),
      kind: r.kind,
      runId: r.runId,
      createdAt: r.createdAt,
      tier,
    };
  });
}

interface WorkPackDiversificationGroup {
  readonly type: 'work_pack';
  readonly workPackId: string;
  readonly workPackSlug: string;
  readonly rows: DiversifiedContextPackRow[];
}
interface RunDiversificationGroup {
  readonly type: 'run';
  readonly runId: string;
  readonly rows: DiversifiedContextPackRow[];
}
type DiversificationGroup = WorkPackDiversificationGroup | RunDiversificationGroup;

/**
 * Append-only redesign (2026-08-05), widened 2026-08-05 to also honor
 * secondary `work_pack_context_pack_links` and to interleave the
 * no-Work-Pack bucket by recency instead of only filling it with
 * whatever budget Work Pack groups left over. SessionStart's "recent
 * context" injection used to be a flat `list_context_packs(limit: 3)`,
 * which assumed ~1 pack per run. Now that a single chatty run can
 * legitimately produce several packs across different (or no) Work
 * Packs, a flat recency slice can be dominated entirely by one run and
 * silently drop everything from before it — the opposite of what the
 * injection is for.
 *
 * This does NOT live on the public `list_context_packs` tool — it's a
 * startup-injection-specific selection *policy* (diversify by Work Pack,
 * prefer higher-value `kind`s, cap per group), not a generally useful
 * "list" semantic an agent calling the tool directly would expect.
 *
 * Algorithm: fetch a wide recent candidate set; a pack with N linked
 * Work Packs (primary + secondary) is a member of all N of those
 * Work Packs' groups, plus its own run's no-Work-Pack group if it has
 * zero links at all — group membership is not mutually exclusive, but
 * final *selection* is deduplicated (a pack is never shown twice).
 * Every group (Work Pack groups and no-Work-Pack run groups alike) is
 * then ranked together in ONE recency-ordered pass, by its own
 * most-recent pack, so a very recent ad hoc save can't be starved by
 * older Work Pack activity just for lacking a Work Pack tag. Within a
 * Work Pack group, packs not yet claimed by an earlier (more recent)
 * group are taken up to `maxPerWorkPack`, kind-prioritized; a
 * no-Work-Pack run group takes up to `maxPerRunWithoutWorkPack`,
 * recency-only. Both cap types stop once `startupBudget` total rows
 * are selected. No "current Work Pack" prioritization — a fresh
 * SessionStart has no resolved Work Pack yet to prioritize; inferring
 * "this session probably resumes Work Pack X" (git branch, etc.) is a
 * real but separate, heuristic-based follow-up, not built here.
 */
export async function selectDiversifiedRecentContextPacks(
  db: DbHandle,
  args: {
    readonly projectId: string;
    readonly internalFetchLimit?: number;
    readonly startupBudget?: number;
    readonly maxPerWorkPack?: number;
    readonly maxPerRunWithoutWorkPack?: number;
  },
): Promise<SelectDiversifiedRecentContextPacksResult> {
  const internalFetchLimit = args.internalFetchLimit ?? 50;
  const startupBudget = args.startupBudget ?? 6;
  const maxPerWorkPack = args.maxPerWorkPack ?? 2;
  const maxPerRunWithoutWorkPack = args.maxPerRunWithoutWorkPack ?? 1;

  const rows = await fetchDiversificationCandidates(db, args.projectId, internalFetchLimit);

  const byWorkPack = new Map<string, WorkPackDiversificationGroup>();
  const noWorkPackByRun = new Map<string, RunDiversificationGroup>();
  for (const row of rows) {
    if (row.workPackIds.length > 0) {
      for (let i = 0; i < row.workPackIds.length; i++) {
        const workPackId = row.workPackIds[i];
        const workPackSlug = row.workPackSlugs[i];
        if (workPackId === undefined || workPackSlug === undefined) continue;
        const group = byWorkPack.get(workPackId) ?? { type: 'work_pack', workPackId, workPackSlug, rows: [] };
        group.rows.push(row);
        byWorkPack.set(workPackId, group);
      }
    } else {
      const group = noWorkPackByRun.get(row.runId) ?? { type: 'run', runId: row.runId, rows: [] };
      group.rows.push(row);
      noWorkPackByRun.set(row.runId, group);
    }
  }

  // Rows arrived createdAt-desc from the query and are appended to
  // groups in that same order, so `group.rows[0]` is each group's most
  // recent pack — one unified list, Work Pack groups and no-Work-Pack
  // run groups together, ranked by that.
  const groups: DiversificationGroup[] = [...byWorkPack.values(), ...noWorkPackByRun.values()].sort(
    (a, b) => firstRow(b.rows).createdAt.getTime() - firstRow(a.rows).createdAt.getTime(),
  );

  const selected: DiversifiedContextPackRow[] = [];
  const pickedIds = new Set<string>();
  const overflow: DiversifiedOverflowNote[] = [];

  for (const group of groups) {
    if (selected.length >= startupBudget) break;
    const unclaimed = group.rows.filter((r) => !pickedIds.has(r.id));
    if (unclaimed.length === 0) continue;
    const cap = group.type === 'work_pack' ? maxPerWorkPack : maxPerRunWithoutWorkPack;
    const sorted =
      group.type === 'work_pack'
        ? [...unclaimed].sort((a, b) => {
            const rankDiff = kindRank(a.kind) - kindRank(b.kind);
            return rankDiff !== 0 ? rankDiff : b.createdAt.getTime() - a.createdAt.getTime();
          })
        : unclaimed;
    const remainingBudget = startupBudget - selected.length;
    const take = sorted.slice(0, Math.min(cap, remainingBudget));
    for (const row of take) pickedIds.add(row.id);
    selected.push(...take);
    // No overflow note for the null-Work-Pack bucket — overflow notes
    // are keyed by workPackSlug, which doesn't exist for ad hoc runs.
    if (group.type === 'work_pack' && sorted.length > take.length) {
      overflow.push({ workPackSlug: group.workPackSlug, hiddenCount: sorted.length - take.length });
    }
  }

  selected.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { packs: selected, overflow };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateContextPackStoreDeps {
  readonly db: DbHandle;
  /** Root for on-disk `YYYY-MM-DD-<runId>.md` files. Defaults to `${cwd}/docs/context-packs`. */
  readonly contextPacksRoot?: string;
  readonly logger?: Logger;
}

export function createContextPackStore(deps: CreateContextPackStoreDeps): ContextPackStore {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createContextPackStore requires an options object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createContextPackStore: deps.db must be a DbHandle from @coodra/db');
  }
  const log = deps.logger ?? contextPackLogger;
  const contextPacksRoot = deps.contextPacksRoot ?? defaultContextPacksRoot();

  log.info(
    { event: 'context_pack_store_wired', contextPacksRoot, mode: 'agent_driven_m05' },
    'createContextPackStore: DB-first store wired (FS is reconcilable, no embedding pipeline).',
  );

  return {
    async write(pack, options) {
      const parsed = packSchema.safeParse(pack);
      if (!parsed.success) {
        throw new ValidationError(
          `context-pack.write: invalid pack payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const input = parsed.data;
      const writeOptions: ContextPackWriteOptions = options ?? { source: 'agent' };
      const incomingSource: ContextPackSource = writeOptions.source ?? 'agent';
      const metaJson =
        writeOptions.meta !== undefined && writeOptions.meta !== null ? JSON.stringify(writeOptions.meta) : null;
      const contentExcerpt = computeContentExcerpt(input.content);
      const kind = writeOptions.kind ?? null;
      const importance = writeOptions.importance ?? null;
      const now = new Date();

      // Append-only redesign (2026-08-05): fetch every existing row for
      // this run (newest first) instead of just one — a run can hold
      // many Context Packs now, so "is this a no-op?" needs to check for
      // an exact content match, not just "does any row already exist?".
      const existingRows = await selectAllByRunId(deps.db, input.runId);

      // True idempotency (retry-safety): an exact (title, content) match
      // against ANY existing row for this run is a genuine retry of the
      // same logical save, not a new one — return it unchanged rather
      // than duplicating it.
      const exactMatch = existingRows.find((row) => row.title === input.title && row.content === input.content);
      if (exactMatch) {
        const incomingWorkPackId = writeOptions.workPackId ?? null;
        if ((exactMatch.workPackId ?? null) === null && incomingWorkPackId !== null) {
          await linkExistingContextPackToWorkPack(deps.db, exactMatch.id, incomingWorkPackId);
        }
        const effectiveWorkPackId = exactMatch.workPackId ?? incomingWorkPackId;
        if (effectiveWorkPackId !== null) {
          await touchWorkPackActivity(deps.db, effectiveWorkPackId, exactMatch.id, now);
        }
        log.info(
          {
            event: 'context_pack_idempotent_hit',
            runId: input.runId,
            id: exactMatch.id,
            existingSource: exactMatch.source,
            incomingSource,
          },
          'context-pack.write: exact (title, content) match against an existing row for this run — returning it unchanged',
        );
        return {
          id: exactMatch.id,
          runId: exactMatch.runId,
          createdAt: exactMatch.createdAt,
          contentExcerpt: exactMatch.contentExcerpt,
          filePath: null,
          source: exactMatch.source === 'bridge_auto' ? 'bridge_auto' : 'agent',
          status: 'idempotent_hit',
        };
      }

      // M05 single ADR-007 relaxation, narrowed (2026-08-05) to
      // specifically the most recent row for this run — an agent-explicit
      // save upgrades a still-unauthored auto-save in place rather than
      // sitting alongside it as a near-empty redundant row.
      const mostRecent = existingRows[0] ?? null;
      if (mostRecent && mostRecent.source === 'bridge_auto' && incomingSource === 'agent') {
        const effectiveWorkPackId = writeOptions.workPackId ?? mostRecent.workPackId ?? null;
        await upgradeBridgeAutoToAgent(deps.db, mostRecent.id, {
          title: input.title,
          content: input.content,
          contentExcerpt,
          metaJson,
          workPackId: effectiveWorkPackId,
          kind,
          importance,
        });
        log.info(
          { event: 'context_pack_upgraded_from_bridge_auto', runId: input.runId, id: mostRecent.id },
          'context-pack.write: upgraded bridge_auto row to agent-authored',
        );
        if (effectiveWorkPackId !== null) {
          await touchWorkPackActivity(deps.db, effectiveWorkPackId, mostRecent.id, now);
        }
        // Re-write the FS materialisation too — non-fatal if it fails.
        let filePath: string | null = null;
        try {
          await mkdir(contextPacksRoot, { recursive: true });
          const filename = contextPackFilename(input.runId, mostRecent.createdAt);
          const fullPath = resolve(contextPacksRoot, filename);
          await writeFile(fullPath, input.content, 'utf8');
          filePath = fullPath;
        } catch (err) {
          log.warn(
            {
              event: 'context_pack_fs_upgrade_write_failed',
              runId: input.runId,
              err: err instanceof Error ? err.message : String(err),
            },
            'context-pack.write: upgrade DB succeeded but FS write failed — row is durable, FS reconcilable',
          );
        }
        return {
          id: mostRecent.id,
          runId: mostRecent.runId,
          createdAt: mostRecent.createdAt,
          contentExcerpt,
          filePath,
          source: 'agent',
          status: 'upgraded_from_bridge_auto',
        };
      }

      // Default path (2026-08-05): a genuinely new save on this run —
      // whether it's the run's first ever pack or its fourth — always
      // inserts a new row. This is what actually fixes the original bug
      // (a second, different-content save on the same run silently
      // discarding the new content).
      const id = `cp_${randomUUID()}`;
      const effectiveWorkPackId = writeOptions.workPackId ?? null;
      const { createdAt } = await insertRow(deps.db, {
        id,
        runId: input.runId,
        orgId: writeOptions.orgId ?? null,
        projectId: input.projectId,
        title: input.title,
        content: input.content,
        contentExcerpt,
        source: incomingSource,
        metaJson,
        createdByUserId: writeOptions.createdByUserId ?? null,
        workPackId: effectiveWorkPackId,
        kind,
        importance,
      });
      if (effectiveWorkPackId !== null) {
        await touchWorkPackActivity(deps.db, effectiveWorkPackId, id, now);
      }

      // M04 Phase 4: in team mode, enqueue a sync_to_cloud job so the
      // sync-daemon pushes the context pack to cloud Postgres. Without
      // this, the row only ever lives in local SQLite and teammates
      // never see it via the team-rows-puller. Solo mode skips.
      if (process.env.COODRA_MODE === 'team') {
        try {
          await scheduleDurableWrite(deps.db, {
            queue: 'sync_to_cloud',
            payload: { v: 1 as const, table: 'context_packs', lookup: { kind: 'id', value: id } },
          });
        } catch (err) {
          log.warn(
            {
              event: 'context_pack_sync_enqueue_failed',
              contextPackId: id,
              err: err instanceof Error ? err.message : String(err),
            },
            'sync_to_cloud enqueue threw after context_pack insert — row will not reach cloud until next save',
          );
        }
      }

      // Materialise FS view. Failure is non-fatal — DB is source of truth.
      // Append-only redesign: pass `id` as the filename discriminator so
      // a second pack on this run today doesn't overwrite the first's
      // file on disk (see contextPackFilename's docblock).
      let filePath: string | null = null;
      try {
        await mkdir(contextPacksRoot, { recursive: true });
        const filename = contextPackFilename(input.runId, createdAt, id);
        const fullPath = resolve(contextPacksRoot, filename);
        await writeFile(fullPath, input.content, 'utf8');
        filePath = fullPath;
      } catch (err) {
        log.warn(
          {
            event: 'context_pack_fs_write_failed',
            runId: input.runId,
            contextPacksRoot,
            err: err instanceof Error ? err.message : String(err),
          },
          'context-pack.write: DB insert succeeded but FS materialise failed; row is durable, FS is reconcilable',
        );
      }

      return {
        id,
        runId: input.runId,
        createdAt,
        contentExcerpt,
        filePath,
        source: incomingSource,
        status: 'created',
      };
    },

    async read(runId) {
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new ValidationError('context-pack.read: runId is required');
      }
      const row = await selectByRunId(deps.db, runId);
      if (!row) return null;
      return row;
    },

    async list(filter) {
      const limit = typeof filter.limit === 'number' && filter.limit > 0 ? Math.min(filter.limit, 200) : 50;
      if (deps.db.kind === 'sqlite') {
        const cp = sqliteSchema.contextPacks;
        const conditions = [];
        if (filter.runId) conditions.push(eq(cp.runId, filter.runId));
        if (filter.projectSlug) {
          const projectRows = await deps.db.db
            .select({ id: sqliteSchema.projects.id })
            .from(sqliteSchema.projects)
            .where(eq(sqliteSchema.projects.slug, filter.projectSlug))
            .limit(1);
          const projectId = projectRows[0]?.id;
          if (!projectId) return [];
          conditions.push(eq(cp.projectId, projectId));
        }
        const where =
          conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
        const rows = await (where
          ? deps.db.db.select().from(cp).where(where).orderBy(desc(cp.createdAt)).limit(limit)
          : deps.db.db.select().from(cp).orderBy(desc(cp.createdAt)).limit(limit));
        return rows;
      }
      const cp = postgresSchema.contextPacks;
      const conditions = [];
      if (filter.runId) conditions.push(eq(cp.runId, filter.runId));
      if (filter.projectSlug) {
        const projectRows = await deps.db.db
          .select({ id: postgresSchema.projects.id })
          .from(postgresSchema.projects)
          .where(eq(postgresSchema.projects.slug, filter.projectSlug))
          .limit(1);
        const projectId = projectRows[0]?.id;
        if (!projectId) return [];
        conditions.push(eq(cp.projectId, projectId));
      }
      const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
      const rows = await (where
        ? deps.db.db.select().from(cp).where(where).orderBy(desc(cp.createdAt)).limit(limit)
        : deps.db.db.select().from(cp).orderBy(desc(cp.createdAt)).limit(limit));
      return rows;
    },
  };
}
