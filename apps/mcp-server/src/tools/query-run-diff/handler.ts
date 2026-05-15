import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger, parseRunDiffFilesChanged } from '@coodra/shared';
import { eq } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import type { QueryRunDiffInput, QueryRunDiffOutput } from './schema.js';

/**
 * Handler factory for `coodra__query_run_diff` (Module 06).
 *
 * Read-only. Two-step query:
 *   1. SELECT runs.id WHERE runs.id = ? — confirms the run exists; if
 *      missing, return `run_not_found`.
 *   2. SELECT * FROM run_diffs WHERE run_id = ? — if missing, return
 *      `analysis_pending` (the bridge runner hasn't written yet).
 *      Otherwise inspect `error` and route to the matching soft-failure
 *      branch, or return success with the parsed payload.
 *
 * The two-step design distinguishes "you typed the wrong runId" (caller
 * fix) from "the run exists but the diff isn't written yet" (wait or
 * trigger SessionEnd). Conflating them confuses agents that retry on
 * pending-not-found.
 */

const handlerLogger = createLogger('mcp-server.tool.query_run_diff');

export interface QueryRunDiffHandlerDeps {
  readonly db: DbHandle;
}

interface RunDiffRow {
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly unifiedDiff: string;
  readonly filesChanged: string;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly generatedAt: Date;
}

async function selectRunExists(db: DbHandle, runId: string): Promise<boolean> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0] !== undefined;
  }
  const rows = await db.db
    .select({ id: postgresSchema.runs.id })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0] !== undefined;
}

async function selectRunDiffRow(db: DbHandle, runId: string): Promise<RunDiffRow | null> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runDiffs;
    const rows = (await db.db
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
      .limit(1)) as RunDiffRow[];
    return rows[0] ?? null;
  }
  const t = postgresSchema.runDiffs;
  const rows = (await db.db
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
    .limit(1)) as RunDiffRow[];
  return rows[0] ?? null;
}

export function createQueryRunDiffHandler(deps: QueryRunDiffHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createQueryRunDiffHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createQueryRunDiffHandler: deps.db must be a DbHandle');
  }

  return async function queryRunDiffHandler(input: QueryRunDiffInput, ctx: ToolContext): Promise<QueryRunDiffOutput> {
    const exists = await selectRunExists(deps.db, input.runId);
    if (!exists) {
      handlerLogger.info(
        { event: 'query_run_diff_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'query_run_diff: runId does not match a runs row',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Pass a runId from query_run_history or get_run_id. The runId format is `run:<projectId>:<sessionId>:<uuid>`.',
      };
    }

    const row = await selectRunDiffRow(deps.db, input.runId);
    if (row === null) {
      return {
        ok: false,
        error: 'analysis_pending',
        howToFix:
          'The bridge writes the run_diffs row on SessionEnd. If the run is still in_progress, end the session first; otherwise the SessionEnd hook may have fired without a cwd and skipped diff capture.',
      };
    }

    if (row.error === 'no_base_sha') {
      return {
        ok: false,
        error: 'no_base_sha',
        howToFix:
          'No `git rev-parse HEAD` was captured at SessionStart for this run. Most often this means the project is not a git repository. Initialize git (`git init` + first commit) for diff capture in future sessions.',
      };
    }
    if (row.error === 'no_edits_in_run') {
      return {
        ok: false,
        error: 'no_edits_in_run',
        howToFix:
          'This run had no Edit/Write/MultiEdit tool calls. There is nothing to diff. If the agent edited files via Bash (e.g. `sed -i`), they will not appear in run_diffs — capture file paths via Edit/Write tools for diff coverage.',
      };
    }
    if (row.error === 'git_diff_failed') {
      return {
        ok: false,
        error: 'git_diff_failed',
        howToFix:
          'The git subprocess errored during diff capture. Check that the baseSha commit is still reachable from the repo (e.g. it was not garbage-collected). Stderr is in the response.',
        stderr: row.unifiedDiff,
      };
    }

    return {
      ok: true,
      runId: input.runId,
      baseSha: row.baseSha,
      headSha: row.headSha,
      unifiedDiff: row.unifiedDiff,
      filesChanged: parseRunDiffFilesChanged(row.filesChanged),
      truncated: row.truncated,
      generatedAt: row.generatedAt.toISOString(),
    };
  };
}
