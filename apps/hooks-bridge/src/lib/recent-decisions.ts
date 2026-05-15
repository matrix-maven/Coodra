import { type DbHandle, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';

/**
 * `apps/hooks-bridge/src/lib/recent-decisions.ts` — Module 05 §7.
 *
 * Loads + formats the project's most-recent `decisions` rows for
 * SessionStart `additionalContext` injection. Closes the cross-developer
 * awareness gap that embeddings would have masked: when dev B starts a
 * session, dev A's recent decisions are visible without anyone having to
 * query for them.
 *
 * Ordering: confidence-prioritised, then recency. NULL confidence sorts
 * as 'medium' for backward compatibility with rows written before M05's
 * `confidence` column existed.
 *
 * Failure semantics: fail-open. Any DB error → log warn, return null.
 * SessionStart never blocks on this.
 */

const recentDecisionsLogger = createLogger('hooks-bridge.recent-decisions');

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_DESC_CHARS = 280;
const DEFAULT_MAX_RATIONALE_CHARS = 600;

export interface LoadRecentDecisionsOptions {
  readonly db: DbHandle;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly limit?: number;
  readonly maxAgeDays?: number;
}

interface DecisionRow {
  readonly id: string;
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly context: string | null;
  readonly impact: string | null;
  readonly confidence: string | null;
  readonly reversible: boolean | null;
  readonly createdAt: Date;
}

/**
 * Returns formatted markdown ready to append to the SessionStart
 * additionalContext, or `null` if there are no decisions to surface
 * (fresh project, all decisions filtered out by maxAgeDays, or DB
 * unavailable).
 */
export async function loadRecentDecisionsForSession(opts: LoadRecentDecisionsOptions): Promise<string | null> {
  // Fail-open: bridge supports SQLite-only at this code path; gracefully
  // skip on Postgres handles. Today the bridge always uses SQLite (per
  // `apps/hooks-bridge/src/lib/db.ts`); this is defensive.
  if (opts.db.kind !== 'sqlite') {
    return null;
  }

  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) {
    return null;
  }
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const sinceMs = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const sinceDate = new Date(sinceMs);

  let rows: DecisionRow[];
  try {
    const r = sqliteSchema.runs;
    // Step 1 — find runs for this project. Decisions FK to runs.id
    // (ON DELETE SET NULL); decisions outlive their runs but the
    // project-scoping needs the runs join for active rows.
    const projectRunIds = (await opts.db.db
      .select({ id: r.id })
      .from(r)
      .where(eq(r.projectId, opts.projectId))) as Array<{ id: string }>;

    if (projectRunIds.length === 0) {
      return null;
    }

    const runIds = projectRunIds.map((row) => row.id);

    // Step 2 — pull decisions for those runs, recency-bounded, ordered
    // by recency (we'll re-sort by confidence below — Drizzle's CASE
    // ordering is awkward across dialects; client-side sort over a small
    // result is cheaper than a portable SQL CASE expression).
    const d = sqliteSchema.decisions;
    rows = (await opts.db.db
      .select({
        id: d.id,
        description: d.description,
        rationale: d.rationale,
        alternatives: d.alternatives,
        context: d.context,
        impact: d.impact,
        confidence: d.confidence,
        reversible: d.reversible,
        createdAt: d.createdAt,
      })
      .from(d)
      .where(and(inArray(d.runId, runIds), gt(d.createdAt, sinceDate)))
      .orderBy(desc(d.createdAt))
      .limit(limit * 4)) as DecisionRow[]; // Pull 4x so confidence-aware sort has room to truncate.
  } catch (err) {
    recentDecisionsLogger.warn(
      {
        event: 'recent_decisions_query_failed',
        projectSlug: opts.projectSlug,
        err: err instanceof Error ? err.message : String(err),
      },
      'recent-decisions: DB query failed, returning null (SessionStart proceeds without injection)',
    );
    return null;
  }

  if (rows.length === 0) {
    return null;
  }

  // Confidence-aware sort. NULL → 'medium' for backward compat. Then
  // recency tiebreak (already DESC from the query).
  const confidenceRank = (c: string | null): number => {
    if (c === 'high') return 1;
    if (c === 'low') return 3;
    return 2; // 'medium' or NULL
  };
  const sorted = [...rows].sort((a, b) => {
    const ra = confidenceRank(a.confidence);
    const rb = confidenceRank(b.confidence);
    if (ra !== rb) return ra - rb;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const top = sorted.slice(0, limit);

  return formatRecentDecisionsBlock({
    projectSlug: opts.projectSlug,
    decisions: top,
    limit,
    maxAgeDays,
  });
}

/**
 * Render the markdown block. Pure function over decision rows; exported
 * for unit tests without DB.
 */
export function formatRecentDecisionsBlock(args: {
  readonly projectSlug: string;
  readonly decisions: ReadonlyArray<DecisionRow>;
  readonly limit: number;
  readonly maxAgeDays: number;
}): string {
  if (args.decisions.length === 0) {
    return '';
  }
  const lines: string[] = [];
  lines.push('## Recent decisions');
  lines.push('');
  lines.push(
    `Project \`${args.projectSlug}\` — last ${args.decisions.length} decision${
      args.decisions.length === 1 ? '' : 's'
    } (cap ${args.limit}, past ${args.maxAgeDays} days, confidence-prioritised).`,
  );
  lines.push('');

  for (const d of args.decisions) {
    const truncatedDesc =
      d.description.length > DEFAULT_MAX_DESC_CHARS
        ? `${d.description.slice(0, DEFAULT_MAX_DESC_CHARS).trimEnd()}…`
        : d.description;
    const dateStr = d.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`### ${dateStr} · ${truncatedDesc}`);
    if (d.context !== null && d.context.length > 0) {
      lines.push(`**Context:** ${d.context}`);
    }
    const truncatedRationale =
      d.rationale.length > DEFAULT_MAX_RATIONALE_CHARS
        ? `${d.rationale.slice(0, DEFAULT_MAX_RATIONALE_CHARS).trimEnd()}…`
        : d.rationale;
    lines.push(`**Rationale:** ${truncatedRationale}`);
    const alts = parseJsonArray(d.alternatives);
    if (alts.length > 0) {
      lines.push(`**Alternatives:** ${alts.join(', ')}`);
    }
    const impact = parseJsonArray(d.impact);
    if (impact.length > 0) {
      lines.push(`**Impact:** ${impact.join(', ')}`);
    }
    const conf = d.confidence ?? null;
    const rev = d.reversible;
    if (conf !== null || rev !== null) {
      const parts: string[] = [];
      if (conf !== null) parts.push(`**Confidence:** ${conf}`);
      if (rev !== null) parts.push(`**Reversible:** ${rev ? 'yes' : 'no'}`);
      lines.push(parts.join(' · '));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function parseJsonArray(raw: string | null): string[] {
  if (raw === null || raw === undefined || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string');
    }
    return [];
  } catch {
    return [];
  }
}
