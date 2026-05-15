import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildAutoSummary, saveAutoContextPack } from '../../src/lib/auto-context-pack.js';

/**
 * Locks the structured-summary contract used by SessionEnd
 * auto-save (decision dec_83ba10c1, 2026-05-02). The summary is
 * deterministic so future runs of the same fixture produce the
 * same Markdown — the contract is what Module 05 (NL Assembly)
 * will replace with an LLM-generated narrative.
 */
describe('buildAutoSummary', () => {
  it('lists files touched, classifies events, surfaces decisions', () => {
    const result = buildAutoSummary({
      runId: 'run:proj_x:sess:abcdefgh-1234-5678-9012-abcdefabcdef',
      events: [
        {
          id: 'evt-1',
          phase: 'pre',
          toolName: 'Write',
          toolUseId: 'tu1',
          toolInput: JSON.stringify({ file_path: '/repo/src/foo.ts' }),
          outcome: null,
          createdAt: new Date('2026-05-02T12:00:00Z'),
        },
        {
          id: 'evt-2',
          phase: 'post',
          toolName: 'Read',
          toolUseId: 'tu2',
          toolInput: JSON.stringify({ file_path: '/repo/src/bar.ts' }),
          outcome: 'ok',
          createdAt: new Date('2026-05-02T12:01:00Z'),
        },
        {
          id: 'evt-3',
          phase: 'pre',
          toolName: 'Bash',
          toolUseId: 'tu3',
          toolInput: JSON.stringify({ command: 'pnpm test' }),
          outcome: 'denied',
          createdAt: new Date('2026-05-02T12:02:00Z'),
        },
      ],
      decisions: [
        {
          id: 'dec-1',
          description: 'Bundle dists into the CLI tarball',
          rationale: 'Workspace packages are private',
          alternatives: JSON.stringify(['Publish all workspace packages', 'CDN postinstall']),
          createdAt: new Date('2026-05-02T12:03:00Z'),
        },
      ],
    });

    expect(result.title).toContain('Auto-saved session');
    expect(result.title.length).toBeLessThan(120);

    expect(result.content).toContain('# Auto-saved Context Pack');
    expect(result.content).toContain('## Run summary');
    expect(result.content).toContain('events recorded:** 3');
    expect(result.content).toContain('writes / edits:** 1');
    expect(result.content).toContain('reads / greps:** 1');
    expect(result.content).toContain('shell commands:** 1');
    expect(result.content).toContain('policy denies:** 1');
    expect(result.content).toContain('## Files touched');
    expect(result.content).toContain('/repo/src/foo.ts');
    expect(result.content).toContain('/repo/src/bar.ts');
    expect(result.content).toContain('## Decisions');
    expect(result.content).toContain('Bundle dists into the CLI tarball');
    expect(result.content).toContain('Workspace packages are private');
    expect(result.content).toContain('Publish all workspace packages');
  });

  it('renders a "## Diff" section when a run-diff snapshot is provided', () => {
    const result = buildAutoSummary({
      runId: 'run:proj_x:sess:abcdefgh-1234-5678-9012-abcdefabcdef',
      events: [],
      decisions: [],
      diff: {
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        unifiedDiff:
          'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,2 @@\n hello\n+world\n',
        filesChanged: [
          { path: 'src/foo.ts', status: 'modified', additions: 1, deletions: 0 },
        ],
        truncated: false,
        error: null,
      },
    });
    expect(result.content).toContain('## Diff');
    expect(result.content).toContain('Diff vs `aaaaaaaaaaaa`');
    expect(result.content).toContain('**Files changed:**');
    expect(result.content).toContain('`src/foo.ts` — modified +1 -0');
    expect(result.content).toContain('```diff');
    expect(result.content).toContain('+world');
  });

  it('renders the no_base_sha soft-failure prose when the runner reported it', () => {
    const result = buildAutoSummary({
      runId: 'run:none',
      events: [],
      decisions: [],
      diff: {
        baseSha: null,
        headSha: null,
        unifiedDiff: '',
        filesChanged: [],
        truncated: false,
        error: 'no_base_sha',
      },
    });
    expect(result.content).toContain('## Diff');
    expect(result.content).toContain('not a git repository');
  });

  it('renders the no_edits soft-failure prose when the runner reported it', () => {
    const result = buildAutoSummary({
      runId: 'run:none',
      events: [],
      decisions: [],
      diff: {
        baseSha: 'a'.repeat(40),
        headSha: 'a'.repeat(40),
        unifiedDiff: '',
        filesChanged: [],
        truncated: false,
        error: 'no_edits_in_run',
      },
    });
    expect(result.content).toContain('## Diff');
    expect(result.content).toContain('No Edit/Write tool calls');
  });

  it('omits the "## Diff" section when no snapshot is provided', () => {
    const result = buildAutoSummary({
      runId: 'run:none',
      events: [],
      decisions: [],
    });
    expect(result.content).not.toContain('## Diff');
  });

  it('produces a valid summary with zero events + zero decisions', () => {
    const result = buildAutoSummary({
      runId: 'run:empty:1:abc',
      events: [],
      decisions: [],
    });
    expect(result.content).toContain('events recorded:** 0');
    expect(result.content).not.toContain('## Files touched');
    expect(result.content).not.toContain('## Decisions');
  });
});

