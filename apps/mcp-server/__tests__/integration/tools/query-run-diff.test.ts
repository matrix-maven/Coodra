import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createQueryRunDiffToolRegistration } from '../../../src/tools/query-run-diff/manifest.js';
import type { QueryRunDiffOutput } from '../../../src/tools/query-run-diff/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__query_run_diff` (Module 06).
 *
 * Real :memory: SQLite migrated to current head + ToolRegistry +
 * ContextDeps. Locks the discriminated-union routing:
 *   - run_not_found        when the runs row is absent
 *   - analysis_pending     when the runs row exists but no run_diffs row
 *   - no_base_sha          when run_diffs.error = 'no_base_sha'
 *   - no_edits_in_run      when run_diffs.error = 'no_edits_in_run'
 *   - git_diff_failed      when run_diffs.error = 'git_diff_failed'
 *   - success branch       when run_diffs.error IS NULL
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly deps: ContextDeps;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  // The registry's post-call audit fires runRecorder.record whenever the
  // tool input has a runId field — query_run_diff's input is `{ runId }`
  // so we must stub it. Default makeFakeDeps lazily throws on any call,
  // which is correct for tools that don't carry a runId.
  const deps = makeFakeDeps({
    runRecorder: {
      record: async () => {
        /* no-op for tests */
      },
    },
  });
  return {
    close: async () => {
      await client.close();
    },
    handle,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createQueryRunDiffToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): QueryRunDiffOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: QueryRunDiffOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

function seedProject(h: Harness, projectId: string): void {
  h.handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, projectId, '__solo__', projectId);
}

function seedRun(h: Harness, args: { id: string; projectId: string; sessionId: string; baseSha: string | null }): void {
  h.handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, base_sha, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(args.id, args.projectId, args.sessionId, 'claude_code', 'solo', 'completed', args.baseSha, 1700000000);
}

function seedDiff(
  h: Harness,
  args: {
    runId: string;
    baseSha: string | null;
    headSha: string | null;
    unifiedDiff: string;
    filesChanged: string;
    error: string | null;
  },
): void {
  h.handle.raw
    .prepare(
      `INSERT INTO run_diffs (run_id, base_sha, head_sha, unified_diff, files_changed, truncated, error, generated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1700000050)`,
    )
    .run(args.runId, args.baseSha, args.headSha, args.unifiedDiff, args.filesChanged, args.error);
}

describe('query_run_diff — run_not_found soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns run_not_found when the runs row is missing', async () => {
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_diff', { runId: 'run_missing' }, 'sess'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('run_not_found');
    expect(out.howToFix).toMatch(/runId/);
  });
});

describe('query_run_diff — analysis_pending soft-failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns analysis_pending when the runs row exists but no run_diffs row', async () => {
    seedProject(h, 'p1');
    seedRun(h, { id: 'run_pending', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_diff', { runId: 'run_pending' }, 'sess'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('analysis_pending');
    expect(out.howToFix).toMatch(/SessionEnd/);
  });
});

describe('query_run_diff — error-code routing', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('routes no_base_sha from run_diffs.error', async () => {
    seedProject(h, 'p1');
    seedRun(h, { id: 'run_no_base', projectId: 'p1', sessionId: 's1', baseSha: null });
    seedDiff(h, {
      runId: 'run_no_base',
      baseSha: null,
      headSha: null,
      unifiedDiff: '',
      filesChanged: '[]',
      error: 'no_base_sha',
    });
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_diff', { runId: 'run_no_base' }, 'sess'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('no_base_sha');
  });

  it('routes no_edits_in_run from run_diffs.error', async () => {
    seedProject(h, 'p1');
    seedRun(h, { id: 'run_no_edits', projectId: 'p1', sessionId: 's2', baseSha: 'a'.repeat(40) });
    seedDiff(h, {
      runId: 'run_no_edits',
      baseSha: 'a'.repeat(40),
      headSha: 'a'.repeat(40),
      unifiedDiff: '',
      filesChanged: '[]',
      error: 'no_edits_in_run',
    });
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_diff', { runId: 'run_no_edits' }, 'sess'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('no_edits_in_run');
  });

  it('routes git_diff_failed and surfaces stderr in the response', async () => {
    seedProject(h, 'p1');
    seedRun(h, { id: 'run_failed', projectId: 'p1', sessionId: 's3', baseSha: 'a'.repeat(40) });
    seedDiff(h, {
      runId: 'run_failed',
      baseSha: 'a'.repeat(40),
      headSha: null,
      unifiedDiff: 'fatal: bad object aaaaaa',
      filesChanged: '[]',
      error: 'git_diff_failed',
    });
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_diff', { runId: 'run_failed' }, 'sess'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('git_diff_failed');
    if (out.error === 'git_diff_failed') {
      expect(out.stderr).toContain('fatal: bad object');
    }
  });
});

describe('query_run_diff — success branch', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the parsed payload when run_diffs.error IS NULL', async () => {
    seedProject(h, 'p1');
    seedRun(h, { id: 'run_ok', projectId: 'p1', sessionId: 's1', baseSha: 'a'.repeat(40) });
    seedDiff(h, {
      runId: 'run_ok',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      unifiedDiff: 'diff --git a/x b/x\n+ hello\n',
      filesChanged: JSON.stringify([{ path: 'src/foo.ts', status: 'modified', additions: 2, deletions: 1 }]),
      error: null,
    });
    const registry = buildRegistry(h);
    const out = unwrap(await registry.handleCall('query_run_diff', { runId: 'run_ok' }, 'sess'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runId).toBe('run_ok');
    expect(out.baseSha).toBe('a'.repeat(40));
    expect(out.headSha).toBe('b'.repeat(40));
    expect(out.unifiedDiff).toContain('diff --git');
    expect(out.filesChanged).toHaveLength(1);
    expect(out.filesChanged[0]?.path).toBe('src/foo.ts');
    expect(out.truncated).toBe(false);
  });
});
