import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { type DbHandle, sqliteSchema } from '@coodra/db';
import {
  createLogger,
  MAX_FILES_PER_DIFF,
  type RunDiffFileEntry,
  type RunDiffFileStatus,
  truncateUnifiedDiff,
} from '@coodra/shared';
import { asc, eq } from 'drizzle-orm';

/**
 * `apps/hooks-bridge/src/lib/run-diff-runner.ts` — Module 06 (Run Diff,
 * 2026-05-09). Generates a `git diff <runs.base_sha>` scoped to files the
 * agent touched in `run_events`, captures the unified output + per-file
 * metadata, truncates to MAX_UNIFIED_DIFF_BYTES, and persists to
 * `run_diffs` via DELETE-then-INSERT (idempotent on re-fired SessionEnd).
 *
 * Invariant: every call lands a `run_diffs` row, even on failure. The
 * `error` column carries the failure code from `RunDiffErrorCode`. This
 * matters because the auto-context-pack consumer + MCP tool + web view
 * all branch on row presence to distinguish "no diff yet" (analysis
 * pending or failed) from "diff captured" (read the row).
 *
 * Soft-failure shapes (see schema/sqlite.ts::runDiffs for the reference):
 *   - `error = 'no_base_sha'`     → SessionStart didn't capture HEAD.
 *   - `error = 'no_edits_in_run'` → no Edit/Write/MultiEdit/NotebookEdit
 *                                   tool calls in run_events.
 *   - `error = 'git_diff_failed'` → subprocess errored; stderr in
 *                                   unified_diff (clamped) for triage.
 *
 * Untracked-file handling: `git diff <baseSha>` does not include files
 * that didn't exist at `baseSha` and are still untracked at SessionEnd.
 * Without intent-to-add we'd lose every brand-new file the agent
 * created (a common case — new components, new tests). Solution: we
 * also call `git status --porcelain -- <files>` to detect untracked
 * (`??`) entries among the agent-touched paths and synthesize a
 * "new file" diff for each by reading the file and emitting a
 * standard /dev/null → b/path diff stanza. This is the same shape
 * `git diff --intent-to-add` would produce, without mutating the
 * user's index.
 *
 * Latency budget: ~50-200ms typical (single git diff + a status call).
 * Caller (session-end) awaits this before the auto-context-pack save
 * so the pack's "Diff" section is populated.
 */

const runnerLogger = createLogger('hooks-bridge.run-diff-runner');

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
/** Edit/Write tool names emitted by Claude Code, Cursor, and Windsurf. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'edit_file',
  'Write',
  'write_file',
  'MultiEdit',
  'NotebookEdit',
  'str_replace_editor',
]);

export interface RunDiffRunnerInput {
  readonly db: DbHandle;
  readonly runId: string;
  readonly cwd: string;
  /** Optional injection points for testing. */
  readonly gitDiff?: (cwd: string, baseSha: string, files: string[]) => Promise<{ stdout: string; stderr: string }>;
  readonly gitStatusUntracked?: (cwd: string, files: string[]) => Promise<string[]>;
  readonly gitNumstat?: (cwd: string, baseSha: string, files: string[]) => Promise<RunDiffNumstatRow[]>;
  readonly gitNameStatus?: (cwd: string, baseSha: string, files: string[]) => Promise<RunDiffNameStatusRow[]>;
  readonly gitRevParseHead?: (cwd: string) => Promise<string | null>;
  readonly readFileForDiff?: (cwd: string, relPath: string) => Promise<string | null>;
}

export interface RunDiffRunnerResult {
  readonly runId: string;
  readonly error: 'no_base_sha' | 'no_edits_in_run' | 'git_diff_failed' | null;
  readonly filesChanged: RunDiffFileEntry[];
  readonly truncated: boolean;
}

