import { beforeEach, describe, expect, it } from 'vitest';

import { clearGraphFreshnessCache, computeGraphFreshness } from '../../src/lib/graph-freshness.js';

/**
 * COOD-81 — graph drift as a first-class signal.
 *
 * `graph.json` has always carried `built_at_commit`; nothing read it, so
 * `query_decisions_by_file` reported `graphAvailable: true` for a graph
 * of any age and served blast-radius paths from it — including paths
 * into directories long since deleted.
 *
 * The contract these tests lock:
 *
 *   - Drift is measured, not assumed.
 *   - `unknown` is NOT `stale`. An artifact with no recorded commit, a
 *     non-git checkout, or a commit lost to a rebase leaves drift
 *     unmeasurable — which is no reason to withhold a graph that may
 *     well be current. Only measured-and-excessive drift withholds.
 *   - Files, not commits, is the axis that decides. Node ids are
 *     path-derived, so 100 commits touching 3 files barely perturbs the
 *     graph while one commit moving a package invalidates a whole
 *     neighbourhood.
 */

function fakeGit(responses: Record<string, string | null>) {
  return async (_cwd: string, args: readonly string[]): Promise<string | null> => {
    const key = args[0] ?? '';
    return Object.hasOwn(responses, key) ? (responses[key] ?? null) : null;
  };
}

const SHA = 'c5b7b138b067eb539325a4734338dfab88e840f5';

beforeEach(() => {
  clearGraphFreshnessCache();
});

describe('computeGraphFreshness', () => {
  it('reports unknown when the artifact records no commit', async () => {
    const result = await computeGraphFreshness('/repo', null);
    expect(result.staleness).toBe('unknown');
    expect(result.builtAtCommit).toBeNull();
  });

  it('reports fresh when drift is within budget', async () => {
    const result = await computeGraphFreshness('/repo', SHA, {
      runGit: fakeGit({
        'cat-file': '',
        'rev-list': '12\n',
        diff: 'a.ts\nb.ts\nc.ts\n',
      }),
    });
    expect(result.staleness).toBe('fresh');
    expect(result.commitsBehind).toBe(12);
    expect(result.filesChanged).toBe(3);
  });

  it('reports stale once measured file drift exceeds the budget', async () => {
    const manyFiles = Array.from({ length: 400 }, (_v, i) => `src/f${i}.ts`).join('\n');
    const result = await computeGraphFreshness('/repo', SHA, {
      runGit: fakeGit({ 'cat-file': '', 'rev-list': '47\n', diff: manyFiles }),
    });
    expect(result.staleness).toBe('stale');
    expect(result.filesChanged).toBe(400);
  });

  it('treats a commit missing from history as unknown, not stale', async () => {
    // Rebase, force-push, or shallow clone. Drift is unmeasurable —
    // but that is not evidence the graph is wrong, so it is still served.
    const result = await computeGraphFreshness('/repo', SHA, {
      runGit: fakeGit({ 'cat-file': null }),
    });
    expect(result.staleness).toBe('unknown');
    expect(result.builtAtCommit).toBe(SHA);
    expect(result.commitsBehind).toBeNull();
  });

  it('treats a non-git checkout as unknown rather than withholding', async () => {
    const result = await computeGraphFreshness('/not-a-repo', SHA, {
      runGit: async () => null,
    });
    expect(result.staleness).toBe('unknown');
  });

  it('does not call stale on commit count alone', async () => {
    // 500 commits that touched two files: the graph is barely perturbed,
    // because node ids are path-derived.
    const result = await computeGraphFreshness('/repo', SHA, {
      runGit: fakeGit({ 'cat-file': '', 'rev-list': '500\n', diff: 'a.ts\nb.ts\n' }),
    });
    expect(result.staleness).toBe('fresh');
    expect(result.commitsBehind).toBe(500);
  });

  it('memoises per (cwd, commit) so the hot path does not spawn git on every call', async () => {
    let calls = 0;
    const counting = async (_cwd: string, args: readonly string[]): Promise<string | null> => {
      calls += 1;
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'rev-list') return '1\n';
      return 'a.ts\n';
    };
    await computeGraphFreshness('/repo', SHA, { runGit: counting, now: 1_000 });
    const first = calls;
    await computeGraphFreshness('/repo', SHA, { runGit: counting, now: 1_500 });
    expect(calls, 'second call inside the TTL is served from the memo').toBe(first);

    await computeGraphFreshness('/repo', SHA, { runGit: counting, now: 200_000 });
    expect(calls, 'past the TTL it recomputes').toBeGreaterThan(first);
  });
});
