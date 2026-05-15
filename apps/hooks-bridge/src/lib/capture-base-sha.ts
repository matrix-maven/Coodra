import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type DbHandle, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * `apps/hooks-bridge/src/lib/capture-base-sha.ts` — Module 06 (Run Diff,
 * 2026-05-09). Spawns `git rev-parse HEAD` in the project's cwd at
 * SessionStart and persists the result in `runs.base_sha`.
 *
 * Why this is a separate module and not inlined in `session-start.ts`:
 *  - Fail-open posture identical to the rest of SessionStart's blocks
 *    (feature pack, features index, recent decisions). Each load runs
 *    inside its own try/catch and a failure of any one block must not
 *    block the response.
 *  - Testable in isolation: feed a mock cwd + a mock spawner + a fake DB
 *    and assert the row was UPDATEd or skipped.
 *
 * Idempotency: the UPDATE WHERE clause includes `base_sha IS NULL` so a
 * re-fired SessionStart for the same (projectId, sessionId) doesn't
 * stomp a value the first run already captured. The runs row may not
 * exist yet at SessionStart time (the run-recorder enqueues it via the
 * outbox); we retry the UPDATE up to 3 times with a 50ms backoff before
 * logging a warn and giving up — the SessionEnd run-diff runner will
 * surface this as `error='no_base_sha'` if it doesn't land.
 *
 * Latency budget: ~5-15ms typical for the git subprocess, plus one
 * SQLite UPDATE. Whole thing fires-and-forgets from the SessionStart
 * handler, so the response goes back to the agent at the same time the
 * subprocess is spawning.
 *
 * Fail modes (all logged + swallowed):
 *   - Not a git repo (`fatal: not a git repository`) → no UPDATE; the
 *     SessionEnd runner will land `error='no_base_sha'`.
 *   - `git` not on PATH → same as above; logged once per process boot.
 *   - cwd doesn't exist → same as above; almost certainly indicates a
 *     wrapper bug (cwd should always exist if SessionStart fired).
 *   - DB UPDATE returned 0 rows → the runs row hasn't landed yet from
 *     the outbox; we retry 3x then give up.
 */

const captureLogger = createLogger('hooks-bridge.capture-base-sha');

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const UPDATE_RETRY_LIMIT = 3;
const UPDATE_RETRY_BACKOFF_MS = 50;

export interface CaptureBaseShaInput {
  readonly cwd: string;
  readonly db: DbHandle;
  readonly projectId: string;
  readonly sessionId: string;
  /** Optional override for testing — defaults to the real `git rev-parse HEAD`. */
  readonly gitRevParseHead?: (cwd: string) => Promise<string | null>;
}

export interface CaptureBaseShaResult {
  readonly captured: boolean;
  readonly baseSha: string | null;
  readonly reason?: 'not_a_git_repo' | 'git_failed' | 'runs_row_not_found' | 'unsupported_db_kind';
}

/**
 * Default git rev-parse implementation. Returns the SHA on success or
 * null on any failure mode. Never throws.
 */
async function defaultGitRevParseHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    // A SHA is exactly 40 hex chars (or 64 for SHA-256 repos). Reject anything else.
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Capture `git rev-parse HEAD` in `cwd` and persist it to `runs.base_sha`
 * for the run identified by (projectId, sessionId). Idempotent at the
 * UPDATE: only writes when `base_sha IS NULL`.
 */
export async function captureBaseSha(input: CaptureBaseShaInput): Promise<CaptureBaseShaResult> {
  if (input.db.kind !== 'sqlite') {
    return { captured: false, baseSha: null, reason: 'unsupported_db_kind' };
  }

  const gitFn = input.gitRevParseHead ?? defaultGitRevParseHead;
  let baseSha: string | null;
  try {
    baseSha = await gitFn(input.cwd);
  } catch (err) {
    captureLogger.warn(
      {
        event: 'capture_base_sha_subprocess_threw',
        cwd: input.cwd,
        sessionId: input.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'git subprocess threw unexpectedly; treating as not_a_git_repo',
    );
    baseSha = null;
  }

  if (baseSha === null) {
    captureLogger.info(
      {
        event: 'capture_base_sha_skipped',
        sessionId: input.sessionId,
        cwd: input.cwd,
        reason: 'not_a_git_repo',
      },
      'no git HEAD captured; SessionEnd run-diff runner will land error=no_base_sha',
    );
    return { captured: false, baseSha: null, reason: 'not_a_git_repo' };
  }

  // UPDATE the runs row. The row may not exist yet (the outbox is async),
  // so retry up to UPDATE_RETRY_LIMIT times with a small backoff. Idempotent
  // via WHERE base_sha IS NULL — a second SessionStart firing for the same
  // session is a no-op.
  for (let attempt = 0; attempt < UPDATE_RETRY_LIMIT; attempt += 1) {
    const t = sqliteSchema.runs;
    const result = await input.db.db
      .update(t)
      .set({ baseSha })
      .where(and(eq(t.projectId, input.projectId), eq(t.sessionId, input.sessionId), isNull(t.baseSha)))
      .run();
    if (result.changes > 0) {
      captureLogger.info(
        {
          event: 'capture_base_sha_persisted',
          sessionId: input.sessionId,
          projectId: input.projectId,
          baseSha,
          attempt,
        },
        'runs.base_sha set',
      );
      return { captured: true, baseSha };
    }
    if (attempt < UPDATE_RETRY_LIMIT - 1) {
      await new Promise((resolve) => setTimeout(resolve, UPDATE_RETRY_BACKOFF_MS));
    }
  }

  captureLogger.warn(
    {
      event: 'capture_base_sha_no_runs_row',
      sessionId: input.sessionId,
      projectId: input.projectId,
      retries: UPDATE_RETRY_LIMIT,
    },
    'UPDATE matched 0 rows after retries; runs row never landed or base_sha was already populated',
  );
  return { captured: false, baseSha, reason: 'runs_row_not_found' };
}