interface RunDiffNumstatRow {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

interface RunDiffNameStatusRow {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: RunDiffFileStatus;
}

// ---- default subprocess implementations ---------------------------------

async function defaultGitDiff(
  cwd: string,
  baseSha: string,
  files: string[],
): Promise<{ stdout: string; stderr: string }> {
  // `--no-color` keeps the output ANSI-free; `--no-ext-diff` ignores any
  // user-configured external diff driver; `-M -C` enables rename + copy
  // detection so we get useful status codes.
  const { stdout, stderr } = await execFileAsync(
    'git',
    ['diff', '--no-color', '--no-ext-diff', '-M', '-C', baseSha, '--', ...files],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  return { stdout, stderr };
}

async function defaultGitStatusUntracked(cwd: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  // `--porcelain=v1 -z` outputs `XY <path>\0` per entry; untracked is `??`.
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--', ...files], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const untracked: string[] = [];
  // The `-z` format separates entries by NUL. Each entry is `XY <space><path>`
  // where XY are the two-character status codes.
  const entries = stdout.split('\0');
  for (const entry of entries) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??' && path.length > 0) {
      untracked.push(path);
    }
  }
  return untracked;
}

async function defaultGitNumstat(cwd: string, baseSha: string, files: string[]): Promise<RunDiffNumstatRow[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--numstat', '--no-ext-diff', '-M', '-C', baseSha, '--', ...files],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const rows: RunDiffNumstatRow[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    // Binary files report `-\t-\t<path>`; treat as 0/0 so we still record the path.
    const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0] ?? '0', 10);
    const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1] ?? '0', 10);
    let path = parts[2] ?? '';
    // For renames numstat reports `old => new` or quoted variants. Strip the
    // arrow and use the new path; the name-status pass surfaces the rename.
    const arrowIdx = path.indexOf(' => ');
    if (arrowIdx >= 0) path = path.slice(arrowIdx + 4);
    if (path.length === 0) continue;
    rows.push({
      path,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return rows;
}

async function defaultGitNameStatus(cwd: string, baseSha: string, files: string[]): Promise<RunDiffNameStatusRow[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-status', '--no-ext-diff', '-M', '-C', '-z', baseSha, '--', ...files],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  // `-z` format for name-status emits sequences:
  //   - For A/M/D/T:  '<status>\0<path>\0'
  //   - For R/C:      '<status><score>\0<oldPath>\0<newPath>\0'
  const tokens = stdout.split('\0');
  const rows: RunDiffNameStatusRow[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (code === undefined || code.length === 0) continue;
    const head = code[0]?.toUpperCase() ?? '';
    if (head === 'R' || head === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      if (oldPath !== undefined && newPath !== undefined && newPath.length > 0) {
        rows.push({
          path: newPath,
          oldPath,
          status: head === 'R' ? 'renamed' : 'copied',
        });
      }
      continue;
    }
    const path = tokens[i + 1];
    i += 1;
    if (path === undefined || path.length === 0) continue;
    let status: RunDiffFileStatus;
    switch (head) {
      case 'A':
        status = 'added';
        break;
      case 'M':
        status = 'modified';
        break;
      case 'D':
        status = 'deleted';
        break;
      case 'T':
        status = 'type_changed';
        break;
      default:
        status = 'modified';
    }
    rows.push({ path, status });
  }
  return rows;
}

async function defaultGitRevParseHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

async function defaultReadFileForDiff(cwd: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(resolvePath(cwd, relPath), 'utf8');
  } catch {
    return null;
  }
}

// ---- helpers ------------------------------------------------------------

/**
 * Synthesize a `git diff` "new file" stanza for an untracked path so the
 * unified diff includes brand-new files the agent created during the
 * session. Format mirrors what `git diff --intent-to-add` would emit.
 */
