import 'server-only';

import { postgresSchema, sqliteSchema } from '@coodra/db';
import { count, desc, isNotNull, sql } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/team-members.ts` — list everyone whose
 * Clerk userId appears in the local row store. Cheaper than a Clerk SDK
 * call and works offline.
 *
 * The query unions the five tables that carry `created_by_user_id`:
 * runs, decisions, context_packs, policies, feature_packs. We pull
 * the distinct user-id set + a per-user activity count and most-recent
 * timestamp. The web app renders these as "team members observed
 * locally" — Clerk is the system of record for org membership, but
 * this query answers "who has actually written something we can see?"
 *
 * Solo mode returns an empty list — there's only one user (`__solo__`)
 * and that's not a team member; show the empty state instead.
 */

export interface TeamMemberRow {
  /** Clerk user id (`user_…`). The page resolves these to display names via Clerk SDK. */
  readonly userId: string;
  /** Total writes attributed to this user across the audit tables. */
  readonly writeCount: number;
  /** Most recent write timestamp, ISO-8601. */
  readonly lastSeenAt: string;
  /** Per-table breakdown for the row's hover/expand. */
  readonly perTable: {
    readonly runs: number;
    readonly decisions: number;
    readonly contextPacks: number;
    readonly policies: number;
    readonly featurePacks: number;
  };
}

// `feature_packs` carries `updated_at` but no `created_at` — see
// packages/db/src/schema/{sqlite,postgres}.ts. Aliasing it with
// `AS ts` keeps the UNION ALL column names consistent.
const SQL_LITE_UNION = sql`
  SELECT created_by_user_id AS user_id, 'runs' AS source, started_at AS ts FROM runs
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'decisions', created_at FROM decisions
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'context_packs', created_at FROM context_packs
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'policies', created_at FROM policies
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'feature_packs', updated_at FROM feature_packs
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
`;

const PG_UNION = sql`
  SELECT created_by_user_id AS user_id, 'runs' AS source, started_at AS ts FROM runs
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'decisions', created_at FROM decisions
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'context_packs', created_at FROM context_packs
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'policies', created_at FROM policies
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
  UNION ALL
  SELECT created_by_user_id, 'feature_packs', updated_at FROM feature_packs
    WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> '__solo__'
`;

export async function listTeamMembers(): Promise<ReadonlyArray<TeamMemberRow>> {
  const handle = createWebDb();

  if (handle.kind === 'sqlite') {
    // Aggregate the union via SQL so we don't ship raw events to JS.
    // The two grouping queries (counts per user-table + max ts per user)
    // run as sub-queries; the outer SELECT joins them.
    const rows = await handle.db.all<{
      user_id: string;
      runs: number;
      decisions: number;
      context_packs: number;
      policies: number;
      feature_packs: number;
      total: number;
      last_seen: number;
    }>(sql`
      WITH events AS (${SQL_LITE_UNION})
      SELECT
        user_id,
        SUM(CASE WHEN source = 'runs' THEN 1 ELSE 0 END) AS runs,
        SUM(CASE WHEN source = 'decisions' THEN 1 ELSE 0 END) AS decisions,
        SUM(CASE WHEN source = 'context_packs' THEN 1 ELSE 0 END) AS context_packs,
        SUM(CASE WHEN source = 'policies' THEN 1 ELSE 0 END) AS policies,
        SUM(CASE WHEN source = 'feature_packs' THEN 1 ELSE 0 END) AS feature_packs,
        COUNT(*) AS total,
        MAX(ts) AS last_seen
      FROM events
      GROUP BY user_id
      ORDER BY last_seen DESC
    `);
    return rows.map((r) => ({
      userId: r.user_id,
      writeCount: r.total,
      // SQLite stores integer unix-seconds; multiply by 1000 for ms.
      lastSeenAt: new Date(Number(r.last_seen) * 1000).toISOString(),
      perTable: {
        runs: r.runs,
        decisions: r.decisions,
        contextPacks: r.context_packs,
        policies: r.policies,
        featurePacks: r.feature_packs,
      },
    }));
  }

  // Postgres path — same shape, dialect-correct timestamp handling.
  const rows = await handle.db.execute<{
    user_id: string;
    runs: string;
    decisions: string;
    context_packs: string;
    policies: string;
    feature_packs: string;
    total: string;
    last_seen: Date;
  }>(sql`
    WITH events AS (${PG_UNION})
    SELECT
      user_id,
      SUM(CASE WHEN source = 'runs' THEN 1 ELSE 0 END)::text AS runs,
      SUM(CASE WHEN source = 'decisions' THEN 1 ELSE 0 END)::text AS decisions,
      SUM(CASE WHEN source = 'context_packs' THEN 1 ELSE 0 END)::text AS context_packs,
      SUM(CASE WHEN source = 'policies' THEN 1 ELSE 0 END)::text AS policies,
      SUM(CASE WHEN source = 'feature_packs' THEN 1 ELSE 0 END)::text AS feature_packs,
      COUNT(*)::text AS total,
      MAX(ts) AS last_seen
    FROM events
    GROUP BY user_id
    ORDER BY last_seen DESC
  `);
  return (rows as unknown as Array<{
    user_id: string;
    runs: string;
    decisions: string;
    context_packs: string;
    policies: string;
    feature_packs: string;
    total: string;
    last_seen: Date;
  }>).map((r) => ({
    userId: r.user_id,
    writeCount: Number(r.total),
    lastSeenAt: (r.last_seen instanceof Date ? r.last_seen : new Date(r.last_seen)).toISOString(),
    perTable: {
      runs: Number(r.runs),
      decisions: Number(r.decisions),
      contextPacks: Number(r.context_packs),
      policies: Number(r.policies),
      featurePacks: Number(r.feature_packs),
    },
  }));
}

/**
 * Smaller helper — total recorded writes in the local view. Used in the
 * dashboard sync-health card. Always runs against the same handle as
 * `createWebDb` so it works in both modes.
 */
export async function countAttributedWrites(): Promise<number> {
  const handle = createWebDb();
  if (handle.kind === 'sqlite') {
    const r = await handle.db
      .select({ n: count() })
      .from(sqliteSchema.runs)
      .where(isNotNull(sqliteSchema.runs.createdByUserId));
    return r[0]?.n ?? 0;
  }
  const r = await handle.db
    .select({ n: count() })
    .from(postgresSchema.runs)
    .where(isNotNull(postgresSchema.runs.createdByUserId));
  return r[0]?.n ?? 0;
}

// Suppress unused `desc` import (kept available for future ordering needs).
void desc;