/**
 * Phase 4 Fix H (Slice 3 — 2026-05-03 audit). The audit observed:
 *
 *   "4 packs in DB, only 2 on filesystem (the 2 manually saved); auto-saves are DB-only."
 *
 * Pre-Fix-H the bridge wrote to `context_packs` directly via
 * `db.db.insert(...)` and skipped the `mkdir + writeFile` step that
 * the MCP `save_context_pack` tool performs via its store. This block
 * locks Fix-H's contract: a successful auto-save lands BOTH the DB
 * row AND the `<contextPacksRoot>/<yyyy-mm-dd>-<runId>.md` file.
 *
 * The integration uses a real `:memory:` SQLite with migrations
 * applied + a tmpdir for `contextPacksRoot`. No mocks for the thing
 * under test (per `01-development-discipline.md` §1.1).
 */
describe('saveAutoContextPack — FS materialization (Slice 3)', () => {
  it('writes a `<yyyy-mm-dd>-<sanitized-runId>.md` file alongside the DB row', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(db.db);
    const packsRoot = await mkdtemp(join(tmpdir(), 'auto-pack-fs-'));

    // Seed minimal `runs` row + `projects` row so the auto-save's
    // event/decision queries return empty (which is fine — the
    // summary still has run-summary headers).
    const projectId = '00000000-0000-0000-0000-0000000000aa';
    await db.db
      .insert(sqliteSchema.projects)
      .values({ id: projectId, slug: 'fs-test', orgId: '__solo__', name: 'fs-test' });
    const runId = `run:${projectId}:audit-fs-test:11111111-2222-3333-4444-555555555555`;
    await db.db.insert(sqliteSchema.runs).values({
      id: runId,
      projectId,
      sessionId: 'audit-fs-test',
      agentType: 'claude_code',
      mode: 'solo',
      status: 'in_progress',
    });

    const result = await saveAutoContextPack({
      runId,
      projectId,
      db,
      contextPacksRoot: packsRoot,
    });

    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);

    // DB row landed.
    const dbRows = (await db.db
      .select({ id: sqliteSchema.contextPacks.id, content: sqliteSchema.contextPacks.content })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .limit(1)) as Array<{ id: string; content: string }>;
    expect(dbRows).toHaveLength(1);
    const dbContent = dbRows[0]?.content as string;

    // FS file landed under packsRoot. Filename format is
    // `<yyyy-mm-dd>-<safe-runId>.md` per shared contextPackFilename().
    const today = new Date().toISOString().slice(0, 10);
    // The runId contains colons which get sanitized to hyphens, then
    // sliced to 16 chars. The first 16 chars of `run:00000000-0000-`
    // become `run-00000000-000`.
    const expectedFilename = `${today}-run-00000000-000.md`;
    const expectedPath = join(packsRoot, expectedFilename);
    expect(existsSync(expectedPath)).toBe(true);

    // FS content matches DB content byte-for-byte (no embedding-fork drift).
    const fsContent = await readFile(expectedPath, 'utf8');
    expect(fsContent).toBe(dbContent);

    // Sanity-check the body — same shape buildAutoSummary's tests already lock.
    expect(fsContent).toContain('# Auto-saved Context Pack');
    expect(fsContent).toContain('events recorded:** 0');
  });

  it('FS-write failure is non-fatal — DB row is durable', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(db.db);

    const projectId = '00000000-0000-0000-0000-0000000000bb';
    await db.db
      .insert(sqliteSchema.projects)
      .values({ id: projectId, slug: 'fs-fail-test', orgId: '__solo__', name: 'fs-fail-test' });
    const runId = `run:${projectId}:audit-fs-fail:11111111-2222-3333-4444-555555555555`;
    await db.db.insert(sqliteSchema.runs).values({
      id: runId,
      projectId,
      sessionId: 'audit-fs-fail',
      agentType: 'claude_code',
      mode: 'solo',
      status: 'in_progress',
    });

    // contextPacksRoot points at a path that mkdir cannot create
    // (parent is a regular file). On most POSIX filesystems this
    // produces ENOTDIR — the auto-save should swallow the error and
    // still return success.
    const tmp = await mkdtemp(join(tmpdir(), 'auto-pack-fail-'));
    const blockedRoot = join(tmp, 'a-file-not-a-dir', 'subdir');
    // Create a file at the parent so mkdir { recursive: true } fails.
    await (await import('node:fs/promises')).writeFile(join(tmp, 'a-file-not-a-dir'), 'x', 'utf8');

    const result = await saveAutoContextPack({
      runId,
      projectId,
      db,
      contextPacksRoot: blockedRoot,
    });

    // DB row landed.
    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
    const dbRows = (await db.db
      .select({ id: sqliteSchema.contextPacks.id })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .limit(1)) as Array<{ id: string }>;
    expect(dbRows).toHaveLength(1);

    // FS file did NOT land under blockedRoot.
    expect(existsSync(blockedRoot)).toBe(false);
  });
});