function synthesizeNewFileDiff(path: string, content: string): string {
  const lines = content.length === 0 ? [] : content.split('\n');
  // Drop a trailing empty element produced by content ending in '\n'.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const header =
    `diff --git a/${path} b/${path}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  const body = lines.map((line) => `+${line}`).join('\n');
  return `${header}${body}${body.length > 0 ? '\n' : ''}`;
}

/**
 * Extract the file path from a tool_input JSON blob. Different tools use
 * different field names; we accept the common ones and ignore the rest.
 */
function extractFilePath(toolInputJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInputJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const fp = obj.file_path ?? obj.filePath ?? obj.path ?? obj.notebook_path ?? obj.notebookPath;
  if (typeof fp === 'string' && fp.length > 0) return fp;
  return null;
}

/**
 * Convert an absolute file path to one relative to `cwd` if it lies
 * inside it. Paths already relative are returned as-is. Paths outside
 * the cwd are returned unchanged (they'll match against git's worktree
 * if they happen to be valid).
 */
function relativizeIfPossible(cwd: string, filePath: string): string {
  if (!filePath.startsWith('/')) return filePath;
  const cwdNorm = cwd.endsWith('/') ? cwd : `${cwd}/`;
  if (filePath.startsWith(cwdNorm)) {
    return filePath.slice(cwdNorm.length);
  }
  return filePath;
}

async function loadRunMeta(
  db: DbHandle,
  runId: string,
): Promise<{ baseSha: string | null; touchedFiles: string[] } | null> {
  if (db.kind !== 'sqlite') return null;
  const runRows = (await db.db
    .select({ baseSha: sqliteSchema.runs.baseSha })
    .from(sqliteSchema.runs)
    .where(eq(sqliteSchema.runs.id, runId))
    .limit(1)) as Array<{ baseSha: string | null }>;
  if (runRows[0] === undefined) return null;
  const events = (await db.db
    .select({
      toolName: sqliteSchema.runEvents.toolName,
      toolInput: sqliteSchema.runEvents.toolInput,
    })
    .from(sqliteSchema.runEvents)
    .where(eq(sqliteSchema.runEvents.runId, runId))
    .orderBy(asc(sqliteSchema.runEvents.createdAt))) as Array<{ toolName: string; toolInput: string }>;
  const seen = new Set<string>();
  for (const e of events) {
    if (!EDIT_TOOL_NAMES.has(e.toolName)) continue;
    const fp = extractFilePath(e.toolInput);
    if (fp !== null && !seen.has(fp)) seen.add(fp);
  }
  return { baseSha: runRows[0].baseSha, touchedFiles: [...seen] };
}

async function persistRunDiff(
  db: DbHandle,
  row: {
    runId: string;
    baseSha: string | null;
    headSha: string | null;
    unifiedDiff: string;
    filesChanged: RunDiffFileEntry[];
    truncated: boolean;
    error: string | null;
  },
): Promise<void> {
  if (db.kind !== 'sqlite') return;
  // DELETE-then-INSERT for idempotency on re-fired SessionEnd. The
  // schema's PRIMARY KEY on run_id gives us the unique constraint.
  await db.db.delete(sqliteSchema.runDiffs).where(eq(sqliteSchema.runDiffs.runId, row.runId));
  await db.db.insert(sqliteSchema.runDiffs).values({
    runId: row.runId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    unifiedDiff: row.unifiedDiff,
    filesChanged: JSON.stringify(row.filesChanged),
    truncated: row.truncated,
    error: row.error,
  });
}

// ---- entry point --------------------------------------------------------

export async function runRunDiff(input: RunDiffRunnerInput): Promise<RunDiffRunnerResult> {
  const meta = await loadRunMeta(input.db, input.runId);
  if (meta === null) {
    runnerLogger.warn(
      { event: 'run_diff_no_runs_row', runId: input.runId },
      'runs row not found; skipping run_diffs INSERT',
    );
    return { runId: input.runId, error: 'git_diff_failed', filesChanged: [], truncated: false };
  }

  const headSha = await (input.gitRevParseHead ?? defaultGitRevParseHead)(input.cwd).catch(() => null);

  if (meta.baseSha === null) {
    await persistRunDiff(input.db, {
      runId: input.runId,
      baseSha: null,
      headSha,
      unifiedDiff: '',
      filesChanged: [],
      truncated: false,
      error: 'no_base_sha',
    });
    runnerLogger.info(
      { event: 'run_diff_no_base_sha', runId: input.runId },
      'persisted run_diffs row with error=no_base_sha',
    );
    return { runId: input.runId, error: 'no_base_sha', filesChanged: [], truncated: false };
  }

  if (meta.touchedFiles.length === 0) {
    await persistRunDiff(input.db, {
      runId: input.runId,
      baseSha: meta.baseSha,
      headSha,
      unifiedDiff: '',
      filesChanged: [],
      truncated: false,
      error: 'no_edits_in_run',
    });
    runnerLogger.info(
      { event: 'run_diff_no_edits', runId: input.runId, baseSha: meta.baseSha },
      'persisted run_diffs row with error=no_edits_in_run',
    );
    return { runId: input.runId, error: 'no_edits_in_run', filesChanged: [], truncated: false };
  }

  const allTouched = meta.touchedFiles.map((p) => relativizeIfPossible(input.cwd, p)).slice(0, MAX_FILES_PER_DIFF);

  const gitDiff = input.gitDiff ?? defaultGitDiff;
  const gitStatusUntracked = input.gitStatusUntracked ?? defaultGitStatusUntracked;
  const gitNumstat = input.gitNumstat ?? defaultGitNumstat;
  const gitNameStatus = input.gitNameStatus ?? defaultGitNameStatus;
  const readFileForDiff = input.readFileForDiff ?? defaultReadFileForDiff;

  let trackedDiff = '';
  let numstatRows: RunDiffNumstatRow[] = [];
  let nameStatusRows: RunDiffNameStatusRow[] = [];
  let untrackedPaths: string[] = [];
  try {
    const [diff, numstat, nameStatus, untracked] = await Promise.all([
      gitDiff(input.cwd, meta.baseSha, allTouched),
      gitNumstat(input.cwd, meta.baseSha, allTouched),
      gitNameStatus(input.cwd, meta.baseSha, allTouched),
      gitStatusUntracked(input.cwd, allTouched),
    ]);
    trackedDiff = diff.stdout;
    numstatRows = numstat;
    nameStatusRows = nameStatus;
    untrackedPaths = untracked;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const clamped = message.length > 4096 ? message.slice(0, 4096) : message;
    await persistRunDiff(input.db, {
      runId: input.runId,
      baseSha: meta.baseSha,
      headSha,
      unifiedDiff: clamped,
      filesChanged: [],
      truncated: false,
      error: 'git_diff_failed',
    });
    runnerLogger.warn(
      { event: 'run_diff_git_failed', runId: input.runId, err: message },
      'git diff threw; persisted run_diffs row with error=git_diff_failed',
    );
    return { runId: input.runId, error: 'git_diff_failed', filesChanged: [], truncated: false };
  }

  // Synthesize new-file diffs for untracked agent-touched paths.
  const untrackedDiffs: string[] = [];
  const untrackedEntries: RunDiffFileEntry[] = [];
  for (const path of untrackedPaths) {
    const content = await readFileForDiff(input.cwd, path);
    if (content === null) continue;
    untrackedDiffs.push(synthesizeNewFileDiff(path, content));
    const lineCount = content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    untrackedEntries.push({
      path,
      status: 'added',
      additions: lineCount,
      deletions: 0,
    });
  }

  const combined = [trackedDiff, ...untrackedDiffs].filter((s) => s.length > 0).join('\n');
  const { text, truncated } = truncateUnifiedDiff(combined);

  // Build files_changed by joining numstat (line counts) with name-status
  // (operation kind). Keys on path so a file appearing in both sources
  // is folded to one entry.
  const byPath = new Map<string, RunDiffFileEntry>();
  for (const ns of nameStatusRows) {
    byPath.set(ns.path, {
      path: ns.path,
      status: ns.status,
      additions: 0,
      deletions: 0,
      ...(ns.oldPath !== undefined ? { oldPath: ns.oldPath } : {}),
    });
  }
  for (const num of numstatRows) {
    const existing = byPath.get(num.path);
    if (existing !== undefined) {
      byPath.set(num.path, { ...existing, additions: num.additions, deletions: num.deletions });
    } else {
      byPath.set(num.path, {
        path: num.path,
        status: 'modified',
        additions: num.additions,
        deletions: num.deletions,
      });
    }
  }
  for (const u of untrackedEntries) {
    if (!byPath.has(u.path)) byPath.set(u.path, u);
  }
  const filesChanged = [...byPath.values()];

  await persistRunDiff(input.db, {
    runId: input.runId,
    baseSha: meta.baseSha,
    headSha,
    unifiedDiff: text,
    filesChanged,
    truncated,
    error: null,
  });

  runnerLogger.info(
    {
      event: 'run_diff_persisted',
      runId: input.runId,
      baseSha: meta.baseSha,
      headSha,
      filesChangedCount: filesChanged.length,
      diffBytes: Buffer.byteLength(text, 'utf8'),
      truncated,
    },
    'run_diffs row written',
  );

  return { runId: input.runId, error: null, filesChanged, truncated };
}
