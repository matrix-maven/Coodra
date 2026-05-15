import { createDb, migrateSqlite } from '@coodra/db';
import { describe, expect, it } from 'vitest';

import { runRunDiff } from '../../../src/lib/run-diff-runner.js';

/**
 * Module 06 — Slice 2. runRunDiff contract:
 *
 *   1. Always lands a run_diffs row (success or soft-failure).
 *   2. Soft-failure codes: no_base_sha, no_edits_in_run, git_diff_failed.
 *   3. Idempotent on re-fire: DELETE-then-INSERT replaces a stale row.
 *   4. Filters touched-files list to Edit/Write/MultiEdit/NotebookEdit
 *      tool calls only — Read/Bash/Grep events are ignored.
 *   5. Folds untracked agent-touched files into the diff via a
 *      synthesized /dev/null → b/path stanza.
 */

interface SeedRun {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly baseSha: string | null;
}

function seedProject(handle: ReturnType<typeof createDb>, projectId: string): void {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, projectId, '__solo__', projectId);
}

function seedRun(handle: ReturnType<typeof createDb>, row: SeedRun): void {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, base_sha, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.projectId, row.sessionId, 'claude_code', 'solo', 'in_progress', row.baseSha, 1000);
}

function seedEvent(
  handle: ReturnType<typeof createDb>,
  args: { id: string; runId: string; toolName: string; toolInput: object; createdAtSec: number },
): void {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle.raw
    .prepare(
      `INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      args.runId,
      'post',
      args.toolName,
      `tool_use_${args.id}`,
      JSON.stringify(args.toolInput),
      null,
      args.createdAtSec,
    );
}

function readRunDiffRow(
  handle: ReturnType<typeof createDb>,
  runId: string,
):
  | {
      base_sha: string | null;
      head_sha: string | null;
      unified_diff: string;
      files_changed: string;
      truncated: number;
      error: string | null;
    }
  | undefined {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  return handle.raw
    .prepare('SELECT base_sha, head_sha, unified_diff, files_changed, truncated, error FROM run_diffs WHERE run_id = ?')
    .get(runId) as
    | {
        base_sha: string | null;
        head_sha: string | null;
        unified_diff: string;
        files_changed: string;
        truncated: number;
        error: string | null;
      }
    | undefined;
}

describe('runRunDiff — Module 06 Slice 2', () => {
  it("lands error='no_base_sha' when runs.base_sha is null", async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    seedProject(db, 'p1');
    seedRun(db, { id: 'run_1', projectId: 'p1', sessionId: 's1', baseSha: null });

    const result = await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/whatever',
      gitRevParseHead: async () => null,
    });

    expect(result.error).toBe('no_base_sha');
    const row = readRunDiffRow(db, 'run_1');
    expect(row).toBeDefined();
    expect(row?.error).toBe('no_base_sha');
    expect(row?.base_sha).toBeNull();
    expect(row?.unified_diff).toBe('');
    expect(row?.files_changed).toBe('[]');
  });

  it("lands error='no_edits_in_run' when there are no Edit/Write events", async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    seedProject(db, 'p1');
    seedRun(db, { id: 'run_1', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    // Reads / shells should NOT count.
    seedEvent(db, { id: 'e1', runId: 'run_1', toolName: 'Read', toolInput: { file_path: 'x.ts' }, createdAtSec: 1001 });
    seedEvent(db, { id: 'e2', runId: 'run_1', toolName: 'Bash', toolInput: { command: 'ls' }, createdAtSec: 1002 });

    const result = await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/whatever',
      gitRevParseHead: async () => 'b'.repeat(40),
    });

    expect(result.error).toBe('no_edits_in_run');
    const row = readRunDiffRow(db, 'run_1');
    expect(row?.error).toBe('no_edits_in_run');
    expect(row?.head_sha).toBe('b'.repeat(40));
  });

  it('persists a successful diff with files_changed metadata', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    seedProject(db, 'p1');
    seedRun(db, { id: 'run_1', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    seedEvent(db, {
      id: 'e1',
      runId: 'run_1',
      toolName: 'Edit',
      toolInput: { file_path: 'src/foo.ts' },
      createdAtSec: 1001,
    });
    seedEvent(db, {
      id: 'e2',
      runId: 'run_1',
      toolName: 'Write',
      toolInput: { file_path: 'src/bar.ts' },
      createdAtSec: 1002,
    });

    const fakeDiff =
      'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,2 @@\n hello\n+world\n' +
      'diff --git a/src/bar.ts b/src/bar.ts\n@@ -1,1 +1,2 @@\n a\n+b\n';

    const result = await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/repo',
      gitRevParseHead: async () => 'b'.repeat(40),
      gitDiff: async () => ({ stdout: fakeDiff, stderr: '' }),
      gitNumstat: async () => [
        { path: 'src/foo.ts', additions: 1, deletions: 0 },
        { path: 'src/bar.ts', additions: 1, deletions: 0 },
      ],
      gitNameStatus: async () => [
        { path: 'src/foo.ts', status: 'modified' },
        { path: 'src/bar.ts', status: 'modified' },
      ],
      gitStatusUntracked: async () => [],
      readFileForDiff: async () => null,
    });

    expect(result.error).toBeNull();
    expect(result.filesChanged).toHaveLength(2);
    const row = readRunDiffRow(db, 'run_1');
    expect(row?.error).toBeNull();
    expect(row?.unified_diff).toBe(fakeDiff);
    const parsed = JSON.parse(row?.files_changed ?? '[]') as Array<{ path: string; additions: number }>;
    const paths = parsed.map((e) => e.path).sort();
    expect(paths).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('synthesizes new-file diffs for untracked agent-touched files', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    seedProject(db, 'p1');
    seedRun(db, { id: 'run_1', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    seedEvent(db, {
      id: 'e1',
      runId: 'run_1',
      toolName: 'Write',
      toolInput: { file_path: 'src/new.ts' },
      createdAtSec: 1001,
    });

    const result = await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/repo',
      gitRevParseHead: async () => 'b'.repeat(40),
      gitDiff: async () => ({ stdout: '', stderr: '' }),
      gitNumstat: async () => [],
      gitNameStatus: async () => [],
      gitStatusUntracked: async () => ['src/new.ts'],
      readFileForDiff: async () => 'export const x = 1;\nexport const y = 2;\n',
    });

    expect(result.error).toBeNull();
    const row = readRunDiffRow(db, 'run_1');
    expect(row?.unified_diff).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(row?.unified_diff).toContain('new file mode 100644');
    expect(row?.unified_diff).toContain('+export const x = 1;');
    expect(row?.unified_diff).toContain('+export const y = 2;');
    const parsed = JSON.parse(row?.files_changed ?? '[]') as Array<{ path: string; status: string; additions: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe('src/new.ts');
    expect(parsed[0]?.status).toBe('added');
    expect(parsed[0]?.additions).toBe(2);
  });

  it("lands error='git_diff_failed' when the subprocess throws", async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    seedProject(db, 'p1');
    seedRun(db, { id: 'run_1', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    seedEvent(db, {
      id: 'e1',
      runId: 'run_1',
      toolName: 'Edit',
      toolInput: { file_path: 'src/foo.ts' },
      createdAtSec: 1001,
    });

    const result = await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/repo',
      gitRevParseHead: async () => 'b'.repeat(40),
      gitDiff: async () => {
        throw new Error('fatal: bad object aaaaaa');
      },
      gitNumstat: async () => [],
      gitNameStatus: async () => [],
      gitStatusUntracked: async () => [],
      readFileForDiff: async () => null,
    });

    expect(result.error).toBe('git_diff_failed');
    const row = readRunDiffRow(db, 'run_1');
    expect(row?.error).toBe('git_diff_failed');
    expect(row?.unified_diff).toContain('fatal: bad object');
  });

  it('is idempotent on re-fire (DELETE-then-INSERT replaces stale row)', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(db.db);
    seedProject(db, 'p1');
    seedRun(db, { id: 'run_1', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    seedEvent(db, {
      id: 'e1',
      runId: 'run_1',
      toolName: 'Edit',
      toolInput: { file_path: 'src/foo.ts' },
      createdAtSec: 1001,
    });

    // First run: empty diff.
    await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/repo',
      gitRevParseHead: async () => 'b'.repeat(40),
      gitDiff: async () => ({ stdout: 'first run diff\n', stderr: '' }),
      gitNumstat: async () => [{ path: 'src/foo.ts', additions: 0, deletions: 0 }],
      gitNameStatus: async () => [{ path: 'src/foo.ts', status: 'modified' }],
      gitStatusUntracked: async () => [],
      readFileForDiff: async () => null,
    });

    // Second run: different diff content.
    await runRunDiff({
      db,
      runId: 'run_1',
      cwd: '/tmp/repo',
      gitRevParseHead: async () => 'c'.repeat(40),
      gitDiff: async () => ({ stdout: 'second run diff\n', stderr: '' }),
      gitNumstat: async () => [{ path: 'src/foo.ts', additions: 5, deletions: 1 }],
      gitNameStatus: async () => [{ path: 'src/foo.ts', status: 'modified' }],
      gitStatusUntracked: async () => [],
      readFileForDiff: async () => null,
    });

    const row = readRunDiffRow(db, 'run_1');
    expect(row?.unified_diff).toBe('second run diff\n');
    expect(row?.head_sha).toBe('c'.repeat(40));
    // Exactly one row.
    if (db.kind !== 'sqlite') throw new Error('unreachable');
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM run_diffs WHERE run_id = ?').get('run_1') as { n: number };
    expect(count.n).toBe(1);
  });
});
