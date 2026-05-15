import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { parseRunDiffFilesChanged, type RunDiffFileEntry } from '@coodra/shared';
import { eq } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/run-diff.ts` — server-only reader for the
 * `run_diffs` row written by the hooks-bridge SessionEnd runner
 * (Module 06). Returns `null` when no row exists yet (analysis pending),
 * otherwise the parsed snapshot the diff page renders.
 *
 * The shape mirrors the MCP `query_run_diff` tool's success branch so
 * the web view and agent path stay in sync.
 */

export interface RunDiffViewModel {
  readonly runId: string;
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly unifiedDiff: string;
  readonly filesChanged: ReadonlyArray<RunDiffFileEntry>;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly generatedAt: Date;
}

export async function getRunDiff(runId: string, db?: DbHandle): Promise<RunDiffViewModel | null> {
  const handle = db ?? createWebDb();
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runDiffs;
    const rows = await handle.db
      .select({
        baseSha: t.baseSha,
        headSha: t.headSha,
        unifiedDiff: t.unifiedDiff,
        filesChanged: t.filesChanged,
        truncated: t.truncated,
        error: t.error,
        generatedAt: t.generatedAt,
      })
      .from(t)
      .where(eq(t.runId, runId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runId,
      baseSha: row.baseSha,
      headSha: row.headSha,
      unifiedDiff: row.unifiedDiff,
      filesChanged: parseRunDiffFilesChanged(row.filesChanged),
      truncated: row.truncated,
      error: row.error,
      generatedAt: row.generatedAt,
    };
  }
  const t = postgresSchema.runDiffs;
  const rows = await handle.db
    .select({
      baseSha: t.baseSha,
      headSha: t.headSha,
      unifiedDiff: t.unifiedDiff,
      filesChanged: t.filesChanged,
      truncated: t.truncated,
      error: t.error,
      generatedAt: t.generatedAt,
    })
    .from(t)
    .where(eq(t.runId, runId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    runId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    unifiedDiff: row.unifiedDiff,
    filesChanged: parseRunDiffFilesChanged(row.filesChanged),
    truncated: row.truncated,
    error: row.error,
    generatedAt: row.generatedAt,
  };
}
